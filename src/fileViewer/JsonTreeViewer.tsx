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

function JsonNode({ name, value, depth }: { name: string | null; value: JsonValue; depth: number }) {
  const isContainer = value !== null && typeof value === "object";
  const [open, setOpen] = React.useState(depth < 2);
  const entries = isContainer
    ? Array.isArray(value)
      ? value.map((v, i) => [String(i), v] as const)
      : Object.entries(value)
    : [];
  const valueClass =
    value === null ? "jsonNull" : typeof value === "number" ? "jsonNumber" : typeof value === "boolean" ? "jsonBool" : typeof value === "string" ? "jsonString" : "";

  return (
    <div className="jsonNode" style={{ paddingLeft: depth ? 14 : 0 }}>
      <div className="jsonRow" onClick={isContainer ? () => setOpen((o) => !o) : undefined} style={{ cursor: isContainer ? "pointer" : "default" }}>
        {isContainer ? <span className="jsonToggle">{open ? "▾" : "▸"}</span> : <span className="jsonToggle" />}
        {name != null ? <span className="jsonKey">{name}: </span> : null}
        {isContainer ? (
          <span className="jsonMuted">{Array.isArray(value) ? `Array(${value.length})` : `Object(${entries.length})`}</span>
        ) : (
          <span className={valueClass}>{summarize(value)}</span>
        )}
      </div>
      {isContainer && open
        ? entries.map(([k, v]) => <JsonNode key={k} name={k} value={v} depth={depth + 1} />)
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
  return (
    <div className="jsonTreeViewer">
      <div className="fileViewerToolbar">
        <span>JSON</span>
        <span className="pdfViewerSpacer" />
        <button type="button" className="btnSmall" onClick={onOpenBytes}>
          Open bytes
        </button>
      </div>
      <div className="jsonTreeBody">
        <JsonNode name={null} value={parsed.value} depth={0} />
      </div>
    </div>
  );
}
