// Auto-caffeinate (macOS).
//
// While at least one SSH session is active, hold a PreventUserIdleSystemSleep
// power assertion — the same unprivileged IOKit mechanism `caffeinate -i`
// uses — so the Mac doesn't idle-sleep, take the network down, and drop the
// connections (which kills whatever was running on the remote side). The
// display still sleeps normally, and the kernel auto-releases the assertion
// if the process dies, so a wedged-awake Mac is not a failure mode.
//
// SSH activity is derived from the backend PTY table (ground truth), never
// from frontend session state: a session counts when its launch command is
// `ssh ...`, or when a live ssh/sftp/scp process is found among the
// descendants of its shell — that second path is what catches `ssh user@host`
// typed into a plain shell session. Detached `agents-ui-*` zellij servers
// (persistent sessions reparent to launchd) are walked as extra roots.
//
// Releasing waits for two consecutive idle scans so the brief exit→respawn
// dip during an SSH auto-reconnect can't open a window for sleep to start.
// Known gap: ssh inside a *local* tmux/zellij the user started themselves is
// reparented away from our PTYs and isn't seen by the walk.

use std::sync::atomic::{AtomicBool, Ordering};

static ENABLED: AtomicBool = AtomicBool::new(true);

/// Frontend toggle ("Auto-Caffeinate" in app settings; default on). Disabling
/// releases any held assertion on the next watcher pass (≤1s via the poke).
#[tauri::command]
pub fn set_auto_caffeinate(enabled: bool) {
    ENABLED.store(enabled, Ordering::SeqCst);
    poke();
}

