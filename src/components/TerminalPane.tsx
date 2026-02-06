import React from "react";
import SessionTerminal, { type PendingDataBuffer, type TerminalRegistry } from "../SessionTerminal";

export type TerminalPaneSession = {
  id: string;
  persistent: boolean;
  exited?: boolean;
  closing?: boolean;
};

type TerminalPaneProps = {
  sessions: TerminalPaneSession[];
  activeId: string | null;
  onCwdChange: (id: string, cwd: string) => void;
  onCommandChange: (id: string, commandLine: string, source?: "osc" | "input") => void;
  onSessionResize: (id: string, size: { cols: number; rows: number }) => void;
  registry: React.MutableRefObject<TerminalRegistry>;
  pendingData: React.MutableRefObject<PendingDataBuffer>;
};

function TerminalPaneImpl({
  sessions,
  activeId,
  onCwdChange,
  onCommandChange,
  onSessionResize,
  registry,
  pendingData,
}: TerminalPaneProps) {
  const paneRef = React.useRef<HTMLDivElement | null>(null);
  const prevActiveIdRef = React.useRef<string | null>(null);

  // Eagerly toggle visibility via direct DOM before React's commit phase.
  // useLayoutEffect fires synchronously after DOM mutations but before paint,
  // so this runs as early as possible when activeId changes.
  React.useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane || activeId === prevActiveIdRef.current) return;
    prevActiveIdRef.current = activeId;

    const containers = pane.children;
    for (let i = 0; i < containers.length; i++) {
      const el = containers[i] as HTMLElement;
      const sessionId = el.dataset.sessionId;
      if (!sessionId) continue;
      if (sessionId === activeId) {
        el.classList.remove("terminalHidden");
      } else {
        el.classList.add("terminalHidden");
      }
    }
  }, [activeId]);

  return (
    <div className="terminalPane" aria-label="Terminal" ref={paneRef}>
      {sessions.map((session) => (
        <div
          key={session.id}
          data-session-id={session.id}
          className={`terminalContainer ${session.id === activeId ? "" : "terminalHidden"}`}
        >
          <SessionTerminal
            id={session.id}
            active={session.id === activeId}
            readOnly={Boolean(session.exited || session.closing)}
            persistent={session.persistent}
            onCwdChange={onCwdChange}
            onCommandChange={onCommandChange}
            onResize={onSessionResize}
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
    prev.onCwdChange === next.onCwdChange &&
    prev.onCommandChange === next.onCommandChange &&
    prev.onSessionResize === next.onSessionResize &&
    prev.registry === next.registry &&
    prev.pendingData === next.pendingData
  );
}

export const TerminalPane = React.memo(TerminalPaneImpl, arePropsEqual);
