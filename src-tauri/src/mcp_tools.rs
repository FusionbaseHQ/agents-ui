use crate::api_handlers::{self, HandlerContext};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, Notify};

// ── Output buffer types ──

pub struct OutputBuffer {
    pub chunks: Vec<String>,
    pub total_bytes: usize,
}

const MAX_BUFFER_BYTES: usize = 200 * 1024; // 200KB per session

impl OutputBuffer {
    pub fn new() -> Self {
        Self {
            chunks: Vec::new(),
            total_bytes: 0,
        }
    }

    pub fn append(&mut self, text: String) {
        let len = text.len();
        self.chunks.push(text);
        self.total_bytes += len;
        // Evict oldest chunks if over limit
        while self.total_bytes > MAX_BUFFER_BYTES && !self.chunks.is_empty() {
            let removed = self.chunks.remove(0);
            self.total_bytes -= removed.len();
        }
    }

    pub fn read_and_clear(&mut self, raw: bool) -> String {
        let text: String = self.chunks.drain(..).collect();
        self.total_bytes = 0;
        if raw {
            text
        } else {
            strip_ansi(&text)
        }
    }

    pub fn is_empty(&self) -> bool {
        self.total_bytes == 0
    }
}

pub type OutputBuffers = Arc<Mutex<HashMap<String, OutputBuffer>>>;

pub type SessionNotifications = Arc<Mutex<HashMap<String, Arc<Notify>>>>;

pub async fn session_notifier(notifications: &SessionNotifications, session_id: &str) -> Arc<Notify> {
    let mut map = notifications.lock().await;
    map.entry(session_id.to_string())
        .or_insert_with(|| Arc::new(Notify::new()))
        .clone()
}

pub async fn notify_session(notifications: &SessionNotifications, session_id: &str) {
    let notify = {
        let map = notifications.lock().await;
        map.get(session_id).cloned()
    };
    if let Some(notify) = notify {
        notify.notify_waiters();
    }
}

// ── Idle notification buffer types ──

pub type IdleNotifications = Arc<Mutex<HashMap<String, Vec<u64>>>>;

pub const MAX_IDLE_NOTIFICATIONS_PER_SESSION: usize = 100;

// ── Command completion buffer types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCompletion {
    pub command: Option<String>,
    pub exit_code: Option<i64>,
    pub output: Option<String>,
    pub duration_ms: Option<i64>,
}

pub type CommandCompletionBuffers = Arc<Mutex<HashMap<String, Vec<CommandCompletion>>>>;

pub const MAX_COMPLETIONS_PER_SESSION: usize = 50;

pub fn strip_ansi(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            // Skip ESC sequences
            if let Some(&next) = chars.peek() {
                if next == '[' {
                    chars.next(); // consume '['
                    // Read until we hit a letter (final byte of CSI sequence)
                    while let Some(&c) = chars.peek() {
                        chars.next();
                        if c.is_ascii_alphabetic() || c == '~' {
                            break;
                        }
                    }
                } else if next == ']' {
                    chars.next(); // consume ']'
                    // OSC sequence: read until ST (ESC \ or BEL)
                    while let Some(&c) = chars.peek() {
                        chars.next();
                        if c == '\x07' {
                            break;
                        }
                        if c == '\x1b' {
                            if let Some(&n) = chars.peek() {
                                if n == '\\' {
                                    chars.next();
                                    break;
                                }
                            }
                        }
                    }
                } else if next == '(' || next == ')' {
                    chars.next(); // consume designator
                    chars.next(); // consume charset
                } else {
                    chars.next(); // consume single char after ESC
                }
            }
        } else {
            result.push(ch);
        }
    }
    result
}

// ── Tool definition ──

