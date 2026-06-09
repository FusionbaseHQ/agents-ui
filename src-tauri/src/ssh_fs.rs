use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::files::{probe_from_sample, FileProbe, FsEntry, MAX_RANGE_READ_BYTES, PROBE_BYTES};

const MAX_TEXT_FILE_BYTES: usize = 2 * 1024 * 1024;
const BINARY_CHECK_BYTES: usize = 8 * 1024;
const MAX_REMOTE_FILE_SEARCH_RESULTS: usize = 1_000;
/// How many times an ssh/sftp op (or master-establish) is retried when it hits a
/// transient transport error before giving up.
const SSH_OP_ATTEMPTS: usize = 3;

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
        let candidates = [
            std::env::var_os("WINDIR")
                .map(|w| PathBuf::from(w).join("System32").join("OpenSSH").join(format!("{name}.exe"))),
        ];
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
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("path is empty".to_string());
    }
    if !trimmed.starts_with('/') {
        return Err("path must be absolute".to_string());
    }

    let mut parts: Vec<&str> = Vec::new();
    for part in trimmed.split('/') {
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

fn control_path() -> Result<String, String> {
    #[cfg(target_family = "unix")]
    let preferred_base = {
        // Keep this short to avoid Unix socket path length limits for ssh ControlPath.
        // Avoid using std::env::temp_dir() on macOS, which can be very long (e.g. /var/folders/...).
        let uid = std::env::var("UID")
            .ok()
            .and_then(|v| v.parse::<u32>().ok());
        match uid {
            Some(uid) => PathBuf::from("/tmp").join(format!("agents-ui-ssh-{uid}")),
            None => PathBuf::from("/tmp").join("agents-ui-ssh"),
        }
    };

    #[cfg(not(target_family = "unix"))]
    let preferred_base = std::env::temp_dir().join("agents-ui-ssh");

    let fallback_base = std::env::temp_dir().join("agents-ui-ssh");

    let base = match std::fs::create_dir_all(&preferred_base) {
        Ok(()) => preferred_base,
        Err(_) => {
            std::fs::create_dir_all(&fallback_base)
                .map_err(|e| format!("create control dir failed: {e}"))?;
            fallback_base
        }
    };

    Ok(base.join("%C").to_string_lossy().to_string())
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

fn user_ssh_config_path() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".ssh").join("config"))
}

