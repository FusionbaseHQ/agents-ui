use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant};

use serde::Serialize;
use rand_core::{OsRng, RngCore};
use tauri::ipc::Channel;

use crate::files::{
    probe_from_sample, rename_no_replace, FileProbe, FsEntry, MAX_RANGE_READ_BYTES, PROBE_BYTES,
};

const MAX_TEXT_FILE_BYTES: usize = 2 * 1024 * 1024;
const BINARY_CHECK_BYTES: usize = 8 * 1024;
const MAX_REMOTE_FILE_SEARCH_RESULTS: usize = 1_000;
/// How many times an ssh/sftp op (or master-establish) is retried when it hits a
/// transient transport error before giving up.
const SSH_OP_ATTEMPTS: usize = 3;
const MAX_ACTIVE_SSH_SHORT_OPS: usize = 8;
const MAX_DEFERRED_SSH_CHILDREN: usize = 8;
const SSH_COMMAND_STDOUT_LIMIT: usize = 16 * 1024 * 1024;
const SFTP_LIST_STDOUT_LIMIT: usize = 8 * 1024 * 1024;
const SSH_COMMAND_RUNTIME_LIMIT: Duration = Duration::from_secs(120);
const SSH_FS_QUERY_RUNTIME_LIMIT: Duration = Duration::from_secs(30);
const SSH_CONTROL_RUNTIME_LIMIT: Duration = Duration::from_secs(5);
const MAX_REMOTE_DIRECTORY_ENTRIES: usize = 10_000;
#[cfg(test)]
const REMOTE_DIRECTORY_FRAME_MAGIC: &[u8] = b"AGENTS_UI_FS_V1";
#[cfg(test)]
const REMOTE_SEARCH_FRAME_MAGIC: &[u8] = b"AGENTS_UI_SEARCH_V1";
#[cfg(test)]
const REMOTE_FRAME_TRAILER: &[u8] = b"Z";
const MAX_ACTIVE_SCP_PROCESSES: usize = 6;
const MAX_ACTIVE_DOWNLOADS: usize = 4;
const SCP_DIAGNOSTIC_TAIL_BYTES: usize = 64 * 1024;
const SCP_POLL_INTERVAL: Duration = Duration::from_millis(125);
const SCP_PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const SCP_DIRECTORY_PROGRESS_INTERVAL: Duration = Duration::from_secs(2);
const SCP_DIRECTORY_SCAN_ENTRY_LIMIT: usize = 2_000;

fn find_program_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(target_family = "windows")]
        {
            let exe = dir.join(format!("{name}.exe"));
            if exe.is_file() {
                return Some(exe);
            }
        }
    }
    None
}

fn find_program_in_common_locations(name: &str) -> Option<PathBuf> {
    #[cfg(target_family = "windows")]
    {
        let candidates = [std::env::var_os("WINDIR").map(|w| {
            PathBuf::from(w)
                .join("System32")
                .join("OpenSSH")
                .join(format!("{name}.exe"))
        })];
        for c in candidates.into_iter().flatten() {
            if c.is_file() {
                return Some(c);
            }
        }
        return None;
    }

    #[cfg(not(target_family = "windows"))]
    {
        let candidates = [
            Path::new("/usr/bin").join(name),
            Path::new("/bin").join(name),
            Path::new("/usr/local/bin").join(name),
            Path::new("/usr/local/sbin").join(name),
            Path::new("/opt/homebrew/bin").join(name),
            Path::new("/opt/homebrew/sbin").join(name),
            Path::new("/usr/sbin").join(name),
            Path::new("/sbin").join(name),
        ];
        for c in candidates {
            if c.is_file() {
                return Some(c);
            }
        }
        None
    }
}

fn program_path(name: &str) -> Result<PathBuf, String> {
    if let Some(found) = find_program_in_path(name) {
        return Ok(found);
    }
    if let Some(found) = find_program_in_common_locations(name) {
        return Ok(found);
    }
    Err(format!(
        "{name} not found. Install the OpenSSH client and ensure it is available in PATH."
    ))
}

fn normalize_posix_path(raw: &str) -> Result<String, String> {
    if raw.is_empty() {
        return Err("path is empty".to_string());
    }
    if raw.contains('\0') {
        return Err("path contains a NUL byte".to_string());
    }
    if !raw.starts_with('/') {
        return Err("path must be absolute".to_string());
    }

    let mut parts: Vec<&str> = Vec::new();
    for part in raw.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            parts.pop();
            continue;
        }
        parts.push(part);
    }

    if parts.is_empty() {
        return Ok("/".to_string());
    }
    Ok(format!("/{}", parts.join("/")))
}

fn ensure_within_root(root: &str, path: &str) -> Result<(String, String), String> {
    let root = normalize_posix_path(root)?;
    let path = normalize_posix_path(path)?;
    if root != "/" && path != root && !path.starts_with(&format!("{root}/")) {
        return Err("path is outside root".to_string());
    }
    Ok((root, path))
}

fn ensure_not_root(root: &str, path: &str, verb: &str) -> Result<(), String> {
    if root == path {
        return Err(format!("cannot {verb} root"));
    }
    Ok(())
}

fn join_posix_path(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}

#[cfg(target_family = "unix")]
fn effective_user_id() -> u32 {
    // SAFETY: geteuid has no preconditions and does not dereference pointers.
    unsafe { libc::geteuid() }
}

#[cfg(target_family = "unix")]
fn secure_owned_private_directory(path: &Path, expected_uid: u32) -> Result<(), String> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("inspect private directory failed: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("private directory path is a symbolic link".to_string());
    }
    if !metadata.is_dir() {
        return Err("private directory path is not a directory".to_string());
    }
    if metadata.uid() != expected_uid {
        return Err("private directory is not owned by the effective user".to_string());
    }

    if metadata.permissions().mode() & 0o777 != 0o700 {
        return Err("private directory permissions are not 0700".to_string());
    }
    Ok(())
}

#[cfg(target_family = "unix")]
fn secure_new_owned_private_directory(path: &Path, expected_uid: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    // This helper is called only immediately after our atomic mkdir succeeded.
    // A restrictive process umask may have removed owner bits, so normalize the
    // mode before publishing the directory as a trust boundary. Never do this
    // for a pre-existing predictable directory: it may already contain
    // attacker-planted SSH control sockets.
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("restrict new private directory failed: {error}"))?;
    secure_owned_private_directory(path, expected_uid)
}

#[cfg(not(target_family = "unix"))]
fn secure_owned_private_directory(path: &Path, _expected_uid: u32) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("inspect private directory failed: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("private directory path is not a real directory".to_string());
    }
    Ok(())
}

#[cfg(not(target_family = "unix"))]
fn secure_new_owned_private_directory(path: &Path, expected_uid: u32) -> Result<(), String> {
    secure_owned_private_directory(path, expected_uid)
}

fn create_unique_private_directory(
    mut candidate: impl FnMut() -> PathBuf,
    expected_uid: u32,
    operation: &str,
) -> Result<PathBuf, String> {
    const MAX_ATTEMPTS: usize = 10_000;
    for _ in 0..MAX_ATTEMPTS {
        let path = candidate();
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(target_family = "unix")]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&path) {
            Ok(()) => {
                if let Err(error) = secure_new_owned_private_directory(&path, expected_uid) {
                    let _ = std::fs::remove_dir(&path);
                    return Err(format!("{operation} failed: {error}"));
                }
                return Ok(path);
            }
            // create() is atomic and treats files, directories, and symlinks as
            // occupied. Never inspect or chmod a colliding candidate.
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("{operation} failed: {error}")),
        }
    }
    Err(format!("{operation} exhausted unique directory names"))
}

#[cfg(target_family = "unix")]
fn prepare_control_base_with_ids(
    temp_root: &Path,
    effective_uid: u32,
    mut next_id: impl FnMut() -> u64,
) -> Result<PathBuf, String> {
    let preferred = temp_root.join(format!("agents-ui-ssh-{effective_uid}"));
    let mut builder = std::fs::DirBuilder::new();
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    let preferred_result = match builder.create(&preferred) {
        Ok(()) => secure_new_owned_private_directory(&preferred, effective_uid),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            // Existing predictable directories are accepted only if they were
            // already private. Chmod would not remove a control socket another
            // user could have planted while the directory was permissive.
            secure_owned_private_directory(&preferred, effective_uid)
        }
        Err(error) => Err(format!("create SSH control directory failed: {error}")),
    };
    if preferred_result.is_ok() {
        return Ok(preferred);
    }

    create_unique_private_directory(
        || {
            temp_root.join(format!(
                "au-s-{:x}-{:x}-{:x}",
                effective_uid,
                std::process::id(),
                next_id()
            ))
        },
        effective_uid,
        "create private SSH control fallback",
    )
    .map_err(|fallback_error| {
        format!(
            "{}; {fallback_error}",
            preferred_result.expect_err("preferred result was checked")
        )
    })
}

fn control_path() -> Result<String, String> {
    #[cfg(target_family = "unix")]
    let base = {
        // Keep this short to avoid Unix socket path length limits for ssh ControlPath.
        // Avoid using std::env::temp_dir() on macOS, which can be very long (e.g. /var/folders/...).
        static CONTROL_BASE: OnceLock<Result<PathBuf, String>> = OnceLock::new();
        static NEXT_CONTROL_FALLBACK: AtomicU64 = AtomicU64::new(1);
        let effective_uid = effective_user_id();
        let base = CONTROL_BASE
            .get_or_init(|| {
                prepare_control_base_with_ids(Path::new("/tmp"), effective_uid, || {
                    NEXT_CONTROL_FALLBACK.fetch_add(1, Ordering::Relaxed)
                })
            })
            .as_ref()
            .map_err(Clone::clone)?;
        secure_owned_private_directory(base, effective_uid)?;

        use std::os::unix::ffi::OsStrExt;
        const MAX_SAFE_CONTROL_BASE_BYTES: usize = 48;
        if base.as_os_str().as_bytes().len() > MAX_SAFE_CONTROL_BASE_BYTES {
            return Err("SSH control directory path is too long for a Unix socket".to_string());
        }
        base.clone()
    };

    #[cfg(not(target_family = "unix"))]
    let base = {
        let base = std::env::temp_dir().join("agents-ui-ssh");
        std::fs::create_dir_all(&base)
            .map_err(|error| format!("create control dir failed: {error}"))?;
        base
    };

    local_path_to_utf8(&base.join("%C"), "SSH control path")
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

fn local_path_to_utf8(path: &Path, operation: &str) -> Result<String, String> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        format!(
            "{operation} contains a name that is not valid UTF-8 and cannot be represented by the frontend"
        )
    })
}

fn validate_local_path_input<'a>(path: &'a str, missing_error: &str) -> Result<&'a str, String> {
    if path.is_empty() {
        return Err(missing_error.to_string());
    }
    if path.contains('\0') {
        return Err("local path contains a NUL byte".to_string());
    }
    Ok(path)
}

fn user_ssh_config_path() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".ssh").join("config"))
}

fn ssh_base_args() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(cfg) = user_ssh_config_path().filter(|p| p.is_file()) {
        if let Some(cfg) = cfg.to_str() {
            out.push("-F".to_string());
            out.push(cfg.to_string());
        }
    }
    out.extend([
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "ConnectTimeout=6".to_string(),
        "-o".to_string(),
        "ConnectionAttempts=1".to_string(),
        "-o".to_string(),
        // Tolerate ~60s of network silence before the shared master gives up, so
        // it survives brief pauses (Wi-Fi power-save when the display turns off)
        // instead of dying after 20s and forcing every next op to re-create it.
        "ServerAliveInterval=15".to_string(),
        "-o".to_string(),
        "ServerAliveCountMax=4".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=yes".to_string(),
    ]);
    out
}

fn ssh_common_args() -> Result<Vec<String>, String> {
    let control = control_path()?;
    let mut out = ssh_base_args();
    out.extend([
        "-o".to_string(),
        "ControlMaster=auto".to_string(),
        "-o".to_string(),
        // Keep the master warm for 5 min after the last op so a burst of file
        // actions reuses one connection instead of repeatedly re-establishing it.
        "ControlPersist=300".to_string(),
        "-o".to_string(),
        format!("ControlPath={control}"),
    ]);
    Ok(out)
}

/// Long-running transfers deliberately do not join the shared multiplexing
/// master. A transient directory-listing retry may tear that master down; when
/// scp shared it, an unrelated poll could terminate a healthy transfer and
/// trigger overlapping full-copy retries. A dedicated connection gives the
/// transfer its own keepalive/dead-peer lifecycle.
fn ssh_transfer_args() -> Vec<String> {
    let mut out = ssh_base_args();
    out.extend([
        "-o".to_string(),
        "ControlMaster=no".to_string(),
        "-o".to_string(),
        // ControlMaster=no still reuses a configured ControlPath if one is
        // present. Explicitly disable the path so long transfers cannot attach
        // to the short-operation master under any user SSH configuration.
        "ControlPath=none".to_string(),
    ]);
    out
}

fn output_to_error(prefix: &str, output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stderr.is_empty() {
        return format!("{prefix}: {stderr}");
    }
    if !stdout.is_empty() {
        return format!("{prefix}: {stdout}");
    }
    format!("{prefix}: command failed")
}

fn parse_remote_file_meta(stderr: &[u8], marker: &str) -> Result<(u64, Option<u64>), String> {
    let text = String::from_utf8_lossy(stderr);
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix(marker) else {
            continue;
        };
        let mut size: Option<u64> = None;
        let mut mtime_s: Option<u64> = None;
        for part in rest.split_whitespace() {
            if let Some(value) = part.strip_prefix("size=") {
                size = value.parse::<u64>().ok();
            } else if let Some(value) = part.strip_prefix("mtime=") {
                if !value.is_empty() {
                    mtime_s = value.parse::<u64>().ok();
                }
            }
        }
        let size = size.ok_or_else(|| "ssh metadata missing size".to_string())?;
        return Ok((size, mtime_s.and_then(|v| v.checked_mul(1000))));
    }
    Err("ssh metadata missing".to_string())
}

fn shell_escape_posix(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            out.push_str("'\"'\"'");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

fn build_sh_c_command(script: &str, argv0: Option<&str>, args: &[String]) -> String {
    let mut out = String::new();
    out.push_str("sh -c ");
    out.push_str(&shell_escape_posix(script));
    if let Some(name) = argv0 {
        out.push(' ');
        out.push_str(&shell_escape_posix(name));
    }
    for arg in args {
        out.push(' ');
        out.push_str(&shell_escape_posix(arg));
    }
    out
}

/// Per-target lock guarding control-master creation, so concurrent file ops
/// don't each open their own connection when the master is down.
fn ssh_master_lock(target: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let registry = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = registry.lock().unwrap_or_else(|e| e.into_inner());
    map.entry(target.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// True for SSH transport failures worth retrying — the server rate-limited /
/// reset the connection, or the multiplexed master refused a session. NOT true
/// for genuine command failures (e.g. "File exists"), which the caller surfaces.
fn is_transient_ssh_error(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("connection reset by peer")
        || s.contains("kex_exchange_identification")
        || s.contains("session open refused")
        || s.contains("mux_client")
        || s.contains("control socket connect")
        || s.contains("connection closed by")
        || s.contains("broken pipe")
        || s.contains("connection timed out")
        || s.contains("operation timed out")
}

/// How long a successful master check stays valid before we re-verify with a
/// fresh `ssh -O check`. The master is kept alive by ControlPersist=300s +
/// ServerAliveInterval, so within this window the check is almost always
/// redundant — and if the master does die anyway, run_ssh's transient-error
/// retry path (close_master → ensure_master) rebuilds it transparently.
const MASTER_CHECK_TTL: Duration = Duration::from_secs(30);

fn master_verified_cache() -> &'static Mutex<HashMap<String, Instant>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn master_recently_verified(target: &str) -> bool {
    master_verified_cache()
        .lock()
        .ok()
        .and_then(|map| map.get(target).map(|t| t.elapsed() < MASTER_CHECK_TTL))
        .unwrap_or(false)
}

fn mark_master_verified(target: &str) {
    if let Ok(mut map) = master_verified_cache().lock() {
        map.insert(target.to_string(), Instant::now());
    }
}

fn invalidate_master_verified(target: &str) {
    if let Ok(mut map) = master_verified_cache().lock() {
        map.remove(target);
    }
}

struct SshShortOpPermit;

impl Drop for SshShortOpPermit {
    fn drop(&mut self) {
        active_ssh_short_ops().fetch_sub(1, Ordering::AcqRel);
    }
}

fn active_ssh_short_ops() -> &'static AtomicUsize {
    static ACTIVE: AtomicUsize = AtomicUsize::new(0);
    &ACTIVE
}

fn acquire_ssh_short_op_permit() -> Result<SshShortOpPermit, String> {
    poll_deferred_ssh_fallback();
    let _ = deferred_ssh_child_sender()?;
    if deferred_ssh_child_count().load(Ordering::Acquire) >= MAX_DEFERRED_SSH_CHILDREN {
        return Err("SSH process cleanup is still pending; try again shortly".to_string());
    }
    active_ssh_short_ops()
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
            (active < MAX_ACTIVE_SSH_SHORT_OPS).then_some(active + 1)
        })
        .map(|_| SshShortOpPermit)
        .map_err(|_| {
            format!(
                "too many active SSH filesystem operations (maximum {MAX_ACTIVE_SSH_SHORT_OPS})"
            )
        })
}

fn run_command_bounded(
    mut command: Command,
    stdin: Option<&[u8]>,
    stdout_limit: usize,
    renderer_generation: Option<u64>,
    runtime_limit: Option<Duration>,
    label: &str,
) -> Result<Output, String> {
    if renderer_generation.is_some_and(|generation| generation != current_ssh_transfer_generation())
    {
        return Err("SSH operation belonged to a terminated renderer".to_string());
    }

    command.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    #[cfg(target_family = "unix")]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = SupervisedChild::new(
        command
            .spawn()
            .map_err(|error| format!("spawn {label} failed: {error}"))?,
    );
    let process_group_id = child.id();
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_scp_process(&mut child);
            return Err(format!("{label} stdout pipe unavailable"));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_scp_process(&mut child);
            return Err(format!("{label} stderr pipe unavailable"));
        }
    };
    if let Err(error) = configure_pipe_nonblocking(&stdout) {
        terminate_scp_process(&mut child);
        return Err(format!("configure {label} stdout pipe failed: {error}"));
    }
    if let Err(error) = configure_pipe_nonblocking(&stderr) {
        terminate_scp_process(&mut child);
        return Err(format!("configure {label} stderr pipe failed: {error}"));
    }

    let stdout_overflowed = Arc::new(AtomicBool::new(false));
    let stdout_stop = Arc::new(AtomicBool::new(false));
    let stdout_overflowed_reader = stdout_overflowed.clone();
    let stdout_stop_reader = stdout_stop.clone();
    let (stdout_sender, stdout_receiver) = std::sync::mpsc::sync_channel(1);
    if let Err(error) = std::thread::Builder::new()
        .name("ssh-stdout-drain".to_string())
        .spawn(move || {
            let output = read_bounded_prefix(
                stdout,
                stdout_limit,
                &stdout_overflowed_reader,
                &stdout_stop_reader,
            );
            let _ = stdout_sender.send(output);
        })
    {
        terminate_scp_process(&mut child);
        return Err(format!("start {label} stdout reader failed: {error}"));
    }

    let stderr_stop = Arc::new(AtomicBool::new(false));
    let stderr_stop_reader = stderr_stop.clone();
    let (stderr_sender, stderr_receiver) = std::sync::mpsc::sync_channel(1);
    if let Err(error) = std::thread::Builder::new()
        .name("ssh-stderr-drain".to_string())
        .spawn(move || {
            let output =
                read_scp_stderr_tail(stderr, SCP_DIAGNOSTIC_TAIL_BYTES, &stderr_stop_reader);
            let _ = stderr_sender.send(output);
        })
    {
        stdout_stop.store(true, Ordering::Release);
        terminate_scp_process(&mut child);
        let _ = collect_scp_stderr(&stdout_receiver, &stdout_stop, process_group_id);
        return Err(format!("start {label} stderr reader failed: {error}"));
    }

    let started_at = Instant::now();
    let mut failure: Option<String> = None;
    let mut stdin_result = if let Some(input) = stdin {
        match child.stdin.take() {
            Some(mut child_stdin) => {
                let input = input.to_vec();
                let (sender, receiver) = std::sync::mpsc::sync_channel(1);
                match std::thread::Builder::new()
                    .name("ssh-stdin-writer".to_string())
                    .spawn(move || {
                        let result = child_stdin
                            .write_all(&input)
                            .map_err(|error| format!("write SSH stdin failed: {error}"));
                        let _ = sender.send(result);
                    }) {
                    Ok(_) => Some(receiver),
                    Err(error) => {
                        failure = Some(format!("start {label} stdin writer failed: {error}"));
                        None
                    }
                }
            }
            None => {
                failure = Some(format!("{label} stdin pipe unavailable"));
                None
            }
        }
    } else {
        None
    };

    let status = loop {
        if let Some(receiver) = stdin_result.as_ref() {
            match receiver.try_recv() {
                Ok(Ok(())) => stdin_result = None,
                Ok(Err(error)) => {
                    failure = Some(error);
                    stdin_result = None;
                }
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    failure = Some(format!("{label} stdin writer stopped unexpectedly"));
                    stdin_result = None;
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
            }
        }
        if failure.is_none() && stdout_overflowed.load(Ordering::Acquire) {
            failure = Some(format!(
                "{label} output exceeded the {stdout_limit}-byte safety limit"
            ));
        }
        if failure.is_none()
            && renderer_generation
                .is_some_and(|generation| generation != current_ssh_transfer_generation())
        {
            failure = Some("SSH operation belonged to a terminated renderer".to_string());
        }
        if failure.is_none() && runtime_limit.is_some_and(|limit| started_at.elapsed() >= limit) {
            let seconds = runtime_limit.map(|limit| limit.as_secs()).unwrap_or(0);
            failure = Some(format!(
                "{label} exceeded the {seconds} second safety deadline"
            ));
        }
        if failure.is_some() {
            terminate_scp_process(&mut child);
            break None;
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(error) => {
                terminate_scp_process(&mut child);
                return Err(format!("wait {label} failed: {error}"));
            }
        }
    };

    let stdout = collect_scp_stderr(&stdout_receiver, &stdout_stop, process_group_id);
    let stderr = collect_scp_stderr(&stderr_receiver, &stderr_stop, process_group_id);
    if let Some(receiver) = stdin_result {
        match receiver.recv_timeout(Duration::from_secs(1)) {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                failure.get_or_insert(error);
            }
            Err(_) => {
                failure.get_or_insert_with(|| format!("{label} stdin writer did not stop"));
            }
        };
    }
    #[cfg(target_family = "unix")]
    if scp_process_group_exists(process_group_id) {
        terminate_remaining_scp_process_group(process_group_id);
    }
    if stdout_overflowed.load(Ordering::Acquire) && failure.is_none() {
        failure = Some(format!(
            "{label} output exceeded the {stdout_limit}-byte safety limit"
        ));
    }
    if let Some(error) = failure {
        return Err(error);
    }
    let status = status.ok_or_else(|| format!("terminated {label} did not exit"))?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