pub fn tool_list() -> Vec<Value> {
    vec![
        // Sessions
        tool_def("list_sessions", "List all active terminal sessions in the workspace. Returns session IDs, names, working directories, and status. Use projectId to filter sessions belonging to a specific project.", json!({
            "type": "object",
            "properties": {
                "projectId": { "type": "string", "description": "Filter by project ID" }
            }
        })),
        tool_def("get_session", "Get detailed information about a specific terminal session, including its name, working directory, process status, and associated project.", json!({
            "type": "object",
            "properties": {
                "sessionId": { "type": "string", "description": "Session ID" }
            },
            "required": ["sessionId"]
        })),
        tool_def("create_session", "Create a new terminal session (PTY shell) in a project. Opens a ready-to-use shell. Use send_command to execute commands in it, and wait_for_output to capture results.", json!({
            "type": "object",
            "properties": {
                "projectId": { "type": "string", "description": "Project ID to create session in" },
                "name": { "type": "string", "description": "Session name" },
                "command": { "type": "string", "description": "Initial command to run on session start" },
                "cwd": { "type": "string", "description": "Working directory for the shell" }
            },
            "required": ["projectId"]
        })),
        tool_def("close_session", "Close and terminate a terminal session. The session's shell process is killed and removed from the workspace.", json!({
            "type": "object",
            "properties": {
                "sessionId": { "type": "string", "description": "Session ID" }
            },
            "required": ["sessionId"]
        })),
        tool_def("rename_session", "Rename a terminal session. Use this after inspecting the session output so the name reflects the work currently happening in that terminal.", json!({
            "type": "object",
            "properties": {
                "sessionId": { "type": "string", "description": "Session ID" },
                "name": { "type": "string", "description": "New semantic session name" }
            },
            "required": ["sessionId", "name"]
        })),
        tool_def("write_to_session", "Write raw data (keystrokes/text) directly to a session's terminal PTY. IMPORTANT: To execute a command, you MUST append \\r at the end (e.g. \"ls\\r\"). Without \\r the text is typed but not submitted. Prefer send_command for running commands.", json!({
            "type": "object",
            "properties": {
                "sessionId": { "type": "string", "description": "Session ID" },
                "data": { "type": "string", "description": "Data to write. Use \\r for Enter/Return, \\n for newline, \\t for tab. Example: to run 'ls -la', send \"ls -la\\r\"" }
            },
            "required": ["sessionId", "data"]
        })),
        tool_def("send_command", "Execute a shell command in a terminal session. Sends the command text followed by Enter to submit it. This is the preferred way to run commands. Use wait_for_output or read_session_output afterward to capture results.", json!({
            "type": "object",
            "properties": {
                "sessionId": { "type": "string", "description": "Session ID" },
                "command": { "type": "string", "description": "The command to execute (e.g. \"ls -la\", \"git status\"). Enter is sent automatically." }
            },
            "required": ["sessionId", "command"]
        })),
        tool_def("read_session_output", "Read and consume buffered terminal output from a session. Returns all output since the last read. The buffer is cleared after reading. Use raw=true to preserve ANSI escape codes for color/formatting.", json!({
            "type": "object",
            "properties": {
                "sessionId": { "type": "string", "description": "Session ID" },
                "raw": { "type": "boolean", "description": "If true, return raw output with ANSI escape codes. Default: false (stripped)" }
            },
            "required": ["sessionId"]
        })),
        tool_def("wait_for_output", "Wait for new terminal output from a session, with configurable timeout. Blocks until output is available or timeout expires. Use after send_command to capture command results. Returns the output text.", json!({
            "type": "object",
            "properties": {
                "sessionId": { "type": "string", "description": "Session ID" },
                "timeout": { "type": "number", "description": "Max wait time in milliseconds (default: 5000)" }
            },
            "required": ["sessionId"]
        })),
        tool_def("activate_session", "Bring a terminal session into focus in the UI. Switches the visible terminal to this session so the user can see its output.", json!({
            "type": "object",
            "properties": {
                "sessionId": { "type": "string", "description": "Session ID" }
            },
            "required": ["sessionId"]
        })),
        // Projects
        tool_def("list_projects", "List all projects in the workspace. Returns project IDs, titles, and base paths. Projects are containers that group terminal sessions together.", json!({
            "type": "object",
            "properties": {}
        })),
        tool_def("create_project", "Create a new project in the workspace. A project groups related terminal sessions and has an optional base directory path for file operations.", json!({
            "type": "object",
            "properties": {
                "title": { "type": "string", "description": "Project title" },
                "basePath": { "type": "string", "description": "Base directory path for the project" },
                "sshTarget": { "type": "string", "description": "SSH host alias or user@host for SSH-based projects. When set, new terminals open SSH sessions to this host." },
                "sshRemotePath": { "type": "string", "description": "Remote working directory on the SSH host. Used as the default directory for new SSH sessions." }
            },
            "required": ["title"]
        })),
        tool_def("get_project", "Get detailed information about a specific project, including its title, base path, and associated sessions.", json!({
            "type": "object",
            "properties": {
                "projectId": { "type": "string", "description": "Project ID" }
            },
            "required": ["projectId"]
        })),
        tool_def("update_project", "Update a project's title, base path, or SSH settings.", json!({
            "type": "object",
            "properties": {
                "projectId": { "type": "string", "description": "Project ID" },
                "title": { "type": "string", "description": "New project title" },
                "basePath": { "type": "string", "description": "New base directory path" },
                "sshTarget": { "type": ["string", "null"], "description": "SSH host alias or user@host. Set to null to convert back to a local project." },
                "sshRemotePath": { "type": ["string", "null"], "description": "Remote working directory on the SSH host." }
            },
            "required": ["projectId"]
        })),
        tool_def("delete_project", "Delete a project and all its associated sessions from the workspace.", json!({
            "type": "object",
            "properties": {
                "projectId": { "type": "string", "description": "Project ID" }
            },
            "required": ["projectId"]
        })),
        tool_def("activate_project", "Switch the active project in the UI. Brings the project's sessions into view.", json!({
            "type": "object",
            "properties": {
                "projectId": { "type": "string", "description": "Project ID" }
            },
            "required": ["projectId"]
        })),
        tool_def("reorder_projects", "Reorder projects in the sidebar by providing the full list of project IDs in the desired display order.", json!({
            "type": "object",
            "properties": {
                "projectIds": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Ordered list of all project IDs"
                }
            },
            "required": ["projectIds"]
        })),
        // SSH
        tool_def("ssh_connect", "Connect to a remote host via SSH and create a terminal session for it. Opens an SSH connection in a new PTY session. Use send_command to run remote commands.", json!({
            "type": "object",
            "properties": {
                "projectId": { "type": "string", "description": "Project ID" },
                "target": { "type": "string", "description": "SSH target (user@host)" },
                "remoteDir": { "type": "string", "description": "Remote working directory to start in" },
                "name": { "type": "string", "description": "Session name" }
            },
            "required": ["projectId", "target"]
        })),
        tool_def("ssh_list_hosts", "List available SSH hosts from the user's ~/.ssh/config. Returns host aliases that can be used with ssh_connect.", json!({
            "type": "object",
            "properties": {}
        })),
        // Files — Local
        tool_def("list_files", "List files and directories at a local path. Returns names, types (file/directory), and sizes. Useful for browsing the project file tree.", json!({
            "type": "object",
            "properties": {
                "root": { "type": "string", "description": "Root directory (absolute path)" },
                "path": { "type": "string", "description": "Relative path within root to list" }
            },
            "required": ["root", "path"]
        })),
        tool_def("read_file", "Read the full contents of a local text file. Returns the file content as a string.", json!({
            "type": "object",
            "properties": {
                "root": { "type": "string", "description": "Root directory (absolute path)" },
                "path": { "type": "string", "description": "Relative file path within root" }
            },
            "required": ["root", "path"]
        })),
        tool_def("write_file", "Write content to a local text file. Creates the file if it doesn't exist, or overwrites if it does.", json!({
            "type": "object",
            "properties": {
                "root": { "type": "string", "description": "Root directory (absolute path)" },
                "path": { "type": "string", "description": "Relative file path within root" },
                "content": { "type": "string", "description": "File content to write" }
            },
            "required": ["root", "path", "content"]
        })),
        // Files — SSH
        tool_def("ssh_files_list", "List files and directories on a remote SSH host. Requires an active SSH connection to the host.", json!({
            "type": "object",
            "properties": {
                "host": { "type": "string", "description": "SSH host (from ssh_list_hosts or ssh_connect)" },
                "root": { "type": "string", "description": "Root directory on remote host" },
                "path": { "type": "string", "description": "Relative path within root to list" }
            },
            "required": ["host", "root", "path"]
        })),
        tool_def("ssh_files_read", "Read the contents of a text file on a remote SSH host.", json!({
            "type": "object",
            "properties": {
                "host": { "type": "string", "description": "SSH host" },
                "root": { "type": "string", "description": "Root directory on remote host" },
                "path": { "type": "string", "description": "Relative file path within root" }
            },
            "required": ["host", "root", "path"]
        })),
        tool_def("ssh_files_write", "Write content to a text file on a remote SSH host. Creates or overwrites the file.", json!({
            "type": "object",
            "properties": {
                "host": { "type": "string", "description": "SSH host" },
                "root": { "type": "string", "description": "Root directory on remote host" },
                "path": { "type": "string", "description": "Relative file path within root" },
                "content": { "type": "string", "description": "File content to write" }
            },
            "required": ["host", "root", "path", "content"]
        })),
        // File viewer / embedded browser tabs
        tool_def("list_file_viewer_tabs", "List open file-viewer/editor tabs and embedded browser tabs. This is not for terminal sessions; use list_sessions for terminal tabs. Returns tab IDs, active tab, file paths, browser URLs, viewer modes, dirty state, and loading/errors.", json!({
            "type": "object",
            "properties": {}
        })),
        tool_def("open_file_viewer_tab", "Open a file-viewer/editor tab or embedded browser tab. Use kind=file with path to show a file, or kind=browser with url to open an embedded browser tab. This does not create terminal sessions.", json!({
            "type": "object",
            "properties": {
                "kind": { "type": "string", "enum": ["file", "browser"], "description": "Tab kind to open" },
                "path": { "type": "string", "description": "File path for kind=file" },
                "url": { "type": "string", "description": "URL for kind=browser" },
                "title": { "type": "string", "description": "Optional browser tab title" },
                "mode": { "type": "string", "enum": ["auto", "text", "image", "bytes", "markdown", "json", "csv", "xlsx"], "description": "File viewer mode for kind=file" }
            },
            "required": ["kind"]
        })),
        tool_def("focus_file_viewer_tab", "Focus an open file-viewer/editor or embedded browser tab by tabId. Browser tab IDs look like browser://1; browser labels like browser-1 are also accepted.", json!({
            "type": "object",
            "properties": {
                "tabId": { "type": "string", "description": "File-viewer/editor tab ID, file path, browser tab ID, or browser label" }
            },
            "required": ["tabId"]
        })),
        tool_def("close_file_viewer_tab", "Close an open file-viewer/editor or embedded browser tab. Pass force=true to close locked tabs or discard unsaved editor changes.", json!({
            "type": "object",
            "properties": {
                "tabId": { "type": "string", "description": "File-viewer/editor tab ID, file path, browser tab ID, or browser label" },
                "force": { "type": "boolean", "description": "Close locked or dirty tabs" }
            },
            "required": ["tabId"]
        })),
        tool_def("browser_navigate", "Navigate an embedded browser tab inside the file-viewer area. If tabId is omitted, the active browser tab is used, or a new browser tab is opened when the file viewer/editor is not mounted.", json!({
            "type": "object",
            "properties": {
                "tabId": { "type": "string", "description": "Optional browser tab ID or label" },
                "url": { "type": "string", "description": "Destination URL" },
                "activate": { "type": "boolean", "description": "Whether to focus the browser tab. Default: true" }
            },
            "required": ["url"]
        })),
        tool_def("browser_action", "Run a navigation action in an embedded browser tab.", json!({
            "type": "object",
            "properties": {
                "tabId": { "type": "string", "description": "Optional browser tab ID or label" },
                "action": { "type": "string", "enum": ["back", "forward", "reload"], "description": "Browser action" }
            },
            "required": ["action"]
        })),
        tool_def("browser_snapshot", "Get embedded browser tab state, including active browser tab, labels, and URLs. Pass tabId to inspect one browser tab.", json!({
            "type": "object",
            "properties": {
                "tabId": { "type": "string", "description": "Optional browser tab ID or label" }
            }
        })),
        tool_def("file_viewer_snapshot", "Get the active file viewer/editor tab metadata and, for text editor tabs, current unsaved text content. Pass maxContentLength to cap returned text.", json!({
            "type": "object",
            "properties": {
                "tabId": { "type": "string", "description": "Optional file tab ID/path" },
                "path": { "type": "string", "description": "Optional file path" },
                "maxContentLength": { "type": "number", "description": "Maximum text characters to return for editable text tabs (default: 20000, max: 200000)" }
            }
        })),
        tool_def("capture_screenshot", "Capture a PNG screenshot from the active file-viewer or embedded-browser visual surface and return it as MCP image content plus JSON metadata. Supports image tabs, rendered PDF pages, and browser tabs. Browser screenshots use native WKWebView capture on macOS, so they capture only the browser viewport and do not require Screen Recording permission. If the target is closed, hidden, loading, or replaced during capture, the tool returns structured failure text with a recovery hint.", json!({
            "type": "object",
            "properties": {
                "target": { "type": "string", "enum": ["file_viewer", "browser"], "description": "Capture target. Defaults to the active file-viewer/browser tab." },
                "tabId": { "type": "string", "description": "Optional file-viewer tab ID/path or browser tab ID/label" },
                "path": { "type": "string", "description": "Optional file path for a file-viewer tab" },
                "maxWidth": { "type": "number", "description": "Maximum output PNG width in pixels (default 1600, max 4096)" },
                "maxHeight": { "type": "number", "description": "Maximum output PNG height in pixels (default 1600, max 4096)" }
            }
        })),
        // Prompts
        tool_def("list_prompts", "List all saved command prompts/snippets. Prompts are reusable command templates that can be sent to terminal sessions.", json!({
            "type": "object",
            "properties": {}
        })),
        tool_def("send_prompt", "Send a saved prompt or direct content to a terminal session. Can send by prompt ID (for saved prompts) or by providing content directly.", json!({
            "type": "object",
            "properties": {
                "sessionId": { "type": "string", "description": "Session ID to send the prompt to" },
                "promptId": { "type": "string", "description": "Prompt ID of a saved prompt to send" },
                "content": { "type": "string", "description": "Direct content to send (alternative to promptId)" },
                "mode": { "type": "string", "description": "Send mode" }
            },
            "required": ["sessionId"]
        })),
        // UI / App
        tool_def("get_app_info", "Get application info including version, platform, and runtime details.", json!({
            "type": "object",
            "properties": {}
        })),
        tool_def("get_ui_state", "Get the current UI state including the active session, active project, theme, visible panels, and window layout.", json!({
            "type": "object",
            "properties": {}
        })),
        tool_def("get_theme", "Get the current UI theme.", json!({
            "type": "object",
            "properties": {}
        })),
        tool_def("set_theme", "Set the UI theme. Available themes: dawn, sepia, ember, slate, midnight, cobalt, neon, forest.", json!({
            "type": "object",
            "properties": {
                "theme": { "type": "string", "description": "Theme name (dawn, sepia, ember, slate, midnight, cobalt, neon, forest)" }
            },
            "required": ["theme"]
        })),
        // Shell integration
        tool_def("wait_for_command_complete", "Wait for a shell command to finish executing (detected via OSC 133 shell integration markers). Blocks until the command's exit marker fires or timeout expires. Returns structured result with command text, exit code, output, and duration. Requires shell integration to be active in the session.", json!({
            "type": "object",
            "properties": {
                "sessionId": { "type": "string", "description": "Session ID" },
                "timeout": { "type": "number", "description": "Max wait time in milliseconds (default: 30000)" }
            },
            "required": ["sessionId"]
        })),
        tool_def("get_command_history", "Get recent completed command results from a session (via OSC 133 shell integration). Returns an array of structured results with command text, exit code, output, and duration.", json!({
            "type": "object",
            "properties": {
                "sessionId": { "type": "string", "description": "Session ID" },
                "limit": { "type": "number", "description": "Max number of results to return (default: 20)" }
            },
            "required": ["sessionId"]
        })),
        tool_def("get_last_command_result", "Get the most recent completed command result from a session (via OSC 133 shell integration). Returns a single structured result with command text, exit code, output, and duration, or null if no commands have completed.", json!({
            "type": "object",
            "properties": {
                "sessionId": { "type": "string", "description": "Session ID" }
            },
            "required": ["sessionId"]
        })),
        // Agent assistance
        tool_def("read_screen", "Read the visible terminal viewport content. Returns the currently displayed text, dimensions, and cursor position. Useful for understanding what the user or a running program is showing right now.", json!({
            "type": "object",
            "properties": {
                "sessionId": { "type": "string", "description": "Session ID" }
            },
            "required": ["sessionId"]
        })),
        tool_def("read_scrollback", "Read lines from the terminal scrollback buffer. Returns historical output that has scrolled off the visible viewport. Use offset to page through history.", json!({
            "type": "object",
            "properties": {
                "sessionId": { "type": "string", "description": "Session ID" },
                "lines": { "type": "number", "description": "Number of lines to read (default: 100)" },
                "offset": { "type": "number", "description": "Line offset from the end of the buffer. 0 = most recent lines (default: 0)" }
            },
            "required": ["sessionId"]
        })),
        tool_def("get_session_status", "Get the current status of a terminal session including the shell program (e.g. nu, zsh), shell state (idle/running/unknown), working directory, and exit info. Uses OSC 133 shell integration markers when available. Note: nu shell may report 'idle' during blocking builtins like sleep — use read_screen to verify.", json!({
            "type": "object",
            "properties": {
                "sessionId": { "type": "string", "description": "Session ID" }
            },
            "required": ["sessionId"]
        })),
        tool_def("send_signal", "Send a control signal to a terminal session. Sends the corresponding control character to the PTY: SIGINT (Ctrl+C), EOF (Ctrl+D), SIGTSTP (Ctrl+Z), SIGQUIT (Ctrl+\\). Works in any shell.", json!({
            "type": "object",
            "properties": {
                "sessionId": { "type": "string", "description": "Session ID" },
                "signal": { "type": "string", "enum": ["SIGINT", "EOF", "SIGTSTP", "SIGQUIT"], "description": "Signal to send" }
            },
            "required": ["sessionId", "signal"]
        })),
        tool_def("wait_for_idle", "Wait for a terminal session to return to an idle shell prompt. Blocks until an OSC 133 'A' (prompt start) marker is received or timeout expires. Requires shell integration. Note: nu shell may not re-emit prompt markers after SIGINT — if this times out, fall back to polling get_session_status.", json!({
            "type": "object",
            "properties": {
                "sessionId": { "type": "string", "description": "Session ID" },
                "timeout": { "type": "number", "description": "Max wait time in milliseconds (default: 30000)" }
            },
            "required": ["sessionId"]
        })),
    ]
}

