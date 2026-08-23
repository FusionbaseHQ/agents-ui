use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Deserialize)]
pub struct DiscoveryFile {
    pub socket: String,
    pub version: String,
    pub pid: u32,
    pub token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_token: Option<String>,
}

fn agents_ui_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "cannot determine home directory".to_string())?;
    Ok(PathBuf::from(home).join(".agents-ui"))
}

pub fn socket_path() -> Result<PathBuf, String> {
    Ok(agents_ui_dir()?.join("api.sock"))
}

pub fn discovery_path() -> Result<PathBuf, String> {
    Ok(agents_ui_dir()?.join("api.json"))
}

pub fn generate_token() -> String {
    use rand_core::{OsRng, RngCore};
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn write_discovery_file(token: &str) -> Result<PathBuf, String> {
    let dir = agents_ui_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("create dir failed: {e}"))?;

    #[cfg(target_family = "unix")]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }

    let sock = socket_path()?;
    let disc = discovery_path()?;

    let file = DiscoveryFile {
        socket: sock
            .to_str()
            .ok_or_else(|| "API socket path is not valid UTF-8".to_string())?
            .to_string(),
        version: "1".to_string(),
        pid: std::process::id(),
        token: token.to_string(),
        mcp_url: None,
        mcp_token: None,
    };

    let json = serde_json::to_string_pretty(&file)
        .map_err(|e| format!("serialize failed: {e}"))?;

    fs::write(&disc, &json).map_err(|e| format!("write failed: {e}"))?;

    #[cfg(target_family = "unix")]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&disc, fs::Permissions::from_mode(0o600));
    }

    Ok(disc)
}

pub fn update_mcp_url(port: u16, mcp_token: &str) -> Result<(), String> {
    let disc = discovery_path()?;
    let content = fs::read_to_string(&disc)
        .map_err(|e| format!("read discovery file failed: {e}"))?;
    let mut file: DiscoveryFile = serde_json::from_str(&content)
        .map_err(|e| format!("parse discovery file failed: {e}"))?;
    // Only update a discovery file THIS process wrote. At startup the file on
    // disk is often a previous instance's — updating it both publishes a URL
    // into a file whose socket/token are stale AND loses the update when our
    // own api_server rewrites the file moments later. The caller's retry loop
    // keeps trying until our api_server has written it.
    if file.pid != std::process::id() {
        return Err("discovery file belongs to another instance (not written yet)".to_string());
    }
    file.mcp_url = Some(format!("http://127.0.0.1:{port}/mcp"));
    file.mcp_token = Some(mcp_token.to_string());
    let json = serde_json::to_string_pretty(&file)
        .map_err(|e| format!("serialize failed: {e}"))?;
    fs::write(&disc, &json).map_err(|e| format!("write failed: {e}"))?;
    Ok(())
}

pub fn cleanup_stale_socket() -> Result<(), String> {
    let disc = discovery_path()?;
    if !disc.exists() {
        return Ok(());
    }

    let content = match fs::read_to_string(&disc) {
        Ok(c) => c,
        Err(_) => {
            let _ = fs::remove_file(&disc);
            return Ok(());
        }
    };

    let parsed: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => {
            let _ = fs::remove_file(&disc);
            return Ok(());
        }
    };

    if let Some(pid) = parsed.get("pid").and_then(|v| v.as_u64()) {
        if !is_process_alive(pid as u32) {
            let sock = socket_path()?;
            let _ = fs::remove_file(&sock);
            let _ = fs::remove_file(&disc);
        }
    }

    Ok(())
}

pub fn cleanup() {
    let _ = fs::remove_file(socket_path().unwrap_or_default());
    let _ = fs::remove_file(discovery_path().unwrap_or_default());
}

fn is_process_alive(pid: u32) -> bool {
    #[cfg(target_family = "unix")]
    {
        // Check if process exists via /proc on Linux, or kill(0) signal check.
        // Using std::process::Command to avoid libc dependency.
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_family = "unix"))]
    {
        let _ = pid;
        false
    }
}
