import React from "react";

type EmptyStateProps = {
  title: string;
  /** One line of guidance under the title. */
  hint?: React.ReactNode;
  /** Primary CTA; renders as a standard .btn. */
  action?: { label: string; onClick: () => void };
  /** Tighter spacing for use inside modals/panels rather than full areas. */
  compact?: boolean;
};

/** Consistent empty state: title + hint + optional call to action. */
export function EmptyState({ title, hint, action, compact }: EmptyStateProps) {
  return (
    <div className={`emptyState${compact ? " emptyStateCompact" : ""}`}>
      <div className="emptyStateTitle">{title}</div>
      {hint ? <div className="emptyStateHint">{hint}</div> : null}
      {action ? (
        <button type="button" className="btn emptyStateAction" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