fn tool_def(name: &str, description: &str, input_schema: Value) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema
    })
}

// ── Tool name → API method mapping ──

fn tool_to_method(name: &str) -> Option<&'static str> {
    match name {
        "list_sessions" => Some("sessions.list"),
        "get_session" => Some("sessions.get"),
        "create_session" => Some("sessions.create"),
        "close_session" => Some("sessions.close"),
        "rename_session" => Some("sessions.rename"),
        "write_to_session" => Some("sessions.write"),
        "send_command" => None, // handled as special case in call_tool
        "activate_session" => Some("sessions.activate"),
        "list_projects" => Some("projects.list"),
        "get_project" => Some("projects.get"),
        "create_project" => Some("projects.create"),
        "update_project" => Some("projects.update"),
        "delete_project" => Some("projects.delete"),
        "activate_project" => Some("projects.activate"),
        "reorder_projects" => Some("projects.reorder"),
        "ssh_connect" => Some("ssh.connect"),
        "ssh_list_hosts" => Some("ssh.list_hosts"),
        "list_files" => Some("files.list"),
        "read_file" => Some("files.read"),
        "write_file" => Some("files.write"),
        "ssh_files_list" => Some("ssh_files.list"),
        "ssh_files_read" => Some("ssh_files.read"),
        "ssh_files_write" => Some("ssh_files.write"),
        "list_file_viewer_tabs" => Some("file_viewer.tabs.list"),
        "open_file_viewer_tab" => Some("file_viewer.tabs.open"),
        "focus_file_viewer_tab" => Some("file_viewer.tabs.focus"),
        "close_file_viewer_tab" => Some("file_viewer.tabs.close"),
        "browser_navigate" => Some("browser.navigate"),
        "browser_action" => Some("browser.action"),
        "browser_snapshot" => Some("browser.snapshot"),
        "file_viewer_snapshot" => Some("file_viewer.snapshot"),
        "capture_screenshot" => Some("capture.screenshot"),
        "list_prompts" => Some("prompts.list"),
        "send_prompt" => Some("prompts.send"),
        "get_app_info" => Some("app.info"),
        "get_ui_state" => Some("ui.state"),
        "get_theme" => Some("ui.get_theme"),
        "set_theme" => Some("ui.set_theme"),
        "wait_for_command_complete" => None, // handled as special case in call_tool
        "get_command_history" => Some("shell.command_history"),
        "get_last_command_result" => Some("shell.last_result"),
        "read_screen" => Some("shell.read_screen"),
        "read_scrollback" => Some("shell.read_scrollback"),
        "get_session_status" => Some("shell.get_status"),
        "send_signal" => None,     // handled as special case in call_tool
        "wait_for_idle" => None,   // handled as special case in call_tool
        _ => None,
    }
}

