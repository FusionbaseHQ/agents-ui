use crate::api_bridge::{ApiEventBus, ApiPendingRequests, BridgeResult};
use crate::api_types::*;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::sync::oneshot;

pub struct HandlerContext {
    pub app_handle: tauri::AppHandle,
    pub pending: ApiPendingRequests,
    #[allow(dead_code)]
    pub event_bus: ApiEventBus,
    pub app_version: String,
}

impl HandlerContext {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        let pending = app_handle.state::<ApiPendingRequests>().inner().clone();
        let event_bus = app_handle.state::<ApiEventBus>().inner().clone();
        let app_version = app_handle
            .config()
            .version
            .clone()
            .unwrap_or_else(|| "0.0.0".to_string());
        Self {
            app_handle,
            pending,
            event_bus,
            app_version,
        }
    }
}

pub async fn dispatch(
    ctx: &HandlerContext,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    if is_bridge_method(method) {
        return dispatch_bridge(ctx, method, params).await;
    }
    dispatch_direct(ctx, method, params).await
}

// ── Direct backend handlers ──

async fn dispatch_direct(
    ctx: &HandlerContext,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        // sessions
        "sessions.write" => handle_sessions_write(ctx, params),
        "sessions.resize" => handle_sessions_resize(ctx, params),
        "sessions.detach" => handle_sessions_detach(ctx, params),

        // persistent_sessions
        "persistent_sessions.list" => handle_persistent_sessions_list(ctx),
        "persistent_sessions.kill" => handle_persistent_sessions_kill(ctx, params),

        // recordings
        "recordings.list" => handle_recordings_list(ctx),
        "recordings.get" => handle_recordings_get(ctx, params),
        "recordings.load" => handle_recordings_load(ctx, params),
        "recordings.delete" => handle_recordings_delete(ctx, params),

        // ssh
        "ssh.list_hosts" => handle_ssh_list_hosts(),

        // files
        "files.list" => handle_files_list(params),
        "files.read" => handle_files_read(params),
        "files.write" => handle_files_write(params),
        "files.create" => handle_files_create(params),
        "files.rename" => handle_files_rename(params),
        "files.delete" => handle_files_delete(params),
        "files.open_in_finder" => handle_files_open_in_finder(params),

        // ssh_files
        "ssh_files.default_root" => handle_ssh_files_default_root(params).await,
        "ssh_files.list" => handle_ssh_files_list(params).await,
        "ssh_files.read" => handle_ssh_files_read(params).await,
        "ssh_files.write" => handle_ssh_files_write(params).await,
        "ssh_files.create" => handle_ssh_files_create(params).await,
        "ssh_files.rename" => handle_ssh_files_rename(params).await,
        "ssh_files.delete" => handle_ssh_files_delete(params).await,
        "ssh_files.download" => handle_ssh_files_download(params).await,

        // app
        "app.info" => handle_app_info(ctx),

        // api
        "api.methods" => handle_api_methods(),
        "api.describe" => handle_api_describe(params),

        _ => Err(JsonRpcError {
            code: METHOD_NOT_FOUND,
            message: format!("Unknown method: {method}"),
            data: None,
        }),
    }
}

// ── Bridge dispatch ──

async fn dispatch_bridge(
    ctx: &HandlerContext,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let request_id = uuid_v4();
    let (tx, rx) = oneshot::channel::<BridgeResult>();

    ctx.pending.insert(request_id.clone(), tx);

    let bridge_cmd = BridgeCommand {
        request_id: request_id.clone(),
        method: method.to_string(),
        params,
    };

    if let Err(e) = ctx.app_handle.emit("api-command", &bridge_cmd) {
        ctx.pending.cancel(&request_id);
        return Err(JsonRpcError {
            code: INTERNAL_ERROR,
            message: format!("Failed to emit bridge command: {e}"),
            data: None,
        });
    }

    match tokio::time::timeout(Duration::from_secs(5), rx).await {
        Ok(Ok(result)) => {
            if let Some(err) = result.error {
                Err(JsonRpcError {
                    code: OPERATION_FAILED,
                    message: err,
                    data: None,
                })
            } else {
                Ok(result.result.unwrap_or(Value::Null))
            }
        }
        Ok(Err(_)) => {
            Err(JsonRpcError {
                code: INTERNAL_ERROR,
                message: "Bridge response channel closed".into(),
                data: None,
            })
        }
        Err(_) => {
            ctx.pending.cancel(&request_id);
            Err(JsonRpcError {
                code: FRONTEND_TIMEOUT,
                message: "Frontend bridge timed out (5s)".into(),
                data: None,
            })
        }
    }
}

