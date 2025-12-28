import React from "react";

type ApplyAssetModalProps = {
  isOpen: boolean;
  templateName: string;
  relativePath: string;
  targetLabel: string;
  targetDir: string;
  applying: boolean;
  error: string | null;
  onClose: () => void;
  onApply: (overwrite: boolean) => void;
};

export function ApplyAssetModal({
  isOpen,
  templateName,
  relativePath,
  targetLabel,
  targetDir,
  applying,
  error,
  onClose,
  onApply,
}: ApplyAssetModalProps) {
  if (!isOpen) return null;

  return (
    <div
      className="modalBackdrop"
      onClick={() => {
        if (applying) return;
        onClose();
      }}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modalTitle">Apply template</h3>

        {error && (
          <div className="pathPickerError" role="alert">
            {error}
          </div>
        )}

        <div className="hint" style={{ marginTop: 0 }}>
          Template: {templateName}
          <br />
          Relative path: {relativePath}
          <br />
          Target ({targetLabel}): {targetDir}
        </div>

        <div className="modalActions">
          <button type="button" className="btn" onClick={onClose} disabled={applying}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => onApply(false)}
            disabled={applying}
            title="Skips writing if the file already exists"
          >
            {applying ? "Applying…" : "Apply"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => onApply(true)}
            disabled={applying}
            title="Overwrites the file if it already exists"
          >
            {applying ? "Applying…" : "Apply & overwrite"}
          </button>
        </div>
      </div>
    </div>
  );
}

