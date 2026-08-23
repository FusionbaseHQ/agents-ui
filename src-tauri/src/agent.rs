use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

const DEFAULT_CODEX_MODEL: &str = "gpt-5.6-sol";
const MCP_CONFIG_FILE_NAME: &str = "mcp-config.json";
static NEXT_MCP_CONFIG_STAGE: AtomicU64 = AtomicU64::new(1);

fn validated_shell_path(shell: &str) -> Option<String> {
    let path = std::path::Path::new(shell);
    if !path.is_absolute() {
        return None;
    }
    #[cfg(target_family = "unix")]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    };
    #[cfg(not(target_family = "unix"))]
    let executable = path.is_file();
    executable.then(|| shell.to_string())
}

/// Get the user's default login shell, same logic as pty.rs.
fn default_user_shell() -> String {
    if let Ok(shell) = std::env::var("SHELL") {
        if let Some(shell) = validated_shell_path(&shell) {
            return shell;
        }
    }
    #[cfg(target_os = "macos")]
    { return "/bin/zsh".to_string(); }
    #[cfg(not(target_os = "macos"))]
    {
        if std::path::Path::new("/bin/bash").is_file() {
            return "/bin/bash".to_string();
        }
        "/bin/sh".to_string()
    }
}

/// Shell-escape a single argument for use inside a shell -c string.
fn shell_escape(s: &str) -> String {
    if s.is_empty() {
        return "''".to_string();
    }
    // If the string is safe, return as-is
    if s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'/' || b == b'.' || b == b':' || b == b'=' || b == b',') {
        return s.to_string();
    }
    // Wrap in single quotes, escaping embedded single quotes
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn append_shell_escaped_args(parts: &mut Vec<String>, args: Vec<String>) {
    parts.extend(args.into_iter().map(|argument| shell_escape(&argument)));
}

fn path_to_utf8<'a>(path: &'a std::path::Path, context: &str) -> Result<&'a str, String> {
    path.to_str()
        .ok_or_else(|| format!("{context} is not valid UTF-8"))
}

/// Tracks running agent processes by run_id.
pub struct AgentState {
    running: Arc<Mutex<HashMap<String, tokio::process::Child>>>,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            running: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLaunchSettings {
    pub provider: Option<String>,
    pub allowed_tools: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
}

impl Default for AgentLaunchSettings {
    fn default() -> Self {
        Self {
            provider: Some("claude-code".to_string()),
            allowed_tools: None,
            model: None,
            effort: None,
        }
    }
}

#[cfg(target_family = "unix")]
fn effective_user_id() -> u32 {
    // SAFETY: geteuid has no preconditions and does not dereference pointers.
    unsafe { libc::geteuid() }
}

#[cfg(target_family = "unix")]
fn ensure_private_agents_ui_directory_for_uid(
    dir: &std::path::Path,
    expected_uid: u32,
) -> Result<(), String> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};

    let mut builder = std::fs::DirBuilder::new();
    builder.mode(0o700);
    match builder.create(dir) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(format!("create agent data directory failed: {error}")),
    }

    let metadata = std::fs::symlink_metadata(dir)
        .map_err(|error| format!("inspect agent data directory failed: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("agent data directory must not be a symbolic link".to_string());
    }
    if !metadata.is_dir() {
        return Err("agent data path is not a directory".to_string());
    }
    if metadata.uid() != expected_uid {
        return Err("agent data directory is not owned by the effective user".to_string());
    }
    if metadata.permissions().mode() & 0o777 != 0o700 {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("restrict agent data directory failed: {error}"))?;
    }

    let metadata = std::fs::symlink_metadata(dir)
        .map_err(|error| format!("verify agent data directory failed: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("agent data directory changed while it was being secured".to_string());
    }
    if metadata.uid() != expected_uid {
        return Err("agent data directory owner changed while it was being secured".to_string());
    }
    if metadata.permissions().mode() & 0o777 != 0o700 {
        return Err("agent data directory permissions are not 0700".to_string());
    }
    Ok(())
}

#[cfg(target_family = "unix")]
fn ensure_private_agents_ui_directory(dir: &std::path::Path) -> Result<(), String> {
    ensure_private_agents_ui_directory_for_uid(dir, effective_user_id())
}

#[cfg(not(target_family = "unix"))]
fn ensure_private_agents_ui_directory(dir: &std::path::Path) -> Result<(), String> {
    match std::fs::create_dir(dir) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(format!("create agent data directory failed: {error}")),
    }
    let metadata = std::fs::symlink_metadata(dir)
        .map_err(|error| format!("inspect agent data directory failed: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("agent data path is not a real directory".to_string());
    }
    Ok(())
}

struct McpConfigStage {
    path: std::path::PathBuf,
    armed: bool,
}

