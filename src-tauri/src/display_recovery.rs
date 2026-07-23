//! Best-effort recovery for a macOS `WKWebView` that stops presenting after a
//! display sleep/wake cycle.
//!
//! This module deliberately does not reload the page or recreate the webview:
//! either operation can orphan the Rust-owned PTYs while the new frontend
//! restores duplicate sessions.  Recovery is instead limited to the native
//! view.  The main `WKWebView` is hidden and shown on separate main-thread
//! tasks, then invalidated, without changing the outer window's geometry.  It
//! therefore also works while the window is in native fullscreen.

const RECOVERY_QUIET_PERIOD_MS: u64 = 3_000;

#[derive(Clone, Debug, PartialEq, Eq)]
struct PendingRecovery {
    generation: u64,
    source: String,
}

#[derive(Debug, PartialEq, Eq)]
enum RequestDecision {
    Start(PendingRecovery),
    Coalesced(u64),
    Queued(u64),
    Suppressed,
}

#[derive(Debug, PartialEq, Eq)]
enum FinishDecision {
    Start(PendingRecovery),
    Idle,
    Stale,
}

/// Pure scheduling state. At most one recovery is running and at most one
/// follow-up (the newest request) is retained while it runs.
#[derive(Debug, Default)]
struct RecoveryCoordinator {
    next_generation: u64,
    running_generation: Option<u64>,
    pending: Option<PendingRecovery>,
    last_finished_ms: Option<u64>,
}

impl RecoveryCoordinator {
    fn request(&mut self, now_ms: u64, source: String, force: bool) -> RequestDecision {
        // AppKit can report one physical wake through both the screen-wake and
        // system-wake channels. If a native recovery is already in flight, a
        // non-explicit signal belongs to that cycle and must not cause a second
        // visible hide/show. Explicit/manual requests retain one follow-up.
        if let Some(running_generation) = self.running_generation {
            if !force {
                return RequestDecision::Coalesced(running_generation);
            }
        }

        if self.running_generation.is_none()
            && !force
            && self
                .last_finished_ms
                .is_some_and(|last| now_ms.saturating_sub(last) < RECOVERY_QUIET_PERIOD_MS)
        {
            return RequestDecision::Suppressed;
        }

        self.next_generation = self.next_generation.wrapping_add(1).max(1);
        let request = PendingRecovery {
            generation: self.next_generation,
            source,
        };

        if self.running_generation.is_some() {
            let generation = request.generation;
            self.pending = Some(request);
            RequestDecision::Queued(generation)
        } else {
            self.running_generation = Some(request.generation);
            RequestDecision::Start(request)
        }
    }

    fn finish(&mut self, generation: u64, now_ms: u64) -> FinishDecision {
        if self.running_generation != Some(generation) {
            return FinishDecision::Stale;
        }

        self.last_finished_ms = Some(now_ms);

        if let Some(next) = self.pending.take() {
            self.running_generation = Some(next.generation);
            FinishDecision::Start(next)
        } else {
            self.running_generation = None;
            FinishDecision::Idle
        }
    }

