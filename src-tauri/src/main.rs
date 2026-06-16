mod agent;
mod api_bridge;
mod browser;
mod display_recovery;
mod api_discovery;
mod api_handlers;
mod api_server;
mod api_types;
mod app_menu;
mod app_info;
mod assets;
mod server_control;
mod files;
mod file_manager;
mod fs_watcher;
mod mcp_server;
mod mcp_tools;
mod power_assertion;
mod pty;
mod persist;
mod recording;
mod secure;
mod ssh;
mod ssh_fs;
mod startup;
mod system_stats;
mod tray;

use app_info::get_app_info;
use assets::apply_text_assets;
use app_menu::{build_app_menu, handle_app_menu_event};
use files::{copy_fs_entry, create_directory, create_file, delete_fs_entry, list_fs_entries, probe_file, read_file_range, read_text_file, rename_fs_entry, search_fs_entries, write_text_file};
use file_manager::{open_path_in_file_manager, open_path_in_vscode};
use pty::{
    close_session, create_session, detach_session, kill_persistent_session, list_persistent_sessions,
    list_sessions, rename_session, resize_session, start_session_recording, stop_session_recording,
    write_to_session, AppState,
};
use persist::{list_directories, load_persisted_state, load_persisted_state_meta, save_persisted_state, validate_directory};
use recording::{delete_recording, list_recordings, load_recording};
use secure::{prepare_secure_storage, reset_secure_storage};
use ssh::list_ssh_hosts;
use ssh_fs::{
    ssh_create_directory, ssh_create_file, ssh_default_root, ssh_delete_fs_entry, ssh_download_file,
    ssh_download_to_temp, ssh_effective_user,
    ssh_list_fs_entries, ssh_probe_file, ssh_read_file_range, ssh_read_text_file, ssh_rename_fs_entry, ssh_search_fs_entries, ssh_upload_file,
    ssh_write_text_file,
};
use fs_watcher::{start_fs_watcher, stop_fs_watcher, watch_directory, unwatch_directory, FsWatcherState};
use startup::get_startup_flags;
use system_stats::{ssh_system_health_stats, system_health_stats};
use agent::{start_agent_prompt, stop_agent, get_agent_terminal_command, build_agent_task_command, write_agent_mcp_config, register_mcp_with_agents, read_agent_session_output, orchestrate_ensure_dir, orchestrate_read_file, AgentState};
use api_bridge::{api_respond, api_notify_state_change, ApiPendingRequests, ApiEventBus};
use mcp_tools::OutputBuffers;
use server_control::{get_server_status, set_api_enabled, set_mcp_enabled, ServerControl};
use tray::{build_status_tray, set_tray_agent_count, set_tray_recent_sessions, set_tray_status};
use std::sync::Arc;
use tauri::{Emitter, Manager};

/// Raise the open-file-descriptor soft limit on Unix. The macOS default is only
/// 256, which a terminal multiplexer exhausts fast: each PTY session holds ~3
/// descriptors (master + cloned reader + writer), so a few dozen restored
/// sessions plus SSH control sockets blow past it. Once over the limit, *any*
/// new FD allocation fails with EMFILE ("Too many open files") — including
/// reading ~/.ssh/config or spawning ssh/sftp for the remote file tree, which
/// is how this surfaces. We only ever raise the soft limit, never lower it, and
/// cap it at the hard limit (65536 is well under macOS's kern.maxfilesperproc).
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn raise_fd_limit() {
    const DESIRED_SOFT: libc::rlim_t = 65_536;
    // SAFETY: getrlimit/setrlimit are simple syscalls writing into a local
    // rlimit we fully own; no aliasing or lifetime concerns.
    unsafe {
        let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) != 0 {
            eprintln!(
                "[fd-limit] getrlimit failed: {}",
                std::io::Error::last_os_error()
            );
            return;
        }

        // Target DESIRED_SOFT, but never exceed the hard cap (unless it reports
        // unlimited, in which case DESIRED_SOFT is the ceiling we want).
        let target = if lim.rlim_max == libc::RLIM_INFINITY {
            DESIRED_SOFT
        } else {
            DESIRED_SOFT.min(lim.rlim_max)
        };

        if lim.rlim_cur >= target {
            return; // already high enough
        }

        let new = libc::rlimit { rlim_cur: target, rlim_max: lim.rlim_max };
        if libc::setrlimit(libc::RLIMIT_NOFILE, &new) != 0 {
            eprintln!(
                "[fd-limit] setrlimit to {target} failed (current soft {}): {}",
                lim.rlim_cur,
                std::io::Error::last_os_error()
            );
        }
    }
}

