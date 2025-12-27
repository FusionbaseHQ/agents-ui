mod assets;
mod pty;
mod persist;
mod recording;
mod tray;

use assets::apply_text_assets;
use pty::{
    close_session, create_session, list_sessions, resize_session, start_session_recording,
    stop_session_recording, write_to_session, AppState,
};
use persist::{list_directories, load_persisted_state, save_persisted_state, validate_directory};
use recording::{delete_recording, list_recordings, load_recording};
use tray::{build_status_tray, set_tray_agent_count};
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .setup(|app| {
            let tray = build_status_tray(&app.handle()).unwrap_or_else(|e| {
                eprintln!("Failed to create tray icon: {e}");
                tray::StatusTrayState::disabled()
            });
            app.manage(tray);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_session,
            write_to_session,
            resize_session,
            close_session,
            list_sessions,
            start_session_recording,
            stop_session_recording,
            load_persisted_state,
            save_persisted_state,
            validate_directory,
            list_directories,
            load_recording,
            list_recordings,
            delete_recording,
            apply_text_assets,
            set_tray_agent_count
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
