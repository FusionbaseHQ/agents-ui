// Embedded browser tabs: each is a child WKWebView added to the main window and
// positioned as a pixel overlay over a DOM rect by the frontend. The webview
// gets no app capabilities (see capabilities/default.json `webviews:["main"]`),
// so pages it loads cannot call any Tauri command.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    fs,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    webview::{PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Rect, WebviewUrl,
};

// Keep browser webviews alive while their tabs are inactive, but hide them
// natively instead of parking them far outside the display. Off-screen native
// layers are prone to retaining stale display coordinates/backing scale across
// monitor sleep and hot-plug events.
static VISIBLE_BROWSERS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static BROWSER_OPERATIONS: OnceLock<Mutex<HashMap<String, Arc<Mutex<BrowserOperationState>>>>> =
    OnceLock::new();
static BROWSER_CREATION_RESERVATIONS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    OnceLock::new();
static MANAGED_BROWSERS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static ORPHANED_BROWSERS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static ORPHAN_CLEANUP_RUNNING: AtomicBool = AtomicBool::new(false);
static MAIN_RENDERER_UNAVAILABLE: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BrowserOperationKind {
    Open,
    Bounds,
    Hide,
    Closed,
}

#[derive(Default)]
struct BrowserOperationState {
    latest_id: Option<u64>,
    latest_kind: Option<BrowserOperationKind>,
}

fn browser_operation_state(label: &str) -> Arc<Mutex<BrowserOperationState>> {
    let states = BROWSER_OPERATIONS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut states = states
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    states
        .entry(label.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(BrowserOperationState::default())))
        .clone()
}

fn browser_operation_state_if_known(label: &str) -> Option<Arc<Mutex<BrowserOperationState>>> {
    let states = BROWSER_OPERATIONS.get()?;
    let states = states
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    states.get(label).cloned()
}

fn browser_creation_reservation(label: &str) -> Arc<Mutex<()>> {
    let reservations = BROWSER_CREATION_RESERVATIONS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut reservations = reservations
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    reservations
        .entry(label.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn register_managed_browser(label: &str) {
    MANAGED_BROWSERS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(label.to_string());
}

fn unregister_managed_browser(label: &str) {
    if let Some(labels) = MANAGED_BROWSERS.get() {
        labels
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(label);
    }
    if let Some(labels) = ORPHANED_BROWSERS.get() {
        labels
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(label);
    }
}

fn queue_orphaned_browser(app: &AppHandle, label: &str) {
    ORPHANED_BROWSERS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(label.to_string());
    ensure_orphan_cleanup_worker(app);
}

fn orphaned_browser_labels() -> Vec<String> {
    ORPHANED_BROWSERS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .cloned()
        .collect()
}

fn ensure_orphan_cleanup_worker(app: &AppHandle) {
    if ORPHAN_CLEANUP_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    let app = app.clone();
    if let Err(error) = std::thread::Builder::new()
        .name("browser-orphan-cleanup".into())
        .spawn(move || run_orphan_cleanup_worker(app))
    {
        ORPHAN_CLEANUP_RUNNING.store(false, Ordering::Release);
        eprintln!("[browser] failed to start orphan cleanup worker: {error}");
    }
}

struct OrphanCleanupRunningGuard(AppHandle);

impl Drop for OrphanCleanupRunningGuard {
    fn drop(&mut self) {
        ORPHAN_CLEANUP_RUNNING.store(false, Ordering::Release);
        // Close both the normal empty-queue publication race and an
        // unexpected worker unwind. A queue publisher after this check sees
        // the cleared flag and starts the replacement itself.
        if !orphaned_browser_labels().is_empty() {
            ensure_orphan_cleanup_worker(&self.0);
        }
    }
}

fn run_orphan_cleanup_worker(app: AppHandle) {
    let _running_guard = OrphanCleanupRunningGuard(app.clone());
    let mut failed_rounds = 0usize;
    loop {
        let labels = orphaned_browser_labels();
        if labels.is_empty() {
            return;
        }

        let mut failed = false;
        for label in labels {
            let close_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                browser_close(app.clone(), label.clone(), u64::MAX)
            }))
            .unwrap_or_else(|_| Err("orphan cleanup panicked; retrying".to_string()));
            if let Err(error) = close_result {
                failed = true;
                if failed_rounds < 3 || failed_rounds.is_multiple_of(12) {
                    eprintln!("[browser] orphan cleanup deferred for {label}: {error}");
                }
            }
        }

        failed_rounds = if failed {
            failed_rounds.saturating_add(1)
        } else {
            0
        };
        let delay_ms = match failed_rounds {
            0 | 1 => 100,
            2 => 250,
            3 => 500,
            4 => 1_000,
            _ => 2_000,
        };
        std::thread::sleep(Duration::from_millis(delay_ms));
    }
}

fn force_terminal_operation(state: &Arc<Mutex<BrowserOperationState>>) {
    let mut state = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.latest_id = Some(u64::MAX);
    state.latest_kind = Some(BrowserOperationKind::Closed);
}

fn claim_browser_operation(
    state: &mut BrowserOperationState,
    operation_id: u64,
    kind: BrowserOperationKind,
) -> Result<(), String> {
    if let Some(latest_id) = state.latest_id {
        if operation_id < latest_id
            || (operation_id == latest_id && state.latest_kind != Some(kind))
        {
            return Err("browser visibility operation was superseded".to_string());
        }
    }
    state.latest_id = Some(operation_id);
    state.latest_kind = Some(kind);
    Ok(())
}

fn browser_operation_is_current(
    state: &Arc<Mutex<BrowserOperationState>>,
    operation_id: u64,
    kind: BrowserOperationKind,
) -> bool {
    let state = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.latest_id == Some(operation_id) && state.latest_kind == Some(kind)
}

fn set_browser_visible_if_current(
    label: &str,
    state: &Arc<Mutex<BrowserOperationState>>,
    operation_id: u64,
    kind: BrowserOperationKind,
    visible: bool,
) -> bool {
    let state = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if state.latest_id != Some(operation_id) || state.latest_kind != Some(kind) {
        return false;
    }
    // Keep the logical visibility marker in the same operation-state critical
    // section as the final current-operation check. Otherwise a newer Hide can
    // finish between a successful native Show and this bookkeeping write, only
    // for the stale Open to mark the now-hidden child visible again.
    set_browser_visible(label, visible);
    true
}

fn browser_has_visible_intent(label: &str) -> bool {
    let Some(state) = browser_operation_state_if_known(label) else {
        return false;
    };
    let state = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    matches!(
        state.latest_kind,
        Some(BrowserOperationKind::Open | BrowserOperationKind::Bounds)
    )
}

fn set_browser_visible(label: &str, visible: bool) {
    let state = VISIBLE_BROWSERS.get_or_init(|| Mutex::new(HashSet::new()));
    let Ok(mut labels) = state.lock() else {
        return;
    };
    if visible {
        labels.insert(label.to_string());
    } else {
        labels.remove(label);
    }
}

fn browser_is_visible(label: &str) -> bool {
    VISIBLE_BROWSERS
        .get()
        .and_then(|state| state.lock().ok())
        .is_some_and(|labels| labels.contains(label))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BrowserNavEvent {
    label: String,
    url: String,
    loading: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScreenshot {
    mime_type: &'static str,
    data: String,
    width: u32,
    height: u32,
    source_width: u32,
    source_height: u32,
    target: &'static str,
    captured_element: &'static str,
    capture_method: &'static str,
}

#[allow(dead_code)]
const SCREEN_RECORDING_PERMISSION_REQUIRED: &str =
    "SCREEN_RECORDING_PERMISSION_REQUIRED: macOS Screen Recording permission is required to capture the embedded browser. Open System Settings > Privacy & Security > Screen Recording, enable Agents UI (or the terminal/editor that launched the app in dev mode), then restart the app.";

fn normalize_url(input: &str) -> Result<tauri::Url, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("empty url".to_string());
    }
    let candidate = if trimmed.contains("://") || trimmed.starts_with("about:") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    tauri::Url::parse(&candidate).map_err(|e| format!("invalid url: {e}"))
}

