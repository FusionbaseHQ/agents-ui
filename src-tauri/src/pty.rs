use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

pub(crate) const AGENTS_UI_ZELLIJ_PREFIX: &str = "agents-ui-";
#[cfg(target_family = "unix")]
const AGENTS_UI_ZELLIJ_LEGACY_SOCKET_BASE: &str = "/tmp/agents-ui-zellij";

#[cfg(target_os = "macos")]
#[derive(Default)]
struct LoginPathCache {
    initialized: bool,
    shell: Option<String>,
    path: Option<String>,
}

#[derive(Default)]
struct AppStateInner {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<String, PtySession>>,
    #[cfg(target_os = "macos")]
    login_path_cache: Mutex<LoginPathCache>,
    #[cfg(target_family = "unix")]
    shells_cache: Mutex<Option<Vec<ShellInfo>>>,
}

#[derive(Clone, Default)]
pub struct AppState {
    inner: Arc<AppStateInner>,
}

impl AppState {
    /// (launch command, child pid) for every live session. The auto-caffeinate
    /// watcher derives SSH activity from this PTY-table ground truth rather
    /// than trusting frontend session state.
    pub fn ssh_activity_snapshot(&self) -> Vec<(String, Option<u32>)> {
        match self.inner.sessions.lock() {
            Ok(sessions) => sessions
                .values()
                .map(|s| (s.command.clone(), s.child.process_id()))
                .collect(),
            Err(_) => Vec::new(),
        }
    }
}

struct PtySession {
    name: String,
    command: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send>,
    recording: Option<SessionRecording>,
    closing: bool,
}

struct SessionRecording {
    id: String,
    writer: BufWriter<std::fs::File>,
    started_at: Instant,
    last_flush: Instant,
    unflushed_bytes: usize,
    input_buffer: String,
    json_buf: Vec<u8>,
    enc_key: Option<[u8; 32]>,
}

#[derive(Serialize, Clone)]
pub struct SessionInfo {
    pub id: String,
    pub name: String,
    pub command: String,
    pub cwd: Option<String>,
}

#[derive(Serialize, Clone)]
struct PtyOutput {
    id: Arc<str>,
    data: String,
}

#[derive(Serialize, Clone)]
struct PtyExit {
    id: String,
    exit_code: Option<u32>,
}

/// Emitted when a session's requested shell couldn't be launched and we fell
/// back to the default. The UI surfaces `message` as a non-fatal toast.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ShellFallbackEvent {
    session_id: String,
    message: String,
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(target_family = "unix")]
fn agents_ui_zellij_session_name(persist_id: &str) -> String {
    let mut out = String::with_capacity(AGENTS_UI_ZELLIJ_PREFIX.len() + persist_id.len());
    out.push_str(AGENTS_UI_ZELLIJ_PREFIX);
    for ch in persist_id.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out == AGENTS_UI_ZELLIJ_PREFIX {
        out.push_str("session");
    }
    out
}

#[cfg(target_family = "unix")]
fn find_bundled_zellij() -> Option<PathBuf> {
    let sidecar = sidecar_path("zellij").filter(|p| p.is_file());
    if sidecar.is_some() {
        return sidecar;
    }
    #[cfg(debug_assertions)]
    {
        let dev = dev_sidecar_path("zellij").filter(|p| p.is_file());
        if dev.is_some() {
            return dev;
        }
    }
    None
}

fn valid_env_key(key: &str) -> bool {
    let trimmed = key.trim();
    let mut chars = trimmed.chars();
    let first = match chars.next() {
        Some(c) => c,
        None => return false,
    };
    if !(first == '_' || first.is_ascii_alphabetic()) {
        return false;
    }
    for c in chars {
        if !(c == '_' || c.is_ascii_alphanumeric()) {
            return false;
        }
    }
    true
}

fn capture_original_env(cmd: &mut CommandBuilder, name: &str, present_key: &str, value_key: &str) {
    match std::env::var_os(name) {
        Some(v) => {
            cmd.env(present_key, "1");
            cmd.env(value_key, v.to_string_lossy().to_string());
        }
        None => {
            cmd.env(present_key, "0");
            cmd.env(value_key, "");
        }
    }
}

#[cfg(target_family = "unix")]
#[cfg(target_family = "unix")]
fn shell_from_passwd() -> Option<String> {
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .ok()?;
    let prefix = format!("{user}:");
    let contents = fs::read_to_string("/etc/passwd").ok()?;
    for line in contents.lines() {
        if !line.starts_with(&prefix) {
            continue;
        }
        let shell = line.split(':').last()?.trim();
        if shell.is_empty() {
            return None;
        }
        if Path::new(shell).is_file() {
            return Some(shell.to_string());
        }
        return None;
    }
    None
}

fn default_user_shell() -> String {
    if let Ok(shell) = std::env::var("SHELL") {
        let trimmed = shell.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    #[cfg(target_family = "unix")]
    if let Some(shell) = shell_from_passwd() {
        return shell;
    }

    #[cfg(target_os = "macos")]
    {
        return "/bin/zsh".to_string();
    }

    #[cfg(not(target_os = "macos"))]
    {
        if Path::new("/bin/bash").is_file() {
            return "/bin/bash".to_string();
        }
        return "/bin/sh".to_string();
    }
}

fn run_command_output_with_timeout(
    mut cmd: Command,
    timeout: Duration,
    label: &str,
) -> Result<std::process::Output, String> {
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{label} failed: {e}"))?;

    let stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| format!("{label} failed: missing stdout pipe"))?;
    let stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| format!("{label} failed: missing stderr pipe"))?;

    let (stdout_tx, stdout_rx) = mpsc::channel::<Vec<u8>>();
    let (stderr_tx, stderr_rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut reader = stdout_pipe;
        let _ = reader.read_to_end(&mut buf);
        let _ = stdout_tx.send(buf);
    });
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut reader = stderr_pipe;
        let _ = reader.read_to_end(&mut buf);
        let _ = stderr_tx.send(buf);
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "{label} timed out after {}ms",
                        timeout.as_millis()
                    ));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(format!("{label} failed: {e}")),
        }
    };

    let stdout = stdout_rx
        .recv_timeout(Duration::from_millis(200))
        .unwrap_or_default();
    let stderr = stderr_rx
        .recv_timeout(Duration::from_millis(200))
        .unwrap_or_default();

    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(target_os = "macos")]
fn login_shell_path(shell: &str, base_path: &str) -> Option<String> {
    let shell_name = Path::new(shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    const START: &str = "__AGENTS_UI_PATH_START__";
    const END: &str = "__AGENTS_UI_PATH_END__";

    let (script, arg_sets): (String, Vec<Vec<&str>>) = if shell_name.contains("zsh") || shell_name.contains("bash") {
        (format!("printf '{START}%s{END}' \"$PATH\""), vec![vec!["-i", "-l", "-c"]])
    } else if shell_name == "fish" {
        (
            format!("printf '{START}%s{END}' (string join ':' $PATH)"),
            vec![vec!["-i", "-l", "-c"], vec!["-l", "-c"]],
        )
    } else if shell_name == "nu" || shell_name == "nushell" {
        (
            format!("print $\"{START}($env.PATH | str join ':'){END}\""),
            vec![vec!["-l", "-c"], vec!["-i", "-l", "-c"]],
        )
    } else {
        return None;
    };

    let extract_path = |stdout: &str| -> Option<String> {
        let start = stdout.find(START)?;
        let rest = &stdout[start + START.len()..];
        let end = rest.find(END)?;
        let path = rest[..end].trim();
        if path.is_empty() {
            return None;
        }
        Some(path.to_string())
    };

    let run_with_pty = |args: &[&str]| -> Option<String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .ok()?;

        let mut cmd = CommandBuilder::new(shell);
        cmd.args(args);
        cmd.arg(&script);
        cmd.env("PATH", base_path);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("SHELL", shell);

        let mut child = pair.slave.spawn_command(cmd).ok()?;
        let mut reader = pair.master.try_clone_reader().ok()?;
        let (tx, rx) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut utf8_carry: Vec<u8> = Vec::new();
            let mut output = String::new();

            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        output.push_str(&decode_utf8_stream(&mut utf8_carry, &buf[..n]));
                        if output.contains(START) && output.contains(END) {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }

            if !utf8_carry.is_empty() {
                output.push_str(&String::from_utf8_lossy(&utf8_carry));
            }
            let _ = tx.send(output);
        });

        let output = match rx.recv_timeout(Duration::from_millis(2000)) {
            Ok(data) => data,
            Err(RecvTimeoutError::Timeout) => String::new(),
            Err(RecvTimeoutError::Disconnected) => String::new(),
        };

        let _ = child.kill();
        let _ = child.wait();

        if output.is_empty() {
            None
        } else {
            Some(output)
        }
    };

    for args in &arg_sets {
        if let Some(stdout) = run_with_pty(args.as_slice()) {
            if let Some(path) = extract_path(&stdout) {
                return Some(path);
            }
        }
    }

    for args in arg_sets {
        let mut cmd = Command::new(shell);
        cmd.args(&args)
            .arg(&script)
            .env("PATH", base_path)
            .env("TERM", "xterm-256color")
            .env("COLORTERM", "truecolor")
            .env("SHELL", shell);
        let out = match run_command_output_with_timeout(
            cmd,
            Duration::from_millis(2000),
            "login shell PATH probe",
        ) {
            Ok(out) => out,
            Err(_) => continue,
        };

        let stdout = String::from_utf8_lossy(&out.stdout);
        if let Some(path) = extract_path(&stdout) {
            return Some(path);
        }
    }

    None
}

#[cfg(target_family = "unix")]
struct ShellXdgPaths {
    config_home: PathBuf,
    data_home: PathBuf,
    cache_home: PathBuf,
    runtime_dir: PathBuf,
}