impl McpConfigStage {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for McpConfigStage {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn mcp_config_stage_path(dir: &std::path::Path, id: u64) -> std::path::PathBuf {
    dir.join(format!(
        ".mcp-config.json.stage-{}-{id:x}",
        std::process::id()
    ))
}

fn create_mcp_config_stage_with_ids(
    dir: &std::path::Path,
    mut next_id: impl FnMut() -> u64,
) -> Result<(McpConfigStage, std::fs::File), String> {
    const MAX_ATTEMPTS: usize = 128;
    for _ in 0..MAX_ATTEMPTS {
        let path = mcp_config_stage_path(dir, next_id());
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(target_family = "unix")]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(file) => {
                let stage = McpConfigStage { path, armed: true };
                #[cfg(target_family = "unix")]
                {
                    use std::os::unix::fs::{MetadataExt, PermissionsExt};
                    if let Err(error) = file.set_permissions(std::fs::Permissions::from_mode(0o600))
                    {
                        drop(file);
                        drop(stage);
                        return Err(format!("restrict MCP config stage failed: {error}"));
                    }
                    let metadata = match file.metadata() {
                        Ok(metadata) => metadata,
                        Err(error) => {
                            drop(file);
                            drop(stage);
                            return Err(format!("inspect MCP config stage failed: {error}"));
                        }
                    };
                    if metadata.uid() != effective_user_id()
                        || metadata.permissions().mode() & 0o777 != 0o600
                    {
                        drop(file);
                        drop(stage);
                        return Err("MCP config staging file is not private".to_string());
                    }
                }
                return Ok((stage, file));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("create MCP config stage failed: {error}")),
        }
    }
    Err("could not allocate a unique MCP config staging file".to_string())
}

fn create_mcp_config_stage(
    dir: &std::path::Path,
) -> Result<(McpConfigStage, std::fs::File), String> {
    create_mcp_config_stage_with_ids(dir, || {
        NEXT_MCP_CONFIG_STAGE.fetch_add(1, Ordering::Relaxed)
    })
}

#[cfg(target_family = "windows")]
fn replace_file_atomically(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> std::io::Result<()> {
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
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(target_family = "windows"))]
fn replace_file_atomically(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

#[cfg(target_family = "unix")]
fn verify_private_mcp_config(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("inspect published MCP config failed: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("published MCP config is not a regular file".to_string());
    }
    if metadata.uid() != effective_user_id() {
        return Err("published MCP config is not owned by the effective user".to_string());
    }
    if metadata.permissions().mode() & 0o777 != 0o600 {
        return Err("published MCP config permissions are not 0600".to_string());
    }
    Ok(())
}

#[cfg(not(target_family = "unix"))]
fn verify_private_mcp_config(path: &std::path::Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("inspect published MCP config failed: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("published MCP config is not a regular file".to_string());
    }
    Ok(())
}

fn write_private_mcp_config_with_publish_and_sync(
    dir: &std::path::Path,
    path: &std::path::Path,
    contents: &[u8],
    publish: impl FnOnce(&std::path::Path, &std::path::Path) -> std::io::Result<()>,
    sync_directory: impl FnOnce(&std::path::Path) -> std::io::Result<()>,
) -> Result<(), String> {
    let (mut stage, mut file) = create_mcp_config_stage(dir)?;
    let write_result = file
        .write_all(contents)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("write MCP config stage failed: {error}"));
    drop(file);
    write_result?;

    publish(&stage.path, path).map_err(|error| format!("publish MCP config failed: {error}"))?;
    stage.disarm();
    verify_private_mcp_config(path)?;
    // Publication already committed the private 0600 file. Network, FUSE, and
    // FileProvider directories may reject directory fsync; reporting failure
    // here would be false and could trigger retries after a successful rename.
    let _ = sync_directory(dir);
    Ok(())
}

fn write_private_mcp_config_with_publish(
    dir: &std::path::Path,
    path: &std::path::Path,
    contents: &[u8],
    publish: impl FnOnce(&std::path::Path, &std::path::Path) -> std::io::Result<()>,
) -> Result<(), String> {
    write_private_mcp_config_with_publish_and_sync(
        dir,
        path,
        contents,
        publish,
        |directory| {
            #[cfg(target_family = "unix")]
            {
                return std::fs::File::open(directory)
                    .and_then(|handle| handle.sync_all());
            }
            #[cfg(not(target_family = "unix"))]
            {
                let _ = directory;
                Ok(())
            }
        },
    )
}

fn serialize_mcp_config(port: u16, token: &str) -> Result<Vec<u8>, String> {
    let config = serde_json::json!({
        "mcpServers": {
            "agents-ui": {
                "type": "http",
                "url": format!("http://127.0.0.1:{port}/mcp"),
                "headers": {
                    "Authorization": format!("Bearer {token}")
                }
            }
        }
    });
    serde_json::to_vec_pretty(&config).map_err(|error| format!("serialize: {error}"))
}

