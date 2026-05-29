import React from "react";
import { getPdfWorker, pdfDocumentOptions, pdfjsLib } from "./pdfEnv";
import { concatBytes } from "../fileViewer/bytes";
import type { ReadRangeFn } from "../fileViewer/useChunkCache";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

const RANGE_CALL_MAX = 1024 * 1024; // backend caps a single range read at 1 MiB
// Granularity of PDF.js range requests. Smaller chunks reduce the wasted
// over-read when PDF.js indexes each page's (tiny) dict on open — which for a
// non-linearized PDF is one request per page — at the cost of more requests
// while rasterizing a page's content. 64 KiB is PDF.js's tuned default.
const RANGE_CHUNK = 64 * 1024;
const LIST_PADDING = 16; // px padding inside the scroll area
const PAGE_GAP = 14; // px between page slots
const RENDER_AHEAD_PX = 800; // rasterize pages within this margin of the viewport
const MAX_RENDERED_PAGES = 14; // hard ceiling on simultaneously rasterized pages (memory bound)
const MAX_CONCURRENT_RENDERS = 3; // cap in-flight PDF.js render tasks so fast scrolling can't stampede
const MAX_CANVAS_DPR = 2; // cap backing-store scale on HiDPI to bound canvas memory
const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.2;
const FALLBACK_PAGE = { w: 612, h: 792 }; // US Letter @72dpi, used until page 1 is measured

function clampScale(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

// Feeds PDF.js the bytes it asks for, on demand, by translating its range
// requests into the app's chunked `read_file_range` IPC. Because the backend
// caps a read at 1 MiB, larger requests are split and reassembled. Nothing
// loads the whole file — PDF.js only pulls the xref tail plus the objects for
// pages it actually parses.
class TauriRangeTransport extends pdfjsLib.PDFDataRangeTransport {
  private aborted = false;
  private readonly path: string;
  private readonly readRange: ReadRangeFn;
  private readonly onError: (message: string) => void;

  constructor(length: number, path: string, readRange: ReadRangeFn, onError: (message: string) => void) {
    super(length, null);
    this.path = path;
    this.readRange = readRange;
    this.onError = onError;
  }

  override requestDataRange(begin: number, end: number): void {
    void this.fulfill(begin, end);
  }

  override abort(): void {
    this.aborted = true;
  }

  private async fulfill(begin: number, end: number): Promise<void> {
    try {
      const parts: Uint8Array[] = [];
      let offset = begin;
      while (offset < end && !this.aborted) {
        const length = Math.min(RANGE_CALL_MAX, end - offset);
        const bytes = await this.readRange(this.path, offset, length);
        if (this.aborted) return;
        if (bytes.length === 0) break;
        parts.push(bytes);
        offset += bytes.length;
        if (bytes.length < length) break; // short read => end of file
      }
      if (this.aborted) return;
      this.onDataRange(begin, concatBytes(parts));
    } catch (err) {
      if (!this.aborted) this.onError(err instanceof Error ? err.message : String(err));
    }
  }
}

type PdfOutlineItem = { title: string; dest: string | unknown[] | null; items: PdfOutlineItem[] };

function PdfOutlineTree({ items, onGo, depth }: { items: PdfOutlineItem[]; onGo: (dest: PdfOutlineItem["dest"]) => void; depth: number }) {
  return (
    <ul className="pdfOutlineList">
      {items.map((item, i) => (
        <li key={i}>
          <button
            type="button"
            className="pdfOutlineItem"
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => onGo(item.dest)}
            title={item.title}
          >
            {item.title || "—"}
          </button>
          {item.items?.length ? <PdfOutlineTree items={item.items} onGo={onGo} depth={depth + 1} /> : null}
        </li>
      ))}
    </ul>
  );
}

type PageSize = { w: number; h: number };
type RenderedPage = {
  canvas: HTMLCanvasElement;
  textLayer: HTMLElement | null;
  task: RenderTask | null;
  scale: number;
  touched: number;
};

function disposeRendered(entry: RenderedPage): void {
  try {
    entry.task?.cancel();
  } catch {
    /* already settled */
  }
  entry.canvas.remove();
  entry.textLayer?.remove();
}

function isCancelled(err: unknown): boolean {
  return Boolean(err) && (err as { name?: string }).name === "RenderingCancelledException";
}