#[cfg(target_family = "unix")]
fn ensure_shell_xdg_paths(app: &AppHandle) -> Option<ShellXdgPaths> {
    let app_data = app.path().app_data_dir().ok()?;
    let base = app_data.join("shell");
    let config_home = base.join("xdg-config");
    let data_home = base.join("xdg-data");
    let cache_home = base.join("xdg-cache");
    let runtime_dir = base.join("xdg-runtime");

    fs::create_dir_all(&config_home).ok()?;
    fs::create_dir_all(&data_home).ok()?;
    fs::create_dir_all(&cache_home).ok()?;
    fs::create_dir_all(&runtime_dir).ok()?;

    #[cfg(target_family = "unix")]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&runtime_dir, fs::Permissions::from_mode(0o700));
    }

    Some(ShellXdgPaths {
        config_home,
        data_home,
        cache_home,
        runtime_dir,
    })
}

#[cfg(target_family = "unix")]
struct ZellijPaths {
    home_dir: PathBuf,
    socket_dir: PathBuf,
}

#[cfg(target_family = "unix")]
fn ensure_preferred_zellij_socket_dir(app: &AppHandle) -> Option<PathBuf> {
    let home = app.path().home_dir().ok()?;
    let base = home.join(".agents-ui-zellij");
    fs::create_dir_all(&base).ok()?;
    let socket_dir = base.join("sockets");
    fs::create_dir_all(&socket_dir).ok()?;

    #[cfg(target_family = "unix")]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&base, fs::Permissions::from_mode(0o700));
        let _ = fs::set_permissions(&socket_dir, fs::Permissions::from_mode(0o700));
    }

    Some(socket_dir)
}

#[cfg(target_family = "unix")]
fn legacy_zellij_socket_dir() -> PathBuf {
    PathBuf::from(AGENTS_UI_ZELLIJ_LEGACY_SOCKET_BASE).join("sockets")
}

#[cfg(target_family = "unix")]
fn existing_legacy_zellij_socket_dir() -> Option<PathBuf> {
    let socket_dir = legacy_zellij_socket_dir();
    if socket_dir.is_dir() {
        Some(socket_dir)
    } else {
        None
    }
}

#[cfg(target_family = "unix")]
fn ensure_legacy_zellij_socket_dir() -> Option<PathBuf> {
    let socket_base = PathBuf::from(AGENTS_UI_ZELLIJ_LEGACY_SOCKET_BASE);
    fs::create_dir_all(&socket_base).ok()?;
    let socket_dir = socket_base.join("sockets");
    fs::create_dir_all(&socket_dir).ok()?;

    #[cfg(target_family = "unix")]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&socket_base, fs::Permissions::from_mode(0o700));
        let _ = fs::set_permissions(&socket_dir, fs::Permissions::from_mode(0o700));
    }

    Some(socket_dir)
}

#[cfg(target_family = "unix")]
fn zellij_socket_dir_candidates(preferred: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    out.push(preferred.to_path_buf());

    if let Some(legacy) = existing_legacy_zellij_socket_dir() {
        if legacy != preferred {
            out.push(legacy);
        }
    }

    out
}

#[cfg(target_family = "unix")]
fn ensure_zellij_paths(app: &AppHandle) -> Option<ZellijPaths> {
    let app_data = app.path().app_data_dir().ok()?;
    let base = app_data.join("zellij");
    fs::create_dir_all(&base).ok()?;

    // Store sockets in a stable per-user path so sessions survive app restarts without relying on /tmp.
    // Fallback to the legacy /tmp dir if we cannot create the preferred location (or in older installs).
    let socket_dir =
        ensure_preferred_zellij_socket_dir(app).or_else(|| ensure_legacy_zellij_socket_dir())?;

    Some(ZellijPaths {
        home_dir: base,
        socket_dir,
    })
}

#[cfg(target_family = "unix")]
fn zellij_list_sessions(
    zellij: &Path,
    zellij_home: &Path,
    socket_dir: &Path,
) -> Result<Vec<String>, String> {
    let mut cmd = Command::new(zellij);
    cmd.args(["list-sessions", "--short", "--no-formatting"])
        .env("HOME", zellij_home.to_string_lossy().to_string())
        .env("ZELLIJ_SOCKET_DIR", socket_dir.to_string_lossy().to_string());
    let out = run_command_output_with_timeout(
        cmd,
        Duration::from_millis(2000),
        "bundled zellij list-sessions",
    )?;

    if out.status.success() {
        let stdout = String::from_utf8_lossy(&out.stdout);
        let mut sessions = Vec::new();
        for line in stdout.lines() {
            let name = line.trim();
            if !name.is_empty() {
                sessions.push(name.to_string());
            }
        }
        return Ok(sessions);
    }

    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let combined = format!("{stdout}\n{stderr}");
    if out.status.code() == Some(1) && combined.contains("No active zellij sessions found") {
        return Ok(Vec::new());
    }

    let msg = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "zellij list-sessions failed".to_string()
    };
    Err(msg)
}

#[cfg(target_family = "unix")]
fn ensure_zellij_config(app: &AppHandle) -> Option<PathBuf> {
    let zellij_paths = ensure_zellij_paths(app)?;
    let config_dir = zellij_paths.home_dir.join(".config").join("zellij");
    fs::create_dir_all(&config_dir).ok()?;
    let config_path = config_dir.join("config.kdl");

    // Minimal config tuned for embedded terminals (xterm.js) to avoid feature probes that can hang.
    let contents = r#"// Agents UI managed Zellij config
// This is stored in an app-private HOME so it won't affect system zellij installs.

simplified_ui true
support_kitty_keyboard_protocol false
show_startup_tips false
show_release_notes false
"#;

    let needs_write = match fs::read_to_string(&config_path) {
        Ok(existing) => existing != contents,
        Err(_) => true,
    };
    if needs_write {
        fs::write(&config_path, contents).ok()?;
    }

    Some(config_path)
}

#[cfg(target_family = "unix")]
fn ensure_zellij_shell_wrapper(app: &AppHandle) -> Option<PathBuf> {
    let app_data = app.path().app_data_dir().ok()?;
    let base = app_data.join("shell");
    fs::create_dir_all(&base).ok()?;

    let path = base.join("zellij-shell-wrapper.sh");
    let contents = r#"#!/bin/sh
set -e

restore() {
  name="$1"
  present="$2"
  value="$3"
  if [ "$present" = "1" ]; then
    export "$name=$value"
  else
    unset "$name"
  fi
}

restore HOME "${AGENTS_UI_ORIG_HOME_PRESENT:-0}" "${AGENTS_UI_ORIG_HOME:-}"

if [ "${AGENTS_UI_ZELLIJ_RESTORE_XDG:-0}" = "1" ]; then
  restore XDG_CONFIG_HOME "${AGENTS_UI_ORIG_XDG_CONFIG_HOME_PRESENT:-0}" "${AGENTS_UI_ORIG_XDG_CONFIG_HOME:-}"
  restore XDG_DATA_HOME "${AGENTS_UI_ORIG_XDG_DATA_HOME_PRESENT:-0}" "${AGENTS_UI_ORIG_XDG_DATA_HOME:-}"
  restore XDG_CACHE_HOME "${AGENTS_UI_ORIG_XDG_CACHE_HOME_PRESENT:-0}" "${AGENTS_UI_ORIG_XDG_CACHE_HOME:-}"
  restore XDG_RUNTIME_DIR "${AGENTS_UI_ORIG_XDG_RUNTIME_DIR_PRESENT:-0}" "${AGENTS_UI_ORIG_XDG_RUNTIME_DIR:-}"
fi

shell="${AGENTS_UI_ZELLIJ_REAL_SHELL:-/bin/sh}"
if [ "${AGENTS_UI_ZELLIJ_LOGIN:-1}" = "1" ]; then
  exec "$shell" -l "$@"
fi
exec "$shell" "$@"
"#;

    let needs_write = match fs::read_to_string(&path) {
        Ok(existing) => existing != contents,
        Err(_) => true,
    };
    if needs_write {
        fs::write(&path, contents).ok()?;
        #[cfg(target_family = "unix")]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o755));
        }
    }

    Some(path)
}