fn write_mcp_config_in_directory(
    dir: &std::path::Path,
    port: u16,
    token: &str,
) -> Result<std::path::PathBuf, String> {
    ensure_private_agents_ui_directory(dir)?;
    let path = dir.join(MCP_CONFIG_FILE_NAME);
    let json = serialize_mcp_config(port, token)?;
    write_private_mcp_config_with_publish(dir, &path, &json, replace_file_atomically)?;
    Ok(path)
}

/// Write the MCP config file that agents use to connect to our MCP server.
#[tauri::command]
pub async fn write_agent_mcp_config(mcp_port: Option<u16>) -> Result<String, String> {
    let port = mcp_port.unwrap_or(45557);
    let token = crate::mcp_server::get_or_init_auth_token();
    let dir = agents_ui_dir()?;
    let path = write_mcp_config_in_directory(&dir, port, &token)?;
    Ok(path_to_utf8(&path, "agent MCP path")?.to_string())
}

/// Build command parts for Claude Code CLI.
fn build_claude_cmd(
    prompt: &str,
    session_id: Option<&str>,
    settings: &AgentLaunchSettings,
    mcp_config_path: &std::path::Path,
) -> Result<Vec<String>, String> {
    let system_prompt = include_str!("agent_system_prompt.txt");

    let mut parts: Vec<String> = vec![
        "claude".into(),
        "-p".into(),
        shell_escape(prompt),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--include-partial-messages".into(),
        "--mcp-config".into(),
        shell_escape(path_to_utf8(mcp_config_path, "agent MCP path")?),
    ];

    if let Some(sid) = session_id {
        parts.push("--resume".into());
        parts.push(shell_escape(sid));
    }

    // Always pre-approve our MCP tools so Claude Code doesn't prompt for permission.
    let default_tools = "mcp__agents-ui__*";
    let tools_value = match settings.allowed_tools.as_deref() {
        Some(extra) if !extra.is_empty() => format!("{default_tools},{extra}"),
        _ => default_tools.to_string(),
    };
    parts.push("--allowedTools".into());
    parts.push(shell_escape(&tools_value));

    if let Some(ref model) = settings.model {
        parts.push("--model".into());
        parts.push(shell_escape(model));
    }

    if let Some(ref effort) = settings.effort {
        parts.push("--effort".into());
        parts.push(shell_escape(effort));
    }

    parts.push("--append-system-prompt".into());
    parts.push(shell_escape(system_prompt));

    Ok(parts)
}

/// Build command parts for Codex CLI.
fn build_codex_cmd(
    prompt: &str,
    session_id: Option<&str>,
    settings: &AgentLaunchSettings,
) -> Result<Vec<String>, String> {
    let system_prompt = include_str!("agent_system_prompt.txt");

    // Write system prompt to instructions file for Codex
    let instructions_path = agents_ui_dir()?.join("codex-instructions.md");
    std::fs::write(&instructions_path, system_prompt)
        .map_err(|e| format!("write instructions: {e}"))?;

    let mut parts: Vec<String> = vec!["codex".into(), "exec".into()];

    // -m is a subcommand flag for `codex exec`, must come before the prompt.
    let model = settings
        .model
        .as_deref()
        .filter(|model| !model.trim().is_empty())
        .unwrap_or(DEFAULT_CODEX_MODEL);
    parts.push("-m".into());
    parts.push(shell_escape(model));

    // Resume uses: codex exec resume <sessionId> <prompt>
    if let Some(sid) = session_id {
        parts.push("resume".into());
        parts.push(shell_escape(sid));
    }

    parts.push(shell_escape(prompt));
    parts.push("--json".into());
    parts.push("--full-auto".into());

    parts.push("-c".into());
    parts.push(format!(
        "instructions_file={}",
        shell_escape(path_to_utf8(&instructions_path, "Codex instructions path")?)
    ));

    Ok(parts)
}

/// Ensure the MCP server is registered with Codex before launching.
#[allow(dead_code)]
fn ensure_codex_mcp_registered(mcp_port: u16) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{mcp_port}/mcp");
    let shell = default_user_shell();

    // Remove first (ignore errors if not registered), then add
    let _ = std::process::Command::new(&shell)
        .arg("-lc")
        .arg("codex mcp remove agents-ui")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();

    let status = std::process::Command::new(&shell)
        .arg("-lc")
        .arg(format!("codex mcp add agents-ui --url {}", shell_escape(&url)))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .status()
        .map_err(|e| format!("failed to register MCP server with codex: {e}"))?;

    if !status.success() {
        // Non-fatal — Codex may still work if already registered
        eprintln!("Warning: codex mcp add returned non-zero exit code");
    }

    Ok(())
}

