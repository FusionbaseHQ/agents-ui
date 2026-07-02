import React, { useEffect, useMemo, useState } from "react";
import type { Terminal } from "xterm";
import type { SessionShellIntegration, CommandBlock } from "../shellIntegration";
import { EmptyState } from "../ui";

type SessionTimelineProps = {
  /** Active session's terminal + shell integration, or null when unavailable. */
  term: Terminal | null;
  shellInt: SessionShellIntegration | null;
  sessionName: string | null;
  onCopyOutput: (text: string) => void;
};

type Row = {
  block: CommandBlock;
  command: string;
  exitCode: number | null;
  running: boolean;
  durationMs: number | null;
  startedAt: number | null;
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function formatClock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Semantic command timeline for the active session, built from the OSC 133
 * blocks SessionShellIntegration tracks: one row per command with exit
 * status, duration, and start time. Click scrolls the terminal to that
 * command; "Copy output" grabs the block's output text. Live: subscribes to
 * block changes. Rows exist only for scrollback still in the buffer —
 * evicted blocks disappear (that's inherent to marker-based tracking).
 */
export function SessionTimeline(props: SessionTimelineProps) {
  const { term, shellInt, sessionName, onCopyOutput } = props;
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!shellInt) return;
    const unsubscribe = shellInt.onBlocksChanged(() => setVersion((v) => v + 1));
    return () => {
      unsubscribe();
    };
  }, [shellInt]);

  // Ticker so running-command durations advance while a command runs.
  const hasRunning = Boolean(shellInt?.pendingBlock?.outputMarker);
  useEffect(() => {
    if (!hasRunning) return;
    const t = window.setInterval(() => setVersion((v) => v + 1), 1000);
    return () => window.clearInterval(t);
  }, [hasRunning]);

  const rows = useMemo<Row[]>(() => {
    void version;
    if (!term || !shellInt) return [];
    return shellInt.allBlocks
      .filter((b) => b.commandMarker)
      .map((b) => {
        const running = !b.endMarker;
        const durationMs = running
          ? b.startedAt != null
            ? Date.now() - b.startedAt
            : null
          : b.startedAt != null && b.finishedAt != null
            ? b.finishedAt - b.startedAt
            : null;
        return {
          block: b,
          command: shellInt.getCommandText(term, b) ?? "",
          exitCode: b.exitCode ?? null,
          running,
          durationMs,
          startedAt: b.startedAt ?? null,
        };
      })
      .filter((r) => r.command.length > 0 || r.running);
  }, [term, shellInt, version]);

  if (!term || !shellInt) {
    return (
      <EmptyState
        compact
        title="No terminal selected"
        hint="Open a terminal session to see its command timeline."
      />
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        compact
        title="No commands yet"
        hint="Commands run in this session appear here with exit status and duration. Requires a shell with OSC 133 integration (bundled agsh and Nushell, managed zsh/bash)."
      />
    );
  }

  return (
    <div className="timelineList" aria-label={`Command timeline${sessionName ? ` — ${sessionName}` : ""}`}>
      {rows.map((r) => (
        <div
          key={r.block.id}
          className={`timelineRow${r.running ? " running" : r.exitCode === 0 ? " ok" : " failed"}`}
          onClick={() => shellInt.navigateToBlock(term, r.block)}
          title="Scroll terminal to this command"
        >
          <span className="timelineStatus" aria-hidden="true" />
          <div className="timelineMain">
            <div className="timelineCommand">{r.command || "(running)"}</div>
            <div className="timelineMeta">
              {[
                r.startedAt != null ? formatClock(r.startedAt) : null,
                r.durationMs != null ? formatDuration(r.durationMs) : null,
                r.running ? "running" : r.exitCode === 0 ? "ok" : `exit ${r.exitCode}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
          {!r.running ? (
            <button
              type="button"
              className="btnSmall timelineCopy"
              onClick={(e) => {
                e.stopPropagation();
                const out = shellInt.getOutputText(term, r.block);
                if (out != null) onCopyOutput(out);
              }}
              title="Copy this command's output"
            >
              Copy output
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
