import React, { useState, useEffect, useCallback } from "react";
import { Modal } from "../../ui";
import {
  FILESYSTEM_TEXT_INPUT_PROPS,
  armImeSubmitSuppression,
  classifyImeEnter,
  consumeImeSubmitSuppression,
  isInvalidPosixBasename,
} from "../filesystemInput";

type DirectoryEntry = { name: string; path: string };
type DirectoryListing = {
  path: string;
  parent: string | null;
  entries: DirectoryEntry[];
  truncated?: boolean;
};

type PathPickerModalProps = {
  initialPath: string | null;
  placeholder: string;
  loadDirectory: (path: string | null) => Promise<DirectoryListing>;
  onClose: () => void;
  onSelect: (path: string, name?: string) => void;
  title?: string;
  selectLabel?: string;
  suggestedName?: string;
  nameLabel?: string;
};

export function PathPickerModal({
  initialPath,
  placeholder,
  loadDirectory,
  onClose,
  onSelect,
  title = "Select folder",
  selectLabel = "Select",
  suggestedName,
  nameLabel = "Name",
}: PathPickerModalProps) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [input, setInput] = useState(initialPath ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectionName, setSelectionName] = useState(suggestedName ?? "");
  const loadRequestRef = React.useRef(0);
  const pathInputRef = React.useRef<HTMLInputElement | null>(null);
  const pathCompositionRef = React.useRef(false);
  const pathSubmitSuppressionRef = React.useRef(0);
  const selectionNameInputRef = React.useRef<HTMLInputElement | null>(null);
  const selectionNameCompositionRef = React.useRef(false);
  const selectionNameInvalid = suggestedName !== undefined && isInvalidPosixBasename(selectionName);

  const load = useCallback(async (path: string | null) => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    setLoading(true);
    setError(null);
    try {
      const result = await loadDirectory(path);
      if (loadRequestRef.current !== requestId) return;
      setListing(result);
      setInput(result.path);
    } catch (err) {
      if (loadRequestRef.current !== requestId) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (loadRequestRef.current === requestId) setLoading(false);
    }
  }, [loadDirectory]);

  useEffect(() => {
    void load(initialPath);
    return () => {
      loadRequestRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Modal
      title={title}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={!listing || loading || input !== listing.path || selectionNameInvalid}
            onClick={() => {
              if (!listing || pathCompositionRef.current || selectionNameCompositionRef.current) return;
              const selectedName =
                suggestedName === undefined
                  ? undefined
                  : (selectionNameInputRef.current?.value ?? selectionName);
              if (selectedName !== undefined && isInvalidPosixBasename(selectedName)) return;
              onSelect(listing.path, selectedName);
            }}
          >
            {selectLabel}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (pathCompositionRef.current || consumeImeSubmitSuppression(pathSubmitSuppressionRef)) return;
          const literalPath = pathInputRef.current?.value ?? input;
          void load(literalPath.length > 0 ? literalPath : null);
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
            {...FILESYSTEM_TEXT_INPUT_PROPS}
            ref={pathInputRef}
            className="input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onCompositionStart={() => {
              pathCompositionRef.current = true;
            }}
            onCompositionEnd={(event) => {
              pathCompositionRef.current = false;
              setInput(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              const disposition = classifyImeEnter(event.nativeEvent, pathCompositionRef.current);
              if (disposition === "none") return;
              armImeSubmitSuppression(pathSubmitSuppressionRef);
              if (disposition === "trailing-enter") event.preventDefault();
              event.stopPropagation();
            }}
            placeholder={placeholder}
            aria-label="Folder path"
          />
          <button type="submit" className="btn" disabled={loading}>
            Go
          </button>
        </div>
      </form>

      {suggestedName !== undefined && (
        <>
          <label className="pathPickerName">
            <span>{nameLabel}</span>
            <input
              {...FILESYSTEM_TEXT_INPUT_PROPS}
              ref={selectionNameInputRef}
              className="input"
              value={selectionName}
              onChange={(event) => setSelectionName(event.target.value)}
              onCompositionStart={() => {
                selectionNameCompositionRef.current = true;
              }}
              onCompositionEnd={(event) => {
                selectionNameCompositionRef.current = false;
                setSelectionName(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                const disposition = classifyImeEnter(event.nativeEvent, selectionNameCompositionRef.current);
                if (disposition === "none") return;
                if (disposition === "trailing-enter") event.preventDefault();
                event.stopPropagation();
              }}
              aria-label={nameLabel}
              aria-invalid={selectionNameInvalid}
              aria-describedby={selectionNameInvalid ? "path-picker-name-error" : undefined}
            />
          </label>
          {selectionNameInvalid && (
            <div id="path-picker-name-error" className="pathPickerError" role="alert">
              Enter a non-empty name other than . or .., without / or NUL.
            </div>
          )}
        </>
      )}

      {error && (
        <div className="pathPickerError" role="alert">
          {error}
        </div>
      )}

      {listing?.truncated && !loading && (
        <div className="pathPickerNotice" role="status">
          Showing a bounded folder list. Enter a full path above to navigate to a folder that is not
          shown.
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
    </Modal>
  );
}
