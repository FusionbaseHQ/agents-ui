use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

const DEFAULT_CODEX_MODEL: &str = "gpt-5.5";

/// Get the user's default login shell, same logic as pty.rs.
fn default_user_shell() -> String {
    if let Ok(shell) = std::env::var("SHELL") {
        let trimmed = shell.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
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

/// Write the MCP config file that agents use to connect to our MCP server.
#[tauri::command]
pub async fn write_agent_mcp_config(mcp_port: Option<u16>) -> Result<String, String> {
    let port = mcp_port.unwrap_or(45557);
    let token = crate::mcp_server::current_auth_token()
        .ok_or_else(|| "MCP server is not running; no auth token available".to_string())?;
    let dir = agents_ui_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
    let path = dir.join("mcp-config.json");

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

    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, &json).map_err(|e| format!("write: {e}"))?;
    Ok(path.to_string_lossy().to_string())
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
        shell_escape(&mcp_config_path.to_string_lossy()),
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
        shell_escape(&instructions_path.to_string_lossy())
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
        parts.push(mcp_config_path.to_string_lossy().to_string());
    }

    if let Some(args) = extra_args {
        parts.extend(args);
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
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
    let path = dir.join("mcp-config.json");

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

    let json = serde_json::to_string_pretty(&config).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, &json).map_err(|e| format!("write: {e}"))?;
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

    let add_cmd = format!(
        "codex mcp add agents-ui --url {} --bearer-token {}",
        shell_escape(url),
        shell_escape(token)
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
                            "codex CLI does not support --bearer-token; upgrade codex to use the authenticated MCP server".into(),
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
        shell_escape(&mcp_config_path.to_string_lossy()),
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
        shell_escape(&instructions_path.to_string_lossy())
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
    let token = crate::mcp_server::current_auth_token()
        .ok_or_else(|| "MCP server is not running; cannot register an auth token".to_string())?;
    let result = tokio::task::spawn_blocking(move || do_register_mcp_with_agents(port, &token))
        .await
        .map_err(|e| format!("join error: {e}"))?;
    Ok(result)
}