// ── Map tool args to API params ──

fn map_params(name: &str, args: &Value) -> Value {
    match name {
        "list_sessions" => json!({ "projectId": args.get("projectId") }),
        "get_session" => json!({ "id": args.get("sessionId") }),
        "create_session" => {
            let mut p = json!({ "projectId": args.get("projectId") });
            if let Some(v) = args.get("name") { p["name"] = v.clone(); }
            if let Some(v) = args.get("command") { p["command"] = v.clone(); }
            if let Some(v) = args.get("cwd") { p["cwd"] = v.clone(); }
            p
        },
        "close_session" => json!({ "id": args.get("sessionId") }),
        "rename_session" => json!({ "id": args.get("sessionId"), "name": args.get("name") }),
        "write_to_session" => json!({ "id": args.get("sessionId"), "data": args.get("data") }),
        "send_command" => json!({}), // handled as special case in call_tool
        "activate_session" => json!({ "id": args.get("sessionId") }),
        "list_projects" => json!({}),
        "get_project" => json!({ "id": args.get("projectId") }),
        "create_project" => {
            let mut p = json!({ "title": args.get("title") });
            if let Some(v) = args.get("basePath") { p["basePath"] = v.clone(); }
            if let Some(v) = args.get("sshTarget") { p["sshTarget"] = v.clone(); }
            if let Some(v) = args.get("sshRemotePath") { p["sshRemotePath"] = v.clone(); }
            p
        },
        "update_project" => {
            let mut p = json!({ "id": args.get("projectId") });
            if let Some(v) = args.get("title") { p["title"] = v.clone(); }
            if let Some(v) = args.get("basePath") { p["basePath"] = v.clone(); }
            if let Some(v) = args.get("sshTarget") { p["sshTarget"] = v.clone(); }
            if let Some(v) = args.get("sshRemotePath") { p["sshRemotePath"] = v.clone(); }
            p
        },
        "delete_project" => json!({ "id": args.get("projectId") }),
        "activate_project" => json!({ "id": args.get("projectId") }),
        "reorder_projects" => json!({ "ids": args.get("projectIds") }),
        "ssh_connect" => {
            let mut p = json!({ "projectId": args.get("projectId"), "target": args.get("target") });
            if let Some(v) = args.get("remoteDir") { p["remoteDir"] = v.clone(); }
            if let Some(v) = args.get("name") { p["name"] = v.clone(); }
            p
        },
        "ssh_list_hosts" => json!({}),
        "list_files" => json!({ "root": args.get("root"), "path": args.get("path") }),
        "read_file" => json!({ "root": args.get("root"), "path": args.get("path") }),
        "write_file" => json!({ "root": args.get("root"), "path": args.get("path"), "content": args.get("content") }),
        "ssh_files_list" => json!({ "host": args.get("host"), "root": args.get("root"), "path": args.get("path") }),
        "ssh_files_read" => json!({ "host": args.get("host"), "root": args.get("root"), "path": args.get("path") }),
        "ssh_files_write" => json!({ "host": args.get("host"), "root": args.get("root"), "path": args.get("path"), "content": args.get("content") }),
        "list_file_viewer_tabs" => json!({}),
        "open_file_viewer_tab" => {
            let mut p = json!({ "kind": args.get("kind") });
            if let Some(v) = args.get("path") { p["path"] = v.clone(); }
            if let Some(v) = args.get("url") { p["url"] = v.clone(); }
            if let Some(v) = args.get("title") { p["title"] = v.clone(); }
            if let Some(v) = args.get("mode") { p["mode"] = v.clone(); }
            p
        },
        "focus_file_viewer_tab" => json!({ "tabId": args.get("tabId") }),
        "close_file_viewer_tab" => {
            let mut p = json!({ "tabId": args.get("tabId") });
            if let Some(v) = args.get("force") { p["force"] = v.clone(); }
            p
        },
        "browser_navigate" => {
            let mut p = json!({ "url": args.get("url") });
            if let Some(v) = args.get("tabId") { p["tabId"] = v.clone(); }
            if let Some(v) = args.get("activate") { p["activate"] = v.clone(); }
            p
        },
        "browser_action" => {
            let mut p = json!({ "action": args.get("action") });
            if let Some(v) = args.get("tabId") { p["tabId"] = v.clone(); }
            p
        },
        "browser_snapshot" => {
            let mut p = json!({});
            if let Some(v) = args.get("tabId") { p["tabId"] = v.clone(); }
            p
        },
        "file_viewer_snapshot" => {
            let mut p = json!({});
            if let Some(v) = args.get("tabId") { p["tabId"] = v.clone(); }
            if let Some(v) = args.get("path") { p["path"] = v.clone(); }
            if let Some(v) = args.get("maxContentLength") { p["maxContentLength"] = v.clone(); }
            p
        },
        "capture_screenshot" => {
            let mut p = json!({});
            if let Some(v) = args.get("target") { p["target"] = v.clone(); }
            if let Some(v) = args.get("tabId") { p["tabId"] = v.clone(); }
            if let Some(v) = args.get("path") { p["path"] = v.clone(); }
            if let Some(v) = args.get("maxWidth") { p["maxWidth"] = v.clone(); }
            if let Some(v) = args.get("maxHeight") { p["maxHeight"] = v.clone(); }
            p
        },
        "list_prompts" => json!({}),
        "send_prompt" => {
            let mut p = json!({ "sessionId": args.get("sessionId") });
            if let Some(v) = args.get("promptId") { p["promptId"] = v.clone(); }
            if let Some(v) = args.get("content") { p["content"] = v.clone(); }
            if let Some(v) = args.get("mode") { p["mode"] = v.clone(); }
            p
        },
        "get_app_info" => json!({}),
        "get_ui_state" => json!({}),
        "get_theme" => json!({}),
        "set_theme" => json!({ "theme": args.get("theme") }),
        "wait_for_command_complete" => json!({}), // handled as special case
        "get_command_history" => {
            let mut p = json!({ "sessionId": args.get("sessionId") });
            if let Some(v) = args.get("limit") { p["limit"] = v.clone(); }
            p
        },
        "get_last_command_result" => json!({ "sessionId": args.get("sessionId") }),
        "read_screen" => json!({ "sessionId": args.get("sessionId") }),
        "read_scrollback" => {
            let mut p = json!({ "sessionId": args.get("sessionId") });
            if let Some(v) = args.get("lines") { p["lines"] = v.clone(); }
            if let Some(v) = args.get("offset") { p["offset"] = v.clone(); }
            p
        },
        "get_session_status" => json!({ "sessionId": args.get("sessionId") }),
        "send_signal" => json!({}),     // handled as special case
        "wait_for_idle" => json!({}),   // handled as special case
        _ => args.clone(),
    }
}

