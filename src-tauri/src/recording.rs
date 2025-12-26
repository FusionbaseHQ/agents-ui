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
    pub project_id: String,
    pub session_persist_id: String,
    pub cwd: Option<String>,
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

#[tauri::command]
pub fn load_recording(window: WebviewWindow, recording_id: String) -> Result<LoadedRecordingV1, String> {
    let safe_id = sanitize_recording_id(&recording_id);
    let path = recording_file_path(&window, &safe_id)?;
    let file = fs::File::open(&path).map_err(|e| format!("open failed: {e}"))?;
    let reader = BufReader::new(file);

    let mut meta: Option<RecordingMetaV1> = None;
    let mut events: Vec<RecordingEventV1> = Vec::new();

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
            RecordingLineV1::Input(ev) => events.push(ev),
        }
    }

    Ok(LoadedRecordingV1 {
        recording_id: safe_id,
        meta,
        events,
    })
}

