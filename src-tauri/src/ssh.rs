use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Default, Clone)]
struct HostOptions {
    host_name: Option<String>,
    user: Option<String>,
    port: Option<u16>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SshHostEntry {
    pub alias: String,
    pub host_name: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(target_family = "unix")]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
    #[cfg(not(target_family = "unix"))]
    {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    }
}

fn is_concrete_host_alias(pattern: &str) -> bool {
    let p = pattern.trim();
    if p.is_empty() {
        return false;
    }
    if p.starts_with('!') {
        return false;
    }
    !p.chars().any(|c| matches!(c, '*' | '?' | '[' | ']'))
}

fn merge_first_wins(dst: &mut HostOptions, src: &HostOptions) {
    if dst.host_name.is_none() {
        dst.host_name = src.host_name.clone();
    }
    if dst.user.is_none() {
        dst.user = src.user.clone();
    }
    if dst.port.is_none() {
        dst.port = src.port;
    }
}

fn tokenize_line(line: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut chars = line.chars().peekable();

    while let Some(c) = chars.next() {
        if quote.is_none() && c == '#' {
            break;
        }

        if c == '\\' {
            if let Some(next) = chars.next() {
                cur.push(next);
            }
            continue;
        }

        if c == '"' || c == '\'' {
            match quote {
                Some(q) if q == c => quote = None,
                None => quote = Some(c),
                _ => cur.push(c),
            }
            continue;
        }

        if quote.is_none() && c.is_whitespace() {
            if !cur.is_empty() {
                tokens.push(cur.clone());
                cur.clear();
            }
            while matches!(chars.peek(), Some(p) if p.is_whitespace()) {
                chars.next();
            }
            continue;
        }

        cur.push(c);
    }

    if !cur.is_empty() {
        tokens.push(cur);
    }

    tokens
}

fn contains_glob(s: &str) -> bool {
    s.chars().any(|c| matches!(c, '*' | '?' | '['))
}

fn matches_glob(pattern: &str, text: &str) -> bool {
    fn inner(pat: &[char], txt: &[char], pi: usize, ti: usize) -> bool {
        if pi >= pat.len() {
            return ti >= txt.len();
        }

        match pat[pi] {
            '*' => {
                for next_ti in ti..=txt.len() {
                    if inner(pat, txt, pi + 1, next_ti) {
                        return true;
                    }
                }
                false
            }
            '?' => {
                if ti >= txt.len() {
                    return false;
                }
                inner(pat, txt, pi + 1, ti + 1)
            }
            '[' => {
                if ti >= txt.len() {
                    return false;
                }

                let mut j = pi + 1;
                let mut negate = false;
                if j < pat.len() && pat[j] == '!' {
                    negate = true;
                    j += 1;
                }

                let mut matched = false;
                while j < pat.len() && pat[j] != ']' {
                    if j + 2 < pat.len() && pat[j + 1] == '-' && pat[j + 2] != ']' {
                        let start = pat[j] as u32;
                        let end = pat[j + 2] as u32;
                        let c = txt[ti] as u32;
                        if start <= c && c <= end {
                            matched = true;
                        }
                        j += 3;
                        continue;
                    }
                    if pat[j] == txt[ti] {
                        matched = true;
                    }
                    j += 1;
                }

                if j >= pat.len() || pat[j] != ']' {
                    // Unclosed bracket expression; treat '[' literally.
                    return pat[pi] == txt[ti] && inner(pat, txt, pi + 1, ti + 1);
                }

                if negate {
                    matched = !matched;
                }

                if !matched {
                    return false;
                }

                inner(pat, txt, j + 1, ti + 1)
            }
            c => {
                if ti >= txt.len() || txt[ti] != c {
                    return false;
                }
                inner(pat, txt, pi + 1, ti + 1)
            }
        }
    }

    inner(
        &pattern.chars().collect::<Vec<char>>(),
        &text.chars().collect::<Vec<char>>(),
        0,
        0,
    )
}

fn expand_tilde(path: &str, home: &Path) -> PathBuf {
    let trimmed = path.trim();
    if trimmed == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return home.join(rest);
    }
    PathBuf::from(trimmed)
}

fn glob_paths(pattern: &Path) -> Vec<PathBuf> {
    let raw = pattern.to_string_lossy().to_string();
    if !contains_glob(&raw) {
        return vec![pattern.to_path_buf()];
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    let mut parts: Vec<String> = Vec::new();
    for part in raw.split(&['/', '\\'][..]).filter(|s| !s.is_empty()) {
        parts.push(part.to_string());
    }

    let mut roots: Vec<PathBuf> = Vec::new();
    if raw.starts_with('/') {
        roots.push(PathBuf::from("/"));
    } else {
        roots.push(PathBuf::from("."));
    }

    for part in parts {
        let has_glob = contains_glob(&part);
        let mut next_roots: Vec<PathBuf> = Vec::new();

        for root in &roots {
            if !has_glob {
                let next = root.join(&part);
                if next.exists() {
                    next_roots.push(next);
                }
                continue;
            }

            let dir = root;
            let read_dir = match fs::read_dir(dir) {
                Ok(rd) => rd,
                Err(_) => continue,
            };

            for entry in read_dir.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if matches_glob(&part, &name) {
                    next_roots.push(entry.path());
                }
            }
        }

        roots = next_roots;
    }

    for p in roots {
        candidates.push(p);
    }

    candidates
}

