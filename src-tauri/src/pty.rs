use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, State, WebviewWindow};

const AGENTS_UI_ZELLIJ_PREFIX: &str = "agents-ui-";
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
}

#[derive(Clone, Default)]
pub struct AppState {
    inner: Arc<AppStateInner>,
}

struct PtySession {
    name: String,
    command: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send>,
    recording: Option<SessionRecording>,
}

struct SessionRecording {
    id: String,
    writer: BufWriter<std::fs::File>,
    started_at: Instant,
    last_flush: Instant,
    unflushed_bytes: usize,
    input_buffer: String,
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
    id: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct PtyExit {
    id: String,
    exit_code: Option<u32>,
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

#[cfg(target_os = "macos")]
fn login_shell_path(shell: &str, base_path: &str) -> Option<String> {
    let shell_name = Path::new(shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if !shell_name.contains("zsh") && !shell_name.contains("bash") {
        return None;
    }

    const START: &str = "__AGENTS_UI_PATH_START__";
    const END: &str = "__AGENTS_UI_PATH_END__";
    let script = format!("printf '{START}%s{END}' \"$PATH\"");

    let out = Command::new(shell)
        .args(["-i", "-l", "-c", script.as_str()])
        .env("PATH", base_path)
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&out.stdout);
    let start = stdout.find(START)?;
    let rest = &stdout[start + START.len()..];
    let end = rest.find(END)?;
    let path = rest[..end].trim();
    if path.is_empty() {
        return None;
    }
    Some(path.to_string())
}

#[cfg(target_family = "unix")]
struct ShellXdgPaths {
    config_home: PathBuf,
    data_home: PathBuf,
    cache_home: PathBuf,
    runtime_dir: PathBuf,
}

#[cfg(target_family = "unix")]
fn ensure_shell_xdg_paths(window: &WebviewWindow) -> Option<ShellXdgPaths> {
    let app_data = window.app_handle().path().app_data_dir().ok()?;
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
fn ensure_preferred_zellij_socket_dir(window: &WebviewWindow) -> Option<PathBuf> {
    let home = window.app_handle().path().home_dir().ok()?;
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
fn ensure_zellij_paths(window: &WebviewWindow) -> Option<ZellijPaths> {
    let app_data = window.app_handle().path().app_data_dir().ok()?;
    let base = app_data.join("zellij");
    fs::create_dir_all(&base).ok()?;

    // Store sockets in a stable per-user path so sessions survive app restarts without relying on /tmp.
    // Fallback to the legacy /tmp dir if we cannot create the preferred location (or in older installs).
    let socket_dir =
        ensure_preferred_zellij_socket_dir(window).or_else(|| ensure_legacy_zellij_socket_dir())?;

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
    let out = Command::new(zellij)
        .args(["list-sessions", "--short", "--no-formatting"])
        .env("HOME", zellij_home.to_string_lossy().to_string())
        .env("ZELLIJ_SOCKET_DIR", socket_dir.to_string_lossy().to_string())
        .output()
        .map_err(|e| format!("failed to run bundled zellij: {e}"))?;

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
fn ensure_zellij_config(window: &WebviewWindow) -> Option<PathBuf> {
    let zellij_paths = ensure_zellij_paths(window)?;
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
fn ensure_zellij_shell_wrapper(window: &WebviewWindow) -> Option<PathBuf> {
    let app_data = window.app_handle().path().app_data_dir().ok()?;
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
fn zsh_zdotdir_path(window: &WebviewWindow, key: &str) -> Option<PathBuf> {
    let app_data = window.app_handle().path().app_data_dir().ok()?;
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
pub fn list_persistent_sessions(window: WebviewWindow) -> Result<Vec<PersistentSessionInfo>, String> {
    #[cfg(not(target_family = "unix"))]
    {
        return Err("persistent sessions are only supported on Unix".to_string());
    }

    #[cfg(target_family = "unix")]
    {
        let zellij = find_bundled_zellij().ok_or("bundled zellij missing in this build".to_string())?;
        let zellij_paths = ensure_zellij_paths(&window).ok_or("unable to determine app data dir".to_string())?;
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
pub fn kill_persistent_session(window: WebviewWindow, persist_id: String) -> Result<(), String> {
    #[cfg(not(target_family = "unix"))]
    {
        return Err("persistent sessions are only supported on Unix".to_string());
    }

    #[cfg(target_family = "unix")]
    {
        let zellij = find_bundled_zellij().ok_or("bundled zellij missing in this build".to_string())?;
        let zellij_paths = ensure_zellij_paths(&window).ok_or("unable to determine app data dir".to_string())?;
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
    let json = serde_json::to_string(&line).map_err(|e| format!("serialize failed: {e}"))?;
    rec.writer
        .write_all(json.as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    rec.writer
        .write_all(b"\n")
        .map_err(|e| format!("write failed: {e}"))?;
    rec.unflushed_bytes += json.len() + 1;
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
        rec.writer.flush().ok();
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
    carry.extend_from_slice(chunk);

    let mut out = String::new();
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
                        out.push('�');
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

#[cfg(target_family = "unix")]
fn ensure_nu_config(window: &WebviewWindow, env_keys: &[String]) -> Option<(String, String, String, String)> {
    let xdg = ensure_shell_xdg_paths(window)?;
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
        r#"$env.config = ($env.config | upsert hooks.pre_execution [
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
  $osc + (ansi cyan) + $dir + (ansi reset) + " "
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
    window: WebviewWindow,
    state: State<'_, AppState>,
    name: Option<String>,
    command: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    env_vars: Option<HashMap<String, String>>,
    persistent: Option<bool>,
    persist_id: Option<String>,
) -> Result<SessionInfo, String> {
    #[cfg(target_family = "unix")]
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    #[cfg(not(target_family = "unix"))]
    let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());

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
        let zellij_config = ensure_zellij_config(&window).map(|p| p.to_string_lossy().to_string());
        let zellij_paths = ensure_zellij_paths(&window).ok_or("unable to determine app data dir".to_string())?;

        let nu = find_bundled_nu();
        let inner_shell = if let Some(nu) = &nu {
            nu.to_string_lossy().to_string()
        } else {
            shell.clone()
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
            nu.is_some(),
            inner_shell,
        )
    } else if is_shell {
        if let Some(nu) = find_bundled_nu() {
            (
                nu.to_string_lossy().to_string(),
                Vec::new(),
                "nu".to_string(),
                true,
                shell.clone(),
            )
        } else {
            (
                shell.clone(),
                vec!["-l".to_string()],
                format!("{shell} -l"),
                false,
                shell.clone(),
            )
        }
    } else {
        (
            shell.clone(),
            vec!["-lc".to_string(), command.clone()],
            format!("{shell} -lc {command}"),
            false,
            shell.clone(),
        )
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
    #[cfg(target_family = "unix")]
    if persistent {
        if let Some((zellij_home, zellij_socket_dir)) = persistent_zellij_env.as_ref() {
            cmd.env("HOME", zellij_home.clone());
            cmd.env("ZELLIJ_SOCKET_DIR", zellij_socket_dir.clone());
        } else if let Some(zellij_paths) = ensure_zellij_paths(&window) {
            cmd.env("HOME", zellij_paths.home_dir.to_string_lossy().to_string());
            cmd.env("ZELLIJ_SOCKET_DIR", zellij_paths.socket_dir.to_string_lossy().to_string());
        }

        if let Some(wrapper) = ensure_zellij_shell_wrapper(&window) {
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
        if cmd.get_env("PATH").is_none() {
            let mut fallback_entries: Vec<String> = std::env::var("PATH")
                .unwrap_or_default()
                .split(':')
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string())
                .collect();

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

            let fallback_path = fallback_entries.join(":");
            let imported_path = if use_nu {
                if let Ok(mut cache) = state.inner.login_path_cache.lock() {
                    if cache.initialized && cache.shell.as_deref() == Some(shell.as_str()) {
                        cache.path.clone()
                    } else {
                        let computed = login_shell_path(&shell, &fallback_path);
                        cache.initialized = true;
                        cache.shell = Some(shell.clone());
                        cache.path = computed.clone();
                        computed
                    }
                } else {
                    login_shell_path(&shell, &fallback_path)
                }
            } else {
                None
            };

            let base_path = imported_path.unwrap_or(fallback_path);
            let mut path_entries: Vec<String> = base_path
                .split(':')
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string())
                .collect();

            for candidate in [
                "/opt/homebrew/bin",
                "/opt/homebrew/sbin",
                "/usr/local/bin",
                "/usr/local/sbin",
            ] {
                if Path::new(candidate).is_dir() && !path_entries.iter().any(|p| p == candidate) {
                    path_entries.insert(0, candidate.to_string());
                }
            }

            if !path_entries.is_empty() {
                cmd.env("PATH", path_entries.join(":"));
            }
        }
    }

    #[cfg(target_family = "unix")]
    if use_nu {
        if let Some((xdg_config_home, xdg_data_home, xdg_cache_home, xdg_runtime_dir)) =
            ensure_nu_config(&window, &env_keys)
        {
            cmd.env("XDG_CONFIG_HOME", xdg_config_home);
            cmd.env("XDG_DATA_HOME", xdg_data_home);
            cmd.env("XDG_CACHE_HOME", xdg_cache_home);
            cmd.env("XDG_RUNTIME_DIR", xdg_runtime_dir);
        }
    } else if persistent {
        if let Some(xdg) = ensure_shell_xdg_paths(&window) {
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
                        .and_then(|pid| zsh_zdotdir_path(&window, pid))
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
        },
    );
    drop(sessions);

    let id_for_thread = id.clone();
    let state_for_thread = state.inner().clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut utf8_carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = decode_utf8_stream(&mut utf8_carry, &buf[..n]);
                    if !data.is_empty() {
                        let _ = window.emit(
                            "pty-output",
                            PtyOutput {
                                id: id_for_thread.clone(),
                                data,
                            },
                        );
                    }
                }
                Err(_) => break,
            }
        }

        if !utf8_carry.is_empty() {
            let data = String::from_utf8_lossy(&utf8_carry).to_string();
            if !data.is_empty() {
                let _ = window.emit(
                    "pty-output",
                    PtyOutput {
                        id: id_for_thread.clone(),
                        data,
                    },
                );
            }
        }

        let session = match state_for_thread.inner.sessions.lock() {
            Ok(mut sessions) => sessions.remove(&id_for_thread),
            Err(_) => None,
        };

        let exit_code = session
            .and_then(|mut s| s.child.wait().ok().map(|status| status.exit_code()));

        let _ = window.emit(
            "pty-exit",
            PtyExit {
                id: id_for_thread,
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
    window: WebviewWindow,
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
        Some(crate::secure::get_or_create_master_key(&window)?)
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

    let path = crate::recording::recording_file_path(&window, &safe_id)?;
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
    writer.flush().ok();

    s.recording = Some(SessionRecording {
        id: safe_id.clone(),
        writer,
        started_at: Instant::now(),
        last_flush: Instant::now(),
        unflushed_bytes: 0,
        input_buffer: String::new(),
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
    rec.writer.flush().ok();
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
pub fn close_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let session = {
        let mut sessions = state
            .inner
            .sessions
            .lock()
            .map_err(|_| "state poisoned")?;
        sessions.remove(&id)
    };

    let Some(session) = session else {
        return Ok(());
    };

    let PtySession { mut child, .. } = session;

    let _ = child.kill();
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
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