    fn abort_start(&mut self, generation: u64) {
        if self.running_generation == Some(generation) {
            self.running_generation = None;
            self.pending = None;
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{FinishDecision, RecoveryCoordinator, RequestDecision};
    use objc2::runtime::{AnyObject, NSObject};
    use objc2::{class, define_class, msg_send, rc::Retained, sel, AllocAnyThread, DefinedClass};
    use objc2_foundation::{
        NSNotification, NSNotificationCenter, NSNotificationName, NSObjectProtocol,
    };
    use objc2_web_kit::WKWebView;
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::{mpsc, Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter, Manager, Webview};

    const NATIVE_STEP_TIMEOUT: Duration = Duration::from_secs(2);
    const PRESENTATION_SETTLE: Duration = Duration::from_millis(150);
    const PRESENTABILITY_RETRY_INTERVAL: Duration = Duration::from_millis(100);
    const PRESENTABILITY_RACE_SETTLE: Duration = Duration::from_millis(50);
    const PRESENTABILITY_RETRY_COUNT: usize = 5;
    const HIDDEN_DWELL: Duration = Duration::from_millis(45);
    const POST_SHOW_DWELL: Duration = Duration::from_millis(20);
    const LATE_INVALIDATION_DELAYS: [Duration; 2] = [
        Duration::from_millis(250),
        Duration::from_millis(750),
    ];
    const FALLBACK_POLL_INTERVAL: Duration = Duration::from_secs(2);
    const STARTUP_SCREEN_CHANGE_GRACE_MS: u64 = 5_000;
    const MAX_DIAGNOSTIC_LINES: usize = 256;

    static STARTED: AtomicBool = AtomicBool::new(false);
    static FALLBACK_STARTED: AtomicBool = AtomicBool::new(false);
    static DISPLAY_SLEEP_OBSERVED: AtomicBool = AtomicBool::new(false);
    static RECOVERY_PENDING_UNTIL_VISIBLE: AtomicBool = AtomicBool::new(false);
    static LAST_FRONTEND_ACK: AtomicU64 = AtomicU64::new(0);
    static COORDINATOR: Mutex<RecoveryCoordinator> = Mutex::new(RecoveryCoordinator {
        next_generation: 0,
        running_generation: None,
        pending: None,
        last_finished_ms: None,
    });
    static CLOCK_ORIGIN: OnceLock<Instant> = OnceLock::new();
    static DIAGNOSTIC_LINES: AtomicUsize = AtomicUsize::new(0);

    // These symbols are public AppKit constants. Declaring them here avoids
    // requiring the broad objc2-app-kit `NSWorkspace` feature solely for three
    // notification names.
    #[link(name = "AppKit", kind = "framework")]
    extern "C" {
        static NSWorkspaceDidWakeNotification: &'static NSNotificationName;
        static NSWorkspaceWillSleepNotification: &'static NSNotificationName;
        static NSWorkspaceScreensDidSleepNotification: &'static NSNotificationName;
        static NSWorkspaceScreensDidWakeNotification: &'static NSNotificationName;
        static NSApplicationDidChangeScreenParametersNotification: &'static NSNotificationName;
    }

    // CoreGraphics polling is intentionally only a backstop for a missed
    // NSWorkspace notification. The NSWorkspace notifications cover all screens;
    // this fallback can only observe the current main display.
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGMainDisplayID() -> u32;
        fn CGDisplayIsAsleep(display: u32) -> i32;
    }

    fn main_display_asleep() -> bool {
        unsafe { CGDisplayIsAsleep(CGMainDisplayID()) != 0 }
    }

    fn monotonic_ms() -> u64 {
        CLOCK_ORIGIN
            .get_or_init(Instant::now)
            .elapsed()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX)
    }

    fn bounded_field(value: &str, max_chars: usize) -> String {
        value
            .chars()
            .take(max_chars)
            .map(|ch| match ch {
                '\n' | '\r' | '\t' => ' ',
                ch if ch.is_control() => '?',
                ch => ch,
            })
            .collect()
    }

    fn diagnostic(event: &str, generation: Option<u64>, source: &str, detail: &str) {
        let line = DIAGNOSTIC_LINES.fetch_add(1, Ordering::Relaxed);
        if line >= MAX_DIAGNOSTIC_LINES {
            if line == MAX_DIAGNOSTIC_LINES {
                eprintln!(
                    "[display-recovery] event=diagnostics-capped max_lines={MAX_DIAGNOSTIC_LINES}"
                );
            }
            return;
        }

        let generation = generation
            .map(|value| value.to_string())
            .unwrap_or_else(|| "none".to_string());
        eprintln!(
            "[display-recovery] event={} generation={} source={} detail={}",
            bounded_field(event, 40),
            generation,
            bounded_field(source, 64),
            bounded_field(detail, 160),
        );
    }

