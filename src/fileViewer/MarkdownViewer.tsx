import React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { readAllText } from "./readText";
import type { ReadRangeFn } from "./useChunkCache";

const MAX_MARKDOWN_BYTES = 8 * 1024 * 1024;

type MarkdownHeading = {
  level: number;
  text: string;
  id: string;
};

function headingId(text: string, seen: Map<string, number>): string {
  const base = text
    .toLowerCase()
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

function markdownHeadings(text: string): MarkdownHeading[] {
  const seen = new Map<string, number>();
  const out: MarkdownHeading[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(#{1,3})\s+(.+?)\s*#*$/.exec(line.trim());
    if (!match) continue;
    const title = match[2].replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`]/g, "").trim();
    if (!title) continue;
    out.push({ level: match[1].length, text: title, id: headingId(title, seen) });
  }
  return out;
}

// Rendered Markdown preview. react-markdown does not render raw HTML by default
// (no rehype-raw), so this is safe under the app CSP. Opened on demand via the
// "View as → Markdown" switch; the editable text view remains the default.
export default function MarkdownViewer({
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
  const [text, setText] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const headings = React.useMemo(() => (text == null ? [] : markdownHeadings(text)), [text]);

  React.useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);
    if (size > MAX_MARKDOWN_BYTES) {
      setError("File is too large to preview.");
      return;
    }
    void (async () => {
      try {
        const value = await readAllText(readRange, path, size, () => cancelled);
        if (cancelled) return;
        setText(value);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, readRange, size]);

  React.useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const rendered = Array.from(body.querySelectorAll<HTMLHeadingElement>("h1, h2, h3"));
    for (let i = 0; i < rendered.length && i < headings.length; i++) {
      rendered[i].id = headings[i].id;
    }
  }, [headings]);

  if (error) {
    return (
      <div className="fileViewerCenter">
        <div className="fileViewerTitle">Markdown preview unavailable</div>
        <div className="fileViewerMuted" title={error}>
          {error}
        </div>
        <button type="button" className="btnSmall" onClick={onOpenBytes}>
          Open bytes
        </button>
      </div>
    );
  }

  if (text == null) {
    return (
      <div className="fileViewerCenter">
        <div className="fileViewerTitle">Loading…</div>
      </div>
    );
  }

  return (
    <div className="markdownViewer">
      <div className="fileViewerToolbar">
        <span>Markdown preview</span>
        <span className="pdfViewerSpacer" />
        <button
          type="button"
          className="btnSmall"
          onClick={() => {
            if (!navigator.clipboard) return;
            void navigator.clipboard.writeText(text).catch(() => {});
          }}
        >
          Copy source
        </button>
        <button type="button" className="btnSmall" onClick={onOpenBytes}>
          Open bytes
        </button>
      </div>
      <div className="markdownViewerContent">
        {headings.length ? (
          <nav className="markdownViewerToc" aria-label="Markdown table of contents">
            {headings.map((heading) => (
              <button
                key={heading.id}
                type="button"
                className={`markdownViewerTocItem markdownViewerTocItem-${heading.level}`}
                onClick={() => bodyRef.current?.querySelector(`#${CSS.escape(heading.id)}`)?.scrollIntoView({ block: "start" })}
                title={heading.text}
              >
                {heading.text}
              </button>
            ))}
          </nav>
        ) : null}
        <div className="markdownViewerBody" ref={bodyRef}>
          <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
        </div>
      </div>
    </div>
  );
}
