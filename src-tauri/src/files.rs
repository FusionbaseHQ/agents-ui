use serde::Serialize;
use std::{
    collections::VecDeque,
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::Command,
    time::UNIX_EPOCH,
};

const MAX_TEXT_FILE_BYTES: u64 = 2 * 1024 * 1024;
const BINARY_CHECK_BYTES: usize = 8 * 1024;
pub(crate) const MAX_RANGE_READ_BYTES: usize = 1024 * 1024;
pub(crate) const PROBE_BYTES: usize = 64 * 1024;
const MAX_FILE_SEARCH_RESULTS: usize = 1_000;
const MAX_FILE_SEARCH_DIRS: usize = 50_000;
const FILE_SEARCH_IGNORED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".cache",
    ".turbo",
    ".venv",
    "venv",
    "__pycache__",
    ".npm",
    ".pnpm-store",
    ".yarn",
];

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
pub struct GitStatusEntry {
    pub path: String,
    pub status: String,
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

fn mtime_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
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
    // TIFF: little-endian "II*\0" or big-endian "MM\0*". WebKit renders these in <img>.
    if sample.starts_with(&[0x49, 0x49, 0x2a, 0x00]) || sample.starts_with(&[0x4d, 0x4d, 0x00, 0x2a]) {
        return Some(("tiff", "image/tiff"));
    }
    // ISOBMFF-based formats: bytes 4..8 == "ftyp", brand at 8..12. WebKit renders
    // AVIF (Safari 16.4+) and HEIC/HEIF (Safari 17+ / macOS) in <img>.
    if sample.len() >= 12 && &sample[4..8] == b"ftyp" {
        match &sample[8..12] {
            b"avif" | b"avis" => return Some(("avif", "image/avif")),
            b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1" | b"msf1" => {
                return Some(("heic", "image/heic"));
            }
            _ => {}
        }
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
        Some("tif") | Some("tiff") => Some(("tiff", "image/tiff")),
        Some("avif") => Some(("avif", "image/avif")),
        Some("heic") | Some("heif") => Some(("heic", "image/heic")),
        _ => None,
    }
}

