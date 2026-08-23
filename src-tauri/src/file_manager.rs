use std::path::Path;
use std::process::Command;

fn validate_directory_path(path: &str) -> Result<&Path, String> {
    if path.is_empty() {
        return Err("missing path".to_string());
    }

    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("path must be absolute".to_string());
    }
    if !path.is_dir() {
        return Err("path is not a directory".to_string());
    }
    Ok(path)
}

#[tauri::command]
pub fn open_path_in_file_manager(path: String) -> Result<(), String> {
    let path = validate_directory_path(&path)?;

    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("open failed: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| format!("explorer failed: {e}"))?;
        return Ok(());
    }

    #[cfg(all(target_family = "unix", not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("xdg-open failed: {e}"))?;
        return Ok(());
    }
}

#[tauri::command]
pub fn open_path_in_vscode(path: String) -> Result<(), String> {
    let path = validate_directory_path(&path)?;

    // On macOS, use 'open -a' which goes through Launch Services.
    // This is more reliable than the 'code' CLI when app is launched from Finder/Dock.
    #[cfg(target_os = "macos")]
    {
        return Command::new("/usr/bin/open")
            .arg("-a")
            .arg("Visual Studio Code")
            .arg(path)
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
                    .arg(path)
                    .spawn()
                    .map(|_| ())
                    .map_err(|e| format!("code command failed: {e}"));
            }
        }
        Err("VS Code not found".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::validate_directory_path;

    #[test]
    fn file_manager_validation_preserves_literal_directory_path() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let parent = std::env::temp_dir().join(format!(
            "agents-ui-file-manager-{}-{unique}",
            std::process::id()
        ));
        let exact = parent.join("  lowerCase-目录-🚀  ");
        std::fs::create_dir_all(&exact).expect("create exact directory");
        let exact_string = exact.to_str().expect("test path is UTF-8");

        let validated = validate_directory_path(exact_string).expect("validate exact path");
        assert_eq!(validated.as_os_str(), exact.as_os_str());
        std::fs::remove_dir_all(parent).expect("remove file-manager test directory");
    }

    #[test]
    fn whitespace_is_not_reclassified_as_missing_input() {
        assert_eq!(
            validate_directory_path("   ").unwrap_err(),
            "path must be absolute"
        );
        assert_eq!(validate_directory_path("").unwrap_err(), "missing path");
    }
}
