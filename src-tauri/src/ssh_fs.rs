use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use crate::files::FsEntry;

const MAX_TEXT_FILE_BYTES: usize = 2 * 1024 * 1024;
const BINARY_CHECK_BYTES: usize = 8 * 1024;

fn find_program_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(target_family = "windows")]
        {
            let exe = dir.join(format!("{name}.exe"));
            if exe.is_file() {
                return Some(exe);
            }
        }
    }
    None
}

fn find_program_in_common_locations(name: &str) -> Option<PathBuf> {
    #[cfg(target_family = "windows")]
    {
        let candidates = [
            std::env::var_os("WINDIR")
                .map(|w| PathBuf::from(w).join("System32").join("OpenSSH").join(format!("{name}.exe"))),
        ];
        for c in candidates.into_iter().flatten() {
            if c.is_file() {
                return Some(c);
            }
        }
        return None;
    }

    #[cfg(not(target_family = "windows"))]
    {
        let candidates = [
            Path::new("/usr/bin").join(name),
            Path::new("/bin").join(name),
            Path::new("/usr/local/bin").join(name),
            Path::new("/usr/local/sbin").join(name),
            Path::new("/opt/homebrew/bin").join(name),
            Path::new("/opt/homebrew/sbin").join(name),
            Path::new("/usr/sbin").join(name),
            Path::new("/sbin").join(name),
        ];
        for c in candidates {
            if c.is_file() {
                return Some(c);
            }
        }
        None
    }
}

fn program_path(name: &str) -> Result<PathBuf, String> {
    if let Some(found) = find_program_in_path(name) {
        return Ok(found);
    }
    if let Some(found) = find_program_in_common_locations(name) {
        return Ok(found);
    }
    Err(format!(
        "{name} not found. Install the OpenSSH client and ensure it is available in PATH."
    ))
}

fn normalize_posix_path(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("path is empty".to_string());
    }
    if !trimmed.starts_with('/') {
        return Err("path must be absolute".to_string());
    }

    let mut parts: Vec<&str> = Vec::new();
    for part in trimmed.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            parts.pop();
            continue;
        }
        parts.push(part);
    }

    if parts.is_empty() {
        return Ok("/".to_string());
    }
    Ok(format!("/{}", parts.join("/")))
}

fn ensure_within_root(root: &str, path: &str) -> Result<(String, String), String> {
    let root = normalize_posix_path(root)?;
    let path = normalize_posix_path(path)?;
    if root != "/" && path != root && !path.starts_with(&format!("{root}/")) {
        return Err("path is outside root".to_string());
    }
    Ok((root, path))
}

fn ensure_not_root(root: &str, path: &str, verb: &str) -> Result<(), String> {
    if root == path {
        return Err(format!("cannot {verb} root"));
    }
    Ok(())
}

fn join_posix_path(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn control_path() -> Result<String, String> {
    #[cfg(target_family = "unix")]
    let preferred_base = {
        // Keep this short to avoid Unix socket path length limits for ssh ControlPath.
        // Avoid using std::env::temp_dir() on macOS, which can be very long (e.g. /var/folders/...).
        let uid = std::env::var("UID")
            .ok()
            .and_then(|v| v.parse::<u32>().ok());
        match uid {
            Some(uid) => PathBuf::from("/tmp").join(format!("agents-ui-ssh-{uid}")),
            None => PathBuf::from("/tmp").join("agents-ui-ssh"),
        }
    };

    #[cfg(not(target_family = "unix"))]
    let preferred_base = std::env::temp_dir().join("agents-ui-ssh");

    let fallback_base = std::env::temp_dir().join("agents-ui-ssh");

    let base = match std::fs::create_dir_all(&preferred_base) {
        Ok(()) => preferred_base,
        Err(_) => {
            std::fs::create_dir_all(&fallback_base)
                .map_err(|e| format!("create control dir failed: {e}"))?;
            fallback_base
        }
    };

    Ok(base.join("%C").to_string_lossy().to_string())
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(target_family = "unix")]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
    #[cfg(not(target_family = "unix"))]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
}

fn user_ssh_config_path() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".ssh").join("config"))
}

fn ssh_common_args() -> Result<Vec<String>, String> {
    let control = control_path()?;
    let mut out: Vec<String> = Vec::new();
    if let Some(cfg) = user_ssh_config_path().filter(|p| p.is_file()) {
        out.push("-F".to_string());
        out.push(cfg.to_string_lossy().to_string());
    }
    out.extend([
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "ConnectTimeout=6".to_string(),
        "-o".to_string(),
        "ConnectionAttempts=1".to_string(),
        "-o".to_string(),
        "ServerAliveInterval=10".to_string(),
        "-o".to_string(),
        "ServerAliveCountMax=2".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=yes".to_string(),
        "-o".to_string(),
        "ControlMaster=auto".to_string(),
        "-o".to_string(),
        "ControlPersist=60".to_string(),
        "-o".to_string(),
        format!("ControlPath={control}"),
    ]);
    Ok(out)
}