    struct DisplayWakeObserverIvars {
        app: AppHandle,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements. The observer owns
        // its AppHandle ivar and implements no custom Drop behavior.
        #[unsafe(super(NSObject))]
        #[ivars = DisplayWakeObserverIvars]
        struct DisplayWakeObserver;

        impl DisplayWakeObserver {
            #[unsafe(method(systemWillSleep:))]
            fn system_will_sleep(&self, _notification: &NSNotification) {
                DISPLAY_SLEEP_OBSERVED.store(true, Ordering::Release);
                diagnostic("system-will-sleep", None, "nsworkspace", "notification received");
            }

            #[unsafe(method(screensDidSleep:))]
            fn screens_did_sleep(&self, _notification: &NSNotification) {
                DISPLAY_SLEEP_OBSERVED.store(true, Ordering::Release);
                diagnostic("screens-slept", None, "nsworkspace", "notification received");
            }

            #[unsafe(method(screensDidWake:))]
            fn screens_did_wake(&self, _notification: &NSNotification) {
                DISPLAY_SLEEP_OBSERVED.store(false, Ordering::Release);
                request_internal(&self.ivars().app, "nsworkspace-screens-wake", false);
            }

            #[unsafe(method(systemDidWake:))]
            fn system_did_wake(&self, _notification: &NSNotification) {
                if main_display_asleep() {
                    DISPLAY_SLEEP_OBSERVED.store(true, Ordering::Release);
                    diagnostic(
                        "system-wake-deferred",
                        None,
                        "nsworkspace-system-wake",
                        "main display is still asleep; waiting for screen wake",
                    );
                    return;
                }
                DISPLAY_SLEEP_OBSERVED.store(false, Ordering::Release);
                request_internal(&self.ivars().app, "nsworkspace-system-wake", false);
            }

            #[unsafe(method(screenParametersChanged:))]
            fn screen_parameters_changed(&self, _notification: &NSNotification) {
                if monotonic_ms() < STARTUP_SCREEN_CHANGE_GRACE_MS {
                    diagnostic(
                        "screen-change-suppressed",
                        None,
                        "appkit-screen-parameters",
                        "ignored during startup grace period",
                    );
                    return;
                }
                if main_display_asleep() {
                    DISPLAY_SLEEP_OBSERVED.store(true, Ordering::Release);
                    diagnostic(
                        "screen-change-deferred",
                        None,
                        "appkit-screen-parameters",
                        "main display is still asleep",
                    );
                    return;
                }
                request_internal(&self.ivars().app, "appkit-screen-parameters", false);
            }

        }

        unsafe impl NSObjectProtocol for DisplayWakeObserver {}
    );

    impl DisplayWakeObserver {
        fn new(app: AppHandle) -> Retained<Self> {
            let observer = Self::alloc().set_ivars(DisplayWakeObserverIvars { app });
            unsafe { msg_send![super(observer), init] }
        }
    }

    struct WorkspaceObserverRegistration {
        workspace_center: Retained<NSNotificationCenter>,
        default_center: Retained<NSNotificationCenter>,
        observer: Retained<DisplayWakeObserver>,
    }

    impl Drop for WorkspaceObserverRegistration {
        fn drop(&mut self) {
            // SAFETY: `observer` is the same live object registered below.
            unsafe {
                self.workspace_center.removeObserver(&self.observer);
                self.default_center.removeObserver(&self.observer);
            }
        }
    }

    thread_local! {
        // AppKit observer objects remain owned on the main thread for the app's
        // lifetime. This also avoids imposing Send/Sync on Objective-C objects.
        static WORKSPACE_OBSERVER: RefCell<Option<WorkspaceObserverRegistration>> = const {
            RefCell::new(None)
        };
    }

