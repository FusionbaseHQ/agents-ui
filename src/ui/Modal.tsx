import React, { useEffect, useRef } from "react";

type ModalProps = {
  /** Uppercase header rendered as .modalTitle; omit for headerless dialogs. */
  title?: React.ReactNode;
  onClose: () => void;
  /** Render above other modals (.modalBackdropTop, z-index 650). */
  top?: boolean;
  /** Extra class(es) on the .modal panel (e.g. "recordingsModal"). */
  className?: string;
  /** Rendered inside a trailing .modalActions row when provided. */
  actions?: React.ReactNode;
  children: React.ReactNode;
};

/**
 * Shared modal chrome: backdrop + panel using the existing .modalBackdrop /
 * .modal / .modalTitle / .modalActions styles, with the behaviors every modal
 * hand-rolled before — click-outside to close, Escape to close (scoped to the
 * panel so the global Escape cascade doesn't double-fire), and initial focus
 * so keyboard users land inside the dialog.
 */
export function Modal(props: ModalProps) {
  const { title, onClose, top, className, actions, children } = props;
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    // Focus the panel unless something inside (e.g. an autofocused input)
    // already took focus.
    const t = window.setTimeout(() => {
      if (panel && !panel.contains(document.activeElement)) panel.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    // Focus trap: keep Tab/Shift+Tab cycling inside the dialog.
    if (e.key === "Tab") {
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || current === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className={`modalBackdrop${top ? " modalBackdropTop" : ""}`} onClick={onClose}>
      <div
        className={`modal${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {title !== undefined ? <h3 className="modalTitle">{title}</h3> : null}
        {children}
        {actions !== undefined ? <div className="modalActions">{actions}</div> : null}
      </div>
    </div>
  );
}
