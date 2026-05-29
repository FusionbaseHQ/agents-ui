import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Icon } from "../components/Icon";

type BrowserNavEvent = { label: string; url: string; loading: boolean };

// A browser tab. The actual page is a native child WKWebView (managed in Rust);
// this component is the chrome (URL bar + nav) plus a viewport placeholder whose
// on-screen rect the native webview is kept aligned to. The rect is polled on a
// rAF loop but an IPC bounds update is sent only when it actually changes, so an
// idle browser tab costs nothing on the wire.
export default function BrowserView({
  label,
  initialUrl,
  suppressed,
  onUrlChange,
}: {
  label: string;
  initialUrl: string;
  suppressed: boolean;
  onUrlChange: (url: string) => void;
}) {
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const [urlInput, setUrlInput] = React.useState(initialUrl);
  const [loading, setLoading] = React.useState(false);
  const suppressedRef = React.useRef(suppressed);
  suppressedRef.current = suppressed;
  const editingRef = React.useRef(false);
  const onUrlChangeRef = React.useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;

  React.useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    let raf = 0;
    let cancelled = false;
    let lastKey = "";
    let parked = false;
    const tick = () => {
      if (cancelled) return;
      if (suppressedRef.current) {
        if (!parked) {
          parked = true;
          lastKey = "";
          void invoke("browser_hide", { label });
        }
      } else {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
          if (key !== lastKey) {
            lastKey = key;
            parked = false;
            // browser_open creates the webview the first time and just repositions
            // (keeping the current page) afterwards.
            void invoke("browser_open", { label, url: initialUrl, x: r.left, y: r.top, width: r.width, height: r.height });
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      void invoke("browser_hide", { label });
    };
  }, [label, initialUrl]);

  React.useEffect(() => {
    let un: (() => void) | undefined;
    void listen<BrowserNavEvent>("browser://event", (e) => {
      if (e.payload.label !== label) return;
      setLoading(e.payload.loading);
      onUrlChangeRef.current(e.payload.url);
      if (!editingRef.current) setUrlInput(e.payload.url);
    }).then((f) => {
      un = f;
    });
    return () => un?.();
  }, [label]);

  const navigate = (url: string) => {
    const trimmed = url.trim();
    if (trimmed) void invoke("browser_navigate", { label, url: trimmed });
  };
  const action = (a: "back" | "forward" | "reload") => void invoke("browser_action", { label, action: a });

  return (
    <div className="browserView">
      <div className="fileViewerToolbar browserBar">
        <button
          type="button"
          className="btnSmall btnIcon browserNavBtn"
          onClick={() => action("back")}
          title="Back"
          aria-label="Back"
        >
          <Icon name="chevron-left" size={16} />
        </button>
        <button
          type="button"
          className="btnSmall btnIcon browserNavBtn"
          onClick={() => action("forward")}
          title="Forward"
          aria-label="Forward"
        >
          <Icon name="chevron-right" size={16} />
        </button>
        <button
          type="button"
          className="btnSmall btnIcon browserNavBtn"
          onClick={() => action("reload")}
          title="Reload"
          aria-label="Reload"
        >
          <Icon name="refresh" size={15} />
        </button>
        <input
          className="fileViewerInput browserUrl"
          value={urlInput}
          spellCheck={false}
          onFocus={(e) => {
            editingRef.current = true;
            e.currentTarget.select();
          }}
          onBlur={() => {
            editingRef.current = false;
          }}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
              navigate(urlInput);
            }
          }}
          placeholder="Search or enter a URL"
        />
        {loading ? <span className="browserSpinner" aria-label="Loading" /> : null}
      </div>
      <div className="browserViewport" ref={viewportRef} />
    </div>
  );
}