    fn install_workspace_observer(app: AppHandle) {
        WORKSPACE_OBSERVER.with(|slot| {
            if slot.borrow().is_some() {
                return;
            }

            // SAFETY: NSWorkspace is an AppKit singleton and `notificationCenter`
            // returns its valid NSNotificationCenter. Registration and observer
            // lifetime are both confined to this main-thread closure.
            let workspace: Retained<AnyObject> =
                unsafe { msg_send![class!(NSWorkspace), sharedWorkspace] };
            let workspace_center: Retained<NSNotificationCenter> =
                unsafe { msg_send![&workspace, notificationCenter] };
            let default_center = NSNotificationCenter::defaultCenter();
            let observer = DisplayWakeObserver::new(app);

            unsafe {
                workspace_center.addObserver_selector_name_object(
                    &observer,
                    sel!(systemWillSleep:),
                    Some(NSWorkspaceWillSleepNotification),
                    None,
                );
                workspace_center.addObserver_selector_name_object(
                    &observer,
                    sel!(screensDidSleep:),
                    Some(NSWorkspaceScreensDidSleepNotification),
                    None,
                );
                workspace_center.addObserver_selector_name_object(
                    &observer,
                    sel!(screensDidWake:),
                    Some(NSWorkspaceScreensDidWakeNotification),
                    None,
                );
                workspace_center.addObserver_selector_name_object(
                    &observer,
                    sel!(systemDidWake:),
                    Some(NSWorkspaceDidWakeNotification),
                    None,
                );
                default_center.addObserver_selector_name_object(
                    &observer,
                    sel!(screenParametersChanged:),
                    Some(NSApplicationDidChangeScreenParametersNotification),
                    None,
                );
            }

            slot.replace(Some(WorkspaceObserverRegistration {
                workspace_center,
                default_center,
                observer,
            }));
            diagnostic(
                "observer-installed",
                None,
                "nsworkspace",
                "sleep/wake and screen-parameter notifications registered",
            );
        });
    }

    fn start_polling_fallback(app: AppHandle) {
        if FALLBACK_STARTED.swap(true, Ordering::AcqRel) {
            return;
        }
        let result = std::thread::Builder::new()
            .name("display-wake-fallback".into())
            .spawn(move || {
                let mut was_asleep = main_display_asleep();
                loop {
                    std::thread::sleep(FALLBACK_POLL_INTERVAL);
                    let asleep = main_display_asleep();
                    if asleep {
                        DISPLAY_SLEEP_OBSERVED.store(true, Ordering::Release);
                    }
                    if was_asleep && !asleep {
                        DISPLAY_SLEEP_OBSERVED.store(false, Ordering::Release);
                        request_internal(&app, "coregraphics-poll-wake", false);
                    }
                    was_asleep = asleep;
                }
            });

        if let Err(error) = result {
            FALLBACK_STARTED.store(false, Ordering::Release);
            diagnostic(
                "fallback-start-failed",
                None,
                "coregraphics-poll",
                &error.to_string(),
            );
        }
    }

    pub fn start(app: AppHandle) {
        if STARTED.swap(true, Ordering::AcqRel) {
            return;
        }
        CLOCK_ORIGIN.get_or_init(Instant::now);

        let observer_app = app.clone();
        if let Err(error) = app.run_on_main_thread(move || install_workspace_observer(observer_app))
        {
            STARTED.store(false, Ordering::Release);
            diagnostic(
                "observer-schedule-failed",
                None,
                "nsworkspace",
                &error.to_string(),
            );
        }
        start_polling_fallback(app);
    }

    pub fn request_recovery(app: &AppHandle, source: &str) {
        // Explicit callers (the native menu/tray) are never dropped by the
        // post-recovery quiet period. They retain one follow-up while active.
        request_internal(app, source, true);
    }

