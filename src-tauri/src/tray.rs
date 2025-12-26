use tauri::menu::{MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State};

pub struct StatusTrayState {
    tray: TrayIcon,
    count_item: MenuItem<tauri::Wry>,
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
        "tray-quit" => app.exit(0),
        _ => {}
    }
}

impl StatusTrayState {
    fn set_agent_count(&self, count: u32) -> Result<(), String> {
        self.count_item
            .set_text(format!("Active agents: {count}"))
            .map_err(|e| e.to_string())?;

        let tooltip = format!("Agents UI — {count} active");
        let _ = self.tray.set_tooltip(Some(tooltip));

        #[cfg(not(windows))]
        {
            let title = if count == 0 {
                None
            } else {
                Some(count.to_string())
            };
            let _ = self.tray.set_title(title);
        }

        Ok(())
    }
}

pub fn build_status_tray(app: &AppHandle) -> Result<StatusTrayState, String> {
    let open_item = MenuItemBuilder::with_id("tray-open", "Open Agents UI")
        .build(app)
        .map_err(|e| e.to_string())?;
    let count_item = MenuItemBuilder::with_id("tray-count", "Active agents: 0")
        .enabled(false)
        .build(app)
        .map_err(|e| e.to_string())?;
    let quit_item = MenuItemBuilder::with_id("tray-quit", "Quit")
        .build(app)
        .map_err(|e| e.to_string())?;

    let menu = MenuBuilder::new(app)
        .item(&open_item)
        .separator()
        .item(&count_item)
        .separator()
        .item(&quit_item)
        .build()
        .map_err(|e| e.to_string())?;

    let mut tray_builder = TrayIconBuilder::with_id("agents-ui-tray")
        .tooltip("Agents UI")
        .menu(&menu)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(|tray, event| on_tray_click(tray, event))
        .show_menu_on_left_click(false);

    if let Some(icon) = app.default_window_icon().cloned() {
        tray_builder = tray_builder.icon(icon);
    }

    #[cfg(target_os = "macos")]
    {
        tray_builder = tray_builder.icon_as_template(true);
    }

    let tray = tray_builder.build(app).map_err(|e| e.to_string())?;

    Ok(StatusTrayState { tray, count_item })
}

#[tauri::command]
pub fn set_tray_agent_count(state: State<'_, StatusTrayState>, count: u32) -> Result<(), String> {
    state.set_agent_count(count)
}
