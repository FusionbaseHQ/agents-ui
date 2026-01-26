import { invoke } from "@tauri-apps/api/core";
import React from "react";
import { shortenPathSmart } from "../pathDisplay";
import { Icon } from "./Icon";

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

export function FileExplorerPanel({
  isOpen,
  rootDir,
  activeFilePath,
  onSelectFile,
  onClose,
}: {
  isOpen: boolean;
  rootDir: string;
  activeFilePath: string | null;
  onSelectFile: (path: string) => void;
  onClose: () => void;
}) {
  const root = React.useMemo(() => normalizePath(rootDir), [rootDir]);
  const [expandedDirs, setExpandedDirs] = React.useState<Set<string>>(() => new Set([root]));
  const [dirStateByPath, setDirStateByPath] = React.useState<Record<string, DirectoryState>>({});

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
    void loadDirectory(root);
  }, [isOpen, loadDirectory, root]);

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

  if (!isOpen) return null;

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
            const isExpanded = entry.isDir && expandedDirs.has(entry.path);
            const indent = 12 + item.depth * 14;
            return (
              <button
                key={entry.path}
                type="button"
                className={`fileExplorerRow ${isActive ? "fileExplorerRowActive" : ""}`}
                style={{ paddingLeft: indent }}
                onClick={() => {
                  if (entry.isDir) {
                    toggleDir(entry.path);
                    return;
                  }
                  onSelectFile(entry.path);
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
    </aside>
  );
}