    pub fn runtime_resumed(app: &AppHandle) {
        // Tauri's desktop `RunEvent::Resumed` is an event-loop lifecycle signal,
        // not a power notification; it may also be produced by a normal poll.
        // Only use it when AppKit/CoreGraphics previously observed display sleep.
        // Never consume that marker while the display is still unavailable: a
        // polling event can arrive before the real wake notification.
        if main_display_asleep() {
            return;
        }
        if DISPLAY_SLEEP_OBSERVED.swap(false, Ordering::AcqRel) {
            request_internal(app, "tauri-resumed-after-observed-sleep", false);
        }
    }

    pub fn recover_if_pending(app: &AppHandle, source: &str) {
        if RECOVERY_PENDING_UNTIL_VISIBLE.swap(false, Ordering::AcqRel) {
            request_internal(app, source, true);
        }
    }

    pub fn acknowledge_recovery_event(generation: u64) {
        // A delayed acknowledgement for an older generation must not overwrite
        // evidence that the renderer already received a newer event.
        LAST_FRONTEND_ACK.fetch_max(generation, Ordering::AcqRel);
        diagnostic(
            "frontend-event-acknowledged",
            Some(generation),
            "frontend",
            "renderer received the native recovery event",
        );
    }

    fn request_internal(app: &AppHandle, source: &str, force: bool) {
        let source = bounded_field(source, 64);
        let decision = {
            let mut coordinator = COORDINATOR
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            coordinator.request(monotonic_ms(), source.clone(), force)
        };

        match decision {
            RequestDecision::Start(request) => spawn_driver(app.clone(), request),
            RequestDecision::Coalesced(generation) => diagnostic(
                "request-coalesced",
                Some(generation),
                &source,
                "duplicate wake signal joined the active cycle",
            ),
            RequestDecision::Queued(generation) => diagnostic(
                "request-queued",
                Some(generation),
                &source,
                "explicit request retained as one follow-up cycle",
            ),
            RequestDecision::Suppressed => diagnostic(
                "request-suppressed",
                None,
                &source,
                "fallback duplicate inside quiet period",
            ),
        }
    }

    fn spawn_driver(app: AppHandle, request: super::PendingRecovery) {
        let generation = request.generation;
        let result = std::thread::Builder::new()
            .name("display-recovery-driver".into())
            .spawn(move || run_driver(app, request));

        if let Err(error) = result {
            let mut coordinator = COORDINATOR
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            coordinator.abort_start(generation);
            diagnostic(
                "driver-start-failed",
                Some(generation),
                "thread",
                &error.to_string(),
            );
        }
    }