/// Spawn a headless agent process and stream NDJSON output via Tauri events.
#[tauri::command]
pub async fn start_agent_prompt(
    app: tauri::AppHandle,
    state: tauri::State<'_, AgentState>,
    prompt: String,
    session_id: Option<String>,
    settings: Option<AgentLaunchSettings>,
) -> Result<String, String> {
    let settings = settings.unwrap_or_default();
    let run_id = generate_run_id();

    let mcp_config_path = agents_ui_dir()?.join("mcp-config.json");
    if !mcp_config_path.exists() {
        write_agent_mcp_config(None).await?;
    }

    let binary = match settings.provider.as_deref() {
        Some("codex") => "codex",
        _ => "claude",
    };

    // Build provider-specific command parts
    let cmd_parts = if binary == "codex" {
        build_codex_cmd(&prompt, session_id.as_deref(), &settings)?
    } else {
        build_claude_cmd(&prompt, session_id.as_deref(), &settings, &mcp_config_path)?
    };

    let shell_command = cmd_parts.join(" ");
    let shell = default_user_shell();

    let mut child = Command::new(&shell)
        .arg("-lc")
        .arg(&shell_command)
        .env(
            crate::mcp_server::MCP_TOKEN_ENV_VAR,
            crate::mcp_server::get_or_init_auth_token(),
        )
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            format!("Failed to spawn `{binary}` via {shell}: {e}. Is `{binary}` installed?")
        })?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    // Store child handle
    let running = state.running.clone();
    running.lock().await.insert(run_id.clone(), child);

    // Spawn stdout reader
    let app_out = app.clone();
    let rid_out = run_id.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim().to_string();
            if !line.is_empty() {
                let _ = app_out.emit(
                    "agent-output",
                    serde_json::json!({ "runId": rid_out, "data": line }),
                );
            }
        }
    });

    // Spawn stderr reader
    let app_err = app.clone();
    let rid_err = run_id.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim().to_string();
            if !line.is_empty() {
                let _ = app_err.emit(
                    "agent-stderr",
                    serde_json::json!({ "runId": rid_err, "data": line }),
                );
            }
        }
    });

    // Spawn waiter — polls until process exits, then emits agent-done
    let app_done = app.clone();
    let rid_done = run_id.clone();
    let running_done = running.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            let mut map = running_done.lock().await;
            if let Some(child) = map.get_mut(&rid_done) {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        map.remove(&rid_done);
                        let _ = app_done.emit(
                            "agent-done",
                            serde_json::json!({
                                "runId": rid_done,
                                "exitCode": status.code()
                            }),
                        );
                        return;
                    }
                    Ok(None) => {}
                    Err(_) => {
                        map.remove(&rid_done);
                        let _ = app_done.emit(
                            "agent-done",
                            serde_json::json!({ "runId": rid_done, "exitCode": null }),
                        );
                        return;
                    }
                }
            } else {
                let _ = app_done.emit(
                    "agent-done",
                    serde_json::json!({ "runId": rid_done, "exitCode": null }),
                );
                return;
            }
        }
    });

    Ok(run_id)
}

/// Kill a running agent process.
#[tauri::command]
pub async fn stop_agent(
    state: tauri::State<'_, AgentState>,
    run_id: String,
) -> Result<(), String> {
    let mut map = state.running.lock().await;
    if let Some(mut child) = map.remove(&run_id) {
        let _ = child.kill().await;
    }
    Ok(())
}

/// Return the command string for launching an agent in a PTY terminal.
/// The frontend will pass this to create_session.
#[tauri::command]
pub async fn get_agent_terminal_command(
    provider: Option<String>,
    extra_args: Option<Vec<String>>,
) -> Result<String, String> {
    let binary = match provider.as_deref() {
        Some("codex") => "codex",
        _ => "claude",
    };

    let mcp_config_path = agents_ui_dir()?.join("mcp-config.json");
    if !mcp_config_path.exists() {
        write_agent_mcp_config(None).await?;
    }

    let mut parts = vec![binary.to_string()];
    let has_explicit_model = extra_args
        .as_ref()
        .is_some_and(|args| args.iter().any(|arg| arg == "--model" || arg == "-m"));

    if binary == "codex" {
        // Codex uses its own global MCP registry (registered at MCP server startup)
        if !has_explicit_model {
            parts.push("--model".into());
            parts.push(DEFAULT_CODEX_MODEL.into());
        }
    } else {
        parts.push("--mcp-config".into());
        parts.push(shell_escape(path_to_utf8(
            &mcp_config_path,
            "agent MCP path",
        )?));
    }

    if let Some(args) = extra_args {
        append_shell_escaped_args(&mut parts, args);
    }

    Ok(parts.join(" "))
}

fn agents_ui_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "cannot determine home directory".to_string())?;
    Ok(std::path::PathBuf::from(home).join(".agents-ui"))
}

/// Read the MCP port from the existing config file.
#[allow(dead_code)]
fn read_mcp_port_from_config(path: &std::path::Path) -> Option<u16> {
    let content = std::fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let url = json.get("mcpServers")?.get("agents-ui")?.get("url")?.as_str()?;
    // URL format: http://127.0.0.1:<port>/mcp
    let port_str = url.strip_prefix("http://127.0.0.1:")?.strip_suffix("/mcp")?;
    port_str.parse().ok()
}

