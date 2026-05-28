use serde::Serialize;
use std::{
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

const MAX_TEXT_FILE_BYTES: u64 = 2 * 1024 * 1024;
const BINARY_CHECK_BYTES: usize = 8 * 1024;
pub(crate) const MAX_RANGE_READ_BYTES: usize = 1024 * 1024;
pub(crate) const PROBE_BYTES: usize = 64 * 1024;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileProbe {
    pub size: u64,
    pub mtime_ms: Option<u64>,
    pub kind: String,
    pub image_type: Option<String>,
    pub mime: Option<String>,
    pub has_nul: bool,
    pub valid_utf8: bool,
    pub is_large_text: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileRangeRead {
    pub offset: u64,
    pub length: usize,
    pub size: u64,
    pub mtime_ms: Option<u64>,
    pub eof: bool,
    pub data_base64: String,
}

fn mtime_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
}

pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut i = 0usize;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | bytes[i + 2] as u32;
        out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 6) & 0x3f) as usize] as char);
        out.push(TABLE[(n & 0x3f) as usize] as char);
        i += 3;
    }
    match bytes.len() - i {
        1 => {
            let n = (bytes[i] as u32) << 16;
            out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
            out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
            out.push('=');
            out.push('=');
        }
        2 => {
            let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
            out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
            out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
            out.push(TABLE[((n >> 6) & 0x3f) as usize] as char);
            out.push('=');
        }
        _ => {}
    }
    out
}

fn raster_image_type(sample: &[u8], path: Option<&Path>) -> Option<(&'static str, &'static str)> {
    if sample.starts_with(&[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n']) {
        return Some(("png", "image/png"));
    }
    if sample.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some(("jpeg", "image/jpeg"));
    }
    if sample.starts_with(b"GIF87a") || sample.starts_with(b"GIF89a") {
        return Some(("gif", "image/gif"));
    }
    if sample.len() >= 12 && sample.starts_with(b"RIFF") && &sample[8..12] == b"WEBP" {
        return Some(("webp", "image/webp"));
    }
    if sample.starts_with(b"BM") {
        return Some(("bmp", "image/bmp"));
    }
    if sample.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return Some(("ico", "image/x-icon"));
    }

    let ext = path
        .and_then(|p| p.extension())
        .and_then(|v| v.to_str())
        .map(|v| v.to_ascii_lowercase());
    match ext.as_deref() {
        Some("png") => Some(("png", "image/png")),
        Some("jpg") | Some("jpeg") => Some(("jpeg", "image/jpeg")),
        Some("gif") => Some(("gif", "image/gif")),
        Some("webp") => Some(("webp", "image/webp")),
        Some("bmp") => Some(("bmp", "image/bmp")),
        Some("ico") => Some(("ico", "image/x-icon")),
        _ => None,
    }
}

fn sample_is_valid_utf8(sample: &[u8]) -> bool {
    match std::str::from_utf8(sample) {
        Ok(_) => true,
        Err(err) => {
            err.error_len().is_none() && sample.len().saturating_sub(err.valid_up_to()) <= 4
        }
    }
}

pub(crate) fn probe_from_sample(
    size: u64,
    mtime_ms: Option<u64>,
    sample: &[u8],
    path: Option<&Path>,
) -> FileProbe {
    let image = raster_image_type(sample, path);
    let has_nul = sample[..sample.len().min(BINARY_CHECK_BYTES)]
        .iter()
        .any(|b| *b == 0);
    let valid_utf8 = sample_is_valid_utf8(sample);
    let kind = if image.is_some() {
        "image"
    } else if size == 0 || (!has_nul && valid_utf8) {
        "text"
    } else {
        "binary"
    };
    let (image_type, mime) = match image {
        Some((kind, mime)) => (Some(kind.to_string()), Some(mime.to_string())),
        None => (None, None),
    };
    FileProbe {
        size,
        mtime_ms,
        kind: kind.to_string(),
        image_type,
        mime,
        has_nul,
        valid_utf8,
        is_large_text: kind == "text" && size > MAX_TEXT_FILE_BYTES,
    }
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
        let mut size = 0u64;
        let is_dir = match item.file_type() {
            Ok(t) if t.is_dir() => true,
            Ok(t) if t.is_file() => {
                size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                false
            }
            Ok(_) | Err(_) => {
                // Follow symlinks (matches previous behavior) and fall back when file_type is unavailable.
                let meta = match fs::metadata(&path) {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                size = meta.len();
                meta.is_dir()
            }
        };
        let name = item
            .file_name()
            .to_string_lossy()
            .to_string();
        entries.push(FsEntry {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            size: if is_dir { 0 } else { size },
        });
    }

    // Pre-compute lowercase names to avoid O(n log n) string allocations during sort.
    let mut sortable: Vec<(String, FsEntry)> = entries
        .into_iter()
        .map(|e| (e.name.to_lowercase(), e))
        .collect();
    sortable.sort_by(|(ka, a), (kb, b)| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => ka.cmp(kb),
        }
    });
    let entries: Vec<FsEntry> = sortable.into_iter().map(|(_, e)| e).collect();

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
pub fn probe_file(root: String, path: String) -> Result<FileProbe, String> {
    let root = Path::new(root.trim());
    let path = Path::new(path.trim());
    let file = ensure_within_root(root, path)?;
    if !file.is_file() {
        return Err("not a file".to_string());
    }

    let meta = fs::metadata(&file).map_err(|e| format!("metadata failed: {e}"))?;
    let size = meta.len();
    let mut f = File::open(&file).map_err(|e| format!("open failed: {e}"))?;
    let mut sample = vec![0u8; PROBE_BYTES.min(size as usize)];
    if !sample.is_empty() {
        f.read_exact(&mut sample)
            .map_err(|e| format!("read failed: {e}"))?;
    }
    Ok(probe_from_sample(
        size,
        mtime_ms(&meta),
        &sample,
        Some(&file),
    ))
}

