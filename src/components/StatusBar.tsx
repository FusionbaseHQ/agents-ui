import React from "react";

type StatusBarProps = {
  /** Shell label for plain-shell sessions (e.g. "Bundled agsh"); null hides the chip. */
  shellLabel: string | null;
  onShellClick?: () => void;
  cwd: string | null;
  sshTarget: string | null;
  connectionState: "connected" | "reconnecting" | "disconnected" | null;
  recordingActive: boolean;
  keepAwake: boolean;
  updateAvailable: boolean;
  onOpenUpdates: () => void;
  version: string | null;
};

/**
 * Bottom status bar: session-scoped facts on the left (shell, cwd, SSH),
 * app-scoped status on the right (REC, keep-awake, update, version). Moves
 * ambient state out of the crowded topbar into the terminal-app-conventional
 * place.
 */
export function StatusBar(props: StatusBarProps) {
  const {
    shellLabel, onShellClick, cwd, sshTarget, connectionState,
    recordingActive, keepAwake, updateAvailable, onOpenUpdates, version,
  } = props;

  return (
    <footer className="statusBar" aria-label="Status bar">
      <div className="statusBarLeft">
        {shellLabel ? (
          <button
            type="button"
            className="statusChip statusChipButton"
            onClick={onShellClick}
            title="Shell for this terminal — click to open a terminal with a different shell"
          >
            {shellLabel}
          </button>
        ) : null}
        {sshTarget ? (
          <span
            className={`statusChip statusChipSsh${connectionState === "connected" ? "" : " warn"}`}
            title={connectionState ? `SSH ${connectionState}` : "SSH"}
          >
            ssh {sshTarget}
            {connectionState && connectionState !== "connected" ? ` · ${connectionState}` : ""}
          </span>
        ) : null}
        {cwd ? (
          <span className="statusCwd" title={cwd}>
            {cwd}
          </span>
        ) : null}
      </div>
      <div className="statusBarRight">
        {recordingActive ? (
          <span className="statusChip statusChipRec" title="Recording this session">
            <span className="recordingTimerDot" /> REC
          </span>
        ) : null}
        {keepAwake ? (
          <span className="statusChip" title="Keeping the Mac awake while SSH sessions are active">
            awake
          </span>
        ) : null}
        {updateAvailable ? (
          <button type="button" className="statusChip statusChipButton accent" onClick={onOpenUpdates}>
            Update available
          </button>
        ) : null}
        {version ? <span className="statusVersion">v{version}</span> : null}
      </div>
    </footer>
  );
}
