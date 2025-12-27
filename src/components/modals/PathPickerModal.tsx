import React from "react";

type DirectoryEntry = { name: string; path: string };
type DirectoryListing = { path: string; parent: string | null; entries: DirectoryEntry[] };

type PathPickerModalProps = {
  isOpen: boolean;
  listing: DirectoryListing | null;
  input: string;
  placeholder: string;
  loading: boolean;
  error: string | null;
  onInputChange: (value: string) => void;
  onLoad: (path: string | null) => void;
  onClose: () => void;
  onSelect: () => void;
};

export function PathPickerModal({
  isOpen,
  listing,
  input,
  placeholder,
  loading,
  error,
  onInputChange,
  onLoad,
  onClose,
  onSelect,
}: PathPickerModalProps) {
  if (!isOpen) return null;

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modalTitle">Select folder</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onLoad(input.trim() || null);
          }}
        >
          <div className="pathPickerHeader">
            <button
              type="button"
              className="btn"
              disabled={!listing?.parent || loading}
              onClick={() => onLoad(listing?.parent ?? null)}
              title="Up"
            >
              Up
            </button>
            <input
              className="input"
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
              placeholder={placeholder}
            />
            <button type="submit" className="btn" disabled={loading}>
              Go
            </button>
          </div>
        </form>

        {error && (
          <div className="pathPickerError" role="alert">
            {error}
          </div>
        )}

        <div className="pathPickerList">
          {loading ? (
            <div className="empty">Loading…</div>
          ) : listing && listing.entries.length === 0 ? (
            <div className="empty">No subfolders.</div>
          ) : (
            listing?.entries.map((e) => (
              <button
                key={e.path}
                type="button"
                className="pathPickerItem"
                onClick={() => onLoad(e.path)}
                title={e.path}
              >
                {e.name}
              </button>
            ))
          )}
        </div>

        <div className="modalActions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn" disabled={!listing} onClick={onSelect}>
            Select
          </button>
        </div>
      </div>
    </div>
  );
}

