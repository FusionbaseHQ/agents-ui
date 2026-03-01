import React from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

const TAB_COLORS = [
  { name: "Blue", value: "107, 140, 222" },
  { name: "Cyan", value: "69, 184, 200" },
  { name: "Pink", value: "200, 120, 152" },
  { name: "Green", value: "88, 184, 120" },
  { name: "Orange", value: "210, 155, 80" },
  { name: "Red", value: "208, 100, 100" },
  { name: "Purple", value: "155, 120, 210" },
  { name: "Yellow", value: "210, 195, 80" },
];

const PROJECT_SYMBOLS = [
  "\u{1F5A5}\uFE0F", "\u{1F4BB}", "\u{1F527}", "\u{1F680}", "\u26A1", "\u{1F41B}",
  "\u{1F4E6}", "\u{1F9EA}", "\u{1F310}", "\u{1F512}", "\u{1F4DD}", "\u{1F3A8}",
  "\u{1F5C4}\uFE0F", "\u{1F433}", "\u2601\uFE0F", "\u{1F4E1}", "\u{1F525}", "\u{1F4A1}",
  "\u2B50", "\u{1F3E0}", "\u{1F6E0}\uFE0F", "\u{1F4CA}", "\u{1F916}", "\u{1F3AF}",
];

type Project = {
  id: string;
  title: string;
  basePath: string | null;
  environmentId: string | null;
  symbol?: string | null;
  color?: string | null;
  sshTarget?: string | null;
  sshRemotePath?: string | null;
};

type EnvironmentConfig = {
  id: string;
  name: string;
};

type ProjectsSectionProps = {
  projects: Project[];
  activeProjectId: string;
  activeProject: Project | null;
  environments: EnvironmentConfig[];
  sessionCountByProject: Map<string, number>;
  workingAgentCountByProject: Map<string, number>;
  onNewProject: () => void;
  onProjectSettings: () => void;
  onDeleteProject: () => void;
  onSelectProject: (projectId: string) => void;
  onOpenProjectSettings: (projectId: string) => void;
  onMoveProject: (projectId: string, targetProjectId: string, position: "before" | "after") => void;
  onRenameProjectInline: (projectId: string, newName: string) => void;
  onSetProjectSymbol: (projectId: string, symbol: string | null) => void;
  onSetProjectColor: (projectId: string, color: string | null) => void;
};

