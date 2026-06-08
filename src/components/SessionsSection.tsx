import React from "react";
import { createPortal } from "react-dom";
import { detectProcessEffect, getProcessEffectById, type ProcessEffect } from "../processEffects";
import { shortenPathSmart } from "../pathDisplay";
import { useClampedMenuPosition } from "../hooks/useClampedMenuPosition";
import { Icon } from "./Icon";

function isSshCommand(commandLine: string | null | undefined): boolean {
  const trimmed = commandLine?.trim() ?? "";
  if (!trimmed) return false;
  const token = trimmed.split(/\s+/)[0];
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.toLowerCase().replace(/\.exe$/, "") === "ssh";
}

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

const SESSION_SYMBOLS = [
  "\u{1F5A5}\uFE0F", "\u{1F4BB}", "\u{1F527}", "\u{1F680}", "\u26A1", "\u{1F41B}",
  "\u{1F4E6}", "\u{1F9EA}", "\u{1F310}", "\u{1F512}", "\u{1F4DD}", "\u{1F3A8}",
  "\u{1F5C4}\uFE0F", "\u{1F433}", "\u2601\uFE0F", "\u{1F4E1}", "\u{1F525}", "\u{1F4A1}",
  "\u2B50", "\u{1F3E0}", "\u{1F6E0}\uFE0F", "\u{1F4CA}", "\u{1F916}", "\u{1F3AF}",
];

type Session = {
  id: string;
  name: string;
  command: string;
  cwd: string | null;
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
  reconnectAttempt?: number;
  manualReconnectAvailable?: boolean;
  disconnectReason?: string | null;
  symbol?: string | null;
  color?: string | null;
};

type SplitView = {
  id: string;
  aId: string;
  bId: string;
  direction: "horizontal" | "vertical";
  createdAt: number;
  lastFocusedId: string;
};