fn main() {
    // Must run before anything opens file descriptors (PTYs, sockets, watchers).
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    raise_fd_limit();

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
        .manage(FsWatcherState::default())
        .manage(ApiPendingRequests::default())
        .manage(ApiEventBus::default())
        .manage(AgentState::default())
        .manage(OutputBuffers::default())
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

            // Recover the main WKWebView from the post-display-sleep compositing
            // wedge that otherwise leaves the window permanently blank (macOS).
            display_recovery::start(app.handle().clone());

            // Auto-caffeinate: keep the Mac awake while SSH sessions are
            // active so idle sleep doesn't drop the connections and kill
            // remote processes (macOS).
            let pty_state = app.state::<AppState>().inner().clone();
            power_assertion::start(app.handle().clone(), pty_state);

            // Server control: create shutdown channels and read persisted settings
            let settings = server_control::load_settings();
            let (sc, api_rx, mcp_rx) = ServerControl::new();
            let sc = Arc::new(sc);
            app.manage(sc.clone());

            // Start the external control API server (if enabled)
            if settings.api_enabled {
                let handle = app.handle().clone();
                let sc_api = sc.clone();
                tauri::async_runtime::spawn(async move {
                    api_server::start_api_server_with_shutdown(handle, api_rx, sc_api).await;
                });
            }

            // Start the MCP server (if enabled)
            if settings.mcp_enabled {
                let handle2 = app.handle().clone();
                let sc_mcp = sc.clone();
                tauri::async_runtime::spawn(async move {
                    mcp_server::start_mcp_server_with_shutdown(handle2, mcp_rx, sc_mcp).await;
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_session,
            write_to_session,
            resize_session,
            close_session,
            rename_session,
            detach_session,
            list_sessions,
            list_persistent_sessions,
            kill_persistent_session,
            start_session_recording,
            stop_session_recording,
            power_assertion::set_auto_caffeinate,
            get_startup_flags,
            load_persisted_state,
            load_persisted_state_meta,
            save_persisted_state,
            validate_directory,
            list_directories,
            list_fs_entries,
            search_fs_entries,
            read_text_file,
            probe_file,
            read_file_range,
            write_text_file,
            rename_fs_entry,
            delete_fs_entry,
            copy_fs_entry,
            create_file,
            create_directory,
            ssh_default_root,
            ssh_effective_user,
            ssh_create_file,
            ssh_create_directory,
            ssh_list_fs_entries,
            ssh_search_fs_entries,
            ssh_read_text_file,
            ssh_probe_file,
            ssh_read_file_range,
            ssh_write_text_file,
            ssh_rename_fs_entry,
            ssh_delete_fs_entry,
            ssh_download_file,
            ssh_upload_file,
            ssh_download_to_temp,
            system_health_stats,
            ssh_system_health_stats,
            load_recording,
            list_recordings,
            delete_recording,
            prepare_secure_storage,
            reset_secure_storage,
            list_ssh_hosts,
            apply_text_assets,
            set_tray_agent_count,
            set_tray_status,
            set_tray_recent_sessions,
            open_path_in_file_manager,
            open_path_in_vscode,
            get_app_info,
            start_fs_watcher,
            stop_fs_watcher,
            watch_directory,
            unwatch_directory,
            api_respond,
            api_notify_state_change,
            start_agent_prompt,
            stop_agent,
            get_agent_terminal_command,
            build_agent_task_command,
            write_agent_mcp_config,
            read_agent_session_output,
            orchestrate_ensure_dir,
            orchestrate_read_file,
            get_server_status,
            set_api_enabled,
            set_mcp_enabled,
            register_mcp_with_agents,
            browser::browser_open,
            browser::browser_set_bounds,
            browser::browser_hide,
            browser::browser_navigate,
            browser::browser_action,
            browser::browser_capture_screenshot,
            browser::open_screen_recording_settings,
            browser::browser_close
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                tauri::RunEvent::Exit => {
                    // Flush recording buffers and kill PTY children before the
                    // process exits — destructors won't run for managed state.
                    {
                        use tauri::Manager;
                        pty::shutdown_flush_all(&app.state::<pty::AppState>());
                    }
                    api_discovery::cleanup();
                }
                tauri::RunEvent::Resumed { .. } => {
                    // emit_to by label, not get_webview_window("main"): a browser
                    // child webview makes the main window stop being a
                    // WebviewWindow, which would make get_webview_window return None.
                    let _ = app.emit_to("main", "system-resumed", ());
                }
                _ => {}
            }
        });
}
