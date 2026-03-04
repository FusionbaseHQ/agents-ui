import React from "react";
import SessionTerminal, { type PendingDataBuffer, type TerminalRegistry } from "../SessionTerminal";
import { shortenPathSmart } from "../pathDisplay";
import { TerminalSearchBar } from "./TerminalSearchBar";

export type SplitPane = {
  secondaryId: string;
  direction: "horizontal" | "vertical";
  ratio: number;
} | null;
type UiTheme = "paper-light" | "paper-dark";

export type TerminalPaneSession = {
  id: string;
  projectId: string;
  persistent: boolean;
  name: string;
  cwd: string | null;
  color: string | null;
  exited?: boolean;
  closing?: boolean;
  connectionState?: "connected" | "reconnecting" | "disconnected";
};

type TerminalPaneProps = {
  sessions: TerminalPaneSession[];
  activeId: string | null;
  activeProjectId: string;
  uiTheme: UiTheme;
  splitPane: SplitPane;
  onSplitRatioChange: (ratio: number) => void;
  onCloseSplitPane: (closedSessionId: string) => void;
  onCwdChange: (id: string, cwd: string) => void;
  onCommandChange: (id: string, commandLine: string, source?: "osc" | "input") => void;
  onSessionResize: (id: string, size: { cols: number; rows: number }) => void;
  onSessionTransportError: (id: string, operation: "write" | "resize", errorMessage: string) => void;
  registry: React.MutableRefObject<TerminalRegistry>;
  pendingData: React.MutableRefObject<PendingDataBuffer>;
  onRegistryChanged: () => void;
  searchOpenSessions: Set<string>;
  onSearchClose: (sessionId: string) => void;
};

const SPLIT_HEADER_HEIGHT = 26;

