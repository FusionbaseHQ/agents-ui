use serde::{Deserialize, Serialize};

// ── JSON-RPC 2.0 core types ──

#[derive(Debug, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: Option<serde_json::Value>,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize, Clone)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcNotification {
    pub jsonrpc: String,
    pub method: String,
    pub params: serde_json::Value,
}

// ── Error codes ──

pub const PARSE_ERROR: i32 = -32700;
pub const INVALID_REQUEST: i32 = -32600;
pub const METHOD_NOT_FOUND: i32 = -32601;
pub const INVALID_PARAMS: i32 = -32602;
pub const INTERNAL_ERROR: i32 = -32603;

pub const AUTH_REQUIRED: i32 = -31001;
pub const AUTH_INVALID: i32 = -31002;
pub const RATE_LIMITED: i32 = -31003;

#[allow(dead_code)]
pub const NOT_FOUND: i32 = -30001;
#[allow(dead_code)]
pub const CONFLICT: i32 = -30002;
#[allow(dead_code)]
pub const VALIDATION: i32 = -30003;
pub const OPERATION_FAILED: i32 = -30004;
pub const FRONTEND_TIMEOUT: i32 = -30005;
#[allow(dead_code)]
pub const APP_NOT_READY: i32 = -30006;

// ── Response constructors ──

impl JsonRpcResponse {
    pub fn success(id: Option<serde_json::Value>, result: serde_json::Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Option<serde_json::Value>, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: None,
            error: Some(JsonRpcError {
                code,
                message: message.into(),
                data: None,
            }),
        }
    }
}

impl JsonRpcNotification {
    pub fn new(method: &str, params: serde_json::Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            method: method.to_string(),
            params,
        }
    }
}