fn ssh_common_args() -> Result<Vec<String>, String> {
    let control = control_path()?;
    let mut out: Vec<String> = Vec::new();
    if let Some(cfg) = user_ssh_config_path().filter(|p| p.is_file()) {
        out.push("-F".to_string());
        out.push(cfg.to_string_lossy().to_string());
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

/// Whether a multiplexing master process is currently registered for `target`.
fn master_is_alive(target: &str) -> bool {
    let (Ok(ssh), Ok(common)) = (program_path("ssh"), ssh_common_args()) else {
        return false;
    };
    Command::new(ssh)
        .args(&common)
        .args(["-O", "check"])
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Tear down the master for `target` (best effort) — used when it looks stale
/// (process alive but its underlying connection dead).
fn close_master(target: &str) {
    invalidate_master_verified(target);
    let (Ok(ssh), Ok(common)) = (program_path("ssh"), ssh_common_args()) else {
        return;
    };
    let _ = Command::new(ssh)
        .args(&common)
        .args(["-O", "exit"])
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Ensure the multiplexing master for `target` is up. Serialized per target so
/// that, when no master exists, exactly one ssh process creates it instead of
/// every concurrent op racing to open its own connection — a burst the server
/// rate-limits, surfacing as "Connection reset by peer" /
/// "kex_exchange_identification" / "Session open refused by peer".
fn ensure_master(target: &str) -> Result<(), String> {
    let lock = ssh_master_lock(target);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());

    // Skip the `ssh -O check` process spawn when the master was verified
    // recently — per-op this check used to dominate burst latency (probe +
    // N chunk reads = N+1 spawns).
    if master_recently_verified(target) {
        return Ok(());
    }

    if master_is_alive(target) {
        mark_master_verified(target);
        return Ok(());
    }

    let ssh = program_path("ssh")?;
    let common = ssh_common_args()?;
    let mut last_err = String::new();
    for attempt in 0..SSH_OP_ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(250 * attempt as u64));
            if master_is_alive(target) {
                mark_master_verified(target);
                return Ok(());
            }
        }
        // `true` is a trivial remote command; with ControlMaster=auto it opens
        // and persists the shared master, then returns immediately.
        let output = Command::new(&ssh)
            .args(&common)
            .arg(target)
            .arg("true")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("spawn ssh failed: {e}"))?;
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

fn run_ssh_once(target: &str, remote_args: &[String], stdin: Option<&[u8]>) -> Result<Output, String> {
    let mut cmd = Command::new(program_path("ssh")?);
    cmd.args(ssh_common_args()?);
    cmd.arg(target);
    cmd.args(remote_args);
    match stdin {
        Some(_) => {
            cmd.stdin(Stdio::piped());
        }
        None => {
            cmd.stdin(Stdio::null());
        }
    }
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    if let Some(input) = stdin {
        let mut child = cmd.spawn().map_err(|e| format!("spawn ssh failed: {e}"))?;
        if let Some(mut child_stdin) = child.stdin.take() {
            child_stdin
                .write_all(input)
                .map_err(|e| format!("write ssh stdin failed: {e}"))?;
        }
        child
            .wait_with_output()
            .map_err(|e| format!("wait ssh failed: {e}"))
    } else {
        cmd.output().map_err(|e| format!("run ssh failed: {e}"))
    }
}

fn run_ssh(target: &str, remote_args: &[String], stdin: Option<&[u8]>) -> Result<Output, String> {
    let mut last_output: Option<Output> = None;
    for attempt in 0..SSH_OP_ATTEMPTS {
        if attempt > 0 {
            // The previous attempt hit a transient transport error. The shared
            // master may be stale (process alive but its connection dead); drop
            // it so ensure_master rebuilds a fresh one, then back off.
            close_master(target);
            std::thread::sleep(Duration::from_millis(250 * attempt as u64));
        }
        ensure_master(target)?;
        let output = run_ssh_once(target, remote_args, stdin)?;
        if output.status.success() {
            return Ok(output);
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !is_transient_ssh_error(&stderr) {
            // Genuine remote-command failure (e.g. "File exists", permission
            // denied) — return it so the caller surfaces the real message.
            return Ok(output);
        }
        last_output = Some(output);
    }
    Ok(last_output.expect("ssh retry loop runs at least once"))
}

pub(crate) fn run_ssh_script(target: &str, script: &str) -> Result<Output, String> {
    let args = vec!["sh".to_string()];
    run_ssh(target, &args, Some(script.as_bytes()))
}

fn run_sftp_once(target: &str, batch: &str) -> Result<Output, String> {
    let mut cmd = Command::new(program_path("sftp")?);
    cmd.args(ssh_common_args()?);
    cmd.arg("-q");
    cmd.arg("-b");
    cmd.arg("-");
    cmd.arg(target);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("spawn sftp failed: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(batch.as_bytes())
            .map_err(|e| format!("write sftp stdin failed: {e}"))?;
    }
    child
        .wait_with_output()
        .map_err(|e| format!("wait sftp failed: {e}"))
}

fn run_sftp_batch(target: &str, batch: &str) -> Result<Output, String> {
    let mut last_output: Option<Output> = None;
    for attempt in 0..SSH_OP_ATTEMPTS {
        if attempt > 0 {
            close_master(target);
            std::thread::sleep(Duration::from_millis(250 * attempt as u64));
        }
        // Reuse the shared master rather than racing to open a fresh connection.
        ensure_master(target)?;
        let output = run_sftp_once(target, batch)?;
        if output.status.success() {
            return Ok(output);
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !is_transient_ssh_error(&stderr) {
            return Ok(output);
        }
        last_output = Some(output);
    }
    Ok(last_output.expect("sftp retry loop runs at least once"))
}

fn sftp_escape_arg(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        if ch == '"' || ch == '\\' {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('"');
    out
}

fn split_whitespace_with_remainder<'a>(line: &'a str, token_count: usize) -> Option<(Vec<&'a str>, &'a str)> {
    let bytes = line.as_bytes();
    let mut i = 0usize;
    let mut tokens: Vec<&'a str> = Vec::with_capacity(token_count);

    while tokens.len() < token_count {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            return None;
        }
        let start = i;
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let token = &line[start..i];
        tokens.push(token);
    }

    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    let remainder = if i >= bytes.len() { "" } else { &line[i..] };
    Some((tokens, remainder))
}

fn parse_sftp_ls(dir_path: &str, stdout: &str) -> Vec<FsEntry> {
    let mut entries: Vec<FsEntry> = Vec::new();

    for raw in stdout.lines() {
        let line = raw.trim_end();
        if line.is_empty() {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("sftp>") || lower.starts_with("connected to ") {
            continue;
        }
        if lower.starts_with("total ") {
            continue;
        }
        let kind = line.chars().next().unwrap_or('?');
        if !matches!(kind, 'd' | '-' | 'l' | 'c' | 'b' | 's' | 'p') {
            continue;
        }

        let Some((tokens, remainder)) = split_whitespace_with_remainder(line, 8) else {
            continue;
        };
        let name_field = remainder.trim();
        if name_field.is_empty() {
            continue;
        }
        let raw_name = name_field
            .split(" -> ")
            .next()
            .unwrap_or(name_field)
            .trim();
        // Some SFTP servers return full absolute paths; extract just the basename.
        let name = raw_name.rsplit('/').next().unwrap_or(raw_name);
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }

        let size = tokens.get(4).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
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

    entries
}

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
    let output = run_ssh(target, &args, None)?;
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

    // Keep scripts single-line: some user shells choke on literal newlines in SSH exec strings.
    let script = r#"uid="$(id -u 2>/dev/null || echo 1000)"; if [ "$uid" = "0" ]; then printf "/"; exit 0; fi; if [ -n "${HOME:-}" ]; then printf "%s" "$HOME"; exit 0; fi; pwd"#;

    let command = build_sh_c_command(script, None, &[]);
    let args = vec![command];
    let output = run_ssh(target, &args, None)?;
    if !output.status.success() {
        return Err(output_to_error("ssh failed", &output));
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Err("ssh returned empty root".to_string());
    }
    normalize_posix_path(&stdout)
}

#[tauri::command]
pub async fn ssh_list_fs_entries(target: String, root: String, path: String) -> Result<Vec<FsEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || ssh_list_fs_entries_sync(target, root, path))
        .await
        .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_list_fs_entries_sync(target: String, root: String, path: String) -> Result<Vec<FsEntry>, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let (_root, path) = ensure_within_root(&root, &path)?;

    let batch = format!("ls -la {}\n", sftp_escape_arg(&path));
    let output = run_sftp_batch(target, &batch)?;
    if !output.status.success() {
        return Err(output_to_error("sftp failed", &output));
    }
    Ok(parse_sftp_ls(&path, &String::from_utf8_lossy(&output.stdout)))
}

