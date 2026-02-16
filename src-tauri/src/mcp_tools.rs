use crate::api_handlers::{self, HandlerContext};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

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
                "basePath": { "type": "string", "description": "Base directory path for the project" }
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
        tool_def("update_project", "Update a project's title or base path.", json!({
            "type": "object",
            "properties": {
                "projectId": { "type": "string", "description": "Project ID" },
                "title": { "type": "string", "description": "New project title" },
                "basePath": { "type": "string", "description": "New base directory path" }
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
        tool_def("get_ui_state", "Get the current UI state including the active session, active project, visible panels, and window layout.", json!({
            "type": "object",
            "properties": {}
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
        "list_prompts" => Some("prompts.list"),
        "send_prompt" => Some("prompts.send"),
        "get_app_info" => Some("app.info"),
        "get_ui_state" => Some("ui.state"),
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
        }
        "close_session" => json!({ "id": args.get("sessionId") }),
        "write_to_session" => json!({ "id": args.get("sessionId"), "data": args.get("data") }),
        "send_command" => json!({}), // handled as special case in call_tool
        "activate_session" => json!({ "id": args.get("sessionId") }),
        "list_projects" => json!({}),
        "get_project" => json!({ "id": args.get("projectId") }),
        "create_project" => {
            let mut p = json!({ "title": args.get("title") });
            if let Some(v) = args.get("basePath") { p["basePath"] = v.clone(); }
            p
        }
        "update_project" => {
            let mut p = json!({ "id": args.get("projectId") });
            if let Some(v) = args.get("title") { p["title"] = v.clone(); }
            if let Some(v) = args.get("basePath") { p["basePath"] = v.clone(); }
            p
        }
        "delete_project" => json!({ "id": args.get("projectId") }),
        "activate_project" => json!({ "id": args.get("projectId") }),
        "reorder_projects" => json!({ "ids": args.get("projectIds") }),
        "ssh_connect" => {
            let mut p = json!({ "projectId": args.get("projectId"), "target": args.get("target") });
            if let Some(v) = args.get("remoteDir") { p["remoteDir"] = v.clone(); }
            if let Some(v) = args.get("name") { p["name"] = v.clone(); }
            p
        }
        "ssh_list_hosts" => json!({}),
        "list_files" => json!({ "root": args.get("root"), "path": args.get("path") }),
        "read_file" => json!({ "root": args.get("root"), "path": args.get("path") }),
        "write_file" => json!({ "root": args.get("root"), "path": args.get("path"), "content": args.get("content") }),
        "ssh_files_list" => json!({ "host": args.get("host"), "root": args.get("root"), "path": args.get("path") }),
        "ssh_files_read" => json!({ "host": args.get("host"), "root": args.get("root"), "path": args.get("path") }),
        "ssh_files_write" => json!({ "host": args.get("host"), "root": args.get("root"), "path": args.get("path"), "content": args.get("content") }),
        "list_prompts" => json!({}),
        "send_prompt" => {
            let mut p = json!({ "sessionId": args.get("sessionId") });
            if let Some(v) = args.get("promptId") { p["promptId"] = v.clone(); }
            if let Some(v) = args.get("content") { p["content"] = v.clone(); }
            if let Some(v) = args.get("mode") { p["mode"] = v.clone(); }
            p
        }
        "get_app_info" => json!({}),
        "get_ui_state" => json!({}),
        _ => args.clone(),
    }
}

// ── Tool call dispatch ──

pub async fn call_tool(
    ctx: &Arc<HandlerContext>,
    buffers: &OutputBuffers,
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
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
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

            // Write the command text
            if !command.is_empty() {
                let text_params = json!({ "id": session_id, "data": command });
                api_handlers::dispatch(ctx, "sessions.write", text_params).await
                    .map_err(|e| e.message)?;
            }

            // Small delay so the TUI app processes the text input first
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;

            // Write Enter separately
            let enter_params = json!({ "id": session_id, "data": "\r" });
            api_handlers::dispatch(ctx, "sessions.write", enter_params).await
                .map_err(|e| e.message)?;

            return Ok(mcp_text_result("Command sent"));
        }
        _ => {}
    }

    // Standard tools: dispatch through api_handlers
    let method = tool_to_method(name)
        .ok_or_else(|| format!("Unknown tool: {name}"))?;
    let params = map_params(name, &args);

    match api_handlers::dispatch(ctx, method, params).await {
        Ok(result) => Ok(mcp_text_result(&serde_json::to_string_pretty(&result).unwrap_or_default())),
        Err(err) => Err(err.message),
    }
}

fn mcp_text_result(text: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }]
    })
}
