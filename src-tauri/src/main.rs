mod pty;
mod persist;

use pty::{close_session, create_session, list_sessions, resize_session, write_to_session, AppState};
use persist::{list_directories, load_persisted_state, save_persisted_state, validate_directory};

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            create_session,
            write_to_session,
            resize_session,
            close_session,
            list_sessions,
            load_persisted_state,
            save_persisted_state,
            validate_directory,
            list_directories
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