/// Whether a multiplexing master process is currently registered for `target`.
fn master_is_alive(target: &str, renderer_generation: Option<u64>) -> bool {
    let Ok(target) = validate_ssh_target(target) else {
        return false;
    };
    let (Ok(ssh), Ok(common)) = (program_path("ssh"), ssh_common_args()) else {
        return false;
    };
    let mut command = Command::new(ssh);
    command.args(&common).args(["-O", "check"]).arg(target);
    run_command_bounded(
        command,
        None,
        SCP_DIAGNOSTIC_TAIL_BYTES,
        renderer_generation,
        Some(SSH_CONTROL_RUNTIME_LIMIT),
        "ssh control check",
    )
    .map(|output| output.status.success())
    .unwrap_or(false)
}

/// Tear down the master for `target` (best effort) — used when it looks stale
/// (process alive but its underlying connection dead).
fn close_master(target: &str, renderer_generation: Option<u64>) {
    let Ok(target) = validate_ssh_target(target) else {
        return;
    };
    invalidate_master_verified(target);
    let (Ok(ssh), Ok(common)) = (program_path("ssh"), ssh_common_args()) else {
        return;
    };
    let mut command = Command::new(ssh);
    command.args(&common).args(["-O", "exit"]).arg(target);
    let _ = run_command_bounded(
        command,
        None,
        SCP_DIAGNOSTIC_TAIL_BYTES,
        renderer_generation,
        Some(SSH_CONTROL_RUNTIME_LIMIT),
        "ssh control exit",
    );
}

fn supervisor_error_is_retryable(error: &str) -> bool {
    !error.contains("terminated renderer")
        && !error.contains("output exceeded")
        && !error.contains("not found")
        && !error.contains("invalid SSH")
}

/// Ensure the multiplexing master for `target` is up. Serialized per target so
/// that, when no master exists, exactly one ssh process creates it instead of
/// every concurrent op racing to open its own connection — a burst the server
/// rate-limits, surfacing as "Connection reset by peer" /
/// "kex_exchange_identification" / "Session open refused by peer".
fn ensure_master(target: &str, renderer_generation: Option<u64>) -> Result<(), String> {
    let target = validate_ssh_target(target)?;
    let lock = ssh_master_lock(target);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());

    // Skip the `ssh -O check` process spawn when the master was verified
    // recently — per-op this check used to dominate burst latency (probe +
    // N chunk reads = N+1 spawns).
    if master_recently_verified(target) {
        return Ok(());
    }

    if master_is_alive(target, renderer_generation) {
        mark_master_verified(target);
        return Ok(());
    }

    let ssh = program_path("ssh")?;
    let common = ssh_common_args()?;
    let mut last_err = String::new();
    for attempt in 0..SSH_OP_ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(250 * attempt as u64));
            if master_is_alive(target, renderer_generation) {
                mark_master_verified(target);
                return Ok(());
            }
        }
        // `true` is a trivial remote command; with ControlMaster=auto it opens
        // and persists the shared master, then returns immediately.
        let mut command = Command::new(&ssh);
        command.args(&common).arg(target).arg("true");
        let output = match run_command_bounded(
            command,
            None,
            SCP_DIAGNOSTIC_TAIL_BYTES,
            renderer_generation,
            Some(SSH_COMMAND_RUNTIME_LIMIT),
            "ssh connect",
        ) {
            Ok(output) => output,
            Err(error) if supervisor_error_is_retryable(&error) => {
                last_err = error;
                continue;
            }
            Err(error) => return Err(error),
        };
        if output.status.success() {
            mark_master_verified(target);
            return Ok(());
        }
        last_err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !is_transient_ssh_error(&last_err) {
            // Auth / host-key / DNS failures won't be fixed by retrying.
            return Err(format!("ssh connect failed: {last_err}"));
        }
    }
    Err(format!(
        "ssh connect failed after {SSH_OP_ATTEMPTS} attempts: {last_err}"
    ))
}

fn run_ssh_once(
    target: &str,
    remote_args: &[String],
    stdin: Option<&[u8]>,
    renderer_generation: Option<u64>,
) -> Result<Output, String> {
    let target = validate_ssh_target(target)?;
    let mut cmd = Command::new(program_path("ssh")?);
    cmd.args(ssh_common_args()?);
    cmd.arg(target);
    cmd.args(remote_args);
    run_command_bounded(
        cmd,
        stdin,
        SSH_COMMAND_STDOUT_LIMIT,
        renderer_generation,
        Some(SSH_COMMAND_RUNTIME_LIMIT),
        "ssh",
    )
}

const SSH_MUTATION_OUTCOME_UNKNOWN: &str =
    "SSH mutation outcome unknown after a connection failure; refresh the file tree before retrying";

fn classify_single_mutation_attempt(
    attempt: Result<Output, String>,
    label: &str,
) -> Result<Output, String> {
    let output = attempt.map_err(|error| {
        format!("{label}: {SSH_MUTATION_OUTCOME_UNKNOWN} ({error})")
    })?;
    if !output.status.success()
        && is_transient_ssh_error(&String::from_utf8_lossy(&output.stderr))
    {
        return Err(format!("{label}: {SSH_MUTATION_OUTCOME_UNKNOWN}"));
    }
    Ok(output)
}

fn execute_single_mutation_attempt(
    label: &str,
    attempt: impl FnOnce() -> Result<Output, String>,
) -> Result<Output, String> {
    classify_single_mutation_attempt(attempt(), label)
}

fn run_ssh_mutation(
    target: &str,
    remote_args: &[String],
    stdin: Option<&[u8]>,
    renderer_generation: Option<u64>,
    label: &str,
) -> Result<Output, String> {
    let target = validate_ssh_target(target)?;
    let _permit = acquire_ssh_short_op_permit()?;
    ensure_master(target, renderer_generation)?;
    let result = execute_single_mutation_attempt(label, || {
        run_ssh_once(target, remote_args, stdin, renderer_generation)
    });
    if result
        .as_ref()
        .err()
        .is_some_and(|error| error.contains(SSH_MUTATION_OUTCOME_UNKNOWN))
    {
        // Do not replay the mutation. Only invalidate the cached health check;
        // the next independent operation may establish a fresh master.
        invalidate_master_verified(target);
    }
    result
}

pub(crate) fn run_ssh_script(target: &str, script: &str) -> Result<Output, String> {
    let args = vec!["sh".to_string()];
    run_ssh_read_only_with_stdin(
        target,
        &args,
        Some(script.as_bytes()),
        None,
        SSH_COMMAND_STDOUT_LIMIT,
        "ssh system query",
    )
}

fn run_ssh_read_only_once(
    target: &str,
    remote_args: &[String],
    stdin: Option<&[u8]>,
    renderer_generation: Option<u64>,
    stdout_limit: usize,
    label: &str,
) -> Result<Output, String> {
    let target = validate_ssh_target(target)?;
    let mut command = Command::new(program_path("ssh")?);
    command.args(ssh_common_args()?);
    command.arg(target);
    command.args(remote_args);
    run_command_bounded(
        command,
        stdin,
        stdout_limit,
        renderer_generation,
        Some(SSH_FS_QUERY_RUNTIME_LIMIT),
        label,
    )
}

fn run_retry_safe_query_attempts(
    label: &str,
    mut attempt: impl FnMut(usize) -> Result<Output, String>,
) -> Result<Output, String> {
    let mut last_output: Option<Output> = None;
    let mut last_error: Option<String> = None;
    for attempt_index in 0..SSH_OP_ATTEMPTS {
        let output = match attempt(attempt_index) {
            Ok(output) => output,
            Err(error)
                if supervisor_error_is_retryable(&error) && !error.contains("safety deadline") =>
            {
                last_error = Some(error);
                continue;
            }
            Err(error) => return Err(error),
        };
        if output.status.success() {
            return Ok(output);
        }
        if !is_transient_ssh_error(&String::from_utf8_lossy(&output.stderr)) {
            return Ok(output);
        }
        last_output = Some(output);
    }
    match last_output {
        Some(output) => Ok(output),
        None => {
            Err(last_error.unwrap_or_else(|| format!("{label} failed before its first attempt")))
        }
    }
}

/// Run an idempotent filesystem query with the same bounded process supervision
/// as transfers. Unlike mutation commands, read-only queries are safe to retry
/// after a transient connection failure.
fn run_ssh_read_only(
    target: &str,
    remote_args: &[String],
    renderer_generation: Option<u64>,
    stdout_limit: usize,
    label: &str,
) -> Result<Output, String> {
    run_ssh_read_only_with_stdin(
        target,
        remote_args,
        None,
        renderer_generation,
        stdout_limit,
        label,
    )
}

fn run_ssh_read_only_with_stdin(
    target: &str,
    remote_args: &[String],
    stdin: Option<&[u8]>,
    renderer_generation: Option<u64>,
    stdout_limit: usize,
    label: &str,
) -> Result<Output, String> {
    let target = validate_ssh_target(target)?;
    let _permit = acquire_ssh_short_op_permit()?;
    run_retry_safe_query_attempts(label, |attempt| {
        if attempt > 0 {
            close_master(target, renderer_generation);
            std::thread::sleep(Duration::from_millis(250 * attempt as u64));
        }
        ensure_master(target, renderer_generation)?;
        run_ssh_read_only_once(
            target,
            remote_args,
            stdin,
            renderer_generation,
            stdout_limit,
            label,
        )
    })
}

fn decode_remote_path_output<'a>(bytes: &'a [u8], operation: &str) -> Result<&'a str, String> {
    std::str::from_utf8(bytes).map_err(|error| {
        format!(
            "{operation} returned path data that is not valid UTF-8 (invalid byte at offset {}); the remote filename encoding is unsupported",
            error.valid_up_to()
        )
    })
}

fn remote_frame_tokens(kind: &str) -> Result<(String, String), String> {
    let mut nonce = [0u8; 16];
    OsRng
        .try_fill_bytes(&mut nonce)
        .map_err(|error| format!("generate SSH response-frame nonce failed: {error}"))?;
    let nonce = nonce
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok((
        format!("AGENTS_UI_{kind}_V2_{nonce}"),
        format!("AGENTS_UI_{kind}_DONE_V2_{nonce}"),
    ))
}

fn unique_nul_field_start(bytes: &[u8], marker: &[u8]) -> Result<usize, ()> {
    if marker.is_empty() {
        return Err(());
    }
    let mut found = None;
    for (index, window) in bytes.windows(marker.len() + 1).enumerate() {
        if &window[..marker.len()] == marker && window[marker.len()] == 0 {
            if found.replace(index).is_some() {
                return Err(());
            }
        }
    }
    found.ok_or(())
}

/// Allocation-free cursor over a NUL-framed response. It deliberately does not
/// split the whole buffer: an attacker-controlled response containing millions
/// of NUL bytes must not turn a bounded byte capture into an unbounded pointer
/// allocation. `next_field` recognizes the trailer only when it is the complete
/// remaining field, so a body field ending in `Z` cannot masquerade as framing.
struct NulFrameCursor<'a> {
    remaining: &'a [u8],
    trailer: Vec<u8>,
    operation: &'static str,
    finished: bool,
}

impl<'a> NulFrameCursor<'a> {
    fn new(
        bytes: &'a [u8],
        expected_magic: &[u8],
        expected_trailer: &[u8],
        operation: &'static str,
    ) -> Result<Self, String> {
        let magic_start = unique_nul_field_start(bytes, expected_magic)
            .map_err(|_| format!("{operation} returned an invalid or ambiguous framed response"))?;
        unique_nul_field_start(bytes, expected_trailer)
            .map_err(|_| format!("{operation} returned an invalid or ambiguous framed response"))?;
        let magic_end = magic_start + expected_magic.len();
        if bytes.get(magic_end) != Some(&0) {
            return Err(format!("{operation} returned an invalid framed response"));
        }
        let remaining = &bytes[magic_end + 1..];
        if remaining.is_empty() {
            return Err(format!(
                "{operation} returned an incomplete framed response"
            ));
        }
        Ok(Self {
            remaining,
            trailer: expected_trailer.to_vec(),
            operation,
            finished: false,
        })
    }

    fn next_field(&mut self) -> Result<Option<&'a [u8]>, String> {
        if self.finished {
            return Ok(None);
        }
        let Some(field_end) = self.remaining.iter().position(|byte| *byte == 0) else {
            return Err(format!(
                "{} returned an incomplete framed response",
                self.operation
            ));
        };
        let field = &self.remaining[..field_end];
        self.remaining = &self.remaining[field_end + 1..];
        if field == self.trailer.as_slice() {
            self.remaining = &[];
            self.finished = true;
            return Ok(None);
        }
        if self.remaining.is_empty() {
            return Err(format!(
                "{} returned an incomplete framed response",
                self.operation
            ));
        }
        Ok(Some(field))
    }

    fn required_field(&mut self) -> Result<&'a [u8], String> {
        self.next_field()?.ok_or_else(|| {
            format!(
                "{} returned a malformed record with missing fields",
                self.operation
            )
        })
    }
}

#[cfg(test)]
fn parse_remote_directory_frame(dir_path: &str, stdout: &[u8]) -> Result<Vec<FsEntry>, String> {
    parse_remote_directory_frame_with_tokens(
        dir_path,
        stdout,
        REMOTE_DIRECTORY_FRAME_MAGIC,
        REMOTE_FRAME_TRAILER,
    )
}

fn parse_remote_directory_frame_with_tokens(
    dir_path: &str,
    stdout: &[u8],
    magic: &[u8],
    trailer: &[u8],
) -> Result<Vec<FsEntry>, String> {
    let mut frame = NulFrameCursor::new(
        stdout,
        magic,
        trailer,
        "ssh directory listing",
    )?;
    let mut entries = Vec::new();
    while let Some(marker) = frame.next_field()? {
        if entries.len() >= MAX_REMOTE_DIRECTORY_ENTRIES {
            return Err(format!(
                "remote directory exceeds the {MAX_REMOTE_DIRECTORY_ENTRIES}-entry safety limit"
            ));
        }
        let kind_field = frame.required_field()?;
        let size_field = frame.required_field()?;
        let name_field = frame.required_field()?;
        if marker != b"E" {
            return Err("ssh directory listing returned an invalid record marker".to_string());
        }
        let kind = match kind_field {
            b"d" => 'd',
            b"f" => 'f',
            b"l" => 'l',
            b"o" => 'o',
            _ => return Err("ssh directory listing returned an invalid entry type".to_string()),
        };
        let size = decode_remote_path_output(size_field, "ssh directory listing size")?
            .parse::<u64>()
            .map_err(|_| "ssh directory listing returned an invalid entry size".to_string())?;
        let name = decode_remote_path_output(name_field, "ssh directory listing filename")?;
        if name.is_empty() || name == "." || name == ".." || name.contains('/') {
            return Err("ssh directory listing returned an invalid filename".to_string());
        }
        let is_dir = kind == 'd';
        entries.push(FsEntry {
            name: name.to_string(),
            path: join_posix_path(dir_path, name),
            is_dir,
            size: if is_dir { 0 } else { size },
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

/// The OpenSSH `sftp ls` command prints human-readable newline-delimited text,
/// so filenames containing LF/CR or symlink-arrow text cannot be recovered
/// unambiguously. Enumerate with the already-required remote POSIX shell and
/// emit an explicit NUL-framed byte protocol instead. POSIX filenames cannot
/// contain NUL, making every record boundary lossless.
const REMOTE_DIRECTORY_LIST_SCRIPT: &str = r#"set -e
dir=$1
limit=$2
magic=${3:-AGENTS_UI_FS_V1}
trailer=${4:-Z}
prefix=$dir
if [ "$prefix" = "/" ]; then prefix=""; fi
if stat -c %s / >/dev/null 2>&1; then
  stat_style=gnu
elif stat -f %z / >/dev/null 2>&1; then
  stat_style=bsd
else
  echo "remote stat does not support a safe size format" >&2
  exit 72
fi
printf '%s\000' "$magic"
count=0
for entry in "$prefix"/* "$prefix"/.[!.]* "$prefix"/..?*; do
  if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then continue; fi
  name=${entry##*/}
  count=$((count + 1))
  if [ "$count" -gt "$limit" ]; then
    echo "remote directory exceeds the entry safety limit" >&2
    exit 73
  fi
  if [ -L "$entry" ]; then
    kind=l
  elif [ -d "$entry" ]; then
    kind=d
  elif [ -f "$entry" ]; then
    kind=f
  else
    kind=o
  fi
  if [ "$kind" = d ]; then
    size=0
  elif [ "$stat_style" = gnu ]; then
    size=$(stat -c %s "$entry") || exit 74
  else
    size=$(stat -f %z "$entry") || exit 74
  fi
  printf 'E\000%s\000%s\000%s\000' "$kind" "$size" "$name"
done
printf '%s\000' "$trailer"
"#;

#[tauri::command]
pub async fn ssh_default_root(target: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ssh_default_root_sync(target))
        .await
        .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

#[tauri::command]
pub async fn ssh_effective_user(target: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ssh_effective_user_sync(target))
        .await
        .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_effective_user_sync(target: String) -> Result<String, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }

    // Single-line command to avoid shell parsing differences across hosts.
    let script = r#"id -un 2>/dev/null || whoami 2>/dev/null"#;
    let command = build_sh_c_command(script, None, &[]);
    let args = vec![command];
    let output = run_ssh_read_only(
        target,
        &args,
        None,
        SSH_COMMAND_STDOUT_LIMIT,
        "ssh user lookup",
    )?;
    if !output.status.success() {
        return Err(output_to_error("ssh failed", &output));
    }
    let user = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if user.is_empty() {
        return Err("ssh returned empty user".to_string());
    }
    Ok(user)
}

fn ssh_default_root_sync(target: String) -> Result<String, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }

    // Print without a line delimiter so whitespace in HOME/PWD remains part of
    // the path rather than being confused with command formatting.
    let script = r#"uid="$(id -u 2>/dev/null || echo 1000)"; if [ "$uid" = "0" ]; then printf "/"; exit 0; fi; if [ -n "${HOME:-}" ]; then printf "%s" "$HOME"; exit 0; fi; if [ -n "${PWD:-}" ]; then printf "%s" "$PWD"; exit 0; fi; echo "ssh returned no root" >&2; exit 1"#;

    let command = build_sh_c_command(script, None, &[]);
    let args = vec![command];
    let output = run_ssh_read_only(
        target,
        &args,
        None,
        SSH_COMMAND_STDOUT_LIMIT,
        "ssh root lookup",
    )?;
    if !output.status.success() {
        return Err(output_to_error("ssh failed", &output));
    }
    let stdout = decode_remote_path_output(&output.stdout, "ssh root lookup")?.to_string();
    if stdout.is_empty() {
        return Err("ssh returned empty root".to_string());
    }
    normalize_posix_path(&stdout)
}

#[tauri::command]
pub async fn ssh_list_fs_entries(
    target: String,
    root: String,
    path: String,
) -> Result<Vec<FsEntry>, String> {
    let renderer_generation = current_ssh_transfer_generation();
    tauri::async_runtime::spawn_blocking(move || {
        ssh_list_fs_entries_sync(target, root, path, renderer_generation)
    })
    .await
    .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_list_fs_entries_sync(
    target: String,
    root: String,
    path: String,
    renderer_generation: u64,
) -> Result<Vec<FsEntry>, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let (_root, path) = ensure_within_root(&root, &path)?;
    let (frame_magic, frame_trailer) = remote_frame_tokens("FS")?;

    let command = build_sh_c_command(
        REMOTE_DIRECTORY_LIST_SCRIPT,
        Some("--"),
        &[
            path.clone(),
            MAX_REMOTE_DIRECTORY_ENTRIES.to_string(),
            frame_magic.clone(),
            frame_trailer.clone(),
        ],
    );
    let output = run_ssh_read_only(
        target,
        &[command],
        Some(renderer_generation),
        SFTP_LIST_STDOUT_LIMIT,
        "ssh directory listing",
    )?;
    if !output.status.success() {
        return Err(output_to_error("ssh directory listing failed", &output));
    }
    parse_remote_directory_frame_with_tokens(
        &path,
        &output.stdout,
        frame_magic.as_bytes(),
        frame_trailer.as_bytes(),
    )
}