#[cfg(target_family = "unix")]
fn zsh_zdotdir_path(app: &AppHandle, key: &str) -> Option<PathBuf> {
    let app_data = app.path().app_data_dir().ok()?;
    let base = app_data.join("shell").join("zsh");
    fs::create_dir_all(&base).ok()?;
    let safe = agents_ui_zellij_session_name(key);
    let dir = base.join(format!("zdotdir-{safe}"));
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PersistentSessionInfo {
    pub persist_id: String,
    pub session_name: String,
}

#[tauri::command]
pub fn list_persistent_sessions(app: AppHandle) -> Result<Vec<PersistentSessionInfo>, String> {
    #[cfg(not(target_family = "unix"))]
    {
        let _ = app;
        return Err("persistent sessions are only supported on Unix".to_string());
    }

    #[cfg(target_family = "unix")]
    {
        let zellij = find_bundled_zellij().ok_or("bundled zellij missing in this build".to_string())?;
        let zellij_paths = ensure_zellij_paths(&app).ok_or("unable to determine app data dir".to_string())?;
        let mut sessions: Vec<PersistentSessionInfo> = Vec::new();
        let mut list_errors: Vec<String> = Vec::new();

        for socket_dir in zellij_socket_dir_candidates(&zellij_paths.socket_dir) {
            match zellij_list_sessions(&zellij, &zellij_paths.home_dir, &socket_dir) {
                Ok(list) => {
                    for session_name in list {
                        if !session_name.starts_with(AGENTS_UI_ZELLIJ_PREFIX) {
                            continue;
                        }
                        let persist_id = session_name
                            .strip_prefix(AGENTS_UI_ZELLIJ_PREFIX)
                            .unwrap_or("")
                            .to_string();
                        sessions.push(PersistentSessionInfo {
                            persist_id,
                            session_name,
                        });
                    }
                }
                Err(err) => list_errors.push(err),
            }
        }

        if sessions.is_empty() && !list_errors.is_empty() {
            return Err(list_errors.remove(0));
        }

        sessions.sort_by(|a, b| a.persist_id.cmp(&b.persist_id));
        sessions.dedup_by(|a, b| a.session_name == b.session_name);
        Ok(sessions)
    }
}

#[tauri::command]
pub fn kill_persistent_session(app: AppHandle, persist_id: String) -> Result<(), String> {
    #[cfg(not(target_family = "unix"))]
    {
        let _ = (app, persist_id);
        return Err("persistent sessions are only supported on Unix".to_string());
    }

    #[cfg(target_family = "unix")]
    {
        let zellij = find_bundled_zellij().ok_or("bundled zellij missing in this build".to_string())?;
        let zellij_paths = ensure_zellij_paths(&app).ok_or("unable to determine app data dir".to_string())?;
        let trimmed = persist_id.trim();
        if trimmed.is_empty() {
            return Err("missing persist id".to_string());
        }
        let session_name = agents_ui_zellij_session_name(trimmed);
        if !session_name.starts_with(AGENTS_UI_ZELLIJ_PREFIX) {
            return Err("refusing to kill non agents-ui session".to_string());
        }

        let mut last_err: Option<String> = None;

        for socket_dir in zellij_socket_dir_candidates(&zellij_paths.socket_dir) {
            let out = Command::new(&zellij)
                .args(["kill-session", &session_name])
                .env("HOME", zellij_paths.home_dir.to_string_lossy().to_string())
                .env("ZELLIJ_SOCKET_DIR", socket_dir.to_string_lossy().to_string())
                .output()
                .map_err(|e| format!("failed to run bundled zellij: {e}"))?;
            if out.status.success() {
                return Ok(());
            }

            let fallback = Command::new(&zellij)
                .args(["delete-session", "--force", &session_name])
                .env("HOME", zellij_paths.home_dir.to_string_lossy().to_string())
                .env("ZELLIJ_SOCKET_DIR", socket_dir.to_string_lossy().to_string())
                .output()
                .ok();
            if let Some(out) = fallback {
                if out.status.success() {
                    return Ok(());
                }
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                if !stderr.is_empty() {
                    last_err = Some(stderr);
                }
            } else {
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                if !stderr.is_empty() {
                    last_err = Some(stderr);
                }
            }
        }

        Err(last_err.unwrap_or_else(|| format!("failed to kill zellij session {session_name}")))
    }
}

fn write_recording_event(rec: &mut SessionRecording, t: u64, data: &str) -> Result<(), String> {
    let data = match rec.enc_key.as_ref() {
        Some(key) => crate::secure::encrypt_string_with_key(
            key,
            crate::secure::SecretContext::Recording,
            data,
        )?,
        None => data.to_string(),
    };
    let line = crate::recording::RecordingLineV1::Input(crate::recording::RecordingEventV1 {
        t,
        data,
    });
    rec.json_buf.clear();
    serde_json::to_writer(&mut rec.json_buf, &line)
        .map_err(|e| format!("serialize failed: {e}"))?;
    rec.writer
        .write_all(&rec.json_buf)
        .map_err(|e| format!("write failed: {e}"))?;
    rec.writer
        .write_all(b"\n")
        .map_err(|e| format!("write failed: {e}"))?;
    rec.unflushed_bytes += rec.json_buf.len() + 1;
    Ok(())
}

fn skip_csi(iter: &mut std::iter::Peekable<std::str::Chars<'_>>) {
    while let Some(ch) = iter.next() {
        // CSI sequence terminator is any byte in 0x40..=0x7E.
        if ('@'..='~').contains(&ch) {
            break;
        }
    }
}

fn skip_until_st(iter: &mut std::iter::Peekable<std::str::Chars<'_>>) {
    while let Some(ch) = iter.next() {
        if ch == '\u{1b}' {
            if let Some('\\') = iter.peek().copied() {
                iter.next();
                break;
            }
        }
    }
}

fn skip_osc(iter: &mut std::iter::Peekable<std::str::Chars<'_>>) {
    while let Some(ch) = iter.next() {
        if ch == '\u{7}' {
            break;
        }
        if ch == '\u{1b}' {
            if let Some('\\') = iter.peek().copied() {
                iter.next();
                break;
            }
        }
    }
}

fn skip_escape_sequence(iter: &mut std::iter::Peekable<std::str::Chars<'_>>) {
    match iter.peek().copied() {
        Some('[') => {
            iter.next();
            skip_csi(iter);
        }
        Some(']') => {
            iter.next();
            skip_osc(iter);
        }
        Some('P') | Some('^') | Some('_') => {
            iter.next();
            skip_until_st(iter);
        }
        Some(_) => {
            // Unknown single-char escape sequence.
            iter.next();
        }
        None => {}
    }
}

fn record_user_input(rec: &mut SessionRecording, data: &str) -> Result<(), String> {
    let t = rec.started_at.elapsed().as_millis() as u64;
    let mut wrote_any = false;

    let mut iter = data.chars().peekable();
    while let Some(ch) = iter.next() {
        match ch {
            '\r' => {
                // Treat CRLF as a single enter.
                if iter.peek().copied() == Some('\n') {
                    iter.next();
                }
                let mut line = std::mem::take(&mut rec.input_buffer);
                line.push('\r');
                write_recording_event(rec, t, &line)?;
                wrote_any = true;
            }
            '\n' => {
                let mut line = std::mem::take(&mut rec.input_buffer);
                line.push('\n');
                write_recording_event(rec, t, &line)?;
                wrote_any = true;
            }
            '\u{7f}' | '\u{8}' => {
                rec.input_buffer.pop();
            }
            '\u{15}' => {
                rec.input_buffer.clear();
            }
            '\t' => {}
            '\u{1b}' => skip_escape_sequence(&mut iter),
            c if c.is_control() => {}
            c => rec.input_buffer.push(c),
        }
    }

    let should_flush = wrote_any
        || rec.unflushed_bytes >= 16 * 1024
        || rec.last_flush.elapsed().as_millis() >= 1500;
    if should_flush {
        rec.writer
            .flush()
            .map_err(|e| format!("flush failed: {e}"))?;
        rec.last_flush = Instant::now();
        rec.unflushed_bytes = 0;
    }
    Ok(())
}

fn unique_name(existing: &HashMap<String, PtySession>, base: &str) -> String {
    let taken: std::collections::HashSet<&str> = existing.values().map(|s| s.name.as_str()).collect();
    if !taken.contains(base) {
        return base.to_string();
    }
    let mut n = 2;
    loop {
        let candidate = format!("{base}-{n}");
        if !taken.contains(candidate.as_str()) {
            return candidate;
        }
        n += 1;
    }
}

fn decode_utf8_stream(carry: &mut Vec<u8>, chunk: &[u8]) -> String {
    if chunk.is_empty() {
        return String::new();
    }

    // Fast path: no leftover bytes from previous call — validate chunk directly
    // without copying into carry, avoiding re-validation of already-processed data.
    if carry.is_empty() {
        match std::str::from_utf8(chunk) {
            Ok(s) => return s.to_string(),
            Err(e) => {
                let valid = e.valid_up_to();
                let mut out = String::with_capacity(chunk.len());
                if valid > 0 {
                    out.push_str(unsafe { std::str::from_utf8_unchecked(&chunk[..valid]) });
                }
                match e.error_len() {
                    None => {
                        // Incomplete multi-byte at end — stash tail in carry
                        carry.extend_from_slice(&chunk[valid..]);
                        return out;
                    }
                    Some(len) => {
                        out.push('\u{FFFD}');
                        // Fall through to slow path for remaining bytes
                        carry.extend_from_slice(&chunk[valid + len..]);
                    }
                }
                if carry.is_empty() {
                    return out;
                }
                // Remaining bytes after the error — process via slow path
                let rest = std::mem::take(carry);
                let tail = decode_utf8_stream(carry, &rest);
                out.push_str(&tail);
                return out;
            }
        }
    }

    // Slow path: carry has leftover bytes from a previous incomplete sequence.
    // Typically only 1-3 bytes, so re-validating the full buffer is cheap.
    carry.extend_from_slice(chunk);

    let mut out = String::with_capacity(carry.len());
    let mut idx = 0usize;
    while idx < carry.len() {
        match std::str::from_utf8(&carry[idx..]) {
            Ok(s) => {
                out.push_str(s);
                idx = carry.len();
                break;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                if valid > 0 {
                    let end = idx + valid;
                    out.push_str(unsafe { std::str::from_utf8_unchecked(&carry[idx..end]) });
                    idx = end;
                }

                match e.error_len() {
                    None => break,
                    Some(len) => {
                        out.push('\u{FFFD}');
                        idx = (idx + len).min(carry.len());
                    }
                }
            }
        }
    }

    if idx > 0 {
        carry.drain(..idx);
    }
    out
}

#[cfg(target_family = "unix")]
fn sh_single_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

#[cfg(target_family = "unix")]
fn write_zsh_startup_files(temp_dir: &Path, orig_dir: &Path) -> Result<(), String> {
    let zshenv = temp_dir.join(".zshenv");
    let zprofile = temp_dir.join(".zprofile");
    let zlogin = temp_dir.join(".zlogin");
    let zshrc = temp_dir.join(".zshrc");

    let orig_zshenv = orig_dir.join(".zshenv");
    let orig_zprofile = orig_dir.join(".zprofile");
    let orig_zlogin = orig_dir.join(".zlogin");
    let orig_zshrc = orig_dir.join(".zshrc");

    let orig_dir_str = orig_dir.to_string_lossy();

    let source_if_exists = |path: &Path| -> String {
        let path_str = path.to_string_lossy();
        format!(
            "if [ -f {q} ]; then source {q}; fi\n",
            q = sh_single_quote(path_str.as_ref())
        )
    };

    let orig_dir_quoted = sh_single_quote(orig_dir_str.as_ref());

    let wrap_source = |orig_file: &Path, restore_to_temp: bool| -> String {
        let mut out = String::new();
        out.push_str("typeset -g __agents_ui_temp_zdotdir=\"$ZDOTDIR\"\n");
        out.push_str(&format!("export ZDOTDIR={orig_dir_quoted}\n"));
        out.push_str(&source_if_exists(orig_file));
        if restore_to_temp {
            out.push_str("export ZDOTDIR=\"$__agents_ui_temp_zdotdir\"\n");
        }
        out.push_str("unset __agents_ui_temp_zdotdir\n");
        out
    };

    fs::write(&zshenv, wrap_source(&orig_zshenv, true)).map_err(|e| e.to_string())?;
    fs::write(&zprofile, wrap_source(&orig_zprofile, true)).map_err(|e| e.to_string())?;
    fs::write(&zlogin, wrap_source(&orig_zlogin, false)).map_err(|e| e.to_string())?;

    let mut zshrc_contents = wrap_source(&orig_zshrc, false);
    zshrc_contents.push_str(
        r#"
__agents_ui_emit_cwd() {
  printf '\033]1337;CurrentDir=%s\007' "$PWD"
  printf '\033]1337;Command=\007'
}

__agents_ui_emit_command() { printf '\033]1337;Command=%s\007' "$1"; }

typeset -ga precmd_functions preexec_functions
precmd_functions+=__agents_ui_emit_cwd
preexec_functions+=__agents_ui_emit_command
__agents_ui_emit_cwd
"#,
    );
    fs::write(&zshrc, zshrc_contents).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_family = "unix")]
