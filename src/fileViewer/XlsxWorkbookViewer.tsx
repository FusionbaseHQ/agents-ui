import React from "react";
import { read, utils, type CellObject, type Range, type WorkSheet } from "xlsx";
import { concatBytes } from "./bytes";
import type { ReadRangeFn } from "./useChunkCache";

const MAX_XLSX_BYTES = 32 * 1024 * 1024;
const XLSX_CHUNK_BYTES = 1024 * 1024;
const MAX_ROWS = 5000;
const MAX_COLUMNS = 200;
const ROW_HEIGHT = 24;
const ROW_OVERSCAN = 8;

type WorkbookPreview = {
  bytes: Uint8Array;
  sheetNames: string[];
};

type SheetPreview = {
  name: string;
  sheet: WorkSheet;
  startRow: number;
  startColumn: number;
  totalRows: number;
  totalColumns: number;
  visibleRows: number;
  visibleColumns: number;
  truncatedRows: boolean;
  truncatedColumns: boolean;
};

async function readAllBytes(
  readRange: ReadRangeFn,
  path: string,
  size: number,
  isCancelled: () => boolean,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < size; offset += XLSX_CHUNK_BYTES) {
    const reqLen = Math.min(XLSX_CHUNK_BYTES, size - offset);
    const chunk = await readRange(path, offset, reqLen);
    if (isCancelled()) return new Uint8Array();
    parts.push(chunk);
    if (chunk.length === 0 || chunk.length < reqLen) break;
  }
  return concatBytes(parts);
}

function formatCell(cell: CellObject | undefined): string {
  if (!cell) return "";
  if (typeof cell.w === "string") return cell.w;
  if (cell.v instanceof Date) return cell.v.toLocaleString();
  if (cell.v != null) return String(cell.v);
  if (typeof cell.f === "string" && cell.f.trim()) return `=${cell.f}`;
  return "";
}

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

function parseSheet(bytes: Uint8Array, name: string): SheetPreview {
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

function cellText(sheet: SheetPreview, rowOffset: number, colOffset: number): string {
  const address = utils.encode_cell({
    r: sheet.startRow + rowOffset,
    c: sheet.startColumn + colOffset,
  });
  return formatCell(sheet.sheet[address] as CellObject | undefined);
}

function columnLabel(index: number, startColumn: number): string {
  return utils.encode_col(startColumn + index);
}

function useTableViewport(resetKey: string | null) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [metrics, setMetrics] = React.useState({ scrollTop: 0, height: 0 });

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let raf: number | null = null;
    const sync = () => {
      raf = null;
      const next = { scrollTop: el.scrollTop, height: el.clientHeight };
      setMetrics((prev) => (prev.scrollTop === next.scrollTop && prev.height === next.height ? prev : next));
    };
    const schedule = () => {
      if (raf != null) return;
      raf = window.requestAnimationFrame(sync);
    };

    sync();
    el.addEventListener("scroll", schedule, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", schedule);
      ro?.disconnect();
      if (raf != null) window.cancelAnimationFrame(raf);
    };
  }, []);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || resetKey == null) return;
    el.scrollTop = 0;
    setMetrics((prev) => (prev.scrollTop === 0 ? prev : { ...prev, scrollTop: 0 }));
  }, [resetKey]);

  return { ref, metrics };
}

function visibleRowWindow(rowCount: number, scrollTop: number, viewportHeight: number) {
  if (rowCount <= 0) return { start: 0, end: 0 };
  const visibleCount = viewportHeight > 0 ? Math.ceil(viewportHeight / ROW_HEIGHT) : 36;
  const start = Math.min(rowCount, Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - ROW_OVERSCAN));
  const end = Math.min(rowCount, start + visibleCount + ROW_OVERSCAN * 2);
  return { start, end };
}

function loadingView(title: string) {
  return (
    <div className="fileViewerCenter">
      <div className="fileViewerTitle">{title}</div>
    </div>
  );
}

function errorView(title: string, error: string, onOpenBytes: () => void) {
  return (
    <div className="fileViewerCenter">
      <div className="fileViewerTitle">{title}</div>
      <div className="fileViewerMuted" title={error}>
        {error}
      </div>
      <button type="button" className="btnSmall" onClick={onOpenBytes}>
        Open bytes
      </button>
    </div>
  );
}

function emptyWorkbookView(onOpenBytes: () => void) {
  return (
    <div className="fileViewerCenter">
      <div className="fileViewerTitle">No sheets</div>
      <button type="button" className="btnSmall" onClick={onOpenBytes}>
        Open bytes
      </button>
    </div>
  );
}

function spacerRow(height: number, colSpan: number, key: string) {
  if (height <= 0) return null;
  return (
    <tr key={key} className="xlsxSpacerRow" style={{ height }}>
      <td colSpan={colSpan} />
    </tr>
  );
}

function renderSheetRows(sheet: SheetPreview, start: number, end: number, colCount: number) {
  return Array.from({ length: end - start }, (_, index) => {
    const rowIndex = start + index;
    return (
      <tr key={rowIndex}>
        <td className="xlsxRowNum">{sheet.startRow + rowIndex + 1}</td>
        {Array.from({ length: colCount }, (_, colIndex) => {
          const text = cellText(sheet, rowIndex, colIndex);
          return (
            <td key={colIndex} title={text}>
              {text}
            </td>
          );
        })}
      </tr>
    );
  });
}

