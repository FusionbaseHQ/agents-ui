use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

const MAX_TEXT_FILE_BYTES: u64 = 2 * 1024 * 1024;
const BINARY_CHECK_BYTES: usize = 8 * 1024;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

fn canonicalize_existing(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|e| format!("canonicalize failed: {e}"))
}

fn ensure_root_dir(root: &Path) -> Result<PathBuf, String> {
    if !root.is_absolute() {
        return Err("root must be absolute".to_string());
    }
    if !root.is_dir() {
        return Err("root is not a directory".to_string());
    }
    canonicalize_existing(root)
}

fn ensure_within_root(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let root = ensure_root_dir(root)?;
    if !path.is_absolute() {
        return Err("path must be absolute".to_string());
    }
    let canon = canonicalize_existing(path)?;
    if !canon.starts_with(&root) {
        return Err("path is outside root".to_string());
    }
    Ok(canon)
}

#[tauri::command]
pub fn list_fs_entries(root: String, path: String) -> Result<Vec<FsEntry>, String> {
    let root = Path::new(root.trim());
    let path = Path::new(path.trim());
    let dir = ensure_within_root(root, path)?;
    if !dir.is_dir() {
        return Err("not a directory".to_string());
    }

    let mut entries: Vec<FsEntry> = Vec::new();
    let read_dir = fs::read_dir(&dir).map_err(|e| format!("read dir failed: {e}"))?;
    for item in read_dir {
        let item = match item {
            Ok(i) => i,
            Err(_) => continue,
        };
        let path = item.path();
        let meta = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        let name = item
            .file_name()
            .to_string_lossy()
            .to_string();
        entries.push(FsEntry {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            size: if is_dir { 0 } else { meta.len() },
        });
    }

    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => return std::cmp::Ordering::Less,
            (false, true) => return std::cmp::Ordering::Greater,
            _ => {}
        }
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });

    Ok(entries)
}

#[tauri::command]
pub fn read_text_file(root: String, path: String) -> Result<String, String> {
    let root = Path::new(root.trim());
    let path = Path::new(path.trim());
    let file = ensure_within_root(root, path)?;
    if !file.is_file() {
        return Err("not a file".to_string());
    }

    let meta = fs::metadata(&file).map_err(|e| format!("metadata failed: {e}"))?;
    let size = meta.len();
    if size > MAX_TEXT_FILE_BYTES {
        return Err(format!(
            "file too large ({size} bytes, max {MAX_TEXT_FILE_BYTES} bytes)"
        ));
    }

    let bytes = fs::read(&file).map_err(|e| format!("read failed: {e}"))?;
    if bytes[..bytes.len().min(BINARY_CHECK_BYTES)]
        .iter()
        .any(|b| *b == 0)
    {
        return Err("binary files are not supported".to_string());
    }

    String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8".to_string())
}

#[tauri::command]
pub fn write_text_file(root: String, path: String, content: String) -> Result<(), String> {
    let root = Path::new(root.trim());
    let path = Path::new(path.trim());
    let file = ensure_within_root(root, path)?;
    if !file.is_file() {
        return Err("not a file".to_string());
    }
    fs::write(&file, content.as_bytes()).map_err(|e| format!("write failed: {e}"))?;
    Ok(())
}

fn ensure_parent_within_root(root: &Path, path: &Path) -> Result<(PathBuf, PathBuf), String> {
    let root = ensure_root_dir(root)?;
    if !path.is_absolute() {
        return Err("path must be absolute".to_string());
    }
    let parent = path.parent().ok_or_else(|| "missing parent directory".to_string())?;
    let canon_parent = canonicalize_existing(parent)?;
    if !canon_parent.starts_with(&root) {
        return Err("path is outside root".to_string());
    }
    Ok((root, canon_parent))
}

#[tauri::command]
pub fn rename_fs_entry(root: String, path: String, new_name: String) -> Result<String, String> {
    let root = Path::new(root.trim());
    let path = Path::new(path.trim());
    let (canon_root, _) = ensure_parent_within_root(root, path)?;
    let from = path.to_path_buf();
    if from == canon_root {
        return Err("cannot rename root".to_string());
    }

    let name = new_name.trim();
    if name.is_empty() {
        return Err("missing new name".to_string());
    }
    if name == "." || name == ".." {
        return Err("invalid name".to_string());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("name must not contain path separators".to_string());
    }

    let parent = from
        .parent()
        .ok_or_else(|| "missing parent directory".to_string())?;
    let to = parent.join(name);
    if to.exists() {
        return Err("target already exists".to_string());
    }
    fs::symlink_metadata(&from).map_err(|e| format!("metadata failed: {e}"))?;

    fs::rename(&from, &to).map_err(|e| format!("rename failed: {e}"))?;
    Ok(to.to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_fs_entry(root: String, path: String) -> Result<(), String> {
    let root = Path::new(root.trim());
    let path = Path::new(path.trim());
    let (canon_root, _) = ensure_parent_within_root(root, path)?;
    let target = path.to_path_buf();
    if target == canon_root {
        return Err("cannot delete root".to_string());
    }

    let meta = fs::symlink_metadata(&target).map_err(|e| format!("metadata failed: {e}"))?;
    if meta.file_type().is_symlink() {
        return fs::remove_file(&target).map_err(|e| format!("delete failed: {e}"));
    }
    if meta.is_dir() {
        fs::remove_dir_all(&target).map_err(|e| format!("delete failed: {e}"))?;
        return Ok(());
    }
    fs::remove_file(&target).map_err(|e| format!("delete failed: {e}"))?;
    Ok(())
}