#[tauri::command]
pub fn read_file_range(
    root: String,
    path: String,
    offset: u64,
    length: u64,
) -> Result<FileRangeRead, String> {
    if length > MAX_RANGE_READ_BYTES as u64 {
        return Err(format!(
            "range too large ({length} bytes, max {MAX_RANGE_READ_BYTES} bytes)"
        ));
    }

    let root = Path::new(root.trim());
    let path = Path::new(path.trim());
    let file = ensure_within_root(root, path)?;
    if !file.is_file() {
        return Err("not a file".to_string());
    }

    let meta = fs::metadata(&file).map_err(|e| format!("metadata failed: {e}"))?;
    let size = meta.len();
    let read_len = length as usize;
    let clamped_offset = offset.min(size);
    let available = size.saturating_sub(clamped_offset).min(read_len as u64) as usize;
    let mut bytes = vec![0u8; available];
    if available > 0 {
        let mut f = File::open(&file).map_err(|e| format!("open failed: {e}"))?;
        f.seek(SeekFrom::Start(clamped_offset))
            .map_err(|e| format!("seek failed: {e}"))?;
        f.read_exact(&mut bytes)
            .map_err(|e| format!("read failed: {e}"))?;
    }

    Ok(FileRangeRead {
        offset: clamped_offset,
        length: bytes.len(),
        size,
        mtime_ms: mtime_ms(&meta),
        eof: clamped_offset + bytes.len() as u64 >= size,
        data_base64: base64_encode(&bytes),
    })
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

#[tauri::command]
pub fn create_file(root: String, path: String) -> Result<(), String> {
    let root = Path::new(root.trim());
    let path = Path::new(path.trim());
    let (_, canon_parent) = ensure_parent_within_root(root, path)?;
    let name = path.file_name().ok_or_else(|| "missing file name".to_string())?;
    let target = canon_parent.join(name);
    if target.exists() {
        return Err("file already exists".to_string());
    }
    fs::write(&target, b"").map_err(|e| format!("create failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn create_directory(root: String, path: String) -> Result<(), String> {
    let root = Path::new(root.trim());
    let path = Path::new(path.trim());
    let (_, canon_parent) = ensure_parent_within_root(root, path)?;
    let name = path.file_name().ok_or_else(|| "missing directory name".to_string())?;
    let target = canon_parent.join(name);
    if target.exists() {
        return Err("directory already exists".to_string());
    }
    fs::create_dir(&target).map_err(|e| format!("create failed: {e}"))?;
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

fn copy_dir_recursive(src: &Path, dest: &Path) -> io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            fs::copy(&src_path, &dest_path)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn copy_fs_entry(root: String, source_path: String, dest_path: String) -> Result<(), String> {
    let root = Path::new(root.trim());
    let source = Path::new(source_path.trim());
    let dest = Path::new(dest_path.trim());

    // Validate root
    let canon_root = ensure_root_dir(root)?;

    // Validate destination is within root
    if !dest.is_absolute() {
        return Err("destination path must be absolute".to_string());
    }
    let dest_parent = dest.parent().ok_or_else(|| "missing destination parent".to_string())?;
    let canon_dest_parent = canonicalize_existing(dest_parent)?;
    if !canon_dest_parent.starts_with(&canon_root) {
        return Err("destination is outside root".to_string());
    }

    // Source doesn't need to be within root (can copy from anywhere)
    if !source.is_absolute() {
        return Err("source path must be absolute".to_string());
    }
    if !source.exists() {
        return Err("source does not exist".to_string());
    }

    // Check if destination already exists
    if dest.exists() {
        return Err("destination already exists".to_string());
    }

    // Perform the copy
    let meta = fs::metadata(source).map_err(|e| format!("metadata failed: {e}"))?;
    if meta.is_dir() {
        copy_dir_recursive(source, dest).map_err(|e| format!("copy failed: {e}"))?;
    } else {
        fs::copy(source, dest).map_err(|e| format!("copy failed: {e}"))?;
    }

    Ok(())
}
