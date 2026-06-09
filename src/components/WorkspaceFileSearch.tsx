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

const MAX_SAMPLE_DIRS_LOCAL = 160;
const MAX_SAMPLE_DIRS_SSH = 45;
const MAX_SAMPLE_FILES_LOCAL = 1_200;
const MAX_SAMPLE_FILES_SSH = 450;
const MAX_SAMPLE_FILES_PER_DIR = 60;
const BACKEND_SEARCH_LIMIT = 300;
const MIN_BACKEND_QUERY_LENGTH = 2;
const MAX_RESULTS = 80;
const SAMPLE_CACHE_TTL_MS = 60_000;
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

type SampleCacheEntry = {
  entries: FsEntry[];
  status: string;
  createdAt: number;
};

const sampleCache = new Map<string, SampleCacheEntry>();

function sampleCacheKey(provider: "local" | "ssh", root: string, target: string): string {
  return `${provider}\0${target}\0${root}`;
}

function relativePath(rootDir: string, path: string): string {
  const root = rootDir.replace(/\/+$/, "");
  if (!root || path === root) return path;
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function searchSortKey(entry: FsEntry): [number, string] {
  return [entry.name.startsWith(".") ? 1 : 0, entry.name.toLowerCase()];
}

function sortForSearch(entries: FsEntry[]): FsEntry[] {
  return entries.slice().sort((a, b) => {
    const [aHidden, aName] = searchSortKey(a);
    const [bHidden, bName] = searchSortKey(b);
    return aHidden - bHidden || aName.localeCompare(bName);
  });
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
  const [sampleEntries, setSampleEntries] = React.useState<FsEntry[]>([]);
  const [sampleStatus, setSampleStatus] = React.useState("Ready");
  const [searchState, setSearchState] = React.useState<{
    query: string;
    entries: FsEntry[];
    status: string;
    loading: boolean;
  }>({ query: "", entries: [], status: "", loading: false });
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
    setSearchState({ query: "", entries: [], status: "", loading: false });

    if (!root) {
      setSampleEntries([]);
      setSampleStatus("Workspace root unavailable");
      return;
    }
    if (provider === "ssh" && !target) {
      setSampleEntries([]);
      setSampleStatus("Missing SSH target.");
      return;
    }

    const cacheKey = sampleCacheKey(provider, root, provider === "ssh" ? target : "");
    const cached = sampleCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt <= SAMPLE_CACHE_TTL_MS) {
      setSampleEntries(cached.entries);
      setSampleStatus(cached.status);
      return;
    }

    setSampleEntries([]);
    setSampleStatus("Loading workspace sample...");

    void (async () => {
      const files: FsEntry[] = [];
      const queue = [root];
      const maxDirs = provider === "ssh" ? MAX_SAMPLE_DIRS_SSH : MAX_SAMPLE_DIRS_LOCAL;
      const maxFiles = provider === "ssh" ? MAX_SAMPLE_FILES_SSH : MAX_SAMPLE_FILES_LOCAL;
      let scannedDirs = 0;
      let skipped = false;
      let cursor = 0;

      while (cursor < queue.length && !cancelled && scannedDirs < maxDirs && files.length < maxFiles) {
        const dir = queue[cursor++]!;
        scannedDirs++;
        try {
          const children =
            provider === "ssh"
              ? await invoke<FsEntry[]>("ssh_list_fs_entries", { target, root, path: dir })
              : await invoke<FsEntry[]>("list_fs_entries", { root, path: dir });

          const sortedChildren = sortForSearch(children);
          const dirs: FsEntry[] = [];
          let filesFromDir = 0;

          for (const child of sortedChildren) {
            if (child.isDir) {
              if (IGNORED_DIRS.has(child.name)) {
                skipped = true;
              } else {
                dirs.push(child);
              }
              continue;
            }
            if (filesFromDir >= MAX_SAMPLE_FILES_PER_DIR) {
              skipped = true;
              continue;
            }
            files.push(child);
            filesFromDir++;
            if (files.length % 120 === 0) setSampleEntries(files.slice());
            if (files.length >= maxFiles) break;
          }

          for (const child of dirs) {
            queue.push(child.path);
          }
        } catch {
          skipped = true;
        }
      }

      if (cancelled) return;
      const finalEntries = files.slice();
      const capped = scannedDirs >= maxDirs || files.length >= maxFiles;
      const status =
        `${files.length.toLocaleString()} sampled` +
          (capped ? " (limited)" : "") +
          (skipped ? " - some folders skipped" : "") +
          ` - type ${MIN_BACKEND_QUERY_LENGTH}+ chars to search all`;
      sampleCache.set(cacheKey, { entries: finalEntries, status, createdAt: Date.now() });
      setSampleEntries(finalEntries);
      setSampleStatus(status);
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, provider, rootDir, sshTarget]);

  React.useEffect(() => {
    if (!isOpen) return;
    const root = rootDir.trim();
    const target = (sshTarget ?? "").trim();
    const q = query.trim();
    if (!root || q.length < MIN_BACKEND_QUERY_LENGTH) {
      setSearchState((prev) =>
        prev.query === "" && prev.entries.length === 0 && !prev.loading ? prev : { query: "", entries: [], status: "", loading: false },
      );
      return;
    }
    if (provider === "ssh" && !target) {
      setSearchState({ query: q, entries: [], status: "Missing SSH target.", loading: false });
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearchState({ query: q, entries: [], status: "Searching full workspace...", loading: true });
      const command = provider === "ssh" ? "ssh_search_fs_entries" : "search_fs_entries";
      const args =
        provider === "ssh"
          ? { target, root, query: q, limit: BACKEND_SEARCH_LIMIT }
          : { root, query: q, limit: BACKEND_SEARCH_LIMIT };
      void invoke<FsEntry[]>(command, args)
        .then((found) => {
          if (cancelled) return;
          const limited = found.length >= BACKEND_SEARCH_LIMIT;
          setSearchState({
            query: q,
            entries: found,
            status:
              `${found.length.toLocaleString()} full-search match${found.length === 1 ? "" : "es"}` +
              (limited ? " (limited)" : ""),
            loading: false,
          });
        })
        .catch((err) => {
          if (cancelled) return;
          const message = err instanceof Error ? err.message : String(err);
          setSearchState({
            query: q,
            entries: [],
            status: `Full search failed: ${message}`,
            loading: false,
          });
        });
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isOpen, provider, query, rootDir, sshTarget]);

  const results = React.useMemo(() => {
    const root = rootDir.trim();
    const q = query.trim();
    const fullSearchReady = q.length >= MIN_BACKEND_QUERY_LENGTH && searchState.query === q && !searchState.loading;
    const fullSearchFailed = searchState.status.startsWith("Full search failed:");
    const sourceEntries = fullSearchReady && !fullSearchFailed ? searchState.entries : sampleEntries;
    return sourceEntries
      .map((entry) => {
        const rel = relativePath(root, entry.path);
        const score = fuzzyScore(rel, q);
        return score == null ? null : { entry, rel, score };
      })
      .filter((item): item is { entry: FsEntry; rel: string; score: number } => item != null)
      .sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))
      .slice(0, MAX_RESULTS);
  }, [query, rootDir, sampleEntries, searchState.entries, searchState.loading, searchState.query, searchState.status]);

  const status = React.useMemo(() => {
    const q = query.trim();
    if (q.length >= MIN_BACKEND_QUERY_LENGTH) {
      if (searchState.query === q && searchState.status) return searchState.status;
      return "Preparing full workspace search...";
    }
    return sampleStatus;
  }, [query, sampleStatus, searchState.query, searchState.status]);

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
            <div className="workspaceFileSearchEmpty">
              {query.trim().length >= MIN_BACKEND_QUERY_LENGTH && searchState.loading
                ? "Searching..."
                : sampleEntries.length || searchState.entries.length
                  ? "No matching files."
                  : "Scanning..."}
            </div>
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