// ── Tool call dispatch ──

pub async fn call_tool(
    ctx: &Arc<HandlerContext>,
    buffers: &OutputBuffers,
    completion_buffers: &CommandCompletionBuffers,
    idle_notifications: &IdleNotifications,
    output_waiters: &SessionNotifications,
    completion_waiters: &SessionNotifications,
    idle_waiters: &SessionNotifications,
    name: &str,
    args: Value,
) -> Result<Value, String> {
    // Special tools that don't go through api_handlers::dispatch
    match name {
        "read_session_output" => {
            let session_id = args.get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or("Missing required parameter: sessionId")?;
            let raw = args.get("raw").and_then(|v| v.as_bool()).unwrap_or(false);
            let mut bufs = buffers.lock().await;
            let text = if let Some(buf) = bufs.get_mut(session_id) {
                buf.read_and_clear(raw)
            } else {
                String::new()
            };
            return Ok(mcp_text_result(&text));
        }
        "wait_for_output" => {
            let session_id = args.get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or("Missing required parameter: sessionId")?
                .to_string();
            let timeout_ms = args.get("timeout")
                .and_then(|v| v.as_u64())
                .unwrap_or(5000);
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);

            loop {
                let notify = session_notifier(output_waiters, &session_id).await;
                let notified = notify.notified();
                {
                    let bufs = buffers.lock().await;
                    if let Some(buf) = bufs.get(&session_id) {
                        if !buf.is_empty() {
                            break;
                        }
                    }
                }
                if std::time::Instant::now() >= deadline {
                    break;
                }
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                if tokio::time::timeout(remaining, notified).await.is_err() {
                    break;
                }
            }

            let mut bufs = buffers.lock().await;
            let text = if let Some(buf) = bufs.get_mut(&session_id) {
                buf.read_and_clear(false)
            } else {
                String::new()
            };
            return Ok(mcp_text_result(&text));
        }
        "send_command" => {
            // Special handling: write command text first, then \r separately after a delay.
            // TUI apps (e.g. Claude Code, Codex) in raw mode need the Enter keystroke
            // as a separate write event — otherwise they treat \r within the batch as a
            // newline in their input buffer rather than a submit action.
            let session_id = args.get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or("Missing required parameter: sessionId")?;
            let command = args.get("command")
                .and_then(|v| v.as_str())
                .ok_or("Missing required parameter: command")?;

            // Write the command text wrapped in bracketed paste markers so TUI apps
            // that enable bracketed paste mode process the text as an atomic paste.
            // This is safe: if the app hasn't enabled the mode, the CSI sequences
            // are silently ignored as unrecognized escape sequences.
            if !command.is_empty() {
                let wrapped = format!("\x1b[200~{}\x1b[201~", command);
                let text_params = json!({ "id": session_id, "data": wrapped });
                api_handlers::dispatch(ctx, "sessions.write", text_params).await
                    .map_err(|e| e.message)?;
            }

            // Small delay so the TUI app processes the text input first
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;

            // Write Enter separately
            let enter_params = json!({ "id": session_id, "data": "\r" });
            api_handlers::dispatch(ctx, "sessions.write", enter_params).await
                .map_err(|e| e.message)?;

            return Ok(mcp_text_result("Command sent"));
        }
        "wait_for_command_complete" => {
            let session_id = args.get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or("Missing required parameter: sessionId")?
                .to_string();
            let timeout_ms = args.get("timeout")
                .and_then(|v| v.as_u64())
                .unwrap_or(30000);
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);

            loop {
                let notify = session_notifier(completion_waiters, &session_id).await;
                let notified = notify.notified();
                {
                    let bufs = completion_buffers.lock().await;
                    if let Some(completions) = bufs.get(&session_id) {
                        if !completions.is_empty() {
                            break;
                        }
                    }
                }
                if std::time::Instant::now() >= deadline {
                    break;
                }
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                if tokio::time::timeout(remaining, notified).await.is_err() {
                    break;
                }
            }

            let mut bufs = completion_buffers.lock().await;
            if let Some(completions) = bufs.get_mut(&session_id) {
                if !completions.is_empty() {
                    let completion = completions.remove(0);
                    let text = serde_json::to_string_pretty(&completion).unwrap_or_default();
                    return Ok(mcp_text_result(&text));
                }
            }
            return Ok(mcp_text_result("Timeout: no command completed within the deadline"));
        }
        "send_signal" => {
            let session_id = args.get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or("Missing required parameter: sessionId")?;
            let signal = args.get("signal")
                .and_then(|v| v.as_str())
                .ok_or("Missing required parameter: signal")?;
            let ctrl_char = match signal {
                "SIGINT"  => "\x03",
                "EOF"     => "\x04",
                "SIGTSTP" => "\x1a",
                "SIGQUIT" => "\x1c",
                _ => return Err(format!("Unknown signal: {signal}. Must be one of: SIGINT, EOF, SIGTSTP, SIGQUIT")),
            };
            let params = json!({ "id": session_id, "data": ctrl_char });
            api_handlers::dispatch(ctx, "sessions.write", params).await
                .map_err(|e| e.message)?;
            return Ok(mcp_text_result(&format!("Signal {signal} sent")));
        }
        "wait_for_idle" => {
            let session_id = args.get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or("Missing required parameter: sessionId")?
                .to_string();
            let timeout_ms = args.get("timeout")
                .and_then(|v| v.as_u64())
                .unwrap_or(30000);
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);

            // Drain any stale notifications for this session before waiting
            {
                let mut notifs = idle_notifications.lock().await;
                if let Some(entries) = notifs.get_mut(&session_id) {
                    entries.clear();
                }
            }

            loop {
                let notify = session_notifier(idle_waiters, &session_id).await;
                let notified = notify.notified();
                {
                    let mut notifs = idle_notifications.lock().await;
                    if let Some(entries) = notifs.get_mut(&session_id) {
                        if !entries.is_empty() {
                            let ts = entries.remove(0);
                            return Ok(mcp_text_result(&json!({
                                "status": "idle",
                                "sessionId": session_id,
                                "timestamp": ts
                            }).to_string()));
                        }
                    }
                }
                if std::time::Instant::now() >= deadline {
                    break;
                }
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                if tokio::time::timeout(remaining, notified).await.is_err() {
                    break;
                }
            }

            return Ok(mcp_text_result(&json!({
                "status": "timeout",
                "sessionId": session_id,
                "message": "No prompt detected within the timeout period"
            }).to_string()));
        }
        _ => {}
    }

    // Standard tools: dispatch through api_handlers
    let method = tool_to_method(name)
        .ok_or_else(|| format!("Unknown tool: {name}"))?;
    let params = map_params(name, &args);

    match api_handlers::dispatch(ctx, method, params).await {
        Ok(result) if name == "capture_screenshot" => mcp_screenshot_result(&result),
        Ok(result) => Ok(mcp_text_result(&serde_json::to_string_pretty(&result).unwrap_or_default())),
        Err(err) if name == "capture_screenshot" => Ok(mcp_capture_failure_result(&err.message)),
        Err(err) => Err(err.message),
    }
}