// Translate a DOM rect (getBoundingClientRect, origin = top-left of the main
// webview's CSS viewport) into the child webview's native bounds.
//
// The main app webview and browser child webviews are native siblings. The DOM
// rect is relative to the main webview, so anchor it to the main webview's real
// native origin instead of assuming the main webview starts at the window origin.
const BROWSER_NATIVE_RETRYABLE: &str = "BROWSER_NATIVE_RETRYABLE";

fn retryable_native_error(detail: impl std::fmt::Display) -> String {
    format!("{BROWSER_NATIVE_RETRYABLE}: {detail}")
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct BrowserLayoutBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    y_offset: f64,
}

impl BrowserLayoutBounds {
    fn validated(x: f64, y: f64, width: f64, height: f64, y_offset: f64) -> Result<Self, String> {
        if !x.is_finite() || !y.is_finite() || !y_offset.is_finite() {
            return Err("invalid browser bounds: position and offset must be finite".to_string());
        }
        if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
            return Err(
                "invalid browser bounds: width and height must be finite and positive".to_string(),
            );
        }
        Ok(Self {
            x,
            y,
            width,
            height,
            y_offset: y_offset.max(0.0),
        })
    }
}

fn ensure_native_view_operations_allowed() -> Result<(), String> {
    if crate::display_recovery::native_view_operations_allowed() {
        Ok(())
    } else {
        Err(retryable_native_error("display topology is still settling"))
    }
}

fn child_bounds(app: &AppHandle, input: BrowserLayoutBounds) -> Result<Rect, String> {
    ensure_native_view_operations_allowed()?;
    let (origin_x, origin_y, scale) = main_webview_geometry(app)?;

    let x = origin_x + input.x * scale;
    let y = origin_y + (input.y + input.y_offset) * scale;
    let within_position_range =
        |value: f64| value.is_finite() && value >= i32::MIN as f64 && value <= i32::MAX as f64;
    if !within_position_range(x) || !within_position_range(y) {
        return Err("invalid browser bounds: physical position is out of range".to_string());
    }

    Ok(Rect {
        position: PhysicalPosition::new(x.round() as i32, y.round() as i32).into(),
        size: LogicalSize::new(input.width, input.height).into(),
    })
}

const NATIVE_BOUNDS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

#[cfg(target_os = "macos")]
fn main_webview_geometry(app: &AppHandle) -> Result<(f64, f64, f64), String> {
    use objc2_web_kit::WKWebView;
    use std::{
        panic::AssertUnwindSafe,
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc,
        },
    };

    ensure_native_view_operations_allowed()?;
    let webview = app
        .get_webview("main")
        .ok_or_else(|| retryable_native_error("main webview is not registered"))?;
    let (sender, receiver) = mpsc::sync_channel(1);
    let callback_allowed = Arc::new(AtomicBool::new(true));
    let native_callback_allowed = callback_allowed.clone();
    crate::display_recovery::with_webview_balanced(&webview, move |inner| {
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            if !native_callback_allowed.load(Ordering::Acquire) {
                return Err("main webview geometry callback was cancelled".to_string());
            }
            ensure_native_view_operations_allowed()?;
            if inner.is_null() {
                return Err(retryable_native_error("main WKWebView handle is null"));
            }

            objc2::exception::catch(AssertUnwindSafe(|| {
                let view = unsafe { &*(inner as *mut WKWebView) };
                let window = view.window().ok_or_else(|| {
                    retryable_native_error("main WKWebView is detached from its window")
                })?;
                let parent = unsafe { view.superview() }.ok_or_else(|| {
                    retryable_native_error("main WKWebView is detached from its superview")
                })?;
                let scale = window.backingScaleFactor();
                let frame = view.frame();
                let parent_frame = parent.frame();
                if !scale.is_normal()
                    || !frame.origin.x.is_finite()
                    || !frame.origin.y.is_finite()
                    || !frame.size.width.is_finite()
                    || !frame.size.height.is_finite()
                    || !parent_frame.size.width.is_finite()
                    || !parent_frame.size.height.is_finite()
                    || frame.size.width <= 0.0
                    || frame.size.height <= 0.0
                    || parent_frame.size.width <= 0.0
                    || parent_frame.size.height <= 0.0
                {
                    return Err(retryable_native_error(
                        "main WKWebView reported invalid native geometry",
                    ));
                }
                let logical_y = if parent.isFlipped() {
                    frame.origin.y
                } else {
                    parent_frame.size.height - frame.origin.y - frame.size.height
                };
                let x = frame.origin.x * scale;
                let y = logical_y * scale;
                if !x.is_finite()
                    || !y.is_finite()
                    || x < i32::MIN as f64
                    || x > i32::MAX as f64
                    || y < i32::MIN as f64
                    || y > i32::MAX as f64
                {
                    return Err(retryable_native_error(
                        "main WKWebView origin is out of physical coordinate range",
                    ));
                }
                if !native_callback_allowed.load(Ordering::Acquire) {
                    return Err("main webview geometry callback was cancelled".to_string());
                }
                Ok((x.round(), y.round(), scale))
            }))
            .map_err(|_| {
                retryable_native_error("Objective-C exception while reading main WKWebView frame")
            })?
        }))
        .unwrap_or_else(|_| {
            Err(retryable_native_error(
                "Rust panic while reading main WKWebView frame",
            ))
        });
        let _ = sender.send(result);
    })
    .map_err(|error| {
        retryable_native_error(format!("failed to queue main geometry callback: {error}"))
    })?;

    match receiver.recv_timeout(NATIVE_BOUNDS_TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            callback_allowed.store(false, Ordering::Release);
            Err(retryable_native_error(
                "main-thread main geometry callback timed out",
            ))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            callback_allowed.store(false, Ordering::Release);
            Err(retryable_native_error(
                "main-thread main geometry callback was dropped",
            ))
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn main_webview_geometry(app: &AppHandle) -> Result<(f64, f64, f64), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| retryable_native_error("main window is not registered"))?;
    let scale = window.scale_factor().map_err(|error| {
        retryable_native_error(format!("main window scale is unavailable: {error}"))
    })?;
    if !scale.is_normal() {
        return Err(retryable_native_error(format!(
            "main window reported invalid scale factor {scale}"
        )));
    }
    let origin = app
        .get_webview("main")
        .ok_or_else(|| retryable_native_error("main webview is not registered"))?
        .position()
        .map_err(|error| {
            retryable_native_error(format!("main webview position is unavailable: {error}"))
        })?;
    Ok((origin.x as f64, origin.y as f64, scale))
}