#[tauri::command]
pub async fn ssh_search_fs_entries(
    target: String,
    root: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<FsEntry>, String> {
    let renderer_generation = current_ssh_transfer_generation();
    tauri::async_runtime::spawn_blocking(move || {
        ssh_search_fs_entries_sync(target, root, query, limit, renderer_generation)
    })
    .await
    .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_search_fs_entries_sync(
    target: String,
    root: String,
    query: String,
    limit: Option<usize>,
    renderer_generation: u64,
) -> Result<Vec<FsEntry>, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let root = normalize_posix_path(&root)?;
    let query = query.trim().to_string();
    if query.contains('\0') {
        return Err("search query contains a NUL byte".to_string());
    }
    if query.len() < 2 {
        return Ok(Vec::new());
    }
    let limit = limit
        .unwrap_or(200)
        .clamp(1, MAX_REMOTE_FILE_SEARCH_RESULTS);

    let mut out: Vec<FsEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    ssh_search_pass(
        target,
        &root,
        &query,
        limit,
        false,
        renderer_generation,
        &mut seen,
        &mut out,
    )?;
    if out.len() < limit {
        ssh_search_pass(
            target,
            &root,
            &query,
            limit - out.len(),
            true,
            renderer_generation,
            &mut seen,
            &mut out,
        )?;
    }

    Ok(out)
}

fn escape_find_pattern_literal(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(character, '\\' | '*' | '?' | '[' | ']') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

#[cfg(test)]
fn parse_remote_search_frame(
    root: &str,
    stdout: &[u8],
    frame_limit: usize,
    total_limit: usize,
    seen: &mut HashSet<String>,
    out: &mut Vec<FsEntry>,
) -> Result<(), String> {
    parse_remote_search_frame_with_tokens(
        root,
        stdout,
        frame_limit,
        total_limit,
        seen,
        out,
        REMOTE_SEARCH_FRAME_MAGIC,
        REMOTE_FRAME_TRAILER,
    )
}

#[allow(clippy::too_many_arguments)]
fn parse_remote_search_frame_with_tokens(
    root: &str,
    stdout: &[u8],
    frame_limit: usize,
    total_limit: usize,
    seen: &mut HashSet<String>,
    out: &mut Vec<FsEntry>,
    magic: &[u8],
    trailer: &[u8],
) -> Result<(), String> {
    let mut frame = NulFrameCursor::new(stdout, magic, trailer, "ssh file search")?;
    let mut record_count = 0usize;
    while let Some(raw) = frame.next_field()? {
        if record_count >= frame_limit {
            return Err("ssh file search exceeded its framed result limit".to_string());
        }
        record_count += 1;
        let raw = decode_remote_path_output(raw, "ssh file search path")?;
        let path = normalize_posix_path(raw)?;
        if root != "/" && path != root && !path.starts_with(&format!("{root}/")) {
            return Err("ssh file search returned a path outside root".to_string());
        }
        let name = path.rsplit('/').next().unwrap_or(&path);
        if name.is_empty() {
            return Err("ssh file search returned an invalid filename".to_string());
        }
        if !seen.insert(path.clone()) || out.len() >= total_limit {
            continue;
        }
        out.push(FsEntry {
            name: name.to_string(),
            path,
            is_dir: false,
            size: 0,
        });
    }
    Ok(())
}

/// `find -print0` preserves every valid POSIX filename byte. Results are capped
/// on the remote host before SSH can fill its output pipe: GNU/BusyBox `head -z`
/// is preferred, with a Perl NUL-record fallback. If neither exact limiter is
/// available we fail explicitly rather than returning ambiguous/unbounded data.
const REMOTE_FILE_SEARCH_SCRIPT: &str = r#"set -e
root=$1
pattern=$2
include_hidden=$3
limit=$4
hidden_direct=$5
hidden_nested=$6
magic=${7:-AGENTS_UI_SEARCH_V1}
trailer=${8:-Z}
if [ ! -d "$root" ]; then
  echo "remote search root is not a directory" >&2
  exit 75
fi
if ! find "$root" -maxdepth 0 -ipath "$pattern" -print0 >/dev/null 2>&1; then
  echo "remote find lacks required -ipath/-print0 support" >&2
  exit 76
fi
probe_size=$(printf 'x\000y\000' | head -z -n 1 2>/dev/null | wc -c | tr -d '[:space:]')
if [ "$probe_size" = "2" ]; then
  limiter=head
elif command -v perl >/dev/null 2>&1 && [ "$(printf 'x\000y\000' | perl -0 -e '$limit=shift; while (<STDIN>) { print; last if ++$seen >= $limit }' 1 | wc -c | tr -d '[:space:]')" = "2" ]; then
  limiter=perl
else
  echo "remote search requires a NUL-aware result limiter (head -z or Perl)" >&2
  exit 77
fi
printf '%s\000' "$magic"
if [ "$include_hidden" = "1" ]; then
  if [ "$limiter" = head ]; then
    find "$root" -mindepth 1 \( -type d \( -name .git -o -name .hg -o -name .svn -o -name node_modules -o -name target -o -name dist -o -name build -o -name .next -o -name .nuxt -o -name .cache -o -name .turbo -o -name .venv -o -name venv -o -name __pycache__ -o -name .npm -o -name .pnpm-store -o -name .yarn \) -prune \) -o -type f -ipath "$pattern" \( -ipath "$hidden_direct" -o -ipath "$hidden_nested" \) -print0 2>/dev/null | head -z -n "$limit"
  else
    find "$root" -mindepth 1 \( -type d \( -name .git -o -name .hg -o -name .svn -o -name node_modules -o -name target -o -name dist -o -name build -o -name .next -o -name .nuxt -o -name .cache -o -name .turbo -o -name .venv -o -name venv -o -name __pycache__ -o -name .npm -o -name .pnpm-store -o -name .yarn \) -prune \) -o -type f -ipath "$pattern" \( -ipath "$hidden_direct" -o -ipath "$hidden_nested" \) -print0 2>/dev/null | perl -0 -e '$limit=shift; while (<STDIN>) { print; last if ++$seen >= $limit }' "$limit"
  fi
else
  if [ "$limiter" = head ]; then
    find "$root" -mindepth 1 \( -type d \( -name .git -o -name .hg -o -name .svn -o -name node_modules -o -name target -o -name dist -o -name build -o -name .next -o -name .nuxt -o -name .cache -o -name .turbo -o -name .venv -o -name venv -o -name __pycache__ -o -name .npm -o -name .pnpm-store -o -name .yarn -o -name '.*' \) -prune \) -o -type f -ipath "$pattern" -print0 2>/dev/null | head -z -n "$limit"
  else
    find "$root" -mindepth 1 \( -type d \( -name .git -o -name .hg -o -name .svn -o -name node_modules -o -name target -o -name dist -o -name build -o -name .next -o -name .nuxt -o -name .cache -o -name .turbo -o -name .venv -o -name venv -o -name __pycache__ -o -name .npm -o -name .pnpm-store -o -name .yarn -o -name '.*' \) -prune \) -o -type f -ipath "$pattern" -print0 2>/dev/null | perl -0 -e '$limit=shift; while (<STDIN>) { print; last if ++$seen >= $limit }' "$limit"
  fi
fi
printf '%s\000' "$trailer"
"#;

#[allow(clippy::too_many_arguments)]
fn ssh_search_pass(
    target: &str,
    root: &str,
    query: &str,
    limit: usize,
    include_hidden_dirs: bool,
    renderer_generation: u64,
    seen: &mut HashSet<String>,
    out: &mut Vec<FsEntry>,
) -> Result<(), String> {
    if limit == 0 {
        return Ok(());
    }

    let pattern = format!("*{}*", escape_find_pattern_literal(query));
    let escaped_root = if root == "/" {
        String::new()
    } else {
        escape_find_pattern_literal(root)
    };
    let (frame_magic, frame_trailer) = remote_frame_tokens("SEARCH")?;
    let args = vec![
        root.to_string(),
        pattern,
        if include_hidden_dirs { "1" } else { "0" }.to_string(),
        limit.to_string(),
        format!("{escaped_root}/.*/*"),
        format!("{escaped_root}/*/.*/*"),
        frame_magic.clone(),
        frame_trailer.clone(),
    ];
    let command = build_sh_c_command(REMOTE_FILE_SEARCH_SCRIPT, Some("--"), &args);
    let output = run_ssh_read_only(
        target,
        &[command],
        Some(renderer_generation),
        SSH_COMMAND_STDOUT_LIMIT,
        "ssh file search",
    )?;
    if !output.status.success() {
        return Err(output_to_error("ssh search failed", &output));
    }
    parse_remote_search_frame_with_tokens(
        root,
        &output.stdout,
        limit,
        out.len() + limit,
        seen,
        out,
        frame_magic.as_bytes(),
        frame_trailer.as_bytes(),
    )
}

#[tauri::command]
pub async fn ssh_read_text_file(
    target: String,
    root: String,
    path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ssh_read_text_file_sync(target, root, path))
        .await
        .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_read_text_file_sync(target: String, root: String, path: String) -> Result<String, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let (root, path) = ensure_within_root(&root, &path)?;
    ensure_not_root(&root, &path, "read")?;

    let limit = MAX_TEXT_FILE_BYTES + 1;
    let script = format!(
        r#"set -e; file="$1"; [ -f "$file" ] || {{ echo "not a file" >&2; exit 1; }}; if command -v head >/dev/null 2>&1; then head -c {limit} "$file"; else dd if="$file" bs=1 count={limit}; fi"#
    );

    let command = build_sh_c_command(&script, Some("--"), &[path.clone()]);
    let args = vec![command];
    let output = run_ssh_read_only(
        target,
        &args,
        None,
        SSH_COMMAND_STDOUT_LIMIT,
        "ssh text read",
    )?;
    if !output.status.success() {
        return Err(output_to_error("ssh failed", &output));
    }

    let bytes = output.stdout;
    if bytes.len() > MAX_TEXT_FILE_BYTES {
        return Err(format!(
            "file too large (>{MAX_TEXT_FILE_BYTES} bytes); open smaller files only"
        ));
    }
    if bytes[..bytes.len().min(BINARY_CHECK_BYTES)]
        .iter()
        .any(|b| *b == 0)
    {
        return Err("binary files are not supported".to_string());
    }
    String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8".to_string())
}

#[tauri::command]
pub async fn ssh_probe_file(
    target: String,
    root: String,
    path: String,
) -> Result<FileProbe, String> {
    tauri::async_runtime::spawn_blocking(move || ssh_probe_file_sync(target, root, path))
        .await
        .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_probe_file_sync(target: String, root: String, path: String) -> Result<FileProbe, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let (root, path) = ensure_within_root(&root, &path)?;
    ensure_not_root(&root, &path, "read")?;

    let probe_bytes = PROBE_BYTES.to_string();
    let script = r#"set -e
file="$1"
count="$2"
[ -f "$file" ] || { echo "not a file" >&2; exit 1; }
size="$(wc -c < "$file" | tr -d '[:space:]')"
mtime=""
if stat -c %Y "$file" >/dev/null 2>&1; then
  mtime="$(stat -c %Y "$file" 2>/dev/null || true)"
elif stat -f %m "$file" >/dev/null 2>&1; then
  mtime="$(stat -f %m "$file" 2>/dev/null || true)"
fi
printf 'AGENTS_UI_PROBE size=%s mtime=%s\n' "$size" "$mtime" >&2
if command -v head >/dev/null 2>&1; then
  head -c "$count" "$file"
else
  dd if="$file" bs=1 count="$count" 2>/dev/null
fi"#;

    let command = build_sh_c_command(&script, Some("--"), &[path.clone(), probe_bytes]);
    let args = vec![command];
    let output = run_ssh_read_only(
        target,
        &args,
        None,
        SSH_COMMAND_STDOUT_LIMIT,
        "ssh file probe",
    )?;
    if !output.status.success() {
        return Err(output_to_error("ssh failed", &output));
    }
    let (size, mtime_ms) = parse_remote_file_meta(&output.stderr, "AGENTS_UI_PROBE ")?;
    Ok(probe_from_sample(
        size,
        mtime_ms,
        &output.stdout,
        Some(Path::new(&path)),
    ))
}

#[tauri::command]
pub async fn ssh_read_file_range(
    target: String,
    root: String,
    path: String,
    offset: u64,
    length: u64,
) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        ssh_read_file_range_sync(target, root, path, offset, length)
    })
    .await
    .map_err(|e| format!("ssh task join failed: {e:?}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

fn ssh_read_file_range_sync(
    target: String,
    root: String,
    path: String,
    offset: u64,
    length: u64,
) -> Result<Vec<u8>, String> {
    if length > MAX_RANGE_READ_BYTES as u64 {
        return Err(format!(
            "range too large ({length} bytes, max {MAX_RANGE_READ_BYTES} bytes)"
        ));
    }

    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let (root, path) = ensure_within_root(&root, &path)?;
    ensure_not_root(&root, &path, "read")?;

    let script = r#"set -e
file="$1"
offset="$2"
count="$3"
[ -f "$file" ] || { echo "not a file" >&2; exit 1; }
start=$((offset + 1))
if command -v tail >/dev/null 2>&1 && command -v head >/dev/null 2>&1; then
  tail -c +"$start" "$file" 2>/dev/null | head -c "$count"
else
  dd if="$file" bs=1 skip="$offset" count="$count" 2>/dev/null
fi"#;

    let command = build_sh_c_command(
        &script,
        Some("--"),
        &[path, offset.to_string(), length.to_string()],
    );
    let args = vec![command];
    let output = run_ssh_read_only(
        target,
        &args,
        None,
        SSH_COMMAND_STDOUT_LIMIT,
        "ssh range read",
    )?;
    if !output.status.success() {
        return Err(output_to_error("ssh failed", &output));
    }
    // Raw bytes; the frontend derives offset/eof from the request + known size.
    Ok(output.stdout)
}

#[tauri::command]
pub async fn ssh_write_text_file(
    target: String,
    root: String,
    path: String,
    content: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        ssh_write_text_file_sync(target, root, path, content)
    })
    .await
    .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_write_text_file_sync(
    target: String,
    root: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let (root, path) = ensure_within_root(&root, &path)?;
    ensure_not_root(&root, &path, "write")?;

    // Note: The editor uses a separate "dirty" flag, so avoid appending extra newlines here.
    // The EXIT trap removes the temp file on any failure (after a successful mv
    // it no longer exists, so the rm is a no-op). Permissions are copied from
    // the original before the rename, since mktemp creates 0600.
    let script = r#"set -e; file="$1"; [ -f "$file" ] || { echo "not a file" >&2; exit 1; }; dir=${file%/*}; [ -n "$dir" ] || dir=/; tmp=""; if command -v mktemp >/dev/null 2>&1; then tmp="$(mktemp "$dir/.agents-ui-tmp.XXXXXXXX" 2>/dev/null || true)"; fi; if [ -z "$tmp" ]; then tmp="$dir/.agents-ui-tmp.$$"; rm -f "$tmp"; fi; trap 'rm -f "$tmp"' EXIT; cat > "$tmp"; perms="$(stat -c %a "$file" 2>/dev/null || stat -f %Lp "$file" 2>/dev/null || echo '')"; if [ -n "$perms" ]; then chmod "$perms" "$tmp" 2>/dev/null || true; fi; mv "$tmp" "$file""#;

    let command = build_sh_c_command(script, Some("--"), &[path]);
    let args = vec![command];
    let output = run_ssh_mutation(
        target,
        &args,
        Some(content.as_bytes()),
        None,
        "ssh file write",
    )?;
    if !output.status.success() {
        return Err(output_to_error("ssh failed", &output));
    }
    Ok(())
}

/// POSIX `set -C` (noclobber) requires an exclusive create for `>` instead of
/// the racy "test then truncate" sequence. The explicit `-L` check gives a
/// stable error for dangling symlinks; the noclobber open remains the actual
/// race-safe guard.
const SSH_CREATE_FILE_EXCLUSIVE_SCRIPT: &str = r#"set -e
file=$1
parent=${file%/*}
[ -n "$parent" ] || parent=/
[ -d "$parent" ] || { echo "parent directory does not exist" >&2; exit 1; }
if [ -e "$file" ] || [ -L "$file" ]; then
  echo "file already exists" >&2
  exit 1
fi
if ! (set -C; : > "$file") 2>/dev/null; then
  if [ -e "$file" ] || [ -L "$file" ]; then
    echo "file already exists" >&2
  else
    echo "remote shell could not perform an exclusive file create" >&2
  fi
  exit 1
fi
"#;

const SSH_CREATE_DIRECTORY_SCRIPT: &str = r#"set -e
dir=$1
parent=${dir%/*}
[ -n "$parent" ] || parent=/
[ -d "$parent" ] || { echo "parent directory does not exist" >&2; exit 1; }
if [ -e "$dir" ] || [ -L "$dir" ]; then
  echo "directory already exists" >&2
  exit 1
fi
mkdir "$dir"
"#;

/// Perform one kernel-atomic no-replace rename. Shell-level `mv -n` is excluded:
/// on several implementations its existence check and rename are separate and
/// can overwrite a concurrently-created target. Linux `renameat2(2)` with
/// `RENAME_NOREPLACE` and Darwin `renamex_np(2)` with `RENAME_EXCL` supply the
/// required atomic primitives. Python is only the isolated FFI carrier;
/// unsupported hosts/libcs/filesystems fail closed without a fallback mutation.
const SSH_RENAME_NO_CLOBBER_SCRIPT: &str = r#"set -e
from=$1
to=$2
if ! command -v python3 >/dev/null 2>&1; then
  echo "remote atomic no-replace rename is unsupported (requires python3 and a native host primitive)" >&2
  exit 78
fi
exec python3 -I - "$from" "$to" <<'PY'
import ctypes
import errno
import os
import sys

source = os.fsencode(sys.argv[1])
destination = os.fsencode(sys.argv[2])
libc = ctypes.CDLL(None, use_errno=True)
ctypes.set_errno(0)
if sys.platform.startswith("linux"):
    try:
        renameat2 = libc.renameat2
    except AttributeError:
        sys.stderr.write("remote atomic no-replace rename is unsupported (Linux renameat2 unavailable)\n")
        raise SystemExit(78)
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    at_fdcwd = getattr(os, "AT_FDCWD", -100)
    RENAME_NOREPLACE = 1
    result = renameat2(at_fdcwd, source, at_fdcwd, destination, RENAME_NOREPLACE)
elif sys.platform == "darwin":
    try:
        renamex_np = libc.renamex_np
    except AttributeError:
        sys.stderr.write("remote atomic no-replace rename is unsupported (Darwin renamex_np unavailable)\n")
        raise SystemExit(78)
    renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    renamex_np.restype = ctypes.c_int
    RENAME_EXCL = 0x00000004
    result = renamex_np(source, destination, RENAME_EXCL)
else:
    sys.stderr.write("remote atomic no-replace rename is unsupported on this host\n")
    raise SystemExit(78)

if result == 0:
    raise SystemExit(0)

error = ctypes.get_errno()
if error in (errno.EEXIST, errno.ENOTEMPTY):
    sys.stderr.write("target already exists\n")
    raise SystemExit(17)
unsupported = {errno.ENOSYS, errno.EINVAL}
for name in ("EOPNOTSUPP", "ENOTSUP"):
    value = getattr(errno, name, None)
    if value is not None:
        unsupported.add(value)
if error in unsupported:
    sys.stderr.write("remote atomic no-replace rename is unsupported by the host filesystem\n")
    raise SystemExit(78)
if error == errno.ENOENT:
    sys.stderr.write("source or destination parent is missing\n")
    raise SystemExit(2)
if error == errno.EXDEV:
    sys.stderr.write("atomic remote rename cannot cross filesystems\n")
    raise SystemExit(18)
if error in (errno.EACCES, errno.EPERM, errno.EROFS):
    sys.stderr.write("atomic remote rename was denied by the remote filesystem\n")
    raise SystemExit(13)
sys.stderr.write("atomic remote rename failed: %s\n" % os.strerror(error))
raise SystemExit(1)
PY
"#;

#[tauri::command]
pub async fn ssh_create_file(target: String, root: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ssh_create_file_sync(target, root, path))
        .await
        .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_create_file_sync(target: String, root: String, path: String) -> Result<(), String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let (root, path) = ensure_within_root(&root, &path)?;
    ensure_not_root(&root, &path, "create")?;

    let command = build_sh_c_command(SSH_CREATE_FILE_EXCLUSIVE_SCRIPT, Some("--"), &[path]);
    let args = vec![command];
    let output = run_ssh_mutation(target, &args, None, None, "ssh file create")?;
    if !output.status.success() {
        return Err(output_to_error("ssh failed", &output));
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_create_directory(
    target: String,
    root: String,
    path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ssh_create_directory_sync(target, root, path))
        .await
        .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_create_directory_sync(target: String, root: String, path: String) -> Result<(), String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let (root, path) = ensure_within_root(&root, &path)?;
    ensure_not_root(&root, &path, "create")?;

    let command = build_sh_c_command(SSH_CREATE_DIRECTORY_SCRIPT, Some("--"), &[path]);
    let args = vec![command];
    let output = run_ssh_mutation(target, &args, None, None, "ssh directory create")?;
    if !output.status.success() {
        return Err(output_to_error("ssh failed", &output));
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_rename_fs_entry(
    target: String,
    root: String,
    path: String,
    new_name: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ssh_rename_fs_entry_sync(target, root, path, new_name)
    })
    .await
    .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_rename_fs_entry_sync(
    target: String,
    root: String,
    path: String,
    new_name: String,
) -> Result<String, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let (root, path) = ensure_within_root(&root, &path)?;
    ensure_not_root(&root, &path, "rename")?;

    let name = new_name.as_str();
    if name.is_empty() {
        return Err("missing new name".to_string());
    }
    if name == "." || name == ".." {
        return Err("invalid name".to_string());
    }
    if name.contains('\0') {
        return Err("name contains a NUL byte".to_string());
    }
    if name.contains('/') {
        return Err("name must not contain a slash".to_string());
    }

    let parent = {
        let idx = path.rfind('/').unwrap_or(0);
        if idx == 0 {
            "/".to_string()
        } else {
            path[..idx].to_string()
        }
    };
    let to = join_posix_path(&parent, name);
    let (_, to_checked) = ensure_within_root(&root, &to)?;
    if path == to_checked {
        return Ok(to_checked);
    }

    let command = build_sh_c_command(
        SSH_RENAME_NO_CLOBBER_SCRIPT,
        Some("--"),
        &[path, to_checked.clone()],
    );
    let args = vec![command];
    let output = run_ssh_mutation(target, &args, None, None, "ssh rename")?;
    if !output.status.success() {
        return Err(output_to_error("ssh failed", &output));
    }
    Ok(to_checked)
}

#[tauri::command]
pub async fn ssh_delete_fs_entry(target: String, root: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ssh_delete_fs_entry_sync(target, root, path))
        .await
        .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_delete_fs_entry_sync(target: String, root: String, path: String) -> Result<(), String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let (root, path) = ensure_within_root(&root, &path)?;
    ensure_not_root(&root, &path, "delete")?;

    let script = r#"set -e; path="$1"; rm -rf "$path""#;
    let command = build_sh_c_command(script, Some("--"), &[path]);
    let args = vec![command];
    let output = run_ssh_mutation(target, &args, None, None, "ssh delete")?;
    if !output.status.success() {
        return Err(output_to_error("ssh failed", &output));
    }
    Ok(())
}

/// Escape a remote path for scp. Legacy SCP uses LF as both a shell continuation
/// and a wire-record delimiter, so it cannot represent an LF-containing name
/// exactly; CR handling also varies across old implementations. Reject those
/// paths before starting any transfer rather than silently fetching/writing a
/// different name. Other shell/glob metacharacters are backslash-escaped for
/// both legacy SCP and OpenSSH's modern SFTP-backed scp mode.
fn scp_escape_remote_path(path: &str) -> Result<String, String> {
    // LF is both a shell line-continuation edge and the legacy SCP record
    // delimiter; CR handling differs across legacy implementations. NUL is not
    // a valid POSIX path byte. Other controls (including TAB) and backslash are
    // representable and remain supported rather than unnecessarily narrowing
    // the remote filesystem namespace.
    if let Some(character) = path
        .chars()
        .find(|character| matches!(character, '\0' | '\n' | '\r'))
    {
        return Err(format!(
            "remote path contains unsupported control character U+{:04X}; SCP cannot transfer it exactly",
            character as u32
        ));
    }
    let mut out = String::with_capacity(path.len());
    for ch in path.chars() {
        let safe = ch.is_ascii_alphanumeric()
            || matches!(
                ch,
                '/' | '-' | '_' | '.' | '+' | ',' | '@' | ':' | '=' | '%'
            );
        if !safe {
            out.push('\\');
        }
        out.push(ch);
    }
    Ok(out)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ScpProgressSample {
    bytes_transferred: u64,
    total_bytes: Option<u64>,
    bytes_per_second: Option<u64>,
    eta_seconds: Option<u64>,
    attempt: usize,
}

#[derive(Clone, Copy, Debug)]
enum ScpProgressEvent {
    Transferring(ScpProgressSample),
    Retrying { attempt: usize },
}

struct ScpPermit;

impl Drop for ScpPermit {
    fn drop(&mut self) {
        active_scp_processes().fetch_sub(1, Ordering::AcqRel);
    }
}

fn active_scp_processes() -> &'static AtomicUsize {
    static ACTIVE: AtomicUsize = AtomicUsize::new(0);
    &ACTIVE
}

fn scp_shutdown_requested() -> &'static AtomicBool {
    static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
    &SHUTTING_DOWN
}

fn ssh_transfer_generation() -> &'static AtomicU64 {
    static GENERATION: AtomicU64 = AtomicU64::new(1);
    &GENERATION
}

fn current_ssh_transfer_generation() -> u64 {
    ssh_transfer_generation().load(Ordering::Acquire)
}

fn active_scp_process_groups() -> &'static Mutex<HashMap<u32, Option<u64>>> {
    static PROCESS_GROUPS: OnceLock<Mutex<HashMap<u32, Option<u64>>>> = OnceLock::new();
    PROCESS_GROUPS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct ScpProcessRegistration<'a> {
    pid: u32,
    owner_slot: Option<&'a AtomicU64>,
}

impl<'a> ScpProcessRegistration<'a> {
    fn new(pid: u32, owner_slot: Option<&'a AtomicU64>, renderer_generation: Option<u64>) -> Self {
        active_scp_process_groups()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(pid, renderer_generation);
        if let Some(slot) = owner_slot {
            slot.store(pid as u64, Ordering::Release);
        }
        Self { pid, owner_slot }
    }
}

impl Drop for ScpProcessRegistration<'_> {
    fn drop(&mut self) {
        if let Some(slot) = self.owner_slot {
            let _ = slot.compare_exchange(self.pid as u64, 0, Ordering::AcqRel, Ordering::Acquire);
        }
        active_scp_process_groups()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.pid);
    }
}

fn acquire_scp_permit() -> Result<ScpPermit, String> {
    if scp_shutdown_requested().load(Ordering::Acquire) {
        return Err("file transfers are shutting down".to_string());
    }
    poll_deferred_ssh_fallback();
    let _ = deferred_ssh_child_sender()?;
    if deferred_ssh_child_count().load(Ordering::Acquire) >= MAX_DEFERRED_SSH_CHILDREN {
        return Err("SSH process cleanup is still pending; try again shortly".to_string());
    }
    let active = active_scp_processes();
    let mut current = active.load(Ordering::Acquire);
    loop {
        if current >= MAX_ACTIVE_SCP_PROCESSES {
            return Err(format!(
                "too many active file transfers (maximum {MAX_ACTIVE_SCP_PROCESSES})"
            ));
        }
        match active.compare_exchange_weak(
            current,
            current + 1,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => return Ok(ScpPermit),
            Err(next) => current = next,
        }
    }
}

fn validate_ssh_target(target: &str) -> Result<&str, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    if target.starts_with('-') || target.chars().any(char::is_control) {
        return Err("invalid ssh target".to_string());
    }
    Ok(target)
}

fn push_bounded_tail(out: &mut Vec<u8>, bytes: &[u8], limit: usize) {
    if limit == 0 {
        return;
    }
    if bytes.len() >= limit {
        out.clear();
        out.extend_from_slice(&bytes[bytes.len() - limit..]);
        return;
    }
    let overflow = out.len().saturating_add(bytes.len()).saturating_sub(limit);
    if overflow > 0 {
        out.drain(..overflow);
    }
    out.extend_from_slice(bytes);
}

#[cfg(target_family = "unix")]
fn configure_pipe_nonblocking(pipe: &impl std::os::fd::AsRawFd) -> std::io::Result<()> {
    let fd = pipe.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(std::io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(target_family = "unix"))]
fn configure_pipe_nonblocking<T>(_pipe: &T) -> std::io::Result<()> {
    Ok(())
}

fn read_bounded_prefix(
    mut reader: std::process::ChildStdout,
    limit: usize,
    overflowed: &AtomicBool,
    stop: &AtomicBool,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(limit.min(8 * 1024));
    let mut chunk = [0u8; 8 * 1024];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                let remaining = limit.saturating_sub(out.len());
                let retained = remaining.min(read);
                out.extend_from_slice(&chunk[..retained]);
                if retained < read {
                    overflowed.store(true, Ordering::Release);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if stop.load(Ordering::Acquire) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => break,
        }
    }
    out
}

fn read_scp_stderr_tail(
    mut reader: std::process::ChildStderr,
    limit: usize,
    stop: &AtomicBool,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(limit.min(8 * 1024));
    let mut chunk = [0u8; 8 * 1024];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => push_bounded_tail(&mut out, &chunk[..read], limit),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if stop.load(Ordering::Acquire) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => break,
        }
    }
    out
}

fn path_size_for_progress_controlled(
    path: &Path,
    is_directory_hint: bool,
    cancelled: Option<&AtomicBool>,
    entry_limit: usize,
) -> Option<u64> {
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return None;
    }
    if !is_directory_hint {
        let metadata = std::fs::symlink_metadata(path).ok()?;
        if !metadata.is_dir() {
            return Some(metadata.len());
        }
    }

    let mut total = 0u64;
    let mut visited = 0usize;
    let mut pending = vec![path.to_path_buf()];
    while let Some(current) = pending.pop() {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return None;
        }
        let metadata = match std::fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return None,
        };
        visited += 1;
        if visited > entry_limit {
            // Re-walking a huge tree every second would turn progress reporting
            // into the bottleneck. Keep folder progress honest/indeterminate.
            return None;
        }
        if metadata.is_file() {
            total = total.saturating_add(metadata.len());
        } else if metadata.is_dir() {
            let entries = std::fs::read_dir(&current).ok()?;
            for entry in entries {
                if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
                    return None;
                }
                if visited.saturating_add(pending.len()) >= entry_limit {
                    return None;
                }
                pending.push(entry.ok()?.path());
            }
        }
    }
    Some(total)
}

fn path_size_for_progress(
    path: &Path,
    is_directory_hint: bool,
    cancelled: Option<&AtomicBool>,
) -> Option<u64> {
    path_size_for_progress_controlled(
        path,
        is_directory_hint,
        cancelled,
        SCP_DIRECTORY_SCAN_ENTRY_LIMIT,
    )
}

struct ProgressEstimator {
    started_at: Instant,
    last_sample_at: Instant,
    last_progress_at: Instant,
    last_bytes: u64,
    smoothed_rate: Option<f64>,
}

impl ProgressEstimator {
    fn new() -> Self {
        let now = Instant::now();
        Self {
            started_at: now,
            last_sample_at: now,
            last_progress_at: now,
            last_bytes: 0,
            smoothed_rate: None,
        }
    }

    fn sample(
        &mut self,
        bytes: u64,
        total_bytes: Option<u64>,
        attempt: usize,
    ) -> ScpProgressSample {
        // The tree listing is a point-in-time hint. If the remote file grew
        // after that listing, stop claiming a false percentage/ETA.
        let total_bytes = total_bytes.filter(|total| *total >= bytes);
        let now = Instant::now();
        let elapsed = now
            .saturating_duration_since(self.last_sample_at)
            .as_secs_f64();
        if bytes >= self.last_bytes && elapsed > 0.0 {
            let delta = bytes - self.last_bytes;
            if delta > 0 {
                self.last_progress_at = now;
                let instantaneous = delta as f64 / elapsed;
                self.smoothed_rate = Some(match self.smoothed_rate {
                    Some(previous) => previous * 0.75 + instantaneous * 0.25,
                    None => instantaneous,
                });
            }
            if delta == 0
                && now.saturating_duration_since(self.last_progress_at) >= Duration::from_secs(3)
            {
                self.smoothed_rate = None;
            }
        } else if bytes < self.last_bytes {
            self.smoothed_rate = None;
            self.last_progress_at = now;
        }
        self.last_sample_at = now;
        self.last_bytes = bytes;

        let bytes_per_second = self
            .smoothed_rate
            .filter(|rate| rate.is_finite() && *rate >= 1.0)
            .map(|rate| rate.min(u64::MAX as f64) as u64);
        let eta_seconds = if self.started_at.elapsed() >= Duration::from_secs(2) {
            total_bytes
                .zip(self.smoothed_rate)
                .and_then(|(total, rate)| {
                    total.checked_sub(bytes).map(|remaining| (remaining, rate))
                })
                .filter(|(_, rate)| rate.is_finite() && *rate >= 1.0)
                .map(|(remaining, rate)| {
                    (remaining as f64 / rate).ceil().min(u64::MAX as f64) as u64
                })
        } else {
            None
        };

        ScpProgressSample {
            bytes_transferred: bytes,
            total_bytes,
            bytes_per_second,
            eta_seconds,
            attempt,
        }
    }
}

fn sleep_with_cancellation(duration: Duration, cancelled: &AtomicBool) -> Result<(), String> {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline {
        if cancelled.load(Ordering::Acquire) {
            return Err("download cancelled".to_string());
        }
        std::thread::sleep(
            SCP_POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
        );
    }
    Ok(())
}

struct SupervisedChild(Option<std::process::Child>);

impl SupervisedChild {
    fn new(child: std::process::Child) -> Self {
        Self(Some(child))
    }
}

impl std::ops::Deref for SupervisedChild {
    type Target = std::process::Child;

    fn deref(&self) -> &Self::Target {
        self.0
            .as_ref()
            .expect("supervised child used after ownership transfer")
    }
}

impl std::ops::DerefMut for SupervisedChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.0
            .as_mut()
            .expect("supervised child used after ownership transfer")
    }
}

impl Drop for SupervisedChild {
    fn drop(&mut self) {
        // std::process::Child::drop neither kills nor reaps. Contain panics in
        // progress/channel code and every early-return path with an RAII guard.
        let Some(mut child) = self.0.take() else {
            return;
        };
        match child.try_wait() {
            Ok(Some(_)) => {}
            Ok(None) => terminate_owned_scp_process(child),
            Err(error) => {
                // An error can mean another owner already reaped the process.
                // Never signal a raw, potentially reusable PID in that state.
                eprintln!("[ssh] query supervised child during drop failed: {error}");
            }
        }
    }
}

fn deferred_ssh_child_count() -> &'static AtomicUsize {
    static COUNT: AtomicUsize = AtomicUsize::new(0);
    &COUNT
}

fn deferred_ssh_fallback() -> &'static Mutex<Vec<std::process::Child>> {
    static CHILDREN: OnceLock<Mutex<Vec<std::process::Child>>> = OnceLock::new();
    CHILDREN.get_or_init(|| Mutex::new(Vec::new()))
}

// `try_wait()` above the removal has already reaped completed children; Clippy
// cannot follow that state through `swap_remove`.
#[allow(clippy::zombie_processes)]
fn poll_deferred_ssh_fallback() {
    let mut children = deferred_ssh_fallback()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut index = 0;
    while index < children.len() {
        let finished = match children[index].try_wait() {
            Ok(Some(_)) => true,
            Ok(None) => false,
            Err(error) => {
                eprintln!("[ssh] fallback child reap failed: {error}");
                true
            }
        };
        if finished {
            children.swap_remove(index);
            deferred_ssh_child_count().fetch_sub(1, Ordering::AcqRel);
        } else {
            index += 1;
        }
    }
}

// The reaper calls `try_wait()` before removing each completed Child handle.
#[allow(clippy::zombie_processes)]
fn deferred_ssh_child_sender() -> Result<std::sync::mpsc::Sender<std::process::Child>, String> {
    static SENDER: OnceLock<std::sync::mpsc::Sender<std::process::Child>> = OnceLock::new();
    if let Some(sender) = SENDER.get() {
        return Ok(sender.clone());
    }

    let (sender, receiver) = std::sync::mpsc::channel::<std::process::Child>();
    std::thread::Builder::new()
        .name("ssh-child-reaper".to_string())
        .spawn(move || {
            let mut pending = Vec::<std::process::Child>::new();
            loop {
                match receiver.recv_timeout(Duration::from_millis(250)) {
                    Ok(child) => pending.push(child),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        if pending.is_empty() {
                            break;
                        }
                    }
                }
                while let Ok(child) = receiver.try_recv() {
                    pending.push(child);
                }
                let mut index = 0;
                while index < pending.len() {
                    let finished = match pending[index].try_wait() {
                        Ok(Some(_)) => true,
                        Ok(None) => false,
                        Err(error) => {
                            eprintln!("[ssh] deferred child reap failed: {error}");
                            true
                        }
                    };
                    if finished {
                        pending.swap_remove(index);
                        deferred_ssh_child_count().fetch_sub(1, Ordering::AcqRel);
                    } else {
                        index += 1;
                    }
                }
            }
        })
        .map_err(|error| format!("start SSH child reaper failed: {error}"))?;

    let _ = SENDER.set(sender.clone());
    Ok(SENDER.get().cloned().unwrap_or(sender))
}

fn defer_ssh_child_reap(child: std::process::Child) {
    let sender = match deferred_ssh_child_sender() {
        Ok(sender) => sender,
        Err(error) => {
            eprintln!("[ssh] {error}; retaining child for bounded polling");
            deferred_ssh_child_count().fetch_add(1, Ordering::AcqRel);
            deferred_ssh_fallback()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(child);
            return;
        }
    };
    deferred_ssh_child_count().fetch_add(1, Ordering::AcqRel);
    if let Err(error) = sender.send(child) {
        eprintln!("[ssh] child reaper stopped unexpectedly; retaining child for bounded polling");
        deferred_ssh_fallback()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(error.0);
    }
}

fn terminate_scp_process(child: &mut SupervisedChild) {
    if let Some(child) = child.0.take() {
        terminate_owned_scp_process(child);
    }
}

fn terminate_owned_scp_process(mut child: std::process::Child) {
    let process_group_id = child.id();
    let mut parent_reaped = match child.try_wait() {
        Ok(Some(_)) => true,
        Ok(None) => false,
        Err(error) => {
            // Losing wait ownership makes this numeric PID unsafe to signal:
            // it may already have been reaped and reused.
            eprintln!("[ssh] query child before termination failed: {error}");
            return;
        }
    };
    if parent_reaped {
        return;
    }

    #[cfg(target_family = "unix")]
    unsafe {
        // scp is placed in its own process group before spawn. Terminating the
        // group also stops its ssh child, so cancellation cannot leave a hidden
        // process holding pipes, sockets, or the destination file.
        let _ = libc::kill(-(process_group_id as i32), libc::SIGTERM);
    }
    #[cfg(not(target_family = "unix"))]
    let _ = child.kill();

    let deadline = Instant::now() + Duration::from_millis(750);
    while Instant::now() < deadline {
        if !parent_reaped {
            match child.try_wait() {
                Ok(Some(_)) => parent_reaped = true,
                Ok(None) => {}
                Err(error) => {
                    eprintln!("[ssh] query child during termination failed: {error}");
                    return;
                }
            }
        }

        #[cfg(target_family = "unix")]
        if !scp_process_group_exists(process_group_id) {
            break;
        }
        #[cfg(not(target_family = "unix"))]
        if parent_reaped {
            break;
        }

        std::thread::sleep(Duration::from_millis(25));
    }

    #[cfg(target_family = "unix")]
    if scp_process_group_exists(process_group_id) {
        // Do this even when the direct scp parent already exited: an ssh child
        // may ignore or outlive SIGTERM while retaining pipes/files.
        unsafe {
            let _ = libc::kill(-(process_group_id as i32), libc::SIGKILL);
        }
    }
    if !parent_reaped {
        let _ = child.kill();
        // SIGKILL can remain pending while a process is stuck in an
        // uninterruptible kernel I/O operation. Never turn our bounded grace
        // period back into an unbounded Child::wait(). Give it one final
        // bounded reap window, then let the global WNOHANG reaper own it.
        let reap_deadline = Instant::now() + Duration::from_millis(250);
        while Instant::now() < reap_deadline {
            match child.try_wait() {
                Ok(Some(_)) => {
                    parent_reaped = true;
                    break;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(error) => {
                    eprintln!("[ssh] query killed child failed: {error}");
                    return;
                }
            }
        }
        if !parent_reaped {
            defer_ssh_child_reap(child);
        }
    }
}

#[cfg(target_family = "unix")]
fn scp_process_group_exists(pid: u32) -> bool {
    unsafe { libc::kill(-(pid as i32), 0) == 0 }
}

#[cfg(target_family = "unix")]
fn terminate_remaining_scp_process_group(pid: u32) {
    unsafe {
        let _ = libc::kill(-(pid as i32), libc::SIGTERM);
    }
    std::thread::sleep(Duration::from_millis(100));
    if scp_process_group_exists(pid) {
        unsafe {
            let _ = libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
}

fn collect_scp_stderr(
    receiver: &std::sync::mpsc::Receiver<Vec<u8>>,
    stop: &AtomicBool,
    process_group_id: u32,
) -> Vec<u8> {
    match receiver.recv_timeout(Duration::from_millis(250)) {
        Ok(stderr) => stderr,
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Vec::new(),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            // A descendant that inherited stderr can keep the pipe open after
            // scp exits. Stop the nonblocking reader and tear down the leftover
            // process group so neither a thread nor a child leaks per transfer.
            stop.store(true, Ordering::Release);
            #[cfg(target_family = "unix")]
            terminate_remaining_scp_process_group(process_group_id);
            receiver
                .recv_timeout(Duration::from_secs(1))
                .unwrap_or_default()
        }
    }
}

#[derive(Clone, Copy)]
struct ScpControl<'a> {
    cancelled: &'a AtomicBool,
    renderer_generation: Option<u64>,
    process_group_slot: Option<&'a AtomicU64>,
    progress_path: Option<&'a Path>,
    is_directory: bool,
    total_bytes: Option<u64>,
    clean_stage_between_attempts: bool,
}

fn scp_control_cancelled(control: ScpControl<'_>) -> bool {
    control.cancelled.load(Ordering::Acquire)
        || control
            .renderer_generation
            .is_some_and(|generation| generation != current_ssh_transfer_generation())
        || scp_shutdown_requested().load(Ordering::Acquire)
}

fn run_scp_once_controlled<F>(
    scp_program: &Path,
    scp_flags: &[&str],
    paths: &[String],
    control: ScpControl<'_>,
    attempt: usize,
    on_progress: &mut F,
) -> Result<Output, String>
where
    F: FnMut(ScpProgressEvent),
{
    let mut cmd = Command::new(scp_program);
    cmd.args(scp_flags);
    cmd.args(ssh_transfer_args());
    // End option parsing before source/destination strings. In particular, an
    // option-shaped target must never be interpreted as an scp flag.
    cmd.arg("--");
    cmd.args(paths);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());
    #[cfg(target_family = "unix")]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child =
        SupervisedChild::new(cmd.spawn().map_err(|e| format!("spawn scp failed: {e}"))?);
    let process_group_id = child.id();
    let process_registration = ScpProcessRegistration::new(
        process_group_id,
        control.process_group_slot,
        control.renderer_generation,
    );
    if scp_control_cancelled(control) {
        terminate_scp_process(&mut child);
        return Err("file transfer cancelled".to_string());
    }
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_scp_process(&mut child);
            return Err("scp stderr pipe unavailable".to_string());
        }
    };
    if let Err(error) = configure_pipe_nonblocking(&stderr) {
        terminate_scp_process(&mut child);
        return Err(format!("configure scp stderr pipe failed: {error}"));
    }
    let (stderr_sender, stderr_receiver) = std::sync::mpsc::sync_channel(1);
    let stderr_stop = Arc::new(AtomicBool::new(false));
    let stderr_reader_stop = stderr_stop.clone();
    let stderr_reader = std::thread::Builder::new()
        .name("scp-stderr-drain".to_string())
        .spawn(move || {
            let tail = read_scp_stderr_tail(stderr, SCP_DIAGNOSTIC_TAIL_BYTES, &stderr_reader_stop);
            let _ = stderr_sender.send(tail);
        });
    if let Err(error) = stderr_reader {
        terminate_scp_process(&mut child);
        return Err(format!("start scp diagnostics reader failed: {error}"));
    }

    let mut estimator = ProgressEstimator::new();
    let mut last_emitted_sample = Some(ScpProgressSample {
        bytes_transferred: 0,
        total_bytes: control.total_bytes,
        bytes_per_second: None,
        eta_seconds: None,
        attempt,
    });
    let mut next_progress_at = Instant::now();
    let progress_interval = if control.is_directory {
        SCP_DIRECTORY_PROGRESS_INTERVAL
    } else {
        SCP_PROGRESS_INTERVAL
    };

    let status = loop {
        if scp_control_cancelled(control) {
            terminate_scp_process(&mut child);
            let _ = collect_scp_stderr(&stderr_receiver, &stderr_stop, process_group_id);
            return Err("file transfer cancelled".to_string());
        }

        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                terminate_scp_process(&mut child);
                let _ = collect_scp_stderr(&stderr_receiver, &stderr_stop, process_group_id);
                return Err(format!("wait scp failed: {error}"));
            }
        }

        let now = Instant::now();
        if now >= next_progress_at {
            if let Some(path) = control.progress_path {
                let bytes =
                    path_size_for_progress(path, control.is_directory, Some(control.cancelled))
                        .unwrap_or(estimator.last_bytes);
                let sample = estimator.sample(bytes, control.total_bytes, attempt);
                // Channel delivery ultimately queues work for the WebContent
                // event loop. Coalesce unchanged samples so display sleep or a
                // paused renderer cannot accumulate identical scripts. A
                // sample still changes once when a 3s stall clears rate/ETA.
                if last_emitted_sample != Some(sample) {
                    on_progress(ScpProgressEvent::Transferring(sample));
                    last_emitted_sample = Some(sample);
                }
            }
            // Schedule from the completed scan. Otherwise a scan that takes
            // longer than its interval immediately starts another traversal.
            next_progress_at = Instant::now() + progress_interval;
        }
        std::thread::sleep(SCP_POLL_INTERVAL);
    };

    let stderr = collect_scp_stderr(&stderr_receiver, &stderr_stop, process_group_id);
    #[cfg(target_family = "unix")]
    if scp_process_group_exists(process_group_id) {
        terminate_remaining_scp_process_group(process_group_id);
    }
    // Clear the externally visible process handle immediately after the child
    // tree is gone, before any potentially slow final filesystem scan.
    drop(process_registration);

    if let Some(path) = control.progress_path {
        let bytes = path_size_for_progress(path, control.is_directory, Some(control.cancelled))
            .unwrap_or(estimator.last_bytes);
        let sample = estimator.sample(bytes, control.total_bytes, attempt);
        if last_emitted_sample != Some(sample) {
            on_progress(ScpProgressEvent::Transferring(sample));
        }
    }
    Ok(Output {
        status,
        stdout: Vec::new(),
        stderr,
    })
}

fn remove_owned_stage(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(path)
            .map_err(|e| format!("remove partial download failed: {e}")),
        Ok(_) => {
            std::fs::remove_file(path).map_err(|e| format!("remove partial download failed: {e}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("inspect partial download failed: {error}")),
    }
}

struct OwnedStageGuard {
    root: PathBuf,
    payload: PathBuf,
}

impl OwnedStageGuard {
    fn create(parent: &Path) -> Result<Self, String> {
        static NEXT_STAGE: AtomicU64 = AtomicU64::new(1);
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        for _ in 0..10_000 {
            let root = parent.join(format!(
                ".agents-ui-download-{}-{timestamp}-{}.part",
                std::process::id(),
                NEXT_STAGE.fetch_add(1, Ordering::Relaxed)
            ));
            let mut builder = std::fs::DirBuilder::new();
            #[cfg(target_family = "unix")]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match builder.create(&root) {
                Ok(()) => {
                    let payload = root.join("payload");
                    return Ok(Self { root, payload });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("create private download stage failed: {error}")),
            }
        }
        Err("could not allocate a private download staging directory".to_string())
    }
}

impl Drop for OwnedStageGuard {
    fn drop(&mut self) {
        // The payload is moved out on success, leaving an empty private root.
        // On every failure path this removes the partial payload recursively.
        let _ = remove_owned_stage(&self.root);
    }
}

/// Run scp on a dedicated SSH connection with bounded diagnostics, bounded
/// concurrency, cancellation, guaranteed reaping, and transient retries.
fn run_scp_controlled<F>(
    target: &str,
    scp_flags: &[&str],
    paths: &[String],
    control: ScpControl<'_>,
    mut on_progress: F,
) -> Result<Output, String>
where
    F: FnMut(ScpProgressEvent),
{
    validate_ssh_target(target)?;
    if scp_control_cancelled(control) {
        return Err("file transfer cancelled".to_string());
    }
    let scp_program = program_path("scp")?;
    let _permit = acquire_scp_permit()?;
    let mut last_output: Option<Output> = None;
    // Retrying a recursive copy into a partial destination can nest or merge
    // stale contents. Only the private-stage path can be cleaned safely between
    // attempts; direct API downloads and uploads fail honestly after one try.
    let max_attempts = if control.clean_stage_between_attempts {
        SSH_OP_ATTEMPTS
    } else {
        1
    };
    for attempt_index in 0..max_attempts {
        let attempt = attempt_index + 1;
        if attempt_index > 0 {
            on_progress(ScpProgressEvent::Retrying { attempt });
            sleep_with_cancellation(
                Duration::from_millis(250 * attempt_index as u64),
                control.cancelled,
            )?;
            if control.clean_stage_between_attempts {
                if let Some(path) = control.progress_path {
                    remove_owned_stage(path)?;
                }
            }
        }
        if scp_control_cancelled(control) {
            return Err("file transfer cancelled".to_string());
        }

        let output = run_scp_once_controlled(
            &scp_program,
            scp_flags,
            paths,
            control,
            attempt,
            &mut on_progress,
        )?;
        if output.status.success() {
            return Ok(output);
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !is_transient_ssh_error(&stderr) {
            return Ok(output);
        }
        last_output = Some(output);
    }
    last_output.ok_or_else(|| "scp failed before its first attempt".to_string())
}

fn run_scp(
    target: &str,
    scp_flags: &[&str],
    paths: &[String],
    renderer_generation: Option<u64>,
) -> Result<Output, String> {
    let cancelled = AtomicBool::new(false);
    run_scp_controlled(
        target,
        scp_flags,
        paths,
        ScpControl {
            cancelled: &cancelled,
            renderer_generation,
            process_group_slot: None,
            progress_path: None,
            is_directory: false,
            total_bytes: None,
            clean_stage_between_attempts: false,
        },
        |_| {},
    )
}

#[derive(Clone)]
struct ActiveDownload {
    cancelled: Arc<AtomicBool>,
    phase: Arc<AtomicU8>,
    process_group: Arc<AtomicU64>,
    renderer_generation: Option<u64>,
    destination: PathBuf,
    stage_root: Option<PathBuf>,
}

const DOWNLOAD_PHASE_TRANSFERRING: u8 = 0;
const DOWNLOAD_PHASE_CANCELLED: u8 = 1;
const DOWNLOAD_PHASE_COMMITTING: u8 = 2;

struct DownloadJobPermit;

impl Drop for DownloadJobPermit {
    fn drop(&mut self) {
        active_download_jobs().fetch_sub(1, Ordering::AcqRel);
    }
}

fn active_download_jobs() -> &'static AtomicUsize {
    static ACTIVE: AtomicUsize = AtomicUsize::new(0);
    &ACTIVE
}

fn acquire_download_job_permit() -> Result<DownloadJobPermit, String> {
    active_download_jobs()
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
            (active < MAX_ACTIVE_DOWNLOADS).then_some(active + 1)
        })
        .map(|_| DownloadJobPermit)
        .map_err(|_| format!("too many active downloads (maximum {MAX_ACTIVE_DOWNLOADS})"))
}

#[derive(Default)]
struct DownloadRegistry {
    active: HashMap<String, ActiveDownload>,
    pending_cancellations: HashMap<String, Instant>,
}

fn download_registry() -> &'static Mutex<DownloadRegistry> {
    static DOWNLOADS: OnceLock<Mutex<DownloadRegistry>> = OnceLock::new();
    DOWNLOADS.get_or_init(|| Mutex::new(DownloadRegistry::default()))
}

fn prune_pending_cancellations(registry: &mut DownloadRegistry) {
    const PENDING_CANCELLATION_TTL: Duration = Duration::from_secs(60);
    registry
        .pending_cancellations
        .retain(|_, created_at| created_at.elapsed() < PENDING_CANCELLATION_TTL);
}

struct ActiveDownloadGuard {
    transfer_id: String,
}

type DownloadRegistration = (
    ActiveDownloadGuard,
    Arc<AtomicBool>,
    Arc<AtomicU8>,
    Arc<AtomicU64>,
);
type ReservedDownloadRegistration = (
    ActiveDownloadGuard,
    Arc<AtomicBool>,
    Arc<AtomicU8>,
    Arc<AtomicU64>,
    PathBuf,
);

impl Drop for ActiveDownloadGuard {
    fn drop(&mut self) {
        let mut registry = download_registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        registry.active.remove(&self.transfer_id);
    }
}

fn validate_transfer_id(transfer_id: &str) -> Result<&str, String> {
    if transfer_id.is_empty()
        || transfer_id.len() > 128
        || !transfer_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid download transfer id".to_string());
    }
    Ok(transfer_id)
}

fn is_windows_reserved_basename(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name);
    let upper = stem.to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$"
    ) || (upper.len() == 4
        && (upper.starts_with("COM") || upper.starts_with("LPT"))
        && matches!(upper.as_bytes()[3], b'1'..=b'9'))
}

fn validate_download_name_for_platform(name: &str, windows: bool) -> Result<&str, String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\0')
        // Backslash and colon are ordinary POSIX/macOS filename characters.
        // On Windows, backslash is a separator and colon permits drive prefixes
        // or alternate data streams, neither of which is a safe basename.
        || (windows
            && (name.contains('\\')
                || name
                    .chars()
                    .any(|character| character.is_control() || "<>:\"|?*".contains(character))
                || name.ends_with('.')
                || name.ends_with(' ')
                || is_windows_reserved_basename(name)))
    {
        return Err("invalid download file name".to_string());
    }
    Ok(name)
}

fn validate_download_name(name: &str) -> Result<&str, String> {
    validate_download_name_for_platform(name, cfg!(target_family = "windows"))
}

fn numbered_destination(directory: &Path, name: &str, index: usize) -> PathBuf {
    if index == 0 {
        return directory.join(name);
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(name);
    let extension = path.extension().and_then(|value| value.to_str());
    let numbered = match extension {
        Some(extension) if !extension.is_empty() => format!("{stem} ({index}).{extension}"),
        _ => format!("{stem} ({index})"),
    };
    directory.join(numbered)
}

fn register_download(
    transfer_id: String,
    destination: PathBuf,
) -> Result<DownloadRegistration, String> {
    validate_transfer_id(&transfer_id)?;
    let mut registry = download_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    prune_pending_cancellations(&mut registry);
    if registry.active.len() >= MAX_ACTIVE_DOWNLOADS {
        return Err(format!(
            "too many active downloads (maximum {MAX_ACTIVE_DOWNLOADS})"
        ));
    }
    if registry.active.contains_key(&transfer_id) {
        return Err("download transfer id is already active".to_string());
    }
    if registry
        .active
        .values()
        .any(|download| download.destination == destination)
    {
        return Err("another download is already writing to that destination".to_string());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    let phase = Arc::new(AtomicU8::new(DOWNLOAD_PHASE_TRANSFERRING));
    let process_group = Arc::new(AtomicU64::new(0));
    if registry
        .pending_cancellations
        .remove(&transfer_id)
        .is_some()
    {
        cancelled.store(true, Ordering::Release);
        phase.store(DOWNLOAD_PHASE_CANCELLED, Ordering::Release);
    }
    registry.active.insert(
        transfer_id.clone(),
        ActiveDownload {
            cancelled: cancelled.clone(),
            phase: phase.clone(),
            process_group: process_group.clone(),
            renderer_generation: None,
            destination,
            stage_root: None,
        },
    );
    Ok((
        ActiveDownloadGuard { transfer_id },
        cancelled,
        phase,
        process_group,
    ))
}

fn reserve_download_destination(
    transfer_id: String,
    local_directory: &str,
    suggested_name: &str,
    renderer_generation: u64,
) -> Result<ReservedDownloadRegistration, String> {
    if renderer_generation != current_ssh_transfer_generation() {
        return Err("download belonged to a terminated renderer".to_string());
    }
    validate_transfer_id(&transfer_id)?;
    let suggested_name = validate_download_name(suggested_name)?;
    let local_directory = validate_local_path_input(local_directory, "missing download folder")?;
    let directory = std::fs::canonicalize(local_directory)
        .map_err(|e| format!("open download folder failed: {e}"))?;
    local_path_to_utf8(&directory, "download folder")?;
    if renderer_generation != current_ssh_transfer_generation() {
        return Err("download belonged to a terminated renderer".to_string());
    }
    if !directory.is_dir() {
        return Err("download destination is not a directory".to_string());
    }

    for index in 0..10_000 {
        let destination = numbered_destination(&directory, suggested_name, index);
        match std::fs::symlink_metadata(&destination) {
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("inspect download destination failed: {error}"));
            }
        }

        // Do not hold the registry mutex across filesystem calls: a slow
        // network-backed destination must never block a cancellation command.
        let mut registry = download_registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        prune_pending_cancellations(&mut registry);
        if registry.active.len() >= MAX_ACTIVE_DOWNLOADS {
            return Err(format!(
                "too many active downloads (maximum {MAX_ACTIVE_DOWNLOADS})"
            ));
        }
        if registry.active.contains_key(&transfer_id) {
            return Err("download transfer id is already active".to_string());
        }
        if registry
            .active
            .values()
            .any(|download| download.destination == destination)
        {
            continue;
        }

        let cancelled = Arc::new(AtomicBool::new(false));
        let phase = Arc::new(AtomicU8::new(DOWNLOAD_PHASE_TRANSFERRING));
        let process_group = Arc::new(AtomicU64::new(0));
        if registry
            .pending_cancellations
            .remove(&transfer_id)
            .is_some()
        {
            cancelled.store(true, Ordering::Release);
            phase.store(DOWNLOAD_PHASE_CANCELLED, Ordering::Release);
        }
        registry.active.insert(
            transfer_id.clone(),
            ActiveDownload {
                cancelled: cancelled.clone(),
                phase: phase.clone(),
                process_group: process_group.clone(),
                renderer_generation: Some(renderer_generation),
                destination: destination.clone(),
                stage_root: None,
            },
        );
        return Ok((
            ActiveDownloadGuard { transfer_id },
            cancelled,
            phase,
            process_group,
            destination,
        ));
    }
    Err("could not allocate a unique download destination".to_string())
}

fn set_download_stage(transfer_id: &str, stage_root: PathBuf) -> Result<(), String> {
    let mut registry = download_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let download = registry
        .active
        .get_mut(transfer_id)
        .ok_or_else(|| "download registration disappeared".to_string())?;
    download.stage_root = Some(stage_root);
    Ok(())
}

fn begin_download_commit(phase: &AtomicU8) -> Result<(), String> {
    phase
        .compare_exchange(
            DOWNLOAD_PHASE_TRANSFERRING,
            DOWNLOAD_PHASE_COMMITTING,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .map(|_| ())
        .map_err(|observed| match observed {
            DOWNLOAD_PHASE_CANCELLED => "download cancelled".to_string(),
            DOWNLOAD_PHASE_COMMITTING => "download is already finalizing".to_string(),
            _ => "download entered an invalid state".to_string(),
        })
}

fn next_internal_transfer_id() -> String {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    format!(
        "internal-{}-{}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}

/// Publish a sibling staging path without ever replacing an entry that another
/// process created after reservation. The platform primitives make the
/// no-overwrite property atomic rather than relying on a racy exists check.
fn publish_stage_no_replace(stage: &Path, destination: &Path) -> std::io::Result<()> {
    rename_no_replace(stage, destination)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTransferProgress {
    transfer_id: String,
    phase: String,
    bytes_transferred: u64,
    total_bytes: Option<u64>,
    bytes_per_second: Option<u64>,
    eta_seconds: Option<u64>,
    attempt: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshDownloadResult {
    local_path: String,
}

#[tauri::command]
pub fn default_download_directory() -> Result<String, String> {
    // Return Home without touching the filesystem. Homes can be network-backed;
    // probing Downloads here could strand a blocking task before the bounded
    // async folder browser even opens. Downloads remains one visible click.
    let home = home_dir().ok_or_else(|| "could not determine the home directory".to_string())?;
    local_path_to_utf8(&home, "home directory")
}

fn request_download_cancellation(download: &ActiveDownload) -> bool {
    loop {
        match download.phase.load(Ordering::Acquire) {
            DOWNLOAD_PHASE_TRANSFERRING => {
                if download
                    .phase
                    .compare_exchange(
                        DOWNLOAD_PHASE_TRANSFERRING,
                        DOWNLOAD_PHASE_CANCELLED,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    )
                    .is_ok()
                {
                    download.cancelled.store(true, Ordering::Release);
                    return true;
                }
            }
            DOWNLOAD_PHASE_CANCELLED => {
                download.cancelled.store(true, Ordering::Release);
                return true;
            }
            DOWNLOAD_PHASE_COMMITTING => return false,
            _ => return false,
        }
    }
}

fn signal_active_download(download: &ActiveDownload) {
    let process_group = download.process_group.load(Ordering::Acquire);
    if process_group == 0 || process_group > u32::MAX as u64 {
        return;
    }
    #[cfg(target_family = "unix")]
    unsafe {
        // Best effort and nonblocking. The supervised worker performs the
        // grace-period escalation and reap; this wakes a stopped/stuck child
        // immediately so it can observe the cancellation state.
        let _ = libc::kill(-(process_group as i32), libc::SIGTERM);
    }
}

#[tauri::command]
pub fn ssh_cancel_download(transfer_id: String) -> Result<bool, String> {
    validate_transfer_id(&transfer_id)?;
    let mut registry = download_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    prune_pending_cancellations(&mut registry);
    if let Some(download) = registry.active.get(&transfer_id).cloned() {
        drop(registry);
        let accepted = request_download_cancellation(&download);
        if accepted {
            signal_active_download(&download);
        }
        return Ok(accepted);
    }
    // Cancellation can overtake spawn_blocking registration even when the UI
    // sent the download invoke first. Retain a short-lived, bounded tombstone
    // so the worker observes that intent before spawning scp.
    const MAX_PENDING_CANCELLATIONS: usize = 128;
    if registry.pending_cancellations.len() >= MAX_PENDING_CANCELLATIONS {
        if let Some(oldest) = registry
            .pending_cancellations
            .iter()
            .min_by_key(|(_, created_at)| *created_at)
            .map(|(transfer_id, _)| transfer_id.clone())
        {
            registry.pending_cancellations.remove(&oldest);
        }
    }
    registry
        .pending_cancellations
        .insert(transfer_id, Instant::now());
    // The cancellation intent is accepted even though registration has not
    // happened yet. `false` is reserved for the only genuinely too-late case:
    // this transfer has already linearized into its atomic commit.
    Ok(true)
}

/// A terminated WebContent process cannot run React cleanup or receive further
/// progress events. Cancel renderer-owned downloads synchronously so reloads
/// cannot strand invisible jobs and exhaust the download slots.
pub fn cancel_active_ssh_downloads_for_renderer_restart() {
    let current_generation = ssh_transfer_generation()
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1);
    let downloads = download_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .active
        .values()
        .filter(|download| {
            download
                .renderer_generation
                .is_some_and(|generation| generation != current_generation)
        })
        .cloned()
        .collect::<Vec<_>>();
    for download in downloads {
        if request_download_cancellation(&download) {
            signal_active_download(&download);
        }
    }
    #[cfg(target_family = "unix")]
    {
        let process_groups = active_scp_process_groups()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .filter_map(|(pid, generation)| {
                generation
                    .is_some_and(|generation| generation != current_generation)
                    .then_some(*pid)
            })
            .collect::<Vec<_>>();
        for pid in process_groups {
            unsafe {
                let _ = libc::kill(-(pid as i32), libc::SIGTERM);
            }
        }
    }
}

pub fn shutdown_ssh_transfers() {
    scp_shutdown_requested().store(true, Ordering::Release);
    {
        let registry = download_registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for download in registry.active.values() {
            request_download_cancellation(download);
        }
    }

    #[cfg(target_family = "unix")]
    {
        let process_groups = || {
            active_scp_process_groups()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .keys()
                .copied()
                .collect::<Vec<_>>()
        };
        for pid in process_groups() {
            unsafe {
                let _ = libc::kill(-(pid as i32), libc::SIGTERM);
            }
        }
        let deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < deadline {
            if process_groups().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        for pid in process_groups() {
            if scp_process_group_exists(pid) {
                unsafe {
                    let _ = libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
        }
    }

    // Process supervision ends before the higher-level worker has necessarily
    // removed its private staging tree. Give guards a bounded cleanup window.
    // Do not call remove_dir_all from the event-loop exit callback after that
    // deadline: the destination may itself be a stalled network/File Provider
    // volume, and shutdown must remain bounded.
    let cleanup_deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let active_count = download_registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .active
            .len();
        if active_count == 0 || Instant::now() >= cleanup_deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let pending_stage_count = download_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .active
        .values()
        .filter(|download| download.stage_root.is_some())
        .count();
    if pending_stage_count > 0 {
        eprintln!(
            "[ssh-download] {pending_stage_count} private staging cleanup(s) exceeded the shutdown deadline"
        );
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_download_file_with_progress(
    target: String,
    root: String,
    remote_path: String,
    local_directory: String,
    suggested_name: String,
    is_directory: bool,
    expected_bytes: Option<u64>,
    transfer_id: String,
    on_progress: Channel<SshTransferProgress>,
) -> Result<SshDownloadResult, String> {
    let renderer_generation = current_ssh_transfer_generation();
    let download_job_permit = acquire_download_job_permit()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _download_job_permit = download_job_permit;
        ssh_download_file_with_progress_sync(
            target,
            root,
            remote_path,
            local_directory,
            suggested_name,
            is_directory,
            expected_bytes,
            transfer_id,
            on_progress,
            renderer_generation,
        )
    })
    .await
    .map_err(|e| format!("ssh download task failed: {e}"))?
}

#[allow(clippy::too_many_arguments)]
fn ssh_download_file_with_progress_sync(
    target: String,
    root: String,
    remote_path: String,
    local_directory: String,
    suggested_name: String,
    is_directory: bool,
    expected_bytes: Option<u64>,
    transfer_id: String,
    on_progress: Channel<SshTransferProgress>,
    renderer_generation: u64,
) -> Result<SshDownloadResult, String> {
    let target = validate_ssh_target(&target)?;
    let (_root, remote_path) = ensure_within_root(&root, &remote_path)?;
    let escaped_remote_path = scp_escape_remote_path(&remote_path)?;
    let (_guard, cancelled, download_phase, download_process_group, destination) =
        reserve_download_destination(
            transfer_id.clone(),
            &local_directory,
            &suggested_name,
            renderer_generation,
        )?;
    let directory = destination
        .parent()
        .ok_or_else(|| "download destination has no parent directory".to_string())?;
    let stage_guard = OwnedStageGuard::create(directory)?;
    set_download_stage(&transfer_id, stage_guard.root.clone())?;
    let stage = stage_guard.payload.clone();

    let total_bytes = if is_directory { None } else { expected_bytes };
    let send_progress = |phase: &str, sample: ScpProgressSample| {
        let _ = on_progress.send(SshTransferProgress {
            transfer_id: transfer_id.clone(),
            phase: phase.to_string(),
            bytes_transferred: sample.bytes_transferred,
            total_bytes: sample.total_bytes,
            bytes_per_second: sample.bytes_per_second,
            eta_seconds: sample.eta_seconds,
            attempt: sample.attempt,
        });
    };
    send_progress(
        "transferring",
        ScpProgressSample {
            bytes_transferred: 0,
            total_bytes,
            bytes_per_second: None,
            eta_seconds: None,
            attempt: 1,
        },
    );

    let source = format!("{target}:{escaped_remote_path}");
    let stage_path = local_path_to_utf8(&stage, "download staging path")?;
    let paths = vec![source, stage_path];
    let mut last_attempt = 1usize;
    let mut last_reported_bytes = 0u64;
    let transfer_result = run_scp_controlled(
        target,
        &["-r"],
        &paths,
        ScpControl {
            cancelled: &cancelled,
            renderer_generation: Some(renderer_generation),
            process_group_slot: Some(&download_process_group),
            progress_path: Some(&stage),
            is_directory,
            total_bytes,
            clean_stage_between_attempts: true,
        },
        |event| match event {
            ScpProgressEvent::Transferring(sample) => {
                last_attempt = sample.attempt;
                last_reported_bytes = sample.bytes_transferred;
                send_progress("transferring", sample);
            }
            ScpProgressEvent::Retrying { attempt } => {
                last_attempt = attempt;
                last_reported_bytes = 0;
                send_progress(
                    "retrying",
                    ScpProgressSample {
                        bytes_transferred: 0,
                        total_bytes,
                        bytes_per_second: None,
                        eta_seconds: None,
                        attempt,
                    },
                );
            }
        },
    );

    match transfer_result {
        Ok(output) if output.status.success() => {}
        Ok(output) => {
            return Err(output_to_error("scp download failed", &output));
        }
        Err(error) => return Err(error),
    }

    if cancelled.load(Ordering::Acquire) {
        return Err("download cancelled".to_string());
    }
    let downloaded_is_directory = std::fs::symlink_metadata(&stage)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(is_directory);
    let final_bytes = path_size_for_progress(&stage, downloaded_is_directory, Some(&cancelled))
        .unwrap_or(last_reported_bytes);
    let final_total_bytes = (!downloaded_is_directory).then_some(final_bytes);
    // Linearize Cancel versus publication. If Cancel wins this transition,
    // publishing is forbidden. If commit wins, a later Cancel returns false
    // (too late) instead of claiming that a published file was cancelled.
    begin_download_commit(&download_phase)?;
    send_progress(
        "finalizing",
        ScpProgressSample {
            bytes_transferred: final_bytes,
            total_bytes: final_total_bytes,
            bytes_per_second: None,
            eta_seconds: final_total_bytes.map(|_| 0),
            attempt: last_attempt,
        },
    );
    publish_stage_no_replace(&stage, &destination)
        .map_err(|error| format!("finalize download failed: {error}"))?;

    Ok(SshDownloadResult {
        local_path: local_path_to_utf8(&destination, "download destination")?,
    })
}

#[tauri::command]
pub async fn ssh_download_file(
    target: String,
    root: String,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        ssh_download_file_sync(target, root, remote_path, local_path)
    })
    .await
    .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_download_file_sync(
    target: String,
    root: String,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    let target = validate_ssh_target(&target)?;
    let (_root, remote_path) = ensure_within_root(&root, &remote_path)?;
    let escaped_remote_path = scp_escape_remote_path(&remote_path)?;

    let local = validate_local_path_input(&local_path, "missing local path")?;

    let transfer_id = next_internal_transfer_id();
    let (_guard, cancelled, _phase, _process_group) =
        register_download(transfer_id, PathBuf::from(local))?;

    // Use scp -r for recursive copy (works for files and directories)
    // Format: scp -r user@host:/remote/path /local/path
    // Remote path must be escaped (remote shell in legacy mode, client-side
    // glob in sftp mode); the local path is passed verbatim.
    let source = format!("{target}:{escaped_remote_path}");
    let paths = vec![source, local.to_string()];
    let output = run_scp_controlled(
        target,
        &["-r"],
        &paths,
        ScpControl {
            cancelled: &cancelled,
            renderer_generation: None,
            process_group_slot: None,
            progress_path: None,
            is_directory: false,
            total_bytes: None,
            clean_stage_between_attempts: false,
        },
        |_| {},
    )?;
    if !output.status.success() {
        return Err(output_to_error("scp download failed", &output));
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_upload_file(
    target: String,
    root: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        ssh_upload_file_sync(target, root, local_path, remote_path)
    })
    .await
    .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_upload_file_sync(
    target: String,
    root: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let (_root, remote_path) = ensure_within_root(&root, &remote_path)?;
    let escaped_remote_path = scp_escape_remote_path(&remote_path)?;

    let local = validate_local_path_input(&local_path, "missing local path")?;
    if !Path::new(local).exists() {
        return Err("local file does not exist".to_string());
    }

    // Use scp -r for recursive copy (works for files and directories)
    // Format: scp -r /local/path user@host:/remote/path
    // Remote path must be escaped (remote shell in legacy mode, client-side
    // glob in sftp mode); the local path is passed verbatim.
    let dest = format!("{target}:{escaped_remote_path}");
    let paths = vec![local.to_string(), dest];
    // Uploads write directly to the remote destination and cannot yet be
    // atomically rolled back. Do not kill one on renderer restart: interruption
    // would turn a recoverable invisible job into visible remote corruption.
    let output = run_scp(target, &["-r"], &paths, None)?;
    if !output.status.success() {
        return Err(output_to_error("scp upload failed", &output));
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_download_to_temp(
    target: String,
    root: String,
    remote_path: String,
) -> Result<String, String> {
    let renderer_generation = current_ssh_transfer_generation();
    tauri::async_runtime::spawn_blocking(move || {
        ssh_download_to_temp_sync(target, root, remote_path, renderer_generation)
    })
    .await
    .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn download_temp_candidate(temp_root: &Path, nonce: u128, id: u64) -> PathBuf {
    temp_root.join(format!(
        ".agents-ui-download-{}-{nonce:x}-{id:x}",
        std::process::id()
    ))
}

fn create_private_download_directory_with_ids(
    temp_root: &Path,
    nonce: u128,
    mut next_id: impl FnMut() -> u64,
) -> Result<PathBuf, String> {
    #[cfg(target_family = "unix")]
    let expected_uid = effective_user_id();
    #[cfg(not(target_family = "unix"))]
    let expected_uid = 0;

    create_unique_private_directory(
        || download_temp_candidate(temp_root, nonce, next_id()),
        expected_uid,
        "create private temporary download directory",
    )
}

fn create_private_download_directory() -> Result<PathBuf, String> {
    static NEXT_TEMP_DOWNLOAD: AtomicU64 = AtomicU64::new(1);
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    create_private_download_directory_with_ids(&std::env::temp_dir(), nonce, || {
        NEXT_TEMP_DOWNLOAD.fetch_add(1, Ordering::Relaxed)
    })
}

fn ssh_download_to_temp_sync(
    target: String,
    root: String,
    remote_path: String,
    renderer_generation: u64,
) -> Result<String, String> {
    if renderer_generation != current_ssh_transfer_generation() {
        return Err("download belonged to a terminated renderer".to_string());
    }
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let (_root, remote_path) = ensure_within_root(&root, &remote_path)?;
    let escaped_remote_path = scp_escape_remote_path(&remote_path)?;

    // Extract filename from remote path
    let file_name = remote_path
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "remote download path has no filename".to_string())?;
    let file_name = validate_download_name(file_name)?;

    // Allocate directly beneath the OS temp directory. There is no shared,
    // predictable 0755 parent that can expose partial drag-download names.
    let unique_dir = create_private_download_directory()?;

    let local_path = unique_dir.join(file_name);
    let local_path_str = match local_path_to_utf8(&local_path, "temporary download path") {
        Ok(path) => path,
        Err(error) => {
            let _ = remove_owned_stage(&unique_dir);
            return Err(error);
        }
    };

    // Download using scp (remote path escaped for both scp protocol modes)
    let source = format!("{target}:{escaped_remote_path}");
    let paths = vec![source, local_path_str.clone()];
    let cancelled = AtomicBool::new(false);
    let transfer = run_scp_controlled(
        target,
        &["-r"],
        &paths,
        ScpControl {
            cancelled: &cancelled,
            renderer_generation: Some(renderer_generation),
            process_group_slot: None,
            progress_path: Some(&local_path),
            is_directory: false,
            total_bytes: None,
            clean_stage_between_attempts: true,
        },
        |_| {},
    );
    let output = match transfer {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            let error = output_to_error("scp download failed", &output);
            let _ = remove_owned_stage(&unique_dir);
            return Err(error);
        }
        Err(error) => {
            let _ = remove_owned_stage(&unique_dir);
            return Err(error);
        }
    };
    debug_assert!(output.status.success());

    Ok(local_path_str)
}

#[cfg(test)]
mod download_safety_tests {
    use super::*;

    fn registry_test_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn unique_test_path(label: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        std::env::temp_dir().join(format!(
            "agents-ui-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[cfg(target_family = "unix")]
    fn policy_test_output(success: bool, stderr: &str) -> Output {
        use std::os::unix::process::ExitStatusExt;
        Output {
            status: std::process::ExitStatus::from_raw(if success { 0 } else { 255 << 8 }),
            stdout: Vec::new(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn mutation_policy_executes_once_and_reports_ambiguous_transport_failure() {
        let mut calls = 0;
        let error = execute_single_mutation_attempt("test mutation", || {
            calls += 1;
            Ok(policy_test_output(false, "connection reset by peer"))
        })
        .expect_err("transient mutation result must be ambiguous");
        assert_eq!(calls, 1);
        assert!(error.contains("outcome unknown"), "{error}");
        assert!(error.contains("refresh the file tree"), "{error}");

        let mut timeout_calls = 0;
        let timeout_error = execute_single_mutation_attempt("test mutation", || {
            timeout_calls += 1;
            Err(format!(
                "ssh exceeded the {} second safety deadline",
                SSH_COMMAND_RUNTIME_LIMIT.as_secs()
            ))
        })
        .expect_err("mutation timeout must be reported as an unknown outcome");
        assert_eq!(timeout_calls, 1, "timed-out mutation must never replay");
        assert!(timeout_error.contains("outcome unknown"), "{timeout_error}");
        assert!(
            timeout_error.contains("safety deadline"),
            "{timeout_error}"
        );
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn read_only_policy_retries_transient_failure_but_is_bounded() {
        let mut recovering_calls = 0;
        let recovered = run_retry_safe_query_attempts("test query", |_| {
            recovering_calls += 1;
            Ok(if recovering_calls == 1 {
                policy_test_output(false, "broken pipe")
            } else {
                policy_test_output(true, "")
            })
        })
        .expect("read-only query should recover");
        assert!(recovered.status.success());
        assert_eq!(recovering_calls, 2);

        let mut bounded_calls = 0;
        let exhausted = run_retry_safe_query_attempts("test query", |_| {
            bounded_calls += 1;
            Ok(policy_test_output(false, "connection timed out"))
        })
        .expect("final bounded transport result is returned");
        assert!(!exhausted.status.success());
        assert_eq!(bounded_calls, SSH_OP_ATTEMPTS);
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn option_shaped_ssh_target_is_rejected_before_any_process_spawn() {
        let sentinel = unique_test_path("ssh-option-injection-sentinel");
        let target = format!(
            "-oProxyCommand=/usr/bin/touch${{IFS}}{}",
            sentinel.to_str().expect("UTF-8 sentinel path")
        );
        let args = vec!["true".to_string()];

        let read_error = run_ssh_read_only(
            &target,
            &args,
            None,
            SSH_COMMAND_STDOUT_LIMIT,
            "injection test",
        )
        .expect_err("option-shaped query target must be rejected");
        let mutation_error = run_ssh_mutation(
            &target,
            &args,
            None,
            None,
            "injection test",
        )
        .expect_err("option-shaped mutation target must be rejected");

        assert_eq!(read_error, "invalid ssh target");
        assert_eq!(mutation_error, "invalid ssh target");
        assert!(!sentinel.exists(), "invalid target unexpectedly spawned ssh");
    }

    #[cfg(target_family = "unix")]
    fn write_test_program(label: &str, script: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let path = unique_test_path(label);
        std::fs::write(&path, script).expect("write test program");
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&path, permissions).expect("make test program executable");
        path
    }

    #[test]
    fn bounded_tail_never_exceeds_limit_and_keeps_latest_bytes() {
        let mut tail = Vec::new();
        for value in 0..200u8 {
            push_bounded_tail(&mut tail, &vec![value; 1_024], 64 * 1_024);
        }
        assert_eq!(tail.len(), 64 * 1_024);
        assert!(tail.iter().all(|value| *value >= 136));

        push_bounded_tail(&mut tail, &vec![255; 128 * 1_024], 64 * 1_024);
        assert_eq!(tail.len(), 64 * 1_024);
        assert!(tail.iter().all(|value| *value == 255));
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn bounded_command_supervisor_rejects_oversized_stdout() {
        let program = write_test_program(
            "stdout-flood",
            "#!/bin/sh\n/bin/dd if=/dev/zero bs=65536 count=32 2>/dev/null\n",
        );
        let command = Command::new(&program);
        let started_at = Instant::now();
        let error = run_command_bounded(
            command,
            None,
            64 * 1024,
            None,
            Some(Duration::from_secs(2)),
            "test stdout flood",
        )
        .expect_err("oversized stdout must fail");
        assert!(error.contains("output exceeded"), "{error}");
        assert!(started_at.elapsed() < Duration::from_secs(2));
        std::fs::remove_file(program).expect("remove stdout flood program");
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn bounded_command_supervisor_can_cancel_a_blocked_stdin_writer() {
        let program = write_test_program("stdin-stall", "#!/bin/sh\nsleep 5\n");
        let command = Command::new(&program);
        let input = vec![7u8; 4 * 1024 * 1024];
        let started_at = Instant::now();
        let error = run_command_bounded(
            command,
            Some(&input),
            64 * 1024,
            None,
            Some(Duration::from_millis(250)),
            "test stdin stall",
        )
        .expect_err("stalled stdin must hit the supervisor deadline");
        assert!(error.contains("safety deadline"), "{error}");
        assert!(started_at.elapsed() < Duration::from_secs(2));
        std::fs::remove_file(program).expect("remove stdin stall program");
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn bounded_command_supervisor_terminates_a_hung_command() {
        let program = write_test_program("hung-command", "#!/bin/sh\nsleep 5\n");
        let command = Command::new(&program);
        let started_at = Instant::now();
        let error = run_command_bounded(
            command,
            None,
            64 * 1024,
            None,
            Some(Duration::from_millis(250)),
            "test hung command",
        )
        .expect_err("hung command must hit the supervisor deadline");
        assert!(error.contains("safety deadline"), "{error}");
        assert!(started_at.elapsed() < Duration::from_secs(2));
        std::fs::remove_file(program).expect("remove hung-command program");
    }

    fn directory_frame(records: &[(&str, &str, u64)]) -> Vec<u8> {
        let mut frame = Vec::from(REMOTE_DIRECTORY_FRAME_MAGIC);
        frame.push(0);
        for (kind, name, size) in records {
            frame.extend_from_slice(b"E\0");
            frame.extend_from_slice(kind.as_bytes());
            frame.push(0);
            frame.extend_from_slice(size.to_string().as_bytes());
            frame.push(0);
            frame.extend_from_slice(name.as_bytes());
            frame.push(0);
        }
        frame.extend_from_slice(b"Z\0");
        frame
    }

    fn search_frame(paths: &[&str]) -> Vec<u8> {
        let mut frame = Vec::from(REMOTE_SEARCH_FRAME_MAGIC);
        frame.push(0);
        for path in paths {
            frame.extend_from_slice(path.as_bytes());
            frame.push(0);
        }
        frame.extend_from_slice(b"Z\0");
        frame
    }

    #[test]
    fn remote_directory_parser_returns_an_explicit_error_at_its_bound() {
        let records: Vec<(String, String, u64)> = (0..=MAX_REMOTE_DIRECTORY_ENTRIES)
            .map(|index| ("f".to_string(), format!("file-{index}"), 1))
            .collect();
        let borrowed: Vec<(&str, &str, u64)> = records
            .iter()
            .map(|(kind, name, size)| (kind.as_str(), name.as_str(), *size))
            .collect();
        let error = match parse_remote_directory_frame("/remote", &directory_frame(&borrowed)) {
            Err(error) => error,
            Ok(_) => panic!("oversized remote directory must not be silently truncated"),
        };
        assert!(error.contains("entry safety limit"), "{error}");
    }

    #[test]
    fn remote_path_decoder_preserves_valid_unicode_and_rejects_invalid_utf8() {
        let valid = "/remote/lowercase-颜色-📁-café-cafe\u{301}";
        assert_eq!(
            decode_remote_path_output(valid.as_bytes(), "test listing").unwrap(),
            valid
        );

        let invalid = b"/remote/\xff/name";
        let error = decode_remote_path_output(invalid, "test listing")
            .expect_err("invalid filename bytes must never become a replacement character");
        assert!(error.contains("not valid UTF-8"), "{error}");
        assert!(error.contains("offset 8"), "{error}");
        assert!(!error.contains('\u{fffd}'), "{error}");
    }

    #[test]
    fn remote_directory_parser_preserves_filename_text_exactly() {
        let names = [
            "lowercase",
            "颜色",
            "emoji-📁",
            "café",
            "cafe\u{301}",
            "  surrounding spaces  ",
            "line\nbreak",
            "carriage\rreturn",
            "ordinary -> filename",
            "back\\slash",
        ];
        let records = names.iter().map(|name| ("f", *name, 1)).collect::<Vec<_>>();
        let entries = parse_remote_directory_frame("/remote", &directory_frame(&records))
            .expect("parse valid framed listing");

        assert_eq!(entries.len(), names.len());
        for name in names {
            let entry = entries
                .iter()
                .find(|entry| entry.name == name)
                .unwrap_or_else(|| panic!("missing exact filename {name:?}"));
            assert_eq!(entry.path, format!("/remote/{name}"));
        }
    }

    #[test]
    fn framed_parsers_reject_truncation_bad_arity_and_invalid_utf8() {
        let mut missing_trailer = directory_frame(&[("f", "name", 1)]);
        missing_trailer.truncate(missing_trailer.len() - 2);
        assert!(parse_remote_directory_frame("/remote", &missing_trailer).is_err());

        let bad_arity = b"AGENTS_UI_FS_V1\0E\0f\x001\0Z\0";
        assert!(parse_remote_directory_frame("/remote", bad_arity).is_err());

        let invalid_utf8 = b"AGENTS_UI_FS_V1\0E\0f\x001\0bad\xff\0Z\0";
        let error = match parse_remote_directory_frame("/remote", invalid_utf8) {
            Err(error) => error,
            Ok(_) => panic!("invalid UTF-8 filename must fail"),
        };
        assert!(error.contains("not valid UTF-8"), "{error}");

        let bad_magic = b"NOT_THE_PROTOCOL\0Z\0";
        assert!(parse_remote_directory_frame("/remote", bad_magic).is_err());
    }

    #[test]
    fn nonce_frame_tolerates_banner_noise_and_rejects_ambiguity() {
        let magic = b"AGENTS_UI_FS_V2_test_nonce";
        let trailer = b"AGENTS_UI_FS_DONE_V2_test_nonce";
        let mut frame = b"leading banner\r\n\xff".to_vec();
        frame.extend_from_slice(magic);
        frame.push(0);
        frame.extend_from_slice(b"E\0f\01\0literal\0");
        frame.extend_from_slice(trailer);
        frame.push(0);
        frame.extend_from_slice(b"\r\ntrailing shell noise\xfe");

        let entries = parse_remote_directory_frame_with_tokens(
            "/remote",
            &frame,
            magic,
            trailer,
        )
        .expect("bounded banner noise outside the nonce frame is harmless");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "literal");

        let mut ambiguous = frame.clone();
        ambiguous.extend_from_slice(magic);
        ambiguous.push(0);
        ambiguous.extend_from_slice(trailer);
        ambiguous.push(0);
        assert!(parse_remote_directory_frame_with_tokens(
            "/remote",
            &ambiguous,
            magic,
            trailer,
        )
        .is_err());
    }

    #[test]
    fn remote_search_frame_preserves_control_characters_and_rejects_bad_paths() {
        let paths = [
            "/remote/needle\nfile",
            "/remote/carriage\rneedle",
            "/remote/  needle -> exact  ",
        ];
        let mut seen = HashSet::new();
        let mut entries = Vec::new();
        parse_remote_search_frame(
            "/remote",
            &search_frame(&paths),
            10,
            10,
            &mut seen,
            &mut entries,
        )
        .expect("parse framed search");
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            paths
        );

        let mut seen = HashSet::new();
        let mut entries = Vec::new();
        let error = parse_remote_search_frame(
            "/remote",
            &search_frame(&["/outside/needle"]),
            10,
            10,
            &mut seen,
            &mut entries,
        )
        .expect_err("out-of-root search path must fail");
        assert!(error.contains("outside root"), "{error}");

        let mut seen = HashSet::new();
        let mut entries = Vec::new();
        let error = parse_remote_search_frame(
            "/remote",
            &search_frame(&["/remote/one", "/remote/two"]),
            1,
            10,
            &mut seen,
            &mut entries,
        )
        .expect_err("a remote response above its negotiated limit must fail");
        assert!(error.contains("framed result limit"), "{error}");
    }

    #[test]
    fn posix_path_and_rename_name_validation_preserve_edge_whitespace() {
        let path = "/remote/ 目录 /name \n";
        assert_eq!(normalize_posix_path(path).unwrap(), path);
        assert!(normalize_posix_path("/remote/bad\0name").is_err());
        assert_eq!(
            escape_find_pattern_literal("a*[b]?\\c"),
            "a\\*\\[b\\]\\?\\\\c"
        );
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn remote_directory_shell_protocol_round_trips_ambiguous_names() {
        use std::os::unix::fs::symlink;

        let directory = unique_test_path("nul-listing");
        std::fs::create_dir(&directory).expect("create listing directory");
        let names = [
            "lowercase",
            "颜色-📁",
            "  edge spaces  ",
            "line\nbreak",
            "carriage\rreturn",
            "ordinary -> filename",
            ".hidden",
            "..double-dot-prefix",
        ];
        for name in names {
            std::fs::write(directory.join(name), b"x").expect("create ambiguous filename");
        }
        symlink("target -> with arrow", directory.join("link -> name"))
            .expect("create symlink with arrow name");

        let output = Command::new("/bin/sh")
            .arg("-c")
            .arg(REMOTE_DIRECTORY_LIST_SCRIPT)
            .arg("--")
            .arg(&directory)
            .arg(MAX_REMOTE_DIRECTORY_ENTRIES.to_string())
            .output()
            .expect("run remote listing protocol locally");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let directory_utf8 = directory.to_str().expect("UTF-8 test directory");
        let entries = parse_remote_directory_frame(directory_utf8, &output.stdout)
            .expect("parse shell listing protocol");
        for name in names.into_iter().chain(["link -> name"]) {
            assert!(
                entries.iter().any(|entry| entry.name == name),
                "missing {name:?}"
            );
        }
        std::fs::remove_dir_all(directory).expect("remove listing directory");
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn remote_search_shell_protocol_round_trips_newlines() {
        let directory = unique_test_path("nul-search");
        std::fs::create_dir(&directory).expect("create search directory");
        let names = ["needle\nfile", "carriage\rneedle", "literal [needle]*"];
        for name in names {
            std::fs::write(directory.join(name), b"x").expect("create search filename");
        }
        let hidden_directory = directory.join(".hidden");
        std::fs::create_dir(&hidden_directory).expect("create hidden search directory");
        std::fs::write(hidden_directory.join("hidden-needle"), b"x")
            .expect("create hidden search filename");
        let pattern = format!("*{}*", escape_find_pattern_literal("needle"));
        let output = Command::new("/bin/sh")
            .arg("-c")
            .arg(REMOTE_FILE_SEARCH_SCRIPT)
            .arg("--")
            .arg(&directory)
            .arg(&pattern)
            .arg("0")
            .arg("10")
            .arg(format!("{}/.*/*", directory.display()))
            .arg(format!("{}/*/.*/*", directory.display()))
            .output()
            .expect("run remote search protocol locally");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let root = directory.to_str().expect("UTF-8 search root");
        let mut seen = HashSet::new();
        let mut entries = Vec::new();
        parse_remote_search_frame(root, &output.stdout, 10, 10, &mut seen, &mut entries)
            .expect("parse shell search protocol");
        for name in names {
            assert!(
                entries.iter().any(|entry| entry.name == name),
                "missing {name:?}"
            );
        }
        assert!(!entries.iter().any(|entry| entry.name == "hidden-needle"));

        let hidden_output = Command::new("/bin/sh")
            .arg("-c")
            .arg(REMOTE_FILE_SEARCH_SCRIPT)
            .arg("--")
            .arg(&directory)
            .arg(&pattern)
            .arg("1")
            .arg("10")
            .arg(format!("{}/.*/*", directory.display()))
            .arg(format!("{}/*/.*/*", directory.display()))
            .output()
            .expect("run hidden-only search protocol locally");
        assert!(
            hidden_output.status.success(),
            "{}",
            String::from_utf8_lossy(&hidden_output.stderr)
        );
        let mut hidden_seen = HashSet::new();
        let mut hidden_entries = Vec::new();
        parse_remote_search_frame(
            root,
            &hidden_output.stdout,
            10,
            10,
            &mut hidden_seen,
            &mut hidden_entries,
        )
        .expect("parse hidden-only search protocol");
        assert_eq!(hidden_entries.len(), 1);
        assert_eq!(hidden_entries[0].name, "hidden-needle");
        std::fs::remove_dir_all(directory).expect("remove search directory");
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn remote_search_shell_protocol_applies_the_limit_before_framing() {
        let directory = unique_test_path("nul-search-limit");
        std::fs::create_dir(&directory).expect("create limited search directory");
        for index in 0..25 {
            std::fs::write(directory.join(format!("needle-{index:02}")), b"x")
                .expect("create search candidate");
        }
        let output = Command::new("/bin/sh")
            .arg("-c")
            .arg(REMOTE_FILE_SEARCH_SCRIPT)
            .arg("--")
            .arg(&directory)
            .arg("*needle*")
            .arg("0")
            .arg("3")
            .arg(format!("{}/.*/*", directory.display()))
            .arg(format!("{}/*/.*/*", directory.display()))
            .output()
            .expect("run limited remote search protocol locally");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let root = directory.to_str().expect("UTF-8 search root");
        let mut seen = HashSet::new();
        let mut entries = Vec::new();
        parse_remote_search_frame(root, &output.stdout, 3, 3, &mut seen, &mut entries)
            .expect("parse remotely-limited search protocol");
        assert_eq!(entries.len(), 3);
        std::fs::remove_dir_all(directory).expect("remove limited search directory");
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn remote_create_and_rename_scripts_never_clobber_targets() {
        use std::os::unix::fs::symlink;

        let directory = unique_test_path("remote-mutation-safety");
        std::fs::create_dir(&directory).expect("create mutation directory");
        let created = directory.join(" created\nexact ");
        let create = |path: &Path| {
            Command::new("/bin/sh")
                .arg("-c")
                .arg(SSH_CREATE_FILE_EXCLUSIVE_SCRIPT)
                .arg("--")
                .arg(path)
                .output()
                .expect("run exclusive create script")
        };
        assert!(create(&created).status.success());
        std::fs::write(&created, b"keep").expect("seed existing content");
        assert!(!create(&created).status.success());
        assert_eq!(std::fs::read(&created).unwrap(), b"keep");

        let dangling = directory.join("dangling");
        let missing_target = directory.join("missing-target");
        symlink(&missing_target, &dangling).expect("create dangling target");
        assert!(!create(&dangling).status.success());
        assert!(std::fs::symlink_metadata(&dangling)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!missing_target.exists());

        let source = directory.join("source\rname");
        let renamed = directory.join(" renamed -> exact ");
        std::fs::write(&source, b"source").expect("create rename source");
        let rename = |from: &Path, to: &Path| {
            Command::new("/bin/sh")
                .arg("-c")
                .arg(SSH_RENAME_NO_CLOBBER_SCRIPT)
                .arg("--")
                .arg(from)
                .arg(to)
                .output()
                .expect("run no-clobber rename script")
        };
        let initial_rename = rename(&source, &renamed);
        if cfg!(any(target_os = "linux", target_os = "macos")) {
            assert!(
                initial_rename.status.success(),
                "{}",
                String::from_utf8_lossy(&initial_rename.stderr)
            );
            assert_eq!(std::fs::read(&renamed).unwrap(), b"source");
        } else {
            assert!(!initial_rename.status.success());
            assert!(String::from_utf8_lossy(&initial_rename.stderr).contains("unsupported"));
            assert_eq!(std::fs::read(&source).unwrap(), b"source");
            assert!(!renamed.exists());
        }

        let blocked_source = directory.join("blocked-source");
        let occupied = directory.join("occupied");
        std::fs::write(&blocked_source, b"source").unwrap();
        std::fs::write(&occupied, b"destination").unwrap();
        let blocked_rename = rename(&blocked_source, &occupied);
        assert!(!blocked_rename.status.success());
        assert_eq!(std::fs::read(&blocked_source).unwrap(), b"source");
        assert_eq!(std::fs::read(&occupied).unwrap(), b"destination");

        let dangling_destination = directory.join("dangling-destination");
        symlink(directory.join("never-created"), &dangling_destination).unwrap();
        assert!(!rename(&blocked_source, &dangling_destination)
            .status
            .success());
        assert!(blocked_source.exists());
        assert!(std::fs::symlink_metadata(&dangling_destination)
            .unwrap()
            .file_type()
            .is_symlink());

        if cfg!(any(target_os = "linux", target_os = "macos")) {
            let dangling_source = directory.join("dangling-source");
            let renamed_dangling = directory.join("renamed-dangling");
            symlink(directory.join("absent-link-target"), &dangling_source).unwrap();
            let output = rename(&dangling_source, &renamed_dangling);
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(std::fs::symlink_metadata(&dangling_source).is_err());
            assert!(std::fs::symlink_metadata(&renamed_dangling)
                .unwrap()
                .file_type()
                .is_symlink());
        }
        std::fs::remove_dir_all(directory).expect("remove mutation directory");
    }

    #[test]
    fn remote_rename_has_no_non_atomic_mv_fallback() {
        assert!(!SSH_RENAME_NO_CLOBBER_SCRIPT.contains("mv -n"));
        assert!(SSH_RENAME_NO_CLOBBER_SCRIPT.contains("renameat2"));
        assert!(SSH_RENAME_NO_CLOBBER_SCRIPT.contains("renamex_np"));
        assert!(SSH_RENAME_NO_CLOBBER_SCRIPT.contains("RENAME_NOREPLACE"));
        assert!(SSH_RENAME_NO_CLOBBER_SCRIPT.contains("RENAME_EXCL"));
        assert!(SSH_RENAME_NO_CLOBBER_SCRIPT.contains("unsupported"));
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn atomic_remote_rename_has_exactly_one_winner_under_race() {
        use std::sync::Barrier;

        let directory = unique_test_path("remote-rename-race");
        std::fs::create_dir(&directory).expect("create rename race directory");
        let destination = directory.join("winner");
        let competitors = 8usize;
        let barrier = Arc::new(Barrier::new(competitors));
        let mut workers = Vec::new();
        for index in 0..competitors {
            let source = directory.join(format!("source-{index}"));
            std::fs::write(&source, index.to_string()).expect("create race source");
            let destination = destination.clone();
            let barrier = barrier.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                let output = Command::new("/bin/sh")
                    .arg("-c")
                    .arg(SSH_RENAME_NO_CLOBBER_SCRIPT)
                    .arg("--")
                    .arg(&source)
                    .arg(&destination)
                    .output()
                    .expect("run atomic rename competitor");
                (source, output.status.success())
            }));
        }
        let results = workers
            .into_iter()
            .map(|worker| worker.join().expect("join rename competitor"))
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|(_, success)| *success).count(), 1);
        assert!(destination.is_file());
        for (source, success) in results {
            assert_eq!(source.exists(), !success);
        }
        std::fs::remove_dir_all(directory).expect("remove rename race directory");
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn controlled_child_drains_large_stderr_without_unbounded_capture() {
        let program = write_test_program(
            "stderr-flood",
            "#!/bin/sh\n/bin/dd if=/dev/zero bs=65536 count=64 1>&2 2>/dev/null\nprintf '\\nFINAL_DIAGNOSTIC\\n' >&2\nexit 7\n",
        );
        let cancelled = AtomicBool::new(false);
        let output = run_scp_once_controlled(
            &program,
            &[],
            &[],
            ScpControl {
                cancelled: &cancelled,
                renderer_generation: None,
                process_group_slot: None,
                progress_path: None,
                is_directory: false,
                total_bytes: None,
                clean_stage_between_attempts: false,
            },
            1,
            &mut |_| {},
        )
        .expect("run controlled child");
        assert!(!output.status.success());
        assert!(output.stderr.len() <= SCP_DIAGNOSTIC_TAIL_BYTES);
        assert!(output.stderr.ends_with(b"FINAL_DIAGNOSTIC\n"));
        std::fs::remove_file(program).expect("remove test program");
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn controlled_child_emits_monotonic_file_progress() {
        let program = write_test_program(
            "progress-writer",
            "#!/bin/sh\nfor last do :; done\n: > \"$last\"\n/bin/dd if=/dev/zero bs=1024 count=1 >> \"$last\" 2>/dev/null\nsleep 0.3\n/bin/dd if=/dev/zero bs=1024 count=1 >> \"$last\" 2>/dev/null\nsleep 0.3\n/bin/dd if=/dev/zero bs=1024 count=1 >> \"$last\" 2>/dev/null\n",
        );
        let destination = unique_test_path("progress-output");
        let cancelled = AtomicBool::new(false);
        let mut samples = Vec::new();
        let output = run_scp_once_controlled(
            &program,
            &[],
            &[destination.to_string_lossy().to_string()],
            ScpControl {
                cancelled: &cancelled,
                renderer_generation: None,
                process_group_slot: None,
                progress_path: Some(&destination),
                is_directory: false,
                total_bytes: Some(3_072),
                clean_stage_between_attempts: false,
            },
            1,
            &mut |event| {
                if let ScpProgressEvent::Transferring(sample) = event {
                    samples.push(sample.bytes_transferred);
                }
            },
        )
        .expect("run progress child");
        assert!(output.status.success());
        assert!(samples.len() >= 2, "samples: {samples:?}");
        assert!(samples.windows(2).all(|pair| pair[0] <= pair[1]));
        assert_eq!(samples.last(), Some(&3_072));
        std::fs::remove_file(program).expect("remove test program");
        std::fs::remove_file(destination).expect("remove progress output");
    }

    #[test]
    fn progress_estimator_reports_smoothed_rate_and_eta_after_warmup() {
        let now = Instant::now();
        let mut estimator = ProgressEstimator {
            started_at: now - Duration::from_secs(3),
            last_sample_at: now - Duration::from_secs(1),
            last_progress_at: now - Duration::from_secs(1),
            last_bytes: 1_000,
            smoothed_rate: None,
        };
        let sample = estimator.sample(2_000, Some(4_000), 1);
        assert!((900..=1_100).contains(&sample.bytes_per_second.unwrap_or_default()));
        assert!((2..=3).contains(&sample.eta_seconds.unwrap_or_default()));
    }

    #[test]
    fn progress_estimator_clears_stale_speed_and_eta_after_a_stall() {
        let now = Instant::now();
        let mut estimator = ProgressEstimator {
            started_at: now - Duration::from_secs(10),
            last_sample_at: now - Duration::from_secs(4),
            last_progress_at: now - Duration::from_secs(4),
            last_bytes: 2_000,
            smoothed_rate: Some(1_000.0),
        };
        let sample = estimator.sample(2_000, Some(4_000), 1);
        assert_eq!(sample.bytes_per_second, None);
        assert_eq!(sample.eta_seconds, None);
    }

    #[test]
    fn download_name_and_target_validation_reject_option_and_path_injection() {
        assert!(validate_ssh_target("-Fmalicious").is_err());
        assert!(validate_ssh_target("host\nother").is_err());
        assert!(validate_ssh_target("user@example.test").is_ok());
        assert!(validate_download_name("../secret").is_err());
        assert!(validate_download_name("report 2026.pdf").is_ok());
        assert_eq!(validate_download_name(" report "), Ok(" report "));
        assert_eq!(
            validate_download_name_for_platform("folder\\secret", false),
            Ok("folder\\secret")
        );
        assert!(validate_download_name_for_platform("folder\\secret", true).is_err());
        assert!(validate_download_name_for_platform("..\\escape", true).is_err());
        assert!(validate_download_name_for_platform("C:escape", true).is_err());
        assert!(validate_download_name_for_platform("file:stream", true).is_err());
        assert!(validate_download_name_for_platform("NUL.txt", true).is_err());
        assert!(validate_download_name_for_platform("COM1.log", true).is_err());
        assert!(validate_download_name_for_platform("report.", true).is_err());
        assert!(validate_download_name_for_platform("bad?.txt", true).is_err());
        assert!(validate_download_name_for_platform("颜色\\exact", false).is_ok());
        assert!(validate_download_name_for_platform("C:notes", false).is_ok());

        for control in ['\0', '\n', '\r'] {
            let path = format!("/remote/before{control}after");
            let error = scp_escape_remote_path(&path).expect_err("controls must fail closed");
            assert!(error.contains("U+"), "{error}");
            assert!(!error.contains(&path), "error must not render controls");
        }
        assert_eq!(
            scp_escape_remote_path("/remote/back\\slash").unwrap(),
            "/remote/back\\\\slash"
        );
        assert!(scp_escape_remote_path("/remote/颜色 [exact]*").is_ok());
        for supported in ['\t', '\u{1b}', '\u{7f}', '\u{85}'] {
            assert!(scp_escape_remote_path(&format!("/remote/a{supported}b")).is_ok());
        }
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn supported_scp_remote_path_bytes_round_trip_through_posix_shell() {
        let paths = [
            "/remote/  spaces  /quotes-'\"-$-`-glob-*?[x]-back\\slash-颜色",
            "/remote/tab\t-escape\u{1b}-delete\u{7f}-next-line\u{85}",
        ];
        for path in paths {
            let escaped = scp_escape_remote_path(path).expect("supported remote path");
            let output = Command::new("/bin/sh")
                .arg("-c")
                .arg(format!("printf '%s' {escaped}"))
                .output()
                .expect("run POSIX shell path round-trip");
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(output.stdout, path.as_bytes(), "path {path:?}");
        }
    }

    #[test]
    fn transfer_arguments_disable_every_control_socket() {
        let args = ssh_transfer_args();
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-o", "ControlMaster=no"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-o", "ControlPath=none"]));
    }

    #[test]
    fn destination_numbering_preserves_extensions() {
        let directory = Path::new("/tmp");
        assert_eq!(
            numbered_destination(directory, "report.tar.gz", 2),
            directory.join("report.tar (2).gz")
        );
        assert_eq!(
            numbered_destination(directory, "archive", 3),
            directory.join("archive (3)")
        );
    }

    #[test]
    fn destination_reservation_never_overwrites_an_existing_file() {
        let _test_guard = registry_test_lock().lock().unwrap();
        let directory = unique_test_path("destination-collision");
        std::fs::create_dir_all(&directory).expect("create destination directory");
        std::fs::write(directory.join("report.txt"), b"existing").expect("write existing file");
        let transfer_id = format!(
            "collision-{}-{}",
            std::process::id(),
            next_internal_transfer_id()
        );
        let (guard, _cancelled, _phase, _process_group, destination) =
            reserve_download_destination(
                transfer_id,
                directory.to_str().expect("utf8 test path"),
                "report.txt",
                current_ssh_transfer_generation(),
            )
            .expect("reserve destination");
        assert_eq!(
            destination,
            std::fs::canonicalize(&directory)
                .unwrap()
                .join("report (1).txt")
        );
        assert_eq!(
            std::fs::read(directory.join("report.txt")).unwrap(),
            b"existing"
        );
        drop(guard);
        std::fs::remove_dir_all(&directory).expect("remove destination directory");
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn dangling_symlink_is_occupied_during_destination_reservation() {
        let _test_guard = registry_test_lock().lock().unwrap();
        let directory = unique_test_path("destination-dangling-link");
        std::fs::create_dir_all(&directory).expect("create destination directory");
        std::os::unix::fs::symlink(
            directory.join("missing-target"),
            directory.join("report.txt"),
        )
        .expect("create dangling destination symlink");
        let transfer_id = format!("dangling-{}", next_internal_transfer_id());
        let (guard, _, _, _, destination) = reserve_download_destination(
            transfer_id,
            directory.to_str().expect("utf8 test path"),
            "report.txt",
            current_ssh_transfer_generation(),
        )
        .expect("reserve around dangling symlink");
        assert_eq!(destination.file_name().unwrap(), "report (1).txt");
        drop(guard);
        std::fs::remove_dir_all(directory).expect("remove dangling-link directory");
    }

    #[test]
    fn atomic_publish_never_replaces_a_destination_created_after_reservation() {
        let directory = unique_test_path("atomic-publish-collision");
        std::fs::create_dir_all(&directory).expect("create publish directory");
        let stage = directory.join("stage");
        let destination = directory.join("destination");
        std::fs::write(&stage, b"downloaded").expect("write stage");
        std::fs::write(&destination, b"competing").expect("write competing destination");

        let error = publish_stage_no_replace(&stage, &destination)
            .expect_err("no-replace publish must reject a competing destination");
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&destination).unwrap(), b"competing");
        assert_eq!(std::fs::read(&stage).unwrap(), b"downloaded");
        std::fs::remove_dir_all(directory).expect("remove publish directory");
    }

    #[test]
    fn atomic_publish_succeeds_for_files_and_directories() {
        let directory = unique_test_path("atomic-publish-success");
        std::fs::create_dir_all(&directory).expect("create publish directory");

        let staged_file = directory.join("staged-file");
        let published_file = directory.join("published-file");
        std::fs::write(&staged_file, b"complete").expect("write staged file");
        publish_stage_no_replace(&staged_file, &published_file).expect("publish file");
        assert!(!staged_file.exists());
        assert_eq!(std::fs::read(&published_file).unwrap(), b"complete");

        let staged_directory = directory.join("staged-directory");
        let published_directory = directory.join("published-directory");
        std::fs::create_dir(&staged_directory).expect("create staged directory");
        std::fs::write(staged_directory.join("payload"), b"complete")
            .expect("write staged directory payload");
        publish_stage_no_replace(&staged_directory, &published_directory)
            .expect("publish directory");
        assert!(!staged_directory.exists());
        assert_eq!(
            std::fs::read(published_directory.join("payload")).unwrap(),
            b"complete"
        );

        std::fs::remove_dir_all(directory).expect("remove publish directory");
    }

    #[test]
    fn private_stage_is_atomically_owned_and_cleaned_by_its_guard() {
        let directory = unique_test_path("private-stage");
        std::fs::create_dir_all(&directory).expect("create private-stage parent");
        let guard = OwnedStageGuard::create(&directory).expect("create private stage");
        let root = guard.root.clone();
        assert!(root.is_dir());
        assert!(!guard.payload.exists());
        #[cfg(target_family = "unix")]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&root).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700);
        }
        drop(guard);
        assert!(!root.exists());
        std::fs::remove_dir_all(directory).expect("remove private-stage parent");
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn temporary_download_root_is_private_and_owned() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let temp_root = unique_test_path("temp-download-root");
        std::fs::create_dir_all(&temp_root).expect("create test temp root");
        let allocated =
            create_private_download_directory_with_ids(&temp_root, 0xabc, || 1)
                .expect("allocate private download root");
        let metadata = std::fs::symlink_metadata(&allocated).expect("inspect download root");

        assert!(metadata.is_dir());
        assert!(!metadata.file_type().is_symlink());
        assert_eq!(metadata.uid(), effective_user_id());
        assert_eq!(metadata.permissions().mode() & 0o777, 0o700);

        std::fs::remove_dir_all(temp_root).expect("remove test temp root");
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn preplanted_download_root_symlink_is_never_followed() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let temp_root = unique_test_path("temp-download-symlink");
        let outside = unique_test_path("temp-download-outside");
        std::fs::create_dir_all(&temp_root).expect("create test temp root");
        std::fs::create_dir_all(&outside).expect("create outside directory");
        std::fs::write(outside.join("marker"), b"untouched").expect("write outside marker");
        let planted = download_temp_candidate(&temp_root, 0xdef, 7);
        symlink(&outside, &planted).expect("plant download-root symlink");
        let mut ids = [7, 8].into_iter();

        let allocated = create_private_download_directory_with_ids(&temp_root, 0xdef, || {
            ids.next().expect("allocator retried unexpectedly")
        })
        .expect("skip occupied symlink candidate");

        assert_eq!(allocated, download_temp_candidate(&temp_root, 0xdef, 8));
        assert!(std::fs::symlink_metadata(&planted)
            .expect("inspect planted entry")
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::metadata(&allocated)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(std::fs::read(outside.join("marker")).unwrap(), b"untouched");

        std::fs::remove_dir_all(temp_root).expect("remove test temp root");
        std::fs::remove_dir_all(outside).expect("remove outside directory");
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn ssh_control_directory_rejects_preexisting_unsafe_mode_and_uses_fallback() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let temp_root = unique_test_path("control-mode");
        std::fs::create_dir_all(&temp_root).expect("create control test root");
        let effective_uid = effective_user_id();
        let preferred = temp_root.join(format!("agents-ui-ssh-{effective_uid}"));
        std::fs::create_dir(&preferred).expect("create preferred control directory");
        std::fs::set_permissions(&preferred, std::fs::Permissions::from_mode(0o755))
            .expect("make preferred mode unsafe");

        let selected = prepare_control_base_with_ids(&temp_root, effective_uid, || 1)
            .expect("select private fallback control directory");
        let metadata = std::fs::symlink_metadata(&selected).expect("inspect selected directory");

        assert_ne!(selected, preferred);
        assert_eq!(metadata.uid(), effective_uid);
        assert_eq!(metadata.permissions().mode() & 0o777, 0o700);
        assert_eq!(
            std::fs::symlink_metadata(&preferred)
                .expect("inspect unsafe preferred directory")
                .permissions()
                .mode()
                & 0o777,
            0o755,
            "pre-existing unsafe directory must never be chmod-repaired"
        );
        let wrong_owner_error =
            secure_owned_private_directory(&selected, effective_uid.wrapping_add(1))
                .expect_err("a different expected owner must be rejected");
        assert!(wrong_owner_error.contains("not owned"), "{wrong_owner_error}");

        std::fs::remove_dir_all(temp_root).expect("remove control test root");
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn ssh_control_directory_rejects_symlink_and_uses_private_short_fallback() {
        use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};

        let temp_root = unique_test_path("control-symlink");
        let outside = unique_test_path("control-outside");
        std::fs::create_dir_all(&temp_root).expect("create control test root");
        std::fs::create_dir_all(&outside).expect("create outside directory");
        let effective_uid = effective_user_id();
        let preferred = temp_root.join(format!("agents-ui-ssh-{effective_uid}"));
        symlink(&outside, &preferred).expect("plant preferred control symlink");

        let selected = prepare_control_base_with_ids(&temp_root, effective_uid, || 0x17)
            .expect("allocate safe control fallback");
        let metadata = std::fs::symlink_metadata(&selected).expect("inspect control fallback");

        assert_ne!(selected, preferred);
        assert!(selected
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("au-s-")));
        assert!(std::fs::symlink_metadata(&preferred)
            .expect("inspect planted control symlink")
            .file_type()
            .is_symlink());
        assert_eq!(metadata.uid(), effective_uid);
        assert_eq!(metadata.permissions().mode() & 0o777, 0o700);

        std::fs::remove_dir_all(temp_root).expect("remove control test root");
        std::fs::remove_dir_all(outside).expect("remove control outside directory");
    }

    #[test]
    fn cancellation_is_idempotent_and_registry_entry_is_released() {
        let _test_guard = registry_test_lock().lock().unwrap();
        let transfer_id = format!(
            "test-{}-{}",
            std::process::id(),
            next_internal_transfer_id()
        );
        let destination = unique_test_path("registry-destination");
        let (guard, cancelled, _phase, _process_group) =
            register_download(transfer_id.clone(), destination).expect("register download");
        assert_eq!(ssh_cancel_download(transfer_id.clone()), Ok(true));
        assert!(cancelled.load(Ordering::Acquire));
        assert_eq!(ssh_cancel_download(transfer_id.clone()), Ok(true));
        drop(guard);
        assert_eq!(ssh_cancel_download(transfer_id), Ok(true));
    }

    #[test]
    fn cancellation_that_overtakes_worker_registration_is_not_lost() {
        let _test_guard = registry_test_lock().lock().unwrap();
        let transfer_id = format!(
            "precancel-{}-{}",
            std::process::id(),
            next_internal_transfer_id()
        );
        assert_eq!(ssh_cancel_download(transfer_id.clone()), Ok(true));
        let destination = unique_test_path("precancel-destination");
        let (guard, cancelled, _phase, _process_group) =
            register_download(transfer_id, destination).expect("register pre-cancelled download");
        assert!(cancelled.load(Ordering::Acquire));
        drop(guard);
    }

    #[test]
    fn cancellation_reports_too_late_after_commit_linearizes() {
        let _test_guard = registry_test_lock().lock().unwrap();
        let transfer_id = format!("committing-{}", next_internal_transfer_id());
        let destination = unique_test_path("committing-destination");
        let (guard, _cancelled, phase, _process_group) =
            register_download(transfer_id.clone(), destination).expect("register download");
        begin_download_commit(&phase).expect("begin commit");
        assert_eq!(ssh_cancel_download(transfer_id), Ok(false));
        drop(guard);
    }

    #[test]
    fn cancel_and_commit_have_exactly_one_linearized_winner() {
        for round in 0..256 {
            let phase = Arc::new(AtomicU8::new(DOWNLOAD_PHASE_TRANSFERRING));
            let download = ActiveDownload {
                cancelled: Arc::new(AtomicBool::new(false)),
                phase: phase.clone(),
                process_group: Arc::new(AtomicU64::new(0)),
                renderer_generation: None,
                destination: PathBuf::from(format!("unused-{round}")),
                stage_root: None,
            };
            let barrier = Arc::new(std::sync::Barrier::new(3));
            let (cancel_won, commit_won) = std::thread::scope(|scope| {
                let cancel_barrier = barrier.clone();
                let cancel_download = download.clone();
                let cancel = scope.spawn(move || {
                    cancel_barrier.wait();
                    request_download_cancellation(&cancel_download)
                });
                let commit_barrier = barrier.clone();
                let commit_phase = phase.clone();
                let commit = scope.spawn(move || {
                    commit_barrier.wait();
                    begin_download_commit(&commit_phase).is_ok()
                });
                barrier.wait();
                (cancel.join().unwrap(), commit.join().unwrap())
            });
            assert_ne!(cancel_won, commit_won, "round {round}");
        }
    }

    #[test]
    fn renderer_restart_cancels_only_renderer_owned_downloads() {
        let _test_guard = registry_test_lock().lock().unwrap();
        let legacy_id = format!("legacy-{}", next_internal_transfer_id());
        let (legacy_guard, legacy_cancelled, _, _) =
            register_download(legacy_id, unique_test_path("legacy-renderer-owner"))
                .expect("register legacy download");

        let directory = unique_test_path("renderer-owned-download");
        std::fs::create_dir_all(&directory).expect("create renderer destination");
        let renderer_id = format!("renderer-{}", next_internal_transfer_id());
        let generation = current_ssh_transfer_generation();
        let (renderer_guard, renderer_cancelled, _, _, _) = reserve_download_destination(
            renderer_id,
            directory.to_str().expect("utf8 renderer path"),
            "payload.bin",
            generation,
        )
        .expect("register renderer download");

        cancel_active_ssh_downloads_for_renderer_restart();
        assert!(renderer_cancelled.load(Ordering::Acquire));
        assert!(!legacy_cancelled.load(Ordering::Acquire));

        drop(renderer_guard);
        drop(legacy_guard);
        std::fs::remove_dir_all(directory).expect("remove renderer destination");
    }

    #[test]
    fn preflight_download_jobs_are_bounded_before_filesystem_work() {
        let permits = (0..MAX_ACTIVE_DOWNLOADS)
            .map(|_| acquire_download_job_permit().expect("acquire bounded job permit"))
            .collect::<Vec<_>>();
        assert!(acquire_download_job_permit().is_err());
        drop(permits);
        assert!(acquire_download_job_permit().is_ok());
    }

    #[test]
    fn pre_cancelled_transfer_never_spawns_scp() {
        let cancelled = AtomicBool::new(true);
        let started_at = Instant::now();
        let result = run_scp_controlled(
            "unreachable.invalid",
            &["-r"],
            &[
                "unreachable.invalid:/remote".to_string(),
                unique_test_path("must-not-be-created")
                    .to_string_lossy()
                    .to_string(),
            ],
            ScpControl {
                cancelled: &cancelled,
                renderer_generation: None,
                process_group_slot: None,
                progress_path: None,
                is_directory: false,
                total_bytes: None,
                clean_stage_between_attempts: false,
            },
            |_| {},
        );
        assert_eq!(result.unwrap_err(), "file transfer cancelled");
        assert!(started_at.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn stale_renderer_generation_never_spawns_scp() {
        let cancelled = AtomicBool::new(false);
        let stale_generation = u64::MAX;
        let started_at = Instant::now();
        let result = run_scp_controlled(
            "unreachable.invalid",
            &["-r"],
            &[
                "unreachable.invalid:/remote".to_string(),
                unique_test_path("stale-renderer-must-not-spawn")
                    .to_string_lossy()
                    .to_string(),
            ],
            ScpControl {
                cancelled: &cancelled,
                renderer_generation: Some(stale_generation),
                process_group_slot: None,
                progress_path: None,
                is_directory: false,
                total_bytes: None,
                clean_stage_between_attempts: false,
            },
            |_| {},
        );
        assert_eq!(result.unwrap_err(), "file transfer cancelled");
        assert!(started_at.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn directory_progress_scan_does_not_follow_symlinks() {
        let root = unique_test_path("progress-tree");
        std::fs::create_dir_all(&root).expect("create test directory");
        std::fs::write(root.join("payload"), vec![7u8; 4_096]).expect("write payload");
        #[cfg(target_family = "unix")]
        std::os::unix::fs::symlink(&root, root.join("loop")).expect("create symlink");
        assert_eq!(path_size_for_progress(&root, true, None), Some(4_096));
        std::fs::remove_dir_all(&root).expect("remove test directory");
    }

    #[test]
    fn flat_directory_progress_frontier_is_bounded_while_discovering_entries() {
        let root = unique_test_path("progress-wide-tree");
        std::fs::create_dir_all(&root).expect("create wide progress tree");
        for index in 0..20 {
            std::fs::write(root.join(format!("payload-{index}")), b"x")
                .expect("write wide-tree payload");
        }
        assert_eq!(
            path_size_for_progress_controlled(&root, true, None, 8),
            None
        );
        std::fs::remove_dir_all(root).expect("remove wide progress tree");
    }

    #[test]
    fn progress_scan_observes_cancellation_before_filesystem_traversal() {
        let cancelled = AtomicBool::new(true);
        assert_eq!(
            path_size_for_progress_controlled(
                Path::new("/path-that-must-not-be-opened"),
                true,
                Some(&cancelled),
                8,
            ),
            None
        );
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn terminating_scp_process_group_stops_descendants_and_reaps_parent() {
        use std::os::unix::process::CommandExt;

        let sentinel = unique_test_path("cancel-sentinel");
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("(trap '' TERM; sleep 1; printf done > \"$1\") 2>/dev/null & wait")
            .arg("--")
            .arg(&sentinel)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command.process_group(0);
        let child = command.spawn().expect("spawn process tree");
        let process_group_id = child.id();
        let mut child = SupervisedChild::new(child);
        std::thread::sleep(Duration::from_millis(100));
        terminate_scp_process(&mut child);
        std::thread::sleep(Duration::from_millis(1_100));
        assert!(
            !sentinel.exists(),
            "cancelled descendant wrote after teardown"
        );
        assert!(!scp_process_group_exists(process_group_id));
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn deferred_reaper_owns_and_reaps_child_handles() {
        let _test_guard = registry_test_lock().lock().unwrap();
        poll_deferred_ssh_fallback();
        let baseline = deferred_ssh_child_count().load(Ordering::Acquire);
        let child = Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .expect("spawn deferred-reap child");
        defer_ssh_child_reap(child);

        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline
            && deferred_ssh_child_count().load(Ordering::Acquire) != baseline
        {
            std::thread::sleep(Duration::from_millis(25));
        }
        assert_eq!(deferred_ssh_child_count().load(Ordering::Acquire), baseline);
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn supervised_child_guard_contains_progress_callback_panics() {
        let program = write_test_program(
            "panic-supervision",
            "#!/bin/sh\nprevious=\nfor argument do second_last=$previous; previous=$argument; done\nprintf x > \"$previous\"\nsleep 1\nprintf done > \"$second_last\"\n",
        );
        let sentinel = unique_test_path("panic-sentinel");
        let progress = unique_test_path("panic-progress");
        let cancelled = AtomicBool::new(false);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = run_scp_once_controlled(
                &program,
                &[],
                &[
                    sentinel.to_string_lossy().to_string(),
                    progress.to_string_lossy().to_string(),
                ],
                ScpControl {
                    cancelled: &cancelled,
                    renderer_generation: None,
                    process_group_slot: None,
                    progress_path: Some(&progress),
                    is_directory: false,
                    total_bytes: Some(1),
                    clean_stage_between_attempts: false,
                },
                1,
                &mut |_| panic!("intentional progress callback panic"),
            );
        }));
        assert!(result.is_err());
        std::thread::sleep(Duration::from_millis(1_100));
        assert!(!sentinel.exists(), "panicking callback leaked its child");
        let _ = std::fs::remove_file(progress);
        std::fs::remove_file(program).expect("remove panic supervision program");
    }
}