#[cfg(target_os = "macos")]
mod imp {
    use super::ENABLED;
    use crate::pty::AppState;
    use std::collections::{HashMap, HashSet, VecDeque};
    use std::ffi::{c_char, c_void, CString};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter};

    type CFStringRef = *const c_void;
    const KCF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const KIOPM_ASSERTION_LEVEL_ON: u32 = 255;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const c_char,
            encoding: u32,
        ) -> CFStringRef;
        fn CFRelease(cf: *const c_void);
    }

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: CFStringRef,
            level: u32,
            name: CFStringRef,
            assertion_id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(assertion_id: u32) -> i32;
    }

    // The name is what users see in Activity Monitor's "Preventing Sleep"
    // column and `pmset -g assertions`, so make it self-explanatory.
    fn create_assertion() -> Option<u32> {
        let assertion_type = CString::new("PreventUserIdleSystemSleep").ok()?;
        let name = CString::new("agents-ui: active SSH session").ok()?;
        unsafe {
            let type_ref = CFStringCreateWithCString(
                std::ptr::null(),
                assertion_type.as_ptr(),
                KCF_STRING_ENCODING_UTF8,
            );
            let name_ref =
                CFStringCreateWithCString(std::ptr::null(), name.as_ptr(), KCF_STRING_ENCODING_UTF8);
            if type_ref.is_null() || name_ref.is_null() {
                if !type_ref.is_null() {
                    CFRelease(type_ref);
                }
                if !name_ref.is_null() {
                    CFRelease(name_ref);
                }
                return None;
            }
            let mut id: u32 = 0;
            let status =
                IOPMAssertionCreateWithName(type_ref, KIOPM_ASSERTION_LEVEL_ON, name_ref, &mut id);
            CFRelease(type_ref);
            CFRelease(name_ref);
            (status == 0).then_some(id)
        }
    }

    static STARTED: AtomicBool = AtomicBool::new(false);
    static POKED: AtomicBool = AtomicBool::new(false);

    pub fn poke() {
        POKED.store(true, Ordering::SeqCst);
    }

    const SCAN_INTERVAL: Duration = Duration::from_secs(20);
    const RELEASE_GRACE_SCANS: u32 = 2;

    pub fn start(app: AppHandle, state: AppState) {
        if STARTED.swap(true, Ordering::SeqCst) {
            return; // a single watcher is enough
        }
        let _ = std::thread::Builder::new()
            .name("auto-caffeinate".into())
            .spawn(move || {
                let mut assertion: Option<u32> = None;
                let mut idle_scans: u32 = 0;
                // None so the first pass scans immediately on startup.
                let mut last_scan: Option<Instant> = None;
                loop {
                    std::thread::sleep(Duration::from_secs(1));
                    let poked = POKED.swap(false, Ordering::SeqCst);
                    if !poked && last_scan.is_some_and(|t| t.elapsed() < SCAN_INTERVAL) {
                        continue;
                    }
                    last_scan = Some(Instant::now());

                    let enabled = ENABLED.load(Ordering::SeqCst);
                    // Short-circuit keeps the watcher free of `ps` calls while
                    // the feature is off or no sessions exist.
                    let active = enabled && ssh_activity(&state);

                    if active {
                        idle_scans = 0;
                        if assertion.is_none() {
                            assertion = create_assertion();
                            if assertion.is_some() {
                                eprintln!(
                                    "[auto-caffeinate] SSH active — holding sleep assertion."
                                );
                                let _ = app.emit("power-assertion-changed", true);
                            }
                        }
                        continue;
                    }

                    let release_now = if enabled {
                        idle_scans = idle_scans.saturating_add(1);
                        idle_scans >= RELEASE_GRACE_SCANS
                    } else {
                        true
                    };
                    if release_now {
                        if let Some(id) = assertion.take() {
                            unsafe {
                                IOPMAssertionRelease(id);
                            }
                            eprintln!(
                                "[auto-caffeinate] No active SSH sessions — released sleep assertion."
                            );
                            let _ = app.emit("power-assertion-changed", false);
                        }
                    }
                }
            });
    }

    fn basename_lower(token: &str) -> String {
        token
            .rsplit('/')
            .next()
            .unwrap_or(token)
            .to_ascii_lowercase()
    }

    fn is_ssh_command(command: &str) -> bool {
        command
            .split_whitespace()
            .next()
            .is_some_and(|first| basename_lower(first) == "ssh")
    }

    fn ssh_activity(state: &AppState) -> bool {
        let snapshot = state.ssh_activity_snapshot();
        if snapshot.is_empty() {
            return false;
        }
        if snapshot
            .iter()
            .any(|(command, _)| is_ssh_command(command))
        {
            return true;
        }
        let roots: Vec<u32> = snapshot.iter().filter_map(|(_, pid)| *pid).collect();
        !roots.is_empty() && has_ssh_descendant(&roots)
    }

    // Long transfers deserve the same keep-awake treatment as shells.
    const REMOTE_PROCESS_NAMES: [&str; 3] = ["ssh", "sftp", "scp"];

    /// One `ps` snapshot per scan, walked in-process. ControlPersist masters
    /// from ssh_fs reparent to launchd and so are never reached from our
    /// roots — correct, since an idle file-ops master shouldn't keep the Mac
    /// awake (it self-expires after 5 min anyway).
    fn has_ssh_descendant(roots: &[u32]) -> bool {
        let Ok(output) = std::process::Command::new("/bin/ps")
            .args(["-axo", "pid=,ppid=,command="])
            .output()
        else {
            return false;
        };
        if !output.status.success() {
            return false;
        }
        let table = String::from_utf8_lossy(&output.stdout);

        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut name_by_pid: HashMap<u32, String> = HashMap::new();
        let mut queue: VecDeque<u32> = roots.iter().copied().collect();
        for line in table.lines() {
            let mut fields = line.split_whitespace();
            let Some(pid) = fields.next().and_then(|t| t.parse::<u32>().ok()) else {
                continue;
            };
            let Some(ppid) = fields.next().and_then(|t| t.parse::<u32>().ok()) else {
                continue;
            };
            let Some(first_arg) = fields.next() else {
                continue;
            };
            let name = basename_lower(first_arg);
            // Persistent sessions live in a detached zellij server (child of
            // launchd, not of our PTY), so an `ssh` typed inside one is only
            // reachable by treating our servers as extra roots.
            if name == "zellij" && line.contains(crate::pty::AGENTS_UI_ZELLIJ_PREFIX) {
                queue.push_back(pid);
            }
            children.entry(ppid).or_default().push(pid);
            name_by_pid.insert(pid, name);
        }

        let mut seen: HashSet<u32> = HashSet::new();
        while let Some(pid) = queue.pop_front() {
            if !seen.insert(pid) {
                continue;
            }
            if name_by_pid
                .get(&pid)
                .is_some_and(|name| REMOTE_PROCESS_NAMES.contains(&name.as_str()))
            {
                return true;
            }
            if let Some(kids) = children.get(&pid) {
                queue.extend(kids.iter().copied());
            }
        }
        false
    }
}

/// Start the auto-caffeinate watcher. No-op on non-macOS platforms.
#[cfg(target_os = "macos")]
pub fn start(app: tauri::AppHandle, state: crate::pty::AppState) {
    imp::start(app, state);
}

/// Ask the watcher to re-evaluate SSH activity promptly (≤1s) instead of
/// waiting out the scan interval — called when a session spawns so the
/// assertion engages as soon as an SSH session opens.
#[cfg(target_os = "macos")]
pub fn poke() {
    imp::poke();
}

#[cfg(not(target_os = "macos"))]
pub fn start(_app: tauri::AppHandle, _state: crate::pty::AppState) {}

#[cfg(not(target_os = "macos"))]
pub fn poke() {}