// A bare page placeholder. It owns no children in React's eyes — the rendered
// canvas is attached imperatively — so it self-registers with the parent's
// IntersectionObserver on mount and stays stable across zoom/layout re-renders.
// Memoized: when one page's true size is learned the parent re-maps every slot,
// but only the slot whose width/height actually changed needs to re-render
// (register/unregister are stable), keeping layout updates O(1) on big docs.
const PageSlot = React.memo(function PageSlot({
  pageNumber,
  width,
  height,
  register,
  unregister,
}: {
  pageNumber: number;
  width: number;
  height: number;
  register: (n: number, el: HTMLDivElement) => void;
  unregister: (n: number, el: HTMLDivElement) => void;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    register(pageNumber, el);
    return () => unregister(pageNumber, el);
  }, [pageNumber, register, unregister]);
  return (
    <div ref={ref} className="pdfPage" data-page={pageNumber} style={{ width, height, marginBottom: PAGE_GAP }} />
  );
});

export default function PdfViewer({
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
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const pdfRef = React.useRef<PDFDocumentProxy | null>(null);
  const transportRef = React.useRef<TauriRangeTransport | null>(null);
  const slotRefs = React.useRef<Map<number, HTMLDivElement>>(new Map());
  const renderedRef = React.useRef<Map<number, RenderedPage>>(new Map());
  const renderingRef = React.useRef<Set<number>>(new Set());
  const renderQueueRef = React.useRef<number[]>([]); // pages waiting for a render slot
  const activeRendersRef = React.useRef(0); // in-flight render tasks (<= MAX_CONCURRENT_RENDERS)
  const pageSizeRef = React.useRef<Map<number, PageSize>>(new Map()); // unscaled (PDF points)
  const visibleRef = React.useRef<Set<number>>(new Set());
  const observerRef = React.useRef<IntersectionObserver | null>(null);
  const passwordResolverRef = React.useRef<((password: string) => void) | null>(null);
  const renderSeqRef = React.useRef(0); // bumped on scale change to discard in-flight renders
  const lruClockRef = React.useRef(0);

  const [status, setStatus] = React.useState<"loading" | "ready" | "error" | "password">("loading");
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [passwordError, setPasswordError] = React.useState(false);
  const [numPages, setNumPages] = React.useState(0);
  const [defaultSize, setDefaultSize] = React.useState<PageSize | null>(null);
  const [scale, setScale] = React.useState(1);
  const [fitWidth, setFitWidth] = React.useState(true);
  const [rotation, setRotation] = React.useState(0); // user rotation in degrees (0/90/180/270)
  const [currentPage, setCurrentPage] = React.useState(1);
  const [outline, setOutline] = React.useState<PdfOutlineItem[] | null>(null);
  const [showOutline, setShowOutline] = React.useState(false);
  const [pageInput, setPageInput] = React.useState("");
  const [passwordInput, setPasswordInput] = React.useState("");
  const [renderError, setRenderError] = React.useState<string | null>(null);
  const [, setLayoutVersion] = React.useState(0);

  // Refs mirror state so imperative callbacks (render loop, observer) read fresh
  // values without being re-created on every change.
  const scaleRef = React.useRef(scale);
  scaleRef.current = scale;
  const numPagesRef = React.useRef(numPages);
  numPagesRef.current = numPages;
  const currentPageRef = React.useRef(currentPage);
  currentPageRef.current = currentPage;
  const rotationRef = React.useRef(rotation);
  rotationRef.current = rotation;
  const defaultSizeRef = React.useRef(defaultSize);
  defaultSizeRef.current = defaultSize;

  const evictExcess = React.useCallback(() => {
    const rendered = renderedRef.current;
    if (rendered.size <= MAX_RENDERED_PAGES) return;
    const candidates = [...rendered.entries()]
      .filter(([n]) => !visibleRef.current.has(n))
      .sort((a, b) => a[1].touched - b[1].touched);
    let over = rendered.size - MAX_RENDERED_PAGES;
    for (const [n, page] of candidates) {
      if (over <= 0) break;
      disposeRendered(page);
      rendered.delete(n);
      over -= 1;
    }
  }, []);

  const renderPage = React.useCallback(
    async (n: number) => {
      const pdf = pdfRef.current;
      const slot = slotRefs.current.get(n);
      if (!pdf || !slot) return;
      const targetScale = scaleRef.current;
      const existing = renderedRef.current.get(n);
      if (existing && existing.scale === targetScale) {
        existing.touched = ++lruClockRef.current;
        return;
      }
      if (renderingRef.current.has(n)) return;
      renderingRef.current.add(n);
      const seq = renderSeqRef.current;
      try {
        const page = await pdf.getPage(n);
        if (seq !== renderSeqRef.current) {
          page.cleanup();
          return;
        }
        const unscaled = page.getViewport({ scale: 1 });
        // Re-flow only when the slot's *displayed* size (its known size, or the
        // page-1 fallback) actually changes — uniform PDFs then never re-render
        // after page 1, avoiding scroll jank from no-op layout bumps.
        const shown = pageSizeRef.current.get(n) ?? defaultSizeRef.current;
        const sizeChanged =
          !shown || Math.abs(shown.w - unscaled.width) > 0.5 || Math.abs(shown.h - unscaled.height) > 0.5;
        pageSizeRef.current.set(n, { w: unscaled.width, h: unscaled.height });
        if (sizeChanged) setLayoutVersion((v) => v + 1);
        const viewport = page.getViewport({ scale: targetScale, rotation: (page.rotate + rotationRef.current) % 360 });
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_DPR);
        const canvas = document.createElement("canvas");
        canvas.className = "pdfPageCanvas";
        canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const task = page.render({
          canvas,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        const stale = renderedRef.current.get(n);
        if (stale) disposeRendered(stale);
        slot.replaceChildren(canvas);
        const entry: RenderedPage = { canvas, textLayer: null, task, scale: targetScale, touched: ++lruClockRef.current };
        renderedRef.current.set(n, entry);
        await task.promise;
        // Selectable/searchable/screen-reader text overlay aligned to the canvas.
        // Additive and best-effort: a failure here never blanks the page.
        try {
          const textLayerDiv = document.createElement("div");
          textLayerDiv.className = "pdfTextLayer";
          textLayerDiv.style.setProperty("--scale-factor", String(targetScale));
          textLayerDiv.style.width = `${Math.floor(viewport.width)}px`;
          textLayerDiv.style.height = `${Math.floor(viewport.height)}px`;
          const textLayer = new pdfjsLib.TextLayer({
            textContentSource: page.streamTextContent({ includeMarkedContent: true }),
            container: textLayerDiv,
            viewport,
          });
          await textLayer.render();
          if (seq === renderSeqRef.current && renderedRef.current.get(n) === entry && canvas.isConnected) {
            slot.appendChild(textLayerDiv);
            entry.textLayer = textLayerDiv;
          }
        } catch {
          /* text layer unavailable — canvas still renders */
        }
        page.cleanup();
        if (seq !== renderSeqRef.current) {
          const current = renderedRef.current.get(n);
          if (current === entry) {
            disposeRendered(entry);
            renderedRef.current.delete(n);
          }
        }
      } catch (err) {
        if (!isCancelled(err)) {
          // A single page failing to render shouldn't take down the viewer
          // (leave the placeholder), but surface it so blank pages aren't silent.
          const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          console.warn(`[pdfviewer] render FAILED: page ${n}:`, err);
          setRenderError(message);
        }
      } finally {
        renderingRef.current.delete(n);
        evictExcess();
      }
    },
    [evictExcess],
  );

  // Drain the queue while staying under the concurrency cap. Pages that have
  // scrolled back out of view before their turn are dropped, so a fast fling
  // can't leave a backlog of off-screen renders running.
  const pumpRenderQueue = React.useCallback(() => {
    const queue = renderQueueRef.current;
    while (activeRendersRef.current < MAX_CONCURRENT_RENDERS && queue.length > 0) {
      const n = queue.shift()!;
      if (!visibleRef.current.has(n)) continue;
      const existing = renderedRef.current.get(n);
      if (existing && existing.scale === scaleRef.current) {
        existing.touched = ++lruClockRef.current;
        continue;
      }
      if (renderingRef.current.has(n)) continue;
      activeRendersRef.current += 1;
      void renderPage(n).finally(() => {
        activeRendersRef.current -= 1;
        pumpRenderQueue();
      });
    }
  }, [renderPage]);

  const scheduleRender = React.useCallback(
    (n: number) => {
      // A page flung out of view before its turn shouldn't be queued at all.
      if (!visibleRef.current.has(n)) return;
      const existing = renderedRef.current.get(n);
      if (existing && existing.scale === scaleRef.current) {
        existing.touched = ++lruClockRef.current;
        return;
      }
      if (renderingRef.current.has(n) || renderQueueRef.current.includes(n)) return;
      renderQueueRef.current.push(n);
      pumpRenderQueue();
    },
    [pumpRenderQueue],
  );

  const registerSlot = React.useCallback((n: number, el: HTMLDivElement) => {
    slotRefs.current.set(n, el);
    observerRef.current?.observe(el);
  }, []);

  const unregisterSlot = React.useCallback((n: number, el: HTMLDivElement) => {
    observerRef.current?.unobserve(el);
    if (slotRefs.current.get(n) === el) slotRefs.current.delete(n);
    visibleRef.current.delete(n);
    // Tie canvas teardown to the slot's lifetime so an unmounting slot never
    // strands its canvas in the DOM (and renderedRef).
    const rendered = renderedRef.current.get(n);
    if (rendered) {
      disposeRendered(rendered);
      renderedRef.current.delete(n);
    }
  }, []);

  // Load the document via the streaming range transport. Remounts (new file)
  // are driven by the `key` prop in the parent, so this runs once per file.
  React.useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setErrorMsg(null);
    setPasswordError(false);
    setRenderError(null);
    setNumPages(0);
    setDefaultSize(null);
    setOutline(null);
    setShowOutline(false);
    slotRefs.current.clear();
    renderedRef.current.clear();
    renderingRef.current.clear();
    renderQueueRef.current.length = 0;
    activeRendersRef.current = 0;
    pageSizeRef.current.clear();
    visibleRef.current.clear();

    const transport = new TauriRangeTransport(size, path, readRange, (msg) => {
      if (!cancelled) {
        setErrorMsg(msg);
        setStatus("error");
      }
    });
    transportRef.current = transport;

    const loadingTask = pdfjsLib.getDocument({
      ...pdfDocumentOptions(),
      worker: getPdfWorker(), // explicit, app-owned worker: survives destroy(), reused across loads
      range: transport,
      disableStream: true, // never pull the file as one stream
      disableAutoFetch: true, // only fetch ranges for pages we touch
      rangeChunkSize: RANGE_CHUNK,
    });
    loadingTask.onPassword = (updatePassword: (password: string) => void, reason: number) => {
      if (cancelled) return;
      passwordResolverRef.current = updatePassword;
      setPasswordError(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD);
      setPasswordInput("");
      setStatus("password");
    };

    loadingTask.promise
      .then(async (pdf) => {
        if (cancelled) return; // cleanup destroys the loadingTask; nothing else to do
        pdfRef.current = pdf;
        setNumPages(pdf.numPages);
        try {
          const first = await pdf.getPage(1);
          if (cancelled) return;
          const vp = first.getViewport({ scale: 1 });
          pageSizeRef.current.set(1, { w: vp.width, h: vp.height });
          setDefaultSize({ w: vp.width, h: vp.height });
          first.cleanup();
        } catch {
          if (!cancelled) setDefaultSize({ ...FALLBACK_PAGE });
        }
        try {
          const tree = (await pdf.getOutline()) as PdfOutlineItem[] | null;
          if (!cancelled && tree && tree.length) setOutline(tree);
        } catch {
          /* no outline */
        }
        if (!cancelled) setStatus("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });

    return () => {
      cancelled = true;
      for (const page of renderedRef.current.values()) disposeRendered(page);
      renderedRef.current.clear();
      observerRef.current?.disconnect();
      observerRef.current = null;
      transport.abort();
      pdfRef.current = null;
      // Tears down this document (and frees the worker's per-doc state) but NOT
      // the shared worker, since we passed it in explicitly. No separate
      // pdf.destroy() — it resolves to this same call.
      void loadingTask.destroy().catch(() => {});
    };
  }, [path, size, readRange]);

  // Observe page slots once the document is ready; (re)render whatever enters
  // the viewport (plus a margin) and recompute the current page indicator.
  React.useEffect(() => {
    const el = listRef.current;
    if (!el || status !== "ready") return;

    const updateCurrentPage = () => {
      const listRect = el.getBoundingClientRect();
      let best = 0;
      let bestTop = Infinity;
      for (const n of visibleRef.current) {
        const slot = slotRefs.current.get(n);
        if (!slot) continue;
        const rect = slot.getBoundingClientRect();
        // Only count pages that actually overlap the real viewport, not the
        // prefetch margin, so the indicator tracks what the user sees.
        const overlapsViewport = rect.bottom > listRect.top + 4 && rect.top < listRect.bottom - 4;
        if (overlapsViewport && rect.top < bestTop) {
          bestTop = rect.top;
          best = n;
        }
      }
      if (best) setCurrentPage(best);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const n = Number((entry.target as HTMLElement).dataset.page);
          if (!n) continue;
          if (entry.isIntersecting) {
            visibleRef.current.add(n);
            scheduleRender(n);
          } else {
            visibleRef.current.delete(n);
          }
        }
        updateCurrentPage();
        evictExcess();
      },
      { root: el, rootMargin: `${RENDER_AHEAD_PX}px 0px` },
    );
    observerRef.current = observer;
    for (const slot of slotRefs.current.values()) observer.observe(slot);

    return () => {
      observer.disconnect();
      if (observerRef.current === observer) observerRef.current = null;
    };
    // scheduleRender/evictExcess are stable; the observer only needs (re)creation
    // when the document becomes ready. Slots added/removed later are handled by
    // register/unregisterSlot, not by re-running this effect.
  }, [status, scheduleRender, evictExcess]);

  // Fit-to-width: derive the scale from the viewport and page-1 width, and keep
  // it in sync as the panel resizes (only while Fit is engaged).
  React.useEffect(() => {
    const el = listRef.current;
    if (!el || !defaultSize || !fitWidth) return;
    const apply = () => {
      const avail = el.clientWidth - LIST_PADDING * 2;
      if (avail <= 0) return;
      const baseWidth = rotation % 180 !== 0 ? defaultSize.h : defaultSize.w;
      const next = clampScale(avail / baseWidth);
      setScale((prev) => (Math.abs(prev - next) > 0.001 ? next : prev));
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [defaultSize, fitWidth, status, rotation]);

  // Zoom or rotation changed: the cached canvases are now the wrong resolution
  // /orientation. Drop them (bumping the render sequence cancels in-flight work)
  // and repaint what's visible. Slot heights re-flow from scale/rotation in render.
  React.useEffect(() => {
    renderSeqRef.current += 1;
    for (const page of renderedRef.current.values()) disposeRendered(page);
    renderedRef.current.clear();
    renderingRef.current.clear();
    renderQueueRef.current.length = 0; // drop pages queued at the old scale/rotation
    for (const n of visibleRef.current) scheduleRender(n);
  }, [scale, rotation, scheduleRender]);

  const scrollToPage = React.useCallback((n: number) => {
    const list = listRef.current;
    const slot = slotRefs.current.get(n);
    if (!list || !slot) return;
    const listRect = list.getBoundingClientRect();
    const slotRect = slot.getBoundingClientRect();
    list.scrollTop += slotRect.top - listRect.top - LIST_PADDING;
  }, []);

  const goToDest = React.useCallback(
    async (dest: PdfOutlineItem["dest"]) => {
      const pdf = pdfRef.current;
      if (!pdf || !dest) return;
      try {
        const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
        if (!Array.isArray(explicit) || explicit.length === 0) return;
        const pageIndex = await pdf.getPageIndex(explicit[0] as Parameters<typeof pdf.getPageIndex>[0]);
        scrollToPage(pageIndex + 1);
      } catch {
        /* unresolved destination */
      }
    },
    [scrollToPage],
  );

  const jumpToPage = React.useCallback(() => {
    const parsed = Number.parseInt(pageInput.trim(), 10);
    if (!Number.isFinite(parsed)) return;
    scrollToPage(Math.max(1, Math.min(numPagesRef.current, parsed)));
  }, [pageInput, scrollToPage]);

  const zoomBy = React.useCallback((factor: number) => {
    setFitWidth(false);
    setScale((prev) => clampScale(prev * factor));
  }, []);

  const onListKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.target instanceof HTMLInputElement) return; // let the page/zoom inputs type
      const total = numPagesRef.current;
      if (e.ctrlKey || e.metaKey) {
        if (e.key === "=" || e.key === "+") {
          e.preventDefault();
          zoomBy(ZOOM_STEP);
        } else if (e.key === "-") {
          e.preventDefault();
          zoomBy(1 / ZOOM_STEP);
        } else if (e.key === "0") {
          e.preventDefault();
          setFitWidth(true);
        }
        return;
      }
      switch (e.key) {
        case "PageDown":
          e.preventDefault();
          scrollToPage(Math.min(total, currentPageRef.current + 1));
          break;
        case "PageUp":
          e.preventDefault();
          scrollToPage(Math.max(1, currentPageRef.current - 1));
          break;
        case "Home":
          e.preventDefault();
          scrollToPage(1);
          break;
        case "End":
          e.preventDefault();
          scrollToPage(total);
          break;
        default:
          break; // arrows / space fall through to native scrolling
      }
    },
    [scrollToPage, zoomBy],
  );

  const submitPassword = React.useCallback(() => {
    const resolve = passwordResolverRef.current;
    if (!resolve) return;
    setStatus("loading");
    resolve(passwordInput);
  }, [passwordInput]);

  if (status === "error") {
    return (
      <div className="fileViewerCenter">
        <div className="fileViewerTitle">Could not open PDF</div>
        <div className="fileViewerMuted" title={errorMsg ?? undefined}>
          {errorMsg ?? "The file could not be parsed as a PDF."}
        </div>
        <button type="button" className="btnSmall" onClick={onOpenBytes}>
          Open bytes
        </button>
      </div>
    );
  }

  if (status === "password") {
    return (
      <div className="fileViewerCenter">
        <div className="fileViewerTitle">Password required</div>
        <div className="fileViewerMuted">
          {passwordError ? "Incorrect password — try again." : "This PDF is encrypted."}
        </div>
        <input
          className="fileViewerInput"
          type="password"
          autoFocus
          value={passwordInput}
          onChange={(e) => setPasswordInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitPassword();
          }}
          placeholder="password"
        />
        <button type="button" className="btnSmall" onClick={submitPassword}>
          Unlock
        </button>
        <button type="button" className="btnSmall" onClick={onOpenBytes}>
          Open bytes
        </button>
      </div>
    );
  }

  if (status === "loading" || !defaultSize) {
    return (
      <div className="fileViewerCenter">
        <div className="fileViewerTitle">Loading PDF…</div>
        <div className="fileViewerMuted">Streaming pages on demand.</div>
      </div>
    );
  }

  return (
    <div className="pdfViewer">
      <div className="fileViewerToolbar">
        {outline ? (
          <button
            type="button"
            className={`btnSmall ${showOutline ? "pdfViewerFitActive" : ""}`}
            onClick={() => setShowOutline((v) => !v)}
            title="Outline"
            aria-label="Toggle outline"
          >
            ☰
          </button>
        ) : null}
        <span>
          Page {currentPage} / {numPages}
        </span>
        {renderError ? (
          <span className="fileViewerError" title={renderError}>
            {renderError}
          </span>
        ) : null}
        <input
          className="fileViewerInput"
          value={pageInput}
          onChange={(e) => setPageInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") jumpToPage();
          }}
          placeholder="page #"
        />
        <button type="button" className="btnSmall" onClick={jumpToPage}>
          Go
        </button>
        <span className="pdfViewerSpacer" />
        <button type="button" className="btnSmall" onClick={() => zoomBy(1 / ZOOM_STEP)} title="Zoom out" aria-label="Zoom out">
          −
        </button>
        <span className="pdfViewerZoom">{Math.round(scale * 100)}%</span>
        <button type="button" className="btnSmall" onClick={() => zoomBy(ZOOM_STEP)} title="Zoom in" aria-label="Zoom in">
          +
        </button>
        <button
          type="button"
          className={`btnSmall ${fitWidth ? "pdfViewerFitActive" : ""}`}
          onClick={() => setFitWidth((prev) => !prev)}
          title="Fit width"
        >
          Fit
        </button>
        <button
          type="button"
          className="btnSmall"
          onClick={() => setRotation((r) => (r + 90) % 360)}
          title="Rotate 90°"
          aria-label="Rotate 90 degrees"
        >
          ⟳
        </button>
        <button type="button" className="btnSmall" onClick={onOpenBytes}>
          Open bytes
        </button>
      </div>
      <div className="pdfViewerMain">
        {showOutline && outline ? (
          <aside className="pdfOutline" aria-label="Document outline">
            <PdfOutlineTree items={outline} onGo={(dest) => void goToDest(dest)} depth={0} />
          </aside>
        ) : null}
        <div
          className="pdfViewerList"
          ref={listRef}
          tabIndex={0}
          role="document"
          aria-label={`PDF, ${numPages} pages`}
          onKeyDown={onListKeyDown}
        >
          <div className="pdfViewerPages">
          {Array.from({ length: numPages }, (_, i) => {
            const n = i + 1;
            const sz = pageSizeRef.current.get(n) ?? defaultSize;
            const swap = rotation % 180 !== 0;
            return (
              <PageSlot
                key={n}
                pageNumber={n}
                width={Math.round((swap ? sz.h : sz.w) * scale)}
                height={Math.round((swap ? sz.w : sz.h) * scale)}
                register={registerSlot}
                unregister={unregisterSlot}
              />
            );
          })}
          </div>
        </div>
      </div>
    </div>
  );
}
