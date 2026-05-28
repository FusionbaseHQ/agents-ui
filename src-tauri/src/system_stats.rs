use serde::Serialize;
use std::process::{Command, Output, Stdio};

use crate::ssh_fs::run_ssh_script;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemHealthStats {
    pub cpu_percent: Option<f64>,
    pub memory_used_bytes: Option<u64>,
    pub memory_free_bytes: Option<u64>,
    pub memory_total_bytes: Option<u64>,
    pub disk_used_bytes: Option<u64>,
    pub disk_free_bytes: Option<u64>,
    pub disk_total_bytes: Option<u64>,
}

const HEALTH_STATS_SCRIPT: &str = r#"
cores="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || printf '1')"
case "$cores" in ''|*[!0-9]*) cores=1 ;; esac
if command -v ps >/dev/null 2>&1 && command -v awk >/dev/null 2>&1; then
  ps -A -o %cpu= 2>/dev/null | awk -v n="$cores" '{ s += $1 } END { if (n > 0) { v = s / n; if (v < 0) v = 0; if (v > 100) v = 100; printf "cpu_percent=%.1f\n", v } }'
fi
if [ -r /proc/meminfo ] && command -v awk >/dev/null 2>&1; then
  awk '/^MemTotal:/ { total = $2 * 1024 } /^MemAvailable:/ { free = $2 * 1024 } END { if (total > 0 && free >= 0) { used = total - free; if (used < 0) used = 0; printf "memory_total_bytes=%.0f\nmemory_free_bytes=%.0f\nmemory_used_bytes=%.0f\n", total, free, used } }' /proc/meminfo 2>/dev/null
elif command -v sysctl >/dev/null 2>&1 && command -v vm_stat >/dev/null 2>&1 && command -v awk >/dev/null 2>&1; then
  total="$(sysctl -n hw.memsize 2>/dev/null)"
  vm_stat 2>/dev/null | awk -v total="$total" '/page size of/ { gsub("\\.", "", $8); page = $8 } /Pages free/ { gsub("\\.", "", $3); free = $3 } /Pages inactive/ { gsub("\\.", "", $3); inactive = $3 } /Pages speculative/ { gsub("\\.", "", $3); speculative = $3 } END { if (total > 0 && page > 0) { avail = (free + inactive + speculative) * page; if (avail < 0) avail = 0; if (avail > total) avail = total; used = total - avail; printf "memory_total_bytes=%.0f\nmemory_free_bytes=%.0f\nmemory_used_bytes=%.0f\n", total, avail, used } }'
elif command -v free >/dev/null 2>&1 && command -v awk >/dev/null 2>&1; then
  free -b 2>/dev/null | awk '/^Mem:/ { total = $2; used = $3; free = $7; if (free == "") free = $4; if (total > 0) printf "memory_total_bytes=%.0f\nmemory_free_bytes=%.0f\nmemory_used_bytes=%.0f\n", total, free, used }'
fi
if command -v df >/dev/null 2>&1 && command -v awk >/dev/null 2>&1; then
  df -Pk / 2>/dev/null | awk 'NR == 2 { total = $2 * 1024; used = $3 * 1024; free = $4 * 1024; if (total > 0) printf "disk_total_bytes=%.0f\ndisk_used_bytes=%.0f\ndisk_free_bytes=%.0f\n", total, used, free }'
fi
"#;

fn parse_optional_u64(value: Option<&String>) -> Option<u64> {
    value?.trim().parse::<u64>().ok()
}

fn parse_optional_f64(value: Option<&String>) -> Option<f64> {
    let parsed = value?.trim().parse::<f64>().ok()?;
    if parsed.is_finite() {
        Some(parsed.clamp(0.0, 100.0))
    } else {
        None
    }
}