fn set_child_bounds_acknowledged(
    webview: &tauri::Webview,
    bounds: Rect,
    operation_state: Arc<Mutex<BrowserOperationState>>,
    operation_id: u64,
    kind: BrowserOperationKind,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{NSPoint, NSRect, NSSize};
        use objc2_web_kit::WKWebView;
        use std::panic::AssertUnwindSafe;
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            mpsc,
        };

        let (sender, receiver) = mpsc::sync_channel(1);
        let callback_allowed = Arc::new(AtomicBool::new(true));
        let native_callback_allowed = callback_allowed.clone();
        crate::display_recovery::with_webview_balanced(webview, move |inner| {
            let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                if !browser_operation_is_current(&operation_state, operation_id, kind) {
                    return Err("browser bounds operation was superseded".to_string());
                }
                if !native_callback_allowed.load(Ordering::Acquire) {
                    return Err("browser bounds callback was cancelled".to_string());
                }
                ensure_native_view_operations_allowed()?;
                if inner.is_null() {
                    return Err(retryable_native_error("native WKWebView handle is null"));
                }

                // SAFETY: Tauri documents `inner` as a WKWebView and invokes
                // this callback on AppKit's main thread. The attachment checks
                // and frame mutation are both inside an Objective-C exception
                // boundary, so a transient WindowServer detach becomes a
                // retryable command failure instead of an abort in Wry's
                // `window().unwrap()` / `superview().unwrap()` path.
                let native_result = objc2::exception::catch(AssertUnwindSafe(|| {
                    let view = unsafe { &*(inner as *mut WKWebView) };
                    let window = view.window().ok_or_else(|| {
                        retryable_native_error("child WKWebView is detached from its window")
                    })?;
                    let parent = unsafe { view.superview() }.ok_or_else(|| {
                        retryable_native_error("child WKWebView is detached from its superview")
                    })?;
                    let scale = window.backingScaleFactor();
                    if !scale.is_normal() {
                        return Err(retryable_native_error(format!(
                            "child WKWebView reported invalid backing scale {scale}"
                        )));
                    }

                    let position = bounds.position.to_logical::<f64>(scale);
                    let size = bounds.size.to_logical::<f64>(scale);
                    if !position.x.is_finite()
                        || !position.y.is_finite()
                        || !size.width.is_finite()
                        || !size.height.is_finite()
                        || size.width <= 0.0
                        || size.height <= 0.0
                    {
                        return Err(
                            "invalid browser bounds after native scale conversion".to_string()
                        );
                    }
                    let parent_frame = parent.frame();
                    if !parent_frame.size.width.is_finite()
                        || !parent_frame.size.height.is_finite()
                        || parent_frame.size.width <= 0.0
                        || parent_frame.size.height <= 0.0
                    {
                        return Err(retryable_native_error(
                            "child WKWebView parent reported invalid geometry",
                        ));
                    }
                    let native_y = if parent.isFlipped() {
                        position.y
                    } else {
                        parent_frame.size.height - position.y - size.height
                    };
                    if !native_y.is_finite() {
                        return Err(retryable_native_error(
                            "child WKWebView parent reported invalid geometry",
                        ));
                    }
                    if !native_callback_allowed.load(Ordering::Acquire) {
                        return Err("browser bounds callback was cancelled".to_string());
                    }
                    view.setFrame(NSRect::new(
                        NSPoint::new(position.x, native_y),
                        NSSize::new(size.width, size.height),
                    ));
                    Ok(())
                }))
                .map_err(|_| {
                    retryable_native_error("Objective-C exception while setting WKWebView bounds")
                })?;
                native_result?;
                if !browser_operation_is_current(&operation_state, operation_id, kind) {
                    return Err("browser bounds operation was superseded".to_string());
                }
                Ok(())
            }));
            let result = result.unwrap_or_else(|_| {
                Err(retryable_native_error(
                    "Rust panic while setting WKWebView bounds",
                ))
            });
            let _ = sender.send(result);
        })
        .map_err(|error| {
            retryable_native_error(format!("failed to queue native bounds callback: {error}"))
        })?;

        match receiver.recv_timeout(NATIVE_BOUNDS_TIMEOUT) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                callback_allowed.store(false, Ordering::Release);
                Err(retryable_native_error(
                    "main-thread native bounds callback timed out",
                ))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                callback_allowed.store(false, Ordering::Release);
                Err(retryable_native_error(
                    "main-thread native bounds callback was dropped",
                ))
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        if !browser_operation_is_current(&operation_state, operation_id, kind) {
            return Err("browser bounds operation was superseded".to_string());
        }
        webview
            .set_bounds(bounds)
            .map_err(|error| format!("failed to set browser webview bounds: {error}"))
    }
}

fn set_child_visibility_acknowledged(
    webview: &tauri::Webview,
    visible: bool,
    operation_state: Arc<Mutex<BrowserOperationState>>,
    operation_id: u64,
    kind: BrowserOperationKind,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_web_kit::WKWebView;
        use std::panic::AssertUnwindSafe;
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            mpsc,
        };

        let (sender, receiver) = mpsc::sync_channel(1);
        let callback_allowed = Arc::new(AtomicBool::new(true));
        let native_callback_allowed = callback_allowed.clone();
        crate::display_recovery::with_webview_balanced(webview, move |inner| {
            let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                if !browser_operation_is_current(&operation_state, operation_id, kind) {
                    return Err("browser visibility operation was superseded".to_string());
                }
                if !native_callback_allowed.load(Ordering::Acquire) {
                    return Err("browser visibility callback was cancelled".to_string());
                }
                // Hiding is always allowed: when topology is unstable, making
                // a stale overlay non-interactive is the safest possible state.
                // Showing must wait until attachment is trustworthy.
                if visible {
                    ensure_native_view_operations_allowed()?;
                }
                if inner.is_null() {
                    return Err(retryable_native_error("native WKWebView handle is null"));
                }

                let native_result = objc2::exception::catch(AssertUnwindSafe(|| {
                    let view = unsafe { &*(inner as *mut WKWebView) };
                    if visible && (view.window().is_none() || unsafe { view.superview() }.is_none())
                    {
                        return Err(retryable_native_error(
                            "child WKWebView is detached before show",
                        ));
                    }
                    if !native_callback_allowed.load(Ordering::Acquire) {
                        return Err("browser visibility callback was cancelled".to_string());
                    }
                    view.setHidden(!visible);
                    view.setNeedsDisplay(true);
                    Ok(())
                }))
                .map_err(|_| {
                    retryable_native_error(
                        "Objective-C exception while changing WKWebView visibility",
                    )
                })?;
                native_result?;
                if !browser_operation_is_current(&operation_state, operation_id, kind) {
                    return Err("browser visibility operation was superseded".to_string());
                }
                Ok(())
            }));
            let result = result.unwrap_or_else(|_| {
                Err(retryable_native_error(
                    "Rust panic while changing WKWebView visibility",
                ))
            });
            let _ = sender.send(result);
        })
        .map_err(|error| {
            retryable_native_error(format!(
                "failed to queue native visibility callback: {error}"
            ))
        })?;

        match receiver.recv_timeout(NATIVE_BOUNDS_TIMEOUT) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                callback_allowed.store(false, Ordering::Release);
                Err(retryable_native_error(
                    "main-thread native visibility callback timed out",
                ))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                callback_allowed.store(false, Ordering::Release);
                Err(retryable_native_error(
                    "main-thread native visibility callback was dropped",
                ))
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        if !browser_operation_is_current(&operation_state, operation_id, kind) {
            return Err("browser visibility operation was superseded".to_string());
        }
        if visible {
            webview
                .show()
                .map_err(|error| format!("failed to show browser webview: {error}"))
        } else {
            webview
                .hide()
                .map_err(|error| format!("failed to hide browser webview: {error}"))
        }
    }
}

