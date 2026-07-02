import React from "react";
import { Modal } from "../../ui";

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
    <Modal
      title="Apply template"
      onClose={() => {
        if (applying) return;
        onClose();
      }}
      actions={
        <>
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
        </>
      }
    >
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
    </Modal>
  );
}

