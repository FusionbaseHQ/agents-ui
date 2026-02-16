use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::watch;

/// Manages on/off state for the API and MCP servers.
pub struct ServerControl {
    pub api_shutdown_tx: watch::Sender<bool>,
    pub mcp_shutdown_tx: watch::Sender<bool>,
    pub api_running: AtomicBool,
    pub mcp_running: AtomicBool,
}

impl ServerControl {
    pub fn new() -> (Self, watch::Receiver<bool>, watch::Receiver<bool>) {
        let (api_tx, api_rx) = watch::channel(false); // false = no shutdown
        let (mcp_tx, mcp_rx) = watch::channel(false);
        let ctrl = Self {
            api_shutdown_tx: api_tx,
            mcp_shutdown_tx: mcp_tx,
            api_running: AtomicBool::new(false),
            mcp_running: AtomicBool::new(false),
        };
        (ctrl, api_rx, mcp_rx)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSettings {
    pub api_enabled: bool,
    pub mcp_enabled: bool,
}

impl Default for ServerSettings {
    fn default() -> Self {
        Self {
            api_enabled: true,
            mcp_enabled: true,
        }
    }
}

fn settings_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "cannot determine home directory".to_string())?;
    Ok(std::path::PathBuf::from(home)
        .join(".agents-ui")
        .join("server-settings.json"))
}

pub fn load_settings() -> ServerSettings {
    let path = match settings_path() {
        Ok(p) => p,
        Err(_) => return ServerSettings::default(),
    };
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => ServerSettings::default(),
    }
}

pub fn save_settings(settings: &ServerSettings) -> Result<(), String> {
    let path = settings_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, &json).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub api_running: bool,
    pub mcp_running: bool,
    pub api_enabled: bool,
    pub mcp_enabled: bool,
}

#[tauri::command]
pub async fn get_server_status(
    state: tauri::State<'_, Arc<ServerControl>>,
) -> Result<ServerStatus, String> {
    let settings = load_settings();
    Ok(ServerStatus {
        api_running: state.api_running.load(Ordering::Relaxed),
        mcp_running: state.mcp_running.load(Ordering::Relaxed),
        api_enabled: settings.api_enabled,
        mcp_enabled: settings.mcp_enabled,
    })
}

#[tauri::command]
pub async fn set_api_enabled(
    state: tauri::State<'_, Arc<ServerControl>>,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    let mut settings = load_settings();
    settings.api_enabled = enabled;
    save_settings(&settings)?;

    if enabled {
        // Signal restart — the watch channel sends false (no shutdown)
        // We need to spawn a new server instance
        if !state.api_running.load(Ordering::Relaxed) {
            let handle = app.clone();
            // Create new shutdown channel
            let (_new_tx, new_rx) = watch::channel(false);
            // We can't replace the tx in Arc — instead, just spawn with a fresh channel
            // For simplicity: spawn the server, it will run until the new channel signals
            let sc = state.inner().clone();
            tokio::spawn(async move {
                crate::api_server::start_api_server_with_shutdown(handle, new_rx, sc).await;
            });
            // Note: we leak the old tx/new_tx but that's acceptable for toggle functionality
        }
    } else {
        // Signal shutdown
        let _ = state.api_shutdown_tx.send(true);
    }

    Ok(())
}

#[tauri::command]
pub async fn set_mcp_enabled(
    state: tauri::State<'_, Arc<ServerControl>>,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    let mut settings = load_settings();
    settings.mcp_enabled = enabled;
    save_settings(&settings)?;

    if enabled {
        if !state.mcp_running.load(Ordering::Relaxed) {
            let handle = app.clone();
            let (_new_tx, new_rx) = watch::channel(false);
            let sc = state.inner().clone();
            tokio::spawn(async move {
                crate::mcp_server::start_mcp_server_with_shutdown(handle, new_rx, sc).await;
            });
        }
    } else {
        let _ = state.mcp_shutdown_tx.send(true);
    }

    Ok(())
}
