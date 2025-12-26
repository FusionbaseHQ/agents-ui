use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, State, WebviewWindow};

#[derive(Default)]
struct AppStateInner {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<String, PtySession>>,
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

fn record_user_input(rec: &mut SessionRecording, data: &str) -> Result<(), String> {
    let t = rec.started_at.elapsed().as_millis() as u64;
    let line = crate::recording::RecordingLineV1::Input(crate::recording::RecordingEventV1 {
        t,
        data: data.to_string(),
    });
    let json = serde_json::to_string(&line).map_err(|e| format!("serialize failed: {e}"))?;
    rec.writer
        .write_all(json.as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    rec.writer.write_all(b"\n").map_err(|e| format!("write failed: {e}"))?;
    rec.unflushed_bytes += json.len() + 1;

    let should_flush = data.contains('\n')
        || data.contains('\r')
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
fn ensure_nu_config(window: &WebviewWindow) -> Option<(String, String, String)> {
    let app_data = window.app_handle().path().app_data_dir().ok()?;
    let config_home = app_data.join("shell").join("xdg-config");
    let data_home = app_data.join("shell").join("xdg-data");
    let cache_home = app_data.join("shell").join("xdg-cache");

    let nu_config_dir = config_home.join("nushell");
    let nu_data_dir = data_home.join("nushell");
    let nu_cache_dir = cache_home.join("nushell");

    fs::create_dir_all(&nu_config_dir).ok()?;
    fs::create_dir_all(&nu_data_dir).ok()?;
    fs::create_dir_all(&nu_cache_dir).ok()?;

    let config_path = nu_config_dir.join("config.nu");
    let config = r#"# Agents UI managed Nushell config

$env.config = ($env.config | upsert show_banner false)

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
  $osc + (ansi cyan) + $dir + (ansi reset) + " "
}

$env.PROMPT_INDICATOR = {|| "❯ " }
$env.PROMPT_MULTILINE_INDICATOR = {|| "… " }
"#;

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
) -> Result<SessionInfo, String> {
    #[cfg(target_family = "unix")]
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    #[cfg(not(target_family = "unix"))]
    let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());

    let command = command.unwrap_or_default().trim().to_string();
    let is_shell = command.is_empty();

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
    let (program, args, shown_command, use_nu) = if is_shell {
        if let Some(nu) = find_bundled_nu() {
            (
                nu.to_string_lossy().to_string(),
                Vec::new(),
                "nu".to_string(),
                true,
            )
        } else {
            (shell.clone(), vec!["-l".to_string()], format!("{shell} -l"), false)
        }
    } else {
        (
            shell.clone(),
            vec!["-lc".to_string(), command.clone()],
            format!("{shell} -lc {command}"),
            false,
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
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    #[cfg(target_os = "macos")]
    {
        let mut path_entries: Vec<String> = std::env::var("PATH")
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
            if Path::new(candidate).is_dir() && !path_entries.iter().any(|p| p == candidate) {
                path_entries.insert(0, candidate.to_string());
            }
        }

        if !path_entries.is_empty() {
            cmd.env("PATH", path_entries.join(":"));
        }
    }

    #[cfg(target_family = "unix")]
    if use_nu {
        if let Some((xdg_config_home, xdg_data_home, xdg_cache_home)) = ensure_nu_config(&window) {
            cmd.env("XDG_CONFIG_HOME", xdg_config_home);
            cmd.env("XDG_DATA_HOME", xdg_data_home);
            cmd.env("XDG_CACHE_HOME", xdg_cache_home);
        }
    }
    if let Some(ref cwd) = cwd {
        cmd.cwd(cwd);
    }

    #[cfg(target_family = "unix")]
    {
        let shell_name = Path::new(&shell)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        if is_shell && shell_name.contains("bash") {
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

        if is_shell && shell_name.contains("zsh") {
            let orig_dotdir = std::env::var("ZDOTDIR")
                .ok()
                .filter(|s| Path::new(s).is_dir())
                .or_else(|| std::env::var("HOME").ok().filter(|s| Path::new(s).is_dir()));

            if let Some(orig_dotdir) = orig_dotdir {
                let temp_dir: PathBuf = std::env::temp_dir().join(format!("agents-ui-zdotdir-{id}"));
                if fs::create_dir_all(&temp_dir).is_ok()
                    && write_zsh_startup_files(&temp_dir, Path::new(&orig_dotdir)).is_ok()
                {
                    cmd.env("ZDOTDIR", temp_dir.to_string_lossy().to_string());
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
    project_id: String,
    session_persist_id: String,
    cwd: Option<String>,
) -> Result<String, String> {
    let safe_id = crate::recording::sanitize_recording_id(&recording_id);

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
    let meta = crate::recording::RecordingMetaV1 {
        schema_version: 1,
        created_at: now_epoch_ms(),
        project_id,
        session_persist_id,
        cwd,
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
