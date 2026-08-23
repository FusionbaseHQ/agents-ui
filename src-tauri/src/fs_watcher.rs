use notify::{RecommendedWatcher, RecursiveMode, Watcher, Event};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

use crate::files::path_to_utf8;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FsChangeEvent {
    path: String,
    watcher_id: String,
}

struct WatcherSession {
    watcher: RecommendedWatcher,
    watched_paths: HashSet<PathBuf>,
    /// Kept alive so the debounce thread stays running;
    /// dropping it disconnects the channel and the thread exits.
    _tx: mpsc::Sender<PathBuf>,
}

pub struct FsWatcherState {
    inner: Arc<Mutex<HashMap<String, WatcherSession>>>,
}

impl Default for FsWatcherState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[tauri::command]
pub fn start_fs_watcher(
    app: AppHandle,
    state: State<'_, FsWatcherState>,
    watcher_id: String,
    root: String,
) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<PathBuf>();
    let tx_for_watcher = tx.clone();

    let watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            for path in &event.paths {
                // Send the parent directory (the directory that changed)
                let dir = if path.is_dir() {
                    path.clone()
                } else {
                    path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| path.clone())
                };
                let _ = tx_for_watcher.send(dir);
            }
        }
    })
    .map_err(|e| format!("Failed to create watcher: {e}"))?;

    // Spawn debounce thread
    let watcher_id_for_thread = watcher_id.clone();
    std::thread::spawn(move || {
        let mut pending: HashSet<PathBuf> = HashSet::new();

        let flush = |set: &mut HashSet<PathBuf>, app: &AppHandle, wid: &str| {
            for dir in set.drain() {
                // The frontend cannot address a Unix path that is not valid
                // UTF-8. Silently substituting U+FFFD would emit a different,
                // potentially actionable path. Notify the nearest representable
                // parent instead, whose strict refresh will surface the child as
                // an explicit unsupported-name error.
                let path_str = match path_to_utf8(&dir) {
                    Ok(path) => path,
                    Err(_) => {
                        let Some(parent) = dir.parent().and_then(|parent| path_to_utf8(parent).ok()) else {
                            continue;
                        };
                        parent
                    }
                };
                let _ = app.emit(
                    "fs-changed",
                    FsChangeEvent {
                        path: path_str,
                        watcher_id: wid.to_string(),
                    },
                );
            }
        };

        loop {
            match rx.recv_timeout(Duration::from_millis(300)) {
                Ok(dir_path) => {
                    pending.insert(dir_path);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    flush(&mut pending, &app, &watcher_id_for_thread);
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    flush(&mut pending, &app, &watcher_id_for_thread);
                    break;
                }
            }
        }
    });

    let mut session = WatcherSession {
        watcher,
        watched_paths: HashSet::new(),
        _tx: tx,
    };

    // Watch the root directory immediately
    let root_path = PathBuf::from(&root);
    if let Err(e) = session.watcher.watch(&root_path, RecursiveMode::NonRecursive) {
        eprintln!("[fs_watcher] Failed to watch root {root}: {e}");
    } else {
        session.watched_paths.insert(root_path);
    }

    let mut map = state.inner.lock().map_err(|e| format!("Lock error: {e}"))?;
    map.insert(watcher_id, session);

    Ok(())
}

#[tauri::command]
pub fn watch_directory(
    state: State<'_, FsWatcherState>,
    watcher_id: String,
    path: String,
) -> Result<(), String> {
    let mut map = state.inner.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(session) = map.get_mut(&watcher_id) {
        let dir_path = PathBuf::from(&path);
        if !session.watched_paths.contains(&dir_path) {
            if let Err(e) = session.watcher.watch(&dir_path, RecursiveMode::NonRecursive) {
                eprintln!("[fs_watcher] Failed to watch {path}: {e}");
            } else {
                session.watched_paths.insert(dir_path);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn unwatch_directory(
    state: State<'_, FsWatcherState>,
    watcher_id: String,
    path: String,
) -> Result<(), String> {
    let mut map = state.inner.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(session) = map.get_mut(&watcher_id) {
        let dir_path = PathBuf::from(&path);
        let _ = session.watcher.unwatch(&dir_path);
        session.watched_paths.remove(&dir_path);
    }
    Ok(())
}

#[tauri::command]
pub fn stop_fs_watcher(
    state: State<'_, FsWatcherState>,
    watcher_id: String,
) -> Result<(), String> {
    let mut map = state.inner.lock().map_err(|e| format!("Lock error: {e}"))?;
    // Dropping the session stops the watcher and disconnects the channel
    map.remove(&watcher_id);
    Ok(())
}