// ── Auth ──

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthParams {
    pub token: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub client_info: Option<ClientInfo>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ClientInfo {
    pub name: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthResult {
    pub session_id: String,
    pub server_version: String,
    pub capabilities: Vec<String>,
}

// ── Subscriptions ──

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeParams {
    pub events: Vec<String>,
    #[serde(default)]
    pub filter: Option<SubscriptionFilter>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionFilter {
    pub session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsubscribeParams {
    pub subscription_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeResult {
    pub subscription_id: String,
}

// ── Event payload ──

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EventPayload {
    pub subscription_id: String,
    pub event: String,
    pub data: serde_json::Value,
}

// ── Bridge command (Rust → Frontend) ──

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BridgeCommand {
    pub request_id: String,
    pub method: String,
    pub params: serde_json::Value,
}

// ── Bridge response (Frontend → Rust) ──

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeResponse {
    pub request_id: String,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
}

// ── State change notification (Frontend → Rust) ──

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StateChangeNotification {
    pub event: String,
    pub data: serde_json::Value,
}

// ── Method metadata (for api.methods / api.describe) ──

#[derive(Debug, Serialize, Clone)]
pub struct MethodInfo {
    pub name: String,
    pub description: String,
    pub category: String,
    pub bridge: bool,
}

// ── Rate limit category ──

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateCategory {
    Read,
    Write,
    TerminalIO,
}

// ── Subscription state ──

#[derive(Debug, Clone)]
pub struct Subscription {
    pub id: String,
    pub events: Vec<String>,
    pub filter: Option<SubscriptionFilter>,
}

impl Subscription {
    pub fn matches(&self, event: &str, session_id: Option<&str>) -> bool {
        if !self.events.iter().any(|e| e == event || e == "*") {
            return false;
        }
        if let Some(filter) = &self.filter {
            if let Some(filter_sid) = &filter.session_id {
                if let Some(sid) = session_id {
                    return sid == filter_sid;
                }
            }
        }
        true
    }
}


// ── Method catalog ──

pub fn method_catalog() -> Vec<MethodInfo> {
    vec![
        // auth
        MethodInfo { name: "auth.authenticate".into(), description: "Authenticate with API token".into(), category: "auth".into(), bridge: false },
        // sessions
        MethodInfo { name: "sessions.list".into(), description: "List sessions".into(), category: "sessions".into(), bridge: true },
        MethodInfo { name: "sessions.get".into(), description: "Get session details".into(), category: "sessions".into(), bridge: true },
        MethodInfo { name: "sessions.create".into(), description: "Create a new session".into(), category: "sessions".into(), bridge: true },
        MethodInfo { name: "sessions.close".into(), description: "Close a session".into(), category: "sessions".into(), bridge: true },
        MethodInfo { name: "sessions.rename".into(), description: "Rename a session".into(), category: "sessions".into(), bridge: true },
        MethodInfo { name: "sessions.set_symbol".into(), description: "Set session symbol/icon".into(), category: "sessions".into(), bridge: true },
        MethodInfo { name: "sessions.set_color".into(), description: "Set session color".into(), category: "sessions".into(), bridge: true },
        MethodInfo { name: "sessions.write".into(), description: "Write data to session PTY".into(), category: "sessions".into(), bridge: false },
        MethodInfo { name: "sessions.resize".into(), description: "Resize session terminal".into(), category: "sessions".into(), bridge: false },
        MethodInfo { name: "sessions.activate".into(), description: "Activate/focus a session".into(), category: "sessions".into(), bridge: true },
        MethodInfo { name: "sessions.reconnect".into(), description: "Reconnect a session".into(), category: "sessions".into(), bridge: true },
        MethodInfo { name: "sessions.detach".into(), description: "Detach a persistent session".into(), category: "sessions".into(), bridge: false },
        MethodInfo { name: "sessions.split".into(), description: "Split session view".into(), category: "sessions".into(), bridge: true },
        MethodInfo { name: "sessions.unsplit".into(), description: "Remove split view".into(), category: "sessions".into(), bridge: true },
        MethodInfo { name: "sessions.start_recording".into(), description: "Start recording a session".into(), category: "sessions".into(), bridge: true },
        MethodInfo { name: "sessions.stop_recording".into(), description: "Stop recording a session".into(), category: "sessions".into(), bridge: true },
        // persistent_sessions
        MethodInfo { name: "persistent_sessions.list".into(), description: "List persistent sessions".into(), category: "persistent_sessions".into(), bridge: false },
        MethodInfo { name: "persistent_sessions.attach".into(), description: "Attach to persistent session".into(), category: "persistent_sessions".into(), bridge: true },
        MethodInfo { name: "persistent_sessions.kill".into(), description: "Kill persistent session".into(), category: "persistent_sessions".into(), bridge: false },
        // projects
        MethodInfo { name: "projects.list".into(), description: "List projects".into(), category: "projects".into(), bridge: true },
        MethodInfo { name: "projects.get".into(), description: "Get project details".into(), category: "projects".into(), bridge: true },
        MethodInfo { name: "projects.create".into(), description: "Create a project".into(), category: "projects".into(), bridge: true },
        MethodInfo { name: "projects.update".into(), description: "Update a project".into(), category: "projects".into(), bridge: true },
        MethodInfo { name: "projects.delete".into(), description: "Delete a project".into(), category: "projects".into(), bridge: true },
        MethodInfo { name: "projects.activate".into(), description: "Activate a project".into(), category: "projects".into(), bridge: true },
        MethodInfo { name: "projects.reorder".into(), description: "Reorder projects".into(), category: "projects".into(), bridge: true },
        MethodInfo { name: "projects.apply_assets".into(), description: "Apply project assets".into(), category: "projects".into(), bridge: true },
        // prompts
        MethodInfo { name: "prompts.list".into(), description: "List prompts".into(), category: "prompts".into(), bridge: true },
        MethodInfo { name: "prompts.get".into(), description: "Get prompt details".into(), category: "prompts".into(), bridge: true },
        MethodInfo { name: "prompts.create".into(), description: "Create a prompt".into(), category: "prompts".into(), bridge: true },
        MethodInfo { name: "prompts.update".into(), description: "Update a prompt".into(), category: "prompts".into(), bridge: true },
        MethodInfo { name: "prompts.delete".into(), description: "Delete a prompt".into(), category: "prompts".into(), bridge: true },
        MethodInfo { name: "prompts.send".into(), description: "Send prompt to session".into(), category: "prompts".into(), bridge: true },
        MethodInfo { name: "prompts.search".into(), description: "Search prompts".into(), category: "prompts".into(), bridge: true },
        // environments
        MethodInfo { name: "environments.list".into(), description: "List environments".into(), category: "environments".into(), bridge: true },
        MethodInfo { name: "environments.get".into(), description: "Get environment details".into(), category: "environments".into(), bridge: true },
        MethodInfo { name: "environments.create".into(), description: "Create an environment".into(), category: "environments".into(), bridge: true },
        MethodInfo { name: "environments.update".into(), description: "Update an environment".into(), category: "environments".into(), bridge: true },
        MethodInfo { name: "environments.delete".into(), description: "Delete an environment".into(), category: "environments".into(), bridge: true },
        // assets
        MethodInfo { name: "assets.list".into(), description: "List assets".into(), category: "assets".into(), bridge: true },
        MethodInfo { name: "assets.get".into(), description: "Get asset details".into(), category: "assets".into(), bridge: true },
        MethodInfo { name: "assets.create".into(), description: "Create an asset".into(), category: "assets".into(), bridge: true },
        MethodInfo { name: "assets.update".into(), description: "Update an asset".into(), category: "assets".into(), bridge: true },
        MethodInfo { name: "assets.delete".into(), description: "Delete an asset".into(), category: "assets".into(), bridge: true },
        MethodInfo { name: "assets.apply".into(), description: "Apply an asset to a directory".into(), category: "assets".into(), bridge: true },
        MethodInfo { name: "assets.update_settings".into(), description: "Update asset settings".into(), category: "assets".into(), bridge: true },
        // recordings
        MethodInfo { name: "recordings.list".into(), description: "List recordings".into(), category: "recordings".into(), bridge: false },
        MethodInfo { name: "recordings.get".into(), description: "Get recording metadata".into(), category: "recordings".into(), bridge: false },
        MethodInfo { name: "recordings.load".into(), description: "Load recording with events".into(), category: "recordings".into(), bridge: false },
        MethodInfo { name: "recordings.delete".into(), description: "Delete a recording".into(), category: "recordings".into(), bridge: false },
        MethodInfo { name: "recordings.start".into(), description: "Start recording a session".into(), category: "recordings".into(), bridge: true },
        MethodInfo { name: "recordings.stop".into(), description: "Stop recording a session".into(), category: "recordings".into(), bridge: true },
        // ssh
        MethodInfo { name: "ssh.list_hosts".into(), description: "List SSH hosts".into(), category: "ssh".into(), bridge: false },
        MethodInfo { name: "ssh.connect".into(), description: "Connect to SSH host".into(), category: "ssh".into(), bridge: true },
        MethodInfo { name: "ssh.history".into(), description: "Get SSH connection history".into(), category: "ssh".into(), bridge: true },
        MethodInfo { name: "ssh.delete_history".into(), description: "Delete SSH history entry".into(), category: "ssh".into(), bridge: true },
        // files
        MethodInfo { name: "files.list".into(), description: "List directory entries".into(), category: "files".into(), bridge: false },
        MethodInfo { name: "files.read".into(), description: "Read a text file".into(), category: "files".into(), bridge: false },
        MethodInfo { name: "files.write".into(), description: "Write a text file".into(), category: "files".into(), bridge: false },
        MethodInfo { name: "files.create".into(), description: "Create a file or directory".into(), category: "files".into(), bridge: false },
        MethodInfo { name: "files.rename".into(), description: "Rename a file or directory".into(), category: "files".into(), bridge: false },
        MethodInfo { name: "files.delete".into(), description: "Delete a file or directory".into(), category: "files".into(), bridge: false },
        MethodInfo { name: "files.open_in_finder".into(), description: "Open path in file manager".into(), category: "files".into(), bridge: false },
        // ssh_files
        MethodInfo { name: "ssh_files.default_root".into(), description: "Get SSH default root dir".into(), category: "ssh_files".into(), bridge: false },
        MethodInfo { name: "ssh_files.list".into(), description: "List remote directory".into(), category: "ssh_files".into(), bridge: false },
        MethodInfo { name: "ssh_files.read".into(), description: "Read remote text file".into(), category: "ssh_files".into(), bridge: false },
        MethodInfo { name: "ssh_files.write".into(), description: "Write remote text file".into(), category: "ssh_files".into(), bridge: false },
        MethodInfo { name: "ssh_files.create".into(), description: "Create remote file/directory".into(), category: "ssh_files".into(), bridge: false },
        MethodInfo { name: "ssh_files.rename".into(), description: "Rename remote file/directory".into(), category: "ssh_files".into(), bridge: false },
        MethodInfo { name: "ssh_files.delete".into(), description: "Delete remote file/directory".into(), category: "ssh_files".into(), bridge: false },
        MethodInfo { name: "ssh_files.download".into(), description: "Download file from SSH".into(), category: "ssh_files".into(), bridge: false },
        // file viewer / embedded browser tabs
        MethodInfo { name: "file_viewer.tabs.list".into(), description: "List open file viewer/editor and embedded browser tabs, not terminal sessions".into(), category: "file_viewer".into(), bridge: true },
        MethodInfo { name: "file_viewer.tabs.open".into(), description: "Open a file viewer/editor or embedded browser tab".into(), category: "file_viewer".into(), bridge: true },
        MethodInfo { name: "file_viewer.tabs.focus".into(), description: "Focus an open file viewer/editor or embedded browser tab".into(), category: "file_viewer".into(), bridge: true },
        MethodInfo { name: "file_viewer.tabs.close".into(), description: "Close an open file viewer/editor or embedded browser tab".into(), category: "file_viewer".into(), bridge: true },
        MethodInfo { name: "browser.navigate".into(), description: "Navigate an embedded browser tab".into(), category: "browser".into(), bridge: true },
        MethodInfo { name: "browser.action".into(), description: "Run browser navigation action".into(), category: "browser".into(), bridge: true },
        MethodInfo { name: "browser.snapshot".into(), description: "Get embedded browser tab state".into(), category: "browser".into(), bridge: true },
        MethodInfo { name: "file_viewer.snapshot".into(), description: "Get active file viewer state and text content when available".into(), category: "file_viewer".into(), bridge: true },
        MethodInfo { name: "capture.screenshot".into(), description: "Capture a PNG screenshot from the active file viewer or embedded browser visual surface".into(), category: "capture".into(), bridge: true },
        // split_views
        MethodInfo { name: "split_views.list".into(), description: "List split views".into(), category: "split_views".into(), bridge: true },
        MethodInfo { name: "split_views.create".into(), description: "Create a split view".into(), category: "split_views".into(), bridge: true },
        MethodInfo { name: "split_views.update".into(), description: "Update split view".into(), category: "split_views".into(), bridge: true },
        MethodInfo { name: "split_views.close".into(), description: "Close a split view".into(), category: "split_views".into(), bridge: true },
        // ui
        MethodInfo { name: "ui.state".into(), description: "Get UI state".into(), category: "ui".into(), bridge: true },
        MethodInfo { name: "ui.activate_session".into(), description: "Activate a session in UI".into(), category: "ui".into(), bridge: true },
        MethodInfo { name: "ui.toggle_panel".into(), description: "Toggle a UI panel".into(), category: "ui".into(), bridge: true },
        MethodInfo { name: "ui.command_palette".into(), description: "Open/close command palette".into(), category: "ui".into(), bridge: true },
        MethodInfo { name: "ui.navigate_session".into(), description: "Navigate to next/prev session".into(), category: "ui".into(), bridge: true },
        MethodInfo { name: "ui.get_theme".into(), description: "Get the current UI theme".into(), category: "ui".into(), bridge: true },
        MethodInfo { name: "ui.set_theme".into(), description: "Set the UI theme".into(), category: "ui".into(), bridge: true },
        // shell integration (OSC 133)
        MethodInfo { name: "shell.read_screen".into(), description: "Read the visible terminal viewport content".into(), category: "shell".into(), bridge: true },
        MethodInfo { name: "shell.read_scrollback".into(), description: "Read lines from the terminal scrollback buffer".into(), category: "shell".into(), bridge: true },
        MethodInfo { name: "shell.get_status".into(), description: "Get session shell status (idle/running, cwd, exit info)".into(), category: "shell".into(), bridge: true },
        MethodInfo { name: "shell.command_history".into(), description: "Get recent completed command results".into(), category: "shell".into(), bridge: true },
        MethodInfo { name: "shell.last_result".into(), description: "Get the most recent completed command result".into(), category: "shell".into(), bridge: true },
        // app
        MethodInfo { name: "app.info".into(), description: "Get app info".into(), category: "app".into(), bridge: false },
        MethodInfo { name: "app.state".into(), description: "Get full persisted state snapshot".into(), category: "app".into(), bridge: true },
        MethodInfo { name: "app.subscribe".into(), description: "Subscribe to events".into(), category: "app".into(), bridge: false },
        MethodInfo { name: "app.unsubscribe".into(), description: "Unsubscribe from events".into(), category: "app".into(), bridge: false },
        // api
        MethodInfo { name: "api.methods".into(), description: "List all API methods".into(), category: "api".into(), bridge: false },
        MethodInfo { name: "api.describe".into(), description: "Describe an API method".into(), category: "api".into(), bridge: false },
    ]
}

pub fn is_bridge_method(method: &str) -> bool {
    // Methods that must be dispatched through the frontend bridge
    matches!(method,
        "sessions.list" | "sessions.get" | "sessions.create" | "sessions.close" |
        "sessions.rename" | "sessions.set_symbol" | "sessions.set_color" |
        "sessions.activate" | "sessions.reconnect" | "sessions.split" | "sessions.unsplit" |
        "sessions.start_recording" | "sessions.stop_recording" |
        "persistent_sessions.attach" |
        "projects.list" | "projects.get" | "projects.create" | "projects.update" |
        "projects.delete" | "projects.activate" | "projects.reorder" | "projects.apply_assets" |
        "prompts.list" | "prompts.get" | "prompts.create" | "prompts.update" |
        "prompts.delete" | "prompts.send" | "prompts.search" |
        "environments.list" | "environments.get" | "environments.create" |
        "environments.update" | "environments.delete" |
        "assets.list" | "assets.get" | "assets.create" | "assets.update" |
        "assets.delete" | "assets.apply" | "assets.update_settings" |
        "recordings.start" | "recordings.stop" |
        "ssh.connect" | "ssh.history" | "ssh.delete_history" |
        "file_viewer.tabs.list" | "file_viewer.tabs.open" | "file_viewer.tabs.focus" | "file_viewer.tabs.close" |
        "workspace.tabs.list" | "workspace.tabs.open" | "workspace.tabs.focus" | "workspace.tabs.close" |
        "browser.navigate" | "browser.action" | "browser.snapshot" |
        "file_viewer.snapshot" |
        "capture.screenshot" |
        "split_views.list" | "split_views.create" | "split_views.update" | "split_views.close" |
        "ui.state" | "ui.activate_session" | "ui.toggle_panel" | "ui.command_palette" |
        "ui.navigate_session" | "ui.get_theme" | "ui.set_theme" |
        "app.state" |
        "shell.command_history" | "shell.last_result" |
        "shell.read_screen" | "shell.read_scrollback" | "shell.get_status"
    )
}

pub fn rate_category(method: &str) -> RateCategory {
    match method {
        "sessions.write" => RateCategory::TerminalIO,
        m if m.ends_with(".list") || m.ends_with(".get") || m.ends_with(".search")
            || m == "app.info" || m == "app.state" || m == "ui.state"
            || m == "browser.snapshot" || m == "file_viewer.snapshot"
            || m == "capture.screenshot"
            || m == "api.methods" || m == "api.describe"
            || m == "auth.authenticate"
            || m == "recordings.load" || m == "files.read" || m == "ssh_files.read"
            || m == "ssh_files.default_root"
            || m == "ui.get_theme"
            || m == "shell.read_screen" || m == "shell.read_scrollback"
            || m == "shell.get_status" || m == "shell.command_history"
            || m == "shell.last_result" => RateCategory::Read,
        _ => RateCategory::Write,
    }
}
