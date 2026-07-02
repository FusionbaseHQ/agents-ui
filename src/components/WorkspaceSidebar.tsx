import React from "react";
import { createPortal } from "react-dom";
import { detectProcessEffect, getProcessEffectById, type ProcessEffect } from "../processEffects";
import { shortenPathSmart } from "../pathDisplay";
import { useClampedMenuPosition } from "../hooks/useClampedMenuPosition";
import { Icon } from "./Icon";
import { EmptyState, Menu, type MenuEntry } from "../ui";
import { TAB_SYMBOLS, TabSymbolIcon, normalizeTabSymbolValue } from "../tabSymbols";

/* -------------------------------------------------------------------------- */
/* Types (structurally compatible with App.tsx)                               */
/* -------------------------------------------------------------------------- */

export type Workspace = {
  id: string;
  name: string;
  symbol?: string | null;
  color?: string | null;
  iconImage?: string | null;
};

export type WorkspaceDeleteOptions = {
  // "move": reassign this workspace's projects to targetWorkspaceId.
  // "remove": delete the projects entirely and close their sessions.
  mode: "move" | "remove";
  targetWorkspaceId: string | null;
};

export type SidebarProject = {
  id: string;
  title: string;
  basePath: string | null;
  symbol?: string | null;
  color?: string | null;
  sshTarget?: string | null;
  sshRemotePath?: string | null;
  branch?: string | null;
};

export type SidebarSession = {
  id: string;
  name: string;
  command: string;
  cwd: string | null;
  projectId: string;
  pinned?: boolean;
  launchCommand: string | null;
  restoreCommand?: string | null;
  persistent?: boolean;
  effectId?: string | null;
  processTag?: string | null;
  runningCommand?: string | null;
  recordingActive?: boolean;
  exited?: boolean;
  closing?: boolean;
  exitCode?: number | null;
  connectionState?: "connected" | "reconnecting" | "disconnected";
  manualReconnectAvailable?: boolean;
  sshTarget?: string | null;
  symbol?: string | null;
  color?: string | null;
};

export type SidebarSplitView = {
  id: string;
  aId: string;
  bId: string;
  direction: "horizontal" | "vertical";
  createdAt: number;
  lastFocusedId: string;
};

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

const COLLAPSED_PROJECTS_KEY = "agents-ui-collapsed-projects-v1";

function isSshCommand(commandLine: string | null | undefined): boolean {
  const trimmed = commandLine?.trim() ?? "";
  if (!trimmed) return false;
  const token = trimmed.split(/\s+/)[0];
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.toLowerCase().replace(/\.exe$/, "") === "ssh";
}

function formatShortcutLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "Agent";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

// Load an image file and re-encode it to a small square PNG data URL so custom
// workspace icons stay tiny in localStorage and render crisply at any size.
async function fileToIconDataUrl(file: File, size = 72): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("Failed to load image"));
      im.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2D canvas context");
    const iw = img.naturalWidth || img.width || 0;
    const ih = img.naturalHeight || img.height || 0;
    if (iw > 0 && ih > 0) {
      const scale = Math.max(size / iw, size / ih);
      const w = iw * scale;
      const h = ih * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    } else {
      // Some images (notably SVGs without width/height) report no intrinsic
      // size in WebKit — scaling by them yields NaN, so fill the tile instead.
      ctx.drawImage(img, 0, 0, size, size);
    }
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadCollapsedProjects(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_PROJECTS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    // ignore
  }
  return new Set();
}

type SessionLaunchInfo = {
  effect: ProcessEffect | null;
  isAgent: boolean;
  isSsh: boolean;
  isPersistent: boolean;
};

function sessionLaunchInfo(s: SidebarSession): SessionLaunchInfo {
  const launchOrRestore =
    s.launchCommand ?? (s.restoreCommand?.trim() ? s.restoreCommand.trim() : null) ?? null;
  const effect =
    getProcessEffectById(s.effectId) ?? detectProcessEffect({ command: launchOrRestore, name: s.name });
  // SSH wins over "persistent": a persistent remote shell is still remote, and
  // the whole point is to tell remote from local at a glance.
  const isSsh = Boolean(s.sshTarget?.trim()) || isSshCommand(launchOrRestore);
  const isPersistent = Boolean(s.persistent) && !isSsh;
  return { effect, isAgent: Boolean(effect?.iconSrc), isSsh, isPersistent };
}

type SessionStatus = "working" | "recording" | "running" | "reconnecting" | "disconnected" | "exited" | "idle";

function sessionStatus(s: SidebarSession, isAgentWorking: boolean): SessionStatus {
  if (s.exited) return "exited";
  if (s.closing) return "exited";
  const conn = s.connectionState ?? "connected";
  if (conn === "reconnecting") return "reconnecting";
  // A disconnected session is dead regardless of whether a manual reconnect is
  // offered — don't let it fall through to a live/idle dot. (The reconnect
  // button is separately gated on manualReconnectAvailable.)
  if (conn === "disconnected") return "disconnected";
  if (s.recordingActive) return "recording";
  if (isAgentWorking) return "working";
  if ((s.runningCommand ?? "").trim()) return "running";
  return "idle";
}

/* -------------------------------------------------------------------------- */
/* Session row                                                                */
/* -------------------------------------------------------------------------- */