// ── Session handlers (direct) ──

fn handle_sessions_write(ctx: &HandlerContext, params: Value) -> Result<Value, JsonRpcError> {
    let id = require_str(&params, "id")?;
    let data = require_str(&params, "data")?;
    let source = params.get("source").and_then(|v| v.as_str()).map(String::from);

    crate::pty::write_to_session(ctx.app_handle.state(), id, data, source)
        .map(|_| Value::Null)
        .map_err(|e| op_failed(&e))
}

fn handle_sessions_resize(ctx: &HandlerContext, params: Value) -> Result<Value, JsonRpcError> {
    let id = require_str(&params, "id")?;
    let cols = require_u16(&params, "cols")?;
    let rows = require_u16(&params, "rows")?;

    crate::pty::resize_session(ctx.app_handle.state(), id, cols, rows)
        .map(|_| Value::Null)
        .map_err(|e| op_failed(&e))
}

fn handle_sessions_detach(ctx: &HandlerContext, params: Value) -> Result<Value, JsonRpcError> {
    let id = require_str(&params, "id")?;

    crate::pty::detach_session(ctx.app_handle.state(), id)
        .map(|_| Value::Null)
        .map_err(|e| op_failed(&e))
}

// ── Persistent sessions ──

fn handle_persistent_sessions_list(ctx: &HandlerContext) -> Result<Value, JsonRpcError> {
    let window = get_window(&ctx.app_handle)?;
    let result = crate::pty::list_persistent_sessions(window)
        .map_err(|e| op_failed(&e))?;
    serde_json::to_value(result).map_err(|e| internal(&e.to_string()))
}

fn handle_persistent_sessions_kill(ctx: &HandlerContext, params: Value) -> Result<Value, JsonRpcError> {
    let persist_id = require_str(&params, "persistId")?;
    let window = get_window(&ctx.app_handle)?;
    crate::pty::kill_persistent_session(window, persist_id)
        .map(|_| Value::Null)
        .map_err(|e| op_failed(&e))
}

// ── Recordings ──

fn handle_recordings_list(ctx: &HandlerContext) -> Result<Value, JsonRpcError> {
    let window = get_window(&ctx.app_handle)?;
    let result = crate::recording::list_recordings(window)
        .map_err(|e| op_failed(&e))?;
    serde_json::to_value(result).map_err(|e| internal(&e.to_string()))
}

fn handle_recordings_get(ctx: &HandlerContext, params: Value) -> Result<Value, JsonRpcError> {
    let id = require_str(&params, "id")?;
    let window = get_window(&ctx.app_handle)?;
    let all = crate::recording::list_recordings(window)
        .map_err(|e| op_failed(&e))?;
    let entry = all.into_iter().find(|r| r.recording_id == id)
        .ok_or_else(|| not_found("recording"))?;
    serde_json::to_value(entry).map_err(|e| internal(&e.to_string()))
}

fn handle_recordings_load(ctx: &HandlerContext, params: Value) -> Result<Value, JsonRpcError> {
    let id = require_str(&params, "id")?;
    let decrypt = params.get("decrypt").and_then(|v| v.as_bool());
    let window = get_window(&ctx.app_handle)?;
    let result = crate::recording::load_recording(window, id, decrypt)
        .map_err(|e| op_failed(&e))?;
    serde_json::to_value(result).map_err(|e| internal(&e.to_string()))
}

fn handle_recordings_delete(ctx: &HandlerContext, params: Value) -> Result<Value, JsonRpcError> {
    let id = require_str(&params, "id")?;
    let window = get_window(&ctx.app_handle)?;
    crate::recording::delete_recording(window, id)
        .map(|_| Value::Null)
        .map_err(|e| op_failed(&e))
}

// ── SSH ──

fn handle_ssh_list_hosts() -> Result<Value, JsonRpcError> {
    let result = crate::ssh::list_ssh_hosts()
        .map_err(|e| op_failed(&e))?;
    serde_json::to_value(result).map_err(|e| internal(&e.to_string()))
}

// ── Files ──

