import { invoke } from "@tauri-apps/api/core";
import React from "react";
import { shortenPathSmart } from "../pathDisplay";
import { Icon } from "./Icon";
import { ConfirmActionModal } from "./modals/ConfirmActionModal";

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

type VisibleItem =
  | { type: "entry"; entry: FsEntry; depth: number }
  | { type: "loading"; path: string; depth: number }
  | { type: "error"; path: string; depth: number; message: string };

function normalizePath(input: string): string {
  return input.trim().replace(/\/+$/, "");
}

function dirname(input: string): string {
  const path = normalizePath(input);
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return path;
  return path.slice(0, idx);
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
  rootDir,
  activeFilePath,
  onSelectFile,
  onClose,
  onPathRenamed,
  onPathDeleted,
}: {
  isOpen: boolean;
  rootDir: string;
  activeFilePath: string | null;
  onSelectFile: (path: string) => void;
  onClose: () => void;
  onPathRenamed?: (fromPath: string, toPath: string) => void;
  onPathDeleted?: (path: string) => void;
}) {
  const root = React.useMemo(() => normalizePath(rootDir), [rootDir]);
  const [expandedDirs, setExpandedDirs] = React.useState<Set<string>>(() => new Set([root]));
  const [dirStateByPath, setDirStateByPath] = React.useState<Record<string, DirectoryState>>({});

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
        const entries = await invoke<FsEntry[]>("list_fs_entries", { root, path: dirPath });
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
    [root],
  );

  React.useEffect(() => {
    if (!isOpen) return;
    setExpandedDirs(new Set([root]));
    setDirStateByPath({});
    setContextMenu(null);
    setRenameTarget(null);
    setDeleteTarget(null);
    void loadDirectory(root);
  }, [isOpen, loadDirectory, root]);

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
      if (!dirStateByPath[path] || (!dirStateByPath[path].loading && dirStateByPath[path].entries.length === 0)) {
        void loadDirectory(path);
      }
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
      const target = renameTarget;
      if (!target) return;

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
        const fromPath = target.path;
        const toPath = await invoke<string>("rename_fs_entry", { root, path: fromPath, newName: name });
        if (target.isDir) remapDirectoryPrefix(fromPath, toPath);
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
    [closeRenameModal, loadDirectory, onPathRenamed, remapDirectoryPrefix, renameTarget, renameValue, root],
  );

  const confirmDelete = React.useCallback(async () => {
    const target = deleteTarget;
    if (!target) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await invoke("delete_fs_entry", { root, path: target.path });
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
  }, [closeDeleteModal, deleteTarget, loadDirectory, onPathDeleted, removeDirectoryPrefix, root]);

  if (!isOpen) return null;

  const menuX = contextMenu
    ? Math.min(contextMenu.x, Math.max(8, window.innerWidth - 268))
    : 0;
  const menuY = contextMenu
    ? Math.min(contextMenu.y, Math.max(8, window.innerHeight - 320))
    : 0;

  return (
    <aside className="fileExplorerPanel" aria-label="Files">
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

      <div className="fileExplorerList" role="tree">
        {visibleItems.length === 0 ? (
          <div className="empty">No files.</div>
        ) : (
          visibleItems.map((item) => {
            if (item.type === "loading") {
              return (
                <div
                  key={`loading:${item.path}`}
                  className="fileExplorerRow fileExplorerMeta"
                  style={{ paddingLeft: 12 + item.depth * 14 }}
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
                  style={{ paddingLeft: 12 + item.depth * 14 }}
                  title={item.message}
                >
                  failed to load
                </div>
              );
            }

            const entry = item.entry;
            const isActive = Boolean(activeFilePath && normalizePath(activeFilePath) === normalizePath(entry.path));
            const isContextTarget = Boolean(contextMenuOpenPath && normalizePath(contextMenuOpenPath) === normalizePath(entry.path));
            const isExpanded = entry.isDir && expandedDirs.has(entry.path);
            const indent = 12 + item.depth * 14;
            return (
              <button
                key={entry.path}
                type="button"
                className={[
                  "fileExplorerRow",
                  isActive ? "fileExplorerRowActive" : "",
                  isContextTarget ? "fileExplorerRowContext" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{ paddingLeft: indent }}
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
          })
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
    </aside>
  );
}