export const ProjectsSection = React.memo(function ProjectsSection({
  projects,
  activeProjectId,
  activeProject,
  environments,
  sessionCountByProject,
  workingAgentCountByProject,
  onNewProject,
  onProjectSettings,
  onDeleteProject,
  onSelectProject,
  onOpenProjectSettings,
  onMoveProject,
  onRenameProjectInline,
  onSetProjectSymbol,
  onSetProjectColor,
}: ProjectsSectionProps) {
  const [draggingProjectId, setDraggingProjectId] = React.useState<string | null>(null);
  const [dropTarget, setDropTarget] = React.useState<{
    projectId: string;
    position: "before" | "after";
  } | null>(null);

  const projectListRef = React.useRef<HTMLDivElement | null>(null);
  const previousItemRectsRef = React.useRef<Map<string, DOMRect>>(new Map());
  const activeAnimationsRef = React.useRef<Map<string, Animation>>(new Map());

  // Context menu state
  const contextMenuRef = React.useRef<HTMLDivElement | null>(null);
  const [contextMenu, setContextMenu] = React.useState<{
    projectId: string;
    x: number;
    y: number;
  } | null>(null);

  // Inline rename state
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState("");

  // Symbol picker state
  const symbolPickerRef = React.useRef<HTMLDivElement | null>(null);
  const [symbolPicker, setSymbolPicker] = React.useState<{
    projectId: string;
    x: number;
    y: number;
  } | null>(null);

  // Color picker state
  const colorPickerRef = React.useRef<HTMLDivElement | null>(null);
  const [colorPicker, setColorPicker] = React.useState<{
    projectId: string;
    x: number;
    y: number;
  } | null>(null);

  const handleRenameStart = React.useCallback(() => {
    if (!contextMenu) return;
    const project = projects.find((p) => p.id === contextMenu.projectId);
    if (!project) return;
    setRenamingId(contextMenu.projectId);
    setRenameValue(project.title);
    setContextMenu(null);
  }, [contextMenu, projects]);

  const handleRenameSubmit = React.useCallback(() => {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    const project = projects.find((p) => p.id === renamingId);
    if (trimmed && project && trimmed !== project.title) {
      onRenameProjectInline(renamingId, trimmed);
    }
    setRenamingId(null);
    setRenameValue("");
  }, [renamingId, renameValue, projects, onRenameProjectInline]);

  const handleRenameCancel = React.useCallback(() => {
    setRenamingId(null);
    setRenameValue("");
  }, []);

  const handleSetSymbolStart = React.useCallback(() => {
    if (!contextMenu) return;
    setSymbolPicker({
      projectId: contextMenu.projectId,
      x: contextMenu.x,
      y: contextMenu.y,
    });
    setContextMenu(null);
  }, [contextMenu]);

  const handleRemoveSymbol = React.useCallback(() => {
    if (!contextMenu) return;
    onSetProjectSymbol(contextMenu.projectId, null);
    setContextMenu(null);
  }, [contextMenu, onSetProjectSymbol]);

  const handleSymbolSelect = React.useCallback(
    (sym: string) => {
      if (!symbolPicker) return;
      onSetProjectSymbol(symbolPicker.projectId, sym);
      setSymbolPicker(null);
    },
    [symbolPicker, onSetProjectSymbol],
  );

  const handleSetColorStart = React.useCallback(() => {
    if (!contextMenu) return;
    setColorPicker({
      projectId: contextMenu.projectId,
      x: contextMenu.x,
      y: contextMenu.y,
    });
    setContextMenu(null);
  }, [contextMenu]);

  const handleRemoveColor = React.useCallback(() => {
    if (!contextMenu) return;
    onSetProjectColor(contextMenu.projectId, null);
    setContextMenu(null);
  }, [contextMenu, onSetProjectColor]);

  const handleColorSelect = React.useCallback(
    (val: string) => {
      if (!colorPicker) return;
      onSetProjectColor(colorPicker.projectId, val);
      setColorPicker(null);
    },
    [colorPicker, onSetProjectColor],
  );

  // Dismiss handlers for context menu, symbol picker, color picker
  React.useEffect(() => {
    if (!contextMenu && !symbolPicker && !colorPicker) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (contextMenuRef.current?.contains(target)) return;
      if (symbolPickerRef.current?.contains(target)) return;
      if (colorPickerRef.current?.contains(target)) return;
      setContextMenu(null);
      setSymbolPicker(null);
      setColorPicker(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setContextMenu(null);
      setSymbolPicker(null);
      setColorPicker(null);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu, symbolPicker, colorPicker]);

  const contextProject = contextMenu
    ? projects.find((p) => p.id === contextMenu.projectId)
    : null;

  const handleDragEnd = React.useCallback(() => {
    setDraggingProjectId(null);
    setDropTarget(null);
  }, []);

  React.useLayoutEffect(() => {
    const list = projectListRef.current;
    if (!list) return;

    const items = Array.from(list.querySelectorAll<HTMLElement>(".projectItem"));
    const nextRects = new Map<string, DOMRect>();
    for (const item of items) {
      const id = item.dataset.projectId;
      if (!id) continue;
      nextRects.set(id, item.getBoundingClientRect());
    }

    const prevRects = previousItemRectsRef.current;
    if (prevRects.size > 0) {
      for (const item of items) {
        const id = item.dataset.projectId;
        if (!id) continue;
        const prev = prevRects.get(id);
        const next = nextRects.get(id);
        if (!prev || !next) continue;
        if (id === draggingProjectId) continue;

        const dx = prev.left - next.left;
        const dy = prev.top - next.top;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;

        activeAnimationsRef.current.get(id)?.cancel();
        const animation = item.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
          { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" },
        );
        activeAnimationsRef.current.set(id, animation);
        void animation.finished
          .then(() => {
            if (activeAnimationsRef.current.get(id) === animation) {
              activeAnimationsRef.current.delete(id);
            }
          })
          .catch(() => {});
      }
    }

    previousItemRectsRef.current = nextRects;
  }, [projects, draggingProjectId]);

  return (
    <>
      <div className="sidebarHeader">
        <div className="title">Projects</div>
        <div className="sidebarHeaderActions">
          <button
            type="button"
            className="btnSmall btnIcon"
            onClick={onNewProject}
            title="New project"
            aria-label="New project"
          >
            <Icon name="plus" />
          </button>
          <button
            type="button"
            className="btnSmall btnIcon"
            onClick={onProjectSettings}
            disabled={!activeProject}
            title="Project settings"
            aria-label="Project settings"
          >
            <Icon name="settings" />
          </button>
          <button
            type="button"
            className="btnSmall btnIcon btnDanger"
            onClick={onDeleteProject}
            disabled={!activeProject}
            title="Delete project"
            aria-label="Delete project"
          >
            <Icon name="trash" />
          </button>
        </div>
      </div>

      <div className="projectList" ref={projectListRef}>
        {projects.map((p) => {
          const isActive = p.id === activeProjectId;
          const count = sessionCountByProject.get(p.id) ?? 0;
          const workingCount = workingAgentCountByProject.get(p.id) ?? 0;
          const envName =
            p.environmentId && environments.some((e) => e.id === p.environmentId)
              ? environments.find((e) => e.id === p.environmentId)?.name?.trim() ?? null
              : null;
          const isDragging = draggingProjectId === p.id;
          const isDropTarget = dropTarget?.projectId === p.id;
          const dropPosition = isDropTarget ? dropTarget?.position ?? null : null;
          return (
            <div
              key={p.id}
              data-project-id={p.id}
              className={[
                "projectItem",
                isActive ? "projectItemActive" : "",
                isDragging ? "projectItemDragging" : "",
                dropPosition === "before" ? "projectItemDropBefore" : "",
                dropPosition === "after" ? "projectItemDropAfter" : "",
                p.color ? "projectItemColored" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={p.color ? { "--tab-color": p.color } as React.CSSProperties : undefined}
            >
              <button
                type="button"
                className="projectItemMain"
                onClick={() => onSelectProject(p.id)}
                onDoubleClick={() => onOpenProjectSettings(p.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ projectId: p.id, x: e.clientX, y: e.clientY });
                  setSymbolPicker(null);
                  setColorPicker(null);
                }}
                title={
                  [
                    p.title,
                    p.sshTarget ? `SSH: ${p.sshTarget}` : null,
                    p.sshRemotePath ? `Remote: ${p.sshRemotePath}` : null,
                    workingCount ? `Agents working: ${workingCount}` : null,
                    !p.sshTarget && p.basePath ? `Base: ${p.basePath}` : null,
                    envName ? `Env: ${envName}` : null,
                  ]
                    .filter(Boolean)
                    .join("\n")
                }
              >
                {p.symbol && <span className="sessionSymbol">{p.symbol}</span>}
                {renamingId === p.id ? (
                  <input
                    className="sessionNameInput"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRenameSubmit();
                      if (e.key === "Escape") handleRenameCancel();
                      e.stopPropagation();
                    }}
                    onBlur={handleRenameSubmit}
                    onClick={(e) => e.stopPropagation()}
                    autoFocus
                  />
                ) : (
                  <>
                    <span className="projectTitle">{p.title}</span>
                    {p.sshTarget && <span className="projectSshBadge" title={`SSH: ${p.sshTarget}`}>SSH</span>}
                  </>
                )}
                <span className="projectBadges">
                  {workingCount > 0 && (
                    <span
                      className="projectAgentsBadge"
                      title={`${workingCount} agent${workingCount === 1 ? "" : "s"} working`}
                    >
                      <span className="projectAgentsDot" aria-hidden="true" />
                      {workingCount}
                    </span>
                  )}
                  <span className="projectCount">{count}</span>
                </span>
              </button>
              <button
                type="button"
                className="projectDragHandle"
                aria-label={`Reorder ${p.title}`}
                title="Drag to reorder"
                disabled={projects.length <= 1}
                onPointerDown={(e) => {
                  if (projects.length <= 1) return;
                  if (e.button !== 0) return;

                  const pointerId = e.pointerId;
                  const handle = e.currentTarget;
                  const startX = e.clientX;
                  const startY = e.clientY;
                  const deadZonePx = 6;

                  let dragging = false;
                  let lastTargetId: string | null = null;
                  let lastPosition: "before" | "after" | null = null;
                  let latestPointer: { x: number; y: number } | null = null;
                  let raf: number | null = null;

                  const prevCursor = document.body.style.cursor;
                  const prevUserSelect = document.body.style.userSelect;

                  const getDropPosition = (clientY: number, rect: DOMRect, targetId: string) => {
                    const mid = rect.top + rect.height / 2;
                    const delta = clientY - mid;
                    if (delta > deadZonePx) return "after";
                    if (delta < -deadZonePx) return "before";
                    if (lastTargetId === targetId && lastPosition) return lastPosition;
                    return delta >= 0 ? "after" : "before";
                  };

                  const stop = () => {
                    if (raf !== null) {
                      window.cancelAnimationFrame(raf);
                      raf = null;
                    }
                    document.removeEventListener("pointermove", onMove);
                    document.removeEventListener("pointerup", onUp);
                    document.removeEventListener("pointercancel", onUp);
                    try {
                      handle.releasePointerCapture(pointerId);
                    } catch {
                      // ignore
                    }
                    document.body.style.cursor = prevCursor;
                    document.body.style.userSelect = prevUserSelect;
                    handleDragEnd();
                  };

                  const processPointer = () => {
                    raf = null;
                    if (!latestPointer) return;
                    const { x, y } = latestPointer;

                    if (!dragging) {
                      const dx = x - startX;
                      const dy = y - startY;
                      const distance = Math.hypot(dx, dy);
                      if (distance < 6) return;
                      dragging = true;
                      setDraggingProjectId(p.id);
                      setDropTarget(null);
                      document.body.style.cursor = "grabbing";
                      document.body.style.userSelect = "none";
                    }

                    const list = projectListRef.current;
                    if (!list) return;

                    const listRect = list.getBoundingClientRect();
                    const edgeZone = 22;
                    if (y < listRect.top + edgeZone) {
                      const ratio = (listRect.top + edgeZone - y) / edgeZone;
                      list.scrollBy({ top: -Math.ceil(10 * ratio), behavior: "auto" });
                    } else if (y > listRect.bottom - edgeZone) {
                      const ratio = (y - (listRect.bottom - edgeZone)) / edgeZone;
                      list.scrollBy({ top: Math.ceil(10 * ratio), behavior: "auto" });
                    }

                    const element = document.elementFromPoint(x, y) as HTMLElement | null;
                    const item = element?.closest<HTMLElement>(".projectItem") ?? null;
                    if (!item || !list.contains(item)) {
                      setDropTarget(null);
                      return;
                    }

                    const targetId = item.dataset.projectId ?? null;
                    if (!targetId || targetId === p.id) {
                      setDropTarget(null);
                      return;
                    }

                    const rect = item.getBoundingClientRect();
                    const position = getDropPosition(y, rect, targetId);
                    setDropTarget((prev) => {
                      if (prev?.projectId === targetId && prev.position === position) return prev;
                      return { projectId: targetId, position };
                    });

                    if (lastTargetId === targetId && lastPosition === position) return;
                    lastTargetId = targetId;
                    lastPosition = position;
                    onMoveProject(p.id, targetId, position);
                  };

                  const scheduleProcess = () => {
                    if (raf !== null) return;
                    raf = window.requestAnimationFrame(processPointer);
                  };

                  const onMove = (ev: PointerEvent) => {
                    if (ev.pointerId !== pointerId) return;
                    latestPointer = { x: ev.clientX, y: ev.clientY };
                    scheduleProcess();
                  };

                  const onUp = (ev: PointerEvent) => {
                    if (ev.pointerId !== pointerId) return;
                    stop();
                  };

                  e.preventDefault();
                  e.stopPropagation();

                  try {
                    handle.setPointerCapture(pointerId);
                  } catch {
                    // ignore
                  }
                  document.addEventListener("pointermove", onMove);
                  document.addEventListener("pointerup", onUp);
                  document.addEventListener("pointercancel", onUp);
                }}
              >
                <Icon name="grip" />
              </button>
            </div>
          );
        })}
      </div>

      {/* Context menu */}
      {contextMenu && contextProject && createPortal(
        <div
          ref={contextMenuRef}
          className="sessionContextMenu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          role="menu"
        >
          <button
            type="button"
            className="sessionContextMenuItem"
            role="menuitem"
            onClick={handleRenameStart}
          >
            Rename
          </button>
          <button
            type="button"
            className="sessionContextMenuItem"
            role="menuitem"
            onClick={handleSetSymbolStart}
          >
            Set symbol
          </button>
          {contextProject.symbol && (
            <button
              type="button"
              className="sessionContextMenuItem"
              role="menuitem"
              onClick={handleRemoveSymbol}
            >
              Remove symbol
            </button>
          )}
          <button
            type="button"
            className="sessionContextMenuItem"
            role="menuitem"
            onClick={handleSetColorStart}
          >
            Set color
          </button>
          {contextProject.color && (
            <button
              type="button"
              className="sessionContextMenuItem"
              role="menuitem"
              onClick={handleRemoveColor}
            >
              Remove color
            </button>
          )}
          <div className="sessionContextMenuSep" />
          <button
            type="button"
            className="sessionContextMenuItem"
            role="menuitem"
            onClick={() => {
              const pid = contextMenu.projectId;
              setContextMenu(null);
              onOpenProjectSettings(pid);
            }}
          >
            Project settings
          </button>
        </div>,
        document.body,
      )}

      {/* Symbol picker */}
      {symbolPicker && createPortal(
        <div
          ref={symbolPickerRef}
          className="sessionSymbolPicker"
          style={{ top: symbolPicker.y, left: symbolPicker.x }}
        >
          {PROJECT_SYMBOLS.map((sym) => (
            <button
              key={sym}
              type="button"
              onClick={() => handleSymbolSelect(sym)}
              title={sym}
            >
              {sym}
            </button>
          ))}
        </div>,
        document.body,
      )}

      {/* Color picker */}
      {colorPicker && createPortal(
        <div
          ref={colorPickerRef}
          className="tabColorPicker"
          style={{
            top: Math.min(colorPicker.y, window.innerHeight - 100),
            left: Math.min(colorPicker.x, window.innerWidth - 160),
          }}
        >
          {TAB_COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => handleColorSelect(c.value)}
              title={c.name}
              style={{ background: `rgb(${c.value})` }}
            />
          ))}
        </div>,
        document.body,
      )}
    </>
  );
});