type SessionRowProps = {
  session: SidebarSession;
  isActive: boolean;
  isHighlighted: boolean;
  isAgentWorking: boolean;
  isRenaming: boolean;
  renameValue: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onReconnect: (id: string) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
  /** Opens the color/symbol picker at the given point (inline hover affordance). */
  onStyle: (id: string, x: number, y: number) => void;
  onDragStart: (e: React.PointerEvent<HTMLButtonElement>, id: string) => void;
  onRenameChange: (v: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  dropPosition: "before" | "after" | null;
  isDragging: boolean;
};

const SessionRow = React.memo(function SessionRow({
  session: s,
  isActive,
  isHighlighted,
  isAgentWorking,
  isRenaming,
  renameValue,
  onSelect,
  onClose,
  onReconnect,
  onContextMenu,
  onStyle,
  onDragStart,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  dropPosition,
  isDragging,
}: SessionRowProps) {
  const info = sessionLaunchInfo(s);
  const status = sessionStatus(s, isAgentWorking);

  const typeClass = info.isAgent
    ? `wsSessionIcon wsSessionIconAgent chip-${info.effect?.id ?? "agent"}`
    : info.isSsh
      ? "wsSessionIcon wsSessionIconSsh"
      : info.isPersistent
        ? "wsSessionIcon wsSessionIconPersistent"
        : "wsSessionIcon wsSessionIconTerminal";

  return (
    <div
      className={[
        "wsSessionItem",
        isActive ? "wsSessionItemActive" : "",
        isHighlighted ? "wsNavHighlight" : "",
        s.exited || s.closing ? "wsSessionItemExited" : "",
        s.color ? "wsSessionItemColored" : "",
        isDragging ? "wsSessionItemDragging" : "",
        dropPosition === "before" ? "wsSessionItemDropBefore" : "",
        dropPosition === "after" ? "wsSessionItemDropAfter" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={s.color ? ({ "--tab-color": s.color } as React.CSSProperties) : undefined}
      data-session-id={s.id}
      data-project-id={s.projectId}
      role="treeitem"
      aria-selected={isActive}
      tabIndex={0}
      onClick={() => onSelect(s.id)}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onSelect(s.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(s.id, e.clientX, e.clientY);
      }}
      title={[s.name, s.cwd ? shortenPathSmart(s.cwd, 52) : null].filter(Boolean).join("\n")}
    >
      <button
        type="button"
        className="wsSessionDrag"
        onPointerDown={(e) => onDragStart(e, s.id)}
        onClick={(e) => e.stopPropagation()}
        title="Drag to reorder"
        aria-label="Drag to reorder"
      >
        <Icon name="grip" size={10} />
      </button>

      <span className={typeClass} aria-hidden="true">
        {s.symbol ? (
          <TabSymbolIcon symbol={s.symbol} />
        ) : info.isAgent && info.effect?.iconSrc ? (
          <img src={info.effect.iconSrc} alt="" />
        ) : info.isSsh ? (
          <Icon name="ssh" size={12} />
        ) : info.isPersistent ? (
          <Icon name="layers" size={12} />
        ) : (
          <Icon name="terminal" size={12} />
        )}
      </span>

      {isRenaming ? (
        <input
          className="wsRenameInput"
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onRenameSubmit();
            if (e.key === "Escape") onRenameCancel();
            e.stopPropagation();
          }}
          onBlur={onRenameSubmit}
          onClick={(e) => e.stopPropagation()}
          autoFocus
        />
      ) : (
        <span className="wsSessionName">{s.name}</span>
      )}

      {s.pinned && !isRenaming ? <Icon name="pin" size={10} className="wsSessionPin" /> : null}

      {status === "exited" ? (
        <span className="wsSessionMeta">exited{s.exitCode != null ? ` ${s.exitCode}` : ""}</span>
      ) : status === "reconnecting" ? (
        <span className="wsSessionMeta">reconnecting…</span>
      ) : status === "disconnected" ? (
        <span className="wsSessionMeta">disconnected</span>
      ) : null}

      <span className="wsSessionEnd">
        {status === "disconnected" && s.manualReconnectAvailable ? (
          <button
            className="wsSessionReconnect"
            onClick={(e) => {
              e.stopPropagation();
              onReconnect(s.id);
            }}
            title="Reconnect session"
            aria-label="Reconnect session"
          >
            <Icon name="refresh" size={12} />
          </button>
        ) : (
          <span className={`wsStatusDot wsStatusDot-${status}`} aria-hidden="true" />
        )}
        <button
          className="wsSessionStyle"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            onStyle(s.id, r.left, r.bottom + 4);
          }}
          title="Set color (right-click for symbol & more)"
          aria-label="Set session color"
        >
          <Icon name="wand" size={12} />
        </button>
        <button
          className="wsSessionClose"
          onClick={(e) => {
            e.stopPropagation();
            onClose(s.id);
          }}
          title={s.closing ? "Force close session" : "Close session"}
          aria-label="Close session"
        >
          <Icon name="close" size={12} />
        </button>
      </span>
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/* Main component                                                             */
/* -------------------------------------------------------------------------- */

type PickerTarget = { kind: "project" | "session"; id: string; mode: "symbol" | "color"; x: number; y: number };
type RenameTarget = { kind: "project" | "session"; id: string };

export type WorkspaceSidebarProps = {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  onSelectWorkspace: (id: string) => void;
  onCreateWorkspace: () => void;
  onRenameWorkspace: (id: string, name: string) => void;
  onSetWorkspaceImage: (id: string, image: string | null) => void;
  onDeleteWorkspace: (id: string, options: WorkspaceDeleteOptions) => void;

  projects: SidebarProject[];
  activeProjectId: string;
  activeSessionId: string | null;
  sessionsByProject: Map<string, SidebarSession[]>;
  workingSessionIds: ReadonlySet<string>;
  agentShortcuts: ProcessEffect[];

  onSelectProject: (id: string) => void;
  onNewProject: () => void;
  onOpenProjectSettings: (id: string) => void;
  onRequestDeleteProject: (id: string) => void;
  onRenameProjectInline: (id: string, name: string) => void;
  onMoveProject: (sourceId: string, targetId: string, position: "before" | "after") => void;
  onSetProjectSymbol: (id: string, symbol: string | null) => void;
  onSetProjectColor: (id: string, color: string | null) => void;

  onSelectSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  onReconnectSession: (id: string) => void;
  onReorderSession: (sourceId: string, targetId: string, position: "before" | "after") => void;
  onToggleSessionPin: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
  onSetSessionSymbol: (id: string, symbol: string | null) => void;
  onSetSessionColor: (id: string, color: string | null) => void;

  onNewTerminalForProject: (projectId: string) => void;
  onNewTerminalWithShellForProject: (projectId: string) => void;
  onNewSshForProject: (projectId: string) => void;
  onQuickStartForProject: (projectId: string, effect: ProcessEffect) => void;

  onOpenPersistentSessions: () => void;
  onOpenAgentShortcuts: () => void;
  onOpenSshManager: () => void;
  onAgentInstruction: (instruction: string) => void;
  agentInstructionRunning: boolean;

  splitViews: SidebarSplitView[];
  activeSplitViewId: string | null;
  splitPane: { secondaryId: string; direction: "horizontal" | "vertical"; ratio: number } | null;
  onActivateSplitView: (viewId: string, focusSessionId?: string) => void;
  onRemoveSplitView: (viewId: string) => void;
  onUnsplit: () => void;
  onSplitSession: (sessionId: string, direction: "horizontal" | "vertical") => void;

  collapsed: boolean;
  onToggleCollapsed: () => void;
};

export const WorkspaceSidebar = React.memo(function WorkspaceSidebar(props: WorkspaceSidebarProps) {
  const {
    workspaces,
    activeWorkspaceId,
    onSelectWorkspace,
    onCreateWorkspace,
    onRenameWorkspace,
    onSetWorkspaceImage,
    onDeleteWorkspace,
    projects,
    activeProjectId,
    activeSessionId,
    sessionsByProject,
    workingSessionIds,
    agentShortcuts,
    onSelectProject,
    onNewProject,
    onOpenProjectSettings,
    onRequestDeleteProject,
    onRenameProjectInline,
    onMoveProject,
    onSetProjectSymbol,
    onSetProjectColor,
    onSelectSession,
    onCloseSession,
    onReconnectSession,
    onReorderSession,
    onToggleSessionPin,
    onRenameSession,
    onSetSessionSymbol,
    onSetSessionColor,
    onNewTerminalForProject,
    onNewTerminalWithShellForProject,
    onNewSshForProject,
    onQuickStartForProject,
    onOpenPersistentSessions,
    onOpenAgentShortcuts,
    onOpenSshManager,
    onAgentInstruction,
    agentInstructionRunning,
    splitViews,
    activeSplitViewId,
    splitPane,
    onActivateSplitView,
    onRemoveSplitView,
    onUnsplit,
    onSplitSession,
    collapsed,
    onToggleCollapsed,
  } = props;

  const activeWorkspace =
    workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0] ?? null;

  const [collapsedProjects, setCollapsedProjects] = React.useState<Set<string>>(loadCollapsedProjects);
  const [query, setQuery] = React.useState("");
  const [highlightIndex, setHighlightIndex] = React.useState(-1);
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);
  const iconFileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [renamingWorkspace, setRenamingWorkspace] = React.useState(false);
  const [workspaceRenameValue, setWorkspaceRenameValue] = React.useState("");
  const [deleteWsOpen, setDeleteWsOpen] = React.useState(false);
  const [deleteWsMode, setDeleteWsMode] = React.useState<"move" | "remove">("move");
  const [deleteWsTarget, setDeleteWsTarget] = React.useState<string | null>(null);

  const treeRef = React.useRef<HTMLDivElement | null>(null);

  // Floating menus
  const wsMenuRef = React.useRef<HTMLDivElement | null>(null);
  const wsMenuTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const [wsMenuOpen, setWsMenuOpen] = React.useState<{ x: number; y: number } | null>(null);

  const [projMenu, setProjMenu] = React.useState<{ projectId: string; x: number; y: number } | null>(null);

  const [newMenu, setNewMenu] = React.useState<{ projectId: string; x: number; y: number } | null>(null);

  const [sessMenu, setSessMenu] = React.useState<{ sessionId: string; x: number; y: number } | null>(null);

  const pickerRef = React.useRef<HTMLDivElement | null>(null);
  const [picker, setPicker] = React.useState<PickerTarget | null>(null);

  // Whether the overflow menu was open at mousedown on its trigger: the shared
  // Menu closes itself on any outside mousedown, so without this the same
  // click's onClick would immediately reopen it instead of toggling it closed.
  const overflowWasOpenRef = React.useRef(false);
  const [overflowOpen, setOverflowOpen] = React.useState<{ x: number; y: number } | null>(null);

  const [renaming, setRenaming] = React.useState<RenameTarget | null>(null);
  const [renameValue, setRenameValue] = React.useState("");

  const [agentModalOpen, setAgentModalOpen] = React.useState(false);
  const [agentCustomInstruction, setAgentCustomInstruction] = React.useState("");

  // Drag state (sessions + projects share a lightweight pointer drag)
  const [draggingSessionId, setDraggingSessionId] = React.useState<string | null>(null);
  const [sessionDrop, setSessionDrop] = React.useState<{ sessionId: string; position: "before" | "after" } | null>(null);
  const [draggingProjectId, setDraggingProjectId] = React.useState<string | null>(null);
  const [projectDrop, setProjectDrop] = React.useState<{ projectId: string; position: "before" | "after" } | null>(null);

  const wsMenuPos = useClampedMenuPosition(wsMenuRef, wsMenuOpen);
  const pickerPos = useClampedMenuPosition(pickerRef, picker);

  // Persist collapsed projects
  React.useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify(Array.from(collapsedProjects)));
    } catch {
      // ignore
    }
  }, [collapsedProjects]);

  const toggleProjectCollapsed = React.useCallback((projectId: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }, []);

  const expandProject = React.useCallback((projectId: string) => {
    setCollapsedProjects((prev) => {
      if (!prev.has(projectId)) return prev;
      const next = new Set(prev);
      next.delete(projectId);
      return next;
    });
  }, []);

  // The focused project always shows its sessions: expand it whenever it
  // becomes active (also covers selecting a session in a collapsed project).
  React.useEffect(() => {
    if (activeProjectId) expandProject(activeProjectId);
  }, [activeProjectId, expandProject]);

  // Seed the inline workspace-rename field from the (possibly just-created)
  // active workspace whenever rename mode opens. window.prompt() is a no-op in
  // Tauri's WKWebView, so workspace naming is done inline instead.
  React.useEffect(() => {
    if (renamingWorkspace) setWorkspaceRenameValue(activeWorkspace?.name ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renamingWorkspace]);

  const commitWorkspaceRename = React.useCallback(() => {
    const trimmed = workspaceRenameValue.trim();
    if (trimmed && activeWorkspace) onRenameWorkspace(activeWorkspace.id, trimmed);
    setRenamingWorkspace(false);
  }, [workspaceRenameValue, activeWorkspace, onRenameWorkspace]);

  const handleIconFileChange = React.useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // allow re-picking the same file later
      if (!file || !activeWorkspace) return;
      try {
        const dataUrl = await fileToIconDataUrl(file);
        onSetWorkspaceImage(activeWorkspace.id, dataUrl);
      } catch {
        // ignore unreadable images
      }
    },
    [activeWorkspace, onSetWorkspaceImage],
  );

  const renderWsIcon = (ws: Workspace | null, fallbackSize: number) =>
    ws?.iconImage ? (
      <img className="wsIconImg" src={ws.iconImage} alt="" />
    ) : ws?.symbol ? (
      <TabSymbolIcon symbol={ws.symbol} />
    ) : (
      <Icon name="layers" size={fallbackSize} />
    );

  // Dismiss-on-outside for the hand-rolled floating popovers (workspace
  // switcher + symbol/color pickers). The action menus are shared <Menu>
  // components that handle their own dismissal.
  React.useEffect(() => {
    if (!wsMenuOpen && !picker) return;
    const onDown = (event: MouseEvent) => {
      const t = event.target;
      if (!(t instanceof Node)) return;
      if (wsMenuTriggerRef.current?.contains(t) || wsMenuRef.current?.contains(t)) return;
      if (pickerRef.current?.contains(t)) return;
      setWsMenuOpen(null);
      setPicker(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setWsMenuOpen(null);
      setPicker(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [wsMenuOpen, picker]);

  const startRename = React.useCallback((kind: "project" | "session", id: string, current: string) => {
    setRenaming({ kind, id });
    setRenameValue(current);
    setProjMenu(null);
    setSessMenu(null);
  }, []);

  const submitRename = React.useCallback(() => {
    if (!renaming) return;
    const trimmed = renameValue.trim();
    if (trimmed) {
      if (renaming.kind === "project") onRenameProjectInline(renaming.id, trimmed);
      else onRenameSession(renaming.id, trimmed);
    }
    setRenaming(null);
    setRenameValue("");
  }, [renaming, renameValue, onRenameProjectInline, onRenameSession]);

  const cancelRename = React.useCallback(() => {
    setRenaming(null);
    setRenameValue("");
  }, []);

  /* ---- Search filtering ---- */
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = React.useMemo(() => {
    if (!normalizedQuery) {
      return projects.map((p) => ({ project: p, sessions: sessionsByProject.get(p.id) ?? [] }));
    }
    const out: { project: SidebarProject; sessions: SidebarSession[] }[] = [];
    for (const p of projects) {
      const sessions = sessionsByProject.get(p.id) ?? [];
      const projectMatches =
        p.title.toLowerCase().includes(normalizedQuery) ||
        (p.basePath ?? "").toLowerCase().includes(normalizedQuery);
      const matchedSessions = sessions.filter(
        (s) =>
          s.name.toLowerCase().includes(normalizedQuery) ||
          (s.cwd ?? "").toLowerCase().includes(normalizedQuery),
      );
      if (projectMatches) out.push({ project: p, sessions });
      else if (matchedSessions.length) out.push({ project: p, sessions: matchedSessions });
    }
    return out;
  }, [projects, sessionsByProject, normalizedQuery]);

  /* ---- Keyboard quick-switch (type → arrow → Enter to jump) ---- */
  type NavItem = { kind: "project" | "session"; id: string };
  const navItems = React.useMemo<NavItem[]>(() => {
    const items: NavItem[] = [];
    for (const { project, sessions } of filtered) {
      items.push({ kind: "project", id: project.id });
      // Only expanded projects expose their sessions to keyboard nav (search
      // forces expansion, so all matches are reachable while filtering).
      if (!collapsedProjects.has(project.id) || normalizedQuery) {
        for (const s of sessions) items.push({ kind: "session", id: s.id });
      }
    }
    return items;
  }, [filtered, collapsedProjects, normalizedQuery]);

  const highlightedItem = highlightIndex >= 0 ? navItems[highlightIndex] ?? null : null;

  // When the query changes, pre-highlight the first session match so a quick
  // type-then-Enter jumps straight to the most relevant session.
  React.useEffect(() => {
    if (!normalizedQuery) {
      setHighlightIndex(-1);
      return;
    }
    const firstSession = navItems.findIndex((i) => i.kind === "session");
    setHighlightIndex(firstSession >= 0 ? firstSession : navItems.length ? 0 : -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalizedQuery]);

  // Keep the highlighted row scrolled into view.
  React.useEffect(() => {
    if (highlightIndex < 0) return;
    const el = treeRef.current?.querySelector(".wsNavHighlight");
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  const activateNavItem = React.useCallback(
    (item: NavItem | null) => {
      if (!item) return;
      if (item.kind === "session") onSelectSession(item.id);
      else onSelectProject(item.id);
      setQuery("");
      setHighlightIndex(-1);
      searchInputRef.current?.blur();
    },
    [onSelectSession, onSelectProject],
  );

  const handleSearchKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIndex((i) => (navItems.length ? Math.min(i + 1, navItems.length - 1) : -1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIndex((i) => (i <= 0 ? 0 : i - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item =
          (highlightIndex >= 0 ? navItems[highlightIndex] : null) ??
          navItems.find((i) => i.kind === "session") ??
          navItems[0] ??
          null;
        activateNavItem(item);
      } else if (e.key === "Escape") {
        if (query) {
          setQuery("");
          setHighlightIndex(-1);
        } else {
          e.currentTarget.blur();
        }
      }
    },
    [navItems, highlightIndex, query, activateNavItem],
  );

  const collapseAllProjects = React.useCallback(() => {
    setCollapsedProjects(new Set(projects.map((p) => p.id)));
  }, [projects]);

  const expandAllProjects = React.useCallback(() => {
    setCollapsedProjects(new Set());
  }, []);

  /* ---- Drag: sessions (within a project) ---- */
  const handleSessionDragStart = React.useCallback(
    (e: React.PointerEvent<HTMLButtonElement>, sessionId: string) => {
      if (e.button !== 0) return;
      const pointerId = e.pointerId;
      const handle = e.currentTarget;
      const startX = e.clientX;
      const startY = e.clientY;
      const sourceProjectId =
        handle.closest<HTMLElement>(".wsSessionItem")?.dataset.projectId ?? null;
      let dragging = false;
      let lastTargetId: string | null = null;
      let lastPosition: "before" | "after" | null = null;
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;

      const stop = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        try {
          handle.releasePointerCapture(pointerId);
        } catch {
          // ignore
        }
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        setDraggingSessionId(null);
        setSessionDrop(null);
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const x = ev.clientX;
        const y = ev.clientY;
        if (!dragging) {
          if (Math.hypot(x - startX, y - startY) < 6) return;
          dragging = true;
          setDraggingSessionId(sessionId);
          document.body.style.cursor = "grabbing";
          document.body.style.userSelect = "none";
        }
        const el = document.elementFromPoint(x, y) as HTMLElement | null;
        const item = el?.closest<HTMLElement>(".wsSessionItem") ?? null;
        if (!item || item.dataset.projectId !== sourceProjectId) {
          setSessionDrop(null);
          return;
        }
        const targetId = item.dataset.sessionId ?? null;
        if (!targetId || targetId === sessionId) {
          setSessionDrop(null);
          return;
        }
        const rect = item.getBoundingClientRect();
        const position: "before" | "after" = y < rect.top + rect.height / 2 ? "before" : "after";
        setSessionDrop({ sessionId: targetId, position });
        if (lastTargetId === targetId && lastPosition === position) return;
        lastTargetId = targetId;
        lastPosition = position;
        onReorderSession(sessionId, targetId, position);
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
    },
    [onReorderSession],
  );

  /* ---- Drag: projects ---- */
  const handleProjectDragStart = React.useCallback(
    (e: React.PointerEvent<HTMLButtonElement>, projectId: string) => {
      if (e.button !== 0) return;
      const pointerId = e.pointerId;
      const handle = e.currentTarget;
      const startX = e.clientX;
      const startY = e.clientY;
      let dragging = false;
      let lastTargetId: string | null = null;
      let lastPosition: "before" | "after" | null = null;
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;

      const stop = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        try {
          handle.releasePointerCapture(pointerId);
        } catch {
          // ignore
        }
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        setDraggingProjectId(null);
        setProjectDrop(null);
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const x = ev.clientX;
        const y = ev.clientY;
        if (!dragging) {
          if (Math.hypot(x - startX, y - startY) < 6) return;
          dragging = true;
          setDraggingProjectId(projectId);
          document.body.style.cursor = "grabbing";
          document.body.style.userSelect = "none";
        }
        const el = document.elementFromPoint(x, y) as HTMLElement | null;
        const group = el?.closest<HTMLElement>(".wsProjectGroup") ?? null;
        if (!group) {
          setProjectDrop(null);
          return;
        }
        const targetId = group.dataset.projectId ?? null;
        if (!targetId || targetId === projectId) {
          setProjectDrop(null);
          return;
        }
        const rect = group.getBoundingClientRect();
        const position: "before" | "after" = y < rect.top + rect.height / 2 ? "before" : "after";
        setProjectDrop({ projectId: targetId, position });
        if (lastTargetId === targetId && lastPosition === position) return;
        lastTargetId = targetId;
        lastPosition = position;
        onMoveProject(projectId, targetId, position);
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
    },
    [onMoveProject],
  );

  const contextProject = projMenu ? projects.find((p) => p.id === projMenu.projectId) ?? null : null;
  const contextSession = sessMenu
    ? (sessionsByProject.get(activeProjectId)?.find((s) => s.id === sessMenu.sessionId) ??
       Array.from(sessionsByProject.values()).flat().find((s) => s.id === sessMenu.sessionId) ??
       null)
    : null;

  const resolvedSplitViews = React.useMemo(() => {
    const byId = new Map(Array.from(sessionsByProject.values()).flat().map((s) => [s.id, s] as const));
    return splitViews
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((view) => {
        const a = byId.get(view.aId) ?? null;
        const b = byId.get(view.bId) ?? null;
        if (!a || !b || a.id === b.id) return null;
        return { view, a, b };
      })
      .filter((x): x is { view: SidebarSplitView; a: SidebarSession; b: SidebarSession } => x !== null);
  }, [splitViews, sessionsByProject]);

  /* ---- Collapsed rail ---- */
  if (collapsed) {
    return (
      <div className="wsRail" aria-label="Sidebar (collapsed)">
        <button
          type="button"
          className="wsRailBtn"
          onClick={onToggleCollapsed}
          title="Expand sidebar"
          aria-label="Expand sidebar"
        >
          <Icon name="sidebar" size={16} />
        </button>
        <button
          type="button"
          className="wsRailBtn"
          onClick={onNewProject}
          title="New project"
          aria-label="New project"
        >
          <Icon name="plus" size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="wsSidebar" aria-label="Workspaces, projects and sessions">
      {/* Workspace header */}
      <div className="wsHeader">
        {renamingWorkspace ? (
          <div className="wsHeaderMain wsHeaderRenaming">
            <span
              className={`wsHeaderIcon ${
                activeWorkspace?.iconImage
                  ? "wsHeaderIconImage"
                  : activeWorkspace?.color
                    ? "wsHeaderIconColored"
                    : ""
              }`}
              style={
                activeWorkspace?.color && !activeWorkspace?.iconImage
                  ? ({ "--tab-color": activeWorkspace.color } as React.CSSProperties)
                  : undefined
              }
            >
              {renderWsIcon(activeWorkspace, 15)}
            </span>
            <input
              className="wsRenameInput wsHeaderRenameInput"
              value={workspaceRenameValue}
              onChange={(e) => setWorkspaceRenameValue(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitWorkspaceRename();
                if (e.key === "Escape") setRenamingWorkspace(false);
                e.stopPropagation();
              }}
              onBlur={commitWorkspaceRename}
              placeholder="Workspace name"
              aria-label="Workspace name"
              autoFocus
            />
          </div>
        ) : (
          <button
            type="button"
            ref={wsMenuTriggerRef}
            className="wsHeaderMain"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setWsMenuOpen((prev) => (prev ? null : { x: r.left, y: r.bottom + 6 }));
            }}
            aria-haspopup="menu"
            aria-expanded={Boolean(wsMenuOpen)}
            title="Switch workspace"
          >
            <span
              className={`wsHeaderIcon ${
                activeWorkspace?.iconImage
                  ? "wsHeaderIconImage"
                  : activeWorkspace?.color
                    ? "wsHeaderIconColored"
                    : ""
              }`}
              style={
                activeWorkspace?.color && !activeWorkspace?.iconImage
                  ? ({ "--tab-color": activeWorkspace.color } as React.CSSProperties)
                  : undefined
              }
            >
              {renderWsIcon(activeWorkspace, 15)}
            </span>
            <span className="wsHeaderText">
              <span className="wsHeaderEyebrow">WORKSPACE</span>
              <span className="wsHeaderName">{activeWorkspace?.name ?? "Workspace"}</span>
            </span>
            <Icon name="chevron-down" size={14} className="wsHeaderChevron" />
          </button>
        )}
        <button
          type="button"
          className="wsHeaderCollapse"
          onClick={onToggleCollapsed}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
        >
          <Icon name="sidebar" size={15} />
        </button>
      </div>

      {/* Hidden picker for custom workspace icons */}
      <input
        ref={iconFileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
        style={{ display: "none" }}
        onChange={handleIconFileChange}
        aria-hidden="true"
        tabIndex={-1}
      />

      {/* Search */}
      <div className="wsSearch">
        <Icon name="search" size={13} className="wsSearchIcon" />
        <input
          ref={searchInputRef}
          className="wsSearchInput"
          placeholder="Search projects & sessions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          spellCheck={false}
          aria-label="Search projects and sessions"
        />
        {/* Always present (just hidden when empty) so the input width never
            changes between empty and typing states. */}
        <button
          type="button"
          className={`wsSearchClear ${query ? "" : "wsSearchClearHidden"}`}
          onClick={() => setQuery("")}
          title="Clear search"
          aria-label="Clear search"
          tabIndex={query ? 0 : -1}
          aria-hidden={query ? undefined : true}
        >
          <Icon name="close" size={12} />
        </button>
      </div>

      {/* PROJECTS section header */}
      <div className="wsSectionHeader">
        <span className="wsSectionTitle">PROJECTS</span>
        <div className="wsSectionActions">
          <button type="button" className="wsSectionBtn" onClick={onNewProject} title="New project">
            <Icon name="plus" size={13} />
            <span>New</span>
          </button>
          <button
            type="button"
            className="wsSectionIconBtn"
            onMouseDown={() => {
              overflowWasOpenRef.current = Boolean(overflowOpen);
            }}
            onClick={(e) => {
              const wasOpen = overflowWasOpenRef.current;
              overflowWasOpenRef.current = false;
              if (wasOpen) return;
              const r = e.currentTarget.getBoundingClientRect();
              setOverflowOpen({ x: r.right - 200, y: r.bottom + 6 });
            }}
            title="More actions"
            aria-label="More actions"
            aria-haspopup="menu"
          >
            <Icon name="more" size={15} />
          </button>
        </div>
      </div>

      {/* Project tree */}
      <div className="wsTree" ref={treeRef} role="tree" aria-label="Projects and sessions">
        {filtered.length === 0 ? (
          normalizedQuery ? (
            <div className="wsEmpty">No matches.</div>
          ) : (
            <EmptyState
              compact
              title="No projects yet"
              hint="A project groups terminals around a folder or SSH host."
              action={{ label: "New project", onClick: onNewProject }}
            />
          )
        ) : (
          filtered.map(({ project: p, sessions }) => {
            const isExpanded = !collapsedProjects.has(p.id) || Boolean(normalizedQuery);
            const isActiveProject = p.id === activeProjectId;
            const workingCount = sessions.reduce(
              (n, s) => n + (workingSessionIds.has(s.id) && !s.exited && !s.closing ? 1 : 0),
              0,
            );
            const hasActivity = sessions.some(
              (s) => sessionStatus(s, workingSessionIds.has(s.id)) !== "idle" && !s.exited && !s.closing,
            );
            const subPath = p.sshTarget
              ? p.sshRemotePath || p.sshTarget
              : p.basePath
                ? shortenPathSmart(p.basePath, 30)
                : null;
            const isProjectDragging = draggingProjectId === p.id;
            const projDropPos =
              projectDrop?.projectId === p.id && draggingProjectId !== p.id ? projectDrop.position : null;

            return (
              <div
                key={p.id}
                className={[
                  "wsProjectGroup",
                  isActiveProject ? "wsProjectGroupActive" : "",
                  isProjectDragging ? "wsProjectGroupDragging" : "",
                  projDropPos === "before" ? "wsProjectDropBefore" : "",
                  projDropPos === "after" ? "wsProjectDropAfter" : "",
                  p.color ? "wsProjectColored" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                data-project-id={p.id}
                style={p.color ? ({ "--tab-color": p.color } as React.CSSProperties) : undefined}
              >
                <div className="wsProjectHeaderRow">
                  <button
                    type="button"
                    className="wsProjectDrag"
                    onPointerDown={(e) => handleProjectDragStart(e, p.id)}
                    onClick={(e) => e.stopPropagation()}
                    title="Drag to reorder"
                    aria-label={`Reorder ${p.title}`}
                  >
                    <Icon name="grip" size={10} />
                  </button>
                  <button
                    type="button"
                    className="wsProjectChevronBtn"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleProjectCollapsed(p.id);
                    }}
                    aria-label={isExpanded ? `Collapse ${p.title}` : `Expand ${p.title}`}
                    aria-expanded={isExpanded}
                    title={isExpanded ? "Collapse" : "Expand"}
                    disabled={Boolean(normalizedQuery)}
                  >
                    <Icon
                      name={isExpanded ? "chevron-down" : "chevron-right"}
                      size={13}
                      className="wsProjectChevron"
                    />
                  </button>
                  <button
                    type="button"
                    className={`wsProjectHeader ${
                      highlightedItem?.kind === "project" && highlightedItem.id === p.id ? "wsNavHighlight" : ""
                    }`}
                    onClick={() => {
                      onSelectProject(p.id);
                      expandProject(p.id);
                    }}
                    onDoubleClick={() => startRename("project", p.id, p.title)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setProjMenu({ projectId: p.id, x: e.clientX, y: e.clientY });
                    }}
                    aria-current={isActiveProject ? "true" : undefined}
                  >
                    <span className={`wsProjectStatus ${hasActivity ? "wsProjectStatusActive" : ""}`} aria-hidden="true" />
                    {p.symbol ? <TabSymbolIcon symbol={p.symbol} /> : null}
                    {renaming?.kind === "project" && renaming.id === p.id ? (
                      <input
                        className="wsRenameInput"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") submitRename();
                          if (e.key === "Escape") cancelRename();
                          e.stopPropagation();
                        }}
                        onBlur={submitRename}
                        onClick={(e) => e.stopPropagation()}
                        autoFocus
                      />
                    ) : (
                      <span className="wsProjectName">{p.title}</span>
                    )}
                    {p.sshTarget ? <span className="wsProjectSshBadge">SSH</span> : null}
                  </button>
                  <div className="wsProjectActions" onClick={(e) => e.stopPropagation()}>
                    {workingCount > 0 ? (
                      <span className="wsProjectWorking" title={`${workingCount} working`}>
                        <span className="wsStatusDot wsStatusDot-working" />
                        {workingCount}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="wsProjectActionBtn"
                      onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        setNewMenu({ projectId: p.id, x: r.right - 220, y: r.bottom + 6 });
                      }}
                      title="New session"
                      aria-label={`New session in ${p.title}`}
                      aria-haspopup="menu"
                    >
                      <Icon name="plus" size={14} />
                    </button>
                    <button
                      type="button"
                      className="wsProjectActionBtn"
                      onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        setProjMenu({ projectId: p.id, x: r.right - 180, y: r.bottom + 6 });
                      }}
                      title="Project actions"
                      aria-label={`Actions for ${p.title}`}
                      aria-haspopup="menu"
                    >
                      <Icon name="more" size={15} />
                    </button>
                  </div>
                </div>

                {subPath && isActiveProject ? (
                  <div className="wsProjectSub" title={p.basePath ?? p.sshTarget ?? undefined}>
                    {p.branch ? (
                      <>
                        <Icon name="git-branch" size={10} className="wsProjectSubIcon" />
                        <span className="wsProjectBranch">{p.branch}</span>
                        <span className="wsProjectSubDot">·</span>
                      </>
                    ) : null}
                    <span className="wsProjectPath">{subPath}</span>
                  </div>
                ) : null}

                {isExpanded ? (
                  <div
                    className={`wsSessionList ${isActiveProject ? "wsSessionListActive" : ""}`}
                    role="group"
                  >
                    {sessions.length === 0 ? (
                      <button
                        type="button"
                        className="wsSessionEmpty"
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          setNewMenu({ projectId: p.id, x: r.left, y: r.bottom + 4 });
                        }}
                      >
                        <Icon name="plus" size={12} />
                        New session
                      </button>
                    ) : (
                      sessions.map((s) => (
                        <SessionRow
                          key={s.id}
                          session={s}
                          isActive={s.id === activeSessionId}
                          isHighlighted={highlightedItem?.kind === "session" && highlightedItem.id === s.id}
                          isAgentWorking={workingSessionIds.has(s.id)}
                          isRenaming={renaming?.kind === "session" && renaming.id === s.id}
                          renameValue={renaming?.kind === "session" && renaming.id === s.id ? renameValue : ""}
                          onSelect={onSelectSession}
                          onClose={onCloseSession}
                          onReconnect={onReconnectSession}
                          onContextMenu={(id, x, y) => setSessMenu({ sessionId: id, x, y })}
                          onStyle={(id, x, y) => setPicker({ kind: "session", id, mode: "color", x, y })}
                          onDragStart={handleSessionDragStart}
                          onRenameChange={setRenameValue}
                          onRenameSubmit={submitRename}
                          onRenameCancel={cancelRename}
                          isDragging={draggingSessionId === s.id}
                          dropPosition={
                            sessionDrop?.sessionId === s.id && draggingSessionId !== s.id
                              ? sessionDrop.position
                              : null
                          }
                        />
                      ))
                    )}
                  </div>
                ) : null}
              </div>
            );
          })
        )}

        {/* Split views (active project) */}
        {resolvedSplitViews.length > 0 && !normalizedQuery ? (
          <div className="wsSplitSection">
            <div className="wsSplitLabel">Split views</div>
            {resolvedSplitViews.map(({ view, a, b }) => {
              const isActiveView = view.id === activeSplitViewId;
              return (
                <div
                  key={view.id}
                  className={`wsSplitGroup ${isActiveView ? "wsSplitGroupActive" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => onActivateSplitView(view.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onActivateSplitView(view.id);
                    }
                  }}
                >
                  <div className="wsSplitHeader">
                    <Icon name="panel" size={13} />
                    <span className="wsSplitTitle">Split view</span>
                    <span className="wsSplitMeta">{view.direction === "vertical" ? "right" : "down"}</span>
                    <button
                      type="button"
                      className="wsSplitRemove"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveSplitView(view.id);
                      }}
                      title="Remove split view"
                      aria-label="Remove split view"
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                  <div className="wsSplitMembers">
                    {[
                      { s: a, tag: "A" },
                      { s: b, tag: "B" },
                    ].map(({ s, tag }) => (
                      <button
                        key={tag}
                        type="button"
                        className={`wsSplitMember ${s.id === activeSessionId ? "wsSplitMemberActive" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onActivateSplitView(view.id, s.id);
                        }}
                        title={s.cwd ?? undefined}
                      >
                        <span className="wsSplitTag">{tag}</span>
                        <span className="wsSplitMemberName">{s.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      {/* ----- Portals: floating menus ----- */}

      {/* Workspace switcher */}
      {wsMenuOpen &&
        createPortal(
          <div
            ref={wsMenuRef}
            className="wsMenu wsWorkspaceMenu"
            style={{ top: wsMenuPos.top, left: wsMenuPos.left }}
            role="menu"
            aria-label="Workspaces"
          >
            <div className="wsMenuLabel">Workspaces</div>
            {workspaces.map((w) => (
              <button
                key={w.id}
                type="button"
                className={`wsMenuItem ${w.id === activeWorkspaceId ? "wsMenuItemActive" : ""}`}
                role="menuitem"
                onClick={() => {
                  setWsMenuOpen(null);
                  onSelectWorkspace(w.id);
                }}
              >
                <span
                  className={`wsMenuIcon ${
                    w.iconImage ? "wsHeaderIconImage" : w.color ? "wsHeaderIconColored" : ""
                  }`}
                  style={w.color && !w.iconImage ? ({ "--tab-color": w.color } as React.CSSProperties) : undefined}
                >
                  {renderWsIcon(w, 13)}
                </span>
                <span className="wsMenuItemName">{w.name}</span>
                {w.id === activeWorkspaceId ? <Icon name="chevron-right" size={12} /> : null}
              </button>
            ))}
            <div className="wsMenuSep" />
            <button
              type="button"
              className="wsMenuItem"
              role="menuitem"
              onClick={() => {
                setWsMenuOpen(null);
                onCreateWorkspace();
                setRenamingWorkspace(true);
              }}
            >
              <span className="wsMenuIcon">
                <Icon name="plus" size={13} />
              </span>
              <span className="wsMenuItemName">New workspace</span>
            </button>
            {activeWorkspace ? (
              <button
                type="button"
                className="wsMenuItem"
                role="menuitem"
                onClick={() => {
                  setWsMenuOpen(null);
                  setRenamingWorkspace(true);
                }}
              >
                <span className="wsMenuIcon">
                  <Icon name="settings" size={13} />
                </span>
                <span className="wsMenuItemName">Rename “{activeWorkspace.name}”</span>
              </button>
            ) : null}
            {activeWorkspace ? (
              <button
                type="button"
                className="wsMenuItem"
                role="menuitem"
                onClick={() => {
                  setWsMenuOpen(null);
                  iconFileInputRef.current?.click();
                }}
              >
                <span className="wsMenuIcon">
                  <Icon name="file" size={13} />
                </span>
                <span className="wsMenuItemName">
                  {activeWorkspace.iconImage ? "Change icon image…" : "Set icon image…"}
                </span>
              </button>
            ) : null}
            {activeWorkspace?.iconImage ? (
              <button
                type="button"
                className="wsMenuItem"
                role="menuitem"
                onClick={() => {
                  setWsMenuOpen(null);
                  onSetWorkspaceImage(activeWorkspace.id, null);
                }}
              >
                <span className="wsMenuIcon">
                  <Icon name="close" size={13} />
                </span>
                <span className="wsMenuItemName">Remove icon image</span>
              </button>
            ) : null}
            {activeWorkspace && workspaces.length > 1 ? (
              <button
                type="button"
                className="wsMenuItem wsMenuItemDanger"
                role="menuitem"
                onClick={() => {
                  setWsMenuOpen(null);
                  const firstOther = workspaces.find((w) => w.id !== activeWorkspace.id) ?? null;
                  setDeleteWsMode("move");
                  setDeleteWsTarget(firstOther?.id ?? null);
                  setDeleteWsOpen(true);
                }}
              >
                <span className="wsMenuIcon">
                  <Icon name="trash" size={13} />
                </span>
                <span className="wsMenuItemName">Delete workspace</span>
              </button>
            ) : null}
          </div>,
          document.body,
        )}

      {/* New-session popover */}
      {newMenu && (
        <Menu
          anchor={{ x: newMenu.x, y: newMenu.y }}
          onClose={() => setNewMenu(null)}
          label="New session"
          items={[
            { type: "label", label: "New session" },
            {
              label: "Terminal",
              icon: (
                <span className="wsMenuIcon wsSessionIconTerminal">
                  <Icon name="terminal" size={13} />
                </span>
              ),
              onSelect: () => onNewTerminalForProject(newMenu.projectId),
            },
            {
              label: (
                <span title="Choose which shell to open this terminal with">Terminal with shell…</span>
              ),
              icon: (
                <span className="wsMenuIcon wsSessionIconTerminal">
                  <Icon name="terminal" size={13} />
                </span>
              ),
              onSelect: () => onNewTerminalWithShellForProject(newMenu.projectId),
            },
            ...agentShortcuts.map(
              (effect): MenuEntry => ({
                label: `${formatShortcutLabel(effect.label)} session`,
                icon: (
                  <span className={`wsMenuIcon wsSessionIconAgent chip-${effect.id}`}>
                    {effect.iconSrc ? (
                      <img src={effect.iconSrc} alt="" />
                    ) : (
                      <Icon name="play" size={13} />
                    )}
                  </span>
                ),
                onSelect: () => onQuickStartForProject(newMenu.projectId, effect),
              }),
            ),
            {
              label: "SSH / remote",
              icon: (
                <span className="wsMenuIcon wsSessionIconSsh">
                  <Icon name="ssh" size={13} />
                </span>
              ),
              onSelect: () => onNewSshForProject(newMenu.projectId),
            },
          ]}
        />
      )}

      {/* Project context menu */}
      {projMenu && contextProject && (
        <Menu
          anchor={{ x: projMenu.x, y: projMenu.y }}
          onClose={() => setProjMenu(null)}
          items={[
            {
              label: "Rename",
              onSelect: () => startRename("project", contextProject.id, contextProject.title),
            },
            {
              label: "Set symbol",
              onSelect: () =>
                setPicker({ kind: "project", id: contextProject.id, mode: "symbol", x: projMenu.x, y: projMenu.y }),
            },
            ...(contextProject.symbol
              ? [
                  {
                    label: "Remove symbol",
                    onSelect: () => onSetProjectSymbol(contextProject.id, null),
                  },
                ]
              : []),
            {
              label: "Set color",
              onSelect: () =>
                setPicker({ kind: "project", id: contextProject.id, mode: "color", x: projMenu.x, y: projMenu.y }),
            },
            ...(contextProject.color
              ? [
                  {
                    label: "Remove color",
                    onSelect: () => onSetProjectColor(contextProject.id, null),
                  },
                ]
              : []),
            { type: "separator" },
            {
              label: "Project settings",
              onSelect: () => onOpenProjectSettings(contextProject.id),
            },
            {
              label: "Delete project",
              danger: true,
              onSelect: () => onRequestDeleteProject(contextProject.id),
            },
          ]}
        />
      )}

      {/* Session context menu */}
      {sessMenu && contextSession && (
        <Menu
          anchor={{ x: sessMenu.x, y: sessMenu.y }}
          onClose={() => setSessMenu(null)}
          items={[
            {
              label: "Rename",
              onSelect: () => startRename("session", contextSession.id, contextSession.name),
            },
            {
              label: contextSession.pinned ? "Unpin" : "Pin",
              onSelect: () => onToggleSessionPin(contextSession.id),
            },
            {
              label: "Set symbol",
              onSelect: () =>
                setPicker({ kind: "session", id: contextSession.id, mode: "symbol", x: sessMenu.x, y: sessMenu.y }),
            },
            ...(contextSession.symbol
              ? [
                  {
                    label: "Remove symbol",
                    onSelect: () => onSetSessionSymbol(contextSession.id, null),
                  },
                ]
              : []),
            {
              label: "Set color",
              onSelect: () =>
                setPicker({ kind: "session", id: contextSession.id, mode: "color", x: sessMenu.x, y: sessMenu.y }),
            },
            ...(contextSession.color
              ? [
                  {
                    label: "Remove color",
                    onSelect: () => onSetSessionColor(contextSession.id, null),
                  },
                ]
              : []),
            { type: "separator" },
            ...(!splitPane && contextSession.id !== activeSessionId
              ? [
                  {
                    label: "Split right",
                    onSelect: () => onSplitSession(contextSession.id, "vertical"),
                  },
                  {
                    label: "Split down",
                    onSelect: () => onSplitSession(contextSession.id, "horizontal"),
                  },
                ]
              : []),
            ...(splitPane &&
            (contextSession.id === activeSessionId || contextSession.id === splitPane.secondaryId)
              ? [{ label: "Unsplit", onSelect: () => onUnsplit() }]
              : []),
            { type: "separator" },
            {
              label: "Close session",
              danger: true,
              onSelect: () => onCloseSession(contextSession.id),
            },
          ]}
        />
      )}

      {/* Section overflow menu */}
      {overflowOpen && (
        <Menu
          anchor={{ x: overflowOpen.x, y: overflowOpen.y }}
          onClose={() => setOverflowOpen(null)}
          items={[
            {
              label: "New project",
              icon: <Icon name="plus" size={13} />,
              onSelect: onNewProject,
            },
            { type: "separator" },
            {
              label: "Collapse all",
              icon: <Icon name="chevron-right" size={13} />,
              onSelect: collapseAllProjects,
            },
            {
              label: "Expand all",
              icon: <Icon name="chevron-down" size={13} />,
              onSelect: expandAllProjects,
            },
            { type: "separator" },
            {
              label: "SSH manager",
              icon: <Icon name="ssh" size={13} />,
              onSelect: onOpenSshManager,
            },
            {
              label: "Persistent sessions",
              icon: <Icon name="layers" size={13} />,
              onSelect: onOpenPersistentSessions,
            },
            {
              label: "Agent shortcuts",
              icon: <Icon name="brain" size={13} />,
              onSelect: onOpenAgentShortcuts,
            },
            {
              label: agentInstructionRunning ? "Agent working…" : "Agent actions",
              icon: <Icon name="wand" size={13} />,
              disabled: agentInstructionRunning,
              onSelect: () => {
                setAgentCustomInstruction("");
                setAgentModalOpen(true);
              },
            },
          ]}
        />
      )}

      {/* Symbol / color picker */}
      {picker &&
        createPortal(
          picker.mode === "symbol" ? (
            <div
              ref={pickerRef}
              className="wsSymbolPicker"
              style={{ top: pickerPos.top, left: pickerPos.left }}
            >
              {TAB_SYMBOLS.map((sym) => (
                <button
                  key={sym.value}
                  type="button"
                  onClick={() => {
                    const value = normalizeTabSymbolValue(sym.value);
                    if (picker.kind === "project") onSetProjectSymbol(picker.id, value);
                    else onSetSessionSymbol(picker.id, value);
                    setPicker(null);
                  }}
                  title={sym.label}
                >
                  <img className="tabSymbolPickerIcon" src={sym.src} alt={sym.label} draggable={false} />
                </button>
              ))}
            </div>
          ) : (
            <div
              ref={pickerRef}
              className="wsColorPicker"
              style={{ top: pickerPos.top, left: pickerPos.left }}
            >
              {TAB_COLORS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  title={c.name}
                  style={{ background: `rgb(${c.value})` }}
                  onClick={() => {
                    if (picker.kind === "project") onSetProjectColor(picker.id, c.value);
                    else onSetSessionColor(picker.id, c.value);
                    setPicker(null);
                  }}
                />
              ))}
            </div>
          ),
          document.body,
        )}

      {/* Agent actions modal */}
      {agentModalOpen &&
        createPortal(
          <div className="agentInstructionBackdrop" onClick={() => setAgentModalOpen(false)}>
            <div
              className="agentInstructionModal"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Escape") setAgentModalOpen(false);
              }}
            >
              <div className="agentInstructionTitle">Agent Actions</div>
              <div className="agentInstructionPresets">
                <button
                  type="button"
                  className="agentInstructionPresetBtn"
                  onClick={() => {
                    setAgentModalOpen(false);
                    onAgentInstruction("rename");
                  }}
                >
                  <Icon name="wand" size={14} />
                  <span>Rename Sessions</span>
                </button>
                <button
                  type="button"
                  className="agentInstructionPresetBtn"
                  onClick={() => {
                    setAgentModalOpen(false);
                    onAgentInstruction("reorder");
                  }}
                >
                  <Icon name="grip" size={14} />
                  <span>Reorder Sessions</span>
                </button>
                <button
                  type="button"
                  className="agentInstructionPresetBtn"
                  onClick={() => {
                    setAgentModalOpen(false);
                    onAgentInstruction("rename-and-reorder");
                  }}
                >
                  <Icon name="layers" size={14} />
                  <span>Rename &amp; Reorder</span>
                </button>
              </div>
              <div className="agentInstructionCustom">
                <input
                  className="agentInstructionInput"
                  type="text"
                  placeholder="Or type a custom instruction…"
                  value={agentCustomInstruction}
                  onChange={(e) => setAgentCustomInstruction(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && agentCustomInstruction.trim()) {
                      setAgentModalOpen(false);
                      onAgentInstruction(agentCustomInstruction.trim());
                    }
                    e.stopPropagation();
                  }}
                  autoFocus
                />
                <button
                  type="button"
                  className="agentInstructionSendBtn"
                  disabled={!agentCustomInstruction.trim()}
                  onClick={() => {
                    if (agentCustomInstruction.trim()) {
                      setAgentModalOpen(false);
                      onAgentInstruction(agentCustomInstruction.trim());
                    }
                  }}
                >
                  Run
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* Delete-workspace confirmation */}
      {deleteWsOpen &&
        activeWorkspace &&
        createPortal(
          <div className="wsConfirmBackdrop" onClick={() => setDeleteWsOpen(false)}>
            <div
              className="wsConfirmModal"
              role="dialog"
              aria-modal="true"
              aria-label="Delete workspace"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Escape") setDeleteWsOpen(false);
              }}
            >
              <div className="wsConfirmTitle">Delete “{activeWorkspace.name}”?</div>
              {projects.length === 0 ? (
                <div className="wsConfirmText">This workspace is empty and will be removed.</div>
              ) : (
                <>
                  <div className="wsConfirmText">
                    This workspace has {projects.length} project{projects.length === 1 ? "" : "s"}.
                    Choose what happens to {projects.length === 1 ? "it" : "them"}:
                  </div>
                  <div className="wsConfirmOptions" role="radiogroup" aria-label="What to do with projects">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={deleteWsMode === "move"}
                      className={`wsConfirmOption ${deleteWsMode === "move" ? "wsConfirmOptionActive" : ""}`}
                      onClick={() => setDeleteWsMode("move")}
                    >
                      <span className="wsConfirmRadio" aria-hidden="true" />
                      <span className="wsConfirmOptionBody">
                        <span className="wsConfirmOptionLabel">Move projects to another workspace</span>
                        <span className="wsConfirmOptionHint">Keeps the projects and their sessions.</span>
                        {deleteWsMode === "move" ? (
                          <select
                            className="wsConfirmSelect"
                            value={deleteWsTarget ?? ""}
                            onChange={(e) => setDeleteWsTarget(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {workspaces
                              .filter((w) => w.id !== activeWorkspace.id)
                              .map((w) => (
                                <option key={w.id} value={w.id}>
                                  {w.name}
                                </option>
                              ))}
                          </select>
                        ) : null}
                      </span>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={deleteWsMode === "remove"}
                      className={`wsConfirmOption ${deleteWsMode === "remove" ? "wsConfirmOptionActive wsConfirmOptionDanger" : ""}`}
                      onClick={() => setDeleteWsMode("remove")}
                    >
                      <span className="wsConfirmRadio" aria-hidden="true" />
                      <span className="wsConfirmOptionBody">
                        <span className="wsConfirmOptionLabel">Delete projects and close their sessions</span>
                        <span className="wsConfirmOptionHint">Permanently removes the projects in this workspace.</span>
                      </span>
                    </button>
                  </div>
                </>
              )}
              <div className="wsConfirmActions">
                <button
                  type="button"
                  className="wsConfirmBtn"
                  onClick={() => setDeleteWsOpen(false)}
                  autoFocus
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="wsConfirmBtn wsConfirmBtnDanger"
                  disabled={projects.length > 0 && deleteWsMode === "move" && !deleteWsTarget}
                  onClick={() => {
                    const mode = projects.length === 0 ? "move" : deleteWsMode;
                    onDeleteWorkspace(activeWorkspace.id, { mode, targetWorkspaceId: deleteWsTarget });
                    setDeleteWsOpen(false);
                  }}
                >
                  {projects.length > 0 && deleteWsMode === "remove" ? "Delete workspace & projects" : "Delete workspace"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
});
