import React from "react";
import { Modal } from "../../ui";

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

/** The one confirm dialog: title + message + cancel/confirm (optionally destructive). */
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
    <Modal
      top
      title={title}
      onClose={() => {
        if (busy) return;
        onClose();
      }}
      actions={
        <>
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
        </>
      }
    >
      <div className="hint" style={{ marginTop: 0 }}>
        {message}
      </div>
    </Modal>
  );
}
