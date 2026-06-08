import { read, utils, type Range } from "xlsx";

const MAX_ROWS = 5000;
const MAX_COLUMNS = 200;

function decodeRange(ref: unknown): Range | null {
  if (typeof ref !== "string" || !ref.trim()) return null;
  try {
    return utils.decode_range(ref);
  } catch {
    return null;
  }
}

function rangeRows(range: Range | null): number {
  return range ? Math.max(0, range.e.r - range.s.r + 1) : 0;
}

function rangeColumns(range: Range | null): number {
  return range ? Math.max(0, range.e.c - range.s.c + 1) : 0;
}

function parseSheetNames(bytes: Uint8Array): string[] {
  const workbook = read(bytes, { type: "array", bookSheets: true });
  return workbook.SheetNames;
}

function parseSheet(bytes: Uint8Array, name: string) {
  const workbook = read(bytes, {
    type: "array",
    sheets: name,
    sheetRows: MAX_ROWS,
    cellDates: true,
    cellFormula: true,
    cellHTML: false,
    cellNF: false,
    cellText: true,
    dense: false,
  });
  const sheet = workbook.Sheets[name] ?? utils.sheet_new();
  const parsedRange = decodeRange(sheet["!ref"]);
  const fullRange = decodeRange(sheet["!fullref"]) ?? parsedRange;
  const displayRange = parsedRange ?? fullRange;
  const totalRows = rangeRows(fullRange);
  const totalColumns = rangeColumns(fullRange);
  const visibleRows = Math.min(rangeRows(displayRange), MAX_ROWS);
  const visibleColumns = Math.min(rangeColumns(displayRange), MAX_COLUMNS);

  return {
    name,
    sheet,
    startRow: displayRange?.s.r ?? 0,
    startColumn: displayRange?.s.c ?? 0,
    totalRows,
    totalColumns,
    visibleRows,
    visibleColumns,
    truncatedRows: totalRows > MAX_ROWS,
    truncatedColumns: totalColumns > MAX_COLUMNS,
  };
}

self.addEventListener("message", (event: MessageEvent) => {
  const request = event.data as
    | { id: number; type: "sheetNames"; bytes: Uint8Array }
    | { id: number; type: "sheet"; bytes: Uint8Array; name: string };

  try {
    if (request.type === "sheetNames") {
      self.postMessage({ id: request.id, ok: true, sheetNames: parseSheetNames(request.bytes) });
      return;
    }
    self.postMessage({ id: request.id, ok: true, sheet: parseSheet(request.bytes, request.name) });
  } catch (err) {
    self.postMessage({
      id: request.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
