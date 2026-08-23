// PDF.js uses new collection/iterator APIs before every supported macOS
// WKWebView provides them. Missing methods abort rendering at runtime even
// though the production bundle compiles successfully. This module must be
// imported BEFORE PDF.js in EACH realm that runs it — the main thread (pdfEnv)
// and the worker (pdfWorker) — because they are separate JavaScript contexts
// with separate prototypes.

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

type IteratorPredicate<T> = (value: T, index: number) => unknown;

function getIteratorPrototype(): object | null {
  // %MapIteratorPrototype% inherits from the realm's shared
  // %IteratorPrototype%. Installing there covers Map/Set/Array iterators and
  // generator-backed helper results without modifying every concrete type.
  const mapIteratorPrototype = Object.getPrototypeOf(
    new Map().keys(),
  ) as object | null;
  return mapIteratorPrototype
    ? (Object.getPrototypeOf(mapIteratorPrototype) as object | null)
    : null;
}

function installIteratorHelpers(): void {
  const iteratorPrototype = getIteratorPrototype();
  if (!iteratorPrototype) return;

  if (typeof (iteratorPrototype as { filter?: unknown }).filter !== "function") {
    Object.defineProperty(iteratorPrototype, "filter", {
      value: function* <T>(
        this: Iterable<T>,
        predicate: IteratorPredicate<T>,
      ): Generator<T, void, undefined> {
        if (typeof predicate !== "function") {
          throw new TypeError("Iterator.prototype.filter requires a function");
        }
        let index = 0;
        for (const value of this) {
          if (predicate(value, index)) yield value;
          index += 1;
        }
      },
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  if (typeof (iteratorPrototype as { toArray?: unknown }).toArray !== "function") {
    Object.defineProperty(iteratorPrototype, "toArray", {
      value: function <T>(this: Iterable<T>): T[] {
        return Array.from(this);
      },
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}

installIteratorHelpers();
