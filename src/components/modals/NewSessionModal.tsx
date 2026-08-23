import React, { useState, useRef, useEffect, useImperativeHandle, forwardRef } from "react";
import { Modal } from "../../ui";
import {
  FILESYSTEM_TEXT_INPUT_PROPS,
  armImeSubmitSuppression,
  classifyImeEnter,
  consumeImeSubmitSuppression,
} from "../filesystemInput";

function normalizeSmartQuotes(input: string): string {
  return input.replace(/[""„‟«»]/g, '"').replace(/[''‚‛‹›]/g, "'");
}

export type NewSessionSubmitData = {
  name: string;
  command: string;
  persistent: boolean;
  cwd: string;
};

export type NewSessionModalHandle = {
  setCwd: (cwd: string) => void;
};

type NewSessionModalProps = {
  projectTitle: string | null;
  commandSuggestions?: string[];
  initialCwd: string;
  cwdPlaceholder: string;
  canUseProjectBase: boolean;
  projectBasePath: string | null;
  canUseCurrentTab: boolean;
  currentTabCwd: string | null;
  onBrowseCwd: (currentCwd: string) => void;
  onClose: () => void;
  onSubmit: (data: NewSessionSubmitData) => void;
};

export const NewSessionModal = forwardRef<NewSessionModalHandle, NewSessionModalProps>(
  function NewSessionModal(props, ref) {
    const {
      projectTitle, commandSuggestions, initialCwd, cwdPlaceholder,
      canUseProjectBase, projectBasePath, canUseCurrentTab, currentTabCwd,
      onBrowseCwd, onClose, onSubmit,
    } = props;

    const [name, setName] = useState("");
    const [command, setCommand] = useState("");
    const [persistent, setPersistent] = useState(false);
    const [cwd, setCwd] = useState(initialCwd);
    const nameRef = useRef<HTMLInputElement>(null);
    const cwdInputRef = useRef<HTMLInputElement>(null);
    const formCompositionRef = useRef(false);
    const formSubmitSuppressionRef = useRef(0);
    const datalistId = "newSessionCommandSuggestions";

    useImperativeHandle(ref, () => ({ setCwd }));

    useEffect(() => {
      const t = window.setTimeout(() => nameRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }, []);

    const handleSubmit = (e: React.FormEvent) => {
      e.preventDefault();
      if (formCompositionRef.current || consumeImeSubmitSuppression(formSubmitSuppressionRef)) return;
      onSubmit({ name, command, persistent, cwd: cwdInputRef.current?.value ?? cwd });
    };

    return (
      <Modal title={`New terminal${projectTitle ? ` — ${projectTitle}` : ""}`} onClose={onClose}>
        <form
          onSubmit={handleSubmit}
          onCompositionStart={() => {
            formCompositionRef.current = true;
          }}
          onCompositionEnd={() => {
            formCompositionRef.current = false;
          }}
          onKeyDown={(event) => {
            const disposition = classifyImeEnter(event.nativeEvent, formCompositionRef.current);
            if (disposition === "none") return;
            armImeSubmitSuppression(formSubmitSuppressionRef);
            if (disposition === "trailing-enter") event.preventDefault();
            event.stopPropagation();
          }}
        >
          <div className="formRow">
            <div className="label">Name (optional)</div>
            <input
              className="input"
              ref={nameRef}
              value={name}
              onChange={(e) => setName(normalizeSmartQuotes(e.target.value))}
              placeholder="e.g. codex"
            />
          </div>
          <div className="formRow">
            <div className="label">Command (optional)</div>
            <input
              className="input"
              value={command}
              onChange={(e) => setCommand(normalizeSmartQuotes(e.target.value))}
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
                onChange={(e) => setPersistent(e.target.checked)}
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
                {...FILESYSTEM_TEXT_INPUT_PROPS}
                ref={cwdInputRef}
                className="input"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder={cwdPlaceholder}
                aria-label="Working directory"
              />
              <button type="button" className="btn" onClick={() => onBrowseCwd(cwd)}>
                Browse
              </button>
            </div>
            <div className="pathActions">
              <button
                type="button"
                className="btnSmall"
                onClick={() => setCwd(projectBasePath ?? "")}
                disabled={!canUseProjectBase}
              >
                Use project base
              </button>
              <button
                type="button"
                className="btnSmall"
                onClick={() => setCwd(currentTabCwd ?? "")}
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
      </Modal>
    );
  }
);
