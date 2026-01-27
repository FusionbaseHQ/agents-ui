use tauri::menu::{MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{include_image, AppHandle, Emitter, Manager, State};

pub struct StatusTrayState {
    tray: Option<TrayIcon>,
    working_item: Option<MenuItem<tauri::Wry>>,
    sessions_item: Option<MenuItem<tauri::Wry>>,
    project_item: Option<MenuItem<tauri::Wry>>,
    session_item: Option<MenuItem<tauri::Wry>>,
    recording_item: Option<MenuItem<tauri::Wry>>,
}

const TRAY_ICON: tauri::image::Image<'_> = include_image!("./icons/tray.png");
const EVENT_TRAY_MENU: &str = "tray-menu";

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TrayMenuEventPayload {
    id: String,
    effect_id: Option<String>,
}

fn show_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.show();
    }

    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn on_tray_click(tray: &TrayIcon, event: TrayIconEvent) {
    let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Down,
        ..
    } = event
    else {
        return;
    };

    show_main_window(tray.app_handle());
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "tray-open" => show_main_window(app),
        "tray-new-terminal" => {
            show_main_window(app);
            let _ = app.emit(
                EVENT_TRAY_MENU,
                TrayMenuEventPayload {
                    id: "new-terminal".to_string(),
                    effect_id: None,
                },
            );
        }
        "tray-start-codex" => {
            show_main_window(app);
            let _ = app.emit(
                EVENT_TRAY_MENU,
                TrayMenuEventPayload {
                    id: "start-agent".to_string(),
                    effect_id: Some("codex".to_string()),
                },
            );
        }
        "tray-start-claude" => {
            show_main_window(app);
            let _ = app.emit(
                EVENT_TRAY_MENU,
                TrayMenuEventPayload {
                    id: "start-agent".to_string(),
                    effect_id: Some("claude".to_string()),
                },
            );
        }
        "tray-start-gemini" => {
            show_main_window(app);
            let _ = app.emit(
                EVENT_TRAY_MENU,
                TrayMenuEventPayload {
                    id: "start-agent".to_string(),
                    effect_id: Some("gemini".to_string()),
                },
            );
        }
        "tray-quit" => app.exit(0),
        _ => {}
    }
}

impl StatusTrayState {
    pub fn disabled() -> Self {
        Self {
            tray: None,
            working_item: None,
            sessions_item: None,
            project_item: None,
            session_item: None,
            recording_item: None,
        }
    }

    fn set_status(
        &self,
        working_count: u32,
        sessions_open: u32,
        active_project: Option<String>,
        active_session: Option<String>,
        recording_count: u32,
    ) -> Result<(), String> {
        if let Some(project_item) = &self.project_item {
            let label = active_project
                .as_deref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .unwrap_or("—");
            project_item
                .set_text(format!("Project: {label}"))
                .map_err(|e| e.to_string())?;
        }

        if let Some(session_item) = &self.session_item {
            let label = active_session
                .as_deref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .unwrap_or("—");
            session_item
                .set_text(format!("Session: {label}"))
                .map_err(|e| e.to_string())?;
        }

        if let Some(sessions_item) = &self.sessions_item {
            sessions_item
                .set_text(format!("Sessions open: {sessions_open}"))
                .map_err(|e| e.to_string())?;
        }

        if let Some(recording_item) = &self.recording_item {
            recording_item
                .set_text(format!("Recordings active: {recording_count}"))
                .map_err(|e| e.to_string())?;
        }

        if let Some(working_item) = &self.working_item {
            working_item
                .set_text(format!("Agents working: {working_count}"))
                .map_err(|e| e.to_string())?;
        }

        let Some(tray) = &self.tray else {
            return Ok(());
        };

        #[cfg(not(windows))]
        {
            let title = if working_count == 0 {
                None
            } else {
                Some(working_count.to_string())
            };
            let _ = tray.set_title(title);
        }

        let tooltip = if working_count == 0 {
            format!("Agents UI — {sessions_open} sessions open")
        } else {
            format!(
                "Agents UI — {working_count} working • {sessions_open} sessions open"
            )
        };
        let _ = tray.set_tooltip(Some(tooltip));

        Ok(())
    }
}

