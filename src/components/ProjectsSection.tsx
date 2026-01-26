import React from "react";
import { Icon } from "./Icon";

type Project = {
  id: string;
  title: string;
  basePath: string | null;
  environmentId: string | null;
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
};

export function ProjectsSection({
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
}: ProjectsSectionProps) {
  const [draggingProjectId, setDraggingProjectId] = React.useState<string | null>(null);
  const [dropTarget, setDropTarget] = React.useState<{
    projectId: string;
    position: "before" | "after";
  } | null>(null);

  const projectListRef = React.useRef<HTMLDivElement | null>(null);
  const previousItemRectsRef = React.useRef<Map<string, DOMRect>>(new Map());
  const activeAnimationsRef = React.useRef<Map<string, Animation>>(new Map());

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
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <button
                type="button"
                className="projectItemMain"
                onClick={() => onSelectProject(p.id)}
                onDoubleClick={() => onOpenProjectSettings(p.id)}
                title={
                  [
                    p.title,
                    workingCount ? `Agents working: ${workingCount}` : null,
                    p.basePath ? `Base: ${p.basePath}` : null,
                    envName ? `Env: ${envName}` : null,
                  ]
                    .filter(Boolean)
                    .join("\n")
                }
              >
                <span className="projectTitle">{p.title}</span>
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
    </>
  );
}
