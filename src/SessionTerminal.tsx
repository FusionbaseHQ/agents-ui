import { invoke } from "@tauri-apps/api/core";
import React, { useEffect, useRef } from "react";
import { Terminal, type ILink } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import type { PendingDataBuffer } from "./App";
import { detectProcessEffect } from "./processEffects";

export type TerminalRegistry = Map<string, { term: Terminal; fit: FitAddon }>;

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
  cwd: string | null;
  persistent?: boolean;
  onCwdChange?: (id: string, cwd: string) => void;
  onCommandChange?: (id: string, commandLine: string) => void;
  onUserEnter?: (id: string) => void;
  registry: React.MutableRefObject<TerminalRegistry>;
  pendingData: React.MutableRefObject<PendingDataBuffer>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const resizeRafRef = useRef<number | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const cwdRef = useRef<string | null>(props.cwd ?? null);
  const zellijAutoScrollRef = useRef<{
    active: boolean;
    wheelRemainder: number;
  }>({ active: false, wheelRemainder: 0 });
  const commandBufferRef = useRef<string>("");

  useEffect(() => {
    cwdRef.current = props.cwd ?? null;
  }, [props.cwd]);

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
        background: "#0b0f14",
        foreground: "rgba(255,255,255,0.92)",
        cursor: "#7aa2f7",
        selectionBackground: "rgba(122,162,247,0.25)",
      },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

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
          const effect = detectProcessEffect({ command: trimmed, name: null });
          if (effect) props.onCommandChange?.(props.id, trimmed);
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
      props.onCommandChange?.(props.id, commandLine);
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

    const parseFileLink = (
      raw: string,
    ): { target: string; line: number | null; column: number | null } | null => {
      const trimmed = raw.trim();
      if (!trimmed) return null;

      let target = trimmed;
      const fromFileUrl = parseFileUrlPath(target);
      if (fromFileUrl) target = fromFileUrl;

      let line: number | null = null;
      let column: number | null = null;
      const m = target.match(/:(\d+)(?::(\d+))?$/);
      if (m) {
        line = Number.parseInt(m[1], 10);
        column = m[2] ? Number.parseInt(m[2], 10) : null;
        target = target.slice(0, -m[0].length);
      }

      target = target.trim();
      if (!target) return null;
      return { target, line, column };
    };

    const isPlausibleFilePath = (raw: string): boolean => {
      const value = raw.trim();
      if (!value) return false;
      if (value.startsWith("file://")) return true;
      if (value.startsWith("http://") || value.startsWith("https://")) return false;
      if (/[^\w@.~%+\-/:\\]/.test(value)) return false;

      const hasLineSuffix = /:\d+(?::\d+)?$/.test(value);
      if (hasLineSuffix) return true;

      const lastSep = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
      const lastSegment = lastSep >= 0 ? value.slice(lastSep + 1) : value;
      return lastSegment.includes(".");
    };

    const trimToken = (raw: string): { text: string; startOffset: number } | null => {
      let text = raw;
      let startOffset = 0;
      while (text.length > 0 && /[([{<"'`]/.test(text[0])) {
        text = text.slice(1);
        startOffset += 1;
      }
      while (text.length > 0 && /[)\]}>.,;'"!?`]/.test(text[text.length - 1])) {
        text = text.slice(0, -1);
      }
      if (!text.trim()) return null;
      return { text, startOffset };
    };

    const candidateRe = /(?:file:\/\/\S+|[^\s"'`<>]+[\\/][^\s"'`<>]+)/g;
    oscDisposables.push(
      term.registerLinkProvider({
        provideLinks: (bufferLineNumber, callback) => {
          const line = term.buffer.active.getLine(bufferLineNumber - 1);
          if (!line) {
            callback(undefined);
            return;
          }

          const contents = line.translateToString(true);
          if (!contents) {
            callback(undefined);
            return;
          }

          const links: ILink[] = [];

          candidateRe.lastIndex = 0;
          let match: RegExpExecArray | null = null;
          while ((match = candidateRe.exec(contents)) !== null) {
            const idx = match.index;
            const trimmed = trimToken(match[0]);
            if (!trimmed) continue;

            const token = trimmed.text;
            if (!isPlausibleFilePath(token)) continue;

            const parsed = parseFileLink(token);
            if (!parsed) continue;

            const startX = idx + trimmed.startOffset + 1;
            const endX = idx + trimmed.startOffset + token.length;

            links.push({
              range: {
                start: { x: startX, y: bufferLineNumber },
                end: { x: endX, y: bufferLineNumber },
              },
              text: token,
              decorations: { pointerCursor: true, underline: true },
              activate: (event) => {
                event.preventDefault();
                event.stopPropagation();
                void invoke("open_in_vscode", {
                  target: parsed.target,
                  cwd: cwdRef.current,
                  line: parsed.line,
                  column: parsed.column,
                }).catch(() => {});
              },
            });
          }

          callback(links.length ? links : undefined);
        },
      }),
    );

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

    const sendResize = () => {
      const term = termRef.current;
      const fit = fitRef.current;
      const container = containerRef.current;
      if (!term || !fit) return;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      fit.fit();
      const { cols, rows } = term;
      const last = lastSizeRef.current;
      if (last && last.cols === cols && last.rows === rows) return;
      lastSizeRef.current = { cols, rows };
      void invoke("resize_session", { id: props.id, cols, rows }).catch(() => {});
    };

    const scheduleResize = () => {
      if (resizeRafRef.current !== null) return;
      resizeRafRef.current = window.requestAnimationFrame(() => {
        resizeRafRef.current = null;
        sendResize();
      });
    };

    // Register BEFORE flushing to avoid race with incoming events
    props.registry.current.set(props.id, { term, fit });

    // Flush any buffered data that arrived before we were ready
    const buffered = props.pendingData.current.get(props.id);
    if (buffered && buffered.length > 0) {
      for (const data of buffered) {
        term.write(data);
      }
      props.pendingData.current.delete(props.id);
    }

    // Create ResizeObserver inside useEffect for proper cleanup
    const resizeObserver = new ResizeObserver(() => scheduleResize());

    resizeObserver.observe(containerRef.current);
    sendResize();

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
  }, [props.id, props.registry, props.pendingData]);

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

      term.focus();
      fit.fit();
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
