mod app_menu;
mod app_info;
mod assets;
mod files;
mod file_manager;
mod pty;
mod persist;
mod recording;
mod secure;
mod ssh;
mod ssh_fs;
mod startup;
mod tray;

use app_info::get_app_info;
use assets::apply_text_assets;
use app_menu::{build_app_menu, handle_app_menu_event};
use files::{copy_fs_entry, delete_fs_entry, list_fs_entries, read_text_file, rename_fs_entry, write_text_file};
use file_manager::{open_path_in_file_manager, open_path_in_vscode};
use pty::{
    close_session, create_session, detach_session, kill_persistent_session, list_persistent_sessions,
    list_sessions, resize_session, start_session_recording, stop_session_recording, write_to_session,
    AppState,
};
use persist::{list_directories, load_persisted_state, load_persisted_state_meta, save_persisted_state, validate_directory};
use recording::{delete_recording, list_recordings, load_recording};
use secure::{prepare_secure_storage, reset_secure_storage};
use ssh::list_ssh_hosts;
use ssh_fs::{
    ssh_default_root, ssh_delete_fs_entry, ssh_download_file, ssh_download_to_temp,
    ssh_list_fs_entries, ssh_read_text_file, ssh_rename_fs_entry, ssh_upload_file,
    ssh_write_text_file,
};
use startup::get_startup_flags;
use tray::{build_status_tray, set_tray_agent_count};
use tauri::Manager;

fn main() {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        // Pre-seed PATH with common directories so shell init scripts can run properly.
        // Without this, commands like `brew` or `nvm` in .zshrc may fail when
        // the app is launched from Finder (which starts with minimal PATH).
        if let Ok(current_path) = std::env::var("PATH") {
            let mut paths: Vec<&str> = current_path.split(':').collect();
            let additions = [
                "/opt/homebrew/bin",
                "/opt/homebrew/sbin",
                "/usr/local/bin",
                "/usr/local/sbin",
            ];
            for dir in additions {
                if std::path::Path::new(dir).is_dir() && !paths.contains(&dir) {
                    paths.insert(0, dir);
                }
            }
            std::env::set_var("PATH", paths.join(":"));
        }

        // Now fix_path_env can properly spawn the shell to extract full PATH.
        let _ = fix_path_env::fix();
    }
    startup::init_startup_flags();
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
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
            list_fs_entries,
            read_text_file,
            write_text_file,
            rename_fs_entry,
            delete_fs_entry,
            copy_fs_entry,
            ssh_default_root,
            ssh_list_fs_entries,
            ssh_read_text_file,
            ssh_write_text_file,
            ssh_rename_fs_entry,
            ssh_delete_fs_entry,
            ssh_download_file,
            ssh_upload_file,
            ssh_download_to_temp,
            load_recording,
            list_recordings,
            delete_recording,
            prepare_secure_storage,
            reset_secure_storage,
            list_ssh_hosts,
            apply_text_assets,
            set_tray_agent_count,
            open_path_in_file_manager,
            open_path_in_vscode,
            get_app_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
