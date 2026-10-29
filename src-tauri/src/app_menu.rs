use tauri::menu::{
    AboutMetadata, IsMenuItem, Menu, MenuEvent, MenuItemBuilder, MenuItemKind,
    PredefinedMenuItem, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
#[cfg(target_os = "macos")]
use tauri::menu::Submenu;
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub const MENU_ID_CHECK_UPDATES: &str = "help-check-updates";
pub const MENU_ID_SELECT_ALL: &str = "edit-select-all";
pub const MENU_ID_TOGGLE_TERMINAL_SEARCH: &str = "window-toggle-terminal-search";
pub const MENU_ID_RECOVER_DISPLAY: &str = "window-recover-display";
pub const MENU_ID_CLOSE_TAB: &str = "window-close-tab";
pub const MENU_ID_CLOSE_WINDOW: &str = "window-close-window";
pub const MENU_ID_QUIT: &str = "app-quit";
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
    #[cfg(target_os = "macos")]
    let recover_display_item =
        MenuItemBuilder::with_id(MENU_ID_RECOVER_DISPLAY, "Recover Display")
            .accelerator("CmdOrCtrl+Alt+R")
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
                // Build number (CFBundleVersion) of internal builds, shown by
                // the About panel as "Version 0.12.0 (3)".
                short_version: config.bundle.macos.bundle_version.clone(),
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
        #[cfg(target_os = "macos")]
        {
            window_menu.insert(&recover_display_item, 1)?;
            window_menu.insert(&window_separator, 2)?;
        }
        #[cfg(not(target_os = "macos"))]
        window_menu.insert(&window_separator, 1)?;
    }
    replace_default_select_all(&menu, &select_all_item)?;
    #[cfg(target_os = "macos")]
    replace_default_close_and_quit(app, &menu)?;

    Ok(menu)
}

/// The default macOS menu binds ⌘W to Close Window, which closed the whole app
/// whenever the page left ⌘W unhandled. ⌘W becomes Close Tab (the page decides
/// what that closes, never the window) and Close Window moves to ⇧⌘W, as in
/// Terminal.app. Quit becomes a custom item so it can ask first (quit.rs); the
/// default one sends AppKit's terminate:, which exits without asking.
#[cfg(target_os = "macos")]
fn replace_default_close_and_quit<R: Runtime>(app: &AppHandle<R>, menu: &Menu<R>) -> tauri::Result<()> {
    let close_tab_item = MenuItemBuilder::with_id(MENU_ID_CLOSE_TAB, "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let close_window_item = MenuItemBuilder::with_id(MENU_ID_CLOSE_WINDOW, "Close Window")
        .accelerator("CmdOrCtrl+Shift+W")
        .build(app)?;
    // Close Window appears in both the File and the Window menu; the new items
    // replace the first and the other one goes.
    let mut replaced = false;
    while let Some((submenu, index, _)) = find_predefined_item(menu, |text| text == "Close Window")? {
        submenu.remove_at(index)?;
        if !replaced {
            submenu.insert_items(&[&close_tab_item, &close_window_item], index)?;
            replaced = true;
        }
    }

    if let Some((submenu, index, text)) = find_predefined_item(menu, |text| text.starts_with("Quit"))? {
        let quit_item = MenuItemBuilder::with_id(MENU_ID_QUIT, text)
            .accelerator("CmdOrCtrl+Q")
            .build(app)?;
        submenu.remove_at(index)?;
        submenu.insert(&quit_item, index)?;
    }
    Ok(())
}

/// Close Tab with another window in front (e.g. the About panel) closes that
/// window, as the default Close Window item did. Returns true when the main
/// window is in front: its page decides what to close, since a browser tab's
/// webview may have focus. With no window in front nothing happens.
#[cfg(target_os = "macos")]
fn main_window_is_key_or_close_key_window(app: &AppHandle) -> bool {
    use objc2::{rc::Retained, MainThreadMarker};
    use objc2_app_kit::NSApplication;

    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    let Some(key_window) = NSApplication::sharedApplication(mtm).keyWindow() else {
        return false;
    };
    let main_ns_window = app.get_window("main").and_then(|window| window.ns_window().ok());
    if main_ns_window == Some(Retained::as_ptr(&key_window) as *mut std::ffi::c_void) {
        return true;
    }
    key_window.performClose(None);
    false
}

/// Finds a predefined item in a top-level submenu by its label (without `&`
/// mnemonics): (submenu, index, label).
#[cfg(target_os = "macos")]
fn find_predefined_item<R: Runtime>(
    menu: &Menu<R>,
    matches: impl Fn(&str) -> bool,
) -> tauri::Result<Option<(Submenu<R>, usize, String)>> {
    for item in menu.items()? {
        let MenuItemKind::Submenu(submenu) = item else {
            continue;
        };
        let found = submenu.items()?.iter().enumerate().find_map(|(index, item)| match item {
            MenuItemKind::Predefined(predefined) => predefined
                .text()
                .ok()
                .map(|text| text.replace('&', ""))
                .filter(|text| matches(text))
                .map(|text| (index, text)),
            _ => None,
        });
        if let Some((index, text)) = found {
            return Ok(Some((submenu, index, text)));
        }
    }
    Ok(None)
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

pub fn handle_app_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    if id == MENU_ID_RECOVER_DISPLAY {
        crate::display_recovery::request_recovery(app, "native-app-menu");
        return;
    }
    if id == MENU_ID_CLOSE_WINDOW {
        // CloseRequested then hides it (see quit::on_main_window_close).
        if let Some(window) = app.get_window("main") {
            let _ = window.close();
        }
        return;
    }
    if id == MENU_ID_QUIT {
        app.exit(0);
        return;
    }
    #[cfg(target_os = "macos")]
    if id == MENU_ID_CLOSE_TAB && !main_window_is_key_or_close_key_window(app) {
        return;
    }
    if id == MENU_ID_CHECK_UPDATES
        || id == MENU_ID_SELECT_ALL
        || id == MENU_ID_TOGGLE_TERMINAL_SEARCH
        || id == MENU_ID_CLOSE_TAB
    {
        let _ = app.emit(
            EVENT_APP_MENU,
            AppMenuEventPayload {
                id: id.to_string(),
            },
        );
    }
}