fn handle_files_list(params: Value) -> Result<Value, JsonRpcError> {
    let root = require_str(&params, "root")?;
    let path = require_str(&params, "path")?;
    let result = crate::files::list_fs_entries(root, path)
        .map_err(|e| op_failed(&e))?;
    serde_json::to_value(result).map_err(|e| internal(&e.to_string()))
}

fn handle_files_read(params: Value) -> Result<Value, JsonRpcError> {
    let root = require_str(&params, "root")?;
    let path = require_str(&params, "path")?;
    let content = crate::files::read_text_file(root, path)
        .map_err(|e| op_failed(&e))?;
    Ok(json!({ "content": content }))
}

fn handle_files_write(params: Value) -> Result<Value, JsonRpcError> {
    let root = require_str(&params, "root")?;
    let path = require_str(&params, "path")?;
    let content = require_str(&params, "content")?;
    crate::files::write_text_file(root, path, content)
        .map(|_| Value::Null)
        .map_err(|e| op_failed(&e))
}

fn handle_files_create(params: Value) -> Result<Value, JsonRpcError> {
    let root = require_str(&params, "root")?;
    let path = require_str(&params, "path")?;
    let file_type = require_str(&params, "type")?;
    match file_type.as_str() {
        "file" => crate::files::create_file(root, path)
            .map(|_| Value::Null)
            .map_err(|e| op_failed(&e)),
        "directory" => crate::files::create_directory(root, path)
            .map(|_| Value::Null)
            .map_err(|e| op_failed(&e)),
        _ => Err(validation("type must be 'file' or 'directory'")),
    }
}

fn handle_files_rename(params: Value) -> Result<Value, JsonRpcError> {
    let root = require_str(&params, "root")?;
    let path = require_str(&params, "path")?;
    let new_name = require_str(&params, "newName")?;
    let new_path = crate::files::rename_fs_entry(root, path, new_name)
        .map_err(|e| op_failed(&e))?;
    Ok(json!({ "newPath": new_path }))
}

fn handle_files_delete(params: Value) -> Result<Value, JsonRpcError> {
    let root = require_str(&params, "root")?;
    let path = require_str(&params, "path")?;
    crate::files::delete_fs_entry(root, path)
        .map(|_| Value::Null)
        .map_err(|e| op_failed(&e))
}

fn handle_files_open_in_finder(params: Value) -> Result<Value, JsonRpcError> {
    let path = require_str(&params, "path")?;
    crate::file_manager::open_path_in_file_manager(path)
        .map(|_| Value::Null)
        .map_err(|e| op_failed(&e))
}

// ── SSH files ──

async fn handle_ssh_files_default_root(params: Value) -> Result<Value, JsonRpcError> {
    let host = require_str(&params, "host")?;
    let path = crate::ssh_fs::ssh_default_root(host).await
        .map_err(|e| op_failed(&e))?;
    Ok(json!({ "path": path }))
}

async fn handle_ssh_files_list(params: Value) -> Result<Value, JsonRpcError> {
    let host = require_str(&params, "host")?;
    let root = require_str(&params, "root")?;
    let path = require_str(&params, "path")?;
    let result = crate::ssh_fs::ssh_list_fs_entries(host, root, path).await
        .map_err(|e| op_failed(&e))?;
    serde_json::to_value(result).map_err(|e| internal(&e.to_string()))
}

async fn handle_ssh_files_read(params: Value) -> Result<Value, JsonRpcError> {
    let host = require_str(&params, "host")?;
    let root = require_str(&params, "root")?;
    let path = require_str(&params, "path")?;
    let content = crate::ssh_fs::ssh_read_text_file(host, root, path).await
        .map_err(|e| op_failed(&e))?;
    Ok(json!({ "content": content }))
}

async fn handle_ssh_files_write(params: Value) -> Result<Value, JsonRpcError> {
    let host = require_str(&params, "host")?;
    let root = require_str(&params, "root")?;
    let path = require_str(&params, "path")?;
    let content = require_str(&params, "content")?;
    crate::ssh_fs::ssh_write_text_file(host, root, path, content).await
        .map(|_| Value::Null)
        .map_err(|e| op_failed(&e))
}

