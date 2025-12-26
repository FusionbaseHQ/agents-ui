import { invoke } from "@tauri-apps/api/core";
import React, { useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import type { PendingDataBuffer } from "./App";

export type TerminalRegistry = Map<string, { term: Terminal; fit: FitAddon }>;

export default function SessionTerminal(props: {
  id: string;
  active: boolean;
  readOnly: boolean;
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
    fit.fit();

    term.onData((data) => {
      void invoke("write_to_session", { id: props.id, data, source: "user" }).catch(() => {});
      if (data.includes("\r") || data.includes("\n")) {
        props.onUserEnter?.(props.id);
      }
    });

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
    }

    const sendResize = () => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
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

    return () => {
      resizeObserver.disconnect();
      if (resizeRafRef.current !== null) {
        window.cancelAnimationFrame(resizeRafRef.current);
      }
      for (const d of oscDisposables) d.dispose();
      props.registry.current.delete(props.id);
      props.pendingData.current.delete(props.id);
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
    term.focus();
    fit.fit();
    const { cols, rows } = term;
    const last = lastSizeRef.current;
    if (!last || last.cols !== cols || last.rows !== rows) {
      lastSizeRef.current = { cols, rows };
      void invoke("resize_session", { id: props.id, cols, rows }).catch(() => {});
    }
  }, [props.active, props.id]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = props.readOnly;
  }, [props.readOnly]);

  return <div ref={containerRef} style={{ height: "100%", width: "100%" }} />;
}