fn generate_run_id() -> String {
    use rand_core::{OsRng, RngCore};
    let mut bytes = [0u8; 8];
    OsRng.fill_bytes(&mut bytes);
    format!(
        "agent-{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}

// ── MCP registration with agent CLIs ────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRegistrationResult {
    pub mcp_config_ok: bool,
    pub claude_code: RegistrationStatus,
    pub codex: RegistrationStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationStatus {
    pub success: bool,
    pub error: Option<String>,
}

/// Register the MCP server with both Claude Code and Codex CLIs.
/// Writes the mcp-config.json with the actual port, then runs CLI commands
/// in parallel with a 10-second timeout per provider.
pub fn do_register_mcp_with_agents(port: u16, token: &str) -> McpRegistrationResult {
    // Step 1: Write mcp-config.json with the actual port
    let mcp_config_ok = match write_mcp_config_sync(port, token) {
        Ok(_) => true,
        Err(e) => {
            eprintln!("[mcp-reg] failed to write mcp-config.json: {e}");
            false
        }
    };

    let url = format!("http://127.0.0.1:{port}/mcp");
    let shell = default_user_shell();
    let timeout = std::time::Duration::from_secs(10);

    // Step 2: Register with Claude Code and Codex in parallel
    let url_cc = url.clone();
    let shell_cc = shell.clone();
    let token_cc = token.to_string();
    let cc_handle = std::thread::spawn(move || {
        register_claude_code(&shell_cc, &url_cc, &token_cc, timeout)
    });

    let url_cx = url.clone();
    let shell_cx = shell.clone();
    let token_cx = token.to_string();
    let cx_handle = std::thread::spawn(move || {
        register_codex(&shell_cx, &url_cx, &token_cx, timeout)
    });

    let claude_code = cc_handle.join().unwrap_or(RegistrationStatus {
        success: false,
        error: Some("thread panicked".into()),
    });

    let codex = cx_handle.join().unwrap_or(RegistrationStatus {
        success: false,
        error: Some("thread panicked".into()),
    });

    McpRegistrationResult {
        mcp_config_ok,
        claude_code,
        codex,
    }
}

fn write_mcp_config_sync(port: u16, token: &str) -> Result<(), String> {
    let dir = agents_ui_dir()?;
    write_mcp_config_in_directory(&dir, port, token)?;
    Ok(())
}

fn register_claude_code(
    shell: &str,
    url: &str,
    token: &str,
    timeout: std::time::Duration,
) -> RegistrationStatus {
    // Remove first, ignore errors
    let _ = run_with_timeout(
        shell,
        "claude mcp remove agents-ui -s user",
        timeout,
    );

    let add_cmd = format!(
        "claude mcp add --transport http -s user agents-ui {} --header {}",
        shell_escape(url),
        shell_escape(&format!("Authorization: Bearer {token}"))
    );

    match run_with_timeout(shell, &add_cmd, timeout) {
        Ok(output) => parse_cli_output(output),
        Err(e) => RegistrationStatus {
            success: false,
            error: Some(e),
        },
    }
}

fn register_codex(
    shell: &str,
    url: &str,
    token: &str,
    timeout: std::time::Duration,
) -> RegistrationStatus {
    // Remove first, ignore errors
    let _ = run_with_timeout(shell, "codex mcp remove agents-ui", timeout);

    // Codex reads the bearer token from an env var at connect time. The app
    // injects MCP_TOKEN_ENV_VAR into its PTY sessions and agent processes, so
    // codex launched from inside the app authenticates transparently.
    let _ = token;
    let add_cmd = format!(
        "codex mcp add agents-ui --url {} --bearer-token-env-var {}",
        shell_escape(url),
        shell_escape(crate::mcp_server::MCP_TOKEN_ENV_VAR)
    );

    match run_with_timeout(shell, &add_cmd, timeout) {
        Ok(output) => {
            let status = parse_cli_output(output);
            if let Some(err) = &status.error {
                let lower = err.to_ascii_lowercase();
                if lower.contains("unexpected argument") || lower.contains("unrecognized") {
                    return RegistrationStatus {
                        success: false,
                        error: Some(
                            "codex CLI does not support --bearer-token-env-var; upgrade codex to use the authenticated MCP server".into(),
                        ),
                    };
                }
            }
            status
        }
        Err(e) => RegistrationStatus {
            success: false,
            error: Some(e),
        },
    }
}

/// Parse CLI output, detecting "not found" / "not installed" patterns in stderr.
fn parse_cli_output(output: std::process::Output) -> RegistrationStatus {
    if output.status.success() {
        return RegistrationStatus { success: true, error: None };
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let combined = format!(
        "{}{}",
        stderr,
        String::from_utf8_lossy(&output.stdout).to_lowercase()
    );
    let is_not_installed = combined.contains("not found")
        || combined.contains("no such file")
        || combined.contains("command not found");
    let error_msg = if is_not_installed {
        "not installed".to_string()
    } else if stderr.is_empty() {
        format!("exit code {}", output.status.code().unwrap_or(-1))
    } else {
        stderr
    };
    RegistrationStatus {
        success: false,
        error: Some(error_msg),
    }
}

/// Run a shell command with a timeout. Returns an error string for
/// "not installed" (binary not found) or timeout scenarios.
fn run_with_timeout(
    shell: &str,
    cmd: &str,
    timeout: std::time::Duration,
) -> Result<std::process::Output, String> {
    let mut child = std::process::Command::new(shell)
        .arg("-lc")
        .arg(cmd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "not installed".to_string()
            } else {
                format!("spawn error: {e}")
            }
        })?;

    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                return child.wait_with_output().map_err(|e| format!("wait: {e}"));
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    return Err("timed out".to_string());
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => return Err(format!("wait error: {e}")),
        }
    }
}