fn emit_nav(app: &AppHandle, label: &str, url: &str, loading: bool) {
    let _ = app.emit_to(
        "main",
        "browser://event",
        BrowserNavEvent {
            label: label.to_string(),
            url: url.to_string(),
            loading,
        },
    );
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn browser_open(
    app: AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    y_offset: Option<f64>,
    operation_id: u64,
) -> Result<(), String> {
    let operation_state = browser_operation_state(&label);
    let creation_reservation = browser_creation_reservation(&label);
    {
        let _creation_guard = creation_reservation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut operation_guard = operation_state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        claim_browser_operation(
            &mut operation_guard,
            operation_id,
            BrowserOperationKind::Open,
        )?;
    }
    register_managed_browser(&label);
    if MAIN_RENDERER_UNAVAILABLE.load(Ordering::Acquire) {
        force_terminal_operation(&operation_state);
        set_browser_visible(&label, false);
        queue_orphaned_browser(&app, &label);
        return Err("main renderer is restarting; browser creation was cancelled".to_string());
    }
    let layout = BrowserLayoutBounds::validated(x, y, width, height, y_offset.unwrap_or(0.0))?;
    let bounds = child_bounds(&app, layout)?;
    // Serialize the final registry check and child insertion with hide/close and
    // bounds operations. A newer intent can supersede this Open while geometry
    // is being calculated, so revalidate only after owning the creation gate.
    let creation_guard = creation_reservation
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !browser_operation_is_current(&operation_state, operation_id, BrowserOperationKind::Open) {
        return Err("browser visibility operation was superseded".to_string());
    }
    // Already created: just reveal + reposition (keeps the current page).
    if let Some(webview) = app.get_webview(&label) {
        drop(creation_guard);
        set_child_bounds_acknowledged(
            &webview,
            bounds,
            operation_state.clone(),
            operation_id,
            BrowserOperationKind::Open,
        )?;
        set_child_visibility_acknowledged(
            &webview,
            true,
            operation_state.clone(),
            operation_id,
            BrowserOperationKind::Open,
        )?;
        if !set_browser_visible_if_current(
            &label,
            &operation_state,
            operation_id,
            BrowserOperationKind::Open,
            true,
        ) {
            return Err("browser visibility operation was superseded".to_string());
        }
        schedule_pending_content_recovery(&app, &label);
        return Ok(());
    }
    ensure_native_view_operations_allowed()?;
    let window = app
        .get_window("main")
        .ok_or_else(|| retryable_native_error("main window is not registered"))?;
    let target = normalize_url(&url)?;

    let load_app = app.clone();
    let load_label = label.clone();

    let builder = WebviewBuilder::new(&label, WebviewUrl::External(target))
        .visible(false)
        .on_page_load(move |_webview, payload| {
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            emit_nav(&load_app, &load_label, payload.url().as_str(), loading);
        });

    // This label has no registered child, so any retained termination belongs
    // to an older incarnation. Clear it before creation; a termination raised
    // by the new WKWebView during add/load must remain pending.
    clear_content_recovery(&label);
    let webview = window
        .add_child(
            builder,
            bounds.position,
            LogicalSize::new(layout.width, layout.height),
        )
        .map_err(|e| format!("failed to create browser webview: {e}"))?;
    #[cfg(target_os = "macos")]
    if let Err(hide_error) = set_child_visibility_acknowledged(
        &webview,
        false,
        operation_state.clone(),
        operation_id,
        BrowserOperationKind::Open,
    ) {
        // Do not leave a just-created, unverified native overlay registered.
        // Acknowledged close either tears it down before retry or preserves the
        // label so the next Open can safely reuse it.
        return match webview.close() {
            Ok(()) => Err(format!(
                "failed to verify newly created browser was hidden; creation rolled back: {hide_error}"
            )),
            Err(close_error) => Err(format!(
                "failed to verify newly created browser was hidden: {hide_error}; rollback close failed: {close_error}"
            )),
        };
    }
    // The child is now registered and initially hidden. Waiting hide/close or
    // bounds commands can safely claim their newer operation and find it.
    drop(creation_guard);
    // The main webview may not be positioned yet at first paint; reposition once
    // more now that the child exists.
    set_child_bounds_acknowledged(
        &webview,
        bounds,
        operation_state.clone(),
        operation_id,
        BrowserOperationKind::Open,
    )?;
    set_child_visibility_acknowledged(
        &webview,
        true,
        operation_state.clone(),
        operation_id,
        BrowserOperationKind::Open,
    )?;
    if !set_browser_visible_if_current(
        &label,
        &operation_state,
        operation_id,
        BrowserOperationKind::Open,
        true,
    ) {
        return Err("browser visibility operation was superseded".to_string());
    }
    schedule_pending_content_recovery(&app, &label);
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn browser_set_bounds(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    y_offset: Option<f64>,
    operation_id: u64,
) -> Result<(), String> {
    let operation_state = browser_operation_state(&label);
    let creation_reservation = browser_creation_reservation(&label);
    {
        let _creation_guard = creation_reservation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut operation_guard = operation_state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        claim_browser_operation(
            &mut operation_guard,
            operation_id,
            BrowserOperationKind::Bounds,
        )?;
    }
    let layout = BrowserLayoutBounds::validated(x, y, width, height, y_offset.unwrap_or(0.0))?;
    let bounds = child_bounds(&app, layout)?;
    let creation_guard = creation_reservation
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !browser_operation_is_current(&operation_state, operation_id, BrowserOperationKind::Bounds) {
        return Err("browser visibility operation was superseded".to_string());
    }
    let Some(webview) = app.get_webview(&label) else {
        return Ok(());
    };
    drop(creation_guard);
    set_child_bounds_acknowledged(
        &webview,
        bounds,
        operation_state,
        operation_id,
        BrowserOperationKind::Bounds,
    )
}

#[tauri::command]
pub fn browser_hide(app: AppHandle, label: String, operation_id: u64) -> Result<(), String> {
    let operation_state = browser_operation_state(&label);
    let creation_reservation = browser_creation_reservation(&label);
    let creation_guard = creation_reservation
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    {
        let mut operation_guard = operation_state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        claim_browser_operation(
            &mut operation_guard,
            operation_id,
            BrowserOperationKind::Hide,
        )?;
    }
    let webview = app.get_webview(&label);
    // Once the registry lookup has observed the child created by any older
    // Open, release the creation gate before waiting on AppKit. A later Open
    // can claim its newer intent, and the native callback's operation check
    // will then reject this stale hide.
    drop(creation_guard);
    if let Some(webview) = webview {
        set_child_visibility_acknowledged(
            &webview,
            false,
            operation_state.clone(),
            operation_id,
            BrowserOperationKind::Hide,
        )?;
    }
    if !set_browser_visible_if_current(
        &label,
        &operation_state,
        operation_id,
        BrowserOperationKind::Hide,
        false,
    ) {
        return Err("browser visibility operation was superseded".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, label: String, url: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser not found".to_string())?;
    webview
        .navigate(normalize_url(&url)?)
        .map_err(|e| format!("navigate failed: {e}"))
}

#[tauri::command]
pub fn browser_action(app: AppHandle, label: String, action: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser not found".to_string())?;
    let script = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        _ => return Err(format!("unknown browser action: {action}")),
    };
    webview
        .eval(script)
        .map_err(|e| format!("action failed: {e}"))
}

/// WebKit invokes this from its process-termination delegate. Do not reload in
/// that callback: during display wake the child may be temporarily detached,
/// and an immediate reload can race the same AppKit topology transition that
/// killed the content process. The macOS implementation coalesces notifications
/// and performs a rate-limited reload only while this label is still the current
/// visible browser child.
pub fn handle_main_web_content_terminated(webview: &tauri::Webview) {
    MAIN_RENDERER_UNAVAILABLE.store(true, Ordering::Release);
    let labels = MANAGED_BROWSERS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .cloned()
        .collect::<Vec<_>>();

    if labels.is_empty() {
        return;
    }

    // This callback performs bookkeeping only. Any AppKit hide/close work is
    // deferred to the worker so no native view mutation or blocking dispatch
    // can re-enter WebKit's process-termination delegate.
    let mut orphaned = ORPHANED_BROWSERS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for label in labels {
        force_terminal_operation(&browser_operation_state(&label));
        set_browser_visible(&label, false);
        orphaned.insert(label);
    }
    drop(orphaned);
    ensure_orphan_cleanup_worker(webview.app_handle());
}

pub(crate) fn mark_main_renderer_ready(app: &AppHandle) {
    MAIN_RENDERER_UNAVAILABLE.store(false, Ordering::Release);
    if !orphaned_browser_labels().is_empty() {
        ensure_orphan_cleanup_worker(app);
    }
}

pub fn handle_web_content_terminated(webview: &tauri::Webview) {
    #[cfg(target_os = "macos")]
    browser_content_recovery::handle(webview);

    #[cfg(not(target_os = "macos"))]
    let _ = webview;
}

fn schedule_pending_content_recovery(app: &AppHandle, label: &str) {
    #[cfg(target_os = "macos")]
    browser_content_recovery::schedule(app, label);

    #[cfg(not(target_os = "macos"))]
    let _ = (app, label);
}

fn clear_content_recovery(label: &str) {
    #[cfg(target_os = "macos")]
    browser_content_recovery::clear(label);

    #[cfg(not(target_os = "macos"))]
    let _ = label;
}

#[cfg(target_os = "macos")]
mod browser_content_recovery {
    use super::{
        browser_has_visible_intent, browser_is_visible, browser_operation_state_if_known,
        retryable_native_error, BrowserOperationKind, NATIVE_BOUNDS_TIMEOUT,
    };
    use objc2_web_kit::WKWebView;
    use std::{
        collections::HashMap,
        panic::AssertUnwindSafe,
        sync::{
            atomic::{AtomicBool, AtomicU64, Ordering},
            mpsc, Arc, Mutex, OnceLock,
        },
        time::{Duration, Instant},
    };
    use tauri::{AppHandle, Manager, Webview};

    const TOPOLOGY_POLL_INTERVAL: Duration = Duration::from_millis(500);
    const MIN_RELOAD_INTERVAL: Duration = Duration::from_secs(5);

    static STATES: OnceLock<Mutex<HashMap<String, ContentRecoveryState>>> = OnceLock::new();
    static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

    #[derive(Debug, Default)]
    struct ContentRecoveryState {
        generation: u64,
        pending: bool,
        worker_running: bool,
        last_attempt: Option<Instant>,
    }

    impl ContentRecoveryState {
        fn mark_pending(&mut self, generation: u64) {
            self.generation = generation;
            self.pending = true;
        }

        fn reserve_worker_if_relevant(&mut self, relevant: bool) -> bool {
            if !relevant || !self.pending || self.worker_running {
                return false;
            }
            self.worker_running = true;
            true
        }

        fn next_attempt_delay(&self, now: Instant) -> Duration {
            self.last_attempt
                .map(|last| MIN_RELOAD_INTERVAL.saturating_sub(now.saturating_duration_since(last)))
                .unwrap_or(Duration::ZERO)
        }

        fn finish_attempt(&mut self, generation: u64, succeeded: bool, now: Instant) {
            self.last_attempt = Some(now);
            if succeeded && self.generation == generation {
                self.pending = false;
            }
        }
    }

    fn states() -> &'static Mutex<HashMap<String, ContentRecoveryState>> {
        STATES.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn next_generation() -> u64 {
        NEXT_GENERATION.fetch_add(1, Ordering::Relaxed).max(1)
    }

    pub(super) fn handle(webview: &Webview) {
        let label = webview.label().to_string();
        if label == "main" {
            return;
        }
        let app = webview.app_handle().clone();
        {
            let mut states = states()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            states
                .entry(label.clone())
                .or_default()
                .mark_pending(next_generation());
        }
        schedule(&app, &label);
    }

    pub(super) fn schedule(app: &AppHandle, label: &str) {
        // Hidden children retain the pending marker but do no background work.
        // browser_open calls this again after the child becomes relevant.
        let relevant = is_relevant(app, label);
        let reserved = {
            let mut states = states()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            states
                .get_mut(label)
                .is_some_and(|state| state.reserve_worker_if_relevant(relevant))
        };
        if !reserved {
            return;
        }

        let app = app.clone();
        let label = label.to_string();
        let worker_label = label.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("browser-content-reloader".into())
            .spawn(move || run_worker(app, worker_label))
        {
            release_worker(&label);
            eprintln!("[browser] failed to start content recovery worker for {label}: {error}");
        }
    }

    pub(super) fn clear(label: &str) {
        let mut states = states()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        states.remove(label);
    }

    fn is_relevant(app: &AppHandle, label: &str) -> bool {
        browser_is_visible(label)
            && browser_has_visible_intent(label)
            && app.get_webview(label).is_some()
    }

    fn pending_work(label: &str) -> Option<(u64, Duration)> {
        let mut states = states()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let state = states.get_mut(label)?;
        if !state.pending || !state.worker_running {
            state.worker_running = false;
            return None;
        }
        Some((state.generation, state.next_attempt_delay(Instant::now())))
    }

    fn generation_is_current(label: &str, generation: u64) -> bool {
        let states = states()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        states.get(label).is_some_and(|state| {
            state.pending && state.worker_running && state.generation == generation
        })
    }

    fn release_worker(label: &str) {
        let mut states = states()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(state) = states.get_mut(label) {
            state.worker_running = false;
        }
    }

    fn should_log_dispatch_failure(attempt: usize) -> bool {
        attempt <= 3 || attempt.is_multiple_of(12)
    }

    fn reload_acknowledged(webview: &Webview, label: &str, generation: u64) -> Result<(), String> {
        let operation_state = browser_operation_state_if_known(label)
            .ok_or_else(|| "browser content reload is no longer current".to_string())?;
        let label = label.to_string();
        let (sender, receiver) = mpsc::sync_channel(1);
        let callback_allowed = Arc::new(AtomicBool::new(true));
        let native_callback_allowed = callback_allowed.clone();
        crate::display_recovery::with_webview_balanced(webview, move |inner| {
            let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                let operation_is_current = || {
                    let operation_guard = operation_state
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    matches!(
                        operation_guard.latest_kind,
                        Some(BrowserOperationKind::Open | BrowserOperationKind::Bounds)
                    )
                };
                if !operation_is_current()
                    || !browser_is_visible(&label)
                    || !generation_is_current(&label, generation)
                {
                    return Err("browser content reload was superseded".to_string());
                }
                if !native_callback_allowed.load(Ordering::Acquire) {
                    return Err("browser content reload callback was cancelled".to_string());
                }
                if !crate::display_recovery::native_view_operations_allowed() {
                    return Err(retryable_native_error(
                        "display topology changed before browser content reload",
                    ));
                }
                if inner.is_null() {
                    return Err(retryable_native_error(
                        "browser content reload WKWebView handle is null",
                    ));
                }

                let native_result = objc2::exception::catch(AssertUnwindSafe(|| {
                    let view = unsafe { &*(inner as *mut WKWebView) };
                    if view.window().is_none() || unsafe { view.superview() }.is_none() {
                        return Err(retryable_native_error(
                            "browser content reload WKWebView is temporarily detached",
                        ));
                    }
                    if !native_callback_allowed.load(Ordering::Acquire) {
                        return Err("browser content reload callback was cancelled".to_string());
                    }
                    unsafe { view.reload() }.ok_or_else(|| {
                        retryable_native_error(
                            "WKWebView did not create a browser reload navigation",
                        )
                    })?;
                    Ok(())
                }))
                .map_err(|_| {
                    retryable_native_error(
                        "Objective-C exception while reloading browser content process",
                    )
                })?;
                native_result?;
                if !operation_is_current()
                    || !browser_is_visible(&label)
                    || !generation_is_current(&label, generation)
                {
                    return Err("browser content reload was superseded".to_string());
                }
                Ok(())
            }))
            .unwrap_or_else(|_| {
                Err(retryable_native_error(
                    "Rust panic while reloading browser content process",
                ))
            });
            let _ = sender.send(result);
        })
        .map_err(|error| {
            retryable_native_error(format!("failed to queue browser content reload: {error}"))
        })?;

        match receiver.recv_timeout(NATIVE_BOUNDS_TIMEOUT) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                callback_allowed.store(false, Ordering::Release);
                Err(retryable_native_error(
                    "main-thread browser content reload timed out",
                ))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                callback_allowed.store(false, Ordering::Release);
                Err(retryable_native_error(
                    "main-thread browser content reload callback was dropped",
                ))
            }
        }
    }

    fn run_worker(app: AppHandle, label: String) {
        let mut dispatch_failures: usize = 0;
        loop {
            let Some((generation, delay)) = pending_work(&label) else {
                return;
            };

            let deadline = Instant::now() + delay;
            loop {
                if !is_relevant(&app, &label) {
                    release_worker(&label);
                    schedule(&app, &label);
                    return;
                }
                if !generation_is_current(&label, generation) {
                    break;
                }
                if Instant::now() >= deadline
                    && crate::display_recovery::native_view_operations_allowed()
                {
                    break;
                }
                std::thread::sleep(TOPOLOGY_POLL_INTERVAL);
            }

            if !generation_is_current(&label, generation) {
                continue;
            }
            if !is_relevant(&app, &label)
                || !crate::display_recovery::native_view_operations_allowed()
            {
                continue;
            }
            let Some(current) = app.get_webview(&label) else {
                clear(&label);
                return;
            };
            let result = reload_acknowledged(&current, &label, generation);
            let succeeded = result.is_ok();
            {
                let mut states = states()
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if let Some(state) = states.get_mut(&label) {
                    state.finish_attempt(generation, succeeded, Instant::now());
                } else {
                    return;
                }
            }

            match result {
                Ok(()) => dispatch_failures = 0,
                Err(error) => {
                    dispatch_failures = dispatch_failures.saturating_add(1);
                    if should_log_dispatch_failure(dispatch_failures) {
                        eprintln!(
                            "[browser] failed to queue content reload for {label} (attempt {dispatch_failures}): {error}"
                        );
                    }
                }
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{should_log_dispatch_failure, ContentRecoveryState, MIN_RELOAD_INTERVAL};
        use std::time::{Duration, Instant};

        #[test]
        fn termination_notifications_coalesce_into_one_worker() {
            let mut state = ContentRecoveryState::default();
            state.mark_pending(1);
            assert!(state.reserve_worker_if_relevant(true));
            state.mark_pending(2);
            assert!(!state.reserve_worker_if_relevant(true));
            assert_eq!(state.generation, 2);
            assert!(state.pending);
        }

        #[test]
        fn stale_reload_completion_does_not_clear_a_newer_termination() {
            let now = Instant::now();
            let mut state = ContentRecoveryState::default();
            state.mark_pending(10);
            state.reserve_worker_if_relevant(true);
            state.mark_pending(11);
            state.finish_attempt(10, true, now);
            assert!(state.pending);
            state.finish_attempt(11, true, now);
            assert!(!state.pending);
        }

        #[test]
        fn reload_attempts_are_rate_limited() {
            let now = Instant::now();
            let mut state = ContentRecoveryState::default();
            state.mark_pending(1);
            assert!(state.reserve_worker_if_relevant(true));
            state.finish_attempt(1, false, now);
            assert!(state.pending);
            assert!(state.worker_running);
            assert_eq!(state.next_attempt_delay(now), MIN_RELOAD_INTERVAL);
            assert_eq!(
                state.next_attempt_delay(now + MIN_RELOAD_INTERVAL + Duration::from_millis(1)),
                Duration::ZERO
            );
        }

        #[test]
        fn persistent_reload_failures_use_bounded_diagnostics() {
            assert!((1..=3).all(should_log_dispatch_failure));
            assert!((4..12).all(|attempt| !should_log_dispatch_failure(attempt)));
            assert!(should_log_dispatch_failure(12));
            assert!(!should_log_dispatch_failure(13));
            assert!(should_log_dispatch_failure(24));
        }

        #[test]
        fn termination_before_first_show_stays_pending_until_child_is_relevant() {
            let mut state = ContentRecoveryState::default();
            state.mark_pending(42);

            assert!(!state.reserve_worker_if_relevant(false));
            assert!(state.pending);
            assert!(!state.worker_running);

            assert!(state.reserve_worker_if_relevant(true));
            assert!(state.pending);
            assert!(state.worker_running);
        }
    }
}

#[tauri::command]
pub async fn browser_capture_screenshot(
    app: AppHandle,
    label: String,
) -> Result<BrowserScreenshot, String> {
    if !browser_is_visible(&label) {
        return Err("browser tab is not visible yet; focus it and retry".to_string());
    }
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser not found".to_string())?;

    #[cfg(target_os = "macos")]
    {
        macos_browser_capture::capture(webview).await
    }

    #[cfg(not(target_os = "macos"))]
    {
        let child_size = webview
            .size()
            .map_err(|e| format!("browser size unavailable: {e}"))?;
        if child_size.width < 2 || child_size.height < 2 {
            return Err("browser tab has no visible capture area".to_string());
        }
        let _ = webview;
        Err(
            "embedded browser screenshot capture is currently implemented for macOS only"
                .to_string(),
        )
    }
}

#[tauri::command]
pub fn open_screen_recording_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .status()
            .map_err(|e| format!("failed to open System Settings: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!(
                "failed to open System Settings: exit status {status}"
            ))
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("Screen Recording permission settings are only available on macOS".to_string())
    }
}