fn sidecar_path(name: &str) -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|p| p.join(name))
}

#[cfg(all(target_family = "unix", debug_assertions))]
fn dev_sidecar_path(name: &str) -> Option<PathBuf> {
    let triple = if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        "aarch64-apple-darwin"
    } else if cfg!(target_os = "macos") && cfg!(target_arch = "x86_64") {
        "x86_64-apple-darwin"
    } else {
        return None;
    };
    Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bin").join(format!("{name}-{triple}")))
}

#[cfg(target_family = "unix")]
fn find_bundled_nu() -> Option<PathBuf> {
    let sidecar = sidecar_path("nu").filter(|p| p.is_file());
    if sidecar.is_some() {
        return sidecar;
    }
    #[cfg(debug_assertions)]
    {
        let dev = dev_sidecar_path("nu").filter(|p| p.is_file());
        if dev.is_some() {
            return dev;
        }
    }
    None
}

// ───────────────────────── Bring-your-own-shell ─────────────────────────
//
// The app bundles Nushell and uses it as the default interactive shell. This
// block lets a user instead launch one of their own installed shells (zsh /
// bash / fish / …) per project or per session, while keeping bundled Nushell
// the default. Detection is advisory and never blocks a launch: if a chosen
// shell is missing at spawn time `resolve_shell` falls back to the default.

/// A shell selection passed from the frontend to `create_session`.
/// `kind == "bundled-nu"` (or `None`) keeps the default bundled Nushell;
/// `kind == "system"` launches `path` (an installed shell binary).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellChoice {
    pub kind: String,
    #[serde(default)]
    pub path: Option<String>,
    // The frontend also sends `family` (for its own display); we re-derive the
    // family from the path at spawn time, so any extra fields are ignored here.
}

/// One detected shell offered in the picker.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    /// Stable key: canonical path, or "bundled-nu" for the built-in.
    pub id: String,
    /// "bundled-nu" | "system"
    pub kind: String,
    /// "nu" | "zsh" | "bash" | "fish" | "sh" | "dash" | "ksh" | …
    pub family: String,
    pub display_name: String,
    /// Absolute launch path; empty for the bundled shell (resolved at spawn).
    pub path: String,
    pub version: Option<String>,
    /// Liveness probe succeeded (we got a version string).
    pub verified: bool,
    /// This is the user's login shell ($SHELL / passwd).
    pub is_login_default: bool,
    /// We provide PATH-import + OSC shell-integration for this family.
    pub supports_integration: bool,
}

fn shell_family_from_name(name: &str) -> &'static str {
    let n = name.trim().to_ascii_lowercase();
    if n == "nu" || n == "nushell" {
        "nu"
    } else if n.contains("pwsh") || n.contains("powershell") {
        "pwsh"
    } else if n.contains("fish") {
        "fish"
    } else if n.contains("zsh") {
        "zsh"
    } else if n.contains("bash") {
        "bash"
    } else if n.contains("xonsh") {
        "xonsh"
    } else if n.contains("elvish") {
        "elvish"
    } else if n.contains("tcsh") {
        "tcsh"
    } else if n.contains("dash") {
        "dash"
    } else if n.contains("ksh") {
        "ksh"
    } else if n.contains("csh") {
        "csh"
    } else if n == "sh" {
        "sh"
    } else {
        "other"
    }
}

fn shell_display_name(family: &str, file_name: &str) -> String {
    match family {
        "nu" => "Nushell".to_string(),
        "zsh" => "Zsh".to_string(),
        "bash" => "Bash".to_string(),
        "fish" => "Fish".to_string(),
        "sh" => "sh".to_string(),
        "dash" => "Dash".to_string(),
        "ksh" => "Ksh".to_string(),
        "tcsh" => "Tcsh".to_string(),
        "csh" => "Csh".to_string(),
        "pwsh" => "PowerShell".to_string(),
        "xonsh" => "Xonsh".to_string(),
        "elvish" => "Elvish".to_string(),
        _ => file_name.to_string(),
    }
}

fn file_name_of(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string()
}

fn shell_supports_integration(family: &str) -> bool {
    matches!(family, "nu" | "zsh" | "bash" | "fish")
}

#[cfg(target_family = "unix")]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match fs::metadata(path) {
        // `fs::metadata` follows symlinks, so /usr/local/bin/zsh → /bin/zsh works.
        Ok(m) => m.is_file() && (m.permissions().mode() & 0o111 != 0),
        Err(_) => false,
    }
}

/// Best-effort version string. Only shells known to accept `--version` and exit
/// promptly are probed; everything is timeout- and stdin-guarded so a hostile or
/// hanging binary can never wedge detection.
#[cfg(target_family = "unix")]
fn probe_shell_version(path: &str, family: &str) -> Option<String> {
    if !matches!(family, "nu" | "zsh" | "bash" | "fish" | "pwsh") {
        return None;
    }
    let mut cmd = Command::new(path);
    cmd.arg("--version");
    cmd.stdin(Stdio::null());
    cmd.env("TERM", "dumb");
    let out = run_command_output_with_timeout(
        cmd,
        Duration::from_millis(1500),
        "shell version probe",
    )
    .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find(|l| !l.trim().is_empty())?.trim();
    if line.is_empty() {
        None
    } else {
        Some(line.chars().take(120).collect())
    }
}

/// Union of candidate shell paths from several independent sources, so one
/// failing source can never blank the list.
#[cfg(target_family = "unix")]
fn shell_candidate_paths() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let push = |p: &str, out: &mut Vec<String>| {
        let t = p.trim().to_string();
        if !t.is_empty() && !out.iter().any(|e| e == &t) {
            out.push(t);
        }
    };

    // 1. /etc/shells — canonical login-approved shells on macOS.
    if let Ok(contents) = fs::read_to_string("/etc/shells") {
        for line in contents.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            push(line, &mut out);
        }
    }

    // 2. $SHELL — the user's configured login shell.
    if let Ok(s) = std::env::var("SHELL") {
        push(&s, &mut out);
    }

    // 3. passwd entry.
    if let Some(s) = shell_from_passwd() {
        push(&s, &mut out);
    }

    // 4. Well-known absolute paths.
    const NAMES: [&str; 10] = [
        "zsh", "bash", "fish", "nu", "pwsh", "dash", "ksh", "tcsh", "elvish", "xonsh",
    ];
    const DIRS: [&str; 5] = [
        "/bin",
        "/usr/bin",
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/run/current-system/sw/bin",
    ];
    for d in DIRS {
        for n in NAMES {
            let p = format!("{d}/{n}");
            if Path::new(&p).exists() {
                push(&p, &mut out);
            }
        }
    }

    // 5. PATH lookup — catches nonstandard prefixes (nix, asdf, custom).
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(':') {
            if dir.trim().is_empty() {
                continue;
            }
            for n in NAMES {
                let p = format!("{dir}/{n}");
                if Path::new(&p).exists() {
                    push(&p, &mut out);
                }
            }
        }
    }

    out
}

#[cfg(target_family = "unix")]
fn detect_shells_uncached() -> Vec<ShellInfo> {
    let login_default = default_user_shell();
    let login_default_canon = fs::canonicalize(&login_default)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| login_default.clone());

    let mut seen: Vec<String> = Vec::new();
    let mut shells: Vec<ShellInfo> = Vec::new();

    // Bundled Nushell is always first and always available.
    if find_bundled_nu().is_some() {
        shells.push(ShellInfo {
            id: "bundled-nu".to_string(),
            kind: "bundled-nu".to_string(),
            family: "nu".to_string(),
            display_name: "Bundled Nushell".to_string(),
            path: String::new(),
            version: None,
            verified: true,
            is_login_default: false,
            supports_integration: true,
        });
    }

    for cand in shell_candidate_paths() {
        if !is_executable_file(Path::new(&cand)) {
            continue;
        }
        // Dedupe by canonical (symlink-resolved) path.
        let canon = fs::canonicalize(&cand)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| cand.clone());
        if seen.iter().any(|s| s == &canon) {
            continue;
        }
        seen.push(canon.clone());

        let fname = file_name_of(&cand);
        let family = shell_family_from_name(&fname).to_string();
        let version = probe_shell_version(&cand, &family);
        let is_login_default = canon == login_default_canon;
        shells.push(ShellInfo {
            id: canon,
            kind: "system".to_string(),
            display_name: shell_display_name(&family, &fname),
            supports_integration: shell_supports_integration(&family),
            family,
            path: cand,
            verified: version.is_some(),
            version,
            is_login_default,
        });
    }

    shells
}