type SessionItemProps = {
  session: Session;
  isActive: boolean;
  isSecondary: boolean;
  splitTag?: string | null;
  isAgentWorking: boolean;
  isRenaming: boolean;
  isPinned: boolean;
  isDragging: boolean;
  dropPosition: "before" | "after" | null;
  renameValue: string;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onReconnectSession: (sessionId: string) => void;
  onDragHandlePointerDown: (e: React.PointerEvent<HTMLButtonElement>, sessionId: string) => void;
  onContextMenu: (sessionId: string, x: number, y: number) => void;
  onRenameValueChange: (value: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
};

const SessionItem = React.memo(function SessionItem({
  session: s,
  isActive,
  isSecondary,
  splitTag,
  isAgentWorking,
  isRenaming,
  isPinned,
  isDragging,
  dropPosition,
  renameValue,
  onSelectSession,
  onCloseSession,
  onReconnectSession,
  onDragHandlePointerDown,
  onContextMenu,
  onRenameValueChange,
  onRenameSubmit,
  onRenameCancel,
}: SessionItemProps) {
  const isExited = Boolean(s.exited);
  const isClosing = Boolean(s.closing);
  const connectionState = s.connectionState ?? "connected";
  const isReconnecting = connectionState === "reconnecting";
  const isDisconnected = connectionState === "disconnected";
  const launchOrRestore =
    s.launchCommand ??
    (s.restoreCommand?.trim() ? s.restoreCommand.trim() : null) ??
    null;
  const effect =
    getProcessEffectById(s.effectId) ??
    detectProcessEffect({ command: launchOrRestore, name: s.name });
  const chipLabel = effect?.label ?? s.processTag ?? null;
  const hasAgentIcon = Boolean(effect?.iconSrc);
  const hasRunningCommand = Boolean((s.runningCommand ?? "").trim());
  const isWorking = Boolean(effect && isAgentWorking && !isExited && !isClosing);
  const isRecording = Boolean(s.recordingActive && !isExited && !isClosing);
  const isSsh = isSshCommand(launchOrRestore);
  const isPersistent = Boolean(s.persistent);
  const isSshType = isSsh && !isPersistent;
  const isDefaultType = !isPersistent && !isSshType;
  const chipClass = effect
    ? `chip chip-${effect.id}`
    : isSshType
      ? "chip chip-ssh"
      : "chip";
  const showChipLabel =
    Boolean(chipLabel) &&
    !hasAgentIcon &&
    !(isSshType && (chipLabel ?? "").trim().toLowerCase() === "ssh");

  return (
    <div
      className={`sessionItem ${isActive ? "sessionItemActive" : ""} ${
        isSecondary ? "sessionItemSecondary" : ""
      } ${isExited ? "sessionItemExited" : ""} ${
        isClosing ? "sessionItemClosing" : ""
      } ${isReconnecting ? "sessionItemReconnecting" : ""} ${
        isDisconnected ? "sessionItemDisconnected" : ""
      } ${isSshType ? "sessionItemSsh" : ""} ${
        isPersistent ? "sessionItemPersistent" : ""
      } ${isDefaultType ? "sessionItemDefault" : ""} ${
        s.color ? "sessionItemColored" : ""
      } ${isPinned ? "sessionItemPinned" : ""} ${
        isDragging ? "sessionItemDragging" : ""
      } ${dropPosition === "before" ? "sessionItemDropBefore" : ""} ${
        dropPosition === "after" ? "sessionItemDropAfter" : ""
      }`}
      data-session-id={s.id}
      style={s.color ? { "--tab-color": s.color } as React.CSSProperties : undefined}
      onClick={() => onSelectSession(s.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(s.id, e.clientX, e.clientY);
      }}
    >
      <button
        type="button"
        className="sessionDragHandle"
        onPointerDown={(e) => onDragHandlePointerDown(e, s.id)}
        onClick={(event) => event.stopPropagation()}
        title="Drag to reorder"
        aria-label="Drag to reorder"
      >
        <Icon name="grip" size={10} />
      </button>
      <div className="sessionMeta">
        <div className="sessionName">
          {splitTag ? (
            <span className="sessionSplitTag" aria-hidden="true">
              {splitTag}
            </span>
          ) : null}
          {s.symbol && <span className="sessionSymbol">{s.symbol}</span>}
          {hasAgentIcon && chipLabel && effect?.iconSrc && (
            <span className={`agentBadge chip-${effect.id}`} title={chipLabel}>
              <img className="agentIcon" src={effect.iconSrc} alt={chipLabel} />
              {isWorking && (
                <span className="chipActivity agentBadgeDot" aria-label="Working" />
              )}
            </span>
          )}
          {isRenaming ? (
            <input
              className="sessionNameInput"
              value={renameValue}
              onChange={(e) => onRenameValueChange(e.target.value)}
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
            <span className="sessionNameText">{s.name}</span>
          )}
          {showChipLabel && chipLabel && (
            <span className={chipClass} title={chipLabel}>
              <span className="chipLabel">{chipLabel}</span>
              {isWorking && <span className="chipActivity" aria-label="Working" />}
            </span>
          )}
          {isRecording && <span className="recordingDot" title="Recording" />}
          {isClosing ? (
            <span className="sessionStatus">closing…</span>
          ) : isReconnecting ? (
            <span className="sessionStatus" title={s.disconnectReason ?? undefined}>
              reconnecting…
            </span>
          ) : isDisconnected ? (
            <span className="sessionStatus" title={s.disconnectReason ?? undefined}>
              disconnected
            </span>
          ) : isExited ? (
            <span className="sessionStatus">
              exited{s.exitCode != null ? ` ${s.exitCode}` : ""}
            </span>
          ) : null}
        </div>
        <div className="sessionCmd">
          {(() => {
            const parts: string[] = [];
            if (s.cwd) parts.push(shortenPathSmart(s.cwd, 44));
            if (launchOrRestore) parts.push(launchOrRestore);
            if (!parts.length) parts.push(s.command);
            return parts.join(" • ");
          })()}
        </div>
      </div>
      {isDisconnected && s.manualReconnectAvailable && (
        <button
          className="reconnectBtn"
          onClick={(e) => {
            e.stopPropagation();
            onReconnectSession(s.id);
          }}
          title="Reconnect session"
        >
          ↻
        </button>
      )}
      <button
        className="closeBtn"
        onClick={(e) => {
          e.stopPropagation();
          onCloseSession(s.id);
        }}
        title={isClosing ? "Force close session" : "Close session"}
      >
        ×
      </button>
    </div>
  );
});

type SessionsSectionProps = {
  agentShortcuts: ProcessEffect[];
  sessions: Session[];
  agentWorkingIds: ReadonlySet<string>;
  activeSessionId: string | null;
  splitViews: SplitView[];
  activeSplitViewId: string | null;
  splitPane: { secondaryId: string; direction: "horizontal" | "vertical"; ratio: number } | null;
  onSplitSession: (sessionId: string, direction: "horizontal" | "vertical") => void;
  onUnsplit: () => void;
  onActivateSplitView: (viewId: string, focusSessionId?: string) => void;
  onRemoveSplitView: (viewId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onToggleSessionPin: (sessionId: string) => void;
  onReorderSession: (sourceSessionId: string, targetSessionId: string, position: "before" | "after") => void;
  onReconnectSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, newName: string) => void;
  onSetSessionSymbol: (sessionId: string, symbol: string | null) => void;
  onSetSessionColor: (sessionId: string, color: string | null) => void;
  onQuickStart: (effect: ProcessEffect) => void;
  onOpenNewSession: () => void;
  onAgentInstruction: (instruction: string) => void;
  agentInstructionRunning: boolean;
  onOpenAgentShortcuts: () => void;
  onOpenPersistentSessions: () => void;
  onOpenSshManager: () => void;
};

export const SessionsSection = React.memo(function SessionsSection({
  agentShortcuts,
  sessions,
  agentWorkingIds,
  activeSessionId,
  splitViews,
  activeSplitViewId,
  splitPane,
  onSplitSession,
  onUnsplit,
  onActivateSplitView,
  onRemoveSplitView,
  onSelectSession,
  onCloseSession,
  onToggleSessionPin,
  onReorderSession,
  onReconnectSession,
  onRenameSession,
  onSetSessionSymbol,
  onSetSessionColor,
  onQuickStart,
  onOpenNewSession,
  onAgentInstruction,
  agentInstructionRunning,
  onOpenAgentShortcuts,
  onOpenPersistentSessions,
  onOpenSshManager,
}: SessionsSectionProps) {
  const createMenuRef = React.useRef<HTMLDivElement | null>(null);
  const settingsMenuRef = React.useRef<HTMLDivElement | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [draggingSessionId, setDraggingSessionId] = React.useState<string | null>(null);
  const [dropTarget, setDropTarget] = React.useState<{
    sessionId: string;
    position: "before" | "after";
  } | null>(null);

  const sessionListRef = React.useRef<HTMLDivElement | null>(null);
  const previousItemRectsRef = React.useRef<Map<string, DOMRect>>(new Map());
  const activeAnimationsRef = React.useRef<Map<string, Animation>>(new Map());

  // Context menu state
  const contextMenuRef = React.useRef<HTMLDivElement | null>(null);
  const [contextMenu, setContextMenu] = React.useState<{
    sessionId: string;
    x: number;
    y: number;
  } | null>(null);

  // Inline rename state
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState("");

  // Symbol picker state
  const symbolPickerRef = React.useRef<HTMLDivElement | null>(null);
  const [symbolPicker, setSymbolPicker] = React.useState<{
    sessionId: string;
    x: number;
    y: number;
  } | null>(null);

  // Color picker state
  const colorPickerRef = React.useRef<HTMLDivElement | null>(null);
  const [colorPicker, setColorPicker] = React.useState<{
    sessionId: string;
    x: number;
    y: number;
  } | null>(null);

  // Keep every floating menu fully on-screen (flip up/left near an edge).
  const contextMenuPos = useClampedMenuPosition(contextMenuRef, contextMenu);
  const symbolPickerPos = useClampedMenuPosition(symbolPickerRef, symbolPicker);
  const colorPickerPos = useClampedMenuPosition(colorPickerRef, colorPicker);

  // Agent instruction modal state
  const [agentModalOpen, setAgentModalOpen] = React.useState(false);
  const [agentCustomInstruction, setAgentCustomInstruction] = React.useState("");
  const agentModalRef = React.useRef<HTMLDivElement | null>(null);

  const handleContextMenu = React.useCallback(
    (sessionId: string, x: number, y: number) => {
      setContextMenu({ sessionId, x, y });
      setSymbolPicker(null);
      setColorPicker(null);
    },
    [],
  );

  const handleRenameStart = React.useCallback(() => {
    if (!contextMenu) return;
    const session = sessions.find((s) => s.id === contextMenu.sessionId);
    if (!session) return;
    setRenamingId(contextMenu.sessionId);
    setRenameValue(session.name);
    setContextMenu(null);
  }, [contextMenu, sessions]);

  const handleRenameSubmit = React.useCallback(() => {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    const session = sessions.find((s) => s.id === renamingId);
    if (trimmed && session && trimmed !== session.name) {
      onRenameSession(renamingId, trimmed);
    }
    setRenamingId(null);
    setRenameValue("");
  }, [renamingId, renameValue, sessions, onRenameSession]);

  const handleRenameCancel = React.useCallback(() => {
    setRenamingId(null);
    setRenameValue("");
  }, []);

  const handleSetSymbolStart = React.useCallback(() => {
    if (!contextMenu) return;
    setSymbolPicker({
      sessionId: contextMenu.sessionId,
      x: contextMenu.x,
      y: contextMenu.y,
    });
    setContextMenu(null);
  }, [contextMenu]);

  const handleRemoveSymbol = React.useCallback(() => {
    if (!contextMenu) return;
    onSetSessionSymbol(contextMenu.sessionId, null);
    setContextMenu(null);
  }, [contextMenu, onSetSessionSymbol]);

  const handleSymbolSelect = React.useCallback(
    (sym: string) => {
      if (!symbolPicker) return;
      onSetSessionSymbol(symbolPicker.sessionId, sym);
      setSymbolPicker(null);
    },
    [symbolPicker, onSetSessionSymbol],
  );

  const handleSetColorStart = React.useCallback(() => {
    if (!contextMenu) return;
    setColorPicker({
      sessionId: contextMenu.sessionId,
      x: contextMenu.x,
      y: contextMenu.y,
    });
    setContextMenu(null);
  }, [contextMenu]);

  const handleRemoveColor = React.useCallback(() => {
    if (!contextMenu) return;
    onSetSessionColor(contextMenu.sessionId, null);
    setContextMenu(null);
  }, [contextMenu, onSetSessionColor]);

  const handleColorSelect = React.useCallback(
    (val: string) => {
      if (!colorPicker) return;
      onSetSessionColor(colorPicker.sessionId, val);
      setColorPicker(null);
    },
    [colorPicker, onSetSessionColor],
  );

  const handleCloseFromContextMenu = React.useCallback(() => {
    if (!contextMenu) return;
    onCloseSession(contextMenu.sessionId);
    setContextMenu(null);
  }, [contextMenu, onCloseSession]);

  const handleTogglePinFromContextMenu = React.useCallback(() => {
    if (!contextMenu) return;
    onToggleSessionPin(contextMenu.sessionId);
    setContextMenu(null);
  }, [contextMenu, onToggleSessionPin]);

  const handleDragEnd = React.useCallback(() => {
    setDraggingSessionId(null);
    setDropTarget(null);
  }, []);

  React.useLayoutEffect(() => {
    const list = sessionListRef.current;
    if (!list) return;

    const items = Array.from(list.querySelectorAll<HTMLElement>(".sessionItem"));
    const nextRects = new Map<string, DOMRect>();
    for (const item of items) {
      const id = item.dataset.sessionId;
      if (!id) continue;
      nextRects.set(id, item.getBoundingClientRect());
    }

    const prevRects = previousItemRectsRef.current;
    if (prevRects.size > 0) {
      for (const item of items) {
        const id = item.dataset.sessionId;
        if (!id) continue;
        const prev = prevRects.get(id);
        const next = nextRects.get(id);
        if (!prev || !next) continue;
        if (id === draggingSessionId) continue;

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
  }, [sessions, draggingSessionId]);

  const handleDragHandlePointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLButtonElement>, sessionId: string) => {
      if (sessions.length <= 1) return;
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
          setDraggingSessionId(sessionId);
          setDropTarget(null);
          document.body.style.cursor = "grabbing";
          document.body.style.userSelect = "none";
        }

        const list = sessionListRef.current;
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
        const item = element?.closest<HTMLElement>(".sessionItem") ?? null;
        if (!item || !list.contains(item)) {
          setDropTarget(null);
          return;
        }

        const targetId = item.dataset.sessionId ?? null;
        if (!targetId || targetId === sessionId) {
          setDropTarget(null);
          return;
        }

        const rect = item.getBoundingClientRect();
        const position = getDropPosition(y, rect, targetId);
        setDropTarget((prev) => {
          if (prev?.sessionId === targetId && prev.position === position) return prev;
          return { sessionId: targetId, position };
        });

        if (lastTargetId === targetId && lastPosition === position) return;
        lastTargetId = targetId;
        lastPosition = position;
        onReorderSession(sessionId, targetId, position);
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
    },
    [sessions.length, onReorderSession, handleDragEnd],
  );

  // Dismiss handlers for menus, context menu, symbol picker, color picker
  React.useEffect(() => {
    if (!createOpen && !settingsOpen && !contextMenu && !symbolPicker && !colorPicker) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (createMenuRef.current?.contains(target)) return;
      if (settingsMenuRef.current?.contains(target)) return;
      if (contextMenuRef.current?.contains(target)) return;
      if (symbolPickerRef.current?.contains(target)) return;
      if (colorPickerRef.current?.contains(target)) return;
      setCreateOpen(false);
      setSettingsOpen(false);
      setContextMenu(null);
      setSymbolPicker(null);
      setColorPicker(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setCreateOpen(false);
      setSettingsOpen(false);
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
  }, [createOpen, settingsOpen, contextMenu, symbolPicker, colorPicker]);

  const contextSession = contextMenu
    ? sessions.find((s) => s.id === contextMenu.sessionId)
    : null;

  const handleSelectStandaloneSession = React.useCallback(
    (sessionId: string) => {
      onUnsplit();
      onSelectSession(sessionId);
    },
    [onSelectSession, onUnsplit],
  );

  const resolvedSplitViews = React.useMemo(() => {
    const sessionById = new Map(sessions.map((s) => [s.id, s] as const));
    return splitViews
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((view) => {
        const aSession = sessionById.get(view.aId) ?? null;
        const bSession = sessionById.get(view.bId) ?? null;
        if (!aSession || !bSession) return null;
        if (aSession.id === bSession.id) return null;
        return { view, aSession, bSession };
      })
      .filter(
        (item): item is { view: SplitView; aSession: Session; bSession: Session } => item !== null,
      );
  }, [sessions, splitViews]);

  return (
    <>
      <div className="sidebarHeader">
        <div className="title">Sessions</div>
        <div className="sidebarHeaderActions">
          <div className="sidebarActionMenu" ref={createMenuRef}>
            <button
              type="button"
              className={`btnSmall btnIcon ${createOpen ? "btnIconActive" : ""}`}
              onClick={() =>
                setCreateOpen((prev) => {
                  const next = !prev;
                  if (next) setSettingsOpen(false);
                  return next;
                })
              }
              title="New terminal"
              aria-label="New terminal"
              aria-haspopup="menu"
              aria-expanded={createOpen}
            >
              <Icon name="plus" />
            </button>
            {createOpen && (
              <div className="sidebarActionMenuDropdown" role="menu" aria-label="New terminal">
                <button
                  type="button"
                  className="sidebarActionMenuItem"
                  role="menuitem"
                  onClick={() => {
                    setCreateOpen(false);
                    onOpenNewSession();
                  }}
                >
                  <Icon name="plus" />
                  <span
                    className="sessionLegendSwatch sessionLegendSwatchDefault"
                    aria-hidden="true"
                  />
                  <span>New terminal</span>
                </button>
                <button
                  type="button"
                  className="sidebarActionMenuItem"
                  role="menuitem"
                  onClick={() => {
                    setCreateOpen(false);
                    onOpenSshManager();
                  }}
                >
                  <Icon name="ssh" />
                  <span className="sessionLegendSwatch sessionLegendSwatchSsh" aria-hidden="true" />
                  <span>SSH connect</span>
                </button>
              </div>
            )}
          </div>

          <div className="sidebarActionMenu" ref={settingsMenuRef}>
            <button
              type="button"
              className={`btnSmall btnIcon ${settingsOpen ? "btnIconActive" : ""}`}
              onClick={() =>
                setSettingsOpen((prev) => {
                  const next = !prev;
                  if (next) setCreateOpen(false);
                  return next;
                })
              }
              title="Session tools"
              aria-label="Session tools"
              aria-haspopup="menu"
              aria-expanded={settingsOpen}
            >
              <Icon name="settings" />
            </button>
            {settingsOpen && (
              <div className="sidebarActionMenuDropdown" role="menu" aria-label="Session tools">
                <button
                  type="button"
                  className="sidebarActionMenuItem"
                  role="menuitem"
                  onClick={() => {
                    setSettingsOpen(false);
                    onOpenAgentShortcuts();
                  }}
                >
                  <Icon name="brain" />
                  <span>Agent shortcuts</span>
                </button>
                <button
                  type="button"
                  className="sidebarActionMenuItem"
                  role="menuitem"
                  onClick={() => {
                    setSettingsOpen(false);
                    onOpenPersistentSessions();
                  }}
                >
                  <Icon name="layers" />
                  <span
                    className="sessionLegendSwatch sessionLegendSwatchPersistent"
                    aria-hidden="true"
                  />
                  <span>Manage persistent terminals</span>
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            className={`btnSmall btnIcon ${agentInstructionRunning ? "btnIconActive" : ""}`}
            onClick={() => {
              if (!agentInstructionRunning) {
                setAgentCustomInstruction("");
                setAgentModalOpen(true);
              }
            }}
            title={
              agentInstructionRunning
                ? "Agent is working…"
                : "Agent actions"
            }
            aria-label={
              agentInstructionRunning
                ? "Agent is working…"
                : "Agent actions"
            }
            disabled={agentInstructionRunning || sessions.length === 0}
          >
            <Icon
              name={agentInstructionRunning ? "refresh" : "wand"}
              className={agentInstructionRunning ? "sessionAutoRenameIconSpin" : undefined}
            />
          </button>
        </div>
      </div>

      {agentShortcuts.length > 0 && (
        <div className="agentShortcutRow" role="toolbar" aria-label="Agent shortcuts">
          {agentShortcuts.map((effect) => (
            <button
              key={effect.id}
              type="button"
              className="agentShortcutBtn"
              onClick={() => onQuickStart(effect)}
              title={`Start ${effect.label}`}
            >
              {effect.iconSrc ? (
                <img className="agentShortcutIcon" src={effect.iconSrc} alt="" aria-hidden="true" />
              ) : (
                <span className="agentShortcutIconFallback" aria-hidden="true">
                  {"\u25B6"}
                </span>
              )}
              <span className="agentShortcutLabel">{effect.label}</span>
            </button>
          ))}
        </div>
      )}

      <div className="sessionList" ref={sessionListRef}>
        {sessions.length === 0 ? (
          <div className="empty">No sessions in this project.</div>
        ) : (
          sessions.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              isActive={s.id === activeSessionId}
              isSecondary={false}
              isAgentWorking={agentWorkingIds.has(s.id)}
              isRenaming={renamingId === s.id}
              isPinned={Boolean(s.pinned)}
              isDragging={draggingSessionId === s.id}
              dropPosition={draggingSessionId && draggingSessionId !== s.id && dropTarget?.sessionId === s.id ? dropTarget.position : null}
              renameValue={renamingId === s.id ? renameValue : ""}
              onSelectSession={handleSelectStandaloneSession}
              onCloseSession={onCloseSession}
              onReconnectSession={onReconnectSession}
              onDragHandlePointerDown={handleDragHandlePointerDown}
              onContextMenu={handleContextMenu}
              onRenameValueChange={setRenameValue}
              onRenameSubmit={handleRenameSubmit}
              onRenameCancel={handleRenameCancel}
            />
          ))
        )}

        {resolvedSplitViews.length > 0 ? (
          <>
            <div className="sessionListSectionLabel">Split views</div>
            {resolvedSplitViews.map(({ view, aSession, bSession }) => {
              const isActiveView = view.id === activeSplitViewId;
              const directionLabel = view.direction === "vertical" ? "right" : "down";
              return (
                <div
                  key={view.id}
                  className={`sessionSplitGroup ${isActiveView ? "sessionSplitGroupActive" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`Split view: ${aSession.name} and ${bSession.name}`}
                  onClick={() => onActivateSplitView(view.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onActivateSplitView(view.id);
                    }
                  }}
                >
                  <div className="sessionSplitGroupHeader">
                    <Icon name="panel" size={14} />
                    <span className="sessionSplitGroupTitle">Split view</span>
                    <span className="sessionSplitGroupMeta">{directionLabel}</span>
                    <button
                      type="button"
                      className="sessionSplitGroupRemove"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveSplitView(view.id);
                      }}
                      title="Remove split view"
                      aria-label="Remove split view"
                    >
                      <Icon name="trash" size={14} />
                    </button>
                    {isActiveView ? (
                      <button
                        type="button"
                        className="sessionSplitGroupUnsplit"
                        onClick={(e) => {
                          e.stopPropagation();
                          onUnsplit();
                        }}
                        title="Exit split view"
                        aria-label="Exit split view"
                      >
                        <Icon name="close" size={14} />
                      </button>
                    ) : null}
                  </div>
                  <div className="sessionSplitGroupMembers">
                    <button
                      type="button"
                      className={`sessionSplitViewMember ${
                        aSession.id === activeSessionId ? "sessionSplitViewMemberActive" : ""
                      } ${
                        (() => {
                          const launchOrRestore =
                            aSession.launchCommand ??
                            (aSession.restoreCommand?.trim() ? aSession.restoreCommand.trim() : null) ??
                            null;
                          const isPersistent = Boolean(aSession.persistent);
                          const isSshType = isSshCommand(launchOrRestore) && !isPersistent;
                          return isPersistent
                            ? "sessionSplitViewMemberPersistent"
                            : isSshType
                              ? "sessionSplitViewMemberSsh"
                              : "sessionSplitViewMemberDefault";
                        })()
                      } ${aSession.color ? "sessionSplitViewMemberColored" : ""}`}
                      style={
                        aSession.color
                          ? ({ "--tab-color": aSession.color } as React.CSSProperties)
                          : undefined
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        onActivateSplitView(view.id, aSession.id);
                      }}
                      title={aSession.cwd ?? undefined}
                    >
                      <span className="sessionSplitTag" aria-hidden="true">
                        A
                      </span>
                      {(() => {
                        const aLaunchOrRestore =
                          aSession.launchCommand ??
                          (aSession.restoreCommand?.trim() ? aSession.restoreCommand.trim() : null) ??
                          null;
                        const aEffect =
                          getProcessEffectById(aSession.effectId) ??
                          detectProcessEffect({ command: aLaunchOrRestore, name: aSession.name });
                        if (aSession.symbol) return <span className="sessionSymbol">{aSession.symbol}</span>;
                        if (aEffect?.iconSrc) {
                          return (
                            <span className={`agentBadge sessionSplitViewAgentBadge chip-${aEffect.id}`} title={aEffect.label}>
                              <img className="agentIcon" src={aEffect.iconSrc} alt={aEffect.label} />
                            </span>
                          );
                        }
                        return null;
                      })()}
                      <span className="sessionSplitViewMemberName">{aSession.name}</span>
                    </button>
                    <button
                      type="button"
                      className={`sessionSplitViewMember ${
                        bSession.id === activeSessionId ? "sessionSplitViewMemberActive" : ""
                      } ${
                        (() => {
                          const launchOrRestore =
                            bSession.launchCommand ??
                            (bSession.restoreCommand?.trim() ? bSession.restoreCommand.trim() : null) ??
                            null;
                          const isPersistent = Boolean(bSession.persistent);
                          const isSshType = isSshCommand(launchOrRestore) && !isPersistent;
                          return isPersistent
                            ? "sessionSplitViewMemberPersistent"
                            : isSshType
                              ? "sessionSplitViewMemberSsh"
                              : "sessionSplitViewMemberDefault";
                        })()
                      } ${bSession.color ? "sessionSplitViewMemberColored" : ""}`}
                      style={
                        bSession.color
                          ? ({ "--tab-color": bSession.color } as React.CSSProperties)
                          : undefined
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        onActivateSplitView(view.id, bSession.id);
                      }}
                      title={bSession.cwd ?? undefined}
                    >
                      <span className="sessionSplitTag" aria-hidden="true">
                        B
                      </span>
                      {(() => {
                        const bLaunchOrRestore =
                          bSession.launchCommand ??
                          (bSession.restoreCommand?.trim() ? bSession.restoreCommand.trim() : null) ??
                          null;
                        const bEffect =
                          getProcessEffectById(bSession.effectId) ??
                          detectProcessEffect({ command: bLaunchOrRestore, name: bSession.name });
                        if (bSession.symbol) return <span className="sessionSymbol">{bSession.symbol}</span>;
                        if (bEffect?.iconSrc) {
                          return (
                            <span className={`agentBadge sessionSplitViewAgentBadge chip-${bEffect.id}`} title={bEffect.label}>
                              <img className="agentIcon" src={bEffect.iconSrc} alt={bEffect.label} />
                            </span>
                          );
                        }
                        return null;
                      })()}
                      <span className="sessionSplitViewMemberName">{bSession.name}</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </>
        ) : null}
      </div>

      {/* Context menu — portalled to body to escape sidebar's backdrop-filter containing block */}
      {contextMenu && contextSession && createPortal(
        <div
          ref={contextMenuRef}
          className="sessionContextMenu"
          style={{ top: contextMenuPos.top, left: contextMenuPos.left }}
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
            onClick={handleTogglePinFromContextMenu}
          >
            {contextSession.pinned ? "Unpin" : "Pin"}
          </button>
          <button
            type="button"
            className="sessionContextMenuItem"
            role="menuitem"
            onClick={handleSetSymbolStart}
          >
            Set symbol
          </button>
          {contextSession.symbol && (
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
          {contextSession.color && (
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
          {!splitPane && sessions.length >= 2 && (() => {
            // If right-clicking the active session, pick the first other session as secondary
            // If right-clicking a different session, use it as secondary
            const secondaryId = contextMenu.sessionId !== activeSessionId
              ? contextMenu.sessionId
              : sessions.find((s) => s.id !== activeSessionId && !s.closing)?.id ?? null;
            if (!secondaryId) return null;
            return (
              <>
                <button
                  type="button"
                  className="sessionContextMenuItem"
                  role="menuitem"
                  onClick={() => {
                    onSplitSession(secondaryId, "vertical");
                    setContextMenu(null);
                  }}
                >
                  Split right
                </button>
                <button
                  type="button"
                  className="sessionContextMenuItem"
                  role="menuitem"
                  onClick={() => {
                    onSplitSession(secondaryId, "horizontal");
                    setContextMenu(null);
                  }}
                >
                  Split down
                </button>
              </>
            );
          })()}
          {splitPane && (contextMenu.sessionId === activeSessionId || contextMenu.sessionId === splitPane.secondaryId) && (
            <button
              type="button"
              className="sessionContextMenuItem"
              role="menuitem"
              onClick={() => {
                onUnsplit();
                setContextMenu(null);
              }}
            >
              Unsplit
            </button>
          )}
          {splitPane && contextMenu.sessionId !== activeSessionId && contextMenu.sessionId !== splitPane.secondaryId && (
            <button
              type="button"
              className="sessionContextMenuItem"
              role="menuitem"
              onClick={() => {
                onSplitSession(contextMenu.sessionId, splitPane.direction as "horizontal" | "vertical");
                setContextMenu(null);
              }}
            >
              Show in split
            </button>
          )}
          <div className="sessionContextMenuSep" />
          <button
            type="button"
            className="sessionContextMenuItem sessionContextMenuItemDanger"
            role="menuitem"
            onClick={handleCloseFromContextMenu}
          >
            Close session
          </button>
        </div>,
        document.body,
      )}

      {/* Symbol picker */}
      {symbolPicker && createPortal(
        <div
          ref={symbolPickerRef}
          className="sessionSymbolPicker"
          style={{ top: symbolPickerPos.top, left: symbolPickerPos.left }}
        >
          {SESSION_SYMBOLS.map((sym) => (
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
          style={{ top: colorPickerPos.top, left: colorPickerPos.left }}
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

      {/* Agent instruction modal */}
      {agentModalOpen && createPortal(
        <div
          className="agentInstructionBackdrop"
          onClick={() => setAgentModalOpen(false)}
        >
          <div
            ref={agentModalRef}
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
    </>
  );
});