    fn run_driver(app: AppHandle, mut request: super::PendingRecovery) {
        loop {
            diagnostic(
                "cycle-started",
                Some(request.generation),
                &request.source,
                "native main-webview recompose",
            );

            // Wake/display notifications arrive before WindowServer and
            // CoreAnimation have necessarily rebuilt their presentation state.
            // Wait off the UI thread so the first pulse is not consumed too early.
            std::thread::sleep(PRESENTATION_SETTLE);

            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                recompose_main_webview(&app, request.generation, &request.source)
            }));
            if outcome.is_err() {
                // Recovery must always fail open. If a panic occurred after the
                // hide step, enqueue Wry's ordinary show path before continuing.
                if let Some(webview) = app.get_webview("main") {
                    let _ = webview.show();
                }
                diagnostic(
                    "cycle-panicked",
                    Some(request.generation),
                    &request.source,
                    "panic contained; coordinator will continue",
                );
            }

            let decision = {
                let mut coordinator = COORDINATOR
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                coordinator.finish(request.generation, monotonic_ms())
            };

            match decision {
                FinishDecision::Start(next) => request = next,
                FinishDecision::Idle => break,
                FinishDecision::Stale => {
                    diagnostic(
                        "stale-finish",
                        Some(request.generation),
                        &request.source,
                        "ignored unexpected coordinator generation",
                    );
                    break;
                }
            }
        }
    }

    #[derive(Clone, Copy)]
    enum NativeStep {
        Hide,
        ShowAndInvalidate,
        Invalidate,
    }

    fn schedule_native_step(
        webview: &Webview,
        step: NativeStep,
    ) -> Result<mpsc::Receiver<Result<(), &'static str>>, String> {
        let (sender, receiver) = mpsc::sync_channel(1);
        webview
            .with_webview(move |platform| {
                let inner = platform.inner();
                if inner.is_null() {
                    let _ = sender.send(Err("native WKWebView handle was null"));
                    return;
                }

                // SAFETY: Tauri documents `PlatformWebview::inner()` as the
                // WKWebView pointer on macOS and runs this closure on the main
                // thread. The pointer is checked before borrowing it.
                let view = unsafe { &*(inner as *mut WKWebView) };
                match step {
                    NativeStep::Hide => {
                        view.setHidden(true);
                        view.setNeedsDisplay(true);
                    }
                    NativeStep::ShowAndInvalidate => {
                        view.setHidden(false);
                        view.setNeedsDisplay(true);
                        view.displayIfNeeded();
                    }
                    NativeStep::Invalidate => {
                        view.setNeedsDisplay(true);
                        view.displayIfNeeded();
                    }
                }
                let _ = sender.send(Ok(()));
            })
            .map_err(|error| error.to_string())?;
        Ok(receiver)
    }

    fn await_native_step(
        receiver: mpsc::Receiver<Result<(), &'static str>>,
    ) -> Result<(), String> {
        match receiver.recv_timeout(NATIVE_STEP_TIMEOUT) {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(error)) => Err(error.to_string()),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Err("main-thread native step timed out (it remains queued)".to_string())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("main-thread native step callback was dropped".to_string())
            }
        }
    }

    fn main_window_unpresentable_reason(app: &AppHandle) -> Option<&'static str> {
        let Some(window) = app.get_window("main") else {
            return Some("main window is not registered");
        };
        if window.is_minimized().unwrap_or(false) {
            return Some("main window is minimized");
        }
        if !window.is_visible().unwrap_or(true) {
            return Some("main window is hidden");
        }
        if !window.is_focused().unwrap_or(true) {
            return Some("main window is not focused");
        }
        None
    }

    fn wait_until_main_window_presentable(
        app: &AppHandle,
        generation: u64,
        source: &str,
    ) -> bool {
        let mut reason = main_window_unpresentable_reason(app);
        for _ in 0..PRESENTABILITY_RETRY_COUNT {
            if reason.is_none() {
                RECOVERY_PENDING_UNTIL_VISIBLE.store(false, Ordering::Release);
                return true;
            }
            std::thread::sleep(PRESENTABILITY_RETRY_INTERVAL);
            reason = main_window_unpresentable_reason(app);
        }

        if reason.is_none() {
            RECOVERY_PENDING_UNTIL_VISIBLE.store(false, Ordering::Release);
            return true;
        }

        // Publish pending before one final short recheck. If a focus event races
        // this boundary it either queues a follow-up cycle, or the recheck sees
        // the now-presentable window and this generation continues—never both.
        RECOVERY_PENDING_UNTIL_VISIBLE.store(true, Ordering::Release);
        std::thread::sleep(PRESENTABILITY_RACE_SETTLE);
        if main_window_unpresentable_reason(app).is_none() {
            if RECOVERY_PENDING_UNTIL_VISIBLE.swap(false, Ordering::AcqRel) {
                return true;
            }
            diagnostic(
                "cycle-deferred",
                Some(generation),
                source,
                "presentability event queued a follow-up recovery",
            );
            return false;
        }

        diagnostic(
            "cycle-deferred",
            Some(generation),
            source,
            reason.unwrap_or("main window is not presentable"),
        );
        false
    }

    fn recompose_main_webview(app: &AppHandle, generation: u64, source: &str) {
        if !wait_until_main_window_presentable(app, generation, source) {
            return;
        }

        let Some(webview) = app.get_webview("main") else {
            RECOVERY_PENDING_UNTIL_VISIBLE.store(true, Ordering::Release);
            diagnostic(
                "cycle-deferred",
                Some(generation),
                source,
                "main webview is not registered",
            );
            return;
        };

        let hide_result = match schedule_native_step(&webview, NativeStep::Hide) {
            Ok(receiver) => await_native_step(receiver),
            Err(error) => Err(error),
        };
        if let Err(error) = hide_result {
            diagnostic("hide-step-warning", Some(generation), source, &error);
        }

        // This sleep is on the recovery worker. Because the hide callback has
        // completed (or timed out) before show is enqueued, hide and show are
        // distinct main-thread tasks and never block the UI thread.
        std::thread::sleep(HIDDEN_DWELL);

        let show_result = match schedule_native_step(&webview, NativeStep::ShowAndInvalidate) {
            Ok(receiver) => await_native_step(receiver),
            Err(error) => Err(error),
        };
        if let Err(error) = show_result {
            diagnostic("show-step-warning", Some(generation), source, &error);
            // A failed/late native callback must never leave the app hidden.
            // This queues Wry's ordinary `set_visible(true)` path as a final
            // fail-safe; it still targets only the webview, not the window.
            if let Err(fallback_error) = webview.show() {
                diagnostic(
                    "show-failsafe-warning",
                    Some(generation),
                    source,
                    &fallback_error.to_string(),
                );
            }
        }

        std::thread::sleep(POST_SHOW_DWELL);

        // The main view is never intentionally hidden while its outer window is
        // presentable; child browser views use their own labels. Always ending
        // visible is therefore both the fail-open behavior and the state restore.

        // The native recompose does not depend on JavaScript. This event is an
        // additional best-effort request for xterm canvas recreation and PTY
        // health reconciliation after the view can present again.
        if let Err(error) = webview.emit("system-resumed", generation) {
            diagnostic(
                "frontend-event-warning",
                Some(generation),
                source,
                &error.to_string(),
            );
        }

        // Later main-loop/CoreAnimation commits are refresh-only: they do not
        // hide the view, alter geometry, steal focus, or resize any PTY. They
        // cover the case where the initial wake notification preceded the
        // compositor becoming fully presentable.
        for delay in LATE_INVALIDATION_DELAYS {
            std::thread::sleep(delay);
            match schedule_native_step(&webview, NativeStep::Invalidate) {
                Ok(receiver) => {
                    if let Err(error) = await_native_step(receiver) {
                        diagnostic(
                            "late-invalidation-warning",
                            Some(generation),
                            source,
                            &error,
                        );
                    }
                }
                Err(error) => diagnostic(
                    "late-invalidation-warning",
                    Some(generation),
                    source,
                    &error,
                ),
            }
        }

        if LAST_FRONTEND_ACK.load(Ordering::Acquire) < generation {
            diagnostic(
                "frontend-ack-missing",
                Some(generation),
                source,
                "renderer did not acknowledge within the bounded recovery cycle",
            );
        }

        diagnostic(
            "cycle-finished",
            Some(generation),
            source,
            "main webview hide/show/invalidate completed",
        );
    }
}