/// Build a CLI command for a task that runs in a visible terminal (non-interactive, human-readable).
/// Unlike start_agent_prompt which streams JSON, this produces a command string for PTY sessions.
#[tauri::command]
pub async fn build_agent_task_command(
    prompt: String,
    settings: Option<AgentLaunchSettings>,
) -> Result<String, String> {
    let settings = settings.unwrap_or_default();
    let mcp_config_path = agents_ui_dir()?.join("mcp-config.json");
    if !mcp_config_path.exists() {
        write_agent_mcp_config(None).await?;
    }

    let binary = match settings.provider.as_deref() {
        Some("codex") => "codex",
        _ => "claude",
    };

    let parts = if binary == "codex" {
        build_codex_task_cmd(&prompt, &settings)?
    } else {
        build_claude_task_cmd(&prompt, &settings, &mcp_config_path)?
    };

    Ok(parts.join(" "))
}

/// Build Claude Code command for visible terminal task (no --output-format stream-json).
fn build_claude_task_cmd(
    prompt: &str,
    settings: &AgentLaunchSettings,
    mcp_config_path: &std::path::Path,
) -> Result<Vec<String>, String> {
    let mut parts: Vec<String> = vec![
        "claude".into(),
        "-p".into(),
        shell_escape(prompt),
        "--verbose".into(),
        "--mcp-config".into(),
        shell_escape(path_to_utf8(mcp_config_path, "agent MCP path")?),
    ];

    let default_tools = "mcp__agents-ui__*";
    let tools_value = match settings.allowed_tools.as_deref() {
        Some(extra) if !extra.is_empty() => format!("{default_tools},{extra}"),
        _ => default_tools.to_string(),
    };
    parts.push("--allowedTools".into());
    parts.push(shell_escape(&tools_value));

    if let Some(ref model) = settings.model {
        parts.push("--model".into());
        parts.push(shell_escape(model));
    }

    if let Some(ref effort) = settings.effort {
        parts.push("--effort".into());
        parts.push(shell_escape(effort));
    }

    Ok(parts)
}

/// Build Codex command for visible terminal task (no --json).
fn build_codex_task_cmd(
    prompt: &str,
    settings: &AgentLaunchSettings,
) -> Result<Vec<String>, String> {
    let system_prompt = include_str!("agent_system_prompt.txt");
    let instructions_path = agents_ui_dir()?.join("codex-instructions.md");
    std::fs::write(&instructions_path, system_prompt)
        .map_err(|e| format!("write instructions: {e}"))?;

    let mut parts: Vec<String> = vec!["codex".into(), "exec".into()];

    let model = settings
        .model
        .as_deref()
        .filter(|model| !model.trim().is_empty())
        .unwrap_or(DEFAULT_CODEX_MODEL);
    parts.push("-m".into());
    parts.push(shell_escape(model));

    parts.push(shell_escape(prompt));
    parts.push("--full-auto".into());

    parts.push("-c".into());
    parts.push(format!(
        "instructions_file={}",
        shell_escape(path_to_utf8(&instructions_path, "Codex instructions path")?)
    ));

    Ok(parts)
}

/// Read and clear the MCP output buffer for a given session.
/// This bridges the MCP output buffer to the frontend for orchestration context passing.
#[tauri::command]
pub async fn read_agent_session_output(
    buffers: tauri::State<'_, crate::mcp_tools::OutputBuffers>,
    session_id: String,
) -> Result<String, String> {
    let mut bufs = buffers.lock().await;
    let text = if let Some(buf) = bufs.get_mut(&session_id) {
        buf.read_and_clear(false)
    } else {
        String::new()
    };
    Ok(text)
}

