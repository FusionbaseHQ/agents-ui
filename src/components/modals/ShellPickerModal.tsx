import React, { useEffect, useMemo, useRef, useState } from "react";
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

type Row = { info: ShellInfo; group: "recommended" | "other" };

/**
 * "Which shell?" prompt for opening an individual terminal. The fast path (the
 * plain "Terminal" button) skips this and uses the project default; this is the
 * explicit per-terminal override. The project default and the OS login shell are
 * surfaced under "Recommended"; everything else sits under "Other shells".
 */
export function ShellPickerModal(props: ShellPickerModalProps) {
  const { projectTitle, shells, loading, projectDefault, onRescan, onClose, onPick } = props;
  const defaultChoice = projectDefault ?? BUNDLED_NU;

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Full ordered list: bundled + login shell first (Recommended), then the rest.
  const ordered = useMemo<Row[]>(() => {
    const synthetic: ShellInfo = {
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
    const bundled = shells.find((s) => s.kind === "bundled-nu") ?? synthetic;
    const all = [bundled, ...shells.filter((s) => s.kind === "system")];

    const recIds = new Set<string>();
    const rec: ShellInfo[] = [];
    const add = (info?: ShellInfo) => {
      if (info && !recIds.has(info.id)) {
        recIds.add(info.id);
        rec.push(info);
      }
    };
    add(all.find((s) => choiceMatchesInfo(defaultChoice, s)) ?? bundled);
    add(all.find((s) => s.isLoginDefault));
    const others = all.filter((s) => !recIds.has(s.id));

    return [
      ...rec.map((info) => ({ info, group: "recommended" as const })),
      ...others.map((info) => ({ info, group: "other" as const })),
    ];
  }, [shells, defaultChoice]);

  const visible = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter(
      ({ info }) =>
        info.displayName.toLowerCase().includes(q) ||
        info.family.toLowerCase().includes(q) ||
        info.path.toLowerCase().includes(q),
    );
  }, [ordered, query]);

  // Keep selection on the default (or first) as the filtered set changes.
  useEffect(() => {
    const idx = visible.findIndex(({ info }) => choiceMatchesInfo(defaultChoice, info));
    setSelected(idx >= 0 ? idx : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.length]);

  useEffect(() => {
    const t = window.setTimeout(() => filterRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, []);

  // Keep the selected row in view when navigating by keyboard (no-op if visible).
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const confirm = (idx = selected) => {
    const row = visible[idx];
    if (row) onPick(shellInfoToChoice(row.info));
  };

  const move = (delta: number) =>
    setSelected((prev) => (visible.length ? (prev + delta + visible.length) % visible.length : 0));

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

  const selectedInfo = visible[selected]?.info;
  const openLabel = selectedInfo
    ? selectedInfo.kind === "bundled-nu"
      ? "Nushell"
      : selectedInfo.displayName
    : "shell";

  return (
    <div className="modalBackdrop" onClick={onClose} onKeyDown={onKeyDown}>
      <div className="modal shellPickerModal" onClick={(e) => e.stopPropagation()}>
        <div className="shellPickerHead">
          <div className="shellPickerCrumb">
            <span>AGENTS-UI</span>
            <span className="shellPickerCrumbSep">/</span>
            <span className="shellPickerCrumbAccent">NEW TERMINAL</span>
            <span className="shellPickerCaret" aria-hidden="true" />
          </div>
          <button type="button" className="shellPickerClose" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <h3 className="shellPickerTitle">
          Choose a shell to launch{projectTitle ? ` — ${projectTitle}` : ""}
        </h3>

        <div className="shellPickerFilter">
          <span className="shellPickerFilterIcon" aria-hidden="true">
            ›
          </span>
          <input
            ref={filterRef}
            className="shellPickerFilterInput"
            placeholder="Filter shells…"
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="shellPickerCount">
            {visible.length}/{ordered.length}
          </span>
        </div>

        <div className="shellPickerScroll" ref={listRef} role="listbox" aria-label="Available shells">
          {visible.map((row, i) => {
            const { info, group } = row;
            const prev = visible[i - 1];
            const showHeader = !prev || prev.group !== group;
            const isDefault = choiceMatchesInfo(defaultChoice, info);
            const sub = info.kind === "bundled-nu" ? "bundled · cross-platform" : info.path;
            return (
              <React.Fragment key={info.id}>
                {showHeader ? (
                  <div className="shellPickerSection">
                    {group === "recommended" ? "Recommended" : "Other shells"}
                  </div>
                ) : null}
                <button
                  type="button"
                  role="option"
                  data-idx={i}
                  aria-selected={i === selected}
                  className={`shellPickerItem${i === selected ? " selected" : ""}`}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => confirm(i)}
                >
                  <span className="shellPickerIcon">{info.family}</span>
                  <span className="shellPickerBody">
                    <span className="shellPickerNameRow">
                      <span className="shellPickerName">{info.displayName}</span>
                      {isDefault ? <span className="shellPickerBadge">Default</span> : null}
                      {info.isLoginDefault ? (
                        <span className="shellPickerBadge alt">Login shell</span>
                      ) : null}
                    </span>
                    <span className="shellPickerSub">{sub}</span>
                  </span>
                  {i === selected ? (
                    <span className="shellPickerEnter" aria-hidden="true">
                      ↵
                    </span>
                  ) : null}
                </button>
              </React.Fragment>
            );
          })}
          {loading && ordered.length <= 1 ? (
            <div className="shellPickerLoading">Detecting shells…</div>
          ) : null}
          {!visible.length ? (
            <div className="shellPickerLoading">No shells match “{query.trim()}”.</div>
          ) : null}
        </div>

        <div className="shellPickerFootHint">
          Opens a one-off terminal with the selected shell. The plain <code>Terminal</code> button
          always uses this project’s default shell.
        </div>

        <div className="shellPickerActions">
          <button type="button" className="shellPickerBtn" onClick={onRescan} disabled={loading}>
            ⟳ Rescan
          </button>
          <span className="shellPickerMoveHint">
            <kbd>↑↓</kbd> move
          </span>
          <span className="shellPickerSpacer" />
          <button type="button" className="shellPickerBtn" onClick={onClose}>
            Cancel <kbd>esc</kbd>
          </button>
          <button
            type="button"
            className="shellPickerBtn shellPickerBtnPrimary"
            onClick={() => confirm()}
            disabled={!selectedInfo}
          >
            Open {openLabel} <kbd>↵</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
