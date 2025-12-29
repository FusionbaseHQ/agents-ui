use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{Manager, WebviewWindow};

use crate::secure::{decrypt_string_with_key, encrypt_string_with_key, get_or_create_master_key, SecretContext};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PersistedProjectV1 {
    pub id: String,
    pub title: String,
    pub base_path: Option<String>,
    pub environment_id: Option<String>,
    pub assets_enabled: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSessionV1 {
    pub persist_id: String,
    pub project_id: String,
    pub name: String,
    pub launch_command: Option<String>,
    pub restore_command: Option<String>,
    pub last_recording_id: Option<String>,
    pub cwd: Option<String>,
    pub persistent: Option<bool>,
    pub created_at: u64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PersistedPromptV1 {
    pub id: String,
    pub title: String,
    pub content: String,
    pub created_at: u64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PersistedEnvironmentV1 {
    pub id: String,
    pub name: String,
    pub content: String,
    pub created_at: u64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PersistedAssetV1 {
    pub id: String,
    pub name: String,
    pub relative_path: String,
    pub content: String,
    pub created_at: u64,
    pub auto_apply: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PersistedAssetSettingsV1 {
    pub auto_apply_enabled: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PersistedStateV1 {
    pub schema_version: u32,
    pub projects: Vec<PersistedProjectV1>,
    pub active_project_id: String,
    pub sessions: Vec<PersistedSessionV1>,
    pub active_session_by_project: HashMap<String, String>,
    #[serde(default)]
    pub prompts: Vec<PersistedPromptV1>,
    #[serde(default)]
    pub environments: Vec<PersistedEnvironmentV1>,
    #[serde(default)]
    pub assets: Vec<PersistedAssetV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_shortcut_ids: Option<Vec<String>>,
    pub asset_settings: Option<PersistedAssetSettingsV1>,
}

fn state_file_path(window: &WebviewWindow) -> Result<PathBuf, String> {
    let dir = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|_| "unknown app data dir".to_string())?;
    Ok(dir.join("state-v1.json"))
}

fn expand_home(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed == "~" {
        return home_dir().unwrap_or_else(|| trimmed.to_string());
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        if let Some(home) = home_dir() {
            return Path::new(&home).join(rest).to_string_lossy().to_string();
        }
    }
    trimmed.to_string()
}

fn home_dir() -> Option<String> {
    #[cfg(target_family = "unix")]
    {
        std::env::var("HOME").ok()
    }
    #[cfg(not(target_family = "unix"))]
    {
        std::env::var("USERPROFILE").ok()
    }
}

#[tauri::command]
pub fn load_persisted_state(window: WebviewWindow) -> Result<Option<PersistedStateV1>, String> {
    let path = state_file_path(&window)?;
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read failed: {e}")),
    };

    let mut state: PersistedStateV1 = serde_json::from_str(&raw).map_err(|e| format!("parse failed: {e}"))?;
    if state.schema_version != 1 {
        return Ok(None);
    }

    let needs_decrypt = state
        .environments
        .iter()
        .any(|env| crate::secure::is_encrypted_value(&env.content));
    if needs_decrypt {
        let key = get_or_create_master_key(&window)?;
        for env in &mut state.environments {
            if crate::secure::is_encrypted_value(&env.content) {
                env.content = decrypt_string_with_key(&key, SecretContext::State, &env.content)?;
            }
        }
    }
    Ok(Some(state))
}

#[tauri::command]
pub fn save_persisted_state(window: WebviewWindow, state: PersistedStateV1) -> Result<(), String> {
    if state.schema_version != 1 {
        return Err("unsupported schema version".to_string());
    }

    let path = state_file_path(&window)?;
    let dir = path.parent().ok_or("invalid state path")?;
    fs::create_dir_all(dir).map_err(|e| format!("create dir failed: {e}"))?;

    let tmp = path.with_extension("json.tmp");
    let mut state = state;
    if !state.environments.is_empty() {
        let key = get_or_create_master_key(&window)?;
        for env in &mut state.environments {
            env.content = encrypt_string_with_key(&key, SecretContext::State, &env.content)?;
        }
    }

    let json = serde_json::to_string_pretty(&state).map_err(|e| format!("serialize failed: {e}"))?;

    let mut file = fs::File::create(&tmp).map_err(|e| format!("write temp failed: {e}"))?;
    file.write_all(json.as_bytes())
        .map_err(|e| format!("write temp failed: {e}"))?;
    file.write_all(b"\n")
        .map_err(|e| format!("write temp failed: {e}"))?;
    file.sync_all().ok();
    drop(file);

    fs::rename(&tmp, &path).map_err(|e| format!("rename failed: {e}"))?;

    // Best-effort: ensure the directory entry for the rename is durable.
    let _ = fs::File::open(dir).and_then(|dir_handle| dir_handle.sync_all());
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<DirectoryEntry>,
}

#[tauri::command]
pub fn validate_directory(path: String) -> Result<Option<String>, String> {
    let expanded = expand_home(&path);
    if expanded.trim().is_empty() {
        return Ok(None);
    }
    let p = Path::new(&expanded);
    if p.is_dir() {
        return Ok(Some(expanded));
    }
    Ok(None)
}

#[tauri::command]
pub fn list_directories(path: Option<String>) -> Result<DirectoryListing, String> {
    let desired = path
        .as_deref()
        .map(expand_home)
        .filter(|s| !s.trim().is_empty())
        .or_else(|| home_dir())
        .ok_or("no path")?;

    let dir = PathBuf::from(&desired);
    if !dir.is_dir() {
        return Err("not a directory".to_string());
    }

    let mut entries: Vec<DirectoryEntry> = Vec::new();
    let read_dir = fs::read_dir(&dir).map_err(|e| format!("read dir failed: {e}"))?;
    for item in read_dir {
        let item = match item {
            Ok(i) => i,
            Err(_) => continue,
        };
        let path = item.path();
        let is_dir = fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false);
        if !is_dir {
            continue;
        }
        let name = item
            .file_name()
            .to_string_lossy()
            .to_string();
        entries.push(DirectoryEntry {
            name,
            path: path.to_string_lossy().to_string(),
        });
    }

    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    let parent = dir
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .filter(|p| p != &dir.to_string_lossy());

    Ok(DirectoryListing {
        path: dir.to_string_lossy().to_string(),
        parent,
        entries,
    })
}
