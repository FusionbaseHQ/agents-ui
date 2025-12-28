import React from "react";

type ConfirmActionModalProps = {
  isOpen: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmDanger?: boolean;
  busy?: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

export function ConfirmActionModal({
  isOpen,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmDanger,
  busy,
  onClose,
  onConfirm,
}: ConfirmActionModalProps) {
  if (!isOpen) return null;

  return (
    <div
      className="modalBackdrop modalBackdropTop"
      onClick={() => {
        if (busy) return;
        onClose();
      }}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modalTitle">{title}</h3>
        <div className="hint" style={{ marginTop: 0 }}>
          {message}
        </div>
        <div className="modalActions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${confirmDanger ? "btnDanger" : ""}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
