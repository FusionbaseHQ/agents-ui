import { invoke } from "@tauri-apps/api/core";
import React from "react";
import { Icon } from "./Icon";

type FsEntry = {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
};

type WorkspaceFileSearchProps = {
  isOpen: boolean;
  provider: "local" | "ssh";
  rootDir: string;
  sshTarget?: string | null;
  onOpenFile: (path: string) => void;
  onClose: () => void;
};

const MAX_SCAN_DIRS = 700;
const MAX_SCAN_FILES = 5_000;
const MAX_RESULTS = 80;
const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
]);

function relativePath(rootDir: string, path: string): string {
  const root = rootDir.replace(/\/+$/, "");
  if (!root || path === root) return path;
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function fuzzyScore(path: string, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 1;

  const text = path.toLowerCase();
  const base = text.split("/").pop() ?? text;
  if (base === q) return 200;
  if (base.startsWith(q)) return 170;
  if (base.includes(q)) return 145;
  if (text.includes(q)) return 120;

  let qi = 0;
  let consecutive = 0;
  let bestRun = 0;
  let first = -1;
  for (let i = 0; i < text.length && qi < q.length; i++) {
    if (text[i] === q[qi]) {
      if (first < 0) first = i;
      qi++;
      consecutive++;
      bestRun = Math.max(bestRun, consecutive);
    } else {
      consecutive = 0;
    }
  }
  if (qi !== q.length) return null;
  return 60 + bestRun * 8 - Math.max(0, first);
}

export function WorkspaceFileSearch({
  isOpen,
  provider,
  rootDir,
  sshTarget,
  onOpenFile,
  onClose,
}: WorkspaceFileSearchProps) {
  const [query, setQuery] = React.useState("");
  const [entries, setEntries] = React.useState<FsEntry[]>([]);
  const [status, setStatus] = React.useState("Ready");
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useLayoutEffect(() => {
    if (!isOpen) return;
    setQuery("");
    setSelectedIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [isOpen]);

  React.useEffect(() => {
    if (!isOpen) return;
    const root = rootDir.trim();
    const target = (sshTarget ?? "").trim();
    let cancelled = false;
    setEntries([]);
    setStatus(root ? "Scanning workspace..." : "Workspace root unavailable");

    if (!root) return;

    void (async () => {
      const files: FsEntry[] = [];
      const stack = [root];
      let scannedDirs = 0;
      let skipped = false;

      while (stack.length > 0 && !cancelled && scannedDirs < MAX_SCAN_DIRS && files.length < MAX_SCAN_FILES) {
        const dir = stack.pop()!;
        scannedDirs++;
        try {
          const children =
            provider === "ssh"
              ? await invoke<FsEntry[]>("ssh_list_fs_entries", { target, root, path: dir })
              : await invoke<FsEntry[]>("list_fs_entries", { root, path: dir });
          for (let i = children.length - 1; i >= 0; i--) {
            const child = children[i];
            if (child.isDir) {
              if (IGNORED_DIRS.has(child.name)) {
                skipped = true;
                continue;
              }
              stack.push(child.path);
            } else {
              files.push(child);
              if (files.length % 150 === 0) setEntries(files.slice());
              if (files.length >= MAX_SCAN_FILES) break;
            }
          }
        } catch {
          skipped = true;
        }
      }

      if (cancelled) return;
      setEntries(files.slice());
      const capped = scannedDirs >= MAX_SCAN_DIRS || files.length >= MAX_SCAN_FILES;
      setStatus(
        `${files.length.toLocaleString()} files` +
          (capped ? " (limited scan)" : "") +
          (skipped ? " - some folders skipped" : ""),
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, provider, rootDir, sshTarget]);

  const results = React.useMemo(() => {
    const root = rootDir.trim();
    const q = query.trim();
    return entries
      .map((entry) => {
        const rel = relativePath(root, entry.path);
        const score = fuzzyScore(rel, q);
        return score == null ? null : { entry, rel, score };
      })
      .filter((item): item is { entry: FsEntry; rel: string; score: number } => item != null)
      .sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))
      .slice(0, MAX_RESULTS);
  }, [entries, query, rootDir]);

  React.useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const openResult = React.useCallback(
    (index: number) => {
      const item = results[index];
      if (!item) return;
      onOpenFile(item.entry.path);
      onClose();
    },
    [onClose, onOpenFile, results],
  );

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((value) => Math.min(value + 1, Math.max(0, results.length - 1)));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((value) => Math.max(0, value - 1));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        openResult(selectedIndex);
      }
    },
    [onClose, openResult, results.length, selectedIndex],
  );

  if (!isOpen) return null;

  return (
    <div className="workspaceFileSearchBackdrop" onClick={onClose}>
      <div className="workspaceFileSearch" onClick={(event) => event.stopPropagation()}>
        <div className="workspaceFileSearchInputRow">
          <Icon name="search" size={15} />
          <input
            ref={inputRef}
            className="workspaceFileSearchInput"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Open file by name or path"
          />
        </div>
        <div className="workspaceFileSearchStatus">{status}</div>
        <div className="workspaceFileSearchList">
          {results.length === 0 ? (
            <div className="workspaceFileSearchEmpty">{entries.length ? "No matching files." : "Scanning..."}</div>
          ) : (
            results.map((item, index) => (
              <button
                key={item.entry.path}
                type="button"
                className={`workspaceFileSearchItem ${index === selectedIndex ? "workspaceFileSearchItemSelected" : ""}`}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => openResult(index)}
                title={item.entry.path}
              >
                <Icon name="file" size={14} />
                <span className="workspaceFileSearchName">{item.entry.name}</span>
                <span className="workspaceFileSearchPath">{item.rel}</span>
              </button>
            ))
          )}
        </div>
        <div className="workspaceFileSearchFooter">
          <kbd>Up</kbd><kbd>Down</kbd> navigate <kbd>Enter</kbd> open <kbd>Esc</kbd> close
        </div>
      </div>
    </div>
  );
}
