mod pty;
mod persist;
mod tray;

use pty::{close_session, create_session, list_sessions, resize_session, write_to_session, AppState};
use persist::{list_directories, load_persisted_state, save_persisted_state, validate_directory};
use tray::{build_status_tray, set_tray_agent_count};
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .setup(|app| {
            let tray = build_status_tray(&app.handle())?;
            app.manage(tray);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_session,
            write_to_session,
            resize_session,
            close_session,
            list_sessions,
            load_persisted_state,
            save_persisted_state,
            validate_directory,
            list_directories,
            set_tray_agent_count
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