/// Enumerate installed shells for the picker. Cached; pass `refresh = true`
/// (the "Rescan" affordance) to force a re-detect. Never errors on Unix and
/// always includes the bundled shell, so the picker is never empty.
#[tauri::command]
pub fn detect_shells(
    state: State<'_, AppState>,
    refresh: Option<bool>,
) -> Result<Vec<ShellInfo>, String> {
    #[cfg(not(target_family = "unix"))]
    {
        let _ = (state, refresh);
        Ok(Vec::new())
    }
    #[cfg(target_family = "unix")]
    {
        let refresh = refresh.unwrap_or(false);
        if !refresh {
            if let Ok(cache) = state.inner.shells_cache.lock() {
                if let Some(cached) = cache.as_ref() {
                    return Ok(cached.clone());
                }
            }
        }
        let shells = detect_shells_uncached();
        if let Ok(mut cache) = state.inner.shells_cache.lock() {
            *cache = Some(shells.clone());
        }
        Ok(shells)
    }
}

/// The interactive shell a session will actually launch.
#[cfg(target_family = "unix")]
enum ResolvedShell {
    /// Bundled Nushell (the default). Carries the resolved `nu` binary path.
    BundledNu(PathBuf),
    /// A user-installed shell at this absolute path.
    System(String),
}

/// Resolve a frontend `ShellChoice` into a concrete shell, falling back to the
/// default (bundled nu, else `$SHELL`) when a chosen system shell is missing.
/// Returns an optional warning describing any fallback.
#[cfg(target_family = "unix")]
fn resolve_shell(
    choice: Option<&ShellChoice>,
    default_shell: &str,
) -> (ResolvedShell, Option<String>) {
    let default_resolved = || match find_bundled_nu() {
        Some(nu) => ResolvedShell::BundledNu(nu),
        None => ResolvedShell::System(default_shell.to_string()),
    };

    match choice {
        Some(c) if c.kind == "system" => match c.path.as_deref() {
            Some(p) if is_executable_file(Path::new(p)) => (ResolvedShell::System(p.to_string()), None),
            Some(p) => (
                default_resolved(),
                Some(format!(
                    "Selected shell \"{p}\" was not found; started the default shell instead."
                )),
            ),
            None => (default_resolved(), None),
        },
        _ => (default_resolved(), None),
    }
}

#[cfg(target_family = "unix")]
fn interactive_login_args(path: &str) -> Vec<String> {
    match shell_family_from_name(&file_name_of(path)) {
        // fish only enters interactive mode reliably with an explicit -i.
        "fish" => vec!["-l".to_string(), "-i".to_string()],
        _ => vec!["-l".to_string()],
    }
}

#[cfg(target_family = "unix")]
fn ensure_nu_config(app: &AppHandle, env_keys: &[String]) -> Option<(String, String, String, String)> {
    let xdg = ensure_shell_xdg_paths(app)?;
    let config_home = xdg.config_home;
    let data_home = xdg.data_home;
    let cache_home = xdg.cache_home;
    let runtime_dir = xdg.runtime_dir;

    let nu_config_dir = config_home.join("nushell");
    let nu_data_dir = data_home.join("nushell");
    let nu_cache_dir = cache_home.join("nushell");

    fs::create_dir_all(&nu_config_dir).ok()?;
    fs::create_dir_all(&nu_data_dir).ok()?;
    fs::create_dir_all(&nu_cache_dir).ok()?;

    let config_path = nu_config_dir.join("config.nu");
    let mut config = String::new();
    config.push_str("# Agents UI managed Nushell config\n\n");
    config.push_str("$env.config = ($env.config | upsert show_banner false)\n\n");
    config.push_str(
        r#"# Completion UX (standalone)
$env.config = ($env.config | upsert completions.algorithm "fuzzy")

$env.config = ($env.config | upsert menus [
  {
    name: completion_menu
    only_buffer_difference: false
    marker: "| "
    type: {
      layout: columnar
      columns: 4
      col_width: 20
      col_padding: 2
    }
    style: {
      text: green
      selected_text: green_reverse
      description_text: yellow
    }
  }
  {
    name: history_menu
    only_buffer_difference: true
    marker: "? "
    type: {
      layout: list
      page_size: 12
    }
    style: {
      text: green
      selected_text: green_reverse
      description_text: yellow
    }
  }
])

$env.config = ($env.config | upsert keybindings [
  {
    name: completion_menu
    modifier: none
    keycode: tab
    mode: [emacs vi_normal vi_insert]
    event: { send: menu name: completion_menu }
  }
  {
    name: history_menu
    modifier: none
    keycode: f7
    mode: [emacs vi_normal vi_insert]
    event: { send: menu name: history_menu }
  }
])

"#,
    );
    config.push_str(
        r#"# Conda compatibility for bundled Nu.
# Conda currently does not provide a native Nushell hook; emulate activate/deactivate
# by parsing `conda shell.posix` output and applying env mutations in-session.
def --env __agents_ui_conda_apply_record [key: string, value: string] {
  if $key == "PATH" {
    let path_list = if (($value | str trim) == "") { [] } else { $value | split row ":" }
    load-env { PATH: $path_list }
  } else {
    load-env ({} | upsert $key $value)
  }
}

def __agents_ui_conda_error [out: record] {
  let stderr = ($out.stderr | default "" | str trim)
  let stdout = ($out.stdout | default "" | str trim)
  let msg = if $stderr != "" {
    $stderr
  } else if $stdout != "" {
    $stdout
  } else {
    "conda command failed"
  }
  error make { msg: $msg }
}

def --env __agents_ui_conda_apply [...shell_args: string] {
  let out = (^conda shell.posix ...$shell_args | complete)
  if ($out.exit_code != 0) {
    __agents_ui_conda_error $out
  }

  mut skipped_hook_count = 0
  for raw_line in ($out.stdout | lines) {
    let line = ($raw_line | str trim)
    if $line == "" {
      continue
    }

    let unset_match = ($line | parse -r '^unset +(?<key>[A-Za-z_][A-Za-z0-9_]*)$')
    if (($unset_match | length) > 0) {
      let key = ($unset_match | get 0.key)
      do -i { hide-env $key }
      continue
    }

    let export_single = ($line | parse -r "^export +(?<key>[A-Za-z_][A-Za-z0-9_]*)='(?<value>.*)'$")
    if (($export_single | length) > 0) {
      let key = ($export_single | get 0.key)
      let value = ($export_single | get 0.value)
      __agents_ui_conda_apply_record $key $value
      continue
    }

    let export_double = ($line | parse -r '^export +(?<key>[A-Za-z_][A-Za-z0-9_]*)="(?<value>.*)"$')
    if (($export_double | length) > 0) {
      let key = ($export_double | get 0.key)
      let value = ($export_double | get 0.value)
      __agents_ui_conda_apply_record $key $value
      continue
    }

    let export_raw = ($line | parse -r '^export +(?<key>[A-Za-z_][A-Za-z0-9_]*)=(?<value>.*)$')
    if (($export_raw | length) > 0) {
      let key = ($export_raw | get 0.key)
      let value = ($export_raw | get 0.value)
      __agents_ui_conda_apply_record $key $value
      continue
    }

    let hook_match = ($line | parse -r '^\. +"(?<path>.+)"$')
    if (($hook_match | length) > 0) {
      $skipped_hook_count = $skipped_hook_count + 1
      continue
    }
  }

  if $skipped_hook_count > 0 {
    print $"[agents-ui] conda hook scripts were skipped in Nushell: ($skipped_hook_count) hook lines."
  }
}

def --wrapped --env conda [...args: string] {
  let subcmd = ($args | get 0? | default "")
  if $subcmd in [activate deactivate reactivate] {
    __agents_ui_conda_apply ...$args
    return
  }

  ^conda ...$args
}

$env.config = ($env.config | upsert hooks.pre_execution [
  {||
    let cleaned = (commandline | str trim | str replace --all (char newline) " ")
    let osc = (char --integer 27) + "]1337;Command=" + $cleaned + (char --integer 7)
    print --no-newline $osc
  }
])

$env.config = ($env.config | upsert hooks.pre_prompt [
  {||
    let osc = (char --integer 27) + "]1337;Command=" + (char --integer 7)
    print --no-newline $osc
  }
])

$env.PROMPT_COMMAND = {||
  let cwd = $env.PWD
  let osc = (char --integer 27) + "]1337;CurrentDir=" + $cwd + (char --integer 7)
  let dir = ($cwd | path basename)
  let conda_prefix = ($env.CONDA_PROMPT_MODIFIER? | default "")
  $osc + $conda_prefix + (ansi cyan) + $dir + (ansi reset) + " "
}

$env.PROMPT_INDICATOR = {|| "❯ " }
$env.PROMPT_MULTILINE_INDICATOR = {|| "… " }
"#,
    );

    let mut keys: Vec<String> = env_keys
        .iter()
        .map(|k| k.trim().to_string())
        .filter(|k| valid_env_key(k))
        .collect();
    keys.sort();
    keys.dedup();
    if !keys.is_empty() {
        config.push_str("\n# Agents UI injected env vars as variables\n");
        for key in keys {
            config.push_str(&format!(
                "let {key} = ($env.{key}? | default \"\")\n",
                key = key
            ));
        }
    }

    let needs_write = match fs::read_to_string(&config_path) {
        Ok(existing) => existing != config,
        Err(_) => true,
    };
    if needs_write {
        fs::write(&config_path, config).ok()?;
    }

    Some((
        config_home.to_string_lossy().to_string(),
        data_home.to_string_lossy().to_string(),
        cache_home.to_string_lossy().to_string(),
        runtime_dir.to_string_lossy().to_string(),
    ))
}

