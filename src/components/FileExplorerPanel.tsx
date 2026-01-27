import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
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
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (trimmed === "/") return "/";
  return trimmed.replace(/\/+$/, "");
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
  provider,
  sshTarget,
  rootDir,
  activeFilePath,
  onSelectFile,
  onClose,
  onPathRenamed,
  onPathDeleted,
}: {
  isOpen: boolean;
  provider: "local" | "ssh";
  sshTarget?: string | null;
  rootDir: string;
  activeFilePath: string | null;
  onSelectFile: (path: string) => void;
  onClose: () => void;
  onPathRenamed?: (fromPath: string, toPath: string) => void;
  onPathDeleted?: (path: string) => void;
}) {
  const root = React.useMemo(() => normalizePath(rootDir), [rootDir]);
  const sshTargetValue = React.useMemo(() => (sshTarget ?? "").trim() || null, [sshTarget]);
  const [expandedDirs, setExpandedDirs] = React.useState<Set<string>>(() => new Set([root]));
  const [dirStateByPath, setDirStateByPath] = React.useState<Record<string, DirectoryState>>({});
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
  const [dropTarget, setDropTarget] = React.useState<string | null>(null);
  const [draggedItem, setDraggedItem] = React.useState<FsEntry | null>(null);

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
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [isOpen, root]);

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

  const handleFileDrop = React.useCallback(async (
    sourceProvider: "local" | "ssh",
    sourceSshTarget: string | null,
    sourceRoot: string,
    sourcePath: string,
    sourceName: string,
    destDirPath: string,
  ) => {
    const destPath = destDirPath === "/" ? `/${sourceName}` : `${destDirPath}/${sourceName}`;

    try {
      if (sourceProvider === "ssh" && provider === "local") {
        // SSH → Local: download
        if (!sourceSshTarget) return;
        await invoke("ssh_download_file", {
          target: sourceSshTarget,
          root: sourceRoot,
          remotePath: sourcePath,
          localPath: destPath,
        });
      } else if (sourceProvider === "local" && provider === "ssh") {
        // Local → SSH: upload
        if (!sshTargetValue) return;
        await invoke("ssh_upload_file", {
          target: sshTargetValue,
          root,
          localPath: sourcePath,
          remotePath: destPath,
        });
      } else {
        // Same provider - not supported for now
        return;
      }
      // Refresh directory to show new file
      void loadDirectory(destDirPath);
    } catch (err) {
      console.error("File transfer failed:", err);
    }
  }, [provider, sshTargetValue, root, loadDirectory]);

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

      <div className="fileExplorerList" role="tree" ref={listRef}>
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
                  const isDragging = draggedItem?.path === entry.path;
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
                        isDragging ? "fileExplorerRowDragging" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style={{ paddingLeft: indent, height: rowHeight }}
                      draggable
                      onDragStart={(e) => {
                        setDraggedItem(entry);
                        e.dataTransfer.effectAllowed = "copy";
                        e.dataTransfer.setData("application/x-file-transfer", JSON.stringify({
                          provider,
                          sshTarget: sshTargetValue,
                          root,
                          path: entry.path,
                          name: entry.name,
                          isDir: entry.isDir,
                        }));
                      }}
                      onDragEnd={() => {
                        setDraggedItem(null);
                        setDropTarget(null);
                      }}
                      onDragOver={(e) => {
                        if (!entry.isDir) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "copy";
                        setDropTarget(entry.path);
                      }}
                      onDragLeave={(e) => {
                        // Only clear if leaving this element, not entering a child
                        const relatedTarget = e.relatedTarget as Node | null;
                        if (relatedTarget && e.currentTarget.contains(relatedTarget)) return;
                        if (dropTarget === entry.path) setDropTarget(null);
                      }}
                      onDrop={async (e) => {
                        e.preventDefault();
                        setDropTarget(null);
                        if (!entry.isDir) return;

                        // Check for files from Finder/external source
                        const files = e.dataTransfer.files;
                        if (files && files.length > 0) {
                          // Handle external file drops (from Finder)
                          for (const file of Array.from(files)) {
                            // file.path contains the full path on macOS/Tauri
                            const filePath = (file as File & { path?: string }).path;
                            if (!filePath) continue;
                            const fileName = file.name;
                            try {
                              if (provider === "ssh" && sshTargetValue) {
                                // Upload to SSH
                                const destPath = entry.path === "/" ? `/${fileName}` : `${entry.path}/${fileName}`;
                                await invoke("ssh_upload_file", {
                                  target: sshTargetValue,
                                  root,
                                  localPath: filePath,
                                  remotePath: destPath,
                                });
                              }
                              // For local provider, we'd need a local copy command
                              // but that's less common use case
                            } catch (err) {
                              console.error("Upload failed:", err);
                            }
                          }
                          void loadDirectory(entry.path);
                          return;
                        }

                        // Check for in-app file transfer
                        const data = e.dataTransfer.getData("application/x-file-transfer");
                        if (!data) return;
                        try {
                          const source = JSON.parse(data) as {
                            provider: "local" | "ssh";
                            sshTarget: string | null;
                            root: string;
                            path: string;
                            name: string;
                            isDir: boolean;
                          };
                          // Prevent dropping onto itself or its children
                          if (source.path === entry.path) return;
                          if (source.isDir && entry.path.startsWith(source.path + "/")) return;
                          // Only allow cross-provider drops for now
                          if (source.provider === provider) return;
                          await handleFileDrop(
                            source.provider,
                            source.sshTarget,
                            source.root,
                            source.path,
                            source.name,
                            entry.path,
                          );
                        } catch {
                          // Invalid JSON, ignore
                        }
                      }}
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