fn output_to_error(prefix: &str, output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stderr.is_empty() {
        return format!("{prefix}: {stderr}");
    }
    if !stdout.is_empty() {
        return format!("{prefix}: {stdout}");
    }
    format!("{prefix}: command failed")
}

fn shell_escape_posix(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            out.push_str("'\"'\"'");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

fn build_sh_c_command(script: &str, argv0: Option<&str>, args: &[String]) -> String {
    let mut out = String::new();
    out.push_str("sh -c ");
    out.push_str(&shell_escape_posix(script));
    if let Some(name) = argv0 {
        out.push(' ');
        out.push_str(&shell_escape_posix(name));
    }
    for arg in args {
        out.push(' ');
        out.push_str(&shell_escape_posix(arg));
    }
    out
}

fn run_ssh(target: &str, remote_args: &[String], stdin: Option<&[u8]>) -> Result<Output, String> {
    let mut cmd = Command::new(program_path("ssh")?);
    cmd.args(ssh_common_args()?);
    cmd.arg(target);
    cmd.args(remote_args);
    match stdin {
        Some(_) => {
            cmd.stdin(Stdio::piped());
        }
        None => {
            cmd.stdin(Stdio::null());
        }
    }
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    if let Some(input) = stdin {
        let mut child = cmd.spawn().map_err(|e| format!("spawn ssh failed: {e}"))?;
        if let Some(mut child_stdin) = child.stdin.take() {
            child_stdin
                .write_all(input)
                .map_err(|e| format!("write ssh stdin failed: {e}"))?;
        }
        child
            .wait_with_output()
            .map_err(|e| format!("wait ssh failed: {e}"))
    } else {
        cmd.output().map_err(|e| format!("run ssh failed: {e}"))
    }
}

fn run_sftp_batch(target: &str, batch: &str) -> Result<Output, String> {
    let mut cmd = Command::new(program_path("sftp")?);
    cmd.args(ssh_common_args()?);
    cmd.arg("-q");
    cmd.arg("-b");
    cmd.arg("-");
    cmd.arg(target);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("spawn sftp failed: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(batch.as_bytes())
            .map_err(|e| format!("write sftp stdin failed: {e}"))?;
    }
    child
        .wait_with_output()
        .map_err(|e| format!("wait sftp failed: {e}"))
}

fn sftp_escape_arg(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        if ch == '"' || ch == '\\' {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('"');
    out
}

fn split_whitespace_with_remainder<'a>(line: &'a str, token_count: usize) -> Option<(Vec<&'a str>, &'a str)> {
    let bytes = line.as_bytes();
    let mut i = 0usize;
    let mut tokens: Vec<&'a str> = Vec::with_capacity(token_count);

    while tokens.len() < token_count {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            return None;
        }
        let start = i;
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let token = &line[start..i];
        tokens.push(token);
    }

    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    let remainder = if i >= bytes.len() { "" } else { &line[i..] };
    Some((tokens, remainder))
}

fn parse_sftp_ls(dir_path: &str, stdout: &str) -> Vec<FsEntry> {
    let mut entries: Vec<FsEntry> = Vec::new();

    for raw in stdout.lines() {
        let line = raw.trim_end();
        if line.is_empty() {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("sftp>") || lower.starts_with("connected to ") {
            continue;
        }
        if lower.starts_with("total ") {
            continue;
        }
        let kind = line.chars().next().unwrap_or('?');
        if !matches!(kind, 'd' | '-' | 'l' | 'c' | 'b' | 's' | 'p') {
            continue;
        }

        let Some((tokens, remainder)) = split_whitespace_with_remainder(line, 8) else {
            continue;
        };
        let name_field = remainder.trim();
        if name_field.is_empty() {
            continue;
        }
        let name = name_field
            .split(" -> ")
            .next()
            .unwrap_or(name_field)
            .trim();
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }

        let size = tokens.get(4).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        let is_dir = kind == 'd';
        entries.push(FsEntry {
            name: name.to_string(),
            path: join_posix_path(dir_path, name),
            is_dir,
            size: if is_dir { 0 } else { size },
        });
    }

    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => return std::cmp::Ordering::Less,
            (false, true) => return std::cmp::Ordering::Greater,
            _ => {}
        }
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });

    entries
}

