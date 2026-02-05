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
  return (
    <div className="terminalPane" aria-label="Terminal">
      {sessions.map((session) => (
        <div
          key={session.id}
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
