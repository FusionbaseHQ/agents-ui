import { invoke } from "@tauri-apps/api/core";
import React, { useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import type { PendingDataBuffer } from "./App";

export type TerminalRegistry = Map<string, { term: Terminal; fit: FitAddon }>;

type RenderDimension = { width: number; height: number };
type RenderDimensionsFallback = {
  css: { canvas: RenderDimension; cell: RenderDimension };
  device: {
    canvas: RenderDimension;
    cell: RenderDimension;
    char: { width: number; height: number; left: number; top: number };
  };
};

function createEmptyRenderDimensions(): RenderDimensionsFallback {
  const dim = (): RenderDimension => ({ width: 0, height: 0 });
  return {
    css: { canvas: dim(), cell: dim() },
    device: { canvas: dim(), cell: dim(), char: { width: 0, height: 0, left: 0, top: 0 } },
  };
}

function patchXtermRenderServiceDimensions(term: Terminal): void {
  try {
    const core = (term as unknown as { _core?: any })._core;
    const renderService = core?._renderService;
    if (!renderService) return;
    if (renderService.__agentsUiSafeDimensions) return;

    const fallback = createEmptyRenderDimensions();
    Object.defineProperty(renderService, "dimensions", {
      configurable: true,
      enumerable: true,
      get: () => {
        const rendererRef = renderService?._renderer;
        const renderer = rendererRef?.value ?? rendererRef?._value ?? null;
        return renderer?.dimensions ?? fallback;
      },
    });

    renderService.__agentsUiSafeDimensions = true;
  } catch {
    // ignore
  }
}

function isXtermRendererReady(term: Terminal): boolean {
  const core = (term as unknown as { _core?: any })._core;
  const renderService = core?._renderService;
  const rendererRef = renderService?._renderer;
  const renderer = rendererRef?.value ?? rendererRef?._value ?? null;
  return Boolean(renderer && renderer.dimensions);
}

async function copyToClipboard(text: string): Promise<boolean> {
  const value = text ?? "";
  if (!value) return false;

  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // fall through
  }

  try {
    const el = document.createElement("textarea");
    el.value = value;
    el.setAttribute("readonly", "true");
    el.style.position = "fixed";
    el.style.left = "-9999px";
    el.style.top = "0";
    document.body.appendChild(el);
    el.focus();
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

export default function SessionTerminal(props: {
  id: string;
  active: boolean;
  readOnly: boolean;
  persistent?: boolean;
  onCwdChange?: (id: string, cwd: string) => void;
  onCommandChange?: (id: string, commandLine: string, source?: "osc" | "input") => void;
  onResize?: (id: string, size: { cols: number; rows: number }) => void;
  onUserEnter?: (id: string) => void;
  registry: React.MutableRefObject<TerminalRegistry>;
  pendingData: React.MutableRefObject<PendingDataBuffer>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const resizeRafRef = useRef<number | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const zellijAutoScrollRef = useRef<{
    active: boolean;
    wheelRemainder: number;
  }>({ active: false, wheelRemainder: 0 });
  const commandBufferRef = useRef<string>("");

  useEffect(() => {
    if (!containerRef.current) return;
    if (termRef.current) return;

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      disableStdin: props.readOnly,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 13,
      theme: {
        background: "#0a0e16",
        foreground: "#f0f4f8",
        cursor: "#6b8afd",
        selectionBackground: "rgba(34,211,238,0.25)",
      },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    patchXtermRenderServiceDimensions(term);

    if (props.persistent) {
      const sendZellij = (data: string) =>
        invoke("write_to_session", { id: props.id, data, source: "ui" }).catch(() => {});

      const skipEscapeSequence = (data: string, start: number): number => {
        const next = data[start];
        if (!next) return start;
        if (next === "[") {
          let i = start + 1;
          while (i < data.length) {
            const ch = data[i];
            if (ch >= "@" && ch <= "~") return i + 1;
            i += 1;
          }
          return i;
        }
        if (next === "]") {
          let i = start + 1;
          while (i < data.length) {
            const ch = data[i];
            if (ch === "\u0007") return i + 1;
            if (ch === "\u001b" && data[i + 1] === "\\") return i + 2;
            i += 1;
          }
          return i;
        }
        if (next === "P" || next === "^" || next === "_") {
          let i = start + 1;
          while (i < data.length) {
            if (data[i] === "\u001b" && data[i + 1] === "\\") return i + 2;
            i += 1;
          }
          return i;
        }
        return start + 1;
      };

      const ingestUserInputForCommandDetection = (data: string) => {
        let buffer = commandBufferRef.current;
        const submitted: string[] = [];

        let i = 0;
        while (i < data.length) {
          const ch = data[i];
          if (ch === "\r") {
            if (data[i + 1] === "\n") i += 1;
            submitted.push(buffer);
            buffer = "";
            i += 1;
            continue;
          }
          if (ch === "\n") {
            submitted.push(buffer);
            buffer = "";
            i += 1;
            continue;
          }
          if (ch === "\u007f" || ch === "\b") {
            buffer = buffer.slice(0, -1);
            i += 1;
            continue;
          }
          if (ch === "\u0015") {
            buffer = "";
            i += 1;
            continue;
          }
          if (ch === "\u001b") {
            i = skipEscapeSequence(data, i + 1);
            continue;
          }
          if (ch < " " || ch === "\u007f") {
            i += 1;
            continue;
          }
          buffer += ch;
          i += 1;
        }

        commandBufferRef.current = buffer;

        for (const line of submitted) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          props.onCommandChange?.(props.id, trimmed, "input");
        }
      };

      const ensureZellijScrollModePrefix = () => {
        const state = zellijAutoScrollRef.current;
        if (state.active) return "";
        state.active = true;
        return "\x13"; // Ctrl+s => zellij scroll mode
      };

      const scrollZellijLines = (lines: number) => {
        const count = Math.min(Math.abs(lines), 120);
        if (count === 0) return;
        if (lines > 0 && !zellijAutoScrollRef.current.active) return;
        const prefix = ensureZellijScrollModePrefix();
        const step = lines < 0 ? "k" : "j";
        void sendZellij(`${prefix}${step.repeat(count)}`);
      };

      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") return true;
        const key = event.key;
        const isCopy =
          (event.metaKey || (event.ctrlKey && event.shiftKey)) &&
          !event.altKey &&
          key.toLowerCase() === "c";
        if (isCopy && term.hasSelection()) {
          void copyToClipboard(term.getSelection());
          return false;
        }
        const isPageUp = key === "PageUp";
        const isPageDown = key === "PageDown";
        const isHome = key === "Home";
        const isEnd = key === "End";
        const isUp = key === "ArrowUp";
        const isDown = key === "ArrowDown";

        if (event.shiftKey && isPageUp) {
          scrollZellijLines(-term.rows);
          return false;
        }
        if (event.shiftKey && isPageDown) {
          scrollZellijLines(term.rows);
          return false;
        }
        if (event.metaKey && isUp) {
          scrollZellijLines(-term.rows);
          return false;
        }
        if (event.metaKey && isDown) {
          scrollZellijLines(term.rows);
          return false;
        }

        if ((event.shiftKey || event.metaKey) && (isHome || isEnd)) {
          // Not supported in zellij defaults; keep default behavior.
          return true;
        }

        return true;
      });
      term.onData((data) => {
        const state = zellijAutoScrollRef.current;
        if (state.active) {
          state.active = false;
          if (data === "\x1b") {
            void invoke("write_to_session", { id: props.id, data: "\x1b", source: "ui" }).catch(() => {});
          } else {
            void invoke("write_to_session", { id: props.id, data: "\x1b", source: "ui" })
              .catch(() => {})
              .then(() =>
                invoke("write_to_session", { id: props.id, data, source: "user" }).catch(() => {}),
              );
          }
        } else {
          void invoke("write_to_session", { id: props.id, data, source: "user" }).catch(() => {});
        }
        if (data.includes("\r") || data.includes("\n")) {
          props.onUserEnter?.(props.id);
        }
        ingestUserInputForCommandDetection(data);
      });
    } else {
      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") return true;
        const key = event.key;
        const isCopy =
          (event.metaKey || (event.ctrlKey && event.shiftKey)) &&
          !event.altKey &&
          key.toLowerCase() === "c";
        if (isCopy && term.hasSelection()) {
          void copyToClipboard(term.getSelection());
          return false;
        }
        return true;
      });
      term.onData((data) => {
        void invoke("write_to_session", { id: props.id, data, source: "user" }).catch(() => {});
        if (data.includes("\r") || data.includes("\n")) {
          props.onUserEnter?.(props.id);
        }
      });
    }

	    termRef.current = term;
	    fitRef.current = fit;

    const oscDisposables: Array<{ dispose: () => void }> = [];
    const reportCwd = (cwd: string) => {
      const trimmed = cwd.trim();
      if (!trimmed) return;
      props.onCwdChange?.(props.id, trimmed);
    };
    const reportCommand = (commandLine: string) => {
      props.onCommandChange?.(props.id, commandLine, "osc");
    };

    const parseFileUrlPath = (data: string): string | null => {
      if (!data.startsWith("file://")) return null;
      const rest = data.slice("file://".length);
      const slashIdx = rest.indexOf("/");
      if (slashIdx < 0) return null;
      const rawPath = rest.slice(slashIdx);
      try {
        return decodeURIComponent(rawPath);
      } catch {
        return rawPath;
      }
    };

    if (term.parser) {
      oscDisposables.push(
        term.parser.registerOscHandler(7, (data) => {
          const path = parseFileUrlPath(data);
          if (path) reportCwd(path);
          return true;
        }),
      );
      oscDisposables.push(
        term.parser.registerOscHandler(1337, (data) => {
          const cwdPrefix = "CurrentDir=";
          if (data.startsWith(cwdPrefix)) {
            const cwd = data.slice(cwdPrefix.length);
            reportCwd(cwd);
            return true;
          }

          const cmdPrefix = "Command=";
          if (data.startsWith(cmdPrefix)) {
            const cmd = data.slice(cmdPrefix.length);
            reportCommand(cmd);
            return true;
          }

          return false;
        }),
      );

      // keep zellij's alternate screen behavior intact
    }

	    const scheduleResize = () => {
	      if (resizeRafRef.current !== null) return;
	      resizeRafRef.current = window.requestAnimationFrame(() => {
	        resizeRafRef.current = null;
	        sendResize();
	      });
	    };

		    const sendResize = () => {
		      const term = termRef.current;
		      const fit = fitRef.current;
		      const container = containerRef.current;
	      if (!term || !fit) return;
	      if (!term.element) return;
	      if (!container) return;
	      const rect = container.getBoundingClientRect();
	      if (rect.width === 0 || rect.height === 0) return;
	      if (!isXtermRendererReady(term)) {
	        scheduleResize();
	        return;
	      }
	      try {
	        fit.fit();
	      } catch {
	        scheduleResize();
	        return;
	      }
		      const { cols, rows } = term;
		      const last = lastSizeRef.current;
		      if (last && last.cols === cols && last.rows === rows) return;
		      lastSizeRef.current = { cols, rows };
          props.onResize?.(props.id, { cols, rows });
		      void invoke("resize_session", { id: props.id, cols, rows }).catch(() => {});
		    };

	    // Register BEFORE flushing to avoid race with incoming events
	    props.registry.current.set(props.id, { term, fit });

	    // Flush any buffered data that arrived before we were ready (but wait for renderer readiness)
	    const flushPending = (attemptsLeft: number) => {
	      const term = termRef.current;
	      if (!term) return;
	      const buffered = props.pendingData.current.get(props.id);
	      if (!buffered || buffered.length === 0) {
	        props.pendingData.current.delete(props.id);
	        return;
	      }
	      if (!isXtermRendererReady(term)) {
	        if (attemptsLeft > 0) {
	          window.requestAnimationFrame(() => flushPending(attemptsLeft - 1));
	        }
	        return;
	      }

	      let index = 0;
	      try {
	        for (; index < buffered.length; index += 1) {
	          term.write(buffered[index]);
	        }
	        props.pendingData.current.delete(props.id);
	      } catch {
	        if (index > 0) {
	          props.pendingData.current.set(props.id, buffered.slice(index));
	        }
	        if (attemptsLeft > 0) {
	          window.requestAnimationFrame(() => flushPending(attemptsLeft - 1));
	        }
	      }
	    };
	    flushPending(20);

	    // Create ResizeObserver inside useEffect for proper cleanup
	    const resizeObserver = new ResizeObserver(() => scheduleResize());

	    resizeObserver.observe(containerRef.current);
	    scheduleResize();

    let wheelCleanup: (() => void) | null = null;
    if (props.persistent) {
      const PIXELS_PER_LINE = 40;

      const wheelListener = (event: WheelEvent) => {
        const term = termRef.current;
        if (!term) return;
        if (event.ctrlKey) return;
        if (event.deltaY === 0) return;

        event.preventDefault();
        event.stopPropagation();

        let lines = 0;
        if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
          lines = Math.trunc(event.deltaY);
        } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
          lines = Math.trunc(event.deltaY * term.rows);
        } else {
          const state = zellijAutoScrollRef.current;
          state.wheelRemainder += event.deltaY;
          lines = Math.trunc(state.wheelRemainder / PIXELS_PER_LINE);
          if (lines !== 0) {
            const state = zellijAutoScrollRef.current;
            state.wheelRemainder -= lines * PIXELS_PER_LINE;
          }
        }
        if (lines !== 0) {
          const state = zellijAutoScrollRef.current;
          if (lines > 0 && !state.active) return;
          const prefix = state.active ? "" : "\x13";
          state.active = true;
          const count = Math.min(Math.abs(lines), 120);
          const step = lines < 0 ? "k" : "j";
          void invoke("write_to_session", {
            id: props.id,
            data: `${prefix}${step.repeat(count)}`,
            source: "ui",
          }).catch(() => {});
        }
      };

      containerRef.current.addEventListener("wheel", wheelListener, {
        passive: false,
        capture: true,
      });
      wheelCleanup = () => {
        containerRef.current?.removeEventListener("wheel", wheelListener, true);
      };
    }

    return () => {
      resizeObserver.disconnect();
      if (resizeRafRef.current !== null) {
        window.cancelAnimationFrame(resizeRafRef.current);
      }
      for (const d of oscDisposables) d.dispose();
      props.registry.current.delete(props.id);
      props.pendingData.current.delete(props.id);
      wheelCleanup?.();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      resizeRafRef.current = null;
    };
  }, [props.id, props.registry, props.pendingData, props.onResize]);

  useEffect(() => {
    if (!props.active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    const container = containerRef.current;
    if (!term || !fit || !container) return;

    let cancelled = false;
	    const attemptFit = (attemptsLeft: number) => {
	      if (cancelled) return;
	      const rect = container.getBoundingClientRect();
	      if (rect.width === 0 || rect.height === 0) {
	        if (attemptsLeft > 0) {
	          window.requestAnimationFrame(() => attemptFit(attemptsLeft - 1));
	        }
	        return;
	      }
	      if (!isXtermRendererReady(term)) {
	        if (attemptsLeft > 0) {
	          window.requestAnimationFrame(() => attemptFit(attemptsLeft - 1));
	        }
	        return;
	      }

	      try {
	        term.focus();
	      } catch {
	        if (attemptsLeft > 0) {
	          window.requestAnimationFrame(() => attemptFit(attemptsLeft - 1));
	        }
	        return;
	      }
	      try {
	        fit.fit();
	      } catch {
	        if (attemptsLeft > 0) {
	          window.requestAnimationFrame(() => attemptFit(attemptsLeft - 1));
	        }
	        return;
	      }
	      const { cols, rows } = term;
	      const last = lastSizeRef.current;
	      if (!last || last.cols !== cols || last.rows !== rows) {
	        lastSizeRef.current = { cols, rows };
	        void invoke("resize_session", { id: props.id, cols, rows }).catch(() => {});
      }
    };

    attemptFit(8);
    return () => {
      cancelled = true;
    };
  }, [props.active, props.id]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = props.readOnly;
  }, [props.readOnly]);

  return <div ref={containerRef} style={{ height: "100%", width: "100%" }} />;
}