/// Starts macOS display notifications and a CoreGraphics polling fallback.
/// Calling this more than once is harmless. No-op on other platforms.
#[cfg(target_os = "macos")]
pub fn start(app: tauri::AppHandle) {
    imp::start(app);
}

#[cfg(not(target_os = "macos"))]
pub fn start(_app: tauri::AppHandle) {}

/// Requests a native recovery cycle. The native menu/tray can call this as an
/// escape hatch when the renderer is black or unresponsive. Requests are
/// generation-coalesced.
#[cfg(target_os = "macos")]
pub fn request_recovery(app: &tauri::AppHandle, source: &str) {
    imp::request_recovery(app, source);
}

#[cfg(not(target_os = "macos"))]
pub fn request_recovery(_app: &tauri::AppHandle, _source: &str) {}

/// Handles Tauri's event-loop `Resumed` signal without treating every ordinary
/// event-loop poll as a system wake. It recovers only after native display sleep
/// was observed.
#[cfg(target_os = "macos")]
pub fn runtime_resumed(app: &tauri::AppHandle) {
    imp::runtime_resumed(app);
}

#[cfg(not(target_os = "macos"))]
pub fn runtime_resumed(_app: &tauri::AppHandle) {}

/// Retries a wake recovery that was deferred while the main window was hidden
/// or minimized. Safe to call on ordinary focus/reopen events.
#[cfg(target_os = "macos")]
pub fn recover_if_pending(app: &tauri::AppHandle, source: &str) {
    imp::recover_if_pending(app, source);
}

