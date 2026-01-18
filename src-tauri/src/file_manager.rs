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