/// Create a directory (and all parent directories) at an absolute path.
/// Used by the orchestrator to create result directories for plans.
#[tauri::command]
pub async fn orchestrate_ensure_dir(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&path).map_err(|e| format!("create_dir_all failed: {e}"))
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Read a text file at an absolute path.
/// Used by the orchestrator to poll task result files.
#[tauri::command]
pub async fn orchestrate_read_file(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        std::fs::read_to_string(&path).map_err(|e| format!("read failed: {e}"))
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Tauri command to register MCP server with agent CLIs.
#[tauri::command]
pub async fn register_mcp_with_agents(port: Option<u16>) -> Result<McpRegistrationResult, String> {
    let port = port.unwrap_or(45557);
    let token = crate::mcp_server::get_or_init_auth_token();
    let result = tokio::task::spawn_blocking(move || do_register_mcp_with_agents(port, &token))
        .await
        .map_err(|e| format!("join error: {e}"))?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{
        append_shell_escaped_args, shell_escape, validated_shell_path,
    };
    #[cfg(target_family = "unix")]
    use super::{
        create_mcp_config_stage_with_ids, effective_user_id,
        ensure_private_agents_ui_directory, ensure_private_agents_ui_directory_for_uid,
        mcp_config_stage_path, replace_file_atomically, verify_private_mcp_config,
        write_mcp_config_in_directory, write_private_mcp_config_with_publish,
        write_private_mcp_config_with_publish_and_sync, MCP_CONFIG_FILE_NAME,
    };
    #[cfg(target_family = "unix")]
    use std::io::Write;

    struct TestDirectory(std::path::PathBuf);

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn test_directory(label: &str) -> TestDirectory {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "agents-ui-agent-{label}-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("create agent test directory");
        TestDirectory(path)
    }

    #[test]
    fn shell_validation_preserves_an_exact_executable_path() {
        let root = test_directory("shell");
        let shell = root.0.join("  shell runner-目录  ");
        std::fs::write(&shell, "#!/bin/sh\n").expect("write test shell");
        #[cfg(target_family = "unix")]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755))
                .expect("make test shell executable");
        }
        let exact = shell.to_str().expect("test path is UTF-8").to_string();

        assert_eq!(validated_shell_path(&exact), Some(exact));
        assert_eq!(validated_shell_path("relative-shell"), None);
        assert_eq!(validated_shell_path("/definitely/missing/agents-ui-shell"), None);
        assert_eq!(validated_shell_path(root.0.to_str().unwrap()), None);
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn shell_validation_rejects_a_non_executable_file() {
        let root = test_directory("non-executable-shell");
        let shell = root.0.join("shell");
        std::fs::write(&shell, "#!/bin/sh\n").expect("write test shell");
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o644))
            .expect("set non-executable permissions");
        assert_eq!(validated_shell_path(shell.to_str().unwrap()), None);
    }

    #[test]
    fn terminal_command_dynamic_arguments_are_shell_escaped() {
        let mut parts = vec!["claude".to_string(), "--mcp-config".to_string()];
        append_shell_escaped_args(
            &mut parts,
            vec![
                "/tmp/MCP path/config.json".to_string(),
                "--model".to_string(),
                "it's-$HOME-`touch owned`; echo bad".to_string(),
            ],
        );

        assert_eq!(parts[1], "--mcp-config");
        assert_eq!(parts[2], "'/tmp/MCP path/config.json'");
        assert_eq!(parts[3], "--model");
        assert_eq!(parts[4], "'it'\\''s-$HOME-`touch owned`; echo bad'");
        assert_eq!(shell_escape("--full-auto"), "--full-auto");
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn mcp_config_and_agent_directory_are_private() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let root = test_directory("mcp-private");
        let dir = root.0.join(".agents-ui");
        std::fs::create_dir(&dir).expect("create agent directory");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755))
            .expect("make directory initially permissive");
        let initial_path = dir.join(MCP_CONFIG_FILE_NAME);
        std::fs::write(&initial_path, b"old").expect("create old MCP config");
        std::fs::set_permissions(&initial_path, std::fs::Permissions::from_mode(0o644))
            .expect("make old MCP config initially permissive");

        let path = write_mcp_config_in_directory(&dir, 45557, "test-bearer-token")
            .expect("write private MCP config");
        let dir_metadata = std::fs::symlink_metadata(&dir).expect("inspect agent directory");
        let file_metadata = std::fs::symlink_metadata(&path).expect("inspect MCP config");

        assert_eq!(path, dir.join(MCP_CONFIG_FILE_NAME));
        assert_eq!(dir_metadata.uid(), effective_user_id());
        assert_eq!(dir_metadata.permissions().mode() & 0o777, 0o700);
        assert!(file_metadata.is_file());
        assert!(!file_metadata.file_type().is_symlink());
        assert_eq!(file_metadata.uid(), effective_user_id());
        assert_eq!(file_metadata.permissions().mode() & 0o777, 0o600);
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn existing_mcp_config_symlink_is_replaced_without_following_it() {
        use std::os::unix::fs::symlink;

        let root = test_directory("mcp-file-symlink");
        let dir = root.0.join(".agents-ui");
        ensure_private_agents_ui_directory(&dir).expect("create private agent directory");
        let victim = root.0.join("victim");
        std::fs::write(&victim, b"untouched").expect("create victim");
        let config_path = dir.join(MCP_CONFIG_FILE_NAME);
        symlink(&victim, &config_path).expect("plant MCP config symlink");

        let published = write_mcp_config_in_directory(&dir, 45557, "private-token")
            .expect("atomically replace MCP config symlink");

        assert_eq!(published, config_path);
        let metadata = std::fs::symlink_metadata(&published).expect("inspect published config");
        assert!(metadata.is_file());
        assert!(!metadata.file_type().is_symlink());
        assert_eq!(std::fs::read(&victim).unwrap(), b"untouched");
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn symlinked_agent_directory_is_rejected_without_writing_outside() {
        use std::os::unix::fs::symlink;

        let root = test_directory("mcp-dir-symlink");
        let outside = test_directory("mcp-dir-outside");
        let dir = root.0.join(".agents-ui");
        symlink(&outside.0, &dir).expect("plant agent directory symlink");

        let error = write_mcp_config_in_directory(&dir, 45557, "must-not-escape")
            .expect_err("symlinked agent directory must fail closed");

        assert!(error.contains("symbolic link"), "{error}");
        assert!(!outside.0.join(MCP_CONFIG_FILE_NAME).exists());
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn agent_directory_with_unexpected_owner_is_rejected_before_chmod() {
        use std::os::unix::fs::PermissionsExt;

        let root = test_directory("mcp-dir-owner");
        let dir = root.0.join(".agents-ui");
        std::fs::create_dir(&dir).expect("create agent directory");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755))
            .expect("set original directory mode");

        let error = ensure_private_agents_ui_directory_for_uid(
            &dir,
            effective_user_id().wrapping_add(1),
        )
        .expect_err("unexpected owner must fail closed");

        assert!(error.contains("not owned"), "{error}");
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o755,
            "ownership must be checked before changing permissions"
        );
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn preplanted_mcp_stage_symlink_is_not_followed() {
        use std::os::unix::fs::symlink;

        let root = test_directory("mcp-stage-symlink");
        let dir = root.0.join(".agents-ui");
        ensure_private_agents_ui_directory(&dir).expect("create private agent directory");
        let victim = root.0.join("victim");
        std::fs::write(&victim, b"untouched").expect("create victim");
        let planted_id = 7;
        let usable_id = 8;
        let planted = mcp_config_stage_path(&dir, planted_id);
        symlink(&victim, &planted).expect("plant staging symlink");
        let mut ids = [planted_id, usable_id].into_iter();

        let (stage, mut file) = create_mcp_config_stage_with_ids(&dir, || {
            ids.next().expect("stage allocator retried unexpectedly")
        })
        .expect("skip planted staging path");
        assert_eq!(stage.path, mcp_config_stage_path(&dir, usable_id));
        file.write_all(b"staged").expect("write staging file");
        file.sync_all().expect("sync staging file");
        drop(file);
        drop(stage);

        assert_eq!(std::fs::read(&victim).unwrap(), b"untouched");
        assert!(std::fs::symlink_metadata(&planted)
            .expect("inspect planted symlink")
            .file_type()
            .is_symlink());
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn failed_publish_preserves_existing_file_and_cleans_stage() {
        let root = test_directory("mcp-publish-failure");
        let dir = root.0.join(".agents-ui");
        ensure_private_agents_ui_directory(&dir).expect("create private agent directory");
        let destination = dir.join("sentinel");
        std::fs::write(&destination, b"original").expect("write original destination");

        let error = write_private_mcp_config_with_publish(
            &dir,
            &destination,
            b"replacement",
            |_stage, _destination| Err(std::io::Error::other("injected publish failure")),
        )
        .expect_err("injected publish failure must be reported");

        assert!(error.contains("injected publish failure"), "{error}");
        assert_eq!(std::fs::read(&destination).unwrap(), b"original");
        let stages = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with(".mcp-config.json.stage-"))
            })
            .count();
        assert_eq!(stages, 0);
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn unsupported_directory_sync_does_not_report_failure_after_publish() {
        let root = test_directory("mcp-directory-sync-unsupported");
        let dir = root.0.join(".agents-ui");
        ensure_private_agents_ui_directory(&dir).expect("create private agent directory");
        let destination = dir.join(MCP_CONFIG_FILE_NAME);

        write_private_mcp_config_with_publish_and_sync(
            &dir,
            &destination,
            b"private config",
            replace_file_atomically,
            |_directory| Err(std::io::Error::from_raw_os_error(libc::EINVAL)),
        )
        .expect("post-commit unsupported directory sync must be best effort");

        assert_eq!(std::fs::read(&destination).unwrap(), b"private config");
        verify_private_mcp_config(&destination).expect("published config remains private");
    }
}
