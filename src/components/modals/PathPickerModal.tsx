import React, { useState, useEffect, useCallback } from "react";

type DirectoryEntry = { name: string; path: string };
type DirectoryListing = { path: string; parent: string | null; entries: DirectoryEntry[] };

type PathPickerModalProps = {
  initialPath: string | null;
  placeholder: string;
  loadDirectory: (path: string | null) => Promise<DirectoryListing>;
  onClose: () => void;
  onSelect: (path: string) => void;
};

export function PathPickerModal({
  initialPath,
  placeholder,
  loadDirectory,
  onClose,
  onSelect,
}: PathPickerModalProps) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (path: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const result = await loadDirectory(path);
      setListing(result);
      setInput(result.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [loadDirectory]);

  useEffect(() => {
    void load(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modalTitle">Select folder</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void load(input.trim() || null);
          }}
        >
          <div className="pathPickerHeader">
            <button
              type="button"
              className="btn"
              disabled={!listing?.parent || loading}
              onClick={() => void load(listing?.parent ?? null)}
              title="Up"
            >
              Up
            </button>
            <input
              className="input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
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
                onClick={() => void load(e.path)}
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
          <button
            type="button"
            className="btn"
            disabled={!listing}
            onClick={() => listing && onSelect(listing.path)}
          >
            Select
          </button>
        </div>
      </div>
    </div>
  );
}
