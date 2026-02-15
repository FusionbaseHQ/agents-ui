import React from "react";
import type { SearchAddon } from "@xterm/addon-search";

type TerminalSearchBarProps = {
  searchAddon: SearchAddon;
  onClose: () => void;
};

const DECORATIONS = {
  matchBackground: "#3a5a80",
  matchBorder: "#4a6a90",
  matchOverviewRuler: "#4a8ac7",
  activeMatchBackground: "#6b8cde",
  activeMatchBorder: "#8aa4e6",
  activeMatchColorOverviewRuler: "#6b8cde",
};

export function TerminalSearchBar({ searchAddon, onClose }: TerminalSearchBarProps) {
  const [query, setQuery] = React.useState("");
  const [caseSensitive, setCaseSensitive] = React.useState(false);
  const [resultIndex, setResultIndex] = React.useState(-1);
  const [resultCount, setResultCount] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  React.useEffect(() => {
    const dispose = searchAddon.onDidChangeResults(({ resultIndex, resultCount }: { resultIndex: number; resultCount: number }) => {
      setResultIndex(resultIndex);
      setResultCount(resultCount);
    });
    return () => dispose.dispose();
  }, [searchAddon]);

  // Run search when query or caseSensitive changes
  React.useEffect(() => {
    if (!query) {
      searchAddon.clearDecorations();
      setResultIndex(-1);
      setResultCount(0);
      return;
    }
    searchAddon.findNext(query, { caseSensitive, incremental: true, decorations: DECORATIONS });
  }, [query, caseSensitive, searchAddon]);

  const doClose = React.useCallback(() => {
    onClose();
  }, [onClose]);

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        doClose();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (!query) return;
        if (e.shiftKey) {
          searchAddon.findPrevious(query, { caseSensitive, decorations: DECORATIONS });
        } else {
          searchAddon.findNext(query, { caseSensitive, decorations: DECORATIONS });
        }
        return;
      }
    },
    [caseSensitive, doClose, query, searchAddon],
  );

  // Use onMouseDown+preventDefault for all button actions to prevent focus
  // being stolen by the terminal underneath before the action completes.
  const onButtonMouseDown = React.useCallback((e: React.MouseEvent, action: () => void) => {
    e.preventDefault();
    e.stopPropagation();
    action();
  }, []);

  const matchLabel =
    !query ? "" : resultCount === 0 ? "No results" : resultIndex < 0 ? `${resultCount}+` : `${resultIndex + 1} of ${resultCount}`;

  return (
    <div
      className="terminalSearchBar"
      onMouseDown={(e) => { e.stopPropagation(); }}
    >
      <input
        ref={inputRef}
        className="terminalSearchInput"
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find…"
        spellCheck={false}
        autoComplete="off"
      />
      {matchLabel && <span className="terminalSearchCount">{matchLabel}</span>}
      <button
        type="button"
        className={`terminalSearchCaseBtn${caseSensitive ? " active" : ""}`}
        onMouseDown={(e) => onButtonMouseDown(e, () => setCaseSensitive((v) => !v))}
        title="Match case"
      >
        Aa
      </button>
      <button
        type="button"
        className="terminalSearchNavBtn"
        onMouseDown={(e) => onButtonMouseDown(e, () => {
          if (query) searchAddon.findPrevious(query, { caseSensitive, decorations: DECORATIONS });
        })}
        title="Previous match (Shift+Enter)"
      >
        &#x25B2;
      </button>
      <button
        type="button"
        className="terminalSearchNavBtn"
        onMouseDown={(e) => onButtonMouseDown(e, () => {
          if (query) searchAddon.findNext(query, { caseSensitive, decorations: DECORATIONS });
        })}
        title="Next match (Enter)"
      >
        &#x25BC;
      </button>
      <button
        type="button"
        className="terminalSearchCloseBtn"
        onMouseDown={(e) => onButtonMouseDown(e, doClose)}
        title="Close (Escape)"
      >
        &#x00D7;
      </button>
    </div>
  );
}