fn parse_health_stats(output: &Output) -> Option<SystemHealthStats> {
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut values = std::collections::HashMap::<String, String>::new();
    for line in stdout.lines() {
        let Some((key, value)) = line.trim().split_once('=') else {
            continue;
        };
        values.insert(key.trim().to_string(), value.trim().to_string());
    }

    let stats = SystemHealthStats {
        cpu_percent: parse_optional_f64(values.get("cpu_percent")),
        memory_used_bytes: parse_optional_u64(values.get("memory_used_bytes")),
        memory_free_bytes: parse_optional_u64(values.get("memory_free_bytes")),
        memory_total_bytes: parse_optional_u64(values.get("memory_total_bytes")),
        disk_used_bytes: parse_optional_u64(values.get("disk_used_bytes")),
        disk_free_bytes: parse_optional_u64(values.get("disk_free_bytes")),
        disk_total_bytes: parse_optional_u64(values.get("disk_total_bytes")),
    };

    if stats.cpu_percent.is_some()
        || stats.memory_used_bytes.is_some()
        || stats.memory_free_bytes.is_some()
        || stats.disk_used_bytes.is_some()
        || stats.disk_free_bytes.is_some()
    {
        Some(stats)
    } else {
        None
    }
}

fn command_stdout(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

fn digits_to_u64(value: &str) -> Option<u64> {
    let digits: String = value.chars().filter(|ch| ch.is_ascii_digit()).collect();
    digits.parse::<u64>().ok()
}

fn local_cpu_percent() -> Option<f64> {
    let cores = command_stdout("/usr/bin/getconf", &["_NPROCESSORS_ONLN"])
        .or_else(|| command_stdout("/bin/getconf", &["_NPROCESSORS_ONLN"]))
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|v| *v > 0.0)
        .unwrap_or(1.0);
    let stdout = command_stdout("/bin/ps", &["-A", "-o", "%cpu="])
        .or_else(|| command_stdout("/usr/bin/ps", &["-A", "-o", "%cpu="]))?;
    let total = stdout
        .lines()
        .filter_map(|line| line.trim().parse::<f64>().ok())
        .sum::<f64>();
    Some((total / cores).clamp(0.0, 100.0))
}

fn parse_vm_stat_memory(stdout: &str, total_override: Option<u64>) -> Option<(u64, u64, u64)> {
    let mut page_size = 4096u64;
    let mut free_pages = 0u64;
    let mut inactive_pages = 0u64;
    let mut speculative_pages = 0u64;
    let mut active_pages = 0u64;
    let mut wired_pages = 0u64;
    let mut compressor_pages = 0u64;
    let mut throttled_pages = 0u64;

    for line in stdout.lines() {
        if line.contains("page size of") {
            if let Some(value) = line
                .split("page size of")
                .nth(1)
                .and_then(|rest| digits_to_u64(rest))
            {
                page_size = value;
            }
            continue;
        }

        let Some((label, raw_value)) = line.split_once(':') else {
            continue;
        };
        let Some(value) = digits_to_u64(raw_value) else {
            continue;
        };
        match label.trim() {
            "Pages free" => free_pages = value,
            "Pages inactive" => inactive_pages = value,
            "Pages speculative" => speculative_pages = value,
            "Pages active" => active_pages = value,
            "Pages wired down" => wired_pages = value,
            "Pages occupied by compressor" => compressor_pages = value,
            "Pages throttled" => throttled_pages = value,
            _ => {}
        }
    }

    let available_pages = free_pages
        .saturating_add(inactive_pages)
        .saturating_add(speculative_pages);
    let observed_total_pages = available_pages
        .saturating_add(active_pages)
        .saturating_add(wired_pages)
        .saturating_add(compressor_pages)
        .saturating_add(throttled_pages);
    let total = total_override.unwrap_or_else(|| observed_total_pages.saturating_mul(page_size));
    if total == 0 {
        return None;
    }
    let free = available_pages.saturating_mul(page_size).min(total);
    let used = total.saturating_sub(free);
    Some((used, free, total))
}

