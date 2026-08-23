use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::{AppHandle, Manager};

use crate::secure::{decrypt_string_with_key, encrypt_string_with_key, get_or_create_master_key, SecretContext};

#[derive(Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum SecureStorageModeV1 {
    Keychain,
    Plaintext,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PersistedShellChoiceV1 {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PersistedProjectV1 {
    pub id: String,
    pub title: String,
    pub base_path: Option<String>,
    pub environment_id: Option<String>,
    pub assets_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_remote_path: Option<String>,
    /// Per-project default shell. Absent ⇒ bundled Nushell (the app default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_shell: Option<PersistedShellChoiceV1>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSessionV1 {
    pub persist_id: String,
    pub project_id: String,
    pub name: String,
    pub launch_command: Option<String>,
    pub restore_command: Option<String>,
    pub ssh_target: Option<String>,
    pub ssh_root_dir: Option<String>,
    pub last_recording_id: Option<String>,
    pub cwd: Option<String>,
    pub persistent: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidebar_order: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub created_at: u64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PersistedPromptV1 {
    pub id: String,
    pub title: String,
    pub content: String,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin_order: Option<u64>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secure_storage_mode: Option<SecureStorageModeV1>,
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

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PersistedStateMetaV1 {
    pub schema_version: u32,
    pub environment_count: usize,
    pub encrypted_environment_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secure_storage_mode: Option<SecureStorageModeV1>,
}

fn state_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "unknown app data dir".to_string())?;
    Ok(dir.join("state-v1.json"))
}

#[tauri::command]
pub fn load_persisted_state_meta(app: AppHandle) -> Result<Option<PersistedStateMetaV1>, String> {
    let path = state_file_path(&app)?;
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read failed: {e}")),
    };

    let state: PersistedStateV1 = serde_json::from_str(&raw).map_err(|e| format!("parse failed: {e}"))?;
    if state.schema_version != 1 {
        return Ok(None);
    }

    let environment_count = state.environments.len();
    let encrypted_environment_count = state
        .environments
        .iter()
        .filter(|env| crate::secure::is_probably_encrypted_value(&env.content))
        .count();

    Ok(Some(PersistedStateMetaV1 {
        schema_version: state.schema_version,
        environment_count,
        encrypted_environment_count,
        secure_storage_mode: state.secure_storage_mode,
    }))
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
pub fn load_persisted_state(app: AppHandle) -> Result<Option<PersistedStateV1>, String> {
    let path = state_file_path(&app)?;
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read failed: {e}")),
    };

    let mut state: PersistedStateV1 = serde_json::from_str(&raw).map_err(|e| format!("parse failed: {e}"))?;
    if state.schema_version != 1 {
        return Ok(None);
    }

    let decrypt_allowed = matches!(state.secure_storage_mode, Some(SecureStorageModeV1::Keychain));
    let needs_decrypt = decrypt_allowed
        && state
            .environments
            .iter()
            .any(|env| crate::secure::is_probably_encrypted_value(&env.content));
    if needs_decrypt {
        let key = match get_or_create_master_key(&app) {
            Ok(key) => Some(key),
            Err(e) => {
                eprintln!("Failed to read master key; leaving environments encrypted: {e}");
                None
            }
        };
        for env in &mut state.environments {
            if !crate::secure::is_probably_encrypted_value(&env.content) {
                continue;
            }
            let Some(key) = key.as_ref() else {
                continue;
            };
            match decrypt_string_with_key(key, SecretContext::State, &env.content) {
                Ok(plaintext) => env.content = plaintext,
                Err(e) => {
                    // Don't fail the full state load; preserve the encrypted value so the user can
                    // potentially recover it later if Keychain access is restored.
                    eprintln!("Failed to decrypt environment {}; leaving encrypted: {e}", env.id);
                }
            }
        }
    }
    Ok(Some(state))
}

