use serde::Serialize;
use std::{
    collections::VecDeque,
    ffi::OsStr,
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

const MAX_TEXT_FILE_BYTES: u64 = 2 * 1024 * 1024;
const BINARY_CHECK_BYTES: usize = 8 * 1024;
pub(crate) const MAX_RANGE_READ_BYTES: usize = 1024 * 1024;
pub(crate) const PROBE_BYTES: usize = 64 * 1024;
const MAX_FILE_SEARCH_RESULTS: usize = 1_000;
const MAX_FILE_SEARCH_DIRS: usize = 50_000;
pub(crate) const NON_UTF8_FILESYSTEM_PATH_ERROR: &str =
    "filesystem path contains a name that is not valid UTF-8";
static NEXT_TEXT_WRITE_STAGE_ID: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
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

fn looks_like_xlsx(sample: &[u8], path: Option<&Path>) -> bool {
    let is_xlsx_path = path
        .and_then(|p| p.extension())
        .and_then(|v| v.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("xlsx"));
    if !is_xlsx_path {
        return false;
    }

    // XLSX files are ZIP-based OOXML workbooks. The first local-file entry is
    // commonly [Content_Types].xml, but extension + ZIP signature is the useful
    // early probe for remote/local range-limited reads.
    sample.starts_with(b"PK\x03\x04")
        || sample.starts_with(b"PK\x05\x06")
        || sample.starts_with(b"PK\x07\x08")
        || sample
            .windows(b"[Content_Types].xml".len())
            .any(|window| window == b"[Content_Types].xml")
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
    let is_xlsx = looks_like_xlsx(sample, path);
    let has_nul = sample[..sample.len().min(BINARY_CHECK_BYTES)]
        .iter()
        .any(|b| *b == 0);
    let valid_utf8 = sample_is_valid_utf8(sample);
    // Detect PDFs before the text/binary fallthrough: small PDFs can look like
    // valid UTF-8 text near the header, so the magic-byte check must win.
    let kind = if is_pdf {
        "pdf"
    } else if is_xlsx {
        "xlsx"
    } else if image.is_some() {
        "image"
    } else if size == 0 || (!has_nul && valid_utf8) {
        "text"
    } else {
        "binary"
    };
    let (image_type, mime) = if is_pdf {
        (None, Some("application/pdf".to_string()))
    } else if is_xlsx {
        (
            None,
            Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".to_string()),
        )
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

/// Convert an OS-native filesystem value at the IPC boundary without changing it.
///
/// JavaScript paths are Unicode strings, so a non-UTF-8 Unix filename cannot be
/// represented losslessly by the frontend. Returning a stable error is safer
/// than substituting U+FFFD and exposing a path that points at a different name.
pub(crate) fn os_str_to_utf8(value: &OsStr) -> Result<&str, String> {
    value
        .to_str()
        .ok_or_else(|| NON_UTF8_FILESYSTEM_PATH_ERROR.to_string())
}

pub(crate) fn path_to_utf8(path: &Path) -> Result<String, String> {
    os_str_to_utf8(path.as_os_str()).map(str::to_owned)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn path_to_c_string(path: &Path) -> io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;

    std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "filesystem path contains a NUL byte",
        )
    })
}