#[tauri::command]
pub fn browser_close(app: AppHandle, label: String, operation_id: u64) -> Result<(), String> {
    let operation_state = browser_operation_state(&label);
    let creation_reservation = browser_creation_reservation(&label);
    let _creation_guard = creation_reservation
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    {
        let mut operation_guard = operation_state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        claim_browser_operation(
            &mut operation_guard,
            operation_id,
            BrowserOperationKind::Closed,
        )?;
    }
    clear_content_recovery(&label);
    let webview = app.get_webview(&label);
    // Keep the lifecycle reservation until native teardown is acknowledged
    // and Tauri has removed the manager label. Otherwise a newer Open can
    // publish the same label while the old Wry wrapper is still pending Drop.
    if let Some(webview) = webview {
        #[cfg(target_os = "macos")]
        {
            // Hiding does not require a stable attachment and is acknowledged
            // first. Even when topology is still settling, an unmounted child
            // cannot remain visible or intercept input while Close retries.
            set_child_visibility_acknowledged(
                &webview,
                false,
                operation_state.clone(),
                operation_id,
                BrowserOperationKind::Closed,
            )?;
            let _ = set_browser_visible_if_current(
                &label,
                &operation_state,
                operation_id,
                BrowserOperationKind::Closed,
                false,
            );
            if !browser_operation_is_current(
                &operation_state,
                operation_id,
                BrowserOperationKind::Closed,
            ) {
                return Err("browser visibility operation was superseded".to_string());
            }

            // Close is retried indefinitely by the frontend. Never begin
            // teardown while WindowServer is reparenting the child, but retain
            // the lifecycle reservation while waiting so Open cannot overtake.
            ensure_native_view_operations_allowed()?;

            if let Err(close_error) = webview.close() {
                return Err(format!(
                    "failed to close browser webview (hidden pending retry): {close_error}"
                ));
            }
        }
        #[cfg(not(target_os = "macos"))]
        if let Err(close_error) = webview.close() {
            return Err(format!("failed to close browser webview: {close_error}"));
        }
    }
    let _ = set_browser_visible_if_current(
        &label,
        &operation_state,
        operation_id,
        BrowserOperationKind::Closed,
        false,
    );
    unregister_managed_browser(&label);
    Ok(())
}