#[tauri::command]
pub fn save_persisted_state(app: AppHandle, state: PersistedStateV1) -> Result<(), String> {
    if state.schema_version != 1 {
        return Err("unsupported schema version".to_string());
    }

    let path = state_file_path(&app)?;
    let dir = path.parent().ok_or("invalid state path")?;
    fs::create_dir_all(dir).map_err(|e| format!("create dir failed: {e}"))?;

    let tmp = path.with_extension("json.tmp");
    let mut state = state;
    let encrypt_allowed = matches!(state.secure_storage_mode, Some(SecureStorageModeV1::Keychain));
    if encrypt_allowed && !state.environments.is_empty() {
        let key = get_or_create_master_key(&app)?;
        for env in &mut state.environments {
            if crate::secure::is_probably_encrypted_value(&env.content) {
                continue;
            }
            env.content = encrypt_string_with_key(&key, SecretContext::State, &env.content)?;
        }
    }

    let json = serde_json::to_string(&state).map_err(|e| format!("serialize failed: {e}"))?;

    let write_result = (|| -> Result<(), String> {
        let mut file = fs::File::create(&tmp).map_err(|e| format!("write temp failed: {e}"))?;
        file.write_all(json.as_bytes())
            .map_err(|e| format!("write temp failed: {e}"))?;
        file.write_all(b"\n")
            .map_err(|e| format!("write temp failed: {e}"))?;
        file.sync_all().ok();
        drop(file);

        fs::rename(&tmp, &path).map_err(|e| format!("rename failed: {e}"))?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    write_result?;

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
    pub truncated: bool,
}

const MAX_DIRECTORY_PICKER_ENTRIES: usize = 500;
const MAX_DIRECTORY_PICKER_SCAN_ENTRIES: usize = 5_000;
const MAX_CONCURRENT_DIRECTORY_LISTINGS: usize = 4;
static ACTIVE_DIRECTORY_LISTINGS: AtomicUsize = AtomicUsize::new(0);

struct DirectoryListingPermit;

impl Drop for DirectoryListingPermit {
    fn drop(&mut self) {
        ACTIVE_DIRECTORY_LISTINGS.fetch_sub(1, Ordering::AcqRel);
    }
}

fn acquire_directory_listing_permit() -> Result<DirectoryListingPermit, String> {
    ACTIVE_DIRECTORY_LISTINGS
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
            (active < MAX_CONCURRENT_DIRECTORY_LISTINGS).then_some(active + 1)
        })
        .map(|_| DirectoryListingPermit)
        .map_err(|_| "too many local folder listings are already running".to_string())
}

#[tauri::command]
pub async fn validate_directory(path: String) -> Result<Option<String>, String> {
    let permit = acquire_directory_listing_permit()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        validate_directory_sync(path)
    })
    .await
    .map_err(|error| format!("local folder validation task failed: {error}"))?
}

fn validate_directory_sync(path: String) -> Result<Option<String>, String> {
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
pub async fn list_directories(path: Option<String>) -> Result<DirectoryListing, String> {
    // Local/network-backed directory enumeration can block inside the OS for
    // seconds. Keep it off Tauri's command/event thread, and cap outstanding
    // jobs so repeatedly closing/reopening a stalled picker cannot exhaust the
    // blocking pool.
    let permit = acquire_directory_listing_permit()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        list_directories_sync(path)
    })
    .await
    .map_err(|error| format!("local folder listing task failed: {error}"))?
}

fn list_directories_sync(path: Option<String>) -> Result<DirectoryListing, String> {
    list_directories_sync_with_limits(
        path,
        MAX_DIRECTORY_PICKER_ENTRIES,
        MAX_DIRECTORY_PICKER_SCAN_ENTRIES,
    )
}