#[tauri::command]
pub async fn ssh_default_root(target: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ssh_default_root_sync(target))
        .await
        .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_default_root_sync(target: String) -> Result<String, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }

    // Keep scripts single-line: some user shells choke on literal newlines in SSH exec strings.
    let script = r#"uid="$(id -u 2>/dev/null || echo 1000)"; if [ "$uid" = "0" ]; then printf "/"; exit 0; fi; if [ -n "${HOME:-}" ]; then printf "%s" "$HOME"; exit 0; fi; pwd"#;

    let command = build_sh_c_command(script, None, &[]);
    let args = vec![command];
    let output = run_ssh(target, &args, None)?;
    if !output.status.success() {
        return Err(output_to_error("ssh failed", &output));
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Err("ssh returned empty root".to_string());
    }
    normalize_posix_path(&stdout)
}

#[tauri::command]
pub async fn ssh_list_fs_entries(target: String, root: String, path: String) -> Result<Vec<FsEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || ssh_list_fs_entries_sync(target, root, path))
        .await
        .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_list_fs_entries_sync(target: String, root: String, path: String) -> Result<Vec<FsEntry>, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let (_root, path) = ensure_within_root(&root, &path)?;

    let batch = format!("ls -la {}\n", sftp_escape_arg(&path));
    let output = run_sftp_batch(target, &batch)?;
    if !output.status.success() {
        return Err(output_to_error("sftp failed", &output));
    }
    Ok(parse_sftp_ls(&path, &String::from_utf8_lossy(&output.stdout)))
}

#[tauri::command]
pub async fn ssh_read_text_file(target: String, root: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ssh_read_text_file_sync(target, root, path))
        .await
        .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_read_text_file_sync(target: String, root: String, path: String) -> Result<String, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let (root, path) = ensure_within_root(&root, &path)?;
    ensure_not_root(&root, &path, "read")?;

    let limit = MAX_TEXT_FILE_BYTES + 1;
    let script = format!(
        r#"set -e; file="$1"; [ -f "$file" ] || {{ echo "not a file" >&2; exit 1; }}; if command -v head >/dev/null 2>&1; then head -c {limit} "$file"; else dd if="$file" bs=1 count={limit}; fi"#
    );

    let command = build_sh_c_command(&script, Some("--"), &[path.clone()]);
    let args = vec![command];
    let output = run_ssh(target, &args, None)?;
    if !output.status.success() {
        return Err(output_to_error("ssh failed", &output));
    }

    let bytes = output.stdout;
    if bytes.len() > MAX_TEXT_FILE_BYTES {
        return Err(format!(
            "file too large (>{MAX_TEXT_FILE_BYTES} bytes); open smaller files only"
        ));
    }
    if bytes[..bytes.len().min(BINARY_CHECK_BYTES)]
        .iter()
        .any(|b| *b == 0)
    {
        return Err("binary files are not supported".to_string());
    }
    String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8".to_string())
}

#[tauri::command]
pub async fn ssh_write_text_file(target: String, root: String, path: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ssh_write_text_file_sync(target, root, path, content))
        .await
        .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_write_text_file_sync(target: String, root: String, path: String, content: String) -> Result<(), String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let (root, path) = ensure_within_root(&root, &path)?;
    ensure_not_root(&root, &path, "write")?;

    // Note: The editor uses a separate "dirty" flag, so avoid appending extra newlines here.
    let script = r#"set -e; file="$1"; [ -f "$file" ] || { echo "not a file" >&2; exit 1; }; dir="$(dirname "$file")"; tmp=""; if command -v mktemp >/dev/null 2>&1; then tmp="$(mktemp "$dir/.agents-ui-tmp.XXXXXXXX" 2>/dev/null || true)"; fi; if [ -z "$tmp" ]; then tmp="$dir/.agents-ui-tmp.$$"; rm -f "$tmp"; fi; cat > "$tmp"; mv "$tmp" "$file""#;

    let command = build_sh_c_command(script, Some("--"), &[path]);
    let args = vec![command];
    let output = run_ssh(target, &args, Some(content.as_bytes()))?;
    if !output.status.success() {
        return Err(output_to_error("ssh failed", &output));
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_rename_fs_entry(target: String, root: String, path: String, new_name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ssh_rename_fs_entry_sync(target, root, path, new_name))
        .await
        .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_rename_fs_entry_sync(target: String, root: String, path: String, new_name: String) -> Result<String, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let (root, path) = ensure_within_root(&root, &path)?;
    ensure_not_root(&root, &path, "rename")?;

    let name = new_name.trim();
    if name.is_empty() {
        return Err("missing new name".to_string());
    }
    if name == "." || name == ".." {
        return Err("invalid name".to_string());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("name must not contain path separators".to_string());
    }

    let parent = {
        let idx = path.rfind('/').unwrap_or(0);
        if idx == 0 { "/".to_string() } else { path[..idx].to_string() }
    };
    let to = join_posix_path(&parent, name);
    let (_, to_checked) = ensure_within_root(&root, &to)?;

    let script = r#"set -e; from="$1"; to="$2"; [ -e "$from" ] || { echo "missing source" >&2; exit 1; }; [ ! -e "$to" ] || { echo "target already exists" >&2; exit 1; }; mv "$from" "$to""#;
    let command = build_sh_c_command(script, Some("--"), &[path, to_checked.clone()]);
    let args = vec![command];
    let output = run_ssh(target, &args, None)?;
    if !output.status.success() {
        return Err(output_to_error("ssh failed", &output));
    }
    Ok(to_checked)
}

