import { invoke } from "@tauri-apps/api/core";
import type { IBufferLine, ILink, ILinkHandler, Terminal } from "xterm";

/**
 * Clickable URLs in terminals.
 *
 * - ⌘-click (Ctrl-click elsewhere) opens the URL in the app's browser tab.
 * - ⌘⇧-click opens it in the OS default browser.
 * - A plain click keeps normal selection behavior; hovering shows a hint.
 *
 * Detection is a custom link provider rather than the web-links addon so it
 * can follow URLs that coding agents' TUIs hard-wrap at the terminal width
 * (real newlines, not xterm soft wraps). OSC 8 hyperlinks use the same
 * handler via the terminal's `linkHandler` option.
 */

export type UrlOpenTarget = "internal" | "external";
type UrlOpener = (url: string, target: UrlOpenTarget) => void;

let urlOpener: UrlOpener | null = null;

/** App-level hook that decides where a URL opens. Returns an unregister function. */
export function setTerminalUrlOpener(opener: UrlOpener): () => void {
  urlOpener = opener;
  return () => {
    if (urlOpener === opener) urlOpener = null;
  };
}

/** Only web URLs are ever opened from terminal output. */
export function normalizeOpenableUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function openUrlInDefaultBrowser(url: string): Promise<void> {
  const safe = normalizeOpenableUrl(url);
  if (!safe) throw new Error("only http(s) links can be opened");
  await invoke("plugin:shell|open", { path: safe });
}

