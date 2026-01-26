import React from "react";

type NewSessionModalProps = {
  isOpen: boolean;
  projectTitle: string | null;
  name: string;
  nameInputRef: React.RefObject<HTMLInputElement>;
  onChangeName: (value: string) => void;
  command: string;
  onChangeCommand: (value: string) => void;
  commandSuggestions?: string[];
  persistent: boolean;
  onChangePersistent: (value: boolean) => void;
  cwd: string;
  onChangeCwd: (value: string) => void;
  cwdPlaceholder: string;
  onBrowseCwd: () => void;
  canUseProjectBase: boolean;
  onUseProjectBase: () => void;
  canUseCurrentTab: boolean;
  onUseCurrentTab: () => void;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
};

export function NewSessionModal({
  isOpen,
  projectTitle,
  name,
  nameInputRef,
  onChangeName,
  command,
  onChangeCommand,
  commandSuggestions,
  persistent,
  onChangePersistent,
  cwd,
  onChangeCwd,
  cwdPlaceholder,
  onBrowseCwd,
  canUseProjectBase,
  onUseProjectBase,
  canUseCurrentTab,
  onUseCurrentTab,
  onClose,
  onSubmit,
}: NewSessionModalProps) {
  if (!isOpen) return null;
  const datalistId = "newSessionCommandSuggestions";

  return (
      <div className="modalBackdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modalTitle">New terminal{projectTitle ? ` — ${projectTitle}` : ""}</h3>
        <form onSubmit={onSubmit}>
          <div className="formRow">
            <div className="label">Name (optional)</div>
            <input
              className="input"
              ref={nameInputRef}
              value={name}
              onChange={(e) => onChangeName(e.target.value)}
              placeholder="e.g. codex"
            />
          </div>
          <div className="formRow">
            <div className="label">Command (optional)</div>
            <input
              className="input"
              value={command}
              onChange={(e) => onChangeCommand(e.target.value)}
              list={commandSuggestions && commandSuggestions.length ? datalistId : undefined}
              placeholder="e.g. codex  (leave blank for a shell)"
            />
            {commandSuggestions && commandSuggestions.length ? (
              <datalist id={datalistId}>
                {commandSuggestions.map((cmd) => (
                  <option key={cmd} value={cmd} />
                ))}
              </datalist>
            ) : null}
            <div className="hint">Uses your $SHELL by default; commands run as "$SHELL -lc".</div>
          </div>
          <div className="formRow">
            <label className="checkRow">
              <input
                type="checkbox"
                checked={persistent}
                onChange={(e) => onChangePersistent(e.target.checked)}
              />
              Persistent terminal (zellij)
            </label>
            <div className="hint">
              Keeps the shell running after you close the app so you can resume later (uses a bundled{" "}
              <code>zellij</code>).
            </div>
          </div>
          <div className="formRow">
            <div className="label">Working directory</div>
            <div className="pathRow">
              <input
                className="input"
                value={cwd}
                onChange={(e) => onChangeCwd(e.target.value)}
                placeholder={cwdPlaceholder}
              />
              <button type="button" className="btn" onClick={onBrowseCwd}>
                Browse
              </button>
            </div>
            <div className="pathActions">
              <button
                type="button"
                className="btnSmall"
                onClick={onUseProjectBase}
                disabled={!canUseProjectBase}
              >
                Use project base
              </button>
              <button
                type="button"
                className="btnSmall"
                onClick={onUseCurrentTab}
                disabled={!canUseCurrentTab}
              >
                Use current tab
              </button>
            </div>
          </div>
          <div className="modalActions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn">
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
