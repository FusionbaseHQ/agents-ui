import React, { useEffect, useMemo, useState } from "react";
import {
  type ShellChoice,
  type ShellInfo,
  BUNDLED_NU,
  choiceMatchesInfo,
  shellInfoToChoice,
} from "../../shells";

type ShellPickerModalProps = {
  projectTitle: string | null;
  shells: ShellInfo[];
  loading: boolean;
  /** The project's default shell, highlighted as the default option. */
  projectDefault: ShellChoice | null;
  onRescan: () => void;
  onClose: () => void;
  onPick: (choice: ShellChoice) => void;
};

/**
 * Lightweight "which shell?" prompt for opening an individual terminal. The
 * fast path (the plain "Terminal" button) skips this and uses the project
 * default; this modal is the explicit per-terminal override.
 */
export function ShellPickerModal(props: ShellPickerModalProps) {
  const { projectTitle, shells, loading, projectDefault, onRescan, onClose, onPick } = props;

  // Always offer the bundled shell, even if detection hasn't returned it yet.
  const items = useMemo<ShellInfo[]>(() => {
    const hasBundled = shells.some((s) => s.kind === "bundled-nu");
    const bundled: ShellInfo = {
      id: "bundled-nu",
      kind: "bundled-nu",
      family: "nu",
      displayName: "Bundled Nushell",
      path: "",
      version: null,
      verified: true,
      isLoginDefault: false,
      supportsIntegration: true,
    };
    return hasBundled ? shells : [bundled, ...shells];
  }, [shells]);

  const defaultChoice = projectDefault ?? BUNDLED_NU;
  const initialIndex = Math.max(
    0,
    items.findIndex((s) => choiceMatchesInfo(defaultChoice, s)),
  );
  const [selected, setSelected] = useState(initialIndex);

  useEffect(() => {
    setSelected(Math.max(0, items.findIndex((s) => choiceMatchesInfo(defaultChoice, s))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  const confirm = () => {
    const info = items[selected];
    if (info) onPick(shellInfoToChoice(info));
  };

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modalTitle">Open terminal{projectTitle ? ` — ${projectTitle}` : ""}</h3>
        <div className="formRow">
          <div className="label">Choose a shell</div>
          <div className="shellPickerList" role="listbox" aria-label="Available shells">
            {items.map((s, i) => {
              const isDefault = choiceMatchesInfo(defaultChoice, s);
              return (
                <button
                  key={s.id}
                  type="button"
                  role="option"
                  aria-selected={i === selected}
                  className={`shellPickerItem${i === selected ? " selected" : ""}`}
                  onClick={() => setSelected(i)}
                  onDoubleClick={confirm}
                >
                  <span className="shellPickerName">
                    {s.displayName}
                    {isDefault ? <span className="shellPickerBadge">default</span> : null}
                    {s.isLoginDefault ? <span className="shellPickerBadge">login</span> : null}
                    {!s.verified && s.kind === "system" ? (
                      <span className="shellPickerBadge muted" title="Couldn't confirm this shell runs; will try anyway">
                        unverified
                      </span>
                    ) : null}
                  </span>
                  {s.path ? <span className="shellPickerPath">{s.path}</span> : null}
                </button>
              );
            })}
            {loading && items.length <= 1 ? (
              <div className="shellPickerHint">Detecting shells…</div>
            ) : null}
          </div>
          <div className="hint">
            Opens a one-off terminal with the selected shell. The plain “Terminal” button always uses
            this project’s default shell.
          </div>
        </div>
        <div className="modalActions">
          <button type="button" className="btnSmall" onClick={onRescan} disabled={loading}>
            Rescan
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn" onClick={confirm}>
            Open
          </button>
        </div>
      </div>
    </div>
  );
}
