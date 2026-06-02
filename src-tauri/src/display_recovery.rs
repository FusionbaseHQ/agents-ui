// Display-sleep recovery (macOS).
//
// ROOT CAUSE (verified): when the monitor powers off (display sleep), macOS
// invalidates the GPU surface (IOSurface) the main WKWebView composites onto.
// On wake the WKWebView's CoreAnimation layer does NOT re-establish that
// surface, so the window presents nothing — a blank/dark window — even though
// the app process, the WebKit web-content process, and the JS app are all still
// alive. (Confirmed by the total absence of crash/hang reports for agents-ui,
// WebContent, WebKit, or the GPU process: nothing is dying; it's a pure
// compositing wedge.)
//
// Why the previous "fixes" never worked:
//   1. They run in JS/DOM (`forceWebviewRepaint` toggles a CSS class; canvas
//      recovery recreates xterm addons). None of that touches the native
//      CoreAnimation compositing layer, so it cannot repair a surface wedge.
//   2. On a *pure monitor sleep* the system stays awake, so the webview gets no
//      visibilitychange / focus / Resumed / timer-gap event at all — the JS
//      recovery frequently never even runs. tao/Tauri expose no occlusion or
//      display-power event, so there was no trigger for this case.
//
// FIX: natively poll the main display's sleep state and, on the asleep->awake
// transition, force the WKWebView to re-create its compositing surface with a
// minimal 1px window-size "kick", and emit `system-resumed` so the frontend
// also refreshes the terminal canvases.

#[cfg(target_os = "macos")]
mod imp {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tauri::{AppHandle, Emitter, Manager};

    // CoreGraphics: CGDisplayIsAsleep returns nonzero while a display is asleep
    // (not drawable). CGMainDisplayID identifies the primary display.
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGMainDisplayID() -> u32;
        fn CGDisplayIsAsleep(display: u32) -> i32;
    }

    fn main_display_asleep() -> bool {
        unsafe { CGDisplayIsAsleep(CGMainDisplayID()) != 0 }
    }

    static STARTED: AtomicBool = AtomicBool::new(false);

    pub fn start(app: AppHandle) {
        if STARTED.swap(true, Ordering::SeqCst) {
            return; // a single watchdog is enough
        }
        let _ = std::thread::Builder::new()
            .name("display-wake-watchdog".into())
            .spawn(move || {
                let mut was_asleep = main_display_asleep();
                loop {
                    std::thread::sleep(Duration::from_millis(1000));
                    let asleep = main_display_asleep();
                    if asleep && !was_asleep {
                        // Logged so a real sleep/wake can be confirmed in the dev
                        // log; the recompose happens on the wake edge below.
                        eprintln!("[display-recovery] Main display slept.");
                    }
                    // Recover on the asleep -> awake edge (monitor turned back
                    // on, or system woke from sleep — the display is asleep in
                    // both cases and wakes on resume).
                    if was_asleep && !asleep {
                        eprintln!(
                            "[display-recovery] Main display woke; forcing webview recomposite."
                        );
                        recompose(&app);
                    }
                    was_asleep = asleep;
                }
            });
    }

    fn recompose(app: &AppHandle) {
        // All window operations must happen on the main (UI) thread; the timing
        // sleep happens on this watchdog thread so the UI is never blocked.
        let size_cell: Arc<Mutex<Option<(u32, u32)>>> = Arc::new(Mutex::new(None));

        // Step 1: signal the frontend recovery and nudge the window 1px smaller,
        // forcing WKWebView to rebuild its CoreAnimation surface.
        let app1 = app.clone();
        let cell1 = size_cell.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(win) = app1.get_webview_window("main") else {
                return;
            };
            let _ = win.emit("system-resumed", ());
            // Resizing a fullscreen window would exit fullscreen; skip the kick
            // there (the JS recovery above still runs).
            if win.is_fullscreen().unwrap_or(false) {
                return;
            }
            if let Ok(sz) = win.inner_size() {
                let w = sz.width.max(2);
                let h = sz.height.max(2);
                *cell1.lock().unwrap() = Some((w, h));
                let _ = win.set_size(tauri::PhysicalSize::new(w - 1, h));
            }
        });

        // Step 2: restore the original size a moment later, again on the main
        // thread, so the surface is presented at the correct dimensions.
        std::thread::sleep(Duration::from_millis(70));
        let app2 = app.clone();
        let cell2 = size_cell;
        let _ = app.run_on_main_thread(move || {
            let Some((w, h)) = *cell2.lock().unwrap() else {
                return;
            };
            if let Some(win) = app2.get_webview_window("main") {
                let _ = win.set_size(tauri::PhysicalSize::new(w, h));
            }
        });
    }
}

/// Start the display-wake watchdog. On macOS this recovers the main WKWebView
/// from the post-display-sleep compositing wedge that otherwise leaves the
/// window permanently blank. No-op on other platforms.
#[cfg(target_os = "macos")]
pub fn start(app: tauri::AppHandle) {
    imp::start(app);
}

#[cfg(not(target_os = "macos"))]
pub fn start(_app: tauri::AppHandle) {}
