function normalizeSeparators(path: string): string {
  // Backslash is a literal POSIX filename character. Normalize it only when
  // the input is unambiguously a Windows drive or UNC path.
  if (/^[A-Za-z]:\\/.test(path) || path.startsWith("\\\\")) {
    return path.replace(/\\/g, "/");
  }
  return path;
}

function replaceHome(path: string): string {
  const normalized = normalizeSeparators(path);
  const mac = normalized.match(/^\/Users\/[^/]+(\/.*)?$/);
  if (mac) return `~${mac[1] ?? ""}` || "~";
  const linux = normalized.match(/^\/home\/[^/]+(\/.*)?$/);
  if (linux) return `~${linux[1] ?? ""}` || "~";
  return normalized;
}

function joinSegments(segments: string[], leadingSlash: boolean): string {
  const joined = segments.join("/");
  if (!leadingSlash) return joined;
  return joined ? `/${joined}` : "/";
}

type GraphemeSegmenter = {
  segment(input: string): Iterable<{ segment: string }>;
};

type GraphemeSegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: "grapheme" },
) => GraphemeSegmenter;

function requiresFullGraphemeSegmentation(codePoint: number): boolean {
  // Printable ASCII is the only set whose one-code-point/one-grapheme
  // relationship is complete and stable without Unicode break tables.
  return codePoint < 0x20 || codePoint > 0x7e;
}

/**
 * Deterministic fallback for WebViews without Intl.Segmenter.
 *
 * Without the Unicode grapheme-break tables there is no sound heuristic for
 * every script (notably conjoining Hangul and Indic virama sequences). Plain
 * scalar values are safe to split by code point. If a string contains any code
 * point outside printable ASCII, treat the complete string as one unit: an old
 * WebView may show only an ellipsis, but it can never show a detached mark,
 * partial flag, Prepend fragment, or broken conjunct.
 */
function fallbackGraphemes(input: string): string[] {
  for (const character of input) {
    const codePoint = character.codePointAt(0)!;
    if (requiresFullGraphemeSegmentation(codePoint)) return [input];
  }
  return Array.from(input);
}

function graphemes(input: string): string[] {
  const Segmenter = (
    Intl as typeof Intl & { Segmenter?: GraphemeSegmenterConstructor }
  ).Segmenter;
  if (typeof Segmenter === "function") {
    return Array.from(
      new Segmenter(undefined, { granularity: "grapheme" }).segment(input),
      ({ segment }) => segment,
    );
  }

  return fallbackGraphemes(input);
}

function trailingTextWithinBudget(input: string, utf16Budget: number): string {
  if (utf16Budget <= 0) return "";

  const parts = graphemes(input);
  let used = 0;
  let start = parts.length;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const width = parts[index].length;
    if (used + width > utf16Budget) break;
    used += width;
    start = index;
  }
  return parts.slice(start).join("");
}

/** Encode one literal local filesystem path as a file URL without treating
 * valid `?` or `#` filename characters as URL query/fragment delimiters. */
export function localFileUrlForPath(path: string): string {
  const encodedPath = encodeURI(path).replace(/\?/g, "%3F").replace(/#/g, "%23");
  return `file://${encodedPath}`;
}

export function shortenPathSmart(input: string, maxChars: number): string {
  const raw = input;
  if (!raw) return "";

  const path = replaceHome(raw);
  if (path.length <= maxChars) return path;

  const leadingSlash = path.startsWith("/");
  const segments = path.split("/").filter(Boolean);

  if (segments.length === 0) return leadingSlash ? "/" : "";

  const hasPrefix = segments[0] === "~" || /^[A-Za-z]:$/.test(segments[0]);
  const prefix = hasPrefix ? segments[0] : null;
  const rest = segments.slice(prefix ? 1 : 0);

  const build = (tailCount: number): string => {
    const tail = rest.slice(-tailCount);
    const parts: string[] = [];
    if (prefix) parts.push(prefix);
    const needsEllipsis = rest.length > tailCount;
    if (needsEllipsis) parts.push("…");
    parts.push(...tail);
    return joinSegments(parts, leadingSlash && !prefix);
  };

  for (const n of [3, 2, 1]) {
    if (rest.length >= n) {
      const candidate = build(n);
      if (candidate.length <= maxChars) return candidate;
    }
  }

  const last = rest[rest.length - 1] ?? (prefix ?? "");
  if (last.length <= maxChars) return last;
  if (maxChars <= 1) return "…".slice(0, maxChars);
  return `…${trailingTextWithinBudget(last, maxChars - 1)}`;
}
