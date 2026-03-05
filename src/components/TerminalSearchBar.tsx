import React from "react";
import type { SearchAddon } from "@xterm/addon-search";

type TerminalSearchBarProps = {
  searchAddon: SearchAddon;
  uiTheme:
    | "dawn"
    | "sepia"
    | "ember"
    | "slate"
    | "midnight"
    | "cobalt"
    | "neon"
    | "forest";
  query: string;
  onQueryChange: (value: string) => void;
  caseSensitive: boolean;
  onCaseSensitiveChange: (value: boolean) => void;
  onClose: () => void;
  autoFocus?: boolean;
};

const DECORATIONS_BY_THEME = {
  dawn: {
    matchBackground: "#2b2420",
    matchBorder: "#5e4f43",
    matchOverviewRuler: "#7d6e61",
    activeMatchBackground: "#2a669c",
    activeMatchBorder: "#d3e4f4",
    activeMatchColorOverviewRuler: "#2a669c",
  },
  sepia: {
    matchBackground: "#4d3523",
    matchBorder: "#8f5f37",
    matchOverviewRuler: "#a77345",
    activeMatchBackground: "#8f5f37",
    activeMatchBorder: "#f3ddbd",
    activeMatchColorOverviewRuler: "#8f5f37",
  },
  ember: {
    matchBackground: "#5b4730",
    matchBorder: "#b59260",
    matchOverviewRuler: "#d2a566",
    activeMatchBackground: "#d2a566",
    activeMatchBorder: "#fff0d8",
    activeMatchColorOverviewRuler: "#d2a566",
  },
  slate: {
    matchBackground: "#313a43",
    matchBorder: "#6f869f",
    matchOverviewRuler: "#8ca3bb",
    activeMatchBackground: "#8ca3bb",
    activeMatchBorder: "#edf2f8",
    activeMatchColorOverviewRuler: "#8ca3bb",
  },
  midnight: {
    matchBackground: "#2a2f36",
    matchBorder: "#6c7887",
    matchOverviewRuler: "#7d93ad",
    activeMatchBackground: "#7d93ad",
    activeMatchBorder: "#e7edf5",
    activeMatchColorOverviewRuler: "#7d93ad",
  },
  cobalt: {
    matchBackground: "#1b3553",
    matchBorder: "#3f79b2",
    matchOverviewRuler: "#5ea4ff",
    activeMatchBackground: "#5ea4ff",
    activeMatchBorder: "#d6e8ff",
    activeMatchColorOverviewRuler: "#5ea4ff",
  },
  neon: {
    matchBackground: "#1f1841",
    matchBorder: "#a75cff",
    matchOverviewRuler: "#2cf9ff",
    activeMatchBackground: "#2cf9ff",
    activeMatchBorder: "#e8fffd",
    activeMatchColorOverviewRuler: "#2cf9ff",
  },
  forest: {
    matchBackground: "#1a3326",
    matchBorder: "#3d8a5c",
    matchOverviewRuler: "#4eca7a",
    activeMatchBackground: "#4eca7a",
    activeMatchBorder: "#d4f5e1",
    activeMatchColorOverviewRuler: "#4eca7a",
  },
};

export function TerminalSearchBar({
  searchAddon,
  uiTheme,
  query,
  onQueryChange,
  caseSensitive,
  onCaseSensitiveChange,
  onClose,
  autoFocus = false,
}: TerminalSearchBarProps) {
  const [resultIndex, setResultIndex] = React.useState(-1);
  const [resultCount, setResultCount] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const decorations = DECORATIONS_BY_THEME[uiTheme];

  React.useEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [autoFocus]);

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
    searchAddon.findNext(query, { caseSensitive, incremental: true, decorations });
  }, [query, caseSensitive, searchAddon, decorations]);

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
          searchAddon.findPrevious(query, { caseSensitive, decorations });
        } else {
          searchAddon.findNext(query, { caseSensitive, decorations });
        }
        return;
      }
    },
    [caseSensitive, decorations, doClose, query, searchAddon],
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
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find…"
        spellCheck={false}
        autoComplete="off"
      />
      {matchLabel && <span className="terminalSearchCount">{matchLabel}</span>}
      <button
        type="button"
        className={`terminalSearchCaseBtn${caseSensitive ? " active" : ""}`}
        onMouseDown={(e) => onButtonMouseDown(e, () => onCaseSensitiveChange(!caseSensitive))}
        title="Match case"
      >
        Aa
      </button>
      <button
        type="button"
        className="terminalSearchNavBtn"
        onMouseDown={(e) => onButtonMouseDown(e, () => {
          if (query) searchAddon.findPrevious(query, { caseSensitive, decorations });
        })}
        title="Previous match (Shift+Enter)"
      >
        &#x25B2;
      </button>
      <button
        type="button"
        className="terminalSearchNavBtn"
        onMouseDown={(e) => onButtonMouseDown(e, () => {
          if (query) searchAddon.findNext(query, { caseSensitive, decorations });
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
