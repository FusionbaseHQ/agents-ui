//! macOS display-topology and WebKit renderer recovery.
//!
//! Display notifications are deliberately treated as a burst: no native view
//! mutation is allowed until the trailing edge has been quiet. This prevents
//! AppKit/Wry work from racing a temporary detach while WindowServer reparents
//! views after an external display wakes.

const RECOVERY_QUIET_PERIOD_MS: u64 = 3_000;

fn topology_is_stable(
    now_ms: u64,
    last_signal_ms: u64,
    epoch: u64,
    display_asleep: bool,
    quiet_period_ms: u64,
) -> bool {
    !display_asleep
        && ((epoch == 0 && last_signal_ms == 0)
            || now_ms.saturating_sub(last_signal_ms) >= quiet_period_ms)
}

fn should_request_screen_parameter_recovery(
    now_ms: u64,
    startup_grace_ms: u64,
    main_display_asleep: bool,
) -> bool {
    !main_display_asleep && now_ms >= startup_grace_ms
}

fn clear_observed_sleep_epoch(
    observed_epoch: &std::sync::atomic::AtomicU64,
    presented_epoch: u64,
) -> bool {
    observed_epoch
        .compare_exchange(
            presented_epoch,
            0,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .is_ok()
}

fn native_failure_retry_delay_ms(failed_attempts: usize, backoff_ms: &[u64]) -> u64 {
    backoff_ms
        .get(failed_attempts.saturating_sub(1))
        .copied()
        .or_else(|| backoff_ms.last().copied())
        .unwrap_or(0)
}

fn hide_callback_is_current(
    active_generation: u64,
    callback_generation: u64,
    current_topology_epoch: u64,
    callback_topology_epoch: u64,
    topology_stable: bool,
) -> bool {
    active_generation == callback_generation
        && current_topology_epoch == callback_topology_epoch
        && topology_stable
}

fn content_reload_delay_ms(
    now_ms: u64,
    recent_attempts_ms: &[u64],
    window_ms: u64,
    backoff_ms: &[u64],
) -> u64 {
    if recent_attempts_ms.len() < backoff_ms.len() {
        backoff_ms[recent_attempts_ms.len()]
    } else {
        recent_attempts_ms
            .first()
            .map(|oldest| window_ms.saturating_sub(now_ms.saturating_sub(*oldest)))
            .unwrap_or(window_ms)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PendingRecovery {
    generation: u64,
    sleep_epoch: u64,
    topology_epoch: u64,
    force: bool,
    source: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CoveredEpochs {
    sleep: u64,
    topology: u64,
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
    running_sleep_epoch: Option<u64>,
    running_topology_epoch: Option<u64>,
    pending: Option<PendingRecovery>,
    last_finished_ms: Option<u64>,
    last_finished_sleep_epoch: Option<u64>,
    last_finished_topology_epoch: Option<u64>,
}

impl RecoveryCoordinator {
    fn request(
        &mut self,
        now_ms: u64,
        source: String,
        force: bool,
        sleep_epoch: u64,
        topology_epoch: u64,
    ) -> RequestDecision {
        // AppKit can report one physical wake through both the screen-wake and
        // system-wake channels. If a native recovery is already in flight, a
        // non-explicit signal for the same observed sleep belongs to that cycle
        // and must not cause a second visible hide/show. A genuinely newer
        // sleep epoch and explicit/manual requests each retain one follow-up.
        if let Some(running_generation) = self.running_generation {
            if !force
                && self.running_sleep_epoch == Some(sleep_epoch)
                && self.running_topology_epoch == Some(topology_epoch)
            {
                return RequestDecision::Coalesced(running_generation);
            }
        }

        if self.running_generation.is_none()
            && !force
            && self
                .last_finished_ms
                .is_some_and(|last| now_ms.saturating_sub(last) < RECOVERY_QUIET_PERIOD_MS)
            && self.last_finished_sleep_epoch == Some(sleep_epoch)
            && self.last_finished_topology_epoch == Some(topology_epoch)
        {
            return RequestDecision::Suppressed;
        }

        if self.running_generation.is_some() && !force {
            if let Some(existing) = self.pending.as_ref() {
                // A later automatic topology signal must not erase the user's
                // explicit follow-up. The forced cycle will itself wait for the
                // newest stable topology before touching the native view.
                if existing.force {
                    return RequestDecision::Queued(existing.generation);
                }
            }
        }

        self.next_generation = self.next_generation.wrapping_add(1).max(1);
        let request = PendingRecovery {
            generation: self.next_generation,
            sleep_epoch,
            topology_epoch,
            force,
            source,
        };

        if self.running_generation.is_some() {
            let generation = request.generation;
            self.pending = Some(request);
            RequestDecision::Queued(generation)
        } else {
            self.running_generation = Some(request.generation);
            self.running_sleep_epoch = Some(request.sleep_epoch);
            self.running_topology_epoch = Some(request.topology_epoch);
            RequestDecision::Start(request)
        }
    }

    fn finish(
        &mut self,
        generation: u64,
        covered: Option<CoveredEpochs>,
        now_ms: u64,
    ) -> FinishDecision {
        if self.running_generation != Some(generation) {
            return FinishDecision::Stale;
        }

        if let Some(covered) = covered {
            self.last_finished_ms = Some(now_ms);
            self.last_finished_sleep_epoch = Some(covered.sleep);
            self.last_finished_topology_epoch = Some(covered.topology);
        } else {
            // Failed/deferred work covered no topology. It must never cause a
            // real retry for the same edge to be suppressed as a duplicate.
            self.last_finished_ms = None;
            self.last_finished_sleep_epoch = None;
            self.last_finished_topology_epoch = None;
        }

        if let Some(next) = self.pending.take() {
            if !next.force
                && covered.is_some_and(|covered| {
                    next.sleep_epoch <= covered.sleep && next.topology_epoch <= covered.topology
                })
            {
                self.running_generation = None;
                self.running_sleep_epoch = None;
                self.running_topology_epoch = None;
                return FinishDecision::Idle;
            }
            self.running_generation = Some(next.generation);
            self.running_sleep_epoch = Some(next.sleep_epoch);
            self.running_topology_epoch = Some(next.topology_epoch);
            FinishDecision::Start(next)
        } else {
            self.running_generation = None;
            self.running_sleep_epoch = None;
            self.running_topology_epoch = None;
            FinishDecision::Idle
        }
    }

    fn abort_start(&mut self, generation: u64) {
        if self.running_generation == Some(generation) {
            self.running_generation = None;
            self.running_sleep_epoch = None;
            self.running_topology_epoch = None;
            self.pending = None;
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{
        clear_observed_sleep_epoch, content_reload_delay_ms, hide_callback_is_current,
        native_failure_retry_delay_ms, should_request_screen_parameter_recovery,
        topology_is_stable, CoveredEpochs, FinishDecision, RecoveryCoordinator, RequestDecision,
    };
    use objc2::runtime::{AnyObject, NSObject};
    use objc2::{class, define_class, msg_send, rc::Retained, sel, AllocAnyThread, DefinedClass};
    use objc2_foundation::{
        NSNotification, NSNotificationCenter, NSNotificationName, NSObjectProtocol,
    };
    use objc2_web_kit::WKWebView;
    use std::cell::RefCell;
    use std::collections::{HashMap, VecDeque};
    use std::ffi::c_void;
    use std::io::Write;
    use std::panic::AssertUnwindSafe;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter, Manager, Webview};

    const NATIVE_STEP_TIMEOUT: Duration = Duration::from_secs(2);
    const TOPOLOGY_QUIET_PERIOD: Duration = Duration::from_millis(1_250);
    const TOPOLOGY_POLL_INTERVAL: Duration = Duration::from_millis(75);
    const PRESENTABILITY_RETRY_INTERVAL: Duration = Duration::from_millis(100);
    const PRESENTABILITY_RACE_SETTLE: Duration = Duration::from_millis(50);
    const PRESENTABILITY_RETRY_COUNT: usize = 5;
    const PRESENTABILITY_READ_TIMEOUT: Duration = Duration::from_millis(500);
    const NATIVE_FAILURE_BACKOFF_MS: [u64; 7] = [250, 500, 1_000, 2_000, 5_000, 10_000, 30_000];
    const CONTAINED_PANIC_RETRY_DELAY: Duration = Duration::from_secs(5);
    const HIDDEN_DWELL: Duration = Duration::from_millis(45);
    const FRONTEND_ACK_WAIT: Duration = Duration::from_millis(350);
    const CONTENT_RELOAD_READY_WAIT: Duration = Duration::from_secs(8);
    const FALLBACK_POLL_INTERVAL: Duration = Duration::from_secs(2);
    const STARTUP_SCREEN_CHANGE_GRACE_MS: u64 = 5_000;
    const MAX_DIAGNOSTIC_LINES: usize = 2_048;

    static STARTED: AtomicBool = AtomicBool::new(false);
    static FALLBACK_STARTED: AtomicBool = AtomicBool::new(false);
    static OBSERVED_SLEEP_EPOCH: AtomicU64 = AtomicU64::new(0);
    static DISPLAY_AWAKE_EDGE_PENDING: AtomicBool = AtomicBool::new(false);
    static RECOVERY_PENDING_UNTIL_VISIBLE: AtomicBool = AtomicBool::new(false);
    static LAST_FRONTEND_ACK: AtomicU64 = AtomicU64::new(0);
    static TOPOLOGY_EPOCH: AtomicU64 = AtomicU64::new(0);
    static LAST_TOPOLOGY_SIGNAL_MS: AtomicU64 = AtomicU64::new(0);
    static SLEEP_EPOCH: AtomicU64 = AtomicU64::new(0);
    static LAST_RUNTIME_RESUME_SLEEP_EPOCH: AtomicU64 = AtomicU64::new(0);
    static ACTIVE_NATIVE_OPERATION_TOKEN: AtomicU64 = AtomicU64::new(0);
    static NEXT_NATIVE_OPERATION_TOKEN: AtomicU64 = AtomicU64::new(1);
    static MAIN_WEB_CONTENT_UNAVAILABLE: AtomicBool = AtomicBool::new(false);
    static COORDINATOR: Mutex<RecoveryCoordinator> = Mutex::new(RecoveryCoordinator {
        next_generation: 0,
        running_generation: None,
        running_sleep_epoch: None,
        running_topology_epoch: None,
        pending: None,
        last_finished_ms: None,
        last_finished_sleep_epoch: None,
        last_finished_topology_epoch: None,
    });
    static RECOVERY_APP: OnceLock<AppHandle> = OnceLock::new();
    static GATE_RECOVERY_NEEDED: AtomicBool = AtomicBool::new(false);
    static CLOCK_ORIGIN: OnceLock<Instant> = OnceLock::new();
    static DIAGNOSTIC_LINES: AtomicUsize = AtomicUsize::new(0);
    static CONTENT_RELOADS: Mutex<Option<HashMap<String, ContentReloadState>>> = Mutex::new(None);

    const CONTENT_RELOAD_WINDOW_MS: u64 = 60_000;
    const CONTENT_RELOAD_BACKOFF_MS: [u64; 4] = [100, 500, 2_000, 5_000];

    #[derive(Default)]
    struct ContentReloadState {
        worker_running: bool,
        attempts_ms: VecDeque<u64>,
    }

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

    fn next_native_operation_token() -> u64 {
        loop {
            let token = NEXT_NATIVE_OPERATION_TOKEN.fetch_add(1, Ordering::Relaxed);
            if token != 0 {
                return token;
            }
        }
    }

    fn next_sleep_epoch() -> u64 {
        loop {
            let epoch = SLEEP_EPOCH.fetch_add(1, Ordering::AcqRel).wrapping_add(1);
            if epoch != 0 {
                return epoch;
            }
        }
    }

    fn record_topology_signal(source: &str) -> u64 {
        let now = monotonic_ms();
        // Store the timestamp first. A racing reader may conservatively block
        // native work before it sees the new epoch, but can never fail open.
        LAST_TOPOLOGY_SIGNAL_MS.store(now, Ordering::Release);
        let epoch = TOPOLOGY_EPOCH
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1)
            .max(1);
        diagnostic("topology-signal", None, source, &format!("epoch={epoch}"));
        epoch
    }

    fn mark_display_sleep(source: &str) {
        // Duplicate system/screens sleep notifications belong to one physical
        // asleep interval. Once an awake edge has been observed, however, a
        // subsequent sleep always gets a new tagged epoch even if an older
        // recovery has not finished clearing its own marker yet.
        if !DISPLAY_AWAKE_EDGE_PENDING.swap(true, Ordering::AcqRel) {
            OBSERVED_SLEEP_EPOCH.store(next_sleep_epoch(), Ordering::Release);
        }
        record_topology_signal(source);
    }

    fn record_display_wake(source: &str) {
        DISPLAY_AWAKE_EDGE_PENDING.store(false, Ordering::Release);
        record_topology_signal(source);
    }

    fn reserve_gate_discovered_recovery() {
        if let Some(app) = RECOVERY_APP.get() {
            request_internal(app, "native-gate-observed-display-wake", false);
            return;
        }

        GATE_RECOVERY_NEEDED.store(true, Ordering::Release);
        // Close the pre-start publication race: `start` may have installed the
        // handle and checked the flag between our first lookup and store.
        if let Some(app) = RECOVERY_APP.get() {
            if GATE_RECOVERY_NEEDED.swap(false, Ordering::AcqRel) {
                request_internal(app, "native-gate-observed-display-wake", false);
            }
        }
    }

    pub fn native_view_operations_allowed() -> bool {
        let display_asleep = main_display_asleep();
        if display_asleep {
            DISPLAY_AWAKE_EDGE_PENDING.store(true, Ordering::Release);
        } else if DISPLAY_AWAKE_EDGE_PENDING.swap(false, Ordering::AcqRel) {
            // This closes the missed-notification fallback gap: whichever safe
            // caller first observes the display awake establishes a fresh
            // trailing-edge quiet period before touching AppKit views.
            record_topology_signal("native-gate-observed-display-wake");
            // This branch exists specifically as the missed-notification
            // fallback. Reserve a recovery here as well as publishing the
            // topology edge, otherwise a gate call just after driver
            // finalization could leave the main view idle forever.
            reserve_gate_discovered_recovery();
            return false;
        }
        let epoch = TOPOLOGY_EPOCH.load(Ordering::Acquire);
        topology_is_stable(
            monotonic_ms(),
            LAST_TOPOLOGY_SIGNAL_MS.load(Ordering::Acquire),
            epoch,
            display_asleep,
            TOPOLOGY_QUIET_PERIOD.as_millis() as u64,
        )
    }

    fn wait_for_stable_topology(generation: u64, source: &str) -> CoveredEpochs {
        let mut last_wait_log = monotonic_ms();
        loop {
            let epoch = TOPOLOGY_EPOCH.load(Ordering::Acquire);
            if native_view_operations_allowed() {
                // Close the read/check race: a notification immediately after
                // the first check must extend the quiet window, not overlap a
                // native view mutation.
                std::thread::sleep(TOPOLOGY_POLL_INTERVAL);
                if epoch == TOPOLOGY_EPOCH.load(Ordering::Acquire)
                    && native_view_operations_allowed()
                {
                    let covered = CoveredEpochs {
                        sleep: SLEEP_EPOCH.load(Ordering::Acquire),
                        topology: epoch,
                    };
                    // `mark_display_sleep` publishes the sleep epoch before its
                    // topology edge. Recheck both values so the returned pair
                    // can only describe one fully observed stable edge.
                    if covered.topology == TOPOLOGY_EPOCH.load(Ordering::Acquire)
                        && covered.sleep == SLEEP_EPOCH.load(Ordering::Acquire)
                        && native_view_operations_allowed()
                    {
                        return covered;
                    }
                }
            }

            let now = monotonic_ms();
            if now.saturating_sub(last_wait_log) >= 5_000 {
                diagnostic(
                    "topology-waiting",
                    Some(generation),
                    source,
                    "display is asleep or topology notifications are still arriving",
                );
                last_wait_log = now;
            }
            std::thread::sleep(TOPOLOGY_POLL_INTERVAL);
        }
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
                let _ = writeln!(
                    std::io::stderr().lock(),
                    "[display-recovery] event=diagnostics-capped max_lines={MAX_DIAGNOSTIC_LINES}"
                );
            }
            return;
        }

        let generation = generation
            .map(|value| value.to_string())
            .unwrap_or_else(|| "none".to_string());
        let _ = writeln!(
            std::io::stderr().lock(),
            "[display-recovery] event={} generation={} source={} detail={}",
            bounded_field(event, 40),
            generation,
            bounded_field(source, 64),
            bounded_field(detail, 160),
        );
    }

    fn contain_observer_callback(source: &'static str, callback: impl FnOnce()) {
        if std::panic::catch_unwind(AssertUnwindSafe(callback)).is_err() {
            diagnostic(
                "observer-callback-panicked",
                None,
                source,
                "Rust panic was contained before crossing the AppKit callback boundary",
            );
        }
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
                contain_observer_callback("nsworkspace-system-sleep", || {
                    mark_display_sleep("nsworkspace-system-sleep");
                    diagnostic(
                        "system-will-sleep",
                        None,
                        "nsworkspace",
                        "notification received",
                    );
                });
            }

            #[unsafe(method(screensDidSleep:))]
            fn screens_did_sleep(&self, _notification: &NSNotification) {
                contain_observer_callback("nsworkspace-screens-sleep", || {
                    mark_display_sleep("nsworkspace-screens-sleep");
                    diagnostic(
                        "screens-slept",
                        None,
                        "nsworkspace",
                        "notification received",
                    );
                });
            }

            #[unsafe(method(screensDidWake:))]
            fn screens_did_wake(&self, _notification: &NSNotification) {
                contain_observer_callback("nsworkspace-screens-wake", || {
                    record_display_wake("nsworkspace-screens-wake");
                    request_internal(&self.ivars().app, "nsworkspace-screens-wake", false);
                });
            }

            #[unsafe(method(systemDidWake:))]
            fn system_did_wake(&self, _notification: &NSNotification) {
                contain_observer_callback("nsworkspace-system-wake", || {
                    if main_display_asleep() {
                        mark_display_sleep("nsworkspace-system-wake-deferred");
                        request_internal(
                            &self.ivars().app,
                            "nsworkspace-system-wake-deferred",
                            false,
                        );
                        diagnostic(
                            "system-wake-deferred",
                            None,
                            "nsworkspace-system-wake",
                            "main display is still asleep; waiting for screen wake",
                        );
                        return;
                    }
                    record_display_wake("nsworkspace-system-wake");
                    request_internal(&self.ivars().app, "nsworkspace-system-wake", false);
                });
            }

            #[unsafe(method(screenParametersChanged:))]
            fn screen_parameters_changed(&self, _notification: &NSNotification) {
                contain_observer_callback("appkit-screen-parameters", || {
                    let display_asleep = main_display_asleep();
                    if display_asleep {
                        mark_display_sleep("appkit-screen-parameters-asleep");
                        request_internal(
                            &self.ivars().app,
                            "appkit-screen-parameters-asleep",
                            false,
                        );
                        diagnostic(
                            "screen-change-deferred",
                            None,
                            "appkit-screen-parameters",
                            "main display is still asleep",
                        );
                        return;
                    }

                    record_display_wake("appkit-screen-parameters");
                    if !should_request_screen_parameter_recovery(
                        monotonic_ms(),
                        STARTUP_SCREEN_CHANGE_GRACE_MS,
                        display_asleep,
                    ) {
                        diagnostic(
                            "screen-change-suppressed",
                            None,
                            "appkit-screen-parameters",
                            "ignored during startup grace period",
                        );
                        return;
                    }
                    // External displays can independently power-save while the
                    // built-in/main display remains awake, yielding only this
                    // notification. The driver is safe to reserve immediately and
                    // will not mutate native views until the trailing edge settles.
                    request_internal(&self.ivars().app, "appkit-screen-parameters", false);
                });
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
                if was_asleep {
                    mark_display_sleep("coregraphics-poll-initial-sleep");
                }
                loop {
                    std::thread::sleep(FALLBACK_POLL_INTERVAL);
                    let asleep = main_display_asleep();
                    if !was_asleep && asleep {
                        mark_display_sleep("coregraphics-poll-sleep");
                    }
                    if was_asleep && !asleep {
                        record_display_wake("coregraphics-poll-wake");
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
        let _ = RECOVERY_APP.set(app.clone());
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
        if GATE_RECOVERY_NEEDED.swap(false, Ordering::AcqRel) {
            if let Some(app) = RECOVERY_APP.get() {
                request_internal(app, "native-gate-prestart-display-wake", false);
            }
        }
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
        let sleep_epoch = OBSERVED_SLEEP_EPOCH.load(Ordering::Acquire);
        if sleep_epoch != 0 {
            if LAST_RUNTIME_RESUME_SLEEP_EPOCH.swap(sleep_epoch, Ordering::AcqRel) != sleep_epoch {
                record_topology_signal("tauri-resumed-after-observed-sleep");
            }
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

    fn reserve_content_reload_worker(label: &str) -> bool {
        let mut states = CONTENT_RELOADS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let states = states.get_or_insert_with(HashMap::new);
        let state = states.entry(label.to_string()).or_default();
        if state.worker_running {
            return false;
        }
        state.worker_running = true;
        true
    }

    fn next_content_reload_delay(label: &str) -> Duration {
        let now = monotonic_ms();
        let mut states = CONTENT_RELOADS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let states = states.get_or_insert_with(HashMap::new);
        let state = states.entry(label.to_string()).or_default();
        while state
            .attempts_ms
            .front()
            .is_some_and(|at| now.saturating_sub(*at) >= CONTENT_RELOAD_WINDOW_MS)
        {
            state.attempts_ms.pop_front();
        }
        let attempts = state.attempts_ms.make_contiguous();
        let delay_ms = content_reload_delay_ms(
            now,
            attempts,
            CONTENT_RELOAD_WINDOW_MS,
            &CONTENT_RELOAD_BACKOFF_MS,
        );
        Duration::from_millis(delay_ms)
    }

    fn record_content_reload_attempt(label: &str) {
        let now = monotonic_ms();
        let mut states = CONTENT_RELOADS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let states = states.get_or_insert_with(HashMap::new);
        let state = states.entry(label.to_string()).or_default();
        state.attempts_ms.push_back(now);
        while state
            .attempts_ms
            .front()
            .is_some_and(|at| now.saturating_sub(*at) >= CONTENT_RELOAD_WINDOW_MS)
        {
            state.attempts_ms.pop_front();
        }
    }

    fn release_content_reload_worker(label: &str) {
        let mut states = CONTENT_RELOADS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let states = states.get_or_insert_with(HashMap::new);
        states.entry(label.to_string()).or_default().worker_running = false;
    }

    /// Clears worker ownership only while holding the same mutex a racing
    /// termination must acquire to reserve the next worker. This prevents a
    /// ready→new-termination edge from being lost between an atomic flag read
    /// and releasing the worker slot.
    fn release_content_reload_worker_if_ready(label: &str) -> bool {
        let mut states = CONTENT_RELOADS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if MAIN_WEB_CONTENT_UNAVAILABLE.load(Ordering::Acquire) {
            return false;
        }
        let states = states.get_or_insert_with(HashMap::new);
        states.entry(label.to_string()).or_default().worker_running = false;
        true
    }

    fn wait_while_content_unavailable(duration: Duration) -> bool {
        let deadline = Instant::now() + duration;
        loop {
            if !MAIN_WEB_CONTENT_UNAVAILABLE.load(Ordering::Acquire) {
                return false;
            }
            let now = Instant::now();
            if now >= deadline {
                return true;
            }
            std::thread::sleep(
                deadline
                    .saturating_duration_since(now)
                    .min(TOPOLOGY_POLL_INTERVAL),
            );
        }
    }

    fn run_content_reload_worker(webview: Webview, label: String) {
        loop {
            if release_content_reload_worker_if_ready(&label) {
                return;
            }

            let delay = next_content_reload_delay(&label);
            if !wait_while_content_unavailable(delay) {
                continue;
            }
            while MAIN_WEB_CONTENT_UNAVAILABLE.load(Ordering::Acquire)
                && !native_view_operations_allowed()
            {
                std::thread::sleep(TOPOLOGY_POLL_INTERVAL);
            }
            if !MAIN_WEB_CONTENT_UNAVAILABLE.load(Ordering::Acquire) {
                continue;
            }

            record_content_reload_attempt(&label);
            let result = schedule_native_reload(&webview).and_then(await_native_reload);
            let succeeded = result.is_ok();
            match &result {
                Ok(()) => diagnostic(
                    "web-content-reload-dispatched",
                    None,
                    &label,
                    "acknowledged native reload dispatched after topology became stable",
                ),
                Err(error) => diagnostic("web-content-reload-failed", None, &label, error),
            }

            // A successful dispatcher acknowledgement does not prove that a
            // replacement WebContent process reached JavaScript. Keep the one
            // bounded/rate-limited worker alive until the new renderer installs
            // its PTY listeners, otherwise a silently failed reload would make
            // native recovery stay suppressed forever.
            if succeeded {
                let _ = wait_while_content_unavailable(CONTENT_RELOAD_READY_WAIT);
            }
        }
    }

    fn ensure_main_content_reload_worker(webview: &Webview, label: &str) {
        if !reserve_content_reload_worker(label) {
            diagnostic(
                "web-content-reload-coalesced",
                None,
                label,
                "the persistent reload worker already owns recovery",
            );
            return;
        }

        let worker_webview = webview.clone();
        let worker_label = label.to_string();
        if let Err(error) = std::thread::Builder::new()
            .name("web-content-reloader".into())
            .spawn(move || run_content_reload_worker(worker_webview, worker_label))
        {
            release_content_reload_worker(label);
            diagnostic(
                "web-content-reloader-start-failed",
                None,
                label,
                &error.to_string(),
            );
            // Do not reload synchronously from WebKit's termination delegate.
            // A later native recovery request or termination notification will
            // retry worker creation without delegate reentrancy.
        }
    }

    pub fn handle_main_web_content_terminated(webview: &Webview) {
        let label = webview.label().to_string();
        MAIN_WEB_CONTENT_UNAVAILABLE.store(true, Ordering::Release);
        diagnostic(
            "web-content-terminated",
            None,
            &label,
            "WebKit reported renderer-process termination",
        );
        ensure_main_content_reload_worker(webview, &label);
    }

    pub fn renderer_listener_ready() {
        if MAIN_WEB_CONTENT_UNAVAILABLE.swap(false, Ordering::AcqRel) {
            diagnostic(
                "web-content-listener-ready",
                None,
                "main",
                "replacement renderer installed its PTY listeners",
            );
        }
        if let Some(app) = RECOVERY_APP.get() {
            crate::browser::mark_main_renderer_ready(app);
        }
    }

    fn request_internal(app: &AppHandle, source: &str, force: bool) {
        let source = bounded_field(source, 64);
        let decision = {
            let mut coordinator = COORDINATOR
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            coordinator.request(
                monotonic_ms(),
                source.clone(),
                force,
                SLEEP_EPOCH.load(Ordering::Acquire),
                TOPOLOGY_EPOCH.load(Ordering::Acquire),
            )
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

    /// Tauri-runtime-wry 2.11.4 constructs `PlatformWebview` by converting
    /// three freshly retained Objective-C objects with `Retained::into_raw`.
    /// `PlatformWebview` has no Drop implementation, so an ordinary
    /// `with_webview` call leaks the WKWebView, content controller, and window.
    /// Keep this balancing shim coupled to the locked runtime and re-audit it
    /// whenever that dependency changes (upstream tauri-apps/tauri#15210).
    struct PlatformRetainBalance([*mut AnyObject; 3]);

    impl Drop for PlatformRetainBalance {
        fn drop(&mut self) {
            for pointer in self.0 {
                if !pointer.is_null() {
                    // SAFETY: runtime-wry 2.11.4 handed each callback a +1
                    // pointer via `Retained::into_raw`. Reconstructing exactly
                    // one Retained per pointer balances those three ownerships.
                    unsafe {
                        drop(Retained::<AnyObject>::from_raw(pointer));
                    }
                }
            }
        }
    }

    pub fn with_webview_balanced(
        webview: &Webview,
        callback: impl FnOnce(*mut c_void) + Send + 'static,
    ) -> tauri::Result<()> {
        webview.with_webview(move |platform| {
            let _balance = PlatformRetainBalance([
                platform.inner().cast(),
                platform.controller().cast(),
                platform.ns_window().cast(),
            ]);
            if std::panic::catch_unwind(AssertUnwindSafe(|| callback(platform.inner()))).is_err() {
                diagnostic(
                    "webview-callback-panicked",
                    None,
                    "with-webview-balanced",
                    "Rust panic was contained before crossing the Tauri/AppKit callback boundary",
                );
            }
        })
    }

    fn run_driver(app: AppHandle, mut request: super::PendingRecovery) {
        loop {
            diagnostic(
                "cycle-started",
                Some(request.generation),
                &request.source,
                "waiting for trailing-edge display stability",
            );

            let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| {
                let mut failed_attempts = 0;
                loop {
                    let covered = wait_for_stable_topology(request.generation, &request.source);
                    if MAIN_WEB_CONTENT_UNAVAILABLE.load(Ordering::Acquire) {
                        if let Some(webview) = app.get_webview("main") {
                            ensure_main_content_reload_worker(&webview, "main");
                        }
                        diagnostic(
                            "cycle-reload-owned",
                            Some(request.generation),
                            &request.source,
                            "native pulse skipped while WebContent reload owns recovery",
                        );
                        break RecomposeResult::Presented(covered);
                    }
                    let result =
                        recompose_main_webview(&app, request.generation, covered, &request.source);
                    let retry_delay = match result {
                        RecomposeResult::Presented(_) | RecomposeResult::Deferred => break result,
                        RecomposeResult::RetryTopology => {
                            failed_attempts = 0;
                            diagnostic(
                                "cycle-retrying",
                                Some(request.generation),
                                &request.source,
                                "topology changed during the acknowledged pulse",
                            );
                            Duration::from_millis(250)
                        }
                        RecomposeResult::Failed => {
                            failed_attempts += 1;
                            let delay_ms = native_failure_retry_delay_ms(
                                failed_attempts,
                                &NATIVE_FAILURE_BACKOFF_MS,
                            );
                            diagnostic(
                                "cycle-retrying",
                                Some(request.generation),
                                &request.source,
                                &format!(
                                    "native recovery failed; attempt={failed_attempts} backoff_ms={delay_ms}"
                                ),
                            );
                            Duration::from_millis(delay_ms)
                        }
                    };
                    std::thread::sleep(retry_delay);
                }
            }));

            let cycle_result = match outcome {
                Ok(result) => result,
                Err(_) => {
                    ACTIVE_NATIVE_OPERATION_TOKEN.store(0, Ordering::Release);
                    if let Some(webview) = app.get_webview("main") {
                        let _ = schedule_native_step(&webview, NativeStep::Show);
                    }
                    diagnostic(
                        "cycle-panicked",
                        Some(request.generation),
                        &request.source,
                        "panic contained on the executing stack; show fail-safe queued",
                    );
                    RecomposeResult::Failed
                }
            };

            if let RecomposeResult::Presented(covered) = cycle_result {
                if !main_display_asleep()
                    && native_view_operations_allowed()
                    && TOPOLOGY_EPOCH.load(Ordering::Acquire) == covered.topology
                    && SLEEP_EPOCH.load(Ordering::Acquire) == covered.sleep
                {
                    // A newer sleep can publish its tagged epoch at any point.
                    // Clear only the exact epoch this presentation covered.
                    let _ = clear_observed_sleep_epoch(&OBSERVED_SLEEP_EPOCH, covered.sleep);
                }
            } else if cycle_result == RecomposeResult::Deferred {
                RECOVERY_PENDING_UNTIL_VISIBLE.store(true, Ordering::Release);
            }

            let covered = match cycle_result {
                RecomposeResult::Presented(covered) => Some(covered),
                _ => None,
            };
            if cycle_result == RecomposeResult::Failed {
                std::thread::sleep(CONTAINED_PANIC_RETRY_DELAY);
            }

            let decision = {
                let mut coordinator = COORDINATOR
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let latest_topology_epoch = TOPOLOGY_EPOCH.load(Ordering::Acquire);
                let latest_sleep_epoch = SLEEP_EPOCH.load(Ordering::Acquire);
                if covered.is_some_and(|covered| {
                    latest_topology_epoch > covered.topology || latest_sleep_epoch > covered.sleep
                }) {
                    // Close the final-check→finish race even when the topology
                    // edge was discovered by the native gate rather than a
                    // notification callback that could enqueue its own request.
                    let _ = coordinator.request(
                        monotonic_ms(),
                        "topology-changed-before-finalization".to_string(),
                        false,
                        latest_sleep_epoch,
                        latest_topology_epoch,
                    );
                }
                if cycle_result == RecomposeResult::Failed && coordinator.pending.is_none() {
                    let _ = coordinator.request(
                        monotonic_ms(),
                        "automatic-retry-after-contained-panic".to_string(),
                        true,
                        latest_sleep_epoch,
                        latest_topology_epoch,
                    );
                }
                coordinator.finish(request.generation, covered, monotonic_ms())
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
        Hide {
            operation_token: u64,
            topology_epoch: u64,
        },
        Show,
    }

    fn schedule_native_step(
        webview: &Webview,
        step: NativeStep,
    ) -> Result<mpsc::Receiver<Result<(), &'static str>>, String> {
        let (sender, receiver) = mpsc::sync_channel(1);
        with_webview_balanced(webview, move |inner| {
            let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                if inner.is_null() {
                    return Err("native WKWebView handle was null");
                }

                // SAFETY: Tauri documents the pointer as WKWebView and invokes
                // this closure on the AppKit thread. All Objective-C messages
                // execute inside objc2's native exception boundary.
                let native_result = objc2::exception::catch(AssertUnwindSafe(|| {
                    let view = unsafe { &*(inner as *mut WKWebView) };
                    match step {
                        NativeStep::Hide {
                            operation_token,
                            topology_epoch,
                        } => {
                            let active_operation_token =
                                ACTIVE_NATIVE_OPERATION_TOKEN.load(Ordering::Acquire);
                            let current_topology_epoch = TOPOLOGY_EPOCH.load(Ordering::Acquire);
                            let topology_stable = native_view_operations_allowed();
                            if active_operation_token != operation_token {
                                return Err("stale hide callback was cancelled");
                            }
                            if !hide_callback_is_current(
                                active_operation_token,
                                operation_token,
                                current_topology_epoch,
                                topology_epoch,
                                topology_stable,
                            ) {
                                return Err("topology changed before hide callback executed");
                            }
                            if view.window().is_none() || unsafe { view.superview() }.is_none() {
                                return Err("main WKWebView is temporarily detached");
                            }
                            view.setHidden(true);
                            view.setNeedsDisplay(true);
                            Ok(())
                        }
                        NativeStep::Show => {
                            // Show is intentionally generation-independent. Once
                            // a hide has executed, every stale/timeout path must
                            // still be able to restore visibility.
                            view.setHidden(false);
                            view.setNeedsDisplay(true);
                            Ok(())
                        }
                    }
                }));

                native_result.map_err(|_| "Objective-C exception during native recovery")?
            }));

            let result = match result {
                Ok(result) => result,
                Err(_) => Err("Rust panic during native recovery callback"),
            };
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
        Ok(receiver)
    }

    fn await_native_step(receiver: mpsc::Receiver<Result<(), &'static str>>) -> Result<(), String> {
        match receiver.recv_timeout(NATIVE_STEP_TIMEOUT) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(error.to_string()),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Err("main-thread native step timed out".to_string())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("main-thread native step callback was dropped".to_string())
            }
        }
    }

    struct ScheduledNativeReload {
        receiver: mpsc::Receiver<Result<(), &'static str>>,
        callback_allowed: Arc<AtomicBool>,
    }

    fn schedule_native_reload(webview: &Webview) -> Result<ScheduledNativeReload, String> {
        let (sender, receiver) = mpsc::sync_channel(1);
        let callback_allowed = Arc::new(AtomicBool::new(true));
        let native_callback_allowed = callback_allowed.clone();
        with_webview_balanced(webview, move |inner| {
            let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                if !native_callback_allowed.load(Ordering::Acquire) {
                    return Err("native reload callback was cancelled");
                }
                if !MAIN_WEB_CONTENT_UNAVAILABLE.load(Ordering::Acquire) {
                    return Err("replacement renderer is already ready");
                }
                if !native_view_operations_allowed() {
                    return Err("display topology changed before native reload");
                }
                if inner.is_null() {
                    return Err("native reload WKWebView handle was null");
                }

                objc2::exception::catch(AssertUnwindSafe(|| {
                    let view = unsafe { &*(inner as *mut WKWebView) };
                    if view.window().is_none() || unsafe { view.superview() }.is_none() {
                        return Err("native reload WKWebView is temporarily detached");
                    }
                    if !native_callback_allowed.load(Ordering::Acquire) {
                        return Err("native reload callback was cancelled");
                    }
                    if !MAIN_WEB_CONTENT_UNAVAILABLE.load(Ordering::Acquire) {
                        return Err("replacement renderer became ready before reload");
                    }
                    if unsafe { view.reload() }.is_none() {
                        return Err("WKWebView rejected the native reload request");
                    }
                    Ok(())
                }))
                .map_err(|_| "Objective-C exception during native reload")?
            }))
            .unwrap_or(Err("Rust panic during native reload callback"));
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;

        Ok(ScheduledNativeReload {
            receiver,
            callback_allowed,
        })
    }

    fn await_native_reload(scheduled: ScheduledNativeReload) -> Result<(), String> {
        match scheduled.receiver.recv_timeout(NATIVE_STEP_TIMEOUT) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(error.to_string()),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                scheduled.callback_allowed.store(false, Ordering::Release);
                Err("main-thread native reload timed out".to_string())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                scheduled.callback_allowed.store(false, Ordering::Release);
                Err("main-thread native reload callback was dropped".to_string())
            }
        }
    }

    fn main_window_unpresentable_reason(app: &AppHandle) -> Result<Option<&'static str>, String> {
        let webview = app
            .get_webview("main")
            .ok_or_else(|| "main webview is not registered".to_string())?;
        let (sender, receiver) = mpsc::sync_channel(1);
        let callback_allowed = Arc::new(AtomicBool::new(true));
        let native_callback_allowed = callback_allowed.clone();
        with_webview_balanced(&webview, move |inner| {
            let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                if !native_callback_allowed.load(Ordering::Acquire) {
                    return Err("presentability callback was cancelled".to_string());
                }
                if !native_view_operations_allowed() {
                    return Err("display topology changed during presentability read".to_string());
                }
                if inner.is_null() {
                    return Err("main WKWebView handle was null".to_string());
                }

                objc2::exception::catch(AssertUnwindSafe(|| {
                    let view = unsafe { &*(inner as *mut WKWebView) };
                    let window = view
                        .window()
                        .ok_or_else(|| "main WKWebView is detached from its window".to_string())?;
                    if unsafe { view.superview() }.is_none() {
                        return Err("main WKWebView is detached from its superview".to_string());
                    }
                    if !native_callback_allowed.load(Ordering::Acquire) {
                        return Err("presentability callback was cancelled".to_string());
                    }
                    if window.isMiniaturized() {
                        Ok(Some("main window is minimized"))
                    } else if !window.isVisible() {
                        Ok(Some("main window is hidden"))
                    } else if !window.isKeyWindow() {
                        Ok(Some("main window is not focused"))
                    } else {
                        Ok(None)
                    }
                }))
                .map_err(|_| "Objective-C exception during presentability read".to_string())?
            }))
            .unwrap_or_else(|_| Err("Rust panic during presentability callback".to_string()));
            let _ = sender.send(result);
        })
        .map_err(|error| format!("failed to queue presentability callback: {error}"))?;

        match receiver.recv_timeout(PRESENTABILITY_READ_TIMEOUT) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                callback_allowed.store(false, Ordering::Release);
                Err("main-thread presentability callback timed out".to_string())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                callback_allowed.store(false, Ordering::Release);
                Err("main-thread presentability callback was dropped".to_string())
            }
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum PresentabilityResult {
        Presentable,
        Deferred,
        Retry,
    }

    fn wait_until_main_window_presentable(
        app: &AppHandle,
        generation: u64,
        source: &str,
    ) -> PresentabilityResult {
        let mut result = main_window_unpresentable_reason(app);
        for _ in 0..PRESENTABILITY_RETRY_COUNT {
            if matches!(result, Ok(None)) {
                RECOVERY_PENDING_UNTIL_VISIBLE.store(false, Ordering::Release);
                return PresentabilityResult::Presentable;
            }
            std::thread::sleep(PRESENTABILITY_RETRY_INTERVAL);
            result = main_window_unpresentable_reason(app);
        }

        if matches!(result, Ok(None)) {
            RECOVERY_PENDING_UNTIL_VISIBLE.store(false, Ordering::Release);
            return PresentabilityResult::Presentable;
        }
        if let Err(error) = result {
            diagnostic(
                "presentability-read-warning",
                Some(generation),
                source,
                &error,
            );
            return PresentabilityResult::Retry;
        }

        // Publish pending only after positively observing a hidden, minimized,
        // or unfocused window. A timeout/read failure must stay on the driver's
        // persistent backoff path because no future focus event is guaranteed.
        RECOVERY_PENDING_UNTIL_VISIBLE.store(true, Ordering::Release);
        std::thread::sleep(PRESENTABILITY_RACE_SETTLE);
        match main_window_unpresentable_reason(app) {
            Ok(None) => {
                if RECOVERY_PENDING_UNTIL_VISIBLE.swap(false, Ordering::AcqRel) {
                    PresentabilityResult::Presentable
                } else {
                    diagnostic(
                        "cycle-deferred",
                        Some(generation),
                        source,
                        "presentability event queued a follow-up recovery",
                    );
                    PresentabilityResult::Deferred
                }
            }
            Ok(Some(reason)) => {
                diagnostic("cycle-deferred", Some(generation), source, reason);
                PresentabilityResult::Deferred
            }
            Err(error) => {
                RECOVERY_PENDING_UNTIL_VISIBLE.store(false, Ordering::Release);
                diagnostic(
                    "presentability-read-warning",
                    Some(generation),
                    source,
                    &error,
                );
                PresentabilityResult::Retry
            }
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum RecomposeResult {
        Presented(CoveredEpochs),
        RetryTopology,
        Deferred,
        Failed,
    }

    fn restore_visibility(
        webview: &Webview,
        operation_token: u64,
        generation: u64,
        source: &str,
    ) -> bool {
        let mut shown = false;
        for attempt in 1..=2 {
            let show_result = match schedule_native_step(webview, NativeStep::Show) {
                Ok(receiver) => await_native_step(receiver),
                Err(error) => Err(error),
            };
            match show_result {
                Ok(()) => {
                    shown = true;
                    break;
                }
                Err(error) => diagnostic(
                    "show-step-warning",
                    Some(generation),
                    source,
                    &format!("attempt={attempt} error={error}"),
                ),
            }
        }
        ACTIVE_NATIVE_OPERATION_TOKEN
            .compare_exchange(operation_token, 0, Ordering::AcqRel, Ordering::Acquire)
            .ok();
        shown
    }

    fn recompose_main_webview(
        app: &AppHandle,
        generation: u64,
        covered: CoveredEpochs,
        source: &str,
    ) -> RecomposeResult {
        match wait_until_main_window_presentable(app, generation, source) {
            PresentabilityResult::Presentable => {}
            PresentabilityResult::Deferred => return RecomposeResult::Deferred,
            PresentabilityResult::Retry => return RecomposeResult::Failed,
        }

        let Some(webview) = app.get_webview("main") else {
            RECOVERY_PENDING_UNTIL_VISIBLE.store(true, Ordering::Release);
            diagnostic(
                "cycle-deferred",
                Some(generation),
                source,
                "main webview is not registered",
            );
            return RecomposeResult::Deferred;
        };

        // This token is unique per native attempt, not merely per recovery
        // request. A Hide that times out on one retry can therefore never pass
        // its relevance check after the same request generation is re-armed.
        let operation_token = next_native_operation_token();
        ACTIVE_NATIVE_OPERATION_TOKEN.store(operation_token, Ordering::Release);
        let hide_result = match schedule_native_step(
            &webview,
            NativeStep::Hide {
                operation_token,
                topology_epoch: covered.topology,
            },
        ) {
            Ok(receiver) => await_native_step(receiver),
            Err(error) => Err(error),
        };
        if let Err(error) = hide_result {
            diagnostic("hide-step-warning", Some(generation), source, &error);
            // Invalidate a callback that timed out before it reached the main
            // thread. Its generation check guarantees it can never hide later.
            ACTIVE_NATIVE_OPERATION_TOKEN
                .compare_exchange(operation_token, 0, Ordering::AcqRel, Ordering::Acquire)
                .ok();
            let _ = restore_visibility(&webview, operation_token, generation, source);
            if error.contains("topology") {
                return RecomposeResult::RetryTopology;
            }
            return RecomposeResult::Failed;
        }

        // Hide was acknowledged on the AppKit thread, so this worker-only dwell
        // cannot leave an unexecuted stale Hide behind the coordinator.
        std::thread::sleep(HIDDEN_DWELL);
        let shown = restore_visibility(&webview, operation_token, generation, source);

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

        std::thread::sleep(FRONTEND_ACK_WAIT);
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
            "acknowledged hide/show recovery completed",
        );

        if !shown {
            RecomposeResult::Failed
        } else if TOPOLOGY_EPOCH.load(Ordering::Acquire) != covered.topology
            || SLEEP_EPOCH.load(Ordering::Acquire) != covered.sleep
            || !native_view_operations_allowed()
        {
            RecomposeResult::RetryTopology
        } else {
            RecomposeResult::Presented(covered)
        }
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

/// True only after the current display-topology notification burst has been
/// quiet long enough for AppKit child-view attachment to be trustworthy.
#[cfg(target_os = "macos")]
pub(crate) fn native_view_operations_allowed() -> bool {
    imp::native_view_operations_allowed()
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn native_view_operations_allowed() -> bool {
    true
}

/// Executes a macOS native-webview callback while balancing the three retained
/// platform objects leaked by the locked tauri-runtime-wry 2.11.4 callback
/// adapter. Callers must use the raw pointer only for the callback's duration.
#[cfg(target_os = "macos")]
pub(crate) fn with_webview_balanced(
    webview: &tauri::Webview,
    callback: impl FnOnce(*mut std::ffi::c_void) + Send + 'static,
) -> tauri::Result<()> {
    imp::with_webview_balanced(webview, callback)
}

/// Defers and rate-limits a reload of a terminated main WebContent process
/// until WindowServer has finished any concurrent display reconfiguration.
#[cfg(target_os = "macos")]
pub(crate) fn handle_main_web_content_terminated(webview: &tauri::Webview) {
    imp::handle_main_web_content_terminated(webview);
}

/// Marks the replacement main renderer usable only after its PTY listeners and
/// replay handshake are installed.
pub(crate) fn renderer_listener_ready() {
    #[cfg(target_os = "macos")]
    imp::renderer_listener_ready();
}

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

    fn covered(sleep: u64, topology: u64) -> Option<CoveredEpochs> {
        Some(CoveredEpochs { sleep, topology })
    }

    #[test]
    fn first_request_starts_and_completion_returns_idle() {
        let mut state = RecoveryCoordinator::default();
        let RequestDecision::Start(request) = state.request(100, "wake".into(), false, 1, 10)
        else {
            panic!("first request should start");
        };
        assert_eq!(request.generation, 1);
        assert_eq!(state.finish(1, covered(1, 10), 200), FinishDecision::Idle);
        assert_eq!(state.running_generation, None);
    }

    #[test]
    fn duplicate_wake_requests_join_the_active_cycle() {
        let mut state = RecoveryCoordinator::default();
        let RequestDecision::Start(first) = state.request(100, "first".into(), false, 1, 10) else {
            panic!("first request should start");
        };
        assert_eq!(
            state.request(110, "second".into(), false, 1, 10),
            RequestDecision::Coalesced(first.generation)
        );
        assert_eq!(
            state.request(120, "third".into(), false, 1, 10),
            RequestDecision::Coalesced(first.generation)
        );
        assert_eq!(
            state.finish(first.generation, covered(1, 10), 200),
            FinishDecision::Idle
        );
    }

    #[test]
    fn a_new_sleep_epoch_queues_behind_an_active_wake_cycle() {
        let mut state = RecoveryCoordinator::default();
        let RequestDecision::Start(first) = state.request(100, "wake-one".into(), false, 3, 10)
        else {
            panic!("first wake should start");
        };
        assert!(matches!(
            state.request(110, "wake-two".into(), false, 4, 11),
            RequestDecision::Queued(2)
        ));
        let FinishDecision::Start(second) = state.finish(first.generation, covered(3, 10), 200)
        else {
            panic!("new sleep epoch should remain queued");
        };
        assert_eq!(second.sleep_epoch, 4);
        assert_eq!(state.running_sleep_epoch, Some(4));
    }

    #[test]
    fn explicit_requests_retain_only_the_newest_follow_up() {
        let mut state = RecoveryCoordinator::default();
        let RequestDecision::Start(first) = state.request(100, "wake".into(), false, 1, 10) else {
            panic!("first request should start");
        };
        assert!(matches!(
            state.request(110, "manual-one".into(), true, 1, 10),
            RequestDecision::Queued(2)
        ));
        assert!(matches!(
            state.request(120, "manual-two".into(), true, 1, 10),
            RequestDecision::Queued(3)
        ));
        let FinishDecision::Start(next) = state.finish(first.generation, covered(1, 10), 200)
        else {
            panic!("one explicit follow-up should start");
        };
        assert_eq!(next.generation, 3);
        assert_eq!(next.source, "manual-two");
        assert_eq!(
            state.finish(next.generation, covered(1, 10), 300),
            FinishDecision::Idle
        );
    }

    #[test]
    fn automatic_edge_cannot_erase_an_explicit_follow_up() {
        let mut state = RecoveryCoordinator::default();
        let RequestDecision::Start(first) = state.request(100, "wake".into(), false, 1, 10) else {
            panic!("first request should start");
        };
        assert_eq!(
            state.request(110, "manual".into(), true, 1, 10),
            RequestDecision::Queued(2)
        );
        assert_eq!(
            state.request(120, "automatic-new-topology".into(), false, 1, 11),
            RequestDecision::Queued(2)
        );
        let FinishDecision::Start(next) = state.finish(first.generation, covered(1, 11), 200)
        else {
            panic!("manual follow-up must run even when the automatic edge was covered");
        };
        assert!(next.force);
        assert_eq!(next.source, "manual");
    }

    #[test]
    fn fallback_duplicate_is_quieted_but_explicit_request_is_not() {
        let mut state = RecoveryCoordinator::default();
        let RequestDecision::Start(first) = state.request(100, "wake".into(), false, 1, 10) else {
            panic!("first request should start");
        };
        assert_eq!(
            state.finish(first.generation, covered(1, 10), 200),
            FinishDecision::Idle
        );
        assert_eq!(
            state.request(500, "poll".into(), false, 1, 10),
            RequestDecision::Suppressed
        );
        assert!(matches!(
            state.request(500, "manual".into(), true, 1, 10),
            RequestDecision::Start(_)
        ));
    }

    #[test]
    fn stale_completion_does_not_change_the_running_generation() {
        let mut state = RecoveryCoordinator::default();
        let RequestDecision::Start(request) = state.request(100, "wake".into(), false, 1, 10)
        else {
            panic!("first request should start");
        };
        assert_eq!(
            state.finish(999, covered(1, 10), 200),
            FinishDecision::Stale
        );
        assert_eq!(state.running_generation, Some(request.generation));
    }

    #[test]
    fn a_new_sleep_epoch_is_never_suppressed_by_the_previous_wake() {
        let mut state = RecoveryCoordinator::default();
        let RequestDecision::Start(first) = state.request(100, "wake-one".into(), false, 7, 20)
        else {
            panic!("first wake should start");
        };
        assert_eq!(
            state.finish(first.generation, covered(7, 20), 200),
            FinishDecision::Idle
        );
        assert_eq!(
            state.request(500, "duplicate-wake-one".into(), false, 7, 20),
            RequestDecision::Suppressed
        );
        assert!(matches!(
            state.request(500, "wake-two".into(), false, 8, 21),
            RequestDecision::Start(_)
        ));
    }

    #[test]
    fn topology_signal_after_presented_but_before_finish_stays_queued() {
        let mut state = RecoveryCoordinator::default();
        let RequestDecision::Start(first) = state.request(100, "wake".into(), false, 1, 30) else {
            panic!("wake should start");
        };
        assert!(matches!(
            state.request(200, "late-topology".into(), false, 1, 31),
            RequestDecision::Queued(2)
        ));
        let FinishDecision::Start(next) = state.finish(first.generation, covered(1, 30), 210)
        else {
            panic!("topology newer than the presented epoch must run");
        };
        assert_eq!(next.topology_epoch, 31);
    }

    #[test]
    fn topology_already_included_in_presentation_drops_redundant_follow_up() {
        let mut state = RecoveryCoordinator::default();
        let RequestDecision::Start(first) = state.request(100, "wake".into(), false, 1, 30) else {
            panic!("wake should start");
        };
        assert!(matches!(
            state.request(150, "burst".into(), false, 1, 31),
            RequestDecision::Queued(2)
        ));
        assert_eq!(
            state.finish(first.generation, covered(1, 31), 200),
            FinishDecision::Idle
        );
    }

    #[test]
    fn newer_sleep_is_not_dropped_when_only_its_topology_was_covered() {
        let mut state = RecoveryCoordinator::default();
        let RequestDecision::Start(first) = state.request(100, "wake-one".into(), false, 7, 30)
        else {
            panic!("first wake should start");
        };
        assert!(matches!(
            state.request(150, "wake-two".into(), false, 8, 30),
            RequestDecision::Queued(2)
        ));
        let FinishDecision::Start(next) = state.finish(first.generation, covered(7, 30), 200)
        else {
            panic!("a newer sleep epoch was not covered");
        };
        assert_eq!(next.sleep_epoch, 8);
    }

    #[test]
    fn presentation_records_the_actual_newer_sleep_it_covered() {
        let mut state = RecoveryCoordinator::default();
        let RequestDecision::Start(first) = state.request(100, "wake-one".into(), false, 7, 30)
        else {
            panic!("first wake should start");
        };
        assert!(matches!(
            state.request(150, "wake-two".into(), false, 8, 31),
            RequestDecision::Queued(2)
        ));
        assert_eq!(
            state.finish(first.generation, covered(8, 31), 200),
            FinishDecision::Idle
        );
        assert_eq!(state.last_finished_sleep_epoch, Some(8));
        assert_eq!(state.last_finished_topology_epoch, Some(31));
        assert_eq!(
            state.request(250, "duplicate-wake-two".into(), false, 8, 31),
            RequestDecision::Suppressed
        );
    }

    #[test]
    fn new_topology_after_finish_bypasses_same_sleep_quiet_suppression() {
        let mut state = RecoveryCoordinator::default();
        let RequestDecision::Start(first) = state.request(100, "wake".into(), false, 1, 40) else {
            panic!("wake should start");
        };
        assert_eq!(
            state.finish(first.generation, covered(1, 40), 200),
            FinishDecision::Idle
        );
        assert!(matches!(
            state.request(250, "late-topology".into(), false, 1, 41),
            RequestDecision::Start(_)
        ));
    }

    #[test]
    fn failed_attempt_never_suppresses_same_topology_retry() {
        let mut state = RecoveryCoordinator::default();
        let RequestDecision::Start(first) = state.request(100, "wake".into(), false, 1, 50) else {
            panic!("wake should start");
        };
        assert_eq!(
            state.finish(first.generation, None, 200),
            FinishDecision::Idle
        );
        assert!(matches!(
            state.request(250, "retry".into(), false, 1, 50),
            RequestDecision::Start(_)
        ));
    }

    #[test]
    fn native_failure_backoff_remains_bounded_but_never_stops_retrying() {
        let backoff = [250, 500, 1_000, 2_000, 5_000, 10_000, 30_000];
        assert_eq!(native_failure_retry_delay_ms(1, &backoff), 250);
        assert_eq!(native_failure_retry_delay_ms(4, &backoff), 2_000);
        assert_eq!(native_failure_retry_delay_ms(10_000, &backoff), 30_000);
    }

    #[test]
    fn external_screen_parameter_change_arms_recovery_after_startup() {
        assert!(!should_request_screen_parameter_recovery(
            4_999, 5_000, false
        ));
        assert!(!should_request_screen_parameter_recovery(
            6_000, 5_000, true
        ));
        assert!(should_request_screen_parameter_recovery(
            5_000, 5_000, false
        ));
    }

    #[test]
    fn old_recovery_cannot_clear_a_newly_observed_sleep_epoch() {
        use std::sync::atomic::{AtomicU64, Ordering};

        let observed = AtomicU64::new(7);
        // Model the new sleep callback publishing its complete tagged state
        // before the old driver's clear attempt.
        observed.store(8, Ordering::Release);
        assert!(!clear_observed_sleep_epoch(&observed, 7));
        assert_eq!(observed.load(Ordering::Acquire), 8);

        // The opposite ordering is safe too: a later sleep publication cannot
        // be overwritten by an already-completed compare_exchange.
        let observed = AtomicU64::new(7);
        assert!(clear_observed_sleep_epoch(&observed, 7));
        observed.store(8, Ordering::Release);
        assert_eq!(observed.load(Ordering::Acquire), 8);
    }

    #[test]
    fn topology_gate_waits_for_the_trailing_quiet_edge() {
        assert!(topology_is_stable(10, 0, 0, false, 1_250));
        assert!(!topology_is_stable(10_000, 0, 0, true, 1_250));
        assert!(!topology_is_stable(2_249, 1_000, 7, false, 1_250));
        assert!(topology_is_stable(2_250, 1_000, 7, false, 1_250));
        // A clock anomaly must fail closed rather than underflowing to stable.
        assert!(!topology_is_stable(900, 1_000, 7, false, 1_250));
    }

    #[test]
    fn stale_or_reparented_hide_callback_can_never_run() {
        assert!(hide_callback_is_current(4, 4, 9, 9, true));
        assert!(!hide_callback_is_current(0, 4, 9, 9, true));
        assert!(!hide_callback_is_current(5, 4, 9, 9, true));
        assert!(!hide_callback_is_current(4, 4, 10, 9, true));
        assert!(!hide_callback_is_current(4, 4, 9, 9, false));
    }

    #[test]
    fn timed_out_hide_token_cannot_become_current_on_request_retry() {
        let timed_out_token = 41;
        let retry_token = 42;
        // The recovery generation and topology epoch may be identical across a
        // retry; the per-attempt token is what permanently invalidates the old
        // main-thread callback.
        assert!(!hide_callback_is_current(
            retry_token,
            timed_out_token,
            9,
            9,
            true,
        ));
    }

    #[test]
    fn renderer_reload_backoff_is_bounded_and_breaks_crash_loops() {
        let backoff = [100, 500, 2_000, 5_000];
        assert_eq!(content_reload_delay_ms(10_000, &[], 60_000, &backoff), 100);
        assert_eq!(
            content_reload_delay_ms(10_000, &[9_000], 60_000, &backoff),
            500
        );
        assert_eq!(
            content_reload_delay_ms(10_000, &[1_000, 2_000, 3_000, 4_000], 60_000, &backoff),
            51_000
        );
        assert_eq!(
            content_reload_delay_ms(70_001, &[1_000, 2_000, 3_000, 4_000], 60_000, &backoff),
            0
        );
    }
}
