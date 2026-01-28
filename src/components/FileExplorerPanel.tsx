import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import React from "react";
import { shortenPathSmart } from "../pathDisplay";
import { Icon } from "./Icon";
import { ConfirmActionModal } from "./modals/ConfirmActionModal";

// Cache for downloaded SSH files to avoid re-downloading during the same session
const sshFileCache = new Map<string, string>();
const dragIconCache = new Map<"file" | "folder", string>();

type FsEntry = {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
};

type DirectoryState = {
  entries: FsEntry[];
  loading: boolean;
  error: string | null;
};

export type FileExplorerPersistedEntry = {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
};

export type FileExplorerPersistedDirState = {
  entries: FileExplorerPersistedEntry[];
  error: string | null;
};

export type FileExplorerPersistedState = {
  root: string;
  expandedDirs: string[];
  dirStateByPath: Record<string, FileExplorerPersistedDirState>;
  scrollTop: number;
};

type VisibleItem =
  | { type: "entry"; entry: FsEntry; depth: number }
  | { type: "loading"; path: string; depth: number }
  | { type: "error"; path: string; depth: number; message: string };

function normalizePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (trimmed === "/") return "/";
  return trimmed.replace(/\/+$/, "");
}

function dirname(input: string): string {
  const path = normalizePath(input);
  const idx = path.lastIndexOf("/");
  if (idx < 0) return path;
  if (idx === 0) return "/";
  return path.slice(0, idx);
}

function basename(input: string): string {
  const path = normalizePath(input).replace(/\\/g, "/");
  if (!path) return "";
  if (path === "/") return "/";
  const idx = path.lastIndexOf("/");
  if (idx < 0) return path;
  return path.slice(idx + 1);
}

function joinPath(dir: string, name: string): string {
  const base = normalizePath(dir);
  if (base === "/") return `/${name}`;
  return `${base}/${name}`;
}

