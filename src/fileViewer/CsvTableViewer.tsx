import React from "react";
import { readAllText } from "./readText";
import type { ReadRangeFn } from "./useChunkCache";

const MAX_CSV_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 5000;

// Minimal RFC-4180-ish parser: handles quoted fields, escaped quotes (""),
// and commas/newlines inside quotes. Delimiter is auto-detected (, ; or tab).
function parseCsv(text: string, delimiter: string, maxRows: number): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let truncated = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
    } else {
      field += ch;
    }
  }
  if (!truncated && (field.length > 0 || row.length > 0)) {
    row.push(field);
    rows.push(row);
  }
  return { rows, truncated };
}

function detectDelimiter(sample: string): string {
  const firstLine = sample.split(/\r?\n/, 1)[0] ?? "";
  const counts: Record<string, number> = {
    ",": (firstLine.match(/,/g) || []).length,
    ";": (firstLine.match(/;/g) || []).length,
    "\t": (firstLine.match(/\t/g) || []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

export default function CsvTableViewer({
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
  const [data, setData] = React.useState<{ rows: string[][]; truncated: boolean } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    if (size > MAX_CSV_BYTES) {
      setError("File is too large to render as a table.");
      return;
    }
    void (async () => {
      try {
        const text = await readAllText(readRange, path, size, () => cancelled);
        if (cancelled) return;
        setData(parseCsv(text, detectDelimiter(text), MAX_ROWS));
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
        <div className="fileViewerTitle">Could not render table</div>
        <div className="fileViewerMuted" title={error}>
          {error}
        </div>
        <button type="button" className="btnSmall" onClick={onOpenBytes}>
          Open bytes
        </button>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="fileViewerCenter">
        <div className="fileViewerTitle">Loading…</div>
      </div>
    );
  }

  const [header, ...body] = data.rows;
  return (
    <div className="csvTableViewer">
      <div className="fileViewerToolbar">
        <span>
          {data.rows.length} rows{data.truncated ? ` (first ${MAX_ROWS})` : ""}
        </span>
        <span className="pdfViewerSpacer" />
        <button type="button" className="btnSmall" onClick={onOpenBytes}>
          Open bytes
        </button>
      </div>
      <div className="csvTableBody">
        <table className="csvTable">
          {header ? (
            <thead>
              <tr>
                <th className="csvRowNum" />
                {header.map((cell, i) => (
                  <th key={i}>{cell}</th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {body.map((r, ri) => (
              <tr key={ri}>
                <td className="csvRowNum">{ri + 1}</td>
                {r.map((cell, ci) => (
                  <td key={ci}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
