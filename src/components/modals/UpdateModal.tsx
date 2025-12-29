import React from "react";

export type UpdateCheckState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "upToDate"; latestVersion: string; releaseUrl: string }
  | { status: "updateAvailable"; latestVersion: string; releaseUrl: string }
  | { status: "error"; message: string };

type UpdateModalProps = {
  isOpen: boolean;
  appName: string;
  currentVersion: string | null;
  updateSourceLabel: string | null;
  checkUrl: string | null;
  fallbackReleaseUrl: string | null;
  state: UpdateCheckState;
  onClose: () => void;
  onCheck: () => void;
  onOpenRelease: (url: string) => void;
};

export function UpdateModal({
  isOpen,
  appName,
  currentVersion,
  updateSourceLabel,
  checkUrl,
  fallbackReleaseUrl,
  state,
  onClose,
  onCheck,
  onOpenRelease,
}: UpdateModalProps) {
  if (!isOpen) return null;

  const isChecking = state.status === "checking";
  const releaseUrlFromState =
    state.status === "upToDate" || state.status === "updateAvailable" ? state.releaseUrl : null;
  const releaseUrl = releaseUrlFromState ?? fallbackReleaseUrl;

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modalTitle">Updates</h3>
        <div className="hint" style={{ marginTop: 0 }}>
          {appName} {currentVersion ? `v${currentVersion}` : ""}
        </div>
        {updateSourceLabel ? <div className="hint">Source: {updateSourceLabel}</div> : null}
        <div className="hint">
          Checking for updates contacts GitHub; opening a release launches your browser to download the installer.
        </div>
        {checkUrl ? (
          <div className="hint" style={{ fontFamily: "ui-monospace, monospace" }}>
            Checks: {checkUrl}
          </div>
        ) : null}
        {releaseUrl ? (
          <div className="hint" style={{ fontFamily: "ui-monospace, monospace" }}>
            Opens: {releaseUrl}
          </div>
        ) : null}

        {state.status === "idle" ? (
          <div className="hint">Check GitHub Releases for a newer version.</div>
        ) : null}
        {state.status === "checking" ? <div className="hint">Checking…</div> : null}
        {state.status === "upToDate" ? (
          <div className="hint">Up to date (latest: {state.latestVersion}).</div>
        ) : null}
        {state.status === "updateAvailable" ? (
          <div className="hint">Update available: {state.latestVersion}.</div>
        ) : null}
        {state.status === "error" ? <div className="hint">{state.message}</div> : null}

        <div className="modalActions">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          {releaseUrl ? (
            <button
              type="button"
              className="btn"
              onClick={() => onOpenRelease(releaseUrl)}
              disabled={isChecking}
            >
              Open release
            </button>
          ) : null}
          <button type="button" className="btn" onClick={onCheck} disabled={isChecking}>
            {isChecking ? "Checking…" : "Check now"}
          </button>
        </div>
      </div>
    </div>
  );
}
