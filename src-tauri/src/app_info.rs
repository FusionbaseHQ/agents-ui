use serde::Serialize;
use tauri::AppHandle;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub homepage: Option<String>,
}

#[tauri::command]
pub fn get_app_info(app: AppHandle) -> AppInfo {
    let pkg = app.package_info();
    let config = app.config();

    AppInfo {
        name: pkg.name.clone(),
        version: pkg.version.to_string(),
        homepage: config.bundle.homepage.clone(),
    }
}