#[allow(dead_code)]
fn capture_region(x: i32, y: i32, width: u32, height: u32) -> Result<BrowserScreenshot, String> {
    #[cfg(target_os = "macos")]
    {
        let path = temp_screenshot_path();
        let region = format!("{x},{y},{width},{height}");
        let output = Command::new("/usr/sbin/screencapture")
            .arg("-x")
            .arg("-R")
            .arg(&region)
            .arg(&path)
            .output()
            .map_err(|e| format!("failed to run screencapture: {e}"))?;

        let bytes = fs::read(&path).unwrap_or_default();
        let _ = fs::remove_file(&path);
        if !output.status.success() || bytes.len() < 32 {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = stderr.trim();
            if detail.is_empty() {
                return Err(SCREEN_RECORDING_PERMISSION_REQUIRED.to_string());
            }
            return Err(format!(
                "{SCREEN_RECORDING_PERMISSION_REQUIRED} screencapture said: {detail}"
            ));
        }

        let (png_width, png_height) = png_dimensions(&bytes)
            .ok_or_else(|| "screencapture did not produce a valid PNG".to_string())?;
        Ok(BrowserScreenshot {
            mime_type: "image/png",
            data: BASE64.encode(bytes),
            width: png_width,
            height: png_height,
            source_width: png_width,
            source_height: png_height,
            target: "browser",
            captured_element: "browser_webview",
            capture_method: "screencapture_region",
        })
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (x, y, width, height);
        Err(
            "embedded browser screenshot capture is currently implemented for macOS only"
                .to_string(),
        )
    }
}