/// Atomically rename `source` to `destination` only when no destination entry
/// exists. Never fall back to ordinary Unix rename semantics, which can replace
/// a file created between a separate existence check and the rename syscall.
#[allow(clippy::needless_return)] // Explicit cfg returns keep each platform implementation local.
pub(crate) fn rename_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let source = path_to_c_string(source)?;
        let destination = path_to_c_string(destination)?;
        let result = unsafe {
            libc::renameatx_np(
                libc::AT_FDCWD,
                source.as_ptr(),
                libc::AT_FDCWD,
                destination.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        return if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        };
    }

    #[cfg(target_os = "linux")]
    {
        let source = path_to_c_string(source)?;
        let destination = path_to_c_string(destination)?;
        let result = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                libc::AT_FDCWD,
                source.as_ptr(),
                libc::AT_FDCWD,
                destination.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        return if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        };
    }

    #[cfg(target_family = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;

        #[link(name = "Kernel32")]
        extern "system" {
            fn MoveFileW(existing: *const u16, new: *const u16) -> i32;
        }
        let existing = source
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let new = destination
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let result = unsafe { MoveFileW(existing.as_ptr(), new.as_ptr()) };
        return if result != 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        };
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_family = "windows")))]
    {
        let _ = (source, destination);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "atomic no-replace rename is unsupported on this platform",
        ))
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn rename_no_replace_in_open_dir(
    directory: &File,
    source_name: &OsStr,
    destination_name: &OsStr,
) -> io::Result<()> {
    use std::os::fd::AsRawFd;

    let source_name = path_to_c_string(Path::new(source_name))?;
    let destination_name = path_to_c_string(Path::new(destination_name))?;
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            directory.as_raw_fd(),
            source_name.as_ptr(),
            directory.as_raw_fd(),
            destination_name.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            directory.as_raw_fd(),
            source_name.as_ptr(),
            directory.as_raw_fd(),
            destination_name.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn rename_in_same_directory_no_replace(
    directory_path: &Path,
    source_name: &OsStr,
    destination_name: &OsStr,
) -> io::Result<()> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let directory = File::open(directory_path)?;
        return rename_no_replace_in_open_dir(&directory, source_name, destination_name);
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    rename_no_replace(
        &directory_path.join(source_name),
        &directory_path.join(destination_name),
    )
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
    let root = Path::new(&root);
    let path = Path::new(&path);
    let dir = ensure_within_root(root, path)?;
    if !dir.is_dir() {
        return Err("not a directory".to_string());
    }
    path_to_utf8(&dir)?;

    let mut entries: Vec<FsEntry> = Vec::new();
    let read_dir = fs::read_dir(&dir).map_err(|e| format!("read dir failed: {e}"))?;
    for item in read_dir {
        let item = match item {
            Ok(i) => i,
            Err(_) => continue,
        };
        let file_name = item.file_name();
        let name = os_str_to_utf8(&file_name)?.to_owned();
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
        entries.push(FsEntry {
            name,
            path: path_to_utf8(&path)?,
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
    let root = ensure_root_dir(Path::new(&root))?;
    path_to_utf8(&root)?;
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
            let file_name = item.file_name();
            let name = os_str_to_utf8(&file_name)?.to_owned();
            let path = item.path();
            let file_type = match item.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            // Search is rooted traversal, not a filesystem browser. Never
            // follow symlinked directories outside the root or into cycles.
            if file_type.is_symlink() {
                let target = match fs::canonicalize(&path) {
                    Ok(target) if target.starts_with(&root) && target.is_file() => target,
                    _ => continue,
                };
                let size = fs::metadata(target).map(|meta| meta.len()).unwrap_or(0);
                files.push((name, path, size));
                continue;
            }
            if file_type.is_dir() {
                if !is_file_search_ignored_dir(&name) {
                    dirs.push((name, path));
                }
            } else if file_type.is_file() {
                let size = item.metadata().map(|meta| meta.len()).unwrap_or(0);
                files.push((name, path, size));
            }
        }

        dirs.sort_by_key(|(name, _)| file_search_sort_key(name));
        files.sort_by_key(|(name, _path, _size)| file_search_sort_key(name));

        for (name, path, size) in files {
            let rel_path = path
                .strip_prefix(&root)
                .map_err(|_| "file search path escaped root".to_string())?;
            let rel = path_to_utf8(rel_path)?.to_lowercase();
            if name.to_lowercase().contains(&query) || rel.contains(&query) {
                out.push(FsEntry {
                    name,
                    path: path_to_utf8(&path)?,
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

#[tauri::command]
pub fn read_text_file(root: String, path: String) -> Result<String, String> {
    let root = Path::new(&root);
    let path = Path::new(&path);
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
    let root = Path::new(&root);
    let path = Path::new(&path);
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

    let root = Path::new(&root);
    let path = Path::new(&path);
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

fn text_write_stage_name(id: u64) -> String {
    format!(
        ".agents-ui-write-stage-{}-{id}",
        std::process::id()
    )
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
struct AnchoredTextWriteStage {
    directory: std::sync::Arc<File>,
    name: std::ffi::CString,
    armed: bool,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl Drop for AnchoredTextWriteStage {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        use std::os::fd::AsRawFd;
        // SAFETY: the directory descriptor and NUL-terminated stage name stay
        // alive for the complete call. Failure is best-effort cleanup only.
        unsafe {
            libc::unlinkat(self.directory.as_raw_fd(), self.name.as_ptr(), 0);
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn open_directory_componentwise_no_follow(path: &Path) -> io::Result<File> {
    use std::os::fd::{AsRawFd, FromRawFd};

    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "directory path must be absolute",
        ));
    }

    let root = std::ffi::CString::new("/").expect("root path has no NUL");
    // SAFETY: root is a valid NUL-terminated path; a successful descriptor is
    // immediately transferred into File ownership.
    let root_fd = unsafe {
        libc::open(
            root.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if root_fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut directory = unsafe { File::from_raw_fd(root_fd) };

    for component in path.components() {
        let name = match component {
            std::path::Component::RootDir | std::path::Component::CurDir => continue,
            std::path::Component::Normal(name) => name,
            std::path::Component::ParentDir | std::path::Component::Prefix(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "directory path contains an unsupported component",
                ));
            }
        };
        let name = path_to_c_string(Path::new(name))?;
        // SAFETY: directory is an open directory and name is NUL-terminated.
        let child_fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if child_fd < 0 {
            return Err(io::Error::last_os_error());
        }
        directory = unsafe { File::from_raw_fd(child_fd) };
    }

    Ok(directory)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn directory_handle_matches_path(directory: &File, path: &Path) -> io::Result<bool> {
    use std::os::unix::fs::MetadataExt;

    let handle = directory.metadata()?;
    let current = fs::symlink_metadata(path)?;
    Ok(!current.file_type().is_symlink()
        && current.is_dir()
        && handle.dev() == current.dev()
        && handle.ino() == current.ino())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn create_anchored_text_write_stage(
    directory: std::sync::Arc<File>,
    mut next_id: impl FnMut() -> u64,
) -> Result<(AnchoredTextWriteStage, File), String> {
    use std::os::fd::{AsRawFd, FromRawFd};

    const MAX_ATTEMPTS: usize = 128;
    for _ in 0..MAX_ATTEMPTS {
        let name = std::ffi::CString::new(text_write_stage_name(next_id()))
            .expect("generated staging name has no NUL");
        // O_EXCL makes every writer own a distinct inode. O_NOFOLLOW is
        // defense-in-depth and guarantees a planted symlink is never opened.
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY
                    | libc::O_CREAT
                    | libc::O_EXCL
                    | libc::O_NOFOLLOW
                    | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd >= 0 {
            let file = unsafe { File::from_raw_fd(fd) };
            return Ok((
                AnchoredTextWriteStage {
                    directory,
                    name,
                    armed: true,
                },
                file,
            ));
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::AlreadyExists {
            return Err(format!("create staging file failed: {error}"));
        }
    }
    Err("could not create a unique text-write staging file".to_string())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn write_text_file_atomic_with_stage_ids(
    file: &Path,
    content: &str,
    next_id: impl FnMut() -> u64,
) -> Result<(), String> {
    use std::os::fd::{AsRawFd, FromRawFd};

    let parent = file.parent().ok_or("invalid file path")?;
    let file_name = file.file_name().ok_or("invalid file name")?;
    let directory = std::sync::Arc::new(
        open_directory_componentwise_no_follow(parent)
            .map_err(|error| format!("open parent directory failed: {error}"))?,
    );
    if !directory_handle_matches_path(&directory, parent)
        .map_err(|error| format!("verify parent directory failed: {error}"))?
    {
        return Err("parent directory changed during save".to_string());
    }

    let file_name_c = path_to_c_string(Path::new(file_name))
        .map_err(|error| format!("invalid file name: {error}"))?;
    // O_NONBLOCK prevents a raced-in FIFO from hanging the save worker. The
    // descriptor is used only for fstat/permissions and must be a regular file.
    let original_fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            file_name_c.as_ptr(),
            libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if original_fd < 0 {
        return Err(format!("open failed: {}", io::Error::last_os_error()));
    }
    let original = unsafe { File::from_raw_fd(original_fd) };
    let original_metadata = original
        .metadata()
        .map_err(|error| format!("metadata failed: {error}"))?;
    if !original_metadata.is_file() {
        return Err("not a file".to_string());
    }
    let original_permissions = original_metadata.permissions();

    let (mut staging, mut output) =
        create_anchored_text_write_stage(std::sync::Arc::clone(&directory), next_id)?;
    output
        .write_all(content.as_bytes())
        .map_err(|error| format!("write failed: {error}"))?;
    output
        .set_permissions(original_permissions)
        .map_err(|error| format!("set permissions failed: {error}"))?;
    output
        .sync_all()
        .map_err(|error| format!("sync failed: {error}"))?;
    drop(output);

    if !directory_handle_matches_path(&directory, parent)
        .map_err(|error| format!("verify parent directory failed: {error}"))?
    {
        return Err("parent directory changed during save".to_string());
    }

    // Both names are interpreted relative to the verified directory handle,
    // so a concurrent ancestor rename/symlink swap cannot redirect the write.
    let rename_result = unsafe {
        libc::renameat(
            directory.as_raw_fd(),
            staging.name.as_ptr(),
            directory.as_raw_fd(),
            file_name_c.as_ptr(),
        )
    };
    if rename_result != 0 {
        return Err(format!("rename failed: {}", io::Error::last_os_error()));
    }
    staging.armed = false;

    // The file was already atomically committed. Some network/FileProvider
    // directories reject fsync, so keep the prior best-effort durability
    // semantics and never report a false post-commit failure.
    let _ = directory.sync_all();
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
struct PathTextWriteStage {
    path: PathBuf,
    armed: bool,
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
impl Drop for PathTextWriteStage {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn write_text_file_atomic_with_stage_ids(
    file: &Path,
    content: &str,
    mut next_id: impl FnMut() -> u64,
) -> Result<(), String> {
    let parent = file.parent().ok_or("invalid file path")?;
    let original_permissions = fs::metadata(file)
        .map_err(|error| format!("metadata failed: {error}"))?
        .permissions();
    const MAX_ATTEMPTS: usize = 128;
    let (mut staging, mut output) = (0..MAX_ATTEMPTS)
        .find_map(|_| {
            let path = parent.join(text_write_stage_name(next_id()));
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => Some(Ok((PathTextWriteStage { path, armed: true }, file))),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => None,
                Err(error) => Some(Err(format!("create staging file failed: {error}"))),
            }
        })
        .transpose()?
        .ok_or_else(|| "could not create a unique text-write staging file".to_string())?;
    output
        .write_all(content.as_bytes())
        .map_err(|error| format!("write failed: {error}"))?;
    output
        .set_permissions(original_permissions)
        .map_err(|error| format!("set permissions failed: {error}"))?;
    output
        .sync_all()
        .map_err(|error| format!("sync failed: {error}"))?;
    drop(output);
    fs::rename(&staging.path, file).map_err(|error| format!("rename failed: {error}"))?;
    staging.armed = false;
    let _ = File::open(parent).and_then(|directory| directory.sync_all());
    Ok(())
}

#[tauri::command]
pub fn write_text_file(root: String, path: String, content: String) -> Result<(), String> {
    let root = Path::new(&root);
    let path = Path::new(&path);
    let file = ensure_within_root(root, path)?;
    if !file.is_file() {
        return Err("not a file".to_string());
    }

    write_text_file_atomic_with_stage_ids(&file, &content, || {
        NEXT_TEXT_WRITE_STAGE_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    })
}

#[tauri::command]
pub fn create_file(root: String, path: String) -> Result<(), String> {
    if has_forbidden_terminal_component(&path) {
        return Err("invalid file path".to_string());
    }
    let root = Path::new(&root);
    let path = Path::new(&path);
    let (_, canon_parent) = ensure_parent_within_root(root, path)?;
    let name = path.file_name().ok_or_else(|| "missing file name".to_string())?;
    let target = canon_parent.join(name);
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                "file already exists".to_string()
            } else {
                format!("create failed: {error}")
            }
        })?;
    Ok(())
}

#[tauri::command]
pub fn create_directory(root: String, path: String) -> Result<(), String> {
    if has_forbidden_terminal_component(&path) {
        return Err("invalid directory path".to_string());
    }
    let root = Path::new(&root);
    let path = Path::new(&path);
    let (_, canon_parent) = ensure_parent_within_root(root, path)?;
    let name = path.file_name().ok_or_else(|| "missing directory name".to_string())?;
    let target = canon_parent.join(name);
    fs::create_dir(&target).map_err(|error| {
        if error.kind() == io::ErrorKind::AlreadyExists {
            "directory already exists".to_string()
        } else {
            format!("create failed: {error}")
        }
    })?;
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

fn has_forbidden_terminal_component(raw_path: &str) -> bool {
    raw_path
        .rsplit(std::path::is_separator)
        .find(|component| !component.is_empty())
        .is_some_and(|component| component == "." || component == "..")
}

#[tauri::command]
pub fn rename_fs_entry(root: String, path: String, new_name: String) -> Result<String, String> {
    if has_forbidden_terminal_component(&path) {
        return Err("invalid source path".to_string());
    }
    let root = Path::new(&root);
    let path = Path::new(&path);
    let (canon_root, canon_parent) = ensure_parent_within_root(root, path)?;
    let source_name = path
        .file_name()
        .ok_or_else(|| "missing file name".to_string())?;
    let from = canon_parent.join(source_name);
    if from == canon_root {
        return Err("cannot rename root".to_string());
    }

    let name = new_name.as_str();
    if name.is_empty() {
        return Err("missing new name".to_string());
    }
    if name == "." || name == ".." {
        return Err("invalid name".to_string());
    }
    if name.chars().any(std::path::is_separator) {
        return Err("name must not contain path separators".to_string());
    }
    if name.contains('\0') {
        return Err("name must not contain NUL".to_string());
    }

    let to = canon_parent.join(name);
    let returned_path = path
        .parent()
        .ok_or_else(|| "missing parent directory".to_string())?
        .join(name);
    let to_utf8 = path_to_utf8(&returned_path)?;
    fs::symlink_metadata(&from).map_err(|e| format!("metadata failed: {e}"))?;

    if from == to {
        return Ok(to_utf8);
    }

    rename_in_same_directory_no_replace(&canon_parent, source_name, OsStr::new(name)).map_err(|error| {
        if error.kind() == io::ErrorKind::AlreadyExists {
            "target already exists".to_string()
        } else {
            format!("rename failed: {error}")
        }
    })?;
    Ok(to_utf8)
}

#[tauri::command]
pub fn delete_fs_entry(root: String, path: String) -> Result<(), String> {
    if has_forbidden_terminal_component(&path) {
        return Err("invalid target path".to_string());
    }
    let root = Path::new(&root);
    let path = Path::new(&path);
    let (canon_root, canon_parent) = ensure_parent_within_root(root, path)?;
    let name = path
        .file_name()
        .ok_or_else(|| "missing target name".to_string())?;
    let requested_target = canon_parent.join(name);
    let meta = fs::symlink_metadata(&requested_target).map_err(|e| format!("metadata failed: {e}"))?;
    let target = if meta.file_type().is_symlink() {
        requested_target
    } else {
        canonicalize_existing(&requested_target)?
    };
    if target == canon_root {
        return Err("cannot delete root".to_string());
    }
    if !target.starts_with(&canon_root) {
        return Err("path is outside root".to_string());
    }

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
    let root = Path::new(&root);
    let source = Path::new(&source_path);
    let dest = Path::new(&dest_path);

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
    use std::{
        path::Path,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static TEST_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock must be after Unix epoch")
                .as_nanos();
            let counter = TEST_DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "agents-ui-files-{label}-{}-{unique}-{counter}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("create isolated test directory");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn utf8_path(&self) -> String {
            path_to_utf8(self.path()).expect("test directory path must be UTF-8")
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn result_error<T>(result: Result<T, String>) -> String {
        match result {
            Ok(_) => panic!("expected command to fail"),
            Err(error) => error,
        }
    }

    fn text_write_stages(parent: &Path) -> Vec<PathBuf> {
        fs::read_dir(parent)
            .expect("read staging parent")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with(".agents-ui-write-stage-"))
            })
            .map(|entry| entry.path())
            .collect()
    }

    fn kind_of(sample: &[u8]) -> String {
        probe_from_sample(sample.len() as u64, None, sample, None).kind
    }

    fn kind_of_path(sample: &[u8], path: &str) -> String {
        probe_from_sample(sample.len() as u64, None, sample, Some(Path::new(path))).kind
    }

    #[test]
    fn detects_pdf_header() {
        let probe = probe_from_sample(2048, None, b"%PDF-1.7\n1 0 obj\n", None);
        assert_eq!(probe.kind, "pdf");
        assert_eq!(probe.mime.as_deref(), Some("application/pdf"));
    }

    #[test]
    fn detects_xlsx_zip_header_for_xlsx_paths() {
        let probe = probe_from_sample(
            4096,
            None,
            b"PK\x03\x04\x14\x00\x00\x00\x08\x00[Content_Types].xml",
            Some(Path::new("/tmp/report.xlsx")),
        );
        assert_eq!(probe.kind, "xlsx");
        assert_eq!(
            probe.mime.as_deref(),
            Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        );
    }

    #[test]
    fn zip_header_without_xlsx_extension_stays_binary() {
        assert_eq!(
            kind_of_path(b"PK\x03\x04\x14\x00\x00\x00\x08\x00", "/tmp/archive.zip"),
            "binary"
        );
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

    #[test]
    fn local_names_round_trip_case_and_unicode_exactly() {
        // The two cafe spellings are canonically equivalent but deliberately
        // use distinct NFC and NFD byte sequences. Never normalize either.
        let names = [
            "lowercase-folder",
            "MixedCase-ß",
            "目录-🚀",
            "café",
            "cafe\u{301}",
            "  surrounding spaces  ",
        ];

        for (index, name) in names.into_iter().enumerate() {
            let dir = TestDir::new(&format!("unicode-{index}"));
            let original = dir.path().join("original");
            fs::write(&original, b"content").expect("create source file");

            let renamed = rename_fs_entry(
                dir.utf8_path(),
                path_to_utf8(&original).expect("source path must be UTF-8"),
                name.to_string(),
            )
            .expect("rename Unicode file");
            let expected_rename =
                path_to_utf8(&dir.path().join(name)).expect("target path must be UTF-8");
            assert_eq!(renamed, expected_rename);

            let entries = list_fs_entries(dir.utf8_path(), dir.utf8_path())
                .expect("list Unicode filename");
            let canonical_dir = fs::canonicalize(dir.path()).expect("canonicalize test directory");
            let expected_listed =
                path_to_utf8(&canonical_dir.join(name)).expect("listed path must be UTF-8");
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].name.as_bytes(), name.as_bytes());
            assert_eq!(entries[0].path, expected_listed);

            let matches = search_fs_entries(dir.utf8_path(), name.to_string(), Some(10))
                .expect("search Unicode filename");
            assert_eq!(matches.len(), 1);
            assert_eq!(matches[0].name.as_bytes(), name.as_bytes());
            assert_eq!(matches[0].path, expected_listed);
        }
    }

    #[test]
    fn local_actions_preserve_edge_whitespace_exactly() {
        let dir = TestDir::new("edge-whitespace");
        let original = dir.path().join("original");
        fs::write(&original, b"content").expect("create source file");
        let exact_name = " leading and trailing ";

        let renamed = rename_fs_entry(
            dir.utf8_path(),
            path_to_utf8(&original).expect("source path must be UTF-8"),
            exact_name.to_string(),
        )
        .expect("rename exact whitespace name");
        assert_eq!(
            renamed,
            path_to_utf8(&dir.path().join(exact_name)).expect("target path must be UTF-8")
        );
        assert_eq!(
            read_text_file(dir.utf8_path(), renamed.clone()).expect("read exact renamed path"),
            "content"
        );
        delete_fs_entry(dir.utf8_path(), renamed).expect("delete exact renamed path");
        assert!(!dir.path().join(exact_name).exists());
    }

    #[test]
    fn concurrent_text_saves_publish_only_complete_unique_contents() {
        use std::sync::{Arc, Barrier};

        const WRITERS: usize = 8;
        let dir = TestDir::new("concurrent-text-save");
        let target = dir.path().join("document.txt");
        fs::write(&target, b"initial").expect("create text target");
        let root = dir.utf8_path();
        let target_utf8 = path_to_utf8(&target).expect("target path must be UTF-8");
        let barrier = Arc::new(Barrier::new(WRITERS + 1));
        let candidates = (0..WRITERS)
            .map(|index| format!("writer-{index}:{}", "x".repeat(128 * 1024)))
            .collect::<Vec<_>>();

        let writers = candidates
            .iter()
            .cloned()
            .map(|content| {
                let barrier = Arc::clone(&barrier);
                let root = root.clone();
                let target = target_utf8.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    write_text_file(root, target, content)
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        for writer in writers {
            writer
                .join()
                .expect("save worker must not panic")
                .expect("concurrent atomic save");
        }

        let published = fs::read_to_string(&target).expect("read published text");
        assert!(
            candidates.iter().any(|candidate| candidate == &published),
            "published text must be one complete writer payload"
        );
        assert!(text_write_stages(dir.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn text_save_never_follows_a_preplanted_staging_symlink() {
        use std::os::unix::fs::symlink;

        let dir = TestDir::new("text-save-stage-symlink");
        let target = dir.path().join("document.txt");
        let victim = dir.path().join("victim.txt");
        fs::write(&target, b"old").expect("create target");
        fs::write(&victim, b"must remain").expect("create victim");

        let planted_id = u64::MAX - 10;
        let planted = dir.path().join(text_write_stage_name(planted_id));
        symlink(&victim, &planted).expect("plant staging symlink");
        let mut ids = [planted_id, planted_id + 1].into_iter();
        let canonical_target = fs::canonicalize(&target).expect("canonicalize target");
        write_text_file_atomic_with_stage_ids(&canonical_target, "new content", || {
            ids.next().expect("staging allocator made too many attempts")
        })
        .expect("save must skip the planted entry safely");

        assert_eq!(fs::read(&victim).expect("read victim"), b"must remain");
        assert_eq!(fs::read(&target).expect("read target"), b"new content");
        assert!(
            fs::symlink_metadata(&planted)
                .expect("planted symlink remains")
                .file_type()
                .is_symlink()
        );
        assert!(!dir
            .path()
            .join(text_write_stage_name(planted_id + 1))
            .exists());
    }

    #[cfg(unix)]
    #[test]
    fn text_save_preserves_the_existing_permission_mode() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TestDir::new("text-save-mode");
        let target = dir.path().join("document.txt");
        fs::write(&target, b"old").expect("create target");
        fs::set_permissions(&target, fs::Permissions::from_mode(0o640))
            .expect("set original permissions");

        write_text_file(
            dir.utf8_path(),
            path_to_utf8(&target).expect("target path must be UTF-8"),
            "new".to_string(),
        )
        .expect("atomic save");

        assert_eq!(
            fs::metadata(&target)
                .expect("target metadata")
                .permissions()
                .mode()
                & 0o777,
            0o640
        );
    }

    #[cfg(unix)]
    #[test]
    fn local_actions_preserve_backslashes_as_literal_name_characters() {
        let dir = TestDir::new("literal-backslash");
        let source = dir.path().join("original");
        fs::write(&source, b"content").expect("create source file");
        let exact_name = "folder\\report";

        let renamed = rename_fs_entry(
            dir.utf8_path(),
            path_to_utf8(&source).expect("source path must be UTF-8"),
            exact_name.to_string(),
        )
        .expect("rename with a literal backslash");
        assert_eq!(
            renamed,
            path_to_utf8(&dir.path().join(exact_name)).expect("target path must be UTF-8")
        );
        assert_eq!(
            fs::read(dir.path().join(exact_name)).expect("read literal backslash filename"),
            b"content"
        );
    }

    #[test]
    fn local_create_never_clobbers_an_existing_file() {
        let dir = TestDir::new("exclusive-create");
        let target = dir.path().join("existing");
        fs::write(&target, b"keep me").expect("create existing target");

        assert_eq!(
            result_error(create_file(
                dir.utf8_path(),
                path_to_utf8(&target).expect("target path must be UTF-8"),
            )),
            "file already exists"
        );
        assert_eq!(fs::read(&target).expect("read existing target"), b"keep me");
    }

    #[test]
    fn local_create_commands_preserve_literal_names() {
        let dir = TestDir::new("literal-create");
        let names = [
            "lowercase",
            "MixedCase-ß",
            "目录-🚀",
            "café",
            "cafe\u{301}",
            "  surrounding spaces  ",
        ];

        for (index, name) in names.into_iter().enumerate() {
            let case_root = dir.path().join(format!("case-{index}"));
            fs::create_dir(&case_root).expect("create isolated literal-name case");
            let directory_name = format!("dir-{name}");
            let file_name = format!("file-{name}");
            create_directory(
                dir.utf8_path(),
                path_to_utf8(&case_root.join(&directory_name))
                    .expect("directory path must be UTF-8"),
            )
            .expect("create literal directory");
            create_file(
                dir.utf8_path(),
                path_to_utf8(&case_root.join(&file_name)).expect("file path must be UTF-8"),
            )
            .expect("create literal file");
            let case_root_utf8 = path_to_utf8(&case_root).expect("case root must be UTF-8");
            let entries = list_fs_entries(dir.utf8_path(), case_root_utf8)
                .expect("list literal creations");
            let listed_names = entries
                .iter()
                .map(|entry| entry.name.as_bytes().to_vec())
                .collect::<Vec<_>>();
            assert!(listed_names.contains(&directory_name.into_bytes()));
            assert!(listed_names.contains(&file_name.into_bytes()));
        }
    }

    #[cfg(unix)]
    #[test]
    fn local_create_and_rename_reject_dangling_symlink_targets() {
        use std::os::unix::fs::symlink;

        let dir = TestDir::new("dangling-target");
        let dangling = dir.path().join("dangling");
        symlink("missing-target", &dangling).expect("create dangling symlink");

        assert_eq!(
            result_error(create_file(
                dir.utf8_path(),
                path_to_utf8(&dangling).expect("symlink path must be UTF-8"),
            )),
            "file already exists"
        );
        assert_eq!(
            result_error(create_directory(
                dir.utf8_path(),
                path_to_utf8(&dangling).expect("symlink path must be UTF-8"),
            )),
            "directory already exists"
        );

        let source = dir.path().join("source");
        fs::write(&source, b"source data").expect("create rename source");
        assert_eq!(
            result_error(rename_fs_entry(
                dir.utf8_path(),
                path_to_utf8(&source).expect("source path must be UTF-8"),
                "dangling".to_string(),
            )),
            "target already exists"
        );
        assert_eq!(fs::read(&source).expect("source remains"), b"source data");
        assert_eq!(
            fs::read_link(&dangling).expect("dangling symlink remains"),
            PathBuf::from("missing-target")
        );
    }

    #[test]
    fn concurrent_local_renames_never_replace_each_other() {
        use std::sync::{Arc, Barrier};

        let dir = TestDir::new("rename-race");
        let first = dir.path().join("first");
        let second = dir.path().join("second");
        fs::write(&first, b"first data").expect("create first source");
        fs::write(&second, b"second data").expect("create second source");

        let root = dir.utf8_path();
        let barrier = Arc::new(Barrier::new(3));
        let spawn_rename = |source: PathBuf| {
            let root = root.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                rename_fs_entry(
                    root,
                    path_to_utf8(&source).expect("source path must be UTF-8"),
                    "winner".to_string(),
                )
            })
        };
        let first_result = spawn_rename(first.clone());
        let second_result = spawn_rename(second.clone());
        barrier.wait();
        let results = [
            first_result.join().expect("first rename thread"),
            second_result.join().expect("second rename thread"),
        ];

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter_map(|result| result.as_ref().err())
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["target already exists"]
        );
        let mut contents = vec![fs::read(dir.path().join("winner")).expect("read winner")];
        if first.exists() {
            contents.push(fs::read(&first).expect("read remaining first"));
        }
        if second.exists() {
            contents.push(fs::read(&second).expect("read remaining second"));
        }
        contents.sort();
        assert_eq!(contents, vec![b"first data".to_vec(), b"second data".to_vec()]);
    }

    #[test]
    fn local_case_only_rename_is_supported_without_overwrite() {
        let dir = TestDir::new("case-only");
        let source = dir.path().join("lowercase");
        fs::write(&source, b"content").expect("create lowercase source");

        let renamed = rename_fs_entry(
            dir.utf8_path(),
            path_to_utf8(&source).expect("source path must be UTF-8"),
            "LowerCase".to_string(),
        )
        .expect("case-only rename");
        assert_eq!(
            renamed,
            path_to_utf8(&dir.path().join("LowerCase")).expect("renamed path must be UTF-8")
        );
        let entries = list_fs_entries(dir.utf8_path(), dir.utf8_path()).expect("list renamed file");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "LowerCase");
        assert_eq!(fs::read(dir.path().join("LowerCase")).expect("read renamed file"), b"content");
    }

    #[cfg(unix)]
    #[test]
    fn local_search_does_not_follow_directory_symlinks() {
        use std::os::unix::fs::symlink;

        let root = TestDir::new("search-root");
        let outside = TestDir::new("search-outside");
        fs::write(root.path().join("inside-target.txt"), b"inside")
            .expect("create inside target");
        symlink("inside-target.txt", root.path().join("inside-link.txt"))
            .expect("create internal file symlink");
        fs::write(outside.path().join("outside-match.txt"), b"outside")
            .expect("create outside file");
        symlink(outside.path(), root.path().join("outside-link"))
            .expect("create external directory symlink");
        symlink(root.path(), root.path().join("self-loop")).expect("create cycle symlink");

        let matches = search_fs_entries(root.utf8_path(), "outside-match".to_string(), Some(10))
            .expect("bounded rooted search");
        assert!(matches.is_empty());

        let matches = search_fs_entries(root.utf8_path(), "inside-link".to_string(), Some(10))
            .expect("search internal file symlink");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].name, "inside-link.txt");
        assert_eq!(matches[0].size, 6);
    }

    #[test]
    fn delete_rejects_dot_aliases_of_the_root() {
        let root = TestDir::new("delete-root-alias");
        fs::write(root.path().join("must-remain"), b"content").expect("create protected child");
        let root_path = root.utf8_path();

        assert_eq!(
            result_error(delete_fs_entry(root_path.clone(), format!("{root_path}/."))),
            "invalid target path"
        );
        let child_parent_alias = format!("{root_path}/child/..");
        fs::create_dir(root.path().join("child")).expect("create child directory");
        assert_eq!(
            result_error(delete_fs_entry(root_path.clone(), child_parent_alias)),
            "invalid target path"
        );
        assert_eq!(
            fs::read(root.path().join("must-remain")).expect("protected child remains"),
            b"content"
        );
    }

    #[cfg(unix)]
    #[test]
    fn local_listing_and_search_reject_non_utf8_names() {
        use std::os::unix::ffi::OsStringExt;

        let dir = TestDir::new("non-utf8");
        let invalid_name = std::ffi::OsString::from_vec(vec![b'b', b'a', b'd', 0xff]);
        assert_eq!(
            result_error(os_str_to_utf8(&invalid_name)),
            NON_UTF8_FILESYSTEM_PATH_ERROR
        );
        assert_eq!(
            result_error(path_to_utf8(Path::new(&invalid_name))),
            NON_UTF8_FILESYSTEM_PATH_ERROR
        );

        if let Err(error) = fs::write(dir.path().join(&invalid_name), b"content") {
            // Darwin rejects invalid UTF-8 at the filesystem boundary with
            // EILSEQ. The direct conversion assertions above still cover the
            // application's boundary on that platform; Unix filesystems that
            // accept arbitrary bytes continue through the command-level checks.
            if cfg!(target_os = "macos") && error.raw_os_error() == Some(92) {
                return;
            }
            panic!("create invalid-byte test filename: {error}");
        }

        assert_eq!(
            result_error(list_fs_entries(dir.utf8_path(), dir.utf8_path())),
            NON_UTF8_FILESYSTEM_PATH_ERROR
        );
        assert_eq!(
            result_error(search_fs_entries(dir.utf8_path(), "bad".to_string(), Some(10))),
            NON_UTF8_FILESYSTEM_PATH_ERROR
        );
    }
}
