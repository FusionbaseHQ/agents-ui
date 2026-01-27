use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{include_image, AppHandle, Emitter, Manager, State};

const RECENT_LIMIT: usize = 10;

pub struct StatusTrayState {
    tray: Option<TrayIcon>,
    recent_items: Vec<MenuItem<tauri::Wry>>,
    recent_targets: Mutex<Vec<Option<TrayRecentTarget>>>,
    working_item: Option<MenuItem<tauri::Wry>>,
    sessions_item: Option<MenuItem<tauri::Wry>>,
    project_item: Option<MenuItem<tauri::Wry>>,
    session_item: Option<MenuItem<tauri::Wry>>,
    recording_item: Option<MenuItem<tauri::Wry>>,
}

const TRAY_ICON: tauri::image::Image<'_> = include_image!("./icons/tray.png");
const EVENT_TRAY_MENU: &str = "tray-menu";

#[derive(Clone)]
struct TrayRecentTarget {
    project_id: String,
    persist_id: String,
}

#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrayRecentSessionInput {
    pub label: String,
    pub project_id: String,
    pub persist_id: String,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TrayMenuEventPayload {
    id: String,
    effect_id: Option<String>,
    project_id: Option<String>,
    persist_id: Option<String>,
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

fn on_tray_click(_tray: &TrayIcon, event: TrayIconEvent) {
    let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Down,
        ..
    } = event
    else {
        return;
    };

    #[cfg(not(target_os = "macos"))]
    {
        show_main_window(_tray.app_handle());
    }
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
                    project_id: None,
                    persist_id: None,
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
                    project_id: None,
                    persist_id: None,
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
                    project_id: None,
                    persist_id: None,
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
                    project_id: None,
                    persist_id: None,
                },
            );
        }
        id if id.starts_with("tray-recent-") => {
            let index = id
                .strip_prefix("tray-recent-")
                .and_then(|raw| raw.parse::<usize>().ok());
            let Some(index) = index else {
                return;
            };

            let state = app.state::<StatusTrayState>();
            let target = match state.recent_targets.lock() {
                Ok(targets) => targets.get(index).and_then(|t| t.clone()),
                Err(_) => None,
            };
            let Some(target) = target else {
                return;
            };

            show_main_window(app);
            let _ = app.emit(
                EVENT_TRAY_MENU,
                TrayMenuEventPayload {
                    id: "recent-session".to_string(),
                    effect_id: None,
                    project_id: Some(target.project_id),
                    persist_id: Some(target.persist_id),
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
            recent_items: Vec::new(),
            recent_targets: Mutex::new(vec![None; RECENT_LIMIT]),
            working_item: None,
            sessions_item: None,
            project_item: None,
            session_item: None,
            recording_item: None,
        }
    }

    fn set_recent_sessions(&self, sessions: Vec<TrayRecentSessionInput>) -> Result<(), String> {
        if self.recent_items.is_empty() {
            return Ok(());
        }

        let mut targets: Vec<Option<TrayRecentTarget>> = Vec::with_capacity(RECENT_LIMIT);
        for (index, item) in self.recent_items.iter().enumerate() {
            let input = sessions.get(index);
            if let Some(input) = input {
                let label = input.label.trim();
                let project_id = input.project_id.trim();
                let persist_id = input.persist_id.trim();
                if !label.is_empty() && !project_id.is_empty() && !persist_id.is_empty() {
                    item.set_text(label.to_string())
                        .map_err(|e| e.to_string())?;
                    item.set_enabled(true).map_err(|e| e.to_string())?;
                    targets.push(Some(TrayRecentTarget {
                        project_id: project_id.to_string(),
                        persist_id: persist_id.to_string(),
                    }));
                    continue;
                }
            }

            item.set_text("—".to_string()).map_err(|e| e.to_string())?;
            item.set_enabled(false).map_err(|e| e.to_string())?;
            targets.push(None);
        }

        let mut state = self.recent_targets.lock().map_err(|_| "state poisoned")?;
        *state = targets;
        Ok(())
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
            // `None` is a no-op in Tauri, so it won't clear an existing title.
            // Use an empty string to explicitly remove the count when idle.
            let title = if working_count == 0 {
                Some(String::new())
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

    let recent_header_item = MenuItemBuilder::with_id("tray-recent-header", "Recent sessions")
        .enabled(false)
        .build(app)
        .map_err(|e| e.to_string())?;
    let mut recent_items: Vec<MenuItem<tauri::Wry>> = Vec::with_capacity(RECENT_LIMIT);
    for i in 0..RECENT_LIMIT {
        let item = MenuItemBuilder::with_id(format!("tray-recent-{i}"), "—")
            .enabled(false)
            .build(app)
            .map_err(|e| e.to_string())?;
        recent_items.push(item);
    }

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

    let mut menu_builder = MenuBuilder::new(app)
        .item(&open_item)
        .item(&new_terminal_item)
        .separator()
        .item(&recent_header_item);

    for item in &recent_items {
        menu_builder = menu_builder.item(item);
    }

    let menu = menu_builder
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
        tray_builder = tray_builder.icon_as_template(true).show_menu_on_left_click(true);
    }

    let tray = tray_builder.build(app).map_err(|e| e.to_string())?;

    Ok(StatusTrayState {
        tray: Some(tray),
        recent_items,
        recent_targets: Mutex::new(vec![None; RECENT_LIMIT]),
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

#[tauri::command]
pub fn set_tray_recent_sessions(
    state: State<'_, StatusTrayState>,
    sessions: Vec<TrayRecentSessionInput>,
) -> Result<(), String> {
    state.set_recent_sessions(sessions)
}
