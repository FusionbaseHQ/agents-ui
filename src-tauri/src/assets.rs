use serde::Deserialize;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TextAssetInput {
    pub relative_path: String,
    pub content: String,
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

fn validate_relative_path(input: &str) -> Result<PathBuf, String> {
    let rel = Path::new(input.trim());
    if rel.as_os_str().is_empty() {
        return Err("empty relative path".to_string());
    }
    for c in rel.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("invalid relative path: {input}"));
            }
        }
    }
    Ok(rel.to_path_buf())
}

fn write_text_file_atomic(path: &Path, content: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("invalid target path")?;
    fs::create_dir_all(parent).map_err(|e| format!("create dir failed: {e}"))?;

    let tmp = path.with_extension("tmp");
    let mut file = fs::File::create(&tmp).map_err(|e| format!("write failed: {e}"))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    file.sync_all().ok();
    drop(file);

    fs::rename(&tmp, path).map_err(|e| format!("rename failed: {e}"))?;

    // Best-effort: ensure the directory entry for the rename is durable.
    let _ = fs::File::open(parent).and_then(|dir_handle| dir_handle.sync_all());
    Ok(())
}

#[tauri::command]
pub fn apply_text_assets(
    base_dir: String,
    assets: Vec<TextAssetInput>,
    overwrite: bool,
) -> Result<Vec<String>, String> {
    let base_dir = expand_home(&base_dir);
    if base_dir.trim().is_empty() {
        return Err("missing base directory".to_string());
    }

    let base = PathBuf::from(&base_dir);
    if !base.is_dir() {
        return Err("base directory is not a folder".to_string());
    }

    let mut written: Vec<String> = Vec::new();
    for asset in assets {
        let rel = validate_relative_path(&asset.relative_path)?;
        let target = base.join(&rel);

        if target.exists() && !overwrite {
            continue;
        }
        if target.exists() && target.is_dir() {
            return Err(format!(
                "target exists and is a directory: {}",
                target.to_string_lossy()
            ));
        }

        write_text_file_atomic(&target, &asset.content)?;
        written.push(target.to_string_lossy().to_string());
    }

    Ok(written)
}
