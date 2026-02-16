use crate::api_bridge::ApiEventBus;
use crate::api_handlers::HandlerContext;
use crate::api_types::StateChangeNotification;
use crate::mcp_tools::{self, OutputBuffer, OutputBuffers};
use crate::server_control::ServerControl;
use axum::http::HeaderMap;
use axum::{extract::State, http::StatusCode, response::IntoResponse, routing::post, Router};
use rand_core::{OsRng, RngCore};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::Manager;
use tokio::net::TcpListener;
use tokio::sync::{watch, Mutex};

const MCP_PORT: u16 = 45557;

struct McpState {
    ctx: Arc<HandlerContext>,
    output_buffers: OutputBuffers,
    session_id: String,
    app_version: String,
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
    let output_buffers: OutputBuffers = Arc::new(Mutex::new(HashMap::new()));
    let app_version = app_handle
        .config()
        .version
        .clone()
        .unwrap_or_else(|| "0.0.0".to_string());

    // Generate a session ID for this MCP server instance
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    let session_id = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();

    let state = Arc::new(McpState {
        ctx,
        output_buffers: output_buffers.clone(),
        session_id,
        app_version,
    });

    // Spawn output buffer background task
    let buffers_clone = output_buffers.clone();
    let event_bus = app_handle.state::<ApiEventBus>().inner().clone();
    let mut event_rx = event_bus.sender().subscribe();

    tokio::spawn(async move {
        loop {
            match event_rx.recv().await {
                Ok(notification) => {
                    handle_event_notification(&buffers_clone, &notification).await;
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
        match crate::api_discovery::update_mcp_url(port) {
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

    // Remove mcp_url from discovery file
    if let Ok(disc_path) = crate::api_discovery::discovery_path() {
        if disc_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&disc_path) {
                if let Ok(mut file) = serde_json::from_str::<crate::api_discovery::DiscoveryFile>(&content) {
                    file.mcp_url = None;
                    if let Ok(json) = serde_json::to_string_pretty(&file) {
                        let _ = std::fs::write(&disc_path, &json);
                    }
                }
            }
        }
    }
}

async fn handle_event_notification(buffers: &OutputBuffers, notification: &StateChangeNotification) {
    match notification.event.as_str() {
        "sessions.output" => {
            if let (Some(session_id), Some(output)) = (
                notification.data.get("sessionId").and_then(|v| v.as_str()),
                notification.data.get("output").and_then(|v| v.as_str()),
            ) {
                let mut bufs = buffers.lock().await;
                bufs.entry(session_id.to_string())
                    .or_insert_with(OutputBuffer::new)
                    .append(output.to_string());
            }
        }
        "sessions.exit" => {
            // Keep buffer around so output can still be read after exit
        }
        _ => {}
    }
}

async fn handle_mcp_request(
    State(state): State<Arc<McpState>>,
    body: String,
) -> impl IntoResponse {
    let mut headers = HeaderMap::new();
    headers.insert("content-type", "application/json".parse().unwrap());

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

            match mcp_tools::call_tool(&state.ctx, &state.output_buffers, tool_name, arguments).await {
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
