use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, HELP_SUBMENU_ID};
use tauri::{AppHandle, Emitter, Runtime};

pub const MENU_ID_CHECK_UPDATES: &str = "help-check-updates";
pub const EVENT_APP_MENU: &str = "app-menu";

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AppMenuEventPayload {
    id: String,
}

pub fn build_app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;

    let check_updates_item =
        MenuItemBuilder::with_id(MENU_ID_CHECK_UPDATES, "Check for Updates…").build(app)?;
    let separator = PredefinedMenuItem::separator(app)?;

    if let Some(MenuItemKind::Submenu(help_menu)) = menu.get(HELP_SUBMENU_ID) {
        help_menu.insert(&check_updates_item, 0)?;
        help_menu.insert(&separator, 1)?;

        #[cfg(target_os = "macos")]
        {
            let pkg_info = app.package_info();
            let config = app.config();
            let about_metadata = AboutMetadata {
                name: Some(pkg_info.name.clone()),
                version: Some(pkg_info.version.to_string()),
                copyright: config.bundle.copyright.clone(),
                authors: config.bundle.publisher.clone().map(|p| vec![p]),
                ..Default::default()
            };
            let about_item = PredefinedMenuItem::about(app, None, Some(about_metadata))?;
            help_menu.append(&about_item)?;
        }
    }

    Ok(menu)
}

pub fn handle_app_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if event.id().as_ref() == MENU_ID_CHECK_UPDATES {
        let _ = app.emit(
            EVENT_APP_MENU,
            AppMenuEventPayload {
                id: MENU_ID_CHECK_UPDATES.to_string(),
            },
        );
    }
}