#[tauri::command]
pub async fn ssh_delete_fs_entry(target: String, root: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ssh_delete_fs_entry_sync(target, root, path))
        .await
        .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_delete_fs_entry_sync(target: String, root: String, path: String) -> Result<(), String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let (root, path) = ensure_within_root(&root, &path)?;
    ensure_not_root(&root, &path, "delete")?;

    let script = r#"set -e; path="$1"; rm -rf "$path""#;
    let command = build_sh_c_command(script, Some("--"), &[path]);
    let args = vec![command];
    let output = run_ssh(target, &args, None)?;
    if !output.status.success() {
        return Err(output_to_error("ssh failed", &output));
    }
    Ok(())
}

fn run_scp(scp_flags: &[&str], ssh_args: Vec<String>, paths: &[String]) -> Result<Output, String> {
    let mut cmd = Command::new(program_path("scp")?);
    // scp flags first (like -r)
    cmd.args(scp_flags);
    // SSH options next
    cmd.args(ssh_args);
    // Source and destination paths last
    cmd.args(paths);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.output().map_err(|e| format!("run scp failed: {e}"))
}

#[tauri::command]
pub async fn ssh_download_file(
    target: String,
    root: String,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        ssh_download_file_sync(target, root, remote_path, local_path)
    })
    .await
    .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_download_file_sync(
    target: String,
    root: String,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let (_root, remote_path) = ensure_within_root(&root, &remote_path)?;

    let local = local_path.trim();
    if local.is_empty() {
        return Err("missing local path".to_string());
    }

    // Use scp -r for recursive copy (works for files and directories)
    // Format: scp -r user@host:/remote/path /local/path
    // Note: No shell escaping needed - scp handles paths directly
    let source = format!("{}:{}", target, remote_path);
    let paths = vec![source, local.to_string()];
    let output = run_scp(&["-r"], ssh_common_args()?, &paths)?;
    if !output.status.success() {
        return Err(output_to_error("scp download failed", &output));
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_upload_file(
    target: String,
    root: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        ssh_upload_file_sync(target, root, local_path, remote_path)
    })
    .await
    .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_upload_file_sync(
    target: String,
    root: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let (_root, remote_path) = ensure_within_root(&root, &remote_path)?;

    let local = local_path.trim();
    if local.is_empty() {
        return Err("missing local path".to_string());
    }
    if !Path::new(local).exists() {
        return Err("local file does not exist".to_string());
    }

    // Use scp -r for recursive copy (works for files and directories)
    // Format: scp -r /local/path user@host:/remote/path
    // Note: No shell escaping needed - scp handles paths directly
    let dest = format!("{}:{}", target, remote_path);
    let paths = vec![local.to_string(), dest];
    let output = run_scp(&["-r"], ssh_common_args()?, &paths)?;
    if !output.status.success() {
        return Err(output_to_error("scp upload failed", &output));
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_download_to_temp(
    target: String,
    root: String,
    remote_path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ssh_download_to_temp_sync(target, root, remote_path)
    })
    .await
    .map_err(|e| format!("ssh task join failed: {e:?}"))?
}

fn ssh_download_to_temp_sync(
    target: String,
    root: String,
    remote_path: String,
) -> Result<String, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing ssh target".to_string());
    }
    let (_root, remote_path) = ensure_within_root(&root, &remote_path)?;

    // Extract filename from remote path
    let file_name = Path::new(&remote_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("download");

    // Create temp directory for this download
    let temp_base = std::env::temp_dir().join("agents-ui-downloads");
    std::fs::create_dir_all(&temp_base)
        .map_err(|e| format!("failed to create temp directory: {e}"))?;

    // Generate unique subdirectory
    let unique_id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let unique_dir = temp_base.join(format!("{unique_id}"));
    std::fs::create_dir_all(&unique_dir)
        .map_err(|e| format!("failed to create temp subdirectory: {e}"))?;

    let local_path = unique_dir.join(file_name);
    let local_path_str = local_path.to_string_lossy().to_string();

    // Download using scp
    // Note: No shell escaping needed - scp handles paths directly
    let source = format!("{}:{}", target, remote_path);
    let paths = vec![source, local_path_str.clone()];
    let output = run_scp(&["-r"], ssh_common_args()?, &paths)?;
    if !output.status.success() {
        return Err(output_to_error("scp download failed", &output));
    }

    Ok(local_path_str)
}