function isOpenModifier(event: MouseEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

function openFromTerminal(event: MouseEvent, raw: string): void {
  hideLinkHint();
  if (!isOpenModifier(event)) return;
  const url = normalizeOpenableUrl(raw);
  if (!url) return;
  event.preventDefault();
  const target: UrlOpenTarget = event.shiftKey ? "external" : "internal";
  if (urlOpener) {
    urlOpener(url, target);
  } else {
    void openUrlInDefaultBrowser(url).catch((err) => console.warn("[links] open failed", err));
  }
}

// --- hover hint --------------------------------------------------------------

let hintEl: HTMLDivElement | null = null;

function showLinkHint(event: MouseEvent, url: string): void {
  if (!normalizeOpenableUrl(url)) return;
  if (!hintEl) {
    hintEl = document.createElement("div");
    hintEl.className = "terminalLinkHint";
    hintEl.setAttribute("role", "tooltip");
    document.body.appendChild(hintEl);
  }
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = mac ? "⌘" : "Ctrl";
  const shift = mac ? "⇧" : "Shift+";
  hintEl.textContent = `${mod}-click to open · ${mod}${shift}-click for default browser`;
  hintEl.hidden = false;
  const { innerWidth, innerHeight } = window;
  const rect = hintEl.getBoundingClientRect();
  const left = Math.min(event.clientX + 12, innerWidth - rect.width - 8);
  const top =
    event.clientY + 20 + rect.height > innerHeight ? event.clientY - rect.height - 10 : event.clientY + 20;
  hintEl.style.left = `${Math.max(8, left)}px`;
  hintEl.style.top = `${Math.max(8, top)}px`;
}

export function hideLinkHint(): void {
  if (hintEl) hintEl.hidden = true;
}

/** OSC 8 hyperlinks (`\e]8;;URL\e\\text\e]8;;\e\\`). */
export const terminalOsc8LinkHandler: ILinkHandler = {
  activate: (event, text) => openFromTerminal(event, text),
  hover: (event, text) => showLinkHint(event, text),
  leave: () => hideLinkHint(),
  allowNonHttpProtocols: false,
};

// --- detection -----------------------------------------------------------------

// Characters that may appear inside a URL: RFC 3986 plus unencoded Unicode
// letters/digits (IDN hosts, localized paths). Excludes whitespace, quotes,
// angle brackets and backticks.
const URL_CHARS = "A-Za-z0-9\\-._~:/?#[\\]@!$&'()*+,;=%\\p{L}\\p{N}\\p{M}";
const URL_CHAR = new RegExp(`[${URL_CHARS}]`, "u");
const URL_ONLY = new RegExp(`^[${URL_CHARS}]+$`, "u");
const URL_RE = new RegExp(`https?://[${URL_CHARS}]+`, "gu");
const MAX_JOINED_ROWS = 24;

/** Drop trailing sentence punctuation and unbalanced closing brackets. */
export function trimUrlMatch(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url[url.length - 1];
    if (!last) return url;
    if (".,;:!?'*".includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    const pairs: Record<string, string> = { ")": "(", "]": "[" };
    const open = pairs[last];
    if (open) {
      const opens = url.split(open).length - 1;
      const closes = url.split(last).length - 1;
      if (closes > opens) {
        url = url.slice(0, -1);
        continue;
      }
    }
    return url;
  }
}

/** Find URLs in plain text; returns [start, end) UTF-16 offsets. */
export function findUrls(text: string): Array<{ url: string; start: number; end: number }> {
  const out: Array<{ url: string; start: number; end: number }> = [];
  URL_RE.lastIndex = 0;
  for (let match = URL_RE.exec(text); match; match = URL_RE.exec(text)) {
    const url = trimUrlMatch(match[0]);
    if (url.length > "https://".length && normalizeOpenableUrl(url)) {
      out.push({ url, start: match.index, end: match.index + url.length });
    }
  }
  return out;
}

type CellPos = { x: number; y: number; width: number };
type RowText = { text: string; pos: CellPos[] };

/** Row text plus the buffer cell of every UTF-16 unit (wide chars take 2 cells). */
function readRow(line: IBufferLine, y: number, cols: number): RowText {
  let text = "";
  const pos: CellPos[] = [];
  for (let x = 0; x < cols; x += 1) {
    const cell = line.getCell(x);
    if (!cell) break;
    if (cell.getWidth() === 0) continue; // trailing half of a wide char
    const chars = cell.getChars() || " ";
    const width = Math.max(1, cell.getWidth());
    for (let i = 0; i < chars.length; i += 1) pos.push({ x, y, width });
    text += chars;
  }
  return { text, pos };
}

function lastCellChar(line: IBufferLine, cols: number): string {
  return line.getCell(cols - 1)?.getChars() ?? "";
}

function firstCellChar(line: IBufferLine): string {
  return line.getCell(0)?.getChars() ?? "";
}

function tailToken(text: string): string {
  const match = /\S+$/.exec(text.replace(/\s+$/, ""));
  return match ? match[0] : "";
}

/**
 * Whether row `next` continues a URL from row `prev` although it is not an
 * xterm soft wrap: `prev` is filled to the last column with URL characters
 * whose trailing token is (part of) a URL, and `next` starts at column 0 with
 * URL characters. This is how agent TUIs print long URLs.
 */
function isHardWrappedUrlContinuation(
  prev: IBufferLine,
  next: IBufferLine,
  cols: number,
  prevTail: string,
): boolean {
  const last = lastCellChar(prev, cols);
  const first = firstCellChar(next);
  if (!last || !first || !URL_CHAR.test(last) || !URL_CHAR.test(first)) return false;
  if (!prevTail.includes("://") && !URL_ONLY.test(prevTail)) return false;
  return prevTail.length > 0;
}

function joinsPrevious(buffer: Terminal["buffer"]["active"], row: number, cols: number): boolean {
  const line = buffer.getLine(row);
  const prev = buffer.getLine(row - 1);
  if (!line || !prev) return false;
  if (line.isWrapped) return true;
  const prevTail = tailToken(prev.translateToString(true));
  return prevTail.includes("://") || isUrlBodyRow(prev, cols)
    ? isHardWrappedUrlContinuation(prev, line, cols, prevTail)
    : false;
}

/** A row that is entirely URL characters edge to edge (middle of a very long URL). */
function isUrlBodyRow(line: IBufferLine, cols: number): boolean {
  const text = line.translateToString(false);
  return text.length >= cols && URL_ONLY.test(text.slice(0, cols));
}

export function createTerminalUrlLinkProvider(term: Terminal) {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) {
      const buffer = term.buffer.active;
      const cols = term.cols;
      const row = bufferLineNumber - 1;
      if (!buffer.getLine(row)) {
        callback(undefined);
        return;
      }

      // Collect the logical line (soft wraps + hard-wrapped URL continuations).
      let start = row;
      while (start > 0 && row - start < MAX_JOINED_ROWS && joinsPrevious(buffer, start, cols)) start -= 1;
      let end = row;
      while (end - start < MAX_JOINED_ROWS && buffer.getLine(end + 1) && joinsPrevious(buffer, end + 1, cols)) {
        end += 1;
      }

      let text = "";
      const pos: CellPos[] = [];
      for (let y = start; y <= end; y += 1) {
        const line = buffer.getLine(y);
        if (!line) break;
        const rowText = readRow(line, y, cols);
        text += rowText.text;
        pos.push(...rowText.pos);
      }

      const links: ILink[] = [];
      for (const found of findUrls(text)) {
        const first = pos[found.start];
        const last = pos[found.end - 1];
        if (!first || !last) continue;
        // Report each link only from rows it covers, as xterm expects.
        if (row < first.y || row > last.y) continue;
        links.push({
          range: {
            start: { x: first.x + 1, y: first.y + 1 },
            // Inclusive end: cover both cells of a trailing wide character.
            end: { x: last.x + last.width, y: last.y + 1 },
          },
          text: found.url,
          decorations: { underline: true, pointerCursor: true },
          activate: (event, url) => openFromTerminal(event, url),
          hover: (event, url) => showLinkHint(event, url),
          leave: () => hideLinkHint(),
        });
      }
      callback(links.length ? links : undefined);
    },
  };
}
