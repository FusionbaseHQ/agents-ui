use serde::Deserialize;
use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

static NEXT_STAGING_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TextAssetInput {
    pub relative_path: String,
    pub content: String,
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(target_family = "unix")]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
    #[cfg(not(target_family = "unix"))]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
}

fn expand_home(input: &str) -> PathBuf {
    if input == "~" {
        return home_dir().unwrap_or_else(|| PathBuf::from(input));
    }
    if let Some(rest) = input.strip_prefix("~/") {
        if let Some(home) = home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(input)
}

fn validate_relative_path(input: &str) -> Result<PathBuf, String> {
    let rel = Path::new(input);
    if rel.as_os_str().is_empty() {
        return Err("empty relative path".to_string());
    }
    let final_text_component = input
        .rsplit(std::path::is_separator)
        .next()
        .unwrap_or(input);
    if final_text_component.is_empty()
        || final_text_component == "."
        || final_text_component == ".."
    {
        return Err(format!("relative path must end with a file name: {input}"));
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

fn path_to_utf8(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "filesystem path is not valid UTF-8".to_string())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AtomicWriteOutcome {
    Written,
    SkippedExisting,
}

struct StagingFile {
    #[cfg(any(test, not(any(target_os = "macos", target_os = "linux"))))]
    path: PathBuf,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    directory: Arc<fs::File>,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    name: std::ffi::CString,
    armed: bool,
}

impl StagingFile {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for StagingFile {
    fn drop(&mut self) {
        if self.armed {
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            unsafe {
                use std::os::fd::AsRawFd;
                libc::unlinkat(self.directory.as_raw_fd(), self.name.as_ptr(), 0);
            }
            #[cfg(not(any(target_os = "macos", target_os = "linux")))]
            let _ = fs::remove_file(&self.path);
        }
    }
}

struct ResolvedAssetTarget {
    path: PathBuf,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    directory: Arc<fs::File>,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    file_name: std::ffi::OsString,
}

fn staging_path(parent: &Path, id: u64) -> PathBuf {
    parent.join(format!(
        ".agents-ui-asset-stage-{}-{id}",
        std::process::id()
    ))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn os_name_to_c_string(name: &std::ffi::OsStr) -> io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;

    std::ffi::CString::new(name.as_bytes()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "filesystem name contains a NUL byte",
        )
    })
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn open_directory_no_follow(path: &Path) -> io::Result<fs::File> {
    use std::os::fd::FromRawFd;
    use std::os::unix::ffi::OsStrExt;

    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "filesystem path contains a NUL byte",
        )
    })?;
    let fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: open returned a new owned descriptor.
        Ok(unsafe { fs::File::from_raw_fd(fd) })
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn open_directory_componentwise_no_follow(path: &Path) -> io::Result<fs::File> {
    let mut directory = if path.is_absolute() {
        open_directory_no_follow(Path::new("/"))?
    } else {
        open_directory_no_follow(Path::new("."))?
    };

    for component in path.components() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(name) => {
                directory = open_child_directory_no_follow(&directory, name)?;
            }
            Component::ParentDir | Component::Prefix(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "directory path contains an unsupported component",
                ));
            }
        }
    }
    Ok(directory)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn open_child_directory_no_follow(
    parent: &fs::File,
    name: &std::ffi::OsStr,
) -> io::Result<fs::File> {
    use std::os::fd::{AsRawFd, FromRawFd};

    let name = os_name_to_c_string(name)?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: openat returned a new owned descriptor.
        Ok(unsafe { fs::File::from_raw_fd(fd) })
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn open_or_create_child_directory(
    parent: &fs::File,
    name: &std::ffi::OsStr,
) -> io::Result<fs::File> {
    use std::os::fd::AsRawFd;

    match open_child_directory_no_follow(parent, name) {
        Ok(directory) => return Ok(directory),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }

    let name_c = os_name_to_c_string(name)?;
    let created = unsafe { libc::mkdirat(parent.as_raw_fd(), name_c.as_ptr(), 0o777) };
    if created != 0 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::AlreadyExists {
            return Err(error);
        }
    }
    // A concurrent symlink or non-directory wins only an error here because
    // O_NOFOLLOW | O_DIRECTORY never follows it.
    open_child_directory_no_follow(parent, name)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn directory_handle_matches_path(directory: &fs::File, path: &Path) -> Result<bool, String> {
    use std::os::unix::fs::MetadataExt;

    let handle_metadata = directory
        .metadata()
        .map_err(|error| format!("inspect asset parent handle failed: {error}"))?;
    let path_metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("inspect asset parent path failed: {error}")),
    };
    if path_metadata.file_type().is_symlink() || !path_metadata.is_dir() {
        return Ok(false);
    }
    Ok(handle_metadata.dev() == path_metadata.dev() && handle_metadata.ino() == path_metadata.ino())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn verify_resolved_parent(target: &ResolvedAssetTarget) -> Result<(), String> {
    let parent = target.path.parent().ok_or("invalid target path")?;
    if directory_handle_matches_path(&target.directory, parent)? {
        Ok(())
    } else {
        Err("asset parent changed after it was verified".to_string())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn verify_resolved_parent(_target: &ResolvedAssetTarget) -> Result<(), String> {
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn create_staging_file_for_target_with_ids(
    target: &ResolvedAssetTarget,
    mut next_id: impl FnMut() -> u64,
) -> Result<(StagingFile, fs::File), String> {
    use std::os::fd::{AsRawFd, FromRawFd};

    const MAX_ATTEMPTS: usize = 128;
    let parent = target.path.parent().ok_or("invalid target path")?;
    for _ in 0..MAX_ATTEMPTS {
        let path = staging_path(parent, next_id());
        let name = path
            .file_name()
            .ok_or_else(|| "invalid staging path".to_string())?;
        let name = os_name_to_c_string(name)
            .map_err(|error| format!("create staging file failed: {error}"))?;
        let fd = unsafe {
            libc::openat(
                target.directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY
                    | libc::O_CREAT
                    | libc::O_EXCL
                    | libc::O_NOFOLLOW
                    | libc::O_CLOEXEC,
                // Preserve the prior OpenOptions create mode: ordinary asset
                // files are 0666 subject to the user's umask.
                0o666,
            )
        };
        if fd >= 0 {
            // SAFETY: openat returned a new owned descriptor.
            let file = unsafe { fs::File::from_raw_fd(fd) };
            return Ok((
                StagingFile {
                    #[cfg(test)]
                    path,
                    directory: Arc::clone(&target.directory),
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
    Err("could not create a unique staging file".to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn create_staging_file_for_target_with_ids(
    target: &ResolvedAssetTarget,
    mut next_id: impl FnMut() -> u64,
) -> Result<(StagingFile, fs::File), String> {
    let parent = target.path.parent().ok_or("invalid target path")?;
    const MAX_ATTEMPTS: usize = 128;
    for _ in 0..MAX_ATTEMPTS {
        let path = staging_path(parent, next_id());
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => {
                return Ok((
                    StagingFile {
                        path,
                        armed: true,
                    },
                    file,
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("create staging file failed: {error}")),
        }
    }
    Err("could not create a unique staging file".to_string())
}

#[cfg(test)]
fn resolved_target_in_existing_parent(path: &Path) -> Result<ResolvedAssetTarget, String> {
    let parent = path.parent().ok_or("invalid target path")?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "invalid target path".to_string())?;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let canonical_parent = fs::canonicalize(parent)
            .map_err(|error| format!("resolve asset parent failed: {error}"))?;
        let directory = open_directory_componentwise_no_follow(&canonical_parent)
            .map_err(|error| format!("open asset parent failed: {error}"))?;
        Ok(ResolvedAssetTarget {
            path: path.to_path_buf(),
            directory: Arc::new(directory),
            file_name: file_name.to_os_string(),
        })
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = file_name;
        Ok(ResolvedAssetTarget {
            path: path.to_path_buf(),
        })
    }
}

#[cfg(test)]
fn create_staging_file_with_ids(
    parent: &Path,
    next_id: impl FnMut() -> u64,
) -> Result<(StagingFile, fs::File), String> {
    let placeholder = resolved_target_in_existing_parent(&parent.join("placeholder"))?;
    create_staging_file_for_target_with_ids(&placeholder, next_id)
}

#[cfg(test)]
fn create_staging_file(parent: &Path) -> Result<(StagingFile, fs::File), String> {
    create_staging_file_with_ids(parent, || {
        NEXT_STAGING_ID.fetch_add(1, Ordering::Relaxed)
    })
}

#[cfg(target_family = "windows")]
fn rename_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(any(
    target_family = "windows",
    target_os = "macos",
    target_os = "linux"
)))]
fn rename_replace(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn target_entry_kind(target: &ResolvedAssetTarget) -> io::Result<Option<bool>> {
    use std::os::fd::AsRawFd;

    let name = os_name_to_c_string(&target.file_name)?;
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    let result = unsafe {
        libc::fstatat(
            target.directory.as_raw_fd(),
            name.as_ptr(),
            metadata.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result == 0 {
        // SAFETY: fstatat initialized metadata after returning success.
        let metadata = unsafe { metadata.assume_init() };
        Ok(Some((metadata.st_mode & libc::S_IFMT) == libc::S_IFDIR))
    } else {
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(error)
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn target_entry_kind(target: &ResolvedAssetTarget) -> io::Result<Option<bool>> {
    match fs::symlink_metadata(&target.path) {
        Ok(metadata) => Ok(Some(metadata.is_dir())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn rename_staging_at(
    staging: &StagingFile,
    target: &ResolvedAssetTarget,
    overwrite: bool,
) -> io::Result<()> {
    use std::os::fd::AsRawFd;

    let destination = os_name_to_c_string(&target.file_name)?;
    let source_fd = staging.directory.as_raw_fd();
    let destination_fd = target.directory.as_raw_fd();
    let result = if overwrite {
        unsafe {
            libc::renameat(
                source_fd,
                staging.name.as_ptr(),
                destination_fd,
                destination.as_ptr(),
            )
        }
    } else {
        #[cfg(target_os = "macos")]
        unsafe {
            libc::renameatx_np(
                source_fd,
                staging.name.as_ptr(),
                destination_fd,
                destination.as_ptr(),
                libc::RENAME_EXCL,
            )
        }
        #[cfg(target_os = "linux")]
        unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                source_fd,
                staging.name.as_ptr(),
                destination_fd,
                destination.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        }
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(test)]
fn publish_staging_file(
    staging: &mut StagingFile,
    destination: &Path,
    overwrite: bool,
) -> Result<AtomicWriteOutcome, String> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let target = {
        if staging.path.parent() != destination.parent() {
            return Err("staging and destination parents differ".to_string());
        }
        ResolvedAssetTarget {
            path: destination.to_path_buf(),
            directory: Arc::clone(&staging.directory),
            file_name: destination
                .file_name()
                .ok_or("invalid destination path")?
                .to_os_string(),
        }
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let target = ResolvedAssetTarget {
        path: destination.to_path_buf(),
    };
    publish_staging_file_for_target(staging, &target, overwrite)
}

fn publish_staging_file_for_target(
    staging: &mut StagingFile,
    target: &ResolvedAssetTarget,
    overwrite: bool,
) -> Result<AtomicWriteOutcome, String> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let result = rename_staging_at(staging, target, overwrite);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let result = if overwrite {
        rename_replace(&staging.path, &target.path)
    } else {
        crate::files::rename_no_replace(&staging.path, &target.path)
    };

    match result {
        Ok(()) => {
            staging.disarm();
            Ok(AtomicWriteOutcome::Written)
        }
        Err(error)
            if !overwrite
                && (error.kind() == io::ErrorKind::AlreadyExists
                    || target_entry_kind(target).ok().flatten().is_some()) =>
        {
            Ok(AtomicWriteOutcome::SkippedExisting)
        }
        Err(error) => Err(format!("publish failed: {error}")),
    }
}

#[cfg(test)]
fn write_text_file_atomic(
    path: &Path,
    content: &str,
    overwrite: bool,
) -> Result<AtomicWriteOutcome, String> {
    let target = resolved_target_in_existing_parent(path)?;
    write_text_file_atomic_for_target(&target, content, overwrite)
}

fn write_text_file_atomic_for_target(
    target: &ResolvedAssetTarget,
    content: &str,
    overwrite: bool,
) -> Result<AtomicWriteOutcome, String> {
    write_text_file_atomic_for_target_with_hook(target, content, overwrite, || {})
}

fn write_text_file_atomic_for_target_with_hook(
    target: &ResolvedAssetTarget,
    content: &str,
    overwrite: bool,
    before_publish: impl FnOnce(),
) -> Result<AtomicWriteOutcome, String> {
    verify_resolved_parent(target)?;
    let (mut staging, mut file) = create_staging_file_for_target_with_ids(target, || {
        NEXT_STAGING_ID.fetch_add(1, Ordering::Relaxed)
    })?;

    let write_result = file
        .write_all(content.as_bytes())
        .map_err(|e| format!("write failed: {e}"))
        .and_then(|()| file.sync_all().map_err(|e| format!("sync failed: {e}")));
    drop(file);
    write_result?;

    before_publish();
    // Detect deterministic swaps before publish. Even if a swap races this
    // check, the rename remains confined to the already-open directory handle.
    verify_resolved_parent(target)?;
    let outcome = publish_staging_file_for_target(&mut staging, target, overwrite)?;

    // Ensure the directory entry for the rename is durable using the same
    // anchored handle; never re-resolve the pathname for durability. Directory
    // fsync is best-effort because some FUSE/FileProvider volumes reject it
    // after the rename has already committed. Reporting that as a failed write
    // would invite a misleading retry and leave a partially reported batch.
    if outcome == AtomicWriteOutcome::Written {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let _ = target.directory.sync_all();
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let parent = target.path.parent().ok_or("invalid target path")?;
            let _ = fs::File::open(parent).and_then(|directory| directory.sync_all());
        }
    }
    verify_resolved_parent(target)?;
    Ok(outcome)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn ensure_directory_component(path: &Path) -> Result<(), String> {
    const MAX_CREATE_RACE_RETRIES: usize = 8;
    for _ in 0..MAX_CREATE_RACE_RETRIES {
        match fs::symlink_metadata(path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(format!(
                        "asset path contains a symbolic link: {}",
                        path_to_utf8(path)?
                    ));
                }
                if !metadata.is_dir() {
                    return Err(format!(
                        "asset parent is not a directory: {}",
                        path_to_utf8(path)?
                    ));
                }
                return Ok(());
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                match fs::create_dir(path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(format!("create dir failed: {error}")),
                }
                // Re-read after creation so a racing symlink or non-directory
                // entry is rejected rather than followed by the file create.
            }
            Err(error) => return Err(format!("inspect asset parent failed: {error}")),
        }
    }
    Err("asset parent changed repeatedly while it was being created".to_string())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn resolve_asset_target(
    canonical_base: &Path,
    rel: &Path,
) -> Result<ResolvedAssetTarget, String> {
    let normal_components = rel
        .components()
        .filter_map(|component| match component {
            Component::Normal(name) => Some(name),
            Component::CurDir => None,
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => None,
        })
        .collect::<Vec<_>>();
    let (file_name, parent_components) = normal_components
        .split_last()
        .ok_or_else(|| "asset path must name a file".to_string())?;
    let base_directory = open_directory_componentwise_no_follow(canonical_base)
        .map_err(|error| format!("open asset base failed: {error}"))?;
    if !directory_handle_matches_path(&base_directory, canonical_base)? {
        return Err("asset base changed while it was being opened".to_string());
    }
    let mut directory = Arc::new(base_directory);
    let mut parent_path = canonical_base.to_path_buf();

    for component in parent_components {
        let child = open_or_create_child_directory(&directory, component).map_err(|error| {
            format!(
                "asset parent component could not be opened without following a symbolic link: {error}"
            )
        })?;
        parent_path.push(component);
        directory = Arc::new(child);
    }

    let target = ResolvedAssetTarget {
        path: parent_path.join(file_name),
        directory,
        file_name: (*file_name).to_os_string(),
    };
    verify_resolved_parent(&target)?;
    Ok(target)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn resolve_asset_target(
    canonical_base: &Path,
    rel: &Path,
) -> Result<ResolvedAssetTarget, String> {
    let normal_components = rel
        .components()
        .filter_map(|component| match component {
            Component::Normal(name) => Some(name),
            Component::CurDir => None,
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => None,
        })
        .collect::<Vec<_>>();
    let (file_name, parent_components) = normal_components
        .split_last()
        .ok_or_else(|| "asset path must name a file".to_string())?;
    let mut parent = canonical_base.to_path_buf();

    for component in parent_components {
        parent.push(component);
        ensure_directory_component(&parent)?;
        let actual_parent = fs::canonicalize(&parent)
            .map_err(|e| format!("resolve asset parent failed: {e}"))?;
        if !actual_parent.starts_with(canonical_base) {
            return Err("asset parent resolves outside the base directory".to_string());
        }
        parent = actual_parent;
    }

    let actual_parent = fs::canonicalize(&parent)
        .map_err(|e| format!("resolve asset parent failed: {e}"))?;
    if !actual_parent.starts_with(canonical_base) {
        return Err("asset parent resolves outside the base directory".to_string());
    }
    Ok(ResolvedAssetTarget {
        path: actual_parent.join(file_name),
    })
}

#[tauri::command]
pub fn apply_text_assets(
    base_dir: String,
    assets: Vec<TextAssetInput>,
    overwrite: bool,
) -> Result<Vec<String>, String> {
    let base_dir = expand_home(&base_dir);
    if base_dir.as_os_str().is_empty() {
        return Err("missing base directory".to_string());
    }

    let base = base_dir;
    if !base.is_dir() {
        return Err("base directory is not a folder".to_string());
    }
    let canonical_base =
        fs::canonicalize(&base).map_err(|e| format!("resolve base directory failed: {e}"))?;

    let mut written: Vec<String> = Vec::new();
    for asset in assets {
        let rel = validate_relative_path(&asset.relative_path)?;
        let response_target = base.join(&rel);
        // Validate the IPC response representation before creating anything,
        // so an unrepresentable path cannot produce a successful write followed
        // by an error while serializing the result.
        let target_utf8 = path_to_utf8(&response_target)?;
        let target = resolve_asset_target(&canonical_base, &rel)?;

        verify_resolved_parent(&target)?;
        match target_entry_kind(&target)
            .map_err(|error| format!("inspect asset target failed: {error}"))?
        {
            Some(_) if !overwrite => continue,
            Some(true) => {
                return Err(format!(
                    "target exists and is a directory: {}",
                    target_utf8
                ));
            }
            Some(false) | None => {}
        }

        if write_text_file_atomic_for_target(&target, &asset.content, overwrite)?
            == AtomicWriteOutcome::Written
        {
            written.push(target_utf8);
        }
    }

    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::{
        apply_text_assets, create_staging_file, create_staging_file_with_ids, expand_home,
        publish_staging_file, staging_path, validate_relative_path, write_text_file_atomic,
        AtomicWriteOutcome, TextAssetInput,
    };
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    use super::{resolve_asset_target, write_text_file_atomic_for_target_with_hook};
    use std::io::Write;
    use std::sync::{Arc, Barrier};

    fn unique_test_path(label: &str) -> std::path::PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "agents-ui-assets-{label}-{}-{unique}",
            std::process::id()
        ))
    }

    fn assert_no_staging_files(parent: &std::path::Path) {
        let staging_files = std::fs::read_dir(parent)
            .expect("read test directory")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .map(|name| name.starts_with(".agents-ui-asset-stage-"))
                    .unwrap_or(false)
            })
            .collect::<Vec<_>>();
        assert!(
            staging_files.is_empty(),
            "staging files were not cleaned up: {staging_files:?}"
        );
    }

    #[test]
    fn asset_paths_preserve_unicode_case_and_edge_whitespace() {
        let parent = unique_test_path("literal");
        let base = parent.join("  base-目录  ");
        std::fs::create_dir_all(&base).expect("create exact base directory");
        let base_string = base.to_str().expect("test path is UTF-8").to_string();
        let exact_relative = "  lowerCase-ß-cafe\u{301}-🚀  ";

        let written = apply_text_assets(
            base_string,
            vec![TextAssetInput {
                relative_path: exact_relative.to_string(),
                content: "literal".to_string(),
            }],
            false,
        )
        .expect("write exact asset path");

        let expected = base.join(exact_relative);
        assert_eq!(written, vec![expected.to_str().unwrap().to_string()]);
        assert_eq!(std::fs::read_to_string(expected).unwrap(), "literal");
        std::fs::remove_dir_all(parent).expect("remove asset test directory");
    }

    #[test]
    fn asset_path_helpers_do_not_normalize_literal_whitespace() {
        assert_eq!(expand_home("  relative  "), std::path::PathBuf::from("  relative  "));
        assert_eq!(
            validate_relative_path("   ").expect("whitespace is a valid name"),
            std::path::PathBuf::from("   ")
        );
    }

    #[test]
    fn asset_path_must_end_in_a_normal_file_name() {
        let parent = unique_test_path("terminal-component");
        let base = parent.join("base");
        std::fs::create_dir_all(&base).expect("create base");

        for invalid in [".", "foo/.", "foo/"] {
            assert!(
                validate_relative_path(invalid).is_err(),
                "{invalid:?} must not be reinterpreted as another file name"
            );
            let error = apply_text_assets(
                base.to_str().unwrap().to_string(),
                vec![TextAssetInput {
                    relative_path: invalid.to_string(),
                    content: "content".to_string(),
                }],
                true,
            )
            .expect_err("terminal dot or separator must be rejected");
            assert!(
                error.contains("must end with a file name"),
                "unexpected error for {invalid:?}: {error}"
            );
        }

        assert!(!base.join("foo").exists());
        std::fs::remove_dir_all(parent).expect("remove test directory");
    }

    #[test]
    fn no_overwrite_publish_preserves_an_existing_file() {
        let parent = unique_test_path("no-clobber");
        std::fs::create_dir_all(&parent).expect("create test directory");
        let target = parent.join("asset.txt");
        std::fs::write(&target, "original").expect("create original target");

        let outcome = write_text_file_atomic(&target, "replacement", false)
            .expect("existing destination is a successful skip");

        assert_eq!(outcome, AtomicWriteOutcome::SkippedExisting);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "original");
        assert_no_staging_files(&parent);
        std::fs::remove_dir_all(parent).expect("remove test directory");
    }

    #[test]
    fn concurrent_no_overwrite_publish_has_exactly_one_winner() {
        const WRITERS: usize = 8;
        let parent = unique_test_path("publish-race");
        std::fs::create_dir_all(&parent).expect("create test directory");
        let target = Arc::new(parent.join("asset.txt"));
        let publish_barrier = Arc::new(Barrier::new(WRITERS));

        let writers = (0..WRITERS)
            .map(|index| {
                let target = Arc::clone(&target);
                let publish_barrier = Arc::clone(&publish_barrier);
                std::thread::spawn(move || {
                    let content = format!("writer-{index}");
                    let parent = target.parent().expect("target parent");
                    let (mut staging, mut file) =
                        create_staging_file(parent).expect("create unique staging file");
                    file.write_all(content.as_bytes()).expect("write staging file");
                    file.sync_all().expect("sync staging file");
                    drop(file);
                    publish_barrier.wait();
                    let outcome = publish_staging_file(&mut staging, &target, false)
                        .expect("publish or deterministic collision");
                    (outcome, content)
                })
            })
            .collect::<Vec<_>>();

        let results = writers
            .into_iter()
            .map(|writer| writer.join().expect("writer did not panic"))
            .collect::<Vec<_>>();
        let winners = results
            .iter()
            .filter(|(outcome, _)| *outcome == AtomicWriteOutcome::Written)
            .collect::<Vec<_>>();

        assert_eq!(winners.len(), 1);
        assert_eq!(
            std::fs::read_to_string(&*target).unwrap(),
            winners[0].1,
            "a losing writer must never replace the winner"
        );
        assert_eq!(
            results
                .iter()
                .filter(|(outcome, _)| *outcome == AtomicWriteOutcome::SkippedExisting)
                .count(),
            WRITERS - 1
        );
        assert_no_staging_files(&parent);
        std::fs::remove_dir_all(parent).expect("remove test directory");
    }

    #[test]
    fn overwrite_atomically_replaces_the_existing_file() {
        let parent = unique_test_path("overwrite");
        std::fs::create_dir_all(&parent).expect("create test directory");
        let target = parent.join("asset.txt");
        std::fs::write(&target, "old").expect("create original target");

        let outcome = write_text_file_atomic(&target, "new", true).expect("replace target");

        assert_eq!(outcome, AtomicWriteOutcome::Written);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
        assert_no_staging_files(&parent);
        std::fs::remove_dir_all(parent).expect("remove test directory");
    }

    #[test]
    fn failed_publish_removes_its_staging_file() {
        let parent = unique_test_path("cleanup");
        std::fs::create_dir_all(&parent).expect("create test directory");
        let target = parent.join("directory-target");
        std::fs::create_dir(&target).expect("create directory target");

        let error = write_text_file_atomic(&target, "content", true)
            .expect_err("a file cannot replace a directory");

        assert!(error.contains("publish failed"), "unexpected error: {error}");
        assert!(target.is_dir());
        assert_no_staging_files(&parent);
        std::fs::remove_dir_all(parent).expect("remove test directory");
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn preplanted_staging_symlink_is_not_followed() {
        use std::os::unix::fs::symlink;

        let parent = unique_test_path("staging-symlink");
        std::fs::create_dir_all(&parent).expect("create test directory");
        let victim = parent.join("victim.txt");
        std::fs::write(&victim, "untouched").expect("create victim");
        let planted_id = 41;
        let usable_id = 42;
        let planted_path = staging_path(&parent, planted_id);
        symlink(&victim, &planted_path).expect("plant staging symlink");
        let mut ids = [planted_id, usable_id].into_iter();

        let (staging, mut file) = create_staging_file_with_ids(&parent, || {
            ids.next().expect("helper retried too many times")
        })
        .expect("skip the planted staging name");
        assert_eq!(staging.path, staging_path(&parent, usable_id));
        file.write_all(b"staged").expect("write safe staging file");
        file.sync_all().expect("sync safe staging file");
        drop(file);
        drop(staging);

        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "untouched");
        assert!(planted_path.is_symlink());
        std::fs::remove_dir_all(parent).expect("remove test directory");
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn symlinked_asset_parent_cannot_escape_the_base() {
        use std::os::unix::fs::symlink;

        let parent = unique_test_path("parent-symlink");
        let base = parent.join("base");
        let outside = parent.join("outside");
        std::fs::create_dir_all(&base).expect("create base");
        std::fs::create_dir_all(&outside).expect("create outside directory");
        symlink(&outside, base.join("link")).expect("create escaping symlink");

        let error = apply_text_assets(
            base.to_str().unwrap().to_string(),
            vec![TextAssetInput {
                relative_path: "link/escaped.txt".to_string(),
                content: "must not escape".to_string(),
            }],
            true,
        )
        .expect_err("symlinked parent must be rejected");

        assert!(
            error.contains("symbolic link") || error.contains("outside the base"),
            "unexpected error: {error}"
        );
        assert!(!outside.join("escaped.txt").exists());
        assert_no_staging_files(&base);
        std::fs::remove_dir_all(parent).expect("remove test directory");
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn parent_swap_after_staging_cannot_escape_and_cleans_anchored_stage() {
        use std::os::unix::fs::symlink;

        let root = unique_test_path("parent-swap-race");
        let base = root.join("base");
        let original_parent = base.join("nested");
        let moved_parent = root.join("verified-parent-moved");
        let outside = root.join("outside");
        std::fs::create_dir_all(&original_parent).expect("create verified parent");
        std::fs::create_dir_all(&outside).expect("create outside directory");
        let canonical_base = std::fs::canonicalize(&base).expect("canonicalize base");
        let target = resolve_asset_target(
            &canonical_base,
            std::path::Path::new("nested/asset.txt"),
        )
        .expect("resolve target to an anchored parent");

        let error = write_text_file_atomic_for_target_with_hook(
            &target,
            "must remain confined",
            true,
            || {
                std::fs::rename(&original_parent, &moved_parent)
                    .expect("move verified parent after staging");
                symlink(&outside, &original_parent).expect("replace parent path with symlink");
            },
        )
        .expect_err("changed parent path must fail closed");

        assert!(error.contains("parent changed"), "unexpected error: {error}");
        assert!(!outside.join("asset.txt").exists());
        assert!(!moved_parent.join("asset.txt").exists());
        assert_no_staging_files(&moved_parent);
        std::fs::remove_dir_all(root).expect("remove race test directory");
    }
}