function WorkbookTable({
  sheet,
  source,
  activeSheet,
  onSelectSheet,
  onOpenBytes,
}: {
  sheet: SheetPreview;
  source: WorkbookPreview;
  activeSheet: number;
  onSelectSheet: (index: number) => void;
  onOpenBytes: () => void;
}) {
  const { ref, metrics } = useTableViewport(sheet.name);
  const colCount = Math.max(1, sheet.visibleColumns);
  const rowWindow = visibleRowWindow(sheet.visibleRows, metrics.scrollTop, metrics.height);
  const topSpacer = rowWindow.start * ROW_HEIGHT;
  const bottomSpacer = Math.max(0, (sheet.visibleRows - rowWindow.end) * ROW_HEIGHT);
  const truncatedParts = [
    sheet.truncatedRows ? `first ${MAX_ROWS} rows` : null,
    sheet.truncatedColumns ? `first ${MAX_COLUMNS} columns` : null,
  ].filter(Boolean);

  return (
    <div className="xlsxWorkbookViewer">
      <div className="fileViewerToolbar xlsxWorkbookToolbar">
        <div className="xlsxSheetTabs" role="tablist" aria-label="Workbook sheets">
          {source.sheetNames.map((name, index) => (
            <button
              key={`${name}:${index}`}
              type="button"
              className={`xlsxSheetTab ${index === activeSheet ? "xlsxSheetTabActive" : ""}`}
              role="tab"
              aria-selected={index === activeSheet}
              title={name}
              onClick={() => onSelectSheet(index)}
            >
              {name || `Sheet ${index + 1}`}
            </button>
          ))}
        </div>
        <span className="pdfViewerSpacer" />
        <span className="xlsxWorkbookMeta">
          {sheet.totalRows} rows x {sheet.totalColumns} columns
          {truncatedParts.length ? ` (${truncatedParts.join(", ")})` : ""}
        </span>
        <button type="button" className="btnSmall" onClick={onOpenBytes}>
          Open bytes
        </button>
      </div>
      <div className="xlsxTableBody" ref={ref}>
        <table className="xlsxTable">
          <colgroup>
            <col className="xlsxRowNumCol" />
            {Array.from({ length: colCount }, (_, index) => (
              <col key={index} className="xlsxDataCol" />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="xlsxCornerCell" />
              {Array.from({ length: colCount }, (_, index) => (
                <th key={index}>{columnLabel(index, sheet.startColumn)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.visibleRows ? (
              <>
                {spacerRow(topSpacer, colCount + 1, "top")}
                {renderSheetRows(sheet, rowWindow.start, rowWindow.end, colCount)}
                {spacerRow(bottomSpacer, colCount + 1, "bottom")}
              </>
            ) : (
              <tr>
                <td className="xlsxRowNum">1</td>
                <td className="xlsxEmptyCell">Empty sheet</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function XlsxWorkbookViewer({
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
  const [source, setSource] = React.useState<WorkbookPreview | null>(null);
  const [activeSheet, setActiveSheet] = React.useState(0);
  const [sheet, setSheet] = React.useState<SheetPreview | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [sheetError, setSheetError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setSource(null);
    setSheet(null);
    setActiveSheet(0);
    setLoadError(null);
    setSheetError(null);
    if (size > MAX_XLSX_BYTES) {
      setLoadError("File is too large to render as a workbook.");
      return;
    }
    void (async () => {
      try {
        const bytes = await readAllBytes(readRange, path, size, () => cancelled);
        if (cancelled) return;
        const sheetNames = parseSheetNames(bytes);
        if (cancelled) return;
        setSource({ bytes, sheetNames });
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, readRange, size]);

  const activeIndex = source ? Math.min(activeSheet, Math.max(0, source.sheetNames.length - 1)) : 0;

  React.useEffect(() => {
    if (!source || !source.sheetNames.length) {
      setSheet(null);
      setSheetError(null);
      return;
    }

    let cancelled = false;
    const sheetName = source.sheetNames[activeIndex];
    setSheet(null);
    setSheetError(null);
    const timer = window.setTimeout(() => {
      try {
        const parsed = parseSheet(source.bytes, sheetName);
        if (!cancelled) setSheet(parsed);
      } catch (err) {
        if (!cancelled) setSheetError(err instanceof Error ? err.message : String(err));
      }
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeIndex, source]);

  if (loadError) return errorView("Could not render workbook", loadError, onOpenBytes);
  if (!source) return loadingView("Loading workbook...");
  if (!source.sheetNames.length) return emptyWorkbookView(onOpenBytes);
  if (sheetError) return errorView("Could not render sheet", sheetError, onOpenBytes);
  if (!sheet) return loadingView("Loading sheet...");

  return (
    <WorkbookTable
      sheet={sheet}
      source={source}
      activeSheet={activeIndex}
      onSelectSheet={setActiveSheet}
      onOpenBytes={onOpenBytes}
    />
  );
}