#[cfg(target_os = "macos")]
mod macos_browser_capture {
    use super::{png_dimensions, retryable_native_error, BrowserScreenshot, BASE64};
    use base64::Engine;
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSImage,
    };
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;
    use std::{
        panic::AssertUnwindSafe,
        sync::{mpsc, Arc, Mutex},
        time::Duration,
    };
    use tauri::Webview;

    const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(3);

    pub async fn capture(webview: Webview) -> Result<BrowserScreenshot, String> {
        if !crate::display_recovery::native_view_operations_allowed() {
            return Err(retryable_native_error(
                "cannot capture browser while display topology is settling",
            ));
        }
        let (tx, rx) = mpsc::channel::<Result<BrowserScreenshot, String>>();
        let sender = Arc::new(Mutex::new(Some(tx)));
        let native_sender = sender.clone();
        crate::display_recovery::with_webview_balanced(&webview, move |inner| {
            let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                if !crate::display_recovery::native_view_operations_allowed() {
                    return Err(retryable_native_error(
                        "cannot capture browser while display topology is settling",
                    ));
                }
                if inner.is_null() {
                    return Err(retryable_native_error(
                        "browser snapshot WKWebView handle is null",
                    ));
                }

                let completion_sender = native_sender.clone();
                let completion = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                        objc2::exception::catch(AssertUnwindSafe(|| unsafe {
                            snapshot_callback_result(image, error)
                        }))
                        .unwrap_or_else(|_| {
                            Err("BROWSER_SNAPSHOT_FAILED: Objective-C exception in snapshot callback"
                                .to_string())
                        })
                    }))
                    .unwrap_or_else(|_| {
                        Err("BROWSER_SNAPSHOT_FAILED: Rust panic in snapshot callback".to_string())
                    });
                    send_once(&completion_sender, result);
                });

                objc2::exception::catch(AssertUnwindSafe(|| {
                    let wk_webview = unsafe { &*(inner as *mut WKWebView) };
                    if wk_webview.window().is_none()
                        || unsafe { wk_webview.superview() }.is_none()
                    {
                        return Err(retryable_native_error(
                            "browser snapshot WKWebView is temporarily detached",
                        ));
                    }
                    let frame = wk_webview.frame();
                    if !frame.size.width.is_finite()
                        || !frame.size.height.is_finite()
                        || frame.size.width < 2.0
                        || frame.size.height < 2.0
                    {
                        return Err("browser tab has no visible capture area".to_string());
                    }
                    unsafe {
                        wk_webview
                            .takeSnapshotWithConfiguration_completionHandler(None, &completion);
                    }
                    Ok(())
                }))
                .map_err(|_| {
                    retryable_native_error("Objective-C exception while starting browser snapshot")
                })?
            }))
            .unwrap_or_else(|_| {
                Err(retryable_native_error(
                    "Rust panic while starting browser snapshot",
                ))
            });
            if let Err(error) = result {
                send_once(&native_sender, Err(error));
            }
        })
            .map_err(|e| {
                format!("BROWSER_SNAPSHOT_FAILED: unable to access native WKWebView: {e}")
            })?;

        let received =
            tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(SNAPSHOT_TIMEOUT))
                .await
                .map_err(|e| format!("BROWSER_SNAPSHOT_FAILED: snapshot wait failed: {e}"))?;

        match received {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Err("BROWSER_SNAPSHOT_FAILED: WKWebView snapshot timed out".to_string())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("BROWSER_SNAPSHOT_FAILED: WKWebView snapshot callback was dropped".to_string())
            }
        }
    }

    fn send_once(
        sender: &Mutex<Option<mpsc::Sender<Result<BrowserScreenshot, String>>>>,
        result: Result<BrowserScreenshot, String>,
    ) {
        if let Ok(mut sender) = sender.lock() {
            if let Some(sender) = sender.take() {
                let _ = sender.send(result);
            }
        }
    }

    unsafe fn snapshot_callback_result(
        image: *mut NSImage,
        error: *mut NSError,
    ) -> Result<BrowserScreenshot, String> {
        if !error.is_null() {
            return Err(format!("BROWSER_SNAPSHOT_FAILED: {}", unsafe { &*error }));
        }

        let bytes = unsafe { image_to_png_bytes(image) }?;
        let (png_width, png_height) = png_dimensions(&bytes).ok_or_else(|| {
            "BROWSER_SNAPSHOT_FAILED: WKWebView did not produce a valid PNG".to_string()
        })?;

        Ok(BrowserScreenshot {
            mime_type: "image/png",
            data: BASE64.encode(bytes),
            width: png_width,
            height: png_height,
            source_width: png_width,
            source_height: png_height,
            target: "browser",
            captured_element: "browser_webview",
            capture_method: "wkwebview_snapshot",
        })
    }

    unsafe fn image_to_png_bytes(image: *mut NSImage) -> Result<Vec<u8>, String> {
        let image = unsafe { image.as_ref() }.ok_or_else(|| {
            "BROWSER_SNAPSHOT_FAILED: WKWebView returned no snapshot image".to_string()
        })?;
        let tiff = image.TIFFRepresentation().ok_or_else(|| {
            "BROWSER_SNAPSHOT_FAILED: WKWebView snapshot could not be converted to TIFF".to_string()
        })?;
        let bitmap = NSBitmapImageRep::imageRepWithData(&tiff).ok_or_else(|| {
            "BROWSER_SNAPSHOT_FAILED: WKWebView snapshot could not be converted to a bitmap"
                .to_string()
        })?;
        let properties = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::dictionary();
        let png = unsafe {
            bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
        }
        .ok_or_else(|| {
            "BROWSER_SNAPSHOT_FAILED: WKWebView snapshot could not be encoded as PNG".to_string()
        })?;
        let bytes = png.to_vec();
        if bytes.is_empty() {
            return Err("BROWSER_SNAPSHOT_FAILED: WKWebView snapshot PNG was empty".to_string());
        }
        Ok(bytes)
    }
}

#[allow(dead_code)]
fn temp_screenshot_path() -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "agents-ui-browser-screenshot-{}-{nanos}.png",
        std::process::id()
    ))
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    const PNG_SIG: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 24 || &bytes[..8] != PNG_SIG {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    if width == 0 || height == 0 {
        return None;
    }
    Some((width, height))
}

#[cfg(test)]
mod tests {
    use super::{
        browser_creation_reservation, browser_operation_is_current, browser_operation_state,
        claim_browser_operation, force_terminal_operation, BrowserLayoutBounds,
        BrowserOperationKind, BrowserOperationState,
    };
    use std::sync::{mpsc, Arc, Mutex, TryLockError};
    use std::time::Duration;

    #[test]
    fn operation_ids_reject_older_visibility_intents() {
        let mut state = BrowserOperationState::default();
        assert!(claim_browser_operation(&mut state, 10, BrowserOperationKind::Open).is_ok());
        assert!(claim_browser_operation(&mut state, 9, BrowserOperationKind::Hide).is_err());
        assert!(claim_browser_operation(&mut state, 11, BrowserOperationKind::Hide).is_ok());
    }

    #[test]
    fn identical_operation_retry_is_allowed_but_conflicting_kind_is_not() {
        let mut state = BrowserOperationState::default();
        assert!(claim_browser_operation(&mut state, 42, BrowserOperationKind::Hide).is_ok());
        assert!(claim_browser_operation(&mut state, 42, BrowserOperationKind::Hide).is_ok());
        assert!(claim_browser_operation(&mut state, 42, BrowserOperationKind::Open).is_err());
    }

    #[test]
    fn sequenced_close_invalidates_in_flight_ids_without_blocking_newer_ones() {
        let mut state = BrowserOperationState::default();
        assert!(claim_browser_operation(&mut state, 100, BrowserOperationKind::Open).is_ok());
        assert!(claim_browser_operation(&mut state, 200, BrowserOperationKind::Closed).is_ok());
        assert!(claim_browser_operation(&mut state, 150, BrowserOperationKind::Open).is_err());
        assert!(claim_browser_operation(&mut state, 200, BrowserOperationKind::Open).is_err());
        assert!(claim_browser_operation(&mut state, 201, BrowserOperationKind::Open).is_ok());
    }

    #[test]
    fn bounds_updates_participate_in_operation_serialization() {
        let mut state = BrowserOperationState::default();
        assert!(claim_browser_operation(&mut state, 1, BrowserOperationKind::Open).is_ok());
        assert!(claim_browser_operation(&mut state, 2, BrowserOperationKind::Bounds).is_ok());
        assert!(claim_browser_operation(&mut state, 1, BrowserOperationKind::Open).is_err());
        assert!(claim_browser_operation(&mut state, 2, BrowserOperationKind::Hide).is_err());
        assert!(claim_browser_operation(&mut state, 3, BrowserOperationKind::Hide).is_ok());
    }

