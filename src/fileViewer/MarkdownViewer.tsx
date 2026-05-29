import React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { concatBytes } from "./bytes";
import type { ReadRangeFn } from "./useChunkCache";

const MAX_MARKDOWN_BYTES = 8 * 1024 * 1024;
const CHUNK = 256 * 1024;

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
        const parts: Uint8Array[] = [];
        for (let offset = 0; offset < size; offset += CHUNK) {
          const reqLen = Math.min(CHUNK, size - offset);
          const chunk = await readRange(path, offset, reqLen);
          if (cancelled) return;
          parts.push(chunk);
          if (chunk.length === 0 || chunk.length < reqLen) break;
        }
        if (cancelled) return;
        setText(new TextDecoder("utf-8").decode(concatBytes(parts)));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, readRange, size]);

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
        <button type="button" className="btnSmall" onClick={onOpenBytes}>
          Open bytes
        </button>
      </div>
      <div className="markdownViewerBody">
        <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
      </div>
    </div>
  );
}
