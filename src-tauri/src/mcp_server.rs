use crate::api_bridge::ApiEventBus;
use crate::api_handlers::HandlerContext;
use crate::api_types::StateChangeNotification;
use crate::mcp_tools::{self, CommandCompletion, CommandCompletionBuffers, IdleNotifications, OutputBuffer, OutputBuffers, SessionNotifications};
use crate::server_control::ServerControl;
use axum::http::HeaderMap;
use axum::{extract::State, http::StatusCode, response::IntoResponse, routing::post, Router};
use rand_core::{OsRng, RngCore};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::Manager;
use tokio::net::TcpListener;
use tokio::sync::watch;

const MCP_PORT: u16 = 45557;

/// Auth token of the currently running MCP server, if any. Used by the
/// re-registration command so CLI registrations always carry the live token.
static CURRENT_TOKEN: std::sync::OnceLock<std::sync::Mutex<Option<String>>> =
    std::sync::OnceLock::new();

fn token_cell() -> &'static std::sync::Mutex<Option<String>> {
    CURRENT_TOKEN.get_or_init(|| std::sync::Mutex::new(None))
}

pub fn current_auth_token() -> Option<String> {
    token_cell()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

struct McpState {
    ctx: Arc<HandlerContext>,
    output_buffers: OutputBuffers,
    completion_buffers: CommandCompletionBuffers,
    idle_notifications: IdleNotifications,
    output_waiters: SessionNotifications,
    completion_waiters: SessionNotifications,
    idle_waiters: SessionNotifications,
    session_id: String,
    app_version: String,
    auth_token: String,
}

#[allow(dead_code)]
pub async fn start_mcp_server(app_handle: tauri::AppHandle) {
    let (_, rx) = watch::channel(false);
    let sc = app_handle.clone().try_state::<Arc<ServerControl>>().map(|s| s.inner().clone());
    start_mcp_server_inner(app_handle, rx, sc).await;
}

pub async fn start_mcp_server_with_shutdown(
    app_handle: tauri::AppHandle,
    shutdown_rx: watch::Receiver<bool>,
    sc: Arc<ServerControl>,
) {
    start_mcp_server_inner(app_handle, shutdown_rx, Some(sc)).await;
}

async fn start_mcp_server_inner(
    app_handle: tauri::AppHandle,
    mut shutdown_rx: watch::Receiver<bool>,
    sc: Option<Arc<ServerControl>>,
) {
    let ctx = Arc::new(HandlerContext::new(app_handle.clone()));
    let output_buffers: OutputBuffers = app_handle.state::<OutputBuffers>().inner().clone();
    let completion_buffers: CommandCompletionBuffers = Default::default();
    let idle_notifications: IdleNotifications = Default::default();
    let output_waiters: SessionNotifications = Default::default();
    let completion_waiters: SessionNotifications = Default::default();
    let idle_waiters: SessionNotifications = Default::default();
    let app_version = app_handle
        .config()
        .version
        .clone()
        .unwrap_or_else(|| "0.0.0".to_string());

    // Generate a session ID for this MCP server instance
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    let session_id = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();

    // Bearer token required on every /mcp request. The MCP tools can spawn
    // shells and run commands, so the TCP port must not be drivable by
    // arbitrary local processes or DNS-rebound web pages. The token is shared
    // with clients via the discovery file and CLI registration below.
    let auth_token = crate::api_discovery::generate_token();
    if let Ok(mut guard) = token_cell().lock() {
        *guard = Some(auth_token.clone());
    }

    let state = Arc::new(McpState {
        ctx,
        output_buffers: output_buffers.clone(),
        completion_buffers: completion_buffers.clone(),
        idle_notifications: idle_notifications.clone(),
        output_waiters: output_waiters.clone(),
        completion_waiters: completion_waiters.clone(),
        idle_waiters: idle_waiters.clone(),
        session_id,
        app_version,
        auth_token: auth_token.clone(),
    });

    // Spawn output buffer background task
    let buffers_clone = output_buffers.clone();
    let completions_clone = completion_buffers.clone();
    let idle_clone = idle_notifications.clone();
    let output_waiters_clone = output_waiters.clone();
    let completion_waiters_clone = completion_waiters.clone();
    let idle_waiters_clone = idle_waiters.clone();
    let event_bus = app_handle.state::<ApiEventBus>().inner().clone();
    let mut event_rx = event_bus.sender().subscribe();

    tokio::spawn(async move {
        loop {
            match event_rx.recv().await {
                Ok(notification) => {
                    handle_event_notification(
                        &buffers_clone,
                        &completions_clone,
                        &idle_clone,
                        &output_waiters_clone,
                        &completion_waiters_clone,
                        &idle_waiters_clone,
                        &notification,
                    ).await;
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    eprintln!("[mcp] output buffer lagged, missed {n} events");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
    });

    // Bind to fixed port, fall back to dynamic
    let listener = match TcpListener::bind(format!("127.0.0.1:{MCP_PORT}")).await {
        Ok(l) => l,
        Err(_) => {
            eprintln!("[mcp] port {MCP_PORT} in use, trying dynamic port");
            match TcpListener::bind("127.0.0.1:0").await {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[mcp] failed to bind: {e}");
                    return;
                }
            }
        }
    };

    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(e) => {
            eprintln!("[mcp] failed to get port: {e}");
            return;
        }
    };

    // Update discovery file with MCP URL (retry — api_server may not have written it yet)
    for i in 0..20 {
        match crate::api_discovery::update_mcp_url(port, &auth_token) {
            Ok(()) => {
                eprintln!("[mcp] wrote mcp_url to discovery file");
                break;
            }
            Err(e) => {
                if i == 19 {
                    eprintln!("[mcp] failed to update discovery file after retries: {e}");
                } else {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
            }
        }
    }

    eprintln!("[mcp] listening on http://127.0.0.1:{port}/mcp");

    // Register MCP server with agent CLIs (non-blocking)
    let reg_port = port;
    let reg_token = auth_token.clone();
    tokio::task::spawn_blocking(move || {
        let result = crate::agent::do_register_mcp_with_agents(reg_port, &reg_token);
        if result.claude_code.success {
            eprintln!("[mcp-reg] Claude Code: registered");
        } else if let Some(ref e) = result.claude_code.error {
            if e == "not installed" {
                eprintln!("[mcp-reg] Claude Code: not installed (skipped)");
            } else {
                eprintln!("[mcp-reg] Claude Code: {e}");
            }
        }
        if result.codex.success {
            eprintln!("[mcp-reg] Codex: registered");
        } else if let Some(ref e) = result.codex.error {
            if e == "not installed" {
                eprintln!("[mcp-reg] Codex: not installed (skipped)");
            } else {
                eprintln!("[mcp-reg] Codex: {e}");
            }
        }
    });

    if let Some(ref sc) = sc {
        sc.mcp_running.store(true, Ordering::Relaxed);
    }

    let app = Router::new()
        .route("/mcp", post(handle_mcp_request))
        .with_state(state);

    let server = axum::serve(listener, app);
    let shutdown_signal = async move {
        loop {
            if shutdown_rx.changed().await.is_err() {
                break;
            }
            if *shutdown_rx.borrow() {
                break;
            }
        }
        eprintln!("[mcp] shutdown signal received");
    };

    if let Err(e) = server.with_graceful_shutdown(shutdown_signal).await {
        eprintln!("[mcp] server error: {e}");
    }

    if let Some(ref sc) = sc {
        sc.mcp_running.store(false, Ordering::Relaxed);
    }

    if let Ok(mut guard) = token_cell().lock() {
        *guard = None;
    }

    // Remove mcp_url from discovery file
    if let Ok(disc_path) = crate::api_discovery::discovery_path() {
        if disc_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&disc_path) {
                if let Ok(mut file) = serde_json::from_str::<crate::api_discovery::DiscoveryFile>(&content) {
                    file.mcp_url = None;
                    file.mcp_token = None;
                    if let Ok(json) = serde_json::to_string_pretty(&file) {
                        let _ = std::fs::write(&disc_path, &json);
                    }
                }
            }
        }
    }
}

async fn handle_event_notification(
    buffers: &OutputBuffers,
    completion_buffers: &CommandCompletionBuffers,
    idle_notifications: &IdleNotifications,
    output_waiters: &SessionNotifications,
    completion_waiters: &SessionNotifications,
    idle_waiters: &SessionNotifications,
    notification: &StateChangeNotification,
) {
    match notification.event.as_str() {
        "sessions.output" => {
            if let (Some(session_id), Some(output)) = (
                notification.data.get("sessionId").and_then(|v| v.as_str()),
                notification.data.get("output").and_then(|v| v.as_str()),
            ) {
                {
                    let mut bufs = buffers.lock().await;
                    bufs.entry(session_id.to_string())
                        .or_insert_with(OutputBuffer::new)
                        .append(output.to_string());
                }
                mcp_tools::notify_session(output_waiters, session_id).await;
            }
        }
        "shell.command_complete" => {
            if let Some(session_id) = notification.data.get("sessionId").and_then(|v| v.as_str()) {
                let completion = CommandCompletion {
                    command: notification.data.get("command").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    exit_code: notification.data.get("exitCode").and_then(|v| v.as_i64()),
                    output: notification.data.get("output").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    duration_ms: notification.data.get("durationMs").and_then(|v| v.as_i64()),
                };
                {
                    let mut bufs = completion_buffers.lock().await;
                    let entries = bufs.entry(session_id.to_string()).or_insert_with(Vec::new);
                    entries.push(completion);
                    // Cap at MAX_COMPLETIONS_PER_SESSION
                    while entries.len() > mcp_tools::MAX_COMPLETIONS_PER_SESSION {
                        entries.remove(0);
                    }
                }
                mcp_tools::notify_session(completion_waiters, session_id).await;
            }
        }
        "shell.prompt_ready" => {
            if let (Some(session_id), Some(timestamp)) = (
                notification.data.get("sessionId").and_then(|v| v.as_str()),
                notification.data.get("timestamp").and_then(|v| v.as_u64()),
            ) {
                {
                    let mut notifs = idle_notifications.lock().await;
                    let entries = notifs.entry(session_id.to_string()).or_insert_with(Vec::new);
                    entries.push(timestamp);
                    while entries.len() > mcp_tools::MAX_IDLE_NOTIFICATIONS_PER_SESSION {
                        entries.remove(0);
                    }
                }
                mcp_tools::notify_session(idle_waiters, session_id).await;
            }
        }
        "sessions.exit" => {
            // Keep buffer around so output can still be read after exit
        }
        _ => {}
    }
}

/// Compare tokens without early exit, so timing doesn't leak prefix matches.
fn constant_time_token_eq(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

async fn handle_mcp_request(
    State(state): State<Arc<McpState>>,
    request_headers: HeaderMap,
    body: String,
) -> impl IntoResponse {
    let mut headers = HeaderMap::new();
    headers.insert("content-type", "application/json".parse().unwrap());

    let authorized = request_headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| constant_time_token_eq(t, &state.auth_token))
        .unwrap_or(false);
    if !authorized {
        let body = json!({
            "jsonrpc": "2.0",
            "id": null,
            "error": { "code": -32001, "message": "Unauthorized: missing or invalid bearer token" }
        })
        .to_string();
        return (StatusCode::UNAUTHORIZED, headers, body);
    }

    // Try parsing as a single JSON-RPC message
    let parsed: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => {
            let body = json!({
                "jsonrpc": "2.0",
                "id": null,
                "error": { "code": -32700, "message": "Parse error" }
            }).to_string();
            return (StatusCode::OK, headers, body);
        }
    };

    // Handle batch array
    if let Some(arr) = parsed.as_array() {
        let mut results = Vec::new();
        for item in arr {
            let (resp, is_init) = process_mcp_message(&state, item).await;
            if is_init {
                headers.insert("mcp-session-id", state.session_id.parse().unwrap());
            }
            if let Some(r) = resp {
                results.push(r);
            }
        }
        let body = serde_json::to_string(&results).unwrap_or_else(|_| "[]".to_string());
        return (StatusCode::OK, headers, body);
    }

    // Single message
    let (resp, is_init) = process_mcp_message(&state, &parsed).await;
    if is_init {
        headers.insert("mcp-session-id", state.session_id.parse().unwrap());
    }
    match resp {
        Some(r) => (StatusCode::OK, headers, r.to_string()),
        None => (StatusCode::ACCEPTED, headers, String::new()),
    }
}

