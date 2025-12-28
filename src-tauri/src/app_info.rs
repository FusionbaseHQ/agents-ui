use serde::Serialize;
use tauri::{Manager, WebviewWindow};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub homepage: Option<String>,
}

#[tauri::command]
pub fn get_app_info(window: WebviewWindow) -> AppInfo {
    let app = window.app_handle();
    let pkg = app.package_info();
    let config = app.config();

    AppInfo {
        name: pkg.name.clone(),
        version: pkg.version.to_string(),
        homepage: config.bundle.homepage.clone(),
    }
}