#[tauri::command]
pub async fn ssh_search_fs_entries(
    target: String,
    root: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<FsEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || ssh_search_fs_entries_sync(target, root, query, limit))
        .await
        .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_search_fs_entries_sync(
    target: String,
    root: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<FsEntry>, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let root = normalize_posix_path(&root)?;
    let query = query.trim().to_string();
    if query.len() < 2 {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(200).clamp(1, MAX_REMOTE_FILE_SEARCH_RESULTS);

    let mut out: Vec<FsEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    ssh_search_pass(target, &root, &query, limit, false, &mut seen, &mut out)?;
    if out.len() < limit {
        ssh_search_pass(target, &root, &query, limit - out.len(), true, &mut seen, &mut out)?;
    }

    Ok(out)
}

fn ssh_search_pass(
    target: &str,
    root: &str,
    query: &str,
    limit: usize,
    include_hidden_dirs: bool,
    seen: &mut HashSet<String>,
    out: &mut Vec<FsEntry>,
) -> Result<(), String> {
    if limit == 0 {
        return Ok(());
    }

    // `awk` exits at `limit` matches (find then dies on SIGPIPE), and the
    // optional `timeout` runner bounds the walk on huge trees with few matches
    // — partial results beat a multi-minute stall. The probe (`timeout 1 true`)
    // confirms coreutils-style syntax before relying on it.
    let script = r#"root=$1
query=$2
limit=$3
include_hidden=$4
q=$(printf '%s' "$query" | tr '[:upper:]' '[:lower:]')
runner=""
if timeout 1 true >/dev/null 2>&1; then runner="timeout 15"; fi
if [ "$include_hidden" = "1" ]; then
  $runner find "$root" -mindepth 1 \( -type d \( -name .git -o -name .hg -o -name .svn -o -name node_modules -o -name target -o -name dist -o -name build -o -name .next -o -name .nuxt -o -name .cache -o -name .turbo -o -name .venv -o -name venv -o -name __pycache__ -o -name .npm -o -name .pnpm-store -o -name .yarn \) -prune \) -o -type f -print 2>/dev/null
else
  $runner find "$root" -mindepth 1 \( -type d \( -name .git -o -name .hg -o -name .svn -o -name node_modules -o -name target -o -name dist -o -name build -o -name .next -o -name .nuxt -o -name .cache -o -name .turbo -o -name .venv -o -name venv -o -name __pycache__ -o -name .npm -o -name .pnpm-store -o -name .yarn -o -name '.*' \) -prune \) -o -type f -print 2>/dev/null
fi | awk -v q="$q" -v limit="$limit" 'BEGIN { count = 0 } { low = tolower($0); if (index(low, q) > 0) { print; count++; if (count >= limit) exit } }'
exit 0
"#;

    let args = vec![
        root.to_string(),
        query.to_string(),
        limit.to_string(),
        if include_hidden_dirs { "1" } else { "0" }.to_string(),
    ];
    let command = build_sh_c_command(script, Some("--"), &args);
    let output = run_ssh(target, &[command], None)?;
    if !output.status.success() {
        return Err(output_to_error("ssh search failed", &output));
    }

    for raw in String::from_utf8_lossy(&output.stdout).lines() {
        let path = match normalize_posix_path(raw) {
            Ok(path) => path,
            Err(_) => continue,
        };
        if root != "/" && path != root && !path.starts_with(&format!("{root}/")) {
            continue;
        }
        if !seen.insert(path.clone()) {
            continue;
        }
        let name = path.rsplit('/').next().unwrap_or(&path).to_string();
        if name.is_empty() {
            continue;
        }
        out.push(FsEntry {
            name,
            path,
            is_dir: false,
            size: 0,
        });
    }

    Ok(())
}

#[tauri::command]
pub async fn ssh_read_text_file(target: String, root: String, path: String) -> Result<String, String> {
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
    let output = run_ssh(target, &args, None)?;
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
    let output = run_ssh(target, &args, None)?;
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
    let output = run_ssh(target, &args, None)?;
    if !output.status.success() {
        return Err(output_to_error("ssh failed", &output));
    }
    // Raw bytes; the frontend derives offset/eof from the request + known size.
    Ok(output.stdout)
}

#[tauri::command]
pub async fn ssh_write_text_file(target: String, root: String, path: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ssh_write_text_file_sync(target, root, path, content))
        .await
        .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_write_text_file_sync(target: String, root: String, path: String, content: String) -> Result<(), String> {
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
    let script = r#"set -e; file="$1"; [ -f "$file" ] || { echo "not a file" >&2; exit 1; }; dir="$(dirname "$file")"; tmp=""; if command -v mktemp >/dev/null 2>&1; then tmp="$(mktemp "$dir/.agents-ui-tmp.XXXXXXXX" 2>/dev/null || true)"; fi; if [ -z "$tmp" ]; then tmp="$dir/.agents-ui-tmp.$$"; rm -f "$tmp"; fi; trap 'rm -f "$tmp"' EXIT; cat > "$tmp"; perms="$(stat -c %a "$file" 2>/dev/null || stat -f %Lp "$file" 2>/dev/null || echo '')"; if [ -n "$perms" ]; then chmod "$perms" "$tmp" 2>/dev/null || true; fi; mv "$tmp" "$file""#;

    let command = build_sh_c_command(script, Some("--"), &[path]);
    let args = vec![command];
    let output = run_ssh(target, &args, Some(content.as_bytes()))?;
    if !output.status.success() {
        return Err(output_to_error("ssh failed", &output));
    }
    Ok(())
}

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

    let script = r#"set -e; file="$1"; [ ! -e "$file" ] || { echo "file already exists" >&2; exit 1; }; dir="$(dirname "$file")"; [ -d "$dir" ] || { echo "parent directory does not exist" >&2; exit 1; }; : > "$file""#;
    let command = build_sh_c_command(script, Some("--"), &[path]);
    let args = vec![command];
    let output = run_ssh(target, &args, None)?;
    if !output.status.success() {
        return Err(output_to_error("ssh failed", &output));
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_create_directory(target: String, root: String, path: String) -> Result<(), String> {
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

    let script = r#"set -e; dir="$1"; [ ! -e "$dir" ] || { echo "directory already exists" >&2; exit 1; }; parent="$(dirname "$dir")"; [ -d "$parent" ] || { echo "parent directory does not exist" >&2; exit 1; }; mkdir "$dir""#;
    let command = build_sh_c_command(script, Some("--"), &[path]);
    let args = vec![command];
    let output = run_ssh(target, &args, None)?;
    if !output.status.success() {
        return Err(output_to_error("ssh failed", &output));
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_rename_fs_entry(target: String, root: String, path: String, new_name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ssh_rename_fs_entry_sync(target, root, path, new_name))
        .await
        .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_rename_fs_entry_sync(target: String, root: String, path: String, new_name: String) -> Result<String, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let (root, path) = ensure_within_root(&root, &path)?;
    ensure_not_root(&root, &path, "rename")?;

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

    let parent = {
        let idx = path.rfind('/').unwrap_or(0);
        if idx == 0 { "/".to_string() } else { path[..idx].to_string() }
    };
    let to = join_posix_path(&parent, name);
    let (_, to_checked) = ensure_within_root(&root, &to)?;

    let script = r#"set -e; from="$1"; to="$2"; [ -e "$from" ] || { echo "missing source" >&2; exit 1; }; [ ! -e "$to" ] || { echo "target already exists" >&2; exit 1; }; mv "$from" "$to""#;
    let command = build_sh_c_command(script, Some("--"), &[path, to_checked.clone()]);
    let args = vec![command];
    let output = run_ssh(target, &args, None)?;
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
    let output = run_ssh(target, &args, None)?;
    if !output.status.success() {
        return Err(output_to_error("ssh failed", &output));
    }
    Ok(())
}

/// Escape a remote path for scp. In legacy scp mode the path is interpreted by
/// the remote shell; in sftp mode (OpenSSH ≥ 9 default) it goes through the
/// client-side glob parser. Backslash-escaping is honored by both, so spaces,
/// quotes and glob metacharacters reach the server literally.
fn scp_escape_remote_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for ch in path.chars() {
        let safe = ch.is_ascii_alphanumeric()
            || matches!(ch, '/' | '-' | '_' | '.' | '+' | ',' | '@' | ':' | '=' | '%');
        if !safe {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn run_scp(scp_flags: &[&str], ssh_args: Vec<String>, paths: &[String]) -> Result<Output, String> {
    let mut cmd = Command::new(program_path("scp")?);
    // scp flags first (like -r)
    cmd.args(scp_flags);
    // SSH options next
    cmd.args(ssh_args);
    // Source and destination paths last
    cmd.args(paths);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.output().map_err(|e| format!("run scp failed: {e}"))
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
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let (_root, remote_path) = ensure_within_root(&root, &remote_path)?;

    let local = local_path.trim();
    if local.is_empty() {
        return Err("missing local path".to_string());
    }

    // Use scp -r for recursive copy (works for files and directories)
    // Format: scp -r user@host:/remote/path /local/path
    // Remote path must be escaped (remote shell in legacy mode, client-side
    // glob in sftp mode); the local path is passed verbatim.
    let source = format!("{}:{}", target, scp_escape_remote_path(&remote_path));
    let paths = vec![source, local.to_string()];
    let output = run_scp(&["-r"], ssh_common_args()?, &paths)?;
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

    let local = local_path.trim();
    if local.is_empty() {
        return Err("missing local path".to_string());
    }
    if !Path::new(local).exists() {
        return Err("local file does not exist".to_string());
    }

    // Use scp -r for recursive copy (works for files and directories)
    // Format: scp -r /local/path user@host:/remote/path
    // Remote path must be escaped (remote shell in legacy mode, client-side
    // glob in sftp mode); the local path is passed verbatim.
    let dest = format!("{}:{}", target, scp_escape_remote_path(&remote_path));
    let paths = vec![local.to_string(), dest];
    let output = run_scp(&["-r"], ssh_common_args()?, &paths)?;
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
    tauri::async_runtime::spawn_blocking(move || {
        ssh_download_to_temp_sync(target, root, remote_path)
    })
    .await
    .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_download_to_temp_sync(
    target: String,
    root: String,
    remote_path: String,
) -> Result<String, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let (_root, remote_path) = ensure_within_root(&root, &remote_path)?;

    // Extract filename from remote path
    let file_name = Path::new(&remote_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("download");

    // Create temp directory for this download
    let temp_base = std::env::temp_dir().join("agents-ui-downloads");
    std::fs::create_dir_all(&temp_base)
        .map_err(|e| format!("failed to create temp directory: {e}"))?;

    // Generate unique subdirectory
    let unique_id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let unique_dir = temp_base.join(format!("{unique_id}"));
    std::fs::create_dir_all(&unique_dir)
        .map_err(|e| format!("failed to create temp subdirectory: {e}"))?;

    let local_path = unique_dir.join(file_name);
    let local_path_str = local_path.to_string_lossy().to_string();

    // Download using scp (remote path escaped for both scp protocol modes)
    let source = format!("{}:{}", target, scp_escape_remote_path(&remote_path));
    let paths = vec![source, local_path_str.clone()];
    let output = run_scp(&["-r"], ssh_common_args()?, &paths)?;
    if !output.status.success() {
        return Err(output_to_error("scp download failed", &output));
    }

    Ok(local_path_str)
}