#[tauri::command]
pub fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionInfo>, String> {
    let sessions = state
        .inner
        .sessions
        .lock()
        .map_err(|_| "state poisoned")?;
    Ok(sessions
        .iter()
        .map(|(id, s)| SessionInfo {
            id: id.clone(),
            name: s.name.clone(),
            command: s.command.clone(),
            cwd: None,
        })
        .collect())
}

#[tauri::command]
pub fn create_session(
    app: AppHandle,
    state: State<'_, AppState>,
    name: Option<String>,
    command: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    env_vars: Option<HashMap<String, String>>,
    persistent: Option<bool>,
    persist_id: Option<String>,
    shell_choice: Option<ShellChoice>,
) -> Result<SessionInfo, String> {
    #[cfg(not(target_family = "unix"))]
    let _ = &shell_choice;

    #[cfg(target_family = "unix")]
    let shell = default_user_shell();
    #[cfg(not(target_family = "unix"))]
    let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());

    // Resolve the requested shell up front. `None`/`bundled-nu` keeps today's
    // default (bundled Nushell); a `system` choice launches the user's own
    // shell, with a graceful fallback if it has gone missing.
    #[cfg(target_family = "unix")]
    let (resolved_shell, shell_warning) = resolve_shell(shell_choice.as_ref(), &shell);
    #[cfg(target_family = "unix")]
    let effective_shell = match &resolved_shell {
        ResolvedShell::System(p) => p.clone(),
        ResolvedShell::BundledNu(_) => shell.clone(),
    };

    let persistent = persistent.unwrap_or(false);
    let persist_id = persist_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    #[cfg(not(target_family = "unix"))]
    if persistent {
        return Err("persistent sessions are only supported on Unix".to_string());
    }

    let command = command.unwrap_or_default().trim().to_string();
    if persistent && !command.is_empty() {
        return Err("persistent sessions currently require an empty command (run commands inside the session)".to_string());
    }
    let is_shell = command.is_empty();
    if persistent && !is_shell {
        return Err("persistent sessions currently require an empty command (run commands inside the session)".to_string());
    }

    #[cfg(target_family = "unix")]
    if persistent && persist_id.is_none() {
        return Err("persistId is required for persistent sessions".to_string());
    }

    let cwd = cwd
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .filter(|s| Path::new(s).is_dir())
        .or_else(|| {
            #[cfg(target_family = "unix")]
            {
                std::env::var("HOME").ok().filter(|s| Path::new(s).is_dir())
            }
            #[cfg(not(target_family = "unix"))]
            {
                std::env::var("USERPROFILE").ok().filter(|s| Path::new(s).is_dir())
            }
        });

    #[cfg(target_family = "unix")]
    let mut persistent_zellij_env: Option<(String, String)> = None;

    #[cfg(target_family = "unix")]
    let (program, args, shown_command, use_nu, inner_shell) = if persistent {
        let zellij = find_bundled_zellij().ok_or("bundled zellij missing in this build".to_string())?;
        let persist_id = persist_id.clone().ok_or("persistId is required for persistent sessions")?;
        let zellij_session = agents_ui_zellij_session_name(&persist_id);
        let zellij_config = ensure_zellij_config(&app).map(|p| p.to_string_lossy().to_string());
        let zellij_paths = ensure_zellij_paths(&app).ok_or("unable to determine app data dir".to_string())?;

        let (inner_shell, inner_use_nu) = match &resolved_shell {
            ResolvedShell::BundledNu(nu) => (nu.to_string_lossy().to_string(), true),
            ResolvedShell::System(p) => (p.clone(), false),
        };

        let mut socket_dir = zellij_paths.socket_dir.clone();
        for candidate in zellij_socket_dir_candidates(&zellij_paths.socket_dir) {
            if let Ok(existing) = zellij_list_sessions(&zellij, &zellij_paths.home_dir, &candidate) {
                if existing.iter().any(|s| s == &zellij_session) {
                    socket_dir = candidate;
                    break;
                }
            }
        }
        persistent_zellij_env = Some((
            zellij_paths.home_dir.to_string_lossy().to_string(),
            socket_dir.to_string_lossy().to_string(),
        ));

        let mut zellij_args: Vec<String> = Vec::new();
        if let Some(cfg) = &zellij_config {
            zellij_args.push("--config".to_string());
            zellij_args.push(cfg.clone());
        }
        zellij_args.push("attach".to_string());
        zellij_args.push("-c".to_string());
        zellij_args.push(zellij_session.clone());

        let shown_command = if let Some(cfg) = zellij_config {
            format!("zellij --config {cfg} attach -c {zellij_session}")
        } else {
            format!("zellij attach -c {zellij_session}")
        };

        (
            zellij.to_string_lossy().to_string(),
            zellij_args,
            shown_command,
            inner_use_nu,
            inner_shell,
        )
    } else if is_shell {
        match &resolved_shell {
            ResolvedShell::BundledNu(nu) => (
                nu.to_string_lossy().to_string(),
                Vec::new(),
                "nu".to_string(),
                true,
                shell.clone(),
            ),
            ResolvedShell::System(p) => {
                let args = interactive_login_args(p);
                let shown = format!("{p} {}", args.join(" "));
                (p.clone(), args, shown, false, p.clone())
            }
        }
    } else {
        // Run-a-command sessions (agent quick-starts like claude/codex). Nushell
        // is not used as the command runner; the default path keeps `$SHELL -lc`,
        // while an explicitly chosen system shell runs `<shell> -l -c <command>`.
        match &resolved_shell {
            ResolvedShell::System(p) => (
                p.clone(),
                vec!["-l".to_string(), "-c".to_string(), command.clone()],
                format!("{p} -l -c {command}"),
                false,
                p.clone(),
            ),
            ResolvedShell::BundledNu(_) => (
                shell.clone(),
                vec!["-lc".to_string(), command.clone()],
                format!("{shell} -lc {command}"),
                false,
                shell.clone(),
            ),
        }
    };

    #[cfg(not(target_family = "unix"))]
    let (program, args, shown_command) = if is_shell {
        (shell.clone(), Vec::new(), shell.clone())
    } else {
        (
            shell.clone(),
            vec!["/C".to_string(), command.clone()],
            format!("{shell} /C {command}"),
        )
    };

    #[cfg(not(target_family = "unix"))]
    let use_nu = false;

    let size = PtySize {
        rows: rows.unwrap_or(24),
        cols: cols.unwrap_or(80),
        pixel_width: 0,
        pixel_height: 0,
    };

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("openpty failed: {e}"))?;

    let id = state.inner.next_id.fetch_add(1, Ordering::Relaxed).to_string();

    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
    let env_keys: Vec<String> = env_vars
        .as_ref()
        .map(|vars| vars.keys().map(|k| k.trim().to_string()).collect())
        .unwrap_or_default();
    let frontend_set_path = env_vars
        .as_ref()
        .map(|vars| vars.contains_key("PATH"))
        .unwrap_or(false);

    if let Some(vars) = env_vars {
        for (k, v) in vars {
            let key = k.trim();
            if !valid_env_key(key) {
                continue;
            }
            cmd.env(key, v);
        }
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // MCP bearer token: CLIs registered with --bearer-token-env-var (Codex)
    // read it from the session environment to authenticate against /mcp.
    cmd.env(
        crate::mcp_server::MCP_TOKEN_ENV_VAR,
        crate::mcp_server::get_or_init_auth_token(),
    );
    #[cfg(target_family = "unix")]
    if cmd.get_env("SHELL").is_none() {
        cmd.env("SHELL", effective_shell.clone());
    }
    #[cfg(target_family = "unix")]
    if persistent {
        if let Some((zellij_home, zellij_socket_dir)) = persistent_zellij_env.as_ref() {
            cmd.env("HOME", zellij_home.clone());
            cmd.env("ZELLIJ_SOCKET_DIR", zellij_socket_dir.clone());
        } else if let Some(zellij_paths) = ensure_zellij_paths(&app) {
            cmd.env("HOME", zellij_paths.home_dir.to_string_lossy().to_string());
            cmd.env("ZELLIJ_SOCKET_DIR", zellij_paths.socket_dir.to_string_lossy().to_string());
        }

        if let Some(wrapper) = ensure_zellij_shell_wrapper(&app) {
            cmd.env("SHELL", wrapper.to_string_lossy().to_string());
            cmd.env("AGENTS_UI_ZELLIJ_REAL_SHELL", inner_shell.clone());
            cmd.env("AGENTS_UI_ZELLIJ_LOGIN", "1");
            cmd.env("AGENTS_UI_ZELLIJ_RESTORE_XDG", if use_nu { "0" } else { "1" });

            capture_original_env(&mut cmd, "HOME", "AGENTS_UI_ORIG_HOME_PRESENT", "AGENTS_UI_ORIG_HOME");
            capture_original_env(
                &mut cmd,
                "XDG_CONFIG_HOME",
                "AGENTS_UI_ORIG_XDG_CONFIG_HOME_PRESENT",
                "AGENTS_UI_ORIG_XDG_CONFIG_HOME",
            );
            capture_original_env(
                &mut cmd,
                "XDG_DATA_HOME",
                "AGENTS_UI_ORIG_XDG_DATA_HOME_PRESENT",
                "AGENTS_UI_ORIG_XDG_DATA_HOME",
            );
            capture_original_env(
                &mut cmd,
                "XDG_CACHE_HOME",
                "AGENTS_UI_ORIG_XDG_CACHE_HOME_PRESENT",
                "AGENTS_UI_ORIG_XDG_CACHE_HOME",
            );
            capture_original_env(
                &mut cmd,
                "XDG_RUNTIME_DIR",
                "AGENTS_UI_ORIG_XDG_RUNTIME_DIR_PRESENT",
                "AGENTS_UI_ORIG_XDG_RUNTIME_DIR",
            );
        } else {
            cmd.env("SHELL", inner_shell.clone());
        }
    }

    #[cfg(target_os = "macos")]
    {
        // Always construct a clean PATH on macOS. Don't check cmd.get_env("PATH")
        // because CommandBuilder inherits the parent environment which may be corrupted.
        // Only skip if frontend explicitly passed PATH in env_vars.
        if !frontend_set_path {
            let mut fallback_entries: Vec<String> = std::env::var("PATH")
                .unwrap_or_default()
                .split(':')
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string())
                .collect();

            if let Ok(home) = std::env::var("HOME") {
                for candidate in [format!("{home}/.cargo/bin"), format!("{home}/.local/bin"), format!("{home}/bin")] {
                    if Path::new(&candidate).is_dir() && !fallback_entries.iter().any(|p| p == &candidate) {
                        fallback_entries.insert(0, candidate);
                    }
                }
            }

            for candidate in [
                "/opt/homebrew/bin",
                "/opt/homebrew/sbin",
                "/usr/local/bin",
                "/usr/local/sbin",
            ] {
                if Path::new(candidate).is_dir() && !fallback_entries.iter().any(|p| p == candidate) {
                    fallback_entries.insert(0, candidate.to_string());
                }
            }

            for candidate in ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
                if Path::new(candidate).is_dir() && !fallback_entries.iter().any(|p| p == candidate) {
                    fallback_entries.push(candidate.to_string());
                }
            }

            let fallback_path = fallback_entries.join(":");
            // Import PATH from the shell that will actually run, so a user whose
            // PATH is configured in their chosen shell's profile gets it. The
            // cache is keyed by that shell, so different shells don't collide.
            let imported_path = if let Ok(mut cache) = state.inner.login_path_cache.lock() {
                if cache.initialized && cache.shell.as_deref() == Some(effective_shell.as_str()) {
                    cache.path.clone()
                } else {
                    let computed = login_shell_path(&effective_shell, &fallback_path);
                    cache.initialized = true;
                    cache.shell = Some(effective_shell.clone());
                    cache.path = computed.clone();
                    computed
                }
            } else {
                login_shell_path(&effective_shell, &fallback_path)
            };

            let mut path_entries: Vec<String> = Vec::new();
            let mut push_unique = |value: &str| {
                let trimmed = value.trim();
                // Filter out entries that don't look like valid paths.
                // Shell startup scripts can pollute PATH with error messages.
                if trimmed.is_empty()
                    || !trimmed.starts_with('/')
                    || trimmed.contains('\n')
                    || trimmed.contains('\r')
                {
                    return;
                }
                if !path_entries.iter().any(|p| p == trimmed) {
                    path_entries.push(trimmed.to_string());
                }
            };

            if let Some(ref imported) = imported_path {
                for entry in imported.split(':') {
                    push_unique(entry);
                }
            }

            for entry in &fallback_entries {
                push_unique(entry);
            }

            if !path_entries.is_empty() {
                cmd.env("PATH", path_entries.join(":"));
            }
        }
    }

    if cmd.get_env("PATH").is_none() {
        if let Ok(path) = std::env::var("PATH") {
            let trimmed = path.trim();
            if !trimmed.is_empty() {
                cmd.env("PATH", trimmed);
            }
        }
    }

    #[cfg(target_family = "unix")]
    if use_nu {
        if let Some((xdg_config_home, xdg_data_home, xdg_cache_home, xdg_runtime_dir)) =
            ensure_nu_config(&app, &env_keys)
        {
            cmd.env("XDG_CONFIG_HOME", xdg_config_home);
            cmd.env("XDG_DATA_HOME", xdg_data_home);
            cmd.env("XDG_CACHE_HOME", xdg_cache_home);
            cmd.env("XDG_RUNTIME_DIR", xdg_runtime_dir);
        }
    } else if persistent {
        if let Some(xdg) = ensure_shell_xdg_paths(&app) {
            cmd.env("XDG_CONFIG_HOME", xdg.config_home.to_string_lossy().to_string());
            cmd.env("XDG_DATA_HOME", xdg.data_home.to_string_lossy().to_string());
            cmd.env("XDG_CACHE_HOME", xdg.cache_home.to_string_lossy().to_string());
            cmd.env("XDG_RUNTIME_DIR", xdg.runtime_dir.to_string_lossy().to_string());
        }
    }
    if let Some(ref cwd) = cwd {
        cmd.cwd(cwd);
    }

    #[cfg(target_family = "unix")]
    {
        let shell_name = Path::new(&inner_shell)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        if is_shell && shell_name.contains("bash") && !use_nu {
            let orig_prompt = cmd
                .get_env("PROMPT_COMMAND")
                .and_then(|v| v.to_str())
                .map(|s| s.to_string());
            if let Some(orig) = orig_prompt {
                cmd.env("AGENTS_UI_ORIG_PROMPT_COMMAND", orig);
            }
            cmd.env(
                "PROMPT_COMMAND",
                "printf '\\033]1337;CurrentDir=%s\\007' \"$PWD\"; if [ -n \"$AGENTS_UI_ORIG_PROMPT_COMMAND\" ]; then eval \"$AGENTS_UI_ORIG_PROMPT_COMMAND\"; fi",
            );
        }

        if is_shell && shell_name.contains("zsh") && !use_nu {
            let orig_dotdir = std::env::var("ZDOTDIR")
                .ok()
                .filter(|s| Path::new(s).is_dir())
                .or_else(|| std::env::var("HOME").ok().filter(|s| Path::new(s).is_dir()));

            if let Some(orig_dotdir) = orig_dotdir {
                let dotdir = if persistent {
                    persist_id
                        .as_deref()
                        .and_then(|pid| zsh_zdotdir_path(&app, pid))
                } else {
                    Some(std::env::temp_dir().join(format!("agents-ui-zdotdir-{id}")))
                };

                if let Some(dotdir) = dotdir {
                    if fs::create_dir_all(&dotdir).is_ok()
                        && write_zsh_startup_files(&dotdir, Path::new(&orig_dotdir)).is_ok()
                    {
                        cmd.env("ZDOTDIR", dotdir.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn failed: {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {e}"))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer failed: {e}"))?;

    let mut sessions = state
        .inner
        .sessions
        .lock()
        .map_err(|_| "state poisoned")?;

    let base_name = name.unwrap_or_else(|| (if is_shell { "shell" } else { "agent" }).to_string());
    let base_trimmed = base_name.trim();
    let base_trimmed = if base_trimmed.is_empty() { "session" } else { base_trimmed };
    let final_name = unique_name(&sessions, base_trimmed);

    sessions.insert(
        id.clone(),
        PtySession {
            name: final_name.clone(),
            command: shown_command.clone(),
            master: pair.master,
            writer,
            child,
            recording: None,
            closing: false,
        },
    );
    drop(sessions);

    // Re-evaluate promptly so the sleep assertion engages as soon as an SSH
    // session opens. Deliberately no poke on exit/close: release goes through
    // the watcher's grace period so a reconnect dip can't let the Mac sleep.
    crate::power_assertion::poke();

    // Tell the UI if the requested shell couldn't be launched and we fell back.
    #[cfg(target_family = "unix")]
    if let Some(message) = shell_warning {
        let _ = app.emit_to(
            "main",
            "shell-fallback",
            ShellFallbackEvent {
                session_id: id.clone(),
                message,
            },
        );
    }

    let id_for_reader = id.clone();
    let id_for_emitter: Arc<str> = Arc::from(id.as_str());
    let state_for_emitter = state.inner().clone();
    let app_for_emitter = app.clone();
    // Bounded channel so a flooding child can't grow the queue without limit:
    // when the emitter falls behind, send() blocks the reader, the kernel PTY
    // buffer fills, and the child throttles on write — the same backpressure a
    // real terminal applies. No output is ever dropped. 256 slots × ≤64 KiB
    // reads gives ample burst absorption before that kicks in.
    let (tx, rx) = mpsc::sync_channel::<String>(256);

    // Reader thread: reads from PTY, decodes UTF-8, sends strings to channel.
    // Blocking reader.read() is isolated here so the emitter can flush on timeout.
    std::thread::spawn(move || {
        // 64 KiB read buffer: read() returns as soon as data is available (so
        // interactive echo latency is unaffected by the size), but a larger
        // buffer means far fewer read syscalls + channel sends when a program
        // floods output, which keeps the pipeline ahead of the producer.
        let mut buf = [0u8; 65536];
        let mut utf8_carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = decode_utf8_stream(&mut utf8_carry, &buf[..n]);
                    if !data.is_empty() {
                        if tx.send(data).is_err() {
                            break;
                        }
                    }
                }
                Err(_) => break,
            }
        }
        if !utf8_carry.is_empty() {
            let data = String::from_utf8_lossy(&utf8_carry).to_string();
            if !data.is_empty() {
                let _ = tx.send(data);
            }
        }
        // tx dropped here → emitter receives Disconnected
    });

    // Emitter thread: coalesces reader chunks into batched pty-output events.
    //
    // Strategy: leading-edge emit + trailing coalesce. The first chunk of every
    // burst is emitted immediately (after a non-blocking drain of anything else
    // already queued), so interactive keystroke echo reaches the UI with the
    // lowest possible latency instead of waiting out a batching interval.
    // Remaining chunks of the same burst are then coalesced for up to
    // OUTPUT_EMIT_INTERVAL, and flushed early whenever the buffer reaches
    // OUTPUT_EMIT_BYTES — so heavy output still collapses into a few large IPC
    // messages. When a burst goes idle we flush the tail and block until the
    // next chunk, so the thread parks at ~0 wakeups when nothing is happening.
    std::thread::spawn(move || {
        const OUTPUT_EMIT_BYTES: usize = 32 * 1024;
        const OUTPUT_EMIT_INTERVAL: Duration = Duration::from_millis(8);

        let mut output_buffer = String::new();

        let emit_buffered_output = |buffer: &mut String| {
            if buffer.is_empty() {
                return;
            }
            let data = std::mem::take(buffer);
            let _ = app_for_emitter.emit_to(
                "main",
                "pty-output",
                PtyOutput {
                    id: id_for_emitter.clone(),
                    data,
                },
            );
        };

        // Pull everything already waiting in the channel into the buffer without
        // blocking, stopping once we have a full batch's worth of bytes.
        let drain_available = |buffer: &mut String| {
            while buffer.len() < OUTPUT_EMIT_BYTES {
                match rx.try_recv() {
                    Ok(data) => buffer.push_str(&data),
                    Err(_) => break,
                }
            }
        };

        'bursts: loop {
            // Block until the first chunk of a new burst arrives.
            match rx.recv() {
                Ok(data) => output_buffer.push_str(&data),
                Err(_) => break, // reader disconnected
            }
            // Leading edge: grab anything else already queued, then emit at once.
            drain_available(&mut output_buffer);
            emit_buffered_output(&mut output_buffer);

            // Trailing coalesce: keep batching while the burst continues.
            loop {
                match rx.recv_timeout(OUTPUT_EMIT_INTERVAL) {
                    Ok(data) => {
                        output_buffer.push_str(&data);
                        drain_available(&mut output_buffer);
                        if output_buffer.len() >= OUTPUT_EMIT_BYTES {
                            emit_buffered_output(&mut output_buffer);
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        // Burst idled — flush the tail and wait for the next one.
                        emit_buffered_output(&mut output_buffer);
                        continue 'bursts;
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        emit_buffered_output(&mut output_buffer);
                        break 'bursts;
                    }
                }
            }
        }

        let session = match state_for_emitter.inner.sessions.lock() {
            Ok(mut sessions) => sessions.remove(&id_for_reader),
            Err(_) => None,
        };

        let exit_code = session
            .and_then(|mut s| s.child.wait().ok().map(|status| status.exit_code()));

        let _ = app_for_emitter.emit_to(
            "main",
            "pty-exit",
            PtyExit {
                id: id_for_reader,
                exit_code,
            },
        );
    });

    Ok(SessionInfo {
        id,
        name: final_name,
        command: shown_command,
        cwd,
    })
}

#[tauri::command]
pub fn start_session_recording(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    recording_id: String,
    recording_name: Option<String>,
    encrypt: Option<bool>,
    project_id: String,
    session_persist_id: String,
    cwd: Option<String>,
    effect_id: Option<String>,
    bootstrap_command: Option<String>,
) -> Result<String, String> {
    let safe_id = crate::recording::sanitize_recording_id(&recording_id);
    let encrypt_enabled = encrypt.unwrap_or(true);
    let enc_key = if encrypt_enabled {
        Some(crate::secure::get_or_create_master_key(&app)?)
    } else {
        None
    };

    let mut sessions = state
        .inner
        .sessions
        .lock()
        .map_err(|_| "state poisoned")?;
    let s = sessions.get_mut(&id).ok_or("unknown session")?;

    if s.recording.is_some() {
        return Err("already recording".to_string());
    }

    let path = crate::recording::recording_file_path(&app, &safe_id)?;
    let dir = path.parent().ok_or("invalid recording path")?;
    fs::create_dir_all(dir).map_err(|e| format!("create dir failed: {e}"))?;

    let file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| format!("open failed: {e}"))?;

    let mut writer = BufWriter::new(file);
    let recording_name = recording_name
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(120).collect());
    let effect_id = effect_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let bootstrap_command = bootstrap_command
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let meta = crate::recording::RecordingMetaV1 {
        schema_version: 1,
        created_at: now_epoch_ms(),
        name: recording_name,
        project_id,
        session_persist_id,
        cwd,
        effect_id,
        bootstrap_command,
        encrypted: Some(encrypt_enabled),
    };
    let line = crate::recording::RecordingLineV1::Meta(meta);
    let json = serde_json::to_string(&line).map_err(|e| format!("serialize failed: {e}"))?;
    writer
        .write_all(json.as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    writer.write_all(b"\n").map_err(|e| format!("write failed: {e}"))?;
    writer.flush().map_err(|e| format!("flush failed: {e}"))?;

    s.recording = Some(SessionRecording {
        id: safe_id.clone(),
        writer,
        started_at: Instant::now(),
        last_flush: Instant::now(),
        unflushed_bytes: 0,
        input_buffer: String::new(),
        json_buf: Vec::with_capacity(256),
        enc_key,
    });

    Ok(safe_id)
}