fn collect_from_config(
    config_path: &Path,
    out: &mut HashMap<String, HostOptions>,
    visited: &mut HashSet<PathBuf>,
    depth: usize,
    ignore_read_errors: bool,
) -> Result<(), String> {
    if depth > 12 {
        return Ok(());
    }

    let canonical = fs::canonicalize(config_path).unwrap_or_else(|_| config_path.to_path_buf());
    if !visited.insert(canonical) {
        return Ok(());
    }

    let raw = match fs::read_to_string(config_path) {
        Ok(s) => s,
        Err(e) if ignore_read_errors => {
            eprintln!("ssh config read failed: {config_path:?}: {e}");
            return Ok(());
        }
        Err(e) => return Err(format!("ssh config read failed: {e}")),
    };

    let base_dir = config_path.parent().unwrap_or_else(|| Path::new("."));
    let home = home_dir().unwrap_or_else(|| PathBuf::from("."));

    let mut current_patterns: Vec<String> = Vec::new();
    let mut current_options = HostOptions::default();

    let flush = |patterns: &Vec<String>,
                 options: &HostOptions,
                 out: &mut HashMap<String, HostOptions>| {
        if patterns.is_empty() {
            return;
        }
        for pat in patterns {
            if !is_concrete_host_alias(pat) {
                continue;
            }
            let alias = pat.trim().to_string();
            let entry = out.entry(alias).or_insert_with(HostOptions::default);
            merge_first_wins(entry, options);
        }
    };

    for line in raw.lines() {
        let tokens = tokenize_line(line);
        if tokens.is_empty() {
            continue;
        }
        let key = tokens[0].to_lowercase();

        match key.as_str() {
            "include" => {
                for include_raw in tokens.iter().skip(1) {
                    let mut include_path = expand_tilde(include_raw, &home);
                    if include_path.is_relative() {
                        include_path = base_dir.join(include_path);
                    }

                    let mut paths = glob_paths(&include_path);
                    paths.sort_by(|a, b| a.to_string_lossy().to_string().cmp(&b.to_string_lossy().to_string()));

                    for p in paths {
                        if p.is_file() {
                            collect_from_config(&p, out, visited, depth + 1, true)?;
                        }
                    }
                }
            }
            "host" => {
                flush(&current_patterns, &current_options, out);
                current_patterns = tokens.iter().skip(1).cloned().collect();
                current_options = HostOptions::default();
            }
            "match" => {
                flush(&current_patterns, &current_options, out);
                current_patterns.clear();
                current_options = HostOptions::default();
            }
            "hostname" => {
                if current_patterns.is_empty() {
                    continue;
                }
                let value = tokens
                    .iter()
                    .skip(1)
                    .cloned()
                    .collect::<Vec<String>>()
                    .join(" ")
                    .trim()
                    .to_string();
                if !value.is_empty() {
                    current_options.host_name = Some(value);
                }
            }
            "user" => {
                if current_patterns.is_empty() {
                    continue;
                }
                let value = tokens
                    .iter()
                    .skip(1)
                    .cloned()
                    .collect::<Vec<String>>()
                    .join(" ")
                    .trim()
                    .to_string();
                if !value.is_empty() {
                    current_options.user = Some(value);
                }
            }
            "port" => {
                if current_patterns.is_empty() {
                    continue;
                }
                let value = tokens.get(1).map(|s| s.trim()).unwrap_or("");
                if let Ok(port) = value.parse::<u16>() {
                    current_options.port = Some(port);
                }
            }
            _ => {}
        }
    }

    flush(&current_patterns, &current_options, out);
    Ok(())
}

#[tauri::command]
pub fn list_ssh_hosts() -> Result<Vec<SshHostEntry>, String> {
    let home = home_dir().ok_or("unable to determine home directory")?;
    let config_path = home.join(".ssh").join("config");
    if !config_path.exists() {
        return Ok(Vec::new());
    }

    let mut visited: HashSet<PathBuf> = HashSet::new();
    let mut entries: HashMap<String, HostOptions> = HashMap::new();
    collect_from_config(&config_path, &mut entries, &mut visited, 0, false)?;

    let mut out: Vec<SshHostEntry> = entries
        .into_iter()
        .map(|(alias, opts)| SshHostEntry {
            alias,
            host_name: opts.host_name,
            user: opts.user,
            port: opts.port,
        })
        .collect();

    out.sort_by(|a, b| a.alias.to_lowercase().cmp(&b.alias.to_lowercase()));
    Ok(out)
}

