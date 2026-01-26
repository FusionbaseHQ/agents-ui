import React from "react";

export type PersistentSessionsModalItem = {
  persistId: string;
  sessionName: string;
  label: string;
  openInUi: boolean;
};

type PersistentSessionsModalProps = {
  isOpen: boolean;
  loading: boolean;
  error: string | null;
  sessions: PersistentSessionsModalItem[];
  onClose: () => void;
  onRefresh: () => void;
  onAttach: (persistId: string) => void;
  onRequestKill: (persistId: string) => void;
};

export function PersistentSessionsModal({
  isOpen,
  loading,
  error,
  sessions,
  onClose,
  onRefresh,
  onAttach,
  onRequestKill,
}: PersistentSessionsModalProps) {
  if (!isOpen) return null;

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modalTitle">Persistent terminals</h3>
        <div className="hint" style={{ marginTop: 0 }}>
          Running bundled <code>zellij</code> sessions started by Agents UI. Kill them to stop background shells.
        </div>

        <div className="agentShortcutEditorSection">
          <div className="agentShortcutEditorTitle">Sessions</div>
          {loading ? (
            <div className="empty">Loading…</div>
          ) : error ? (
            <div className="empty">{error}</div>
          ) : sessions.length === 0 ? (
            <div className="empty">No persistent terminals found.</div>
          ) : (
            <div className="agentShortcutEditorList">
              {sessions.map((s) => (
                <div key={s.sessionName} className="agentShortcutEditorItem">
                  <div className="agentShortcutEditorMain">
                    <div className="agentShortcutEditorName" style={{ display: "flex", gap: 8 }}>
                      <span>{s.label}</span>
                      {s.openInUi ? (
                        <span className="chip" title="Open in the app">
                          <span className="chipLabel">open</span>
                        </span>
                      ) : (
                        <span className="chip" title="Detached (running without an attached tab)">
                          <span className="chipLabel">detached</span>
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="agentShortcutEditorActions">
                    {!s.openInUi && (
                      <button
                        type="button"
                        className="btnSmall"
                        onClick={() => onAttach(s.persistId)}
                        title="Attach"
                      >
                        Attach
                      </button>
                    )}
                    <button
                      type="button"
                      className="btnSmall btnDanger"
                      onClick={() => onRequestKill(s.persistId)}
                      title="Kill session"
                    >
                      Kill
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modalActions">
          <button type="button" className="btnSmall" onClick={onRefresh} disabled={loading}>
            Refresh
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
