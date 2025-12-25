function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, "/");
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

export function shortenPathSmart(input: string, maxChars: number): string {
  const raw = input.trim();
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
  return `…${last.slice(-(maxChars - 1))}`;
}

