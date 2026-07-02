import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type MenuEntry =
  | {
      type?: "item";
      label: React.ReactNode;
      /** Optional leading icon node (rendered in .wsMenuIcon). */
      icon?: React.ReactNode;
      danger?: boolean;
      disabled?: boolean;
      active?: boolean;
      /** Trailing hint (e.g. a keyboard shortcut), rendered muted. */
      hint?: string;
      onSelect: () => void;
    }
  | { type: "separator" }
  | { type: "label"; label: React.ReactNode };

type MenuProps = {
  /** Viewport anchor point; the menu opens below/right and clamps on overflow. */
  anchor: { x: number; y: number };
  items: MenuEntry[];
  onClose: () => void;
  minWidth?: number;
  /** aria-label for the menu. */
  label?: string;
};

function isSelectable(e: MenuEntry): e is Extract<MenuEntry, { onSelect: () => void }> {
  return (e.type === undefined || e.type === "item") && !e.disabled;
}

/**
 * Shared context/dropdown menu: portal-positioned, viewport-clamped, closes on
 * outside click / Escape / scroll-away, with full keyboard navigation
 * (arrows, Home/End, Enter). Uses the existing .wsMenu / .wsMenuItem styles so
 * it is a drop-in replacement for the hand-rolled sidebar menus.
 */
export function Menu(props: MenuProps) {
  const { anchor, items, onClose, minWidth, label } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.x, top: anchor.y });
  const selectableIdx = useMemo(
    () => items.map((e, i) => (isSelectable(e) ? i : -1)).filter((i) => i >= 0),
    [items],
  );
  const [cursor, setCursor] = useState<number>(-1);

  // Clamp to the viewport once rendered.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    let left = anchor.x;
    let top = anchor.y;
    if (left + r.width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - r.width - pad);
    if (top + r.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - r.height - pad);
    setPos({ left, top });
  }, [anchor.x, anchor.y, items.length]);

  useEffect(() => {
    const el = ref.current;
    el?.focus();
    const onDocPointer = (e: MouseEvent) => {
      if (el && e.target instanceof Node && !el.contains(e.target)) onClose();
    };
    // Capture phase so clicks on other UI both close the menu and still land.
    document.addEventListener("mousedown", onDocPointer, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDocPointer, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const move = (delta: number) => {
    if (!selectableIdx.length) return;
    setCursor((prev) => {
      const cur = selectableIdx.indexOf(prev);
      const next = cur < 0 ? (delta > 0 ? 0 : selectableIdx.length - 1) : (cur + delta + selectableIdx.length) % selectableIdx.length;
      return selectableIdx[next];
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      if (selectableIdx.length) setCursor(selectableIdx[0]);
    } else if (e.key === "End") {
      e.preventDefault();
      if (selectableIdx.length) setCursor(selectableIdx[selectableIdx.length - 1]);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const entry = items[cursor];
      if (entry && isSelectable(entry)) {
        onClose();
        entry.onSelect();
      }
    }
  };

  const menu = (
    <div
      className="wsMenu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      ref={ref}
      style={{ left: pos.left, top: pos.top, ...(minWidth ? { minWidth } : null) }}
      onKeyDown={onKeyDown}
    >
      {items.map((entry, i) => {
        if (entry.type === "separator") return <div key={i} className="wsMenuSep" />;
        if (entry.type === "label")
          return (
            <div key={i} className="wsMenuLabel">
              {entry.label}
            </div>
          );
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`wsMenuItem${entry.danger ? " wsMenuItemDanger" : ""}${entry.active || cursor === i ? " wsMenuItemActive" : ""}`}
            disabled={entry.disabled}
            onMouseEnter={() => !entry.disabled && setCursor(i)}
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
          >
            {entry.icon !== undefined ? <span className="wsMenuIcon">{entry.icon}</span> : null}
            <span className="wsMenuItemName">{entry.label}</span>
            {entry.hint ? <span className="uiMenuHint">{entry.hint}</span> : null}
          </button>
        );
      })}
    </div>
  );

  return createPortal(menu, document.body);
}