    #[test]
    fn close_waits_for_child_insertion_before_claiming_terminal_intent() {
        const LABEL: &str = "__browser_create_close_race_test__";
        let creation_reservation = browser_creation_reservation(LABEL);
        let operation_state = browser_operation_state(LABEL);
        let child_exists = Arc::new(Mutex::new(false));

        let creation_guard = creation_reservation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        {
            let mut state = operation_state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *state = BrowserOperationState::default();
            claim_browser_operation(&mut state, 100, BrowserOperationKind::Open)
                .expect("Open should own the initial creation intent");
        }
        assert!(!*child_exists
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()));

        let close_reservation = creation_reservation.clone();
        let close_operation_state = operation_state.clone();
        let close_child_exists = child_exists.clone();
        let (blocked_sender, blocked_receiver) = mpsc::sync_channel(1);
        let (closed_sender, closed_receiver) = mpsc::sync_channel(1);
        let close_thread = std::thread::spawn(move || {
            assert!(matches!(
                close_reservation.try_lock(),
                Err(TryLockError::WouldBlock)
            ));
            blocked_sender
                .send(())
                .expect("test should observe the paused Close");

            let _close_guard = close_reservation
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            {
                let mut state = close_operation_state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                claim_browser_operation(&mut state, 200, BrowserOperationKind::Closed)
                    .expect("newer Close should claim after insertion completes");
            }
            let mut exists = close_child_exists
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(*exists, "Close must not observe the pre-insertion gap");
            *exists = false;
            closed_sender
                .send(())
                .expect("Close completion receiver alive");
        });

        blocked_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("Close should reach the held creation reservation");
        assert_eq!(
            operation_state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .latest_kind,
            Some(BrowserOperationKind::Open),
            "Close cannot supersede Open before the child is registered"
        );

        *child_exists
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
        drop(creation_guard);

        closed_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("Close should finish after child insertion");
        close_thread
            .join()
            .expect("Close test thread should not panic");
        assert!(!*child_exists
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()));
        assert_eq!(
            operation_state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .latest_kind,
            Some(BrowserOperationKind::Closed)
        );
    }

    #[test]
    fn acknowledged_close_blocks_same_label_open_until_native_drop() {
        const LABEL: &str = "__browser_close_ack_reopen_race_test__";
        let reservation = browser_creation_reservation(LABEL);
        let operation_state = browser_operation_state(LABEL);
        let child_exists = Arc::new(Mutex::new(true));
        {
            let mut state = operation_state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *state = BrowserOperationState::default();
            claim_browser_operation(&mut state, 100, BrowserOperationKind::Open)
                .expect("initial child should have an Open intent");
        }

        let close_reservation = reservation.clone();
        let close_state = operation_state.clone();
        let close_child = child_exists.clone();
        let (close_started_tx, close_started_rx) = mpsc::sync_channel(1);
        let (allow_native_drop_tx, allow_native_drop_rx) = mpsc::sync_channel(1);
        let (close_ack_tx, close_ack_rx) = mpsc::sync_channel(1);
        let close_thread = std::thread::spawn(move || {
            let _lifecycle_guard = close_reservation
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            {
                let mut state = close_state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                claim_browser_operation(&mut state, 200, BrowserOperationKind::Closed)
                    .expect("Close should own the newer lifecycle intent");
            }
            close_started_tx
                .send(())
                .expect("test Close-start receiver should remain alive");
            allow_native_drop_rx
                .recv()
                .expect("test should release the simulated native Drop");
            *close_child
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = false;
            // The real runtime sends its acknowledgement only after dropping
            // the event-loop-owned Wry wrapper.
            close_ack_tx
                .send(())
                .expect("test Close-ack receiver should remain alive");
        });

        close_started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("Close should acquire the lifecycle reservation");
        assert!(matches!(
            reservation.try_lock(),
            Err(TryLockError::WouldBlock)
        ));

        let open_reservation = reservation.clone();
        let open_state = operation_state.clone();
        let open_child = child_exists.clone();
        let (open_waiting_tx, open_waiting_rx) = mpsc::sync_channel(1);
        let (open_done_tx, open_done_rx) = mpsc::sync_channel(1);
        let open_thread = std::thread::spawn(move || {
            open_waiting_tx
                .send(())
                .expect("test Open-wait receiver should remain alive");
            let _lifecycle_guard = open_reservation
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            {
                let mut state = open_state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                claim_browser_operation(&mut state, 201, BrowserOperationKind::Open)
                    .expect("newer Open should run after acknowledged Close");
            }
            let mut exists = open_child
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(!*exists, "Open must observe completed native teardown");
            *exists = true;
            open_done_tx
                .send(())
                .expect("test Open completion receiver should remain alive");
        });

        open_waiting_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("Open should reach the held lifecycle reservation");
        assert!(matches!(
            open_done_rx.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));

        allow_native_drop_tx
            .send(())
            .expect("Close thread should await native Drop");
        close_ack_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("native Drop must precede Close acknowledgement");
        open_done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("Open should proceed after acknowledged Close");
        close_thread
            .join()
            .expect("Close test thread should not panic");
        open_thread
            .join()
            .expect("Open test thread should not panic");

        assert!(*child_exists
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()));
        assert_eq!(
            operation_state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .latest_kind,
            Some(BrowserOperationKind::Open)
        );
    }

    #[test]
    fn operation_check_releases_mutex_before_native_reentry() {
        let operation_state = Arc::new(Mutex::new(BrowserOperationState::default()));
        {
            let mut state = operation_state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            claim_browser_operation(&mut state, 7, BrowserOperationKind::Bounds)
                .expect("test operation should be accepted");
        }

        assert!(browser_operation_is_current(
            &operation_state,
            7,
            BrowserOperationKind::Bounds
        ));
        assert!(
            operation_state.try_lock().is_ok(),
            "operation checks must not retain the mutex across native callbacks"
        );
    }

    #[test]
    fn renderer_termination_marker_invalidates_stale_native_callbacks() {
        let operation_state = Arc::new(Mutex::new(BrowserOperationState::default()));
        {
            let mut state = operation_state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            claim_browser_operation(&mut state, 41, BrowserOperationKind::Open)
                .expect("test Open should be accepted");
        }
        force_terminal_operation(&operation_state);

        assert!(!browser_operation_is_current(
            &operation_state,
            41,
            BrowserOperationKind::Open
        ));
        let mut state = operation_state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(claim_browser_operation(&mut state, 42, BrowserOperationKind::Open).is_err());
        assert!(
            claim_browser_operation(&mut state, u64::MAX, BrowserOperationKind::Closed).is_ok()
        );
    }

    #[test]
    fn layout_bounds_require_finite_positive_dimensions() {
        for (width, height) in [
            (0.0, 10.0),
            (-1.0, 10.0),
            (10.0, 0.0),
            (10.0, -1.0),
            (f64::NAN, 10.0),
            (10.0, f64::INFINITY),
        ] {
            assert!(BrowserLayoutBounds::validated(0.0, 0.0, width, height, 0.0).is_err());
        }
        assert!(BrowserLayoutBounds::validated(f64::NAN, 0.0, 10.0, 10.0, 0.0).is_err());
        assert!(BrowserLayoutBounds::validated(0.0, f64::INFINITY, 10.0, 10.0, 0.0).is_err());
        assert!(BrowserLayoutBounds::validated(0.0, 0.0, 10.0, 10.0, f64::NAN).is_err());
    }

    #[test]
    fn layout_bounds_allow_offscreen_origins_and_normalize_negative_offset() {
        let bounds = BrowserLayoutBounds::validated(-500.5, -20.25, 800.0, 600.0, -4.0)
            .expect("valid layout bounds");
        assert_eq!(bounds.x, -500.5);
        assert_eq!(bounds.y, -20.25);
        assert_eq!(bounds.y_offset, 0.0);
    }
}
