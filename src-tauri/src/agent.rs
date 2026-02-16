use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

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
}

impl Default for AgentLaunchSettings {
    fn default() -> Self {
        Self {
            provider: Some("claude-code".to_string()),
            allowed_tools: None,
            model: None,
        }
    }
}

/// Write the MCP config file that agents use to connect to our MCP server.
#[tauri::command]
pub async fn write_agent_mcp_config(mcp_port: Option<u16>) -> Result<String, String> {
    let port = mcp_port.unwrap_or(45557);
    let dir = agents_ui_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
    let path = dir.join("mcp-config.json");

    let config = serde_json::json!({
        "mcpServers": {
            "agents-ui": {
                "type": "http",
                "url": format!("http://127.0.0.1:{port}/mcp")
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

    // Resume uses: codex exec resume <sessionId> <prompt>
    if let Some(sid) = session_id {
        parts.push("resume".into());
        parts.push(shell_escape(sid));
    }

    parts.push(shell_escape(prompt));
    parts.push("--json".into());
    parts.push("--full-auto".into());

    if let Some(ref model) = settings.model {
        parts.push("-m".into());
        parts.push(shell_escape(model));
    }

    parts.push("-c".into());
    parts.push(format!(
        "instructions_file={}",
        shell_escape(&instructions_path.to_string_lossy())
    ));

    Ok(parts)
}

/// Ensure the MCP server is registered with Codex before launching.
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
        // Register MCP server with Codex before launching
        // Read port from the existing config to stay in sync
        let mcp_port = read_mcp_port_from_config(&mcp_config_path).unwrap_or(45557);
        ensure_codex_mcp_registered(mcp_port)?;
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

    if binary == "codex" {
        // For terminal mode, register MCP and don't pass --mcp-config
        let mcp_port = read_mcp_port_from_config(&mcp_config_path).unwrap_or(45557);
        let _ = ensure_codex_mcp_registered(mcp_port);
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
