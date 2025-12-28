import React from "react";

type ConfirmDeleteProjectModalProps = {
  isOpen: boolean;
  projectTitle: string;
  onClose: () => void;
  onConfirmDelete: () => void;
};

export function ConfirmDeleteProjectModal({
  isOpen,
  projectTitle,
  onClose,
  onConfirmDelete,
}: ConfirmDeleteProjectModalProps) {
  if (!isOpen) return null;

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modalTitle">Delete project</h3>
        <div className="hint" style={{ marginTop: 0 }}>
          Delete "{projectTitle}"? All sessions in this project will be closed.
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
