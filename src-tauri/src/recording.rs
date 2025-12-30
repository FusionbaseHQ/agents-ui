use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use tauri::{Manager, WebviewWindow};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecordingMetaV1 {
    pub schema_version: u32,
    pub created_at: u64,
    pub name: Option<String>,
    pub project_id: String,
    pub session_persist_id: String,
    pub cwd: Option<String>,
    pub effect_id: Option<String>,
    pub bootstrap_command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encrypted: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecordingEventV1 {
    pub t: u64,
    pub data: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum RecordingLineV1 {
    Meta(RecordingMetaV1),
    Input(RecordingEventV1),
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoadedRecordingV1 {
    pub recording_id: String,
    pub meta: Option<RecordingMetaV1>,
    pub events: Vec<RecordingEventV1>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecordingIndexEntryV1 {
    pub recording_id: String,
    pub meta: Option<RecordingMetaV1>,
}

pub fn sanitize_recording_id(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return "recording".to_string();
    }
    let mut out = String::with_capacity(trimmed.len());
    for ch in trimmed.chars().take(120) {
        let ok = ch.is_ascii_alphanumeric() || ch == '-' || ch == '_';
        out.push(if ok { ch } else { '_' });
    }
    if out.is_empty() {
        "recording".to_string()
    } else {
        out
    }
}

pub fn recording_file_path(window: &WebviewWindow, recording_id: &str) -> Result<PathBuf, String> {
    let app_data = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|_| "unknown app data dir".to_string())?;
    Ok(app_data
        .join("recordings")
        .join(format!("{recording_id}.jsonl")))
}

fn recordings_dir(window: &WebviewWindow) -> Result<PathBuf, String> {
    let app_data = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|_| "unknown app data dir".to_string())?;
    Ok(app_data.join("recordings"))
}

fn read_recording_meta(path: &PathBuf) -> Result<Option<RecordingMetaV1>, String> {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("open failed: {e}")),
    };
    let reader = BufReader::new(file);

    for line in reader.lines().take(25) {
        let line = line.map_err(|e| format!("read failed: {e}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: RecordingLineV1 =
            serde_json::from_str(trimmed).map_err(|e| format!("parse failed: {e}"))?;
        if let RecordingLineV1::Meta(meta) = parsed {
            return Ok(Some(meta));
        }
    }
    Ok(None)
}

#[tauri::command]
pub fn load_recording(
    window: WebviewWindow,
    recording_id: String,
    decrypt: Option<bool>,
) -> Result<LoadedRecordingV1, String> {
    let safe_id = sanitize_recording_id(&recording_id);
    let path = recording_file_path(&window, &safe_id)?;
    let file = fs::File::open(&path).map_err(|e| format!("open failed: {e}"))?;
    let reader = BufReader::new(file);

    let mut meta: Option<RecordingMetaV1> = None;
    let mut events: Vec<RecordingEventV1> = Vec::new();
    let mut key: Option<[u8; 32]> = None;
    let decrypt_allowed = decrypt.unwrap_or(true);

    for line in reader.lines() {
        let line = line.map_err(|e| format!("read failed: {e}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: RecordingLineV1 =
            serde_json::from_str(trimmed).map_err(|e| format!("parse failed: {e}"))?;
        match parsed {
            RecordingLineV1::Meta(m) => {
                if meta.is_none() {
                    meta = Some(m);
                }
            }
            RecordingLineV1::Input(mut ev) => {
                if crate::secure::is_probably_encrypted_value(&ev.data) {
                    if !decrypt_allowed {
                        return Err(
                            "Recording is encrypted. Enable macOS Keychain encryption to replay it."
                                .to_string(),
                        );
                    }
                    if key.is_none() {
                        key = Some(crate::secure::get_or_create_master_key(&window)?);
                    }
                    if let Some(key) = key.as_ref() {
                        ev.data = crate::secure::decrypt_string_with_key(
                            key,
                            crate::secure::SecretContext::Recording,
                            &ev.data,
                        )?;
                    }
                }
                events.push(ev);
            }
        }
    }

    Ok(LoadedRecordingV1 {
        recording_id: safe_id,
        meta,
        events,
    })
}

#[tauri::command]
pub fn list_recordings(window: WebviewWindow) -> Result<Vec<RecordingIndexEntryV1>, String> {
    let dir = recordings_dir(&window)?;
    let read_dir = match fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read dir failed: {e}")),
    };

    let mut out: Vec<RecordingIndexEntryV1> = Vec::new();

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let recording_id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let meta = read_recording_meta(&path).ok().flatten();
        out.push(RecordingIndexEntryV1 { recording_id, meta });
    }

    out.sort_by(|a, b| {
        let a_created = a.meta.as_ref().map(|m| m.created_at).unwrap_or(0);
        let b_created = b.meta.as_ref().map(|m| m.created_at).unwrap_or(0);
        b_created.cmp(&a_created)
    });

    Ok(out)
}

#[tauri::command]
pub fn delete_recording(window: WebviewWindow, recording_id: String) -> Result<(), String> {
    let safe_id = sanitize_recording_id(&recording_id);
    let path = recording_file_path(&window, &safe_id)?;
    match fs::remove_file(&path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete failed: {e}")),
    }
}
