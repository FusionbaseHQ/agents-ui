#[cfg(all(target_os = "macos", panic = "abort"))]
compile_error!(
    "macOS builds require panic=unwind so WebKit/AppKit callback containment remains effective"
);

mod agent;
mod api_bridge;
mod api_discovery;
mod api_handlers;
mod api_server;
mod api_types;
mod app_info;
mod app_menu;
mod assets;
mod browser;
mod display_recovery;
mod file_manager;
mod files;
mod fs_watcher;
mod mcp_server;
mod mcp_tools;
mod persist;
mod power_assertion;
mod pty;
mod recording;
mod secure;
mod server_control;
mod ssh;
mod ssh_fs;
mod startup;
mod system_stats;
mod tray;

use agent::{
    build_agent_task_command, get_agent_terminal_command, orchestrate_ensure_dir,
    orchestrate_read_file, read_agent_session_output, register_mcp_with_agents, start_agent_prompt,
    stop_agent, write_agent_mcp_config, AgentState,
};
use api_bridge::{api_notify_state_change, api_respond, ApiEventBus, ApiPendingRequests};
use app_info::get_app_info;
use app_menu::{build_app_menu, handle_app_menu_event};
use assets::apply_text_assets;
use file_manager::{open_path_in_file_manager, open_path_in_vscode};
use files::{
    copy_fs_entry, create_directory, create_file, delete_fs_entry, list_fs_entries, probe_file,
    read_file_range, read_text_file, rename_fs_entry, search_fs_entries, write_text_file,
};
use fs_watcher::{
    start_fs_watcher, stop_fs_watcher, unwatch_directory, watch_directory, FsWatcherState,
};
use mcp_tools::OutputBuffers;
use persist::{
    list_directories, load_persisted_state, load_persisted_state_meta, save_persisted_state,
    validate_directory,
};
use pty::{
    close_session, create_session, detach_session, detect_shells, kill_persistent_session,
    list_persistent_sessions, list_sessions, rename_session, renderer_listener_ready,
    renderer_listener_ticket, renderer_listener_unavailable, resize_session,
    start_session_recording, stop_session_recording, write_to_session, AppState,
};
use recording::{delete_recording, list_recordings, load_recording};
use secure::{prepare_secure_storage, reset_secure_storage};
use server_control::{get_server_status, set_api_enabled, set_mcp_enabled, ServerControl};
use ssh::list_ssh_hosts;
use ssh_fs::{
    ssh_create_directory, ssh_create_file, ssh_default_root, ssh_delete_fs_entry,
    ssh_download_file, ssh_download_to_temp, ssh_effective_user, ssh_list_fs_entries,
    ssh_probe_file, ssh_read_file_range, ssh_read_text_file, ssh_rename_fs_entry,
    ssh_search_fs_entries, ssh_upload_file, ssh_write_text_file,
};
use startup::get_startup_flags;
use std::sync::Arc;
use system_stats::{ssh_system_health_stats, system_health_stats};
use tauri::Manager;
use tray::{build_status_tray, set_tray_agent_count, set_tray_recent_sessions, set_tray_status};

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
        let mut lim = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
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

        let new = libc::rlimit {
            rlim_cur: target,
            rlim_max: lim.rlim_max,
        };
        if libc::setrlimit(libc::RLIMIT_NOFILE, &new) != 0 {
            eprintln!(
                "[fd-limit] setrlimit to {target} failed (current soft {}): {}",
                lim.rlim_cur,
                std::io::Error::last_os_error()
            );
        }
    }
}

#[tauri::command]
fn acknowledge_display_recovery_event(generation: u64) {
    display_recovery::acknowledge_recovery_event(generation);
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
    let builder = tauri::Builder::default()
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
        .on_menu_event(|app, event| handle_app_menu_event(app, event));

    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(|webview| {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if webview.label() == "main" {
                // Stop serializing PTY output into a dead JavaScript event queue.
                // Output remains available in bounded per-session replay buffers.
                pty::mark_renderer_unavailable();
                // Browser child views belong to the dead renderer's ephemeral
                // React state. Mark them terminal synchronously, then let the
                // browser worker hide/close them outside this WebKit callback.
                browser::handle_main_web_content_terminated(webview);
                display_recovery::handle_main_web_content_terminated(webview);
            } else {
                browser::handle_web_content_terminated(webview);
            }
        }));
        if result.is_err() {
            use std::io::Write as _;
            let _ = writeln!(
                std::io::stderr().lock(),
                "[web-content-recovery] Rust panic contained in process-termination callback"
            );
        }
    });

    builder
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
            renderer_listener_ticket,
            renderer_listener_ready,
            renderer_listener_unavailable,
            detect_shells,
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
            acknowledge_display_recovery_event,
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
                tauri::RunEvent::Resumed => {
                    // This is an event-loop lifecycle signal and can also mean a
                    // normal poll. The recovery module acts only if AppKit or
                    // CoreGraphics previously observed actual display sleep.
                    display_recovery::runtime_resumed(app);
                }
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::Focused(true),
                    ..
                } if label == "main" => {
                    // A wake recovery is deferred while the window is hidden or
                    // minimized. Consume it only once the window is presentable.
                    display_recovery::recover_if_pending(app, "main-window-focused");
                }
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    display_recovery::recover_if_pending(app, "application-reopened");
                }
                _ => {}
            }
        });
}
