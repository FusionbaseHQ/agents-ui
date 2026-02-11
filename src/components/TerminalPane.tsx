import React from "react";
import SessionTerminal, { type PendingDataBuffer, type TerminalRegistry } from "../SessionTerminal";

export type TerminalPaneSession = {
  id: string;
  projectId: string;
  persistent: boolean;
  exited?: boolean;
  closing?: boolean;
  connectionState?: "connected" | "reconnecting" | "disconnected";
};

type TerminalPaneProps = {
  sessions: TerminalPaneSession[];
  activeId: string | null;
  activeProjectId: string;
  onCwdChange: (id: string, cwd: string) => void;
  onCommandChange: (id: string, commandLine: string, source?: "osc" | "input") => void;
  onSessionResize: (id: string, size: { cols: number; rows: number }) => void;
  onSessionTransportError: (id: string, operation: "write" | "resize", errorMessage: string) => void;
  registry: React.MutableRefObject<TerminalRegistry>;
  pendingData: React.MutableRefObject<PendingDataBuffer>;
};

function TerminalPaneImpl({
  sessions,
  activeId,
  activeProjectId,
  onCwdChange,
  onCommandChange,
  onSessionResize,
  onSessionTransportError,
  registry,
  pendingData,
}: TerminalPaneProps) {
  const paneRef = React.useRef<HTMLDivElement | null>(null);
  const prevVisibleIdRef = React.useRef<string | null>(null);
  const visibleId = React.useMemo(() => {
    const activeSession = activeId ? (sessions.find((s) => s.id === activeId) ?? null) : null;
    if (activeSession && activeSession.projectId === activeProjectId) return activeId;

    const fallback =
      sessions.find((s) => s.projectId === activeProjectId && !s.closing)?.id ??
      sessions.find((s) => s.projectId === activeProjectId)?.id ??
      null;
    return fallback;
  }, [activeId, activeProjectId, sessions]);

  // Eagerly toggle visibility via direct DOM before React's commit phase.
  // useLayoutEffect fires synchronously after DOM mutations but before paint,
  // so this runs as early as possible when activeId changes.
  React.useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane || visibleId === prevVisibleIdRef.current) return;
    prevVisibleIdRef.current = visibleId;

    const containers = pane.children;
    for (let i = 0; i < containers.length; i++) {
      const el = containers[i] as HTMLElement;
      const sessionId = el.dataset.sessionId;
      if (!sessionId) continue;
      if (sessionId === visibleId) {
        el.classList.remove("terminalHidden");
      } else {
        el.classList.add("terminalHidden");
      }
    }
  }, [visibleId]);

  return (
    <div className="terminalPane" aria-label="Terminal" ref={paneRef}>
      {sessions.map((session) => (
        <div
          key={session.id}
          data-session-id={session.id}
          className={`terminalContainer ${session.id === visibleId ? "" : "terminalHidden"}`}
        >
          <SessionTerminal
            id={session.id}
            active={session.id === visibleId}
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
          />
        </div>
      ))}
    </div>
  );
}

function arePropsEqual(prev: TerminalPaneProps, next: TerminalPaneProps): boolean {
  return (
    prev.sessions === next.sessions &&
    prev.activeId === next.activeId &&
    prev.activeProjectId === next.activeProjectId &&
    prev.onCwdChange === next.onCwdChange &&
    prev.onCommandChange === next.onCommandChange &&
    prev.onSessionResize === next.onSessionResize &&
    prev.onSessionTransportError === next.onSessionTransportError &&
    prev.registry === next.registry &&
    prev.pendingData === next.pendingData
  );
}

export const TerminalPane = React.memo(TerminalPaneImpl, arePropsEqual);