#[tauri::command]
pub fn stop_session_recording(state: State<'_, AppState>, id: String) -> Result<Option<String>, String> {
    let mut sessions = state
        .inner
        .sessions
        .lock()
        .map_err(|_| "state poisoned")?;
    let s = sessions.get_mut(&id).ok_or("unknown session")?;

    let mut rec = match s.recording.take() {
        Some(r) => r,
        None => return Ok(None),
    };
    rec.writer.flush().map_err(|e| format!("flush failed: {e}"))?;
    Ok(Some(rec.id))
}

#[tauri::command]
pub fn write_to_session(
    state: State<'_, AppState>,
    id: String,
    data: String,
    source: Option<String>,
) -> Result<(), String> {
    let mut sessions = state
        .inner
        .sessions
        .lock()
        .map_err(|_| "state poisoned")?;
    let s = sessions.get_mut(&id).ok_or("unknown session")?;
    if s.closing {
        return Ok(());
    }

    // Unescape common terminal escape sequences (e.g. \r, \n, \t) that
    // MCP tool callers send as literal backslash-letter pairs.
    let data = unescape_terminal_sequences(&data);

    s.writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    s.writer.flush().ok();

    let is_user = source.as_deref() == Some("user");
    if is_user {
        let mut rec_err: Option<String> = None;
        if let Some(rec) = s.recording.as_mut() {
            if let Err(e) = record_user_input(rec, &data) {
                rec_err = Some(e);
            }
        }
        if let Some(err) = rec_err {
            eprintln!("Failed to write recording event: {err}");
            s.recording = None;
        }
    }
    Ok(())
}

