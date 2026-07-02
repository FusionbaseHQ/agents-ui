import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  type ShellChoice,
  type ShellInfo,
  BUNDLED_AGSH,
  choiceMatchesInfo,
  isBundledKind,
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

type Row = { info: ShellInfo; group: "recommended" | "other" };

/**
 * "Which shell?" prompt for opening an individual terminal. The fast path (the
 * plain "Terminal" button) skips this and uses the project default; this is the
 * explicit per-terminal override. "Recommended" lists the bundled shells (agsh —
 * the default — then Nushell), the OS login shell, and the project default;
 * every other installed shell goes under "Other". Uses the shared modal chrome
 * (.modal / .modalTitle / .modalActions / .btn) for consistency.
 */
export function ShellPickerModal(props: ShellPickerModalProps) {
  const { projectTitle, shells, loading, projectDefault, onRescan, onClose, onPick } = props;
  const defaultChoice = projectDefault ?? BUNDLED_AGSH;

  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Ordered list: agsh, Nushell (bundled), the login shell, and the project
  // default under "Recommended"; every other installed shell under "Other".
  const rows = useMemo<Row[]>(() => {
    const syntheticAgsh: ShellInfo = {
      id: "bundled-agsh",
      kind: "bundled-agsh",
      family: "agsh",
      displayName: "Bundled agsh",
      path: "",
      version: null,
      verified: true,
      isLoginDefault: false,
      supportsIntegration: false,
    };
    // Bundled shells as detected (backend lists agsh first, then Nushell);
    // synthesize the default while detection is still loading so the list is
    // never empty.
    const bundled = shells.filter((s) => isBundledKind(s.kind));
    const bundledList = bundled.length ? bundled : [syntheticAgsh];
    const all = [...bundledList, ...shells.filter((s) => s.kind === "system")];

    const recIds = new Set<string>();
    const rec: ShellInfo[] = [];
    const add = (info?: ShellInfo) => {
      if (info && !recIds.has(info.id)) {
        recIds.add(info.id);
        rec.push(info);
      }
    };
    for (const b of bundledList) add(b);
    add(all.find((s) => s.isLoginDefault));
    // A project default that is some other system shell is recommended too.
    add(all.find((s) => choiceMatchesInfo(defaultChoice, s)));
    const others = all.filter((s) => !recIds.has(s.id));

    return [
      ...rec.map((info) => ({ info, group: "recommended" as const })),
      ...others.map((info) => ({ info, group: "other" as const })),
    ];
  }, [shells, defaultChoice]);

  // Start on the project default.
  useEffect(() => {
    const idx = rows.findIndex(({ info }) => choiceMatchesInfo(defaultChoice, info));
    setSelected(idx >= 0 ? idx : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length]);

  useEffect(() => {
    const t = window.setTimeout(() => listRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const confirm = (idx = selected) => {
    const row = rows[idx];
    if (row) onPick(shellInfoToChoice(row.info));
  };

  const move = (delta: number) =>
    setSelected((prev) => (rows.length ? (prev + delta + rows.length) % rows.length : 0));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      confirm();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const selectedInfo = rows[selected]?.info;
  const openLabel = selectedInfo
    ? selectedInfo.kind === "bundled-nu"
      ? "Nushell"
      : selectedInfo.kind === "bundled-agsh"
        ? "agsh"
        : selectedInfo.displayName
    : "shell";

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <h3 className="modalTitle">Open terminal{projectTitle ? ` — ${projectTitle}` : ""}</h3>

        <div className="formRow">
          <div className="label">Shell</div>
          <div className="shellList" role="listbox" aria-label="Available shells" tabIndex={0} ref={listRef}>
            {rows.map((row, i) => {
              const { info, group } = row;
              const prev = rows[i - 1];
              const showHeader = !prev || prev.group !== group;
              const isDefault = choiceMatchesInfo(defaultChoice, info);
              const sub =
                info.kind === "bundled-nu"
                  ? "ships with the app · cross-platform"
                  : info.kind === "bundled-agsh"
                    ? "ships with the app · built for coding agents"
                    : info.path;
              // The "Bundled" tag carries the bundled-ness; drop the prefix.
              const nameLabel = isBundledKind(info.kind)
                ? info.displayName.replace(/^Bundled\s+/, "")
                : info.displayName;
              return (
                <React.Fragment key={info.id}>
                  {showHeader ? (
                    <div className="shellGroupLabel">
                      {group === "recommended" ? "Recommended" : "Other"}
                    </div>
                  ) : null}
                  <div
                    role="option"
                    data-idx={i}
                    aria-selected={i === selected}
                    className={`shellOption${i === selected ? " active" : ""}`}
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => confirm(i)}
                  >
                    <span className="shellOptionIcon">{info.family}</span>
                    <span className="shellOptionMain">
                      <span className="shellOptionName">
                        {nameLabel}
                        {isBundledKind(info.kind) ? (
                          <span className="shellTag bundled">Bundled</span>
                        ) : null}
                        {isDefault ? <span className="shellTag">Default</span> : null}
                        {info.isLoginDefault ? <span className="shellTag login">Login shell</span> : null}
                      </span>
                      <span className="shellOptionPath">{sub}</span>
                    </span>
                    <span className="shellOptionCheck" aria-hidden="true">
                      ✓
                    </span>
                  </div>
                </React.Fragment>
              );
            })}
            {loading && rows.length <= 1 ? (
              <div className="shellListEmpty">Detecting shells…</div>
            ) : null}
          </div>
          <div className="hint">
            The plain “Terminal” button always opens this project’s default shell.
          </div>
        </div>

        <div className="modalActions">
          <button type="button" className="btn shellRescanBtn" onClick={onRescan} disabled={loading}>
            Rescan
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btnPrimary"
            onClick={() => confirm()}
            disabled={!selectedInfo}
          >
            Open {openLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
