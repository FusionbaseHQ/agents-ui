use tauri::menu::{
    AboutMetadata, IsMenuItem, Menu, MenuEvent, MenuItemBuilder, MenuItemKind,
    PredefinedMenuItem, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Emitter, Runtime};

pub const MENU_ID_CHECK_UPDATES: &str = "help-check-updates";
pub const MENU_ID_SELECT_ALL: &str = "edit-select-all";
pub const MENU_ID_TOGGLE_TERMINAL_SEARCH: &str = "window-toggle-terminal-search";
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
    let select_all_item = MenuItemBuilder::with_id(MENU_ID_SELECT_ALL, "Select All")
        .accelerator("CmdOrCtrl+A")
        .build(app)?;
    let help_separator = PredefinedMenuItem::separator(app)?;
    let find_terminal_item = MenuItemBuilder::with_id(MENU_ID_TOGGLE_TERMINAL_SEARCH, "Find")
        .accelerator("CmdOrCtrl+F")
        .build(app)?;

    if let Some(MenuItemKind::Submenu(help_menu)) = menu.get(HELP_SUBMENU_ID) {
        help_menu.insert(&check_updates_item, 0)?;
        help_menu.insert(&help_separator, 1)?;

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
    if let Some(MenuItemKind::Submenu(window_menu)) = menu.get(WINDOW_SUBMENU_ID) {
        let window_separator = PredefinedMenuItem::separator(app)?;
        window_menu.insert(&find_terminal_item, 0)?;
        window_menu.insert(&window_separator, 1)?;
    }
    replace_default_select_all(&menu, &select_all_item)?;

    Ok(menu)
}

fn replace_default_select_all<R: Runtime>(
    menu: &Menu<R>,
    select_all_item: &dyn IsMenuItem<R>,
) -> tauri::Result<()> {
    let Some(MenuItemKind::Submenu(edit_menu)) =
        menu.items()?.into_iter().find(|item| match item {
            MenuItemKind::Submenu(submenu) => submenu.text().is_ok_and(|text| text == "Edit"),
            _ => false,
        })
    else {
        return Ok(());
    };

    let items = edit_menu.items()?;
    let Some(index) = items.iter().enumerate().find_map(|(index, item)| match item {
        MenuItemKind::Predefined(predefined) => predefined
            .text()
            .ok()
            .map(|text| text.replace('&', ""))
            .filter(|text| text == "Select All")
            .map(|_| index),
        _ => None,
    }) else {
        return Ok(());
    };

    edit_menu.remove_at(index)?;
    edit_menu.insert(select_all_item, index)?;
    Ok(())
}

pub fn handle_app_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    if id == MENU_ID_CHECK_UPDATES
        || id == MENU_ID_SELECT_ALL
        || id == MENU_ID_TOGGLE_TERMINAL_SEARCH
    {
        let _ = app.emit(
            EVENT_APP_MENU,
            AppMenuEventPayload {
                id: id.to_string(),
            },
        );
    }
}