function parseFileUrlPath(data: string): string | null {
  if (!data.startsWith("file://")) return null;
  const rest = data.slice("file://".length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx < 0) return null;
  const rawPath = rest.slice(slashIdx);
  try {
    const decoded = decodeURIComponent(rawPath);
    if (/^\/[A-Za-z]:\//.test(decoded)) return decoded.slice(1);
    return decoded;
  } catch {
    if (/^\/[A-Za-z]:\//.test(rawPath)) return rawPath.slice(1);
    return rawPath;
  }
}

function relativePath(rootDir: string, absolutePath: string): string {
  const root = normalizePath(rootDir);
  const path = normalizePath(absolutePath);
  if (path === root) return "";
  if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path;
}

async function copyToClipboard(text: string): Promise<boolean> {
  const value = text ?? "";
  if (!value) return false;

  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // fall through
  }

  try {
    const el = document.createElement("textarea");
    el.value = value;
    el.setAttribute("readonly", "true");
    el.style.position = "fixed";
    el.style.left = "-9999px";
    el.style.top = "0";
    document.body.appendChild(el);
    el.focus();
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

export function FileExplorerPanel({
  isOpen,
  provider,
  sshTarget,
  rootDir,
  persistedState,
  activeFilePath,
  onSelectFile,
  onOpenTerminalAtPath,
  onPersistState,
  onClose,
  onPathRenamed,
  onPathDeleted,
}: {
  isOpen: boolean;
  provider: "local" | "ssh";
  sshTarget?: string | null;
  rootDir: string;
  persistedState?: FileExplorerPersistedState | null;
  activeFilePath: string | null;
  onSelectFile: (path: string) => void;
  onOpenTerminalAtPath?: (path: string, provider: "local" | "ssh", sshTarget: string | null) => void;
  onPersistState?: (state: FileExplorerPersistedState) => void;
  onClose: () => void;
  onPathRenamed?: (fromPath: string, toPath: string) => void;
  onPathDeleted?: (path: string) => void;
}) {
  const root = React.useMemo(() => normalizePath(rootDir), [rootDir]);
  const sshTargetValue = React.useMemo(() => (sshTarget ?? "").trim() || null, [sshTarget]);
  const [expandedDirs, setExpandedDirs] = React.useState<Set<string>>(() => new Set([root]));
  const [dirStateByPath, setDirStateByPath] = React.useState<Record<string, DirectoryState>>({});
  const panelRef = React.useRef<HTMLElement | null>(null);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [listHeight, setListHeight] = React.useState(0);

  const [contextMenu, setContextMenu] = React.useState<{ x: number; y: number; entry: FsEntry } | null>(null);
  const contextMenuRef = React.useRef<HTMLDivElement | null>(null);
  const contextMenuOpenPath = contextMenu?.entry.path ?? null;

  const [renameTarget, setRenameTarget] = React.useState<FsEntry | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [renameBusy, setRenameBusy] = React.useState(false);
  const [renameError, setRenameError] = React.useState<string | null>(null);
  const renameInputRef = React.useRef<HTMLInputElement | null>(null);

  const [deleteTarget, setDeleteTarget] = React.useState<FsEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

  const [downloadBusy, setDownloadBusy] = React.useState(false);
  const [downloadError, setDownloadError] = React.useState<string | null>(null);
  const [dragDropActive, setDragDropActive] = React.useState(false);
  const [dropTarget, setDropTarget] = React.useState<string | null>(null);
  const [dragPreparing, setDragPreparing] = React.useState<string | null>(null);

  // Track mouse state for native drag initiation
  const mouseDownRef = React.useRef<{
    attemptId: number;
    entry: FsEntry;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const dragAttemptSeqRef = React.useRef(0);
  const dropRafRef = React.useRef<number | null>(null);
  const lastDropPosRef = React.useRef<{ x: number; y: number } | null>(null);

  const expandedDirsRef = React.useRef(expandedDirs);
  React.useLayoutEffect(() => {
    expandedDirsRef.current = expandedDirs;
  }, [expandedDirs]);

  const dirStateByPathRef = React.useRef(dirStateByPath);
  React.useLayoutEffect(() => {
    dirStateByPathRef.current = dirStateByPath;
  }, [dirStateByPath]);

  const scrollTopRef = React.useRef(scrollTop);
  React.useLayoutEffect(() => {
    scrollTopRef.current = scrollTop;
  }, [scrollTop]);

  const rootRef = React.useRef(root);
  React.useLayoutEffect(() => {
    rootRef.current = root;
  }, [root]);

  const onPersistStateRef = React.useRef(onPersistState);
  React.useEffect(() => {
    onPersistStateRef.current = onPersistState;
  }, [onPersistState]);

  const persistStateNow = React.useCallback(() => {
    const persist = onPersistStateRef.current;
    if (!persist) return;
    try {
      const currentRoot = rootRef.current;
      const expanded = Array.from(expandedDirsRef.current.values());
      const states = dirStateByPathRef.current;
      const persistedStates: Record<string, FileExplorerPersistedDirState> = {};
      for (const [path, state] of Object.entries(states)) {
        if (!state) continue;
        if (state.loading) continue;
        persistedStates[path] = {
          entries: state.entries as unknown as FileExplorerPersistedEntry[],
          error: state.error ?? null,
        };
      }
      persist({
        root: currentRoot,
        expandedDirs: expanded,
        dirStateByPath: persistedStates,
        scrollTop: scrollTopRef.current,
      });
    } catch {
      // Best-effort.
    }
  }, []);

  const persistTimerRef = React.useRef<number | null>(null);
  const schedulePersist = React.useCallback(() => {
    if (!onPersistStateRef.current) return;
    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      persistStateNow();
    }, 250);
  }, [persistStateNow]);

  React.useEffect(() => {
    if (!isOpen) return;
    schedulePersist();
  }, [dirStateByPath, expandedDirs, isOpen, root, schedulePersist, scrollTop]);

  React.useLayoutEffect(() => {
    return () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      persistStateNow();
    };
  }, [persistStateNow]);

  const loadDirectory = React.useCallback(
    async (path: string) => {
      const dirPath = normalizePath(path);
      setDirStateByPath((prev) => ({
        ...prev,
        [dirPath]: {
          entries: prev[dirPath]?.entries ?? [],
          loading: true,
          error: null,
        },
      }));
      try {
        if (provider === "ssh" && !sshTargetValue) {
          throw new Error("Missing SSH target.");
        }
        const entries =
          provider === "ssh"
            ? await invoke<FsEntry[]>("ssh_list_fs_entries", { target: sshTargetValue, root, path: dirPath })
            : await invoke<FsEntry[]>("list_fs_entries", { root, path: dirPath });
        setDirStateByPath((prev) => ({
          ...prev,
          [dirPath]: { entries, loading: false, error: null },
        }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setDirStateByPath((prev) => ({
          ...prev,
          [dirPath]: { entries: prev[dirPath]?.entries ?? [], loading: false, error: message },
        }));
      }
    },
    [provider, root, sshTargetValue],
  );

  React.useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const update = () => setListHeight(el.clientHeight);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  React.useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => setScrollTop(el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const restoredRef = React.useRef(false);
  React.useEffect(() => {
    restoredRef.current = false;
  }, [root]);

  React.useEffect(() => {
    if (!isOpen) return;
    if (restoredRef.current) return;
    setContextMenu(null);
    setRenameTarget(null);
    setDeleteTarget(null);
    setDragDropActive(false);
    setDropTarget(null);
    setDragPreparing(null);
    const normalizedPersistedRoot = persistedState?.root ? normalizePath(persistedState.root) : "";
    if (persistedState && normalizedPersistedRoot === root) {
      const nextExpanded = new Set<string>([root]);
      for (const raw of persistedState.expandedDirs ?? []) {
        const normalized = normalizePath(raw);
        if (normalized) nextExpanded.add(normalized);
      }
      setExpandedDirs(nextExpanded);

      const nextDirState: Record<string, DirectoryState> = {};
      for (const [path, value] of Object.entries(persistedState.dirStateByPath ?? {})) {
        const normalized = normalizePath(path);
        if (!normalized) continue;
        const entries = Array.isArray(value.entries) ? (value.entries as unknown as FsEntry[]) : [];
        nextDirState[normalized] = { entries, loading: false, error: value.error ?? null };
      }
      setDirStateByPath(nextDirState);

      const nextScrollTop = Number.isFinite(persistedState.scrollTop) ? Math.max(0, persistedState.scrollTop) : 0;
      setScrollTop(nextScrollTop);
      if (listRef.current) listRef.current.scrollTop = nextScrollTop;

      if (!nextDirState[root] || nextDirState[root]?.error) void loadDirectory(root);
      for (const dirPath of nextExpanded) {
        if (dirPath === root) continue;
        const state = nextDirState[dirPath];
        if (!state || state.error) void loadDirectory(dirPath);
      }
      restoredRef.current = true;
      return;
    }

    setExpandedDirs(new Set([root]));
    setDirStateByPath({});
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
    void loadDirectory(root);
    restoredRef.current = true;
  }, [isOpen, loadDirectory, persistedState, root]);

  React.useEffect(() => {
    if (!contextMenu) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (contextMenuRef.current?.contains(target)) return;
      setContextMenu(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setContextMenu(null);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  React.useEffect(() => {
    if (!renameTarget) return;
    window.setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
  }, [renameTarget]);

  const closeRenameModal = React.useCallback(() => {
    if (renameBusy) return;
    setRenameTarget(null);
    setRenameValue("");
    setRenameError(null);
  }, [renameBusy]);

  const closeDeleteModal = React.useCallback(() => {
    if (deleteBusy) return;
    setDeleteTarget(null);
    setDeleteError(null);
  }, [deleteBusy]);

  const remapDirectoryPrefix = React.useCallback((fromPath: string, toPath: string) => {
    const from = normalizePath(fromPath);
    const to = normalizePath(toPath);
    if (!from || !to || from === to) return;

    setExpandedDirs((prev) => {
      const next = new Set<string>();
      for (const p of prev) {
        if (p === from) next.add(to);
        else if (p.startsWith(`${from}/`)) next.add(`${to}${p.slice(from.length)}`);
        else next.add(p);
      }
      return next;
    });

    setDirStateByPath((prev) => {
      const next: Record<string, DirectoryState> = {};
      for (const [key, value] of Object.entries(prev)) {
        const nextKey = key === from ? to : key.startsWith(`${from}/`) ? `${to}${key.slice(from.length)}` : key;
        const nextEntries = value.entries.map((entry) => {
          const cleaned = normalizePath(entry.path);
          if (cleaned === from) return { ...entry, path: to };
          if (cleaned.startsWith(`${from}/`)) return { ...entry, path: `${to}${cleaned.slice(from.length)}` };
          return entry;
        });
        next[nextKey] = { ...value, entries: nextEntries };
      }
      return next;
    });
  }, []);

  const removeDirectoryPrefix = React.useCallback((basePath: string) => {
    const base = normalizePath(basePath);
    if (!base) return;

    setExpandedDirs((prev) => {
      const next = new Set<string>();
      for (const p of prev) {
        if (p === base) continue;
        if (p.startsWith(`${base}/`)) continue;
        next.add(p);
      }
      return next;
    });

    setDirStateByPath((prev) => {
      const next: Record<string, DirectoryState> = {};
      for (const [key, value] of Object.entries(prev)) {
        if (key === base) continue;
        if (key.startsWith(`${base}/`)) continue;
        next[key] = value;
      }
      return next;
    });
  }, []);

  const visibleItems = React.useMemo<VisibleItem[]>(() => {
    const out: VisibleItem[] = [];
    if (!isOpen) return out;

    const walk = (dirPath: string, depth: number) => {
      const state = dirStateByPath[dirPath];
      const entries = state?.entries ?? [];
      for (const entry of entries) {
        out.push({ type: "entry", entry, depth });
        if (!entry.isDir) continue;
        if (!expandedDirs.has(entry.path)) continue;
        const childState = dirStateByPath[entry.path];
        if (childState?.loading) {
          out.push({ type: "loading", path: entry.path, depth: depth + 1 });
          continue;
        }
        if (childState?.error) {
          out.push({ type: "error", path: entry.path, depth: depth + 1, message: childState.error });
          continue;
        }
        if (childState?.entries) {
          walk(entry.path, depth + 1);
          continue;
        }
        out.push({ type: "loading", path: entry.path, depth: depth + 1 });
      }
    };

    walk(root, 0);
    return out;
  }, [dirStateByPath, expandedDirs, isOpen, root]);

  const toggleDir = React.useCallback(
    (dirPath: string) => {
      const path = normalizePath(dirPath);
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
          return next;
        }
        next.add(path);
        return next;
      });
      const state = dirStateByPath[path];
      if (!state || state.error) void loadDirectory(path);
    },
    [dirStateByPath, loadDirectory],
  );

  const refreshRoot = React.useCallback(() => {
    setDirStateByPath({});
    setExpandedDirs(new Set([root]));
    void loadDirectory(root);
  }, [loadDirectory, root]);

  const submitRename = React.useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const entry = renameTarget;
      if (!entry) return;

      const name = renameValue.trim();
      if (!name) return;
      if (name === "." || name === "..") {
        setRenameError("That name is not allowed.");
        return;
      }
      if (/[\\/]/.test(name)) {
        setRenameError("Name must not contain / or \\.");
        return;
      }

      setRenameBusy(true);
      setRenameError(null);
      try {
        if (provider === "ssh" && !sshTargetValue) {
          throw new Error("Missing SSH target.");
        }
        const fromPath = entry.path;
        const toPath =
          provider === "ssh"
            ? await invoke<string>("ssh_rename_fs_entry", { target: sshTargetValue, root, path: fromPath, newName: name })
            : await invoke<string>("rename_fs_entry", { root, path: fromPath, newName: name });
        if (entry.isDir) remapDirectoryPrefix(fromPath, toPath);
        void loadDirectory(dirname(fromPath));
        onPathRenamed?.(fromPath, toPath);
        closeRenameModal();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setRenameError(message);
      } finally {
        setRenameBusy(false);
      }
    },
    [closeRenameModal, loadDirectory, onPathRenamed, provider, remapDirectoryPrefix, renameTarget, renameValue, root, sshTargetValue],
  );

  const confirmDelete = React.useCallback(async () => {
    const target = deleteTarget;
    if (!target) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      if (provider === "ssh" && !sshTargetValue) {
        throw new Error("Missing SSH target.");
      }
      await (provider === "ssh"
        ? invoke("ssh_delete_fs_entry", { target: sshTargetValue, root, path: target.path })
        : invoke("delete_fs_entry", { root, path: target.path }));
      if (target.isDir) removeDirectoryPrefix(target.path);
      void loadDirectory(dirname(target.path));
      onPathDeleted?.(target.path);
      closeDeleteModal();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setDeleteError(message);
    } finally {
      setDeleteBusy(false);
    }
  }, [closeDeleteModal, deleteTarget, loadDirectory, onPathDeleted, provider, removeDirectoryPrefix, root, sshTargetValue]);

  const handleDownload = React.useCallback(async (entry: FsEntry) => {
    setContextMenu(null);
    if (!sshTargetValue) return;

    try {
      setDownloadBusy(true);
      setDownloadError(null);
      const savePath = await save({
        defaultPath: entry.name,
        title: entry.isDir ? "Download folder" : "Download file",
      });
      if (!savePath) {
        setDownloadBusy(false);
        return;
      }

      await invoke("ssh_download_file", {
        target: sshTargetValue,
        root,
        remotePath: entry.path,
        localPath: savePath,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Download failed:", message);
      setDownloadError(message);
    } finally {
      setDownloadBusy(false);
    }
  }, [sshTargetValue, root]);

  const getDragIcon = React.useCallback((kind: "file" | "folder"): string => {
    const cached = dragIconCache.get(kind);
    if (cached) return cached;

    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "data:image/png;base64,";

    const roundRect = (x: number, y: number, w: number, h: number, r: number) => {
      const radius = Math.max(0, Math.min(r, w / 2, h / 2));
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.arcTo(x + w, y, x + w, y + h, radius);
      ctx.arcTo(x + w, y + h, x, y + h, radius);
      ctx.arcTo(x, y + h, x, y, radius);
      ctx.arcTo(x, y, x + w, y, radius);
      ctx.closePath();
    };

    ctx.clearRect(0, 0, size, size);
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = "rgba(15, 23, 42, 0.94)";
    roundRect(6, 6, size - 12, size - 12, 14);
    ctx.fill();

    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    ctx.fillStyle = "rgba(240, 244, 248, 0.95)";
    if (kind === "folder") {
      roundRect(16, 20, 22, 10, 4);
      ctx.fill();
      roundRect(14, 26, 36, 24, 6);
      ctx.fill();
      ctx.fillStyle = "rgba(107, 138, 253, 0.35)";
      roundRect(14, 26, 36, 10, 6);
      ctx.fill();
    } else {
      roundRect(20, 16, 24, 32, 6);
      ctx.fill();
      ctx.fillStyle = "rgba(15, 23, 42, 0.5)";
      ctx.beginPath();
      ctx.moveTo(40, 16);
      ctx.lineTo(44, 20);
      ctx.lineTo(44, 30);
      ctx.lineTo(34, 30);
      ctx.closePath();
      ctx.fill();
    }

    const dataUrl = canvas.toDataURL("image/png");
    dragIconCache.set(kind, dataUrl);
    return dataUrl;
  }, []);

  const resolveDropDestination = React.useCallback(
    (logicalX: number, logicalY: number): string | null => {
      if (!panelRef.current) return null;
      const el = document.elementFromPoint(logicalX, logicalY);
      if (!el || !(el instanceof Element)) return null;
      if (!panelRef.current.contains(el)) return null;

      const row = el.closest("[data-fs-entry-path]") as HTMLElement | null;
      if (!row) return root;
      const entryPath = row.dataset.fsEntryPath;
      if (!entryPath) return root;
      const isDir = row.dataset.fsEntryIsDir === "true";
      return isDir ? entryPath : dirname(entryPath);
    },
    [root],
  );

  const transferDroppedPaths = React.useCallback(
    async (paths: string[], destinationDir: string) => {
      const destDir = normalizePath(destinationDir);
      if (!destDir) return;

      if (provider === "ssh" && !sshTargetValue) return;

      setExpandedDirs((prev) => {
        if (prev.has(destDir)) return prev;
        const next = new Set(prev);
        next.add(destDir);
        return next;
      });

      for (const sourcePathRaw of paths) {
        const raw = sourcePathRaw.trim();
        const sourcePath = parseFileUrlPath(raw) ?? raw;
        if (!sourcePath) continue;

        const name = basename(sourcePath);
        if (!name || name === "/") continue;
        const destPath = joinPath(destDir, name);

        if (normalizePath(sourcePath) === normalizePath(destPath)) continue;
        if (normalizePath(destPath).startsWith(`${normalizePath(sourcePath)}/`)) continue;

        try {
          if (provider === "ssh" && sshTargetValue) {
            await invoke("ssh_upload_file", {
              target: sshTargetValue,
              root,
              localPath: sourcePath,
              remotePath: destPath,
            });
          } else if (provider === "local") {
            await invoke("copy_fs_entry", {
              root,
              sourcePath,
              destPath,
            });
          }
        } catch (err) {
          console.error("File transfer failed:", err);
        }
      }

      void loadDirectory(destDir);
    },
    [loadDirectory, provider, root, sshTargetValue],
  );

  // Initiate native drag to Finder/Desktop
  const initiateNativeDrag = React.useCallback(async (entry: FsEntry, attemptId: number) => {
    try {
      if (mouseDownRef.current?.attemptId !== attemptId) return;
      let localPath: string;

      if (provider === "local") {
        // Local file - use path directly
        localPath = entry.path;
      } else {
        // SSH file - need to download first
        // Check cache first
        const cacheKey = `${sshTargetValue}:${entry.path}`;
        const cached = sshFileCache.get(cacheKey);
        if (cached) {
          localPath = cached;
        } else {
          // Download to temp
          setDragPreparing(entry.path);
          if (!sshTargetValue) return;
          localPath = await invoke<string>("ssh_download_to_temp", {
            target: sshTargetValue,
            root,
            remotePath: entry.path,
          });
          // Cache for future drags
          sshFileCache.set(cacheKey, localPath);
          setDragPreparing(null);
        }
      }

      if (mouseDownRef.current?.attemptId !== attemptId) return;
      // Clear drag tracking before handing off to OS drag.
      mouseDownRef.current = null;
      await startDrag({
        item: [localPath],
        icon: getDragIcon(entry.isDir ? "folder" : "file"),
        mode: "copy",
      });
    } catch (err) {
      console.error("Native drag failed:", err);
      setDragPreparing(null);
    }
  }, [getDragIcon, provider, sshTargetValue, root]);

  // Handle mouse events for native drag detection
  const handleMouseDown = React.useCallback((e: React.MouseEvent, entry: FsEntry) => {
    // Only track left mouse button
    if (e.button !== 0) return;
    dragAttemptSeqRef.current += 1;
    mouseDownRef.current = {
      attemptId: dragAttemptSeqRef.current,
      entry,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
  }, []);

  const handleMouseMove = React.useCallback((e: React.MouseEvent) => {
    const state = mouseDownRef.current;
    if (!state || state.moved) return;

    // Check if mouse has moved enough to consider it a drag (5px threshold)
    const dx = e.clientX - state.startX;
    const dy = e.clientY - state.startY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance > 5) {
      state.moved = true;
      // Initiate native drag
      void initiateNativeDrag(state.entry, state.attemptId);
    }
  }, [initiateNativeDrag]);

  const handleMouseUp = React.useCallback(() => {
    mouseDownRef.current = null;
  }, []);

  // Global mouse up listener to handle mouse release outside the component
  React.useEffect(() => {
    const handleGlobalMouseUp = () => {
      mouseDownRef.current = null;
    };
    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => window.removeEventListener("mouseup", handleGlobalMouseUp);
  }, []);

  React.useEffect(() => {
    if (!isOpen) return;

    let unlistenWebview: (() => void) | null = null;
    let unlistenWindow: (() => void) | null = null;
    let cancelled = false;
    let lastDropSignature = "";
    let lastDropAt = 0;

    const setDropTargetFromPhysical = (pos: { x: number; y: number }) => {
      lastDropPosRef.current = pos;
      if (dropRafRef.current !== null) return;
      dropRafRef.current = window.requestAnimationFrame(() => {
        dropRafRef.current = null;
        const nextPos = lastDropPosRef.current;
        if (!nextPos) return;
        // Tauri reports drag/drop position as PhysicalPosition, but on some platforms/configs
        // it may already be in logical coordinates. Try both for resilience.
        const scale = window.devicePixelRatio || 1;
        const logicalX = nextPos.x / scale;
        const logicalY = nextPos.y / scale;
        const resolved =
          resolveDropDestination(logicalX, logicalY) ?? resolveDropDestination(nextPos.x, nextPos.y);
        setDropTarget(resolved);
      });
    };

    const setup = async () => {
      const handleEvent = (event: { payload: any }) => {
        if (cancelled) return;
        const payload = event.payload;

        if (payload.type === "enter") {
          setDragDropActive(true);
          setDropTargetFromPhysical({ x: payload.position.x, y: payload.position.y });
          return;
        }
        if (payload.type === "over") {
          setDropTargetFromPhysical({ x: payload.position.x, y: payload.position.y });
          return;
        }
        if (payload.type === "leave") {
          setDragDropActive(false);
          setDropTarget(null);
          return;
        }
        if (payload.type === "drop") {
          const signature = `${payload.paths?.join("\n") ?? ""}@${payload.position.x},${payload.position.y}`;
          const now = Date.now();
          if (signature === lastDropSignature && now - lastDropAt < 200) return;
          lastDropSignature = signature;
          lastDropAt = now;

          setDragDropActive(false);
          setDropTarget(null);

          const scale = window.devicePixelRatio || 1;
          const logicalX = payload.position.x / scale;
          const logicalY = payload.position.y / scale;
          const destDir =
            resolveDropDestination(logicalX, logicalY) ??
            resolveDropDestination(payload.position.x, payload.position.y);
          if (!destDir) return;
          if (!payload.paths || payload.paths.length === 0) return;
          void transferDroppedPaths(payload.paths, destDir);
        }
      };

      try {
        unlistenWebview = await getCurrentWebview().onDragDropEvent(handleEvent);
      } catch (err) {
        console.error("Failed to register drag-drop listener (webview):", err);
      }

      try {
        unlistenWindow = await getCurrentWindow().onDragDropEvent(handleEvent);
      } catch (err) {
        console.error("Failed to register drag-drop listener (window):", err);
      }
    };

    void setup();
    return () => {
      cancelled = true;
      if (dropRafRef.current !== null) {
        window.cancelAnimationFrame(dropRafRef.current);
        dropRafRef.current = null;
      }
      unlistenWebview?.();
      unlistenWindow?.();
    };
  }, [isOpen, resolveDropDestination, transferDroppedPaths]);

  if (!isOpen) return null;

  const menuX = contextMenu
    ? Math.min(contextMenu.x, Math.max(8, window.innerWidth - 268))
    : 0;
  const menuY = contextMenu
    ? Math.min(contextMenu.y, Math.max(8, window.innerHeight - 320))
    : 0;

  return (
    <aside className="fileExplorerPanel" aria-label="Files" ref={panelRef}>
      <div className="fileExplorerHeader">
        <div className="fileExplorerTitle">
          <span>Files</span>
          <span className="fileExplorerPath" title={rootDir}>
            {shortenPathSmart(rootDir, 46)}
          </span>
        </div>
        <div className="fileExplorerActions">
          <button type="button" className="btnSmall btnIcon" onClick={refreshRoot} title="Refresh">
            <Icon name="refresh" />
          </button>
          <button type="button" className="btnSmall btnIcon" onClick={onClose} title="Close">
            <Icon name="close" />
          </button>
        </div>
      </div>

      <div
        className={[
          "fileExplorerList",
          dragDropActive && dropTarget === root ? "fileExplorerListDropTarget" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        role="tree"
        ref={listRef}
      >
        {visibleItems.length === 0 ? (
          <div className="empty">No files.</div>
        ) : (
          (() => {
            const rowHeight = 28;
            const overscan = 12;
            const total = visibleItems.length;
            const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
            const endIndex = Math.min(total, Math.ceil((scrollTop + listHeight) / rowHeight) + overscan);
            const topSpace = startIndex * rowHeight;
            const bottomSpace = Math.max(0, (total - endIndex) * rowHeight);
            const activeNorm = activeFilePath ? normalizePath(activeFilePath) : null;
            const contextNorm = contextMenuOpenPath ? normalizePath(contextMenuOpenPath) : null;

            return (
              <div style={{ paddingTop: topSpace, paddingBottom: bottomSpace }}>
                {visibleItems.slice(startIndex, endIndex).map((item) => {
                  if (item.type === "loading") {
                    return (
                      <div
                        key={`loading:${item.path}`}
                        className="fileExplorerRow fileExplorerMeta"
                        style={{ paddingLeft: 12 + item.depth * 14, height: rowHeight }}
                      >
                        loading…
                      </div>
                    );
                  }
                  if (item.type === "error") {
                    return (
                      <div
                        key={`error:${item.path}`}
                        className="fileExplorerRow fileExplorerMeta fileExplorerError"
                        style={{ paddingLeft: 12 + item.depth * 14, height: rowHeight }}
                        title={item.message}
                      >
                        failed to load
                      </div>
                    );
                  }

                  const entry = item.entry;
                  const isActive = Boolean(activeNorm && activeNorm === normalizePath(entry.path));
                  const isContextTarget = Boolean(contextNorm && contextNorm === normalizePath(entry.path));
                  const isExpanded = entry.isDir && expandedDirs.has(entry.path);
                  const isDropTarget = dropTarget === entry.path;
                  const isPreparing = dragPreparing === entry.path;
                  const indent = 12 + item.depth * 14;
                  return (
                    <button
                      key={entry.path}
                      type="button"
                      className={[
                        "fileExplorerRow",
                        isActive ? "fileExplorerRowActive" : "",
                        isContextTarget ? "fileExplorerRowContext" : "",
                        isDropTarget ? "fileExplorerRowDropTarget" : "",
                        isPreparing ? "fileExplorerRowPreparing" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style={{ paddingLeft: indent, height: rowHeight }}
                      data-fs-entry-path={entry.path}
                      data-fs-entry-is-dir={entry.isDir ? "true" : "false"}
                      onMouseDown={(e) => handleMouseDown(e, entry)}
                      onMouseMove={handleMouseMove}
                      onMouseUp={handleMouseUp}
                      onClick={() => {
                        if (entry.isDir) {
                          toggleDir(entry.path);
                          return;
                        }
                        onSelectFile(entry.path);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setContextMenu({ x: e.clientX, y: e.clientY, entry });
                      }}
                      role="treeitem"
                      aria-expanded={entry.isDir ? isExpanded : undefined}
                      title={entry.path}
                    >
                      {entry.isDir ? (
                        <span className="fileExplorerDisclosure" aria-hidden="true">
                          {isExpanded ? "▾" : "▸"}
                        </span>
                      ) : (
                        <span className="fileExplorerDisclosure" aria-hidden="true">
                          {" "}
                        </span>
                      )}
                      <span className="fileExplorerIcon" aria-hidden="true">
                        <Icon name={entry.isDir ? "folder" : "file"} size={14} />
                      </span>
                      <span className="fileExplorerName">{entry.name}</span>
                    </button>
                  );
                })}
              </div>
            );
          })()
        )}
      </div>

      {contextMenu && (
        <div
          className="fileContextMenu"
          ref={contextMenuRef}
          role="menu"
          aria-label={`Actions for ${contextMenu.entry.name}`}
          style={{ top: menuY, left: menuX }}
        >
          <button
            type="button"
            className="sidebarActionMenuItem"
            role="menuitem"
            disabled={provider === "ssh" ? !sshTargetValue || !onOpenTerminalAtPath : !onOpenTerminalAtPath}
            onClick={() => {
              if (!onOpenTerminalAtPath) return;
              const folder = contextMenu.entry.isDir ? contextMenu.entry.path : dirname(contextMenu.entry.path);
              onOpenTerminalAtPath(folder, provider, sshTargetValue);
              setContextMenu(null);
            }}
          >
            Open terminal here
          </button>
          <div className="fileContextMenuSep" role="separator" />
          <button
            type="button"
            className="sidebarActionMenuItem"
            role="menuitem"
            onClick={() => {
              const rel = relativePath(root, contextMenu.entry.path);
              void copyToClipboard(rel);
              setContextMenu(null);
            }}
          >
            Copy relative path
          </button>
          <button
            type="button"
            className="sidebarActionMenuItem"
            role="menuitem"
            onClick={() => {
              void copyToClipboard(contextMenu.entry.path);
              setContextMenu(null);
            }}
          >
            Copy full path
          </button>
          {provider === "local" ? (
            <>
              <button
                type="button"
                className="sidebarActionMenuItem"
                role="menuitem"
                onClick={() => {
                  const folder = contextMenu.entry.isDir ? contextMenu.entry.path : dirname(contextMenu.entry.path);
                  void invoke("open_path_in_file_manager", { path: folder }).catch(() => {});
                  setContextMenu(null);
                }}
              >
                Open folder in Finder
              </button>
              <button
                type="button"
                className="sidebarActionMenuItem"
                role="menuitem"
                onClick={() => {
                  const folder = contextMenu.entry.isDir ? contextMenu.entry.path : dirname(contextMenu.entry.path);
                  void invoke("open_path_in_vscode", { path: folder }).catch(() => {});
                  setContextMenu(null);
                }}
              >
                Open folder in VS Code
              </button>
              <div className="fileContextMenuSep" role="separator" />
            </>
          ) : (
            <>
              <button
                type="button"
                className="sidebarActionMenuItem"
                role="menuitem"
                disabled={downloadBusy}
                onClick={() => void handleDownload(contextMenu.entry)}
              >
                <Icon name="download" size={14} />
                Download{contextMenu.entry.isDir ? " folder" : ""}…
              </button>
              <div className="fileContextMenuSep" role="separator" />
            </>
          )}
          <button
            type="button"
            className="sidebarActionMenuItem"
            role="menuitem"
            onClick={() => {
              setRenameTarget(contextMenu.entry);
              setRenameValue(contextMenu.entry.name);
              setRenameError(null);
              setContextMenu(null);
            }}
          >
            Rename…
          </button>
          <button
            type="button"
            className="sidebarActionMenuItem fileContextMenuItemDanger"
            role="menuitem"
            onClick={() => {
              setDeleteTarget(contextMenu.entry);
              setDeleteError(null);
              setContextMenu(null);
            }}
          >
            Delete…
          </button>
        </div>
      )}

      {renameTarget && (
        <div
          className="modalBackdrop modalBackdropTop"
          onClick={() => {
            closeRenameModal();
          }}
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="modalTitle">Rename</h3>
            {renameError && (
              <div className="pathPickerError" role="alert">
                {renameError}
              </div>
            )}
            <form onSubmit={(e) => void submitRename(e)}>
              <div className="formRow">
                <div className="label">New name</div>
                <input
                  className="input"
                  ref={renameInputRef}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  placeholder={renameTarget.name}
                  disabled={renameBusy}
                />
                <div className="hint" style={{ marginTop: 6 }}>
                  {relativePath(root, renameTarget.path)}
                </div>
              </div>
              <div className="modalActions">
                <button type="button" className="btn" onClick={closeRenameModal} disabled={renameBusy}>
                  Cancel
                </button>
                <button type="submit" className="btn" disabled={renameBusy}>
                  {renameBusy ? "Renaming…" : "Rename"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmActionModal
        isOpen={Boolean(deleteTarget)}
        title="Delete"
        message={
          deleteTarget ? (
            <>
              <div>
                Delete {deleteTarget.isDir ? "folder" : "file"}{" "}
                <span style={{ fontFamily: "ui-monospace, monospace" }}>{deleteTarget.name}</span>?
              </div>
              <div className="hint" style={{ marginTop: 6 }}>
                {relativePath(root, deleteTarget.path)}
              </div>
              {deleteError ? (
                <div className="pathPickerError" role="alert" style={{ marginTop: 8 }}>
                  {deleteError}
                </div>
              ) : null}
            </>
          ) : null
        }
        confirmLabel="Delete"
        confirmDanger
        busy={deleteBusy}
        onClose={closeDeleteModal}
        onConfirm={() => void confirmDelete()}
      />

      {downloadError && (
        <div
          className="modalBackdrop modalBackdropTop"
          onClick={() => setDownloadError(null)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modalTitle">Download Failed</h3>
            <div className="pathPickerError" role="alert">
              {downloadError}
            </div>
            <div className="modalActions">
              <button type="button" className="btn" onClick={() => setDownloadError(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
