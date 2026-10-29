//! Closing the window and quitting the app without losing running sessions.
//!
//! On macOS closing the main window only hides it: sessions keep running, and
//! the Dock icon or the tray brings the window back. Quitting (⌘Q, the tray's
//! Quit, or closing the window on other platforms) asks first when it would end
//! running sessions. The Dock's Quit and logout/shutdown go through AppKit's
//! terminate:, which can't be held up, so those exit without asking.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, ExitRequestApi, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::pty;

/// Set once the user confirmed, so the second exit request goes through.
static QUIT_CONFIRMED: AtomicBool = AtomicBool::new(false);
/// A confirmation dialog is showing; repeated ⌘Q presses don't stack dialogs.
static QUIT_DIALOG_OPEN: AtomicBool = AtomicBool::new(false);

pub fn on_main_window_close(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let Some(window) = app.get_window("main") else {
            return;
        };
        // Hiding a full-screen window would leave its empty Space behind; hide
        // the app instead (like ⌘H), which the Dock icon also undoes.
        if window.is_fullscreen().unwrap_or(false) {
            let _ = app.hide();
        } else {
            let _ = window.hide();
        }
    }
    #[cfg(not(target_os = "macos"))]
    app.exit(0);
}

pub fn on_exit_requested(app: &AppHandle, code: Option<i32>, api: &ExitRequestApi) {
    if code == Some(tauri::RESTART_EXIT_CODE) || QUIT_CONFIRMED.load(Ordering::Acquire) {
        return;
    }
    let (ended, persistent) = pty::quit_session_counts(&app.state::<pty::AppState>());
    if ended == 0 {
        return;
    }
    api.prevent_exit();
    if QUIT_DIALOG_OPEN.swap(true, Ordering::AcqRel) {
        return;
    }

    // The window may be hidden (or the app in the background after the tray's
    // Quit); show it so the dialog appears in front.
    crate::tray::show_main_window(app);
    let mut message = if ended == 1 {
        "Quitting closes 1 terminal session and stops anything running in it.".to_string()
    } else {
        format!("Quitting closes {ended} terminal sessions and stops anything running in them.")
    };
    if persistent > 0 {
        message.push_str(" Persistent terminals keep running.");
    }
    let handle = app.clone();
    app.dialog()
        .message(message)
        .title("Quit Agents UI?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit".to_string(),
            "Cancel".to_string(),
        ))
        .show(move |quit| {
            QUIT_DIALOG_OPEN.store(false, Ordering::Release);
            if quit {
                QUIT_CONFIRMED.store(true, Ordering::Release);
                handle.exit(0);
            }
        });
}
