import React from "react";

type ConfirmDeleteRecordingModalProps = {
  isOpen: boolean;
  recordingLabel: string;
  onClose: () => void;
  onConfirmDelete: () => void;
};

export function ConfirmDeleteRecordingModal({
  isOpen,
  recordingLabel,
  onClose,
  onConfirmDelete,
}: ConfirmDeleteRecordingModalProps) {
  if (!isOpen) return null;

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modalTitle">Delete recording</h3>
        <div className="hint" style={{ marginTop: 0 }}>
          Delete "{recordingLabel}"? This cannot be undone.
        </div>
        <div className="modalActions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btnDanger" onClick={onConfirmDelete}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