fn list_directories_sync_with_limits(
    path: Option<String>,
    max_entries: usize,
    max_scanned_entries: usize,
) -> Result<DirectoryListing, String> {
    let desired = path
        .as_deref()
        .map(expand_home)
        .filter(|s| !s.trim().is_empty())
        .or_else(home_dir)
        .ok_or("no path")?;

    let dir = PathBuf::from(&desired);
    if !dir.is_dir() {
        return Err("not a directory".to_string());
    }

    let mut entries: Vec<DirectoryEntry> = Vec::new();
    let mut truncated = false;
    let read_dir = fs::read_dir(&dir).map_err(|e| format!("read dir failed: {e}"))?;
    for (index, item) in read_dir.enumerate() {
        if index >= max_scanned_entries {
            truncated = true;
            break;
        }
        let item = match item {
            Ok(i) => i,
            Err(_) => continue,
        };
        let path = item.path();
        let is_dir = item
            .file_type()
            .map(|file_type| file_type.is_dir() || (file_type.is_symlink() && path.is_dir()))
            .unwrap_or(false);
        if !is_dir {
            continue;
        }
        if entries.len() >= max_entries {
            truncated = true;
            break;
        }
        let name = item.file_name().to_string_lossy().to_string();
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
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::{list_directories_sync_with_limits, PersistedStateV1};
    use serde_json::{json, Value};

    fn round_trip(value: Value) -> Value {
        let state: PersistedStateV1 =
            serde_json::from_value(value).expect("state should deserialize");
        serde_json::to_value(state).expect("state should serialize")
    }

    #[test]
    fn directory_picker_listing_is_bounded_and_reports_truncation() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "agents-ui-picker-limit-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("create picker test root");
        for index in 0..8 {
            std::fs::create_dir(root.join(format!("folder-{index}")))
                .expect("create picker test folder");
        }

        let listing =
            list_directories_sync_with_limits(Some(root.to_string_lossy().to_string()), 3, 64)
                .expect("list bounded picker directory");
        assert_eq!(listing.entries.len(), 3);
        assert!(listing.truncated);

        std::fs::remove_dir_all(root).expect("remove picker test root");
    }

    #[test]
    fn state_round_trip_preserves_frontend_metadata() {
        let output = round_trip(json!({
            "schemaVersion": 1,
            "projects": [{
                "id": "project-1",
                "title": "Project",
                "basePath": "/tmp/project",
                "environmentId": null,
                "assetsEnabled": true,
                "symbol": "rocket",
                "color": "80, 120, 240",
                "sshTarget": "dev@example.test",
                "sshRemotePath": "/srv/project"
            }],
            "activeProjectId": "project-1",
            "sessions": [{
                "persistId": "session-1",
                "projectId": "project-1",
                "name": "Terminal",
                "launchCommand": null,
                "restoreCommand": null,
                "sshTarget": null,
                "sshRootDir": null,
                "lastRecordingId": null,
                "cwd": "/tmp/project",
                "persistent": false,
                "pinned": true,
                "sidebarOrder": 3,
                "symbol": "terminal",
                "color": "220, 90, 120",
                "createdAt": 123
            }],
            "activeSessionByProject": { "project-1": "session-1" },
            "prompts": [{
                "id": "prompt-1",
                "title": "Prompt",
                "content": "Content",
                "createdAt": 456,
                "pinned": true,
                "pinOrder": 2
            }],
            "environments": [],
            "assets": [],
            "assetSettings": null
        }));

        assert_eq!(output["projects"][0]["symbol"], "rocket");
        assert_eq!(output["projects"][0]["color"], "80, 120, 240");
        assert_eq!(output["projects"][0]["sshTarget"], "dev@example.test");
        assert_eq!(output["projects"][0]["sshRemotePath"], "/srv/project");
        assert_eq!(output["sessions"][0]["pinned"], true);
        assert_eq!(output["sessions"][0]["sidebarOrder"], 3);
        assert_eq!(output["sessions"][0]["symbol"], "terminal");
        assert_eq!(output["sessions"][0]["color"], "220, 90, 120");
        assert_eq!(output["prompts"][0]["pinned"], true);
        assert_eq!(output["prompts"][0]["pinOrder"], 2);
    }

    #[test]
    fn older_v1_state_without_frontend_metadata_stays_compatible() {
        let output = round_trip(json!({
            "schemaVersion": 1,
            "projects": [{
                "id": "project-1",
                "title": "Project",
                "basePath": null,
                "environmentId": null,
                "assetsEnabled": true
            }],
            "activeProjectId": "project-1",
            "sessions": [{
                "persistId": "session-1",
                "projectId": "project-1",
                "name": "Terminal",
                "launchCommand": null,
                "restoreCommand": null,
                "sshTarget": null,
                "sshRootDir": null,
                "lastRecordingId": null,
                "cwd": null,
                "persistent": false,
                "createdAt": 123
            }],
            "activeSessionByProject": {},
            "prompts": [],
            "environments": [],
            "assets": [],
            "assetSettings": null
        }));

        assert!(output["projects"][0].get("color").is_none());
        assert!(output["sessions"][0].get("color").is_none());
        assert!(output["sessions"][0].get("sidebarOrder").is_none());
    }
}