#[cfg(not(target_os = "macos"))]
pub fn recover_if_pending(_app: &tauri::AppHandle, _source: &str) {}

/// Records that the frontend event loop handled a native recovery generation.
/// This contains no terminal or page data; it only distinguishes a live renderer
/// from a compositor-only failure in bounded diagnostics.
pub fn acknowledge_recovery_event(generation: u64) {
    #[cfg(target_os = "macos")]
    imp::acknowledge_recovery_event(generation);

    #[cfg(not(target_os = "macos"))]
    let _ = generation;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_request_starts_and_completion_returns_idle() {
        let mut state = RecoveryCoordinator::default();
        let RequestDecision::Start(request) = state.request(100, "wake".into(), false) else {
            panic!("first request should start");
        };
        assert_eq!(request.generation, 1);
        assert_eq!(state.finish(1, 200), FinishDecision::Idle);
        assert_eq!(state.running_generation, None);
    }

    #[test]
    fn duplicate_wake_requests_join_the_active_cycle() {
        let mut state = RecoveryCoordinator::default();
        let RequestDecision::Start(first) = state.request(100, "first".into(), false) else {
            panic!("first request should start");
        };
        assert_eq!(
            state.request(110, "second".into(), false),
            RequestDecision::Coalesced(first.generation)
        );
        assert_eq!(
            state.request(120, "third".into(), false),
            RequestDecision::Coalesced(first.generation)
        );
        assert_eq!(state.finish(first.generation, 200), FinishDecision::Idle);
    }

    #[test]
    fn explicit_requests_retain_only_the_newest_follow_up() {
        let mut state = RecoveryCoordinator::default();
        let RequestDecision::Start(first) = state.request(100, "wake".into(), false) else {
            panic!("first request should start");
        };
        assert!(matches!(
            state.request(110, "manual-one".into(), true),
            RequestDecision::Queued(2)
        ));
        assert!(matches!(
            state.request(120, "manual-two".into(), true),
            RequestDecision::Queued(3)
        ));
        let FinishDecision::Start(next) = state.finish(first.generation, 200) else {
            panic!("one explicit follow-up should start");
        };
        assert_eq!(next.generation, 3);
        assert_eq!(next.source, "manual-two");
        assert_eq!(state.finish(next.generation, 300), FinishDecision::Idle);
    }

    #[test]
    fn fallback_duplicate_is_quieted_but_explicit_request_is_not() {
        let mut state = RecoveryCoordinator::default();
        let RequestDecision::Start(first) = state.request(100, "wake".into(), false) else {
            panic!("first request should start");
        };
        assert_eq!(state.finish(first.generation, 200), FinishDecision::Idle);
        assert_eq!(
            state.request(500, "poll".into(), false),
            RequestDecision::Suppressed
        );
        assert!(matches!(
            state.request(500, "manual".into(), true),
            RequestDecision::Start(_)
        ));
    }

    #[test]
    fn stale_completion_does_not_change_the_running_generation() {
        let mut state = RecoveryCoordinator::default();
        let RequestDecision::Start(request) = state.request(100, "wake".into(), false) else {
            panic!("first request should start");
        };
        assert_eq!(state.finish(999, 200), FinishDecision::Stale);
        assert_eq!(state.running_generation, Some(request.generation));
    }
}