/// Returns (response_json, is_initialize)
async fn process_mcp_message(state: &McpState, msg: &Value) -> (Option<Value>, bool) {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(json!({}));

    // Notifications (no id) — handle silently
    if id.is_none() {
        return (None, false);
    }

    let is_init = method == "initialize";

    let result = match method {
        "initialize" => {
            json!({
                "protocolVersion": "2025-03-26",
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "agents-ui",
                    "version": state.app_version
                }
            })
        }
        "ping" => json!({}),
        "tools/list" => {
            let tools = mcp_tools::tool_list();
            json!({ "tools": tools })
        }
        "tools/call" => {
            let tool_name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let arguments = params.get("arguments").cloned().unwrap_or(json!({}));

            match mcp_tools::call_tool(
                &state.ctx,
                &state.output_buffers,
                &state.completion_buffers,
                &state.idle_notifications,
                &state.output_waiters,
                &state.completion_waiters,
                &state.idle_waiters,
                tool_name,
                arguments,
            ).await {
                Ok(result) => result,
                Err(err) => {
                    json!({
                        "isError": true,
                        "content": [{ "type": "text", "text": err }]
                    })
                }
            }
        }
        _ => {
            return (Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("Unknown method: {method}") }
            })), false);
        }
    };

    (Some(json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    })), is_init)
}
