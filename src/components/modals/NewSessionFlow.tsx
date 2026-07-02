import React, { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "../../ui";

export type NewSessionFlowItem = {
  id: string;
  title: string;
  subtitle?: string;
  iconSrc?: string | null;
  /** Short mono chip rendered instead of an image (e.g. shell family). */
  glyph?: string;
  group: "start" | "agents" | "more";
  onPick: () => void;
};

type NewSessionFlowProps = {
  projectTitle: string | null;
  items: NewSessionFlowItem[];
  onClose: () => void;
};

const GROUP_LABELS: Record<NewSessionFlowItem["group"], string> = {
  start: "Start",
  agents: "Agents",
  more: "More",
};

/**
 * The one "new session" entry point (⌘T): terminal with the default shell,
 * per-shell terminal, agent quick-starts, SSH, and custom command — the same
 * actions previously split across four separate flows. Keyboard-first, same
 * list interaction as the shell picker.
 */
export function NewSessionFlow({ projectTitle, items, onClose }: NewSessionFlowProps) {
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const grouped = useMemo(() => {
    const order: NewSessionFlowItem["group"][] = ["start", "agents", "more"];
    return order
      .map((g) => ({ group: g, items: items.filter((i) => i.group === g) }))
      .filter((g) => g.items.length > 0);
  }, [items]);
  const flat = useMemo(() => grouped.flatMap((g) => g.items), [grouped]);

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
    const item = flat[idx];
    if (!item) return;
    onClose();
    item.onPick();
  };

  const move = (delta: number) =>
    setSelected((prev) => (flat.length ? (prev + delta + flat.length) % flat.length : 0));

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
    }
  };

  let idx = -1;
  return (
    <Modal title={`New session${projectTitle ? ` — ${projectTitle}` : ""}`} onClose={onClose}>
      <div
        className="shellList"
        role="listbox"
        aria-label="New session options"
        tabIndex={0}
        ref={listRef}
        onKeyDown={onKeyDown}
      >
        {grouped.map((g) => (
          <React.Fragment key={g.group}>
            <div className="shellGroupLabel">{GROUP_LABELS[g.group]}</div>
            {g.items.map((item) => {
              idx += 1;
              const i = idx;
              return (
                <div
                  key={item.id}
                  role="option"
                  data-idx={i}
                  aria-selected={i === selected}
                  className={`shellOption${i === selected ? " active" : ""}`}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => confirm(i)}
                >
                  <span className="shellOptionIcon">
                    {item.iconSrc ? (
                      <img className="agentIcon" src={item.iconSrc} alt="" aria-hidden="true" />
                    ) : (
                      item.glyph ?? "❯"
                    )}
                  </span>
                  <span className="shellOptionMain">
                    <span className="shellOptionName">{item.title}</span>
                    {item.subtitle ? <span className="shellOptionPath">{item.subtitle}</span> : null}
                  </span>
                  <span className="shellOptionCheck" aria-hidden="true">
                    ↵
                  </span>
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </div>
      <div className="hint">↑↓ to choose, Enter to start. ⌘T opens this from anywhere.</div>
    </Modal>
  );
}
