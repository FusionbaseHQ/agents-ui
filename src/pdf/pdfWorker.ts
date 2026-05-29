// Worker entry: install the getOrInsertComputed polyfill in the worker realm
// FIRST (import order is guaranteed), then run PDF.js's actual worker. Used via
// `./pdfWorker?worker` so the bundled worker has the polyfill the WKWebView
// engine lacks. See pdfPolyfills.ts.
import "./pdfPolyfills";
import "pdfjs-dist/build/pdf.worker.min.mjs";