/// Unescape common terminal escape sequences that arrive as literal
/// backslash-letter pairs from MCP tool callers (e.g. `\r` → CR, `\n` → LF).
fn unescape_terminal_sequences(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('r') => out.push('\r'),
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('\\') => out.push('\\'),
                Some('x') => {
                    // Handle \x1b style hex escapes (e.g. for ESC)
                    let h: String = chars.by_ref().take(2).collect();
                    if let Ok(byte) = u8::from_str_radix(&h, 16) {
                        out.push(byte as char);
                    } else {
                        out.push('\\');
                        out.push('x');
                        out.push_str(&h);
                    }
                }
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[tauri::command]
pub fn resize_session(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state
        .inner
        .sessions
        .lock()
        .map_err(|_| "state poisoned")?;
    let s = sessions.get(&id).ok_or("unknown session")?;
    if s.closing {
        return Ok(());
    }
    s.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn rename_session(state: State<'_, AppState>, id: String, name: String) -> Result<(), String> {
    let mut sessions = state
        .inner
        .sessions
        .lock()
        .map_err(|_| "state poisoned")?;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| "Session not found".to_string())?;
    session.name = name;
    Ok(())
}

#[tauri::command]
pub fn close_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut sessions = state
        .inner
        .sessions
        .lock()
        .map_err(|_| "state poisoned")?;
    let Some(session) = sessions.get_mut(&id) else {
        return Ok(());
    };

    if session.closing {
        return Ok(());
    }
    // Flush any buffered recording tail now rather than relying on BufWriter's
    // silent Drop flush when the emitter thread removes the session.
    if let Some(rec) = session.recording.as_mut() {
        let _ = rec.writer.flush();
    }
    session.closing = true;
    let _ = session.child.kill();
    Ok(())
}

/// Best-effort cleanup at app exit: process exit does not run destructors for
/// managed state, so buffered recording tails would be lost and children would
/// only learn of the exit via PTY EOF. Flush every recording and kill children.
pub fn shutdown_flush_all(state: &AppState) {
    let Ok(mut sessions) = state.inner.sessions.lock() else {
        return;
    };
    for session in sessions.values_mut() {
        if let Some(rec) = session.recording.as_mut() {
            let _ = rec.writer.flush();
        }
        session.closing = true;
        let _ = session.child.kill();
    }
}

#[tauri::command]
pub fn detach_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    #[cfg(not(target_family = "unix"))]
    {
        let _ = state;
        let _ = id;
        return Err("detach is only supported on Unix".to_string());
    }

    #[cfg(target_family = "unix")]
    {
        let mut sessions = state
            .inner
            .sessions
            .lock()
            .map_err(|_| "state poisoned")?;
        let Some(s) = sessions.get_mut(&id) else {
            return Ok(());
        };

        // Default zellij detach: Ctrl+o then d.
        s.writer
            .write_all(&[0x0f, b'd'])
            .map_err(|e| format!("write failed: {e}"))?;
        s.writer.flush().ok();
        Ok(())
    }
}