fn looks_like_pdf(sample: &[u8]) -> bool {
    // Real PDFs begin with "%PDF-<version>". Tolerate a few leading bytes (BOM /
    // junk) by scanning only the very start, and require a version digit right
    // after the signature, so a text file that merely mentions "%PDF-" isn't
    // misclassified as a PDF and routed to the (failing) PDF viewer.
    const SIG: &[u8] = b"%PDF-";
    let scan = &sample[..sample.len().min(16)];
    scan.windows(SIG.len()).enumerate().any(|(i, window)| {
        window == SIG && scan.get(i + SIG.len()).is_some_and(u8::is_ascii_digit)
    })
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
    let is_pdf = looks_like_pdf(sample);
    let has_nul = sample[..sample.len().min(BINARY_CHECK_BYTES)]
        .iter()
        .any(|b| *b == 0);
    let valid_utf8 = sample_is_valid_utf8(sample);
    // Detect PDFs before the text/binary fallthrough: small PDFs can look like
    // valid UTF-8 text near the header, so the magic-byte check must win.
    let kind = if is_pdf {
        "pdf"
    } else if image.is_some() {
        "image"
    } else if size == 0 || (!has_nul && valid_utf8) {
        "text"
    } else {
        "binary"
    };
    let (image_type, mime) = if is_pdf {
        (None, Some("application/pdf".to_string()))
    } else {
        match image {
            Some((kind, mime)) => (Some(kind.to_string()), Some(mime.to_string())),
            None => (None, None),
        }
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

fn is_file_search_ignored_dir(name: &str) -> bool {
    FILE_SEARCH_IGNORED_DIRS.iter().any(|ignored| *ignored == name)
}

fn file_search_sort_key(name: &str) -> (bool, String) {
    (name.starts_with('.'), name.to_lowercase())
}

#[tauri::command]
pub fn search_fs_entries(root: String, query: String, limit: Option<usize>) -> Result<Vec<FsEntry>, String> {
    let root = ensure_root_dir(Path::new(root.trim()))?;
    let query = query.trim().to_lowercase();
    if query.len() < 2 {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(200).clamp(1, MAX_FILE_SEARCH_RESULTS);

    let mut out: Vec<FsEntry> = Vec::new();
    let mut queue: VecDeque<PathBuf> = VecDeque::from([root.clone()]);
    let mut scanned_dirs = 0usize;

    while let Some(dir) = queue.pop_front() {
        if out.len() >= limit || scanned_dirs >= MAX_FILE_SEARCH_DIRS {
            break;
        }
        scanned_dirs += 1;

        let read_dir = match fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        let mut dirs: Vec<(String, PathBuf)> = Vec::new();
        let mut files: Vec<(String, PathBuf, u64)> = Vec::new();

        for item in read_dir.flatten() {
            let name = item.file_name().to_string_lossy().to_string();
            let path = item.path();
            let meta = match fs::metadata(&path) {
                Ok(meta) => meta,
                Err(_) => continue,
            };
            if meta.is_dir() {
                if !is_file_search_ignored_dir(&name) {
                    dirs.push((name, path));
                }
            } else if meta.is_file() {
                files.push((name, path, meta.len()));
            }
        }

        dirs.sort_by_key(|(name, _)| file_search_sort_key(name));
        files.sort_by_key(|(name, _path, _size)| file_search_sort_key(name));

        for (name, path, size) in files {
            let rel = path
                .strip_prefix(&root)
                .ok()
                .and_then(|p| p.to_str())
                .unwrap_or(&name)
                .to_lowercase();
            if name.to_lowercase().contains(&query) || rel.contains(&query) {
                out.push(FsEntry {
                    name,
                    path: path.to_string_lossy().to_string(),
                    is_dir: false,
                    size,
                });
                if out.len() >= limit {
                    break;
                }
            }
        }

        for (_name, path) in dirs {
            queue.push_back(path);
        }
    }

    Ok(out)
}

fn git_status_kind(code: &str) -> &'static str {
    if code.contains('U') || code == "AA" || code == "DD" {
        "conflicted"
    } else if code.contains('R') || code.contains('C') {
        "renamed"
    } else if code.contains('A') {
        "added"
    } else if code.contains('D') {
        "deleted"
    } else if code == "??" {
        "untracked"
    } else {
        "modified"
    }
}

#[tauri::command]
pub fn git_status_entries(root: String) -> Result<Vec<GitStatusEntry>, String> {
    let root = ensure_root_dir(Path::new(root.trim()))?;
    let output = Command::new("git")
        .arg("-C")
        .arg(&root)
        .arg("status")
        .arg("--porcelain=v1")
        .arg("-z")
        .arg("--untracked-files=normal")
        .output()
        .map_err(|e| format!("git status failed: {e}"))?;

    if !output.status.success() {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    let mut parts = output.stdout.split(|b| *b == 0).filter(|part| !part.is_empty());
    while let Some(part) = parts.next() {
        if part.len() < 4 {
            continue;
        }
        let code = String::from_utf8_lossy(&part[..2]).to_string();
        let rel = String::from_utf8_lossy(&part[3..]).to_string();
        if code.contains('R') || code.contains('C') {
            let _old_path = parts.next();
        }
        if rel.is_empty() {
            continue;
        }
        let path = root.join(rel);
        out.push(GitStatusEntry {
            path: path.to_string_lossy().to_string(),
            status: git_status_kind(&code).to_string(),
        });
    }

    Ok(out)
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

    // Single open + fstat on the handle, rather than a separate path stat + open.
    let mut f = File::open(&file).map_err(|e| format!("open failed: {e}"))?;
    let meta = f.metadata().map_err(|e| format!("metadata failed: {e}"))?;
    let size = meta.len();
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
) -> Result<tauri::ipc::Response, String> {
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

    // Raw bytes over IPC (no base64). The frontend derives offset/eof from the
    // requested range and the known file size — a short read means EOF.
    Ok(tauri::ipc::Response::new(bytes))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn kind_of(sample: &[u8]) -> String {
        probe_from_sample(sample.len() as u64, None, sample, None).kind
    }

    #[test]
    fn detects_pdf_header() {
        let probe = probe_from_sample(2048, None, b"%PDF-1.7\n1 0 obj\n", None);
        assert_eq!(probe.kind, "pdf");
        assert_eq!(probe.mime.as_deref(), Some("application/pdf"));
    }

    #[test]
    fn detects_pdf_with_leading_bom() {
        // A few leading junk/BOM bytes before the signature are tolerated.
        assert_eq!(kind_of(b"\xef\xbb\xbf%PDF-2.0\n"), "pdf");
    }

    #[test]
    fn text_mentioning_pdf_signature_is_not_a_pdf() {
        // The signature appears well past the start, so this stays text rather
        // than being misrouted to the PDF viewer.
        assert_eq!(kind_of(b"This document describes the %PDF-1.5 file header.\n"), "text");
    }

    #[test]
    fn pdf_signature_without_version_digit_is_not_a_pdf() {
        assert_eq!(kind_of(b"%PDF-marker but not a real pdf\n"), "text");
    }

    #[test]
    fn plain_text_and_binary_unchanged() {
        assert_eq!(kind_of(b"hello, world\n"), "text");
        assert_eq!(kind_of(&[0x00, 0x01, 0x02, 0xff, 0xfe]), "binary");
    }

    #[test]
    fn detects_tiff_and_isobmff_images() {
        assert_eq!(kind_of(&[0x49, 0x49, 0x2a, 0x00, 0x08, 0x00]), "image"); // TIFF LE
        assert_eq!(kind_of(&[0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x08]), "image"); // TIFF BE
        let avif = b"\x00\x00\x00\x20ftypavif\x00\x00\x00\x00";
        assert_eq!(kind_of(avif), "image");
        let heic = b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00";
        assert_eq!(kind_of(heic), "image");
    }
}