pub fn build_status_tray(app: &AppHandle) -> Result<StatusTrayState, String> {
    let open_item = MenuItemBuilder::with_id("tray-open", "Open Agents UI")
        .build(app)
        .map_err(|e| e.to_string())?;
    let new_terminal_item = MenuItemBuilder::with_id("tray-new-terminal", "New terminal")
        .build(app)
        .map_err(|e| e.to_string())?;

    let start_codex_item = MenuItemBuilder::with_id("tray-start-codex", "Start codex")
        .build(app)
        .map_err(|e| e.to_string())?;
    let start_claude_item = MenuItemBuilder::with_id("tray-start-claude", "Start claude")
        .build(app)
        .map_err(|e| e.to_string())?;
    let start_gemini_item = MenuItemBuilder::with_id("tray-start-gemini", "Start gemini")
        .build(app)
        .map_err(|e| e.to_string())?;

    let project_item = MenuItemBuilder::with_id("tray-project", "Project: —")
        .enabled(false)
        .build(app)
        .map_err(|e| e.to_string())?;
    let session_item = MenuItemBuilder::with_id("tray-session", "Session: —")
        .enabled(false)
        .build(app)
        .map_err(|e| e.to_string())?;
    let sessions_item = MenuItemBuilder::with_id("tray-sessions", "Sessions open: 0")
        .enabled(false)
        .build(app)
        .map_err(|e| e.to_string())?;
    let recording_item = MenuItemBuilder::with_id("tray-recordings", "Recordings active: 0")
        .enabled(false)
        .build(app)
        .map_err(|e| e.to_string())?;
    let working_item = MenuItemBuilder::with_id("tray-working", "Agents working: 0")
        .enabled(false)
        .build(app)
        .map_err(|e| e.to_string())?;
    let quit_item = MenuItemBuilder::with_id("tray-quit", "Quit")
        .build(app)
        .map_err(|e| e.to_string())?;

    let menu = MenuBuilder::new(app)
        .item(&open_item)
        .item(&new_terminal_item)
        .separator()
        .item(&start_codex_item)
        .item(&start_claude_item)
        .item(&start_gemini_item)
        .separator()
        .item(&project_item)
        .item(&session_item)
        .item(&sessions_item)
        .item(&recording_item)
        .item(&working_item)
        .separator()
        .item(&quit_item)
        .build()
        .map_err(|e| e.to_string())?;

    let mut tray_builder = TrayIconBuilder::with_id("agents-ui-tray")
        .icon(TRAY_ICON)
        .tooltip("Agents UI")
        .menu(&menu)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(|tray, event| on_tray_click(tray, event))
        .show_menu_on_left_click(false);

    #[cfg(target_os = "macos")]
    {
        tray_builder = tray_builder.icon_as_template(true);
    }

    let tray = tray_builder.build(app).map_err(|e| e.to_string())?;

    Ok(StatusTrayState {
        tray: Some(tray),
        working_item: Some(working_item),
        sessions_item: Some(sessions_item),
        project_item: Some(project_item),
        session_item: Some(session_item),
        recording_item: Some(recording_item),
    })
}

#[tauri::command]
pub fn set_tray_agent_count(state: State<'_, StatusTrayState>, count: u32) -> Result<(), String> {
    state.set_status(count, 0, None, None, 0)
}

#[tauri::command]
pub fn set_tray_status(
    state: State<'_, StatusTrayState>,
    working_count: u32,
    sessions_open: u32,
    active_project: Option<String>,
    active_session: Option<String>,
    recording_count: u32,
) -> Result<(), String> {
    state.set_status(
        working_count,
        sessions_open,
        active_project,
        active_session,
        recording_count,
    )
}
