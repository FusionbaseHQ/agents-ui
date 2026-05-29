// PDF.js v5 calls `Map.prototype.getOrInsertComputed` (the TC39 "upsert"
// proposal). V8/Blink shipped it, but JavaScriptCore — the engine in the macOS
// WKWebView that Tauri runs on — has not yet, so the call is `undefined` and
// PDF.js throws `TypeError: ...getOrInsertComputed is not a function`, aborting
// every page render (blank white pages). PDF.js bundles no fallback, so we add
// one. This module must be imported BEFORE PDF.js in EACH realm that runs it —
// the main thread (pdfEnv) and the worker (pdfWorker) — because they are
// separate JS contexts with separate prototypes.

type ComputeFn<K, V> = (key: K) => V;

function install(proto: { has(key: unknown): boolean; get(key: unknown): unknown; set(key: unknown, value: unknown): unknown }): void {
  if (typeof (proto as { getOrInsertComputed?: unknown }).getOrInsertComputed === "function") return;
  Object.defineProperty(proto, "getOrInsertComputed", {
    value: function <K, V>(this: { has(k: K): boolean; get(k: K): V; set(k: K, v: V): unknown }, key: K, callbackfn: ComputeFn<K, V>): V {
      if (this.has(key)) return this.get(key);
      const value = callbackfn(key);
      this.set(key, value);
      return value;
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

install(Map.prototype as never);
install(WeakMap.prototype as never);