async fn handle_ssh_files_create(params: Value) -> Result<Value, JsonRpcError> {
    let host = require_str(&params, "host")?;
    let root = require_str(&params, "root")?;
    let path = require_str(&params, "path")?;
    let file_type = require_str(&params, "type")?;
    match file_type.as_str() {
        "file" => crate::ssh_fs::ssh_create_file(host, root, path).await
            .map(|_| Value::Null)
            .map_err(|e| op_failed(&e)),
        "directory" => crate::ssh_fs::ssh_create_directory(host, root, path).await
            .map(|_| Value::Null)
            .map_err(|e| op_failed(&e)),
        _ => Err(validation("type must be 'file' or 'directory'")),
    }
}

async fn handle_ssh_files_rename(params: Value) -> Result<Value, JsonRpcError> {
    let host = require_str(&params, "host")?;
    let root = require_str(&params, "root")?;
    let path = require_str(&params, "path")?;
    let new_name = require_str(&params, "newName")?;
    let new_path = crate::ssh_fs::ssh_rename_fs_entry(host, root, path, new_name).await
        .map_err(|e| op_failed(&e))?;
    Ok(json!({ "newPath": new_path }))
}

async fn handle_ssh_files_delete(params: Value) -> Result<Value, JsonRpcError> {
    let host = require_str(&params, "host")?;
    let root = require_str(&params, "root")?;
    let path = require_str(&params, "path")?;
    crate::ssh_fs::ssh_delete_fs_entry(host, root, path).await
        .map(|_| Value::Null)
        .map_err(|e| op_failed(&e))
}

async fn handle_ssh_files_download(params: Value) -> Result<Value, JsonRpcError> {
    let host = require_str(&params, "host")?;
    let root = require_str(&params, "root")?;
    let remote_path = require_str(&params, "remotePath")?;
    let local_path = require_str(&params, "localPath")?;
    crate::ssh_fs::ssh_download_file(host, root, remote_path, local_path).await
        .map(|_| Value::Null)
        .map_err(|e| op_failed(&e))
}

// ── App ──

fn handle_app_info(ctx: &HandlerContext) -> Result<Value, JsonRpcError> {
    let window = get_window(&ctx.app_handle)?;
    let info = crate::app_info::get_app_info(window);
    serde_json::to_value(info).map_err(|e| internal(&e.to_string()))
}

// ── API introspection ──

fn handle_api_methods() -> Result<Value, JsonRpcError> {
    let methods = method_catalog();
    Ok(json!({ "methods": methods }))
}

fn handle_api_describe(params: Value) -> Result<Value, JsonRpcError> {
    let method_name = require_str(&params, "method")?;
    let catalog = method_catalog();
    let info = catalog.into_iter().find(|m| m.name == method_name)
        .ok_or_else(|| not_found("method"))?;
    serde_json::to_value(info).map_err(|e| internal(&e.to_string()))
}

// ── Helpers ──

fn get_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, JsonRpcError> {
    app.get_webview_window("main")
        .ok_or_else(|| internal("main window not found"))
}

fn require_str(params: &Value, key: &str) -> Result<String, JsonRpcError> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| JsonRpcError {
            code: INVALID_PARAMS,
            message: format!("Missing required parameter: {key}"),
            data: None,
        })
}

fn require_u16(params: &Value, key: &str) -> Result<u16, JsonRpcError> {
    params
        .get(key)
        .and_then(|v| v.as_u64())
        .map(|v| v as u16)
        .ok_or_else(|| JsonRpcError {
            code: INVALID_PARAMS,
            message: format!("Missing required parameter: {key}"),
            data: None,
        })
}

fn op_failed(msg: &str) -> JsonRpcError {
    JsonRpcError {
        code: OPERATION_FAILED,
        message: msg.to_string(),
        data: None,
    }
}

fn not_found(resource: &str) -> JsonRpcError {
    JsonRpcError {
        code: NOT_FOUND,
        message: format!("{resource} not found"),
        data: None,
    }
}

fn internal(msg: &str) -> JsonRpcError {
    JsonRpcError {
        code: INTERNAL_ERROR,
        message: msg.to_string(),
        data: None,
    }
}

fn validation(msg: &str) -> JsonRpcError {
    JsonRpcError {
        code: VALIDATION,
        message: msg.to_string(),
        data: None,
    }
}

fn uuid_v4() -> String {
    use rand_core::{OsRng, RngCore};
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    // Set version 4 and variant bits
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5],
        bytes[6], bytes[7],
        bytes[8], bytes[9],
        bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}