fn mcp_text_result(text: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }]
    })
}

fn mcp_screenshot_result(result: &Value) -> Result<Value, String> {
    let data = result
        .get("data")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "capture_screenshot response did not include PNG data".to_string())?;
    let mime_type = result
        .get("mimeType")
        .and_then(|v| v.as_str())
        .unwrap_or("image/png");

    let mut metadata = result.clone();
    if let Value::Object(map) = &mut metadata {
        map.remove("data");
    }
    let text = serde_json::to_string_pretty(&metadata).unwrap_or_else(|_| "{}".to_string());

    Ok(json!({
        "content": [
            { "type": "text", "text": text },
            { "type": "image", "mimeType": mime_type, "data": data }
        ]
    }))
}

fn mcp_capture_failure_result(message: &str) -> Value {
    let error_code = if message.starts_with("CAPTURE_SCREENSHOT_FAILED:") {
        "CAPTURE_SCREENSHOT_FAILED"
    } else if message.starts_with("BROWSER_SNAPSHOT_FAILED:") {
        "BROWSER_SNAPSHOT_FAILED"
    } else if message.contains("not found") {
        "CAPTURE_TARGET_NOT_FOUND"
    } else {
        "CAPTURE_FAILED"
    };

    let recovery = if message.contains("list_file_viewer_tabs") || message.contains("tabId") {
        "Call list_file_viewer_tabs, choose an open tabId, wait for loading to finish, then call capture_screenshot again."
    } else if message.contains("loading") || message.contains("render") {
        "Wait for the file viewer or browser to finish loading/rendering, then retry capture_screenshot."
    } else {
        "Retry capture_screenshot after the file viewer is idle. If the target was closed, open or focus a current tab first."
    };

    mcp_text_result(
        &serde_json::to_string_pretty(&json!({
            "status": "failed",
            "tool": "capture_screenshot",
            "errorCode": error_code,
            "message": message,
            "recovery": recovery
        }))
        .unwrap_or_default(),
    )
}