fn local_memory_bytes() -> Option<(u64, u64, u64)> {
    #[cfg(target_os = "macos")]
    {
        let total = command_stdout("/usr/sbin/sysctl", &["-n", "hw.memsize"])
            .or_else(|| command_stdout("/sbin/sysctl", &["-n", "hw.memsize"]))
            .and_then(|v| v.trim().parse::<u64>().ok());
        let vm_stat = command_stdout("/usr/bin/vm_stat", &[])
            .or_else(|| command_stdout("/bin/vm_stat", &[]))?;
        return parse_vm_stat_memory(&vm_stat, total);
    }

    #[cfg(target_os = "linux")]
    {
        let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
        let mut total = None;
        let mut available = None;
        for line in meminfo.lines() {
            if let Some(rest) = line.strip_prefix("MemTotal:") {
                total = digits_to_u64(rest).and_then(|kb| kb.checked_mul(1024));
            } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
                available = digits_to_u64(rest).and_then(|kb| kb.checked_mul(1024));
            }
        }
        let total = total?;
        let free = available?.min(total);
        return Some((total.saturating_sub(free), free, total));
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

fn local_disk_bytes() -> Option<(u64, u64, u64)> {
    let stdout = command_stdout("/bin/df", &["-Pk", "/"])
        .or_else(|| command_stdout("/usr/bin/df", &["-Pk", "/"]))?;
    let line = stdout.lines().nth(1)?;
    let mut parts = line.split_whitespace();
    let _filesystem = parts.next()?;
    let total = parts.next()?.parse::<u64>().ok()?.checked_mul(1024)?;
    let used = parts.next()?.parse::<u64>().ok()?.checked_mul(1024)?;
    let free = parts.next()?.parse::<u64>().ok()?.checked_mul(1024)?;
    Some((used, free, total))
}

fn local_system_health_stats_sync() -> Option<SystemHealthStats> {
    let shell_stats = Command::new("/bin/sh")
        .arg("-c")
        .arg(HEALTH_STATS_SCRIPT)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()
        .and_then(|output| parse_health_stats(&output));

    let memory = local_memory_bytes();
    let disk = local_disk_bytes();
    let stats = SystemHealthStats {
        cpu_percent: shell_stats
            .as_ref()
            .and_then(|stats| stats.cpu_percent)
            .or_else(local_cpu_percent),
        memory_used_bytes: memory.map(|(used, _, _)| used).or_else(|| {
            shell_stats.as_ref().and_then(|stats| stats.memory_used_bytes)
        }),
        memory_free_bytes: memory.map(|(_, free, _)| free).or_else(|| {
            shell_stats.as_ref().and_then(|stats| stats.memory_free_bytes)
        }),
        memory_total_bytes: memory.map(|(_, _, total)| total).or_else(|| {
            shell_stats.as_ref().and_then(|stats| stats.memory_total_bytes)
        }),
        disk_used_bytes: disk.map(|(used, _, _)| used).or_else(|| {
            shell_stats.as_ref().and_then(|stats| stats.disk_used_bytes)
        }),
        disk_free_bytes: disk.map(|(_, free, _)| free).or_else(|| {
            shell_stats.as_ref().and_then(|stats| stats.disk_free_bytes)
        }),
        disk_total_bytes: disk.map(|(_, _, total)| total).or_else(|| {
            shell_stats.as_ref().and_then(|stats| stats.disk_total_bytes)
        }),
    };

    if stats.cpu_percent.is_some()
        || stats.memory_used_bytes.is_some()
        || stats.memory_free_bytes.is_some()
        || stats.disk_used_bytes.is_some()
        || stats.disk_free_bytes.is_some()
    {
        Some(stats)
    } else {
        None
    }
}

fn ssh_system_health_stats_sync(target: String) -> Option<SystemHealthStats> {
    let target = target.trim();
    if target.is_empty() {
        return None;
    }

    let output = run_ssh_script(target, HEALTH_STATS_SCRIPT).ok()?;
    parse_health_stats(&output)
}

#[tauri::command]
pub async fn system_health_stats() -> Result<Option<SystemHealthStats>, String> {
    tauri::async_runtime::spawn_blocking(local_system_health_stats_sync)
        .await
        .map_err(|e| format!("system stats task join failed: {e:?}"))
}

#[tauri::command]
pub async fn ssh_system_health_stats(target: String) -> Result<Option<SystemHealthStats>, String> {
    tauri::async_runtime::spawn_blocking(move || ssh_system_health_stats_sync(target))
        .await
        .map_err(|e| format!("ssh system stats task join failed: {e:?}"))
}