function TerminalPaneImpl({
  sessions,
  activeId,
  activeProjectId,
  uiTheme,
  splitPane,
  onSplitRatioChange,
  onCloseSplitPane,
  onCwdChange,
  onCommandChange,
  onSessionResize,
  onSessionTransportError,
  registry,
  pendingData,
  onRegistryChanged,
  searchOpenSessions,
  onSearchClose,
}: TerminalPaneProps) {
  const paneRef = React.useRef<HTMLDivElement | null>(null);
  const prevVisibleIdRef = React.useRef<string | null>(null);
  const prevSecondaryIdRef = React.useRef<string | null>(null);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [searchCaseSensitive, setSearchCaseSensitive] = React.useState(false);

  const visibleId = React.useMemo(() => {
    const activeSession = activeId ? (sessions.find((s) => s.id === activeId) ?? null) : null;
    if (activeSession && activeSession.projectId === activeProjectId) return activeId;

    const fallback =
      sessions.find((s) => s.projectId === activeProjectId && !s.closing)?.id ??
      sessions.find((s) => s.projectId === activeProjectId)?.id ??
      null;
    return fallback;
  }, [activeId, activeProjectId, sessions]);

  const secondaryVisibleId = splitPane?.secondaryId ?? null;
  const isSplit = secondaryVisibleId !== null && secondaryVisibleId !== visibleId;
  const visibleSearchOpen = Boolean(
    (visibleId && searchOpenSessions.has(visibleId)) ||
      (isSplit && secondaryVisibleId && searchOpenSessions.has(secondaryVisibleId)),
  );

  React.useEffect(() => {
    if (visibleSearchOpen) return;
    if (searchQuery !== "") setSearchQuery("");
    if (searchCaseSensitive) setSearchCaseSensitive(false);
  }, [searchCaseSensitive, searchQuery, visibleSearchOpen]);

  // Eagerly toggle visibility via direct DOM before React's commit phase.
  React.useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;

    const visChanged = visibleId !== prevVisibleIdRef.current;
    const secChanged = secondaryVisibleId !== prevSecondaryIdRef.current;
    if (!visChanged && !secChanged) return;
    prevVisibleIdRef.current = visibleId;
    prevSecondaryIdRef.current = secondaryVisibleId;

    const containers = pane.querySelectorAll<HTMLElement>("[data-session-id]");
    for (const el of containers) {
      const sessionId = el.dataset.sessionId;
      if (!sessionId) continue;
      const isPrimary = sessionId === visibleId;
      const isSecondary = isSplit && sessionId === secondaryVisibleId;
      if (isPrimary || isSecondary) {
        el.classList.remove("terminalHidden");
      } else {
        el.classList.add("terminalHidden");
      }
    }
  }, [visibleId, secondaryVisibleId, isSplit]);

  const closeVisibleSearch = React.useCallback(() => {
    // Close secondary first so focus ends on the primary terminal.
    if (
      isSplit &&
      secondaryVisibleId &&
      secondaryVisibleId !== visibleId &&
      searchOpenSessions.has(secondaryVisibleId)
    ) {
      onSearchClose(secondaryVisibleId);
    }
    if (visibleId && searchOpenSessions.has(visibleId)) {
      onSearchClose(visibleId);
    }
  }, [isSplit, onSearchClose, searchOpenSessions, secondaryVisibleId, visibleId]);

  // Divider drag handler
  const handleDividerDrag = React.useCallback(
    (e: React.MouseEvent) => {
      if (!splitPane || !paneRef.current) return;
      e.preventDefault();
      const pane = paneRef.current;
      const startPos = splitPane.direction === "vertical" ? e.clientX : e.clientY;
      const startRatio = splitPane.ratio;
      const rect = pane.getBoundingClientRect();
      const totalSize = splitPane.direction === "vertical" ? rect.width : rect.height;

      const onMove = (ev: MouseEvent) => {
        const currentPos = splitPane.direction === "vertical" ? ev.clientX : ev.clientY;
        const delta = currentPos - startPos;
        const newRatio = startRatio + delta / totalSize;
        onSplitRatioChange(newRatio);
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = splitPane.direction === "vertical" ? "ew-resize" : "ns-resize";
      document.body.style.userSelect = "none";
    },
    [splitPane, onSplitRatioChange],
  );

  const isVertical = splitPane?.direction === "vertical";
  const ratio = splitPane?.ratio ?? 0.5;
  const pct = ratio * 100;

  // Compute inline styles for split containers — must set ALL four inset
  // properties explicitly so they override the stylesheet `inset: 0` shorthand
  // (WebKit doesn't let inline longhands override stylesheet shorthands reliably).
  const primaryStyle: React.CSSProperties | undefined = isSplit
    ? isVertical
      ? { top: 0, right: `calc(${100 - pct}% + 4px)`, bottom: 0, left: 0, paddingTop: SPLIT_HEADER_HEIGHT }
      : { top: 0, right: 0, bottom: `calc(${100 - pct}% + 4px)`, left: 0, paddingTop: SPLIT_HEADER_HEIGHT }
    : undefined;

  const secondaryStyle: React.CSSProperties | undefined = isSplit
    ? isVertical
      ? { top: 0, right: 0, bottom: 0, left: `calc(${pct}% + 4px)`, paddingTop: SPLIT_HEADER_HEIGHT }
      : { top: `calc(${pct}% + 4px)`, right: 0, bottom: 0, left: 0, paddingTop: SPLIT_HEADER_HEIGHT }
    : undefined;

  const dividerStyle: React.CSSProperties | undefined = isSplit
    ? isVertical
      ? { position: "absolute", top: 0, bottom: 0, left: `${pct}%`, width: 8, cursor: "ew-resize", zIndex: 10, transform: "translateX(-50%)" }
      : { position: "absolute", left: 0, right: 0, top: `${pct}%`, height: 8, cursor: "ns-resize", zIndex: 10, transform: "translateY(-50%)" }
    : undefined;

  return (
    <div
      className={`terminalPane${isSplit ? " terminalPaneSplit" : ""}`}
      aria-label="Terminal"
      ref={paneRef}
    >
      {sessions.map((session) => {
        const isPrimary = session.id === visibleId;
        const isSecondary = isSplit && session.id === secondaryVisibleId;
        const showHeader = isSplit && (isPrimary || isSecondary);
        const showSearch = (isPrimary || isSecondary) && searchOpenSessions.has(session.id);
        const searchAddon = showSearch ? registry.current.get(session.id)?.search ?? null : null;
        return (
          <div
            key={session.id}
            data-session-id={session.id}
            className={`terminalContainer ${isPrimary || isSecondary ? "" : "terminalHidden"}`}
            style={isPrimary ? primaryStyle : isSecondary ? secondaryStyle : undefined}
          >
            {showHeader && (
              <div
                className="splitPaneHeader"
                style={session.color ? { "--split-header-color": session.color } as React.CSSProperties : undefined}
              >
                <span className="splitPaneHeaderTitle">{session.name}</span>
                {session.cwd && (
                  <span className="splitPaneHeaderPath">{shortenPathSmart(session.cwd, 40)}</span>
                )}
                <button
                  className="splitPaneHeaderClose"
                  onClick={() => onCloseSplitPane(session.id)}
                  title="Close split"
                >
                  ×
                </button>
              </div>
            )}
            {searchAddon && (
              <TerminalSearchBar
                searchAddon={searchAddon}
                uiTheme={uiTheme}
                query={searchQuery}
                onQueryChange={setSearchQuery}
                caseSensitive={searchCaseSensitive}
                onCaseSensitiveChange={setSearchCaseSensitive}
                onClose={closeVisibleSearch}
                autoFocus={isPrimary}
              />
            )}
            <SessionTerminal
              id={session.id}
              uiTheme={uiTheme}
              active={isPrimary || isSecondary}
              shouldFocus={isPrimary}
              readOnly={Boolean(
                session.exited ||
                  session.closing ||
                  session.connectionState === "reconnecting" ||
                  session.connectionState === "disconnected",
              )}
              persistent={session.persistent}
              onCwdChange={onCwdChange}
              onCommandChange={onCommandChange}
              onResize={onSessionResize}
              onTransportError={onSessionTransportError}
              registry={registry}
              pendingData={pendingData}
              onRegistryChanged={onRegistryChanged}
            />
          </div>
        );
      })}
      {isSplit && <div className="terminalSplitDivider" style={dividerStyle} onMouseDown={handleDividerDrag} />}
    </div>
  );
}

function arePropsEqual(prev: TerminalPaneProps, next: TerminalPaneProps): boolean {
  return (
    prev.sessions === next.sessions &&
    prev.activeId === next.activeId &&
    prev.activeProjectId === next.activeProjectId &&
    prev.uiTheme === next.uiTheme &&
    prev.splitPane === next.splitPane &&
    prev.onSplitRatioChange === next.onSplitRatioChange &&
    prev.onCloseSplitPane === next.onCloseSplitPane &&
    prev.onCwdChange === next.onCwdChange &&
    prev.onCommandChange === next.onCommandChange &&
    prev.onSessionResize === next.onSessionResize &&
    prev.onSessionTransportError === next.onSessionTransportError &&
    prev.registry === next.registry &&
    prev.pendingData === next.pendingData &&
    prev.onRegistryChanged === next.onRegistryChanged &&
    prev.searchOpenSessions === next.searchOpenSessions &&
    prev.onSearchClose === next.onSearchClose
  );
}

export const TerminalPane = React.memo(TerminalPaneImpl, arePropsEqual);
