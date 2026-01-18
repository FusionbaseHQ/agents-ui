use std::path::{Path, PathBuf};
use std::process::Command;

fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    if path == "~" {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home);
        }
    }
    PathBuf::from(path)
}

fn resolve_target(target: &str, cwd: Option<&str>) -> Result<PathBuf, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("missing target".to_string());
    }

    let path = expand_tilde(target);
    if path.is_absolute() {
        return Ok(path);
    }

    let Some(cwd) = cwd else {
        return Err("target must be absolute or cwd must be provided".to_string());
    };
    let cwd_path = Path::new(cwd.trim());
    if !cwd_path.is_absolute() {
        return Err("cwd must be absolute".to_string());
    }
    Ok(cwd_path.join(path))
}

fn code_location(path: &Path, line: Option<u32>, column: Option<u32>) -> String {
    let base = path.to_string_lossy().to_string();
    match line {
        Some(line) => match column {
            Some(column) => format!("{base}:{line}:{column}"),
            None => format!("{base}:{line}"),
        },
        None => base,
    }
}

fn try_spawn_code(location: &str, use_goto: bool) -> std::io::Result<()> {
    let mut cmd = Command::new("code");
    cmd.arg("--reuse-window");
    if use_goto {
        cmd.arg("-g");
    }
    cmd.arg(location);
    cmd.spawn().map(|_| ())
}

#[cfg(target_os = "macos")]
fn try_spawn_open_app(location: &str, use_goto: bool) -> std::io::Result<()> {
    let mut cmd = Command::new("/usr/bin/open");
    cmd.arg("-a");
    cmd.arg("Visual Studio Code");
    cmd.arg("--args");
    cmd.arg("--reuse-window");
    if use_goto {
        cmd.arg("-g");
    }
    cmd.arg(location);
    cmd.spawn().map(|_| ())
}

#[tauri::command]
pub fn open_in_vscode(
    target: String,
    cwd: Option<String>,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<(), String> {
    let resolved = resolve_target(&target, cwd.as_deref())?;

    let use_goto = line.is_some();
    let location = code_location(&resolved, line, column);

    match try_spawn_code(&location, use_goto) {
        Ok(()) => Ok(()),
        Err(err) => {
            #[cfg(target_os = "macos")]
            {
                try_spawn_open_app(&location, use_goto).map_err(|e| {
                    format!(
                        "failed to open VS Code ({code_err}); fallback open failed ({fallback_err})",
                        code_err = err,
                        fallback_err = e
                    )
                })?;
                Ok(())
            }
            #[cfg(not(target_os = "macos"))]
            {
                Err(format!("failed to open VS Code: {err}"))
            }
        }
    }
}

