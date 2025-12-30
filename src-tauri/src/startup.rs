use serde::Serialize;
use std::fs;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StartupFlags {
    pub clear_data: bool,
}

static FLAGS: OnceLock<StartupFlags> = OnceLock::new();

pub fn init_startup_flags() {
    let clear_data = std::env::args().any(|arg| arg == "--clear-data");
    let _ = FLAGS.set(StartupFlags { clear_data });
}

fn flags() -> StartupFlags {
    FLAGS
        .get()
        .cloned()
        .unwrap_or(StartupFlags { clear_data: false })
}

#[tauri::command]
pub fn get_startup_flags() -> StartupFlags {
    flags()
}

pub fn clear_app_data_if_requested(app: &AppHandle) -> Result<(), String> {
    if !flags().clear_data {
        return Ok(());
    }

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "unknown app data dir".to_string())?;

    if dir.as_os_str().is_empty() {
        return Err("invalid app data dir".to_string());
    }

    let state = dir.join("state-v1.json");
    let tmp = dir.join("state-v1.json.tmp");
    let recordings = dir.join("recordings");

    match fs::remove_file(&tmp) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("delete failed: {e}")),
    }

    match fs::remove_file(&state) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("delete failed: {e}")),
    }

    match fs::remove_dir_all(&recordings) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("delete failed: {e}")),
    }

    Ok(())
}
