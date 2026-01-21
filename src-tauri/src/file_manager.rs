use std::path::Path;
use std::process::Command;

#[tauri::command]
pub fn open_path_in_file_manager(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("missing path".to_string());
    }

    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err("path must be absolute".to_string());
    }
    if !path.is_dir() {
        return Err("path is not a directory".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("open failed: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("explorer failed: {e}"))?;
        return Ok(());
    }

    #[cfg(all(target_family = "unix", not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("xdg-open failed: {e}"))?;
        return Ok(());
    }
}

#[tauri::command]
pub fn open_path_in_vscode(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("missing path".to_string());
    }

    let p = Path::new(trimmed);
    if !p.is_absolute() {
        return Err("path must be absolute".to_string());
    }
    if !p.is_dir() {
        return Err("path is not a directory".to_string());
    }

    // On macOS, use 'open -a' which goes through Launch Services.
    // This is more reliable than the 'code' CLI when app is launched from Finder/Dock.
    #[cfg(target_os = "macos")]
    {
        return Command::new("/usr/bin/open")
            .args(["-a", "Visual Studio Code", trimmed])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to open VS Code: {e}"));
    }

    // On other platforms, try common locations for the 'code' command
    #[cfg(not(target_os = "macos"))]
    {
        for code_path in &["/usr/local/bin/code", "/opt/homebrew/bin/code"] {
            if Path::new(code_path).exists() {
                return Command::new(code_path)
                    .arg(trimmed)
                    .spawn()
                    .map(|_| ())
                    .map_err(|e| format!("code command failed: {e}"));
            }
        }
        Err("VS Code not found".to_string())
    }
}

