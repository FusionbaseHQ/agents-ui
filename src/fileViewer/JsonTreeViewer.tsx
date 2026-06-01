import React from "react";
import { readAllText } from "./readText";
import type { ReadRangeFn } from "./useChunkCache";

const MAX_JSON_BYTES = 16 * 1024 * 1024;

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

function summarize(value: JsonValue): string {
  if (Array.isArray(value)) return `[] ${value.length}`;
  if (value && typeof value === "object") return `{} ${Object.keys(value).length}`;
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function pathForChild(parentPath: string, key: string, parentIsArray: boolean): string {
  if (parentIsArray) return `${parentPath}[${key}]`;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return parentPath === "$" ? `$.${key}` : `${parentPath}.${key}`;
  return `${parentPath}[${JSON.stringify(key)}]`;
}

function jsonValueMatches(name: string | null, value: JsonValue, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  if (name?.toLowerCase().includes(q)) return true;
  if (value === null || typeof value !== "object") return summarize(value).toLowerCase().includes(q);
  return false;
}

function jsonSubtreeMatches(name: string | null, value: JsonValue, query: string): boolean {
  if (jsonValueMatches(name, value, query)) return true;
  if (value === null || typeof value !== "object") return false;
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
  return entries.some(([childName, childValue]) => jsonSubtreeMatches(childName, childValue, query));
}

function countJsonMatches(value: JsonValue, query: string): number {
  const q = query.trim();
  if (!q) return 0;
  let count = jsonValueMatches(null, value, q) ? 1 : 0;
  if (value !== null && typeof value === "object") {
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
    for (const [name, child] of entries) {
      count += jsonSubtreeMatches(name, child, q) ? 1 : 0;
    }
  }
  return count;
}

function copyText(value: string): void {
  if (!navigator.clipboard) return;
  void navigator.clipboard.writeText(value).catch(() => {});
}

function JsonNode({
  name,
  value,
  depth,
  path,
  query,
  expandSignal,
  collapseSignal,
}: {
  name: string | null;
  value: JsonValue;
  depth: number;
  path: string;
  query: string;
  expandSignal: number;
  collapseSignal: number;
}) {
  const isContainer = value !== null && typeof value === "object";
  const [open, setOpen] = React.useState(depth < 2);
  const entries = isContainer
    ? Array.isArray(value)
      ? value.map((v, i) => [String(i), v] as const)
      : Object.entries(value)
    : [];
  const directMatch = jsonValueMatches(name, value, query);
  const subtreeMatch = query.trim() ? jsonSubtreeMatches(name, value, query) : false;
  const valueClass =
    value === null ? "jsonNull" : typeof value === "number" ? "jsonNumber" : typeof value === "boolean" ? "jsonBool" : typeof value === "string" ? "jsonString" : "";

  React.useEffect(() => {
    if (expandSignal > 0 && isContainer) setOpen(true);
  }, [expandSignal, isContainer]);

  React.useEffect(() => {
    if (collapseSignal > 0 && isContainer) setOpen(depth < 1);
  }, [collapseSignal, depth, isContainer]);

  React.useEffect(() => {
    if (query.trim() && subtreeMatch && isContainer) setOpen(true);
  }, [isContainer, query, subtreeMatch]);

  return (
    <div className="jsonNode" style={{ paddingLeft: depth ? 14 : 0 }}>
      <div
        className={`jsonRow ${directMatch ? "jsonRowMatch" : ""}`}
        onClick={isContainer ? () => setOpen((o) => !o) : undefined}
        style={{ cursor: isContainer ? "pointer" : "default" }}
      >
        {isContainer ? <span className="jsonToggle">{open ? "▾" : "▸"}</span> : <span className="jsonToggle" />}
        {name != null ? <span className="jsonKey">{name}: </span> : null}
        {isContainer ? (
          <span className="jsonMuted">{Array.isArray(value) ? `Array(${value.length})` : `Object(${entries.length})`}</span>
        ) : (
          <span className={valueClass}>{summarize(value)}</span>
        )}
        <button
          type="button"
          className="jsonPathButton"
          title={`Copy ${path}`}
          onClick={(event) => {
            event.stopPropagation();
            copyText(path);
          }}
        >
          {path}
        </button>
      </div>
      {isContainer && open
        ? entries.map(([k, v]) => (
            <JsonNode
              key={k}
              name={k}
              value={v}
              depth={depth + 1}
              path={pathForChild(path, k, Array.isArray(value))}
              query={query}
              expandSignal={expandSignal}
              collapseSignal={collapseSignal}
            />
          ))
        : null}
    </div>
  );
}

export default function JsonTreeViewer({
  path,
  size,
  readRange,
  onOpenBytes,
}: {
  path: string;
  size: number;
  readRange: ReadRangeFn;
  onOpenBytes: () => void;
}) {
  const [parsed, setParsed] = React.useState<{ value: JsonValue } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [expandSignal, setExpandSignal] = React.useState(0);
  const [collapseSignal, setCollapseSignal] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setParsed(null);
    setError(null);
    if (size > MAX_JSON_BYTES) {
      setError("File is too large to parse as a tree.");
      return;
    }
    void (async () => {
      try {
        const text = await readAllText(readRange, path, size, () => cancelled);
        if (cancelled) return;
        setParsed({ value: JSON.parse(text) as JsonValue });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, readRange, size]);

  if (error) {
    return (
      <div className="fileViewerCenter">
        <div className="fileViewerTitle">Not valid JSON</div>
        <div className="fileViewerMuted" title={error}>
          {error}
        </div>
        <button type="button" className="btnSmall" onClick={onOpenBytes}>
          Open bytes
        </button>
      </div>
    );
  }
  if (!parsed) {
    return (
      <div className="fileViewerCenter">
        <div className="fileViewerTitle">Loading…</div>
      </div>
    );
  }
  const matchCount = countJsonMatches(parsed.value, query);
  return (
    <div className="jsonTreeViewer">
      <div className="fileViewerToolbar">
        <span>JSON</span>
        <input
          className="fileViewerInput fileViewerSearchInput"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="search keys/values"
        />
        {query ? <span className="fileViewerMuted">{matchCount} matches</span> : null}
        <span className="pdfViewerSpacer" />
        <button type="button" className="btnSmall" onClick={() => setExpandSignal((value) => value + 1)}>
          Expand all
        </button>
        <button type="button" className="btnSmall" onClick={() => setCollapseSignal((value) => value + 1)}>
          Collapse
        </button>
        <button type="button" className="btnSmall" onClick={onOpenBytes}>
          Open bytes
        </button>
      </div>
      <div className="jsonTreeBody">
        <JsonNode
          name={null}
          value={parsed.value}
          depth={0}
          path="$"
          query={query}
          expandSignal={expandSignal}
          collapseSignal={collapseSignal}
        />
      </div>
    </div>
  );
}
