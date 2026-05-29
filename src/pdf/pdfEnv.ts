import "./pdfPolyfills"; // must run before pdfjs-dist on the main thread
import * as pdfjsLib from "pdfjs-dist";
// Custom worker entry that also installs the polyfill in the worker realm.
import PdfWorkerCtor from "./pdfWorker?worker";

type PdfWorker = InstanceType<typeof pdfjsLib.PDFWorker>;

// One long-lived worker, reused across every document load and passed to
// getDocument as an *explicit* worker. Because PDF.js only owns (and destroys)
// workers it creates itself, an explicit worker survives loadingTask.destroy(),
// so it can be shared safely. The PDF panel only ever mounts one document at a
// time, so a single worker is enough.
//
// We deliberately do NOT use GlobalWorkerOptions.workerPort: there PDF.js owns
// the shared worker, and the first loadingTask.destroy() tears it down + evicts
// its port from the internal cache, so the next load (or a React StrictMode
// remount, which is why this surfaced on slower SSH reads) throws
// "PDFWorker.create - the worker is being destroyed".
//
// The worker is bundled by Vite via ?worker (same pattern as the Monaco workers
// in ../monaco/monacoEnv), so it loads from the app origin and satisfies the
// strict `script-src 'self'` CSP — a CDN/blob worker would be blocked.
let sharedWorker: PdfWorker | null = null;

export function getPdfWorker(): PdfWorker {
  if (!sharedWorker || sharedWorker.destroyed) {
    // pdfjs-dist's generated d.ts mistypes the `port` option as `null`; it
    // accepts a Worker (the same value GlobalWorkerOptions.workerPort takes).
    sharedWorker = new pdfjsLib.PDFWorker({ port: new PdfWorkerCtor() as unknown as null });
  }
  return sharedWorker;
}

// CMaps (CID fonts), the standard 14 fonts, ICC profiles, and the wasm modules
// (image decoders, colour management, and the QuickJS engine PDF.js v5 uses in
// place of CSP-blocked JS eval) are all fetched at runtime. The CSP forbids
// cross-origin loads, so they are served from /pdfjs/* (copied out of
// node_modules by vite.config.ts) addressed relative to the document base so
// dev and the bundled app both resolve. PDF.js auto-detects that native eval is
// blocked and routes through the wasm engine instead — no eval flag needed.
const assetBase = new URL("pdfjs/", document.baseURI);

const COMMON_OPTIONS = {
  cMapUrl: new URL("cmaps/", assetBase).href,
  cMapPacked: true,
  standardFontDataUrl: new URL("standard_fonts/", assetBase).href,
  iccUrl: new URL("iccs/", assetBase).href,
  wasmUrl: new URL("wasm/", assetBase).href,
  // Render glyphs as canvas vector paths instead of loading fonts via the Font
  // Loading API / @font-face. Under the strict CSP (no `font-src` for data:/blob:
  // sources) the FontFace path throws inside the system WebView, which aborts the
  // whole page render and leaves blank white pages. Path rendering needs no font
  // fetch and is CSP-proof; non-embedded fonts still use the bundled outlines.
  disableFontFace: true,
  // Use a hardware-accelerated 2D canvas. PDF.js's default is a software canvas
  // (`willReadFrequently: true`), which renders blank in the macOS WebKit
  // (WKWebView) Tauri runs on — the same config renders correctly in Blink.
  enableHWA: true,
  verbosity: 0,
} as const;

export function pdfDocumentOptions() {
  return { ...COMMON_OPTIONS };
}

export { pdfjsLib };
export type { PdfWorker };
