import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Icon } from "../components/Icon";
import {
  enqueueBrowserNativeOperation,
  isBrowserNativeViewClosing,
  invokeBrowserNativeCommand,
} from "./nativeViewLifecycle";

type BrowserNavEvent = { label: string; url: string; loading: boolean };

const NATIVE_VIEW_RETRY_DELAYS_MS = [50, 150, 400, 1_000] as const;
const CLEANUP_HIDE_FAST_ATTEMPTS = 12;
const ORPHAN_HIDE_RETRY_MS = 5_000;
let browserViewOwnerSequence = 0;
const browserViewOwners = new Map<string, number>();

function retryDelay(attempt: number): number {
  return NATIVE_VIEW_RETRY_DELAYS_MS[
    Math.min(attempt, NATIVE_VIEW_RETRY_DELAYS_MS.length - 1)
  ];
}

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
  const viewRef = React.useRef<HTMLDivElement | null>(null);
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const [urlInput, setUrlInput] = React.useState(initialUrl);
  const [loading, setLoading] = React.useState(false);
  const suppressedRef = React.useRef(suppressed);
  const initialUrlRef = React.useRef(initialUrl);
  React.useLayoutEffect(() => {
    suppressedRef.current = suppressed;
    initialUrlRef.current = initialUrl;
  }, [initialUrl, suppressed]);
  const editingRef = React.useRef(false);
  const onUrlChangeRef = React.useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;

  React.useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    let raf = 0;
    let cancelled = false;
    const owner = ++browserViewOwnerSequence;
    browserViewOwners.set(label, owner);
    let appliedVisible: boolean | null = null;
    let appliedKey = "";
    let operationInFlight = false;
    let retryAttempt = 0;
    let retryNotBefore = 0;
    let desiredSignature = "";
    let desiredVisible = false;
    let desiredKey = "";
    let recoveryPhase: "none" | "hiding" | "dwell" = "none";
    let recoveryTimer = 0;
    let unlistenRecovery: (() => void) | undefined;

    const resetRetry = () => {
      retryAttempt = 0;
      retryNotBefore = 0;
    };

    const scheduleRetry = (operation: "show" | "hide", error: unknown) => {
      const delay = retryDelay(retryAttempt);
      retryAttempt += 1;
      retryNotBefore = performance.now() + delay;
      if (retryAttempt <= NATIVE_VIEW_RETRY_DELAYS_MS.length) {
        console.warn(`[browser] Native ${operation} failed; retrying in ${delay}ms`, error);
      }
    };

    const beginRecoveryDwell = () => {
      if (cancelled || recoveryPhase !== "hiding") return;
      recoveryPhase = "dwell";
      if (recoveryTimer !== 0) window.clearTimeout(recoveryTimer);
      recoveryTimer = window.setTimeout(() => {
        recoveryTimer = 0;
        if (cancelled) return;
        recoveryPhase = "none";
        // Force a bounds/show call even if layout coordinates did not change.
        appliedKey = "";
        resetRetry();
      }, 60);
    };

    const runNativeOperation = (
      operation: "open" | "hide",
      args: Record<string, unknown>,
      key = "",
    ) => {
      operationInFlight = true;
      const result = enqueueBrowserNativeOperation(label, async (operationId) => {
        if (isBrowserNativeViewClosing(label)) return false;
        // An operation can wait behind another component instance or a previous
        // layout update. Drop it if the desired visibility changed meanwhile.
        if (operation === "open") {
          if (cancelled || !desiredVisible || desiredKey !== key) return false;
        } else if (!cancelled && desiredVisible) {
          return false;
        }
        await invokeBrowserNativeCommand(
          operation === "open" ? "browser_open" : "browser_hide",
          args,
          operationId,
        );
        return true;
      });

      void result.then((executed) => {
        if (!executed) return;
        resetRetry();
        if (operation === "open") {
          appliedVisible = true;
          appliedKey = key;
        } else {
          appliedVisible = false;
          appliedKey = "";
          beginRecoveryDwell();
        }
      }, (error) => {
        if (cancelled) return;
        const stillDesired = operation === "open"
          ? desiredVisible && desiredKey === key
          : !desiredVisible;
        if (stillDesired) scheduleRetry(operation === "open" ? "show" : "hide", error);
        else resetRetry();
      }).finally(() => {
        operationInFlight = false;
      });
    };

    // Native child WKWebView bounds are expressed in the current window/display
    // coordinate space. A display wake can invalidate that mapping even when
    // the DOM rectangle itself is unchanged. Pulse through the same serialized
    // state machine as tab/modal visibility so stale completions cannot win.
    void listen("system-resumed", () => {
      if (cancelled || suppressedRef.current || isBrowserNativeViewClosing(label)) return;
      recoveryPhase = "hiding";
      desiredVisible = false;
      desiredKey = "";
      if (recoveryTimer !== 0) {
        window.clearTimeout(recoveryTimer);
        recoveryTimer = 0;
      }
      appliedKey = "";
      resetRetry();
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else unlistenRecovery = unlisten;
    }).catch((error) => {
      console.warn("[browser] Failed to register display-recovery listener", error);
    });

    const tick = () => {
      if (cancelled) return;
      if (isBrowserNativeViewClosing(label)) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const r = el.getBoundingClientRect();
      const hasUsableBounds = r.width > 0 && r.height > 0;
      const viewRect = hasUsableBounds ? viewRef.current?.getBoundingClientRect() ?? null : null;
      const yOffset = viewRect ? Math.max(0, Math.round(r.top - viewRect.top)) : 0;
      const key = hasUsableBounds
        ? `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)},${yOffset},${window.devicePixelRatio.toFixed(4)}`
        : "";
      const wantsHidden = suppressedRef.current || recoveryPhase !== "none" || !hasUsableBounds;
      desiredVisible = !wantsHidden;
      desiredKey = desiredVisible ? key : "";
      const nextSignature = wantsHidden
        ? `hidden:${suppressedRef.current}:${recoveryPhase}:${hasUsableBounds}`
        : `visible:${key}`;
      if (nextSignature !== desiredSignature) {
        desiredSignature = nextSignature;
        resetRetry();
      }

      if (!operationInFlight && performance.now() >= retryNotBefore) {
        if (wantsHidden) {
          if (appliedVisible !== false) {
            runNativeOperation("hide", { label });
          } else {
            beginRecoveryDwell();
          }
        } else if (appliedVisible !== true || appliedKey !== key) {
          // browser_open creates the webview the first time and repositions +
          // shows the same view afterwards, preserving page and form state.
          runNativeOperation("open", {
            label,
            url: initialUrlRef.current,
            x: r.left,
            y: r.top,
            width: r.width,
            height: r.height,
            yOffset,
          }, key);
        }
      }
      raf = requestAnimationFrame(tick);
    };

    const retryCleanupHide = (attempt: number) => {
      if (
        browserViewOwners.get(label) !== owner
        || isBrowserNativeViewClosing(label)
      ) return;
      const result = enqueueBrowserNativeOperation(label, async (operationId) => {
        if (
          browserViewOwners.get(label) !== owner
          || isBrowserNativeViewClosing(label)
        ) return false;
        await invokeBrowserNativeCommand("browser_hide", { label }, operationId);
        return true;
      });

      void result.then((executed) => {
        if (executed && browserViewOwners.get(label) === owner) {
          browserViewOwners.delete(label);
        }
      }, (error) => {
        // A newer owner is responsible for its own current intent. Otherwise
        // keep one low-rate retry alive so an unmounted child can never become
        // a permanent ownerless overlay after WindowServer recovers.
        if (
          browserViewOwners.get(label) !== owner
          || isBrowserNativeViewClosing(label)
        ) return;
        const nextAttempt = attempt + 1;
        if (nextAttempt === CLEANUP_HIDE_FAST_ATTEMPTS) {
          console.warn(
            `[browser] Native cleanup hide still failing; continuing every ${ORPHAN_HIDE_RETRY_MS}ms`,
            error,
          );
        }
        const delay = nextAttempt < CLEANUP_HIDE_FAST_ATTEMPTS
          ? retryDelay(attempt)
          : ORPHAN_HIDE_RETRY_MS;
        window.setTimeout(() => retryCleanupHide(nextAttempt), delay);
      });
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (recoveryTimer !== 0) window.clearTimeout(recoveryTimer);
      unlistenRecovery?.();
      // Queue the final native hide behind every prior operation for this label.
      // Owner-aware retries prevent an obsolete component from hiding a newer
      // instance while ensuring a transient failure cannot orphan an overlay.
      if (isBrowserNativeViewClosing(label)) {
        if (browserViewOwners.get(label) === owner) browserViewOwners.delete(label);
        return;
      }
      retryCleanupHide(0);
    };
  }, [label]);

  React.useEffect(() => {
    let cancelled = false;
    let un: (() => void) | undefined;
    void listen<BrowserNavEvent>("browser://event", (e) => {
      if (cancelled) return;
      if (e.payload.label !== label) return;
      setLoading(e.payload.loading);
      onUrlChangeRef.current(e.payload.url);
      if (!editingRef.current) setUrlInput(e.payload.url);
    }).then((f) => {
      if (cancelled) f();
      else un = f;
    }).catch((error) => {
      console.warn("[browser] Failed to register browser event listener", error);
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [label]);

  const navigate = (url: string) => {
    const trimmed = url.trim();
    if (trimmed) void invoke("browser_navigate", { label, url: trimmed });
  };
  const action = (a: "back" | "forward" | "reload") => void invoke("browser_action", { label, action: a });

  return (
    <div className="browserView" ref={viewRef}>
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
