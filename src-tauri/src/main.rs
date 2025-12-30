mod app_menu;
mod app_info;
mod assets;
mod pty;
mod persist;
mod recording;
mod secure;
mod ssh;
mod startup;
mod tray;

use app_info::get_app_info;
use assets::apply_text_assets;
use app_menu::{build_app_menu, handle_app_menu_event};
use pty::{
    close_session, create_session, detach_session, kill_persistent_session, list_persistent_sessions,
    list_sessions, resize_session, start_session_recording, stop_session_recording, write_to_session,
    AppState,
};
use persist::{list_directories, load_persisted_state, load_persisted_state_meta, save_persisted_state, validate_directory};
use recording::{delete_recording, list_recordings, load_recording};
use secure::{prepare_secure_storage, reset_secure_storage};
use ssh::list_ssh_hosts;
use startup::get_startup_flags;
use tray::{build_status_tray, set_tray_agent_count};
use tauri::Manager;

fn main() {
    startup::init_startup_flags();
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_shell::init())
        .menu(|app| build_app_menu(app))
        .on_menu_event(|app, event| handle_app_menu_event(app, event))
        .setup(|app| {
            if let Err(e) = startup::clear_app_data_if_requested(&app.handle()) {
                eprintln!("Failed to clear app data: {e}");
            }
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
            detach_session,
            list_sessions,
            list_persistent_sessions,
            kill_persistent_session,
            start_session_recording,
            stop_session_recording,
            get_startup_flags,
            load_persisted_state,
            load_persisted_state_meta,
            save_persisted_state,
            validate_directory,
            list_directories,
            load_recording,
            list_recordings,
            delete_recording,
            prepare_secure_storage,
            reset_secure_storage,
            list_ssh_hosts,
            apply_text_assets,
            set_tray_agent_count,
            get_app_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
