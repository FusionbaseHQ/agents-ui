import React, { useState } from "react";
import type { PlanTask } from "./agentTypes";
import { Icon } from "../components/Icon";

type Props = {
  task: PlanTask;
  onViewTerminal?: (sessionId: string) => void;
  onRetry?: (taskId: string) => void;
  onCancel?: (taskId: string) => void;
};

const STATUS_ICONS: Record<string, { symbol: string; className: string }> = {
  pending: { symbol: "\u25CB", className: "planTaskStatusPending" },
  blocked: { symbol: "\u2298", className: "planTaskStatusBlocked" },
  ready: { symbol: "\u25CB", className: "planTaskStatusReady" },
  running: { symbol: "\u25C9", className: "planTaskStatusRunning" },
  done: { symbol: "\u25CF", className: "planTaskStatusDone" },
  failed: { symbol: "\u25CF", className: "planTaskStatusFailed" },
};

function formatTimeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function assigneeLabel(assignee: string): string {
  return assignee === "codex" ? "Codex" : "Claude";
}

export function PlanTaskCard({ task, onViewTerminal, onRetry, onCancel }: Props) {
  const [expanded, setExpanded] = useState(false);
  const statusInfo = STATUS_ICONS[task.status] ?? STATUS_ICONS.pending;

  return (
    <div className={`planTaskCard planTaskCard-${task.status}`}>
      <div
        className="planTaskCardHeader"
        onClick={() => setExpanded((p) => !p)}
      >
        <span className={`planTaskStatusDot ${statusInfo.className}`}>
          {statusInfo.symbol}
        </span>
        <div className="planTaskCardInfo">
          <span className="planTaskTitle">{task.title}</span>
          <span className="planTaskMeta">
            {assigneeLabel(task.assignee)}
            {task.model ? ` \u00B7 ${task.model}` : ""}
            {task.status === "done" && task.completedAt && (
              <> \u2713 {formatTimeAgo(task.completedAt)}</>
            )}
            {task.status === "running" && (
              <> <span className="planTaskRunningIcon">\u21BB</span></>
            )}
            {task.status === "blocked" && task.dependencies.length > 0 && (
              <> needs: {task.dependencies.join(", ")}</>
            )}
          </span>
        </div>
        <span className={`planTaskExpandIcon ${expanded ? "planTaskExpandIconOpen" : ""}`}>
          <Icon name="chevron-down" size={12} />
        </span>
      </div>

      {expanded && (
        <div className="planTaskCardBody">
          <div className="planTaskDescription">{task.description}</div>

          {task.status === "done" && task.output && (
            <div className="planTaskOutput">
              <div className="planTaskOutputLabel">Output</div>
              <pre className="planTaskOutputText">
                {task.output.length > 1000
                  ? task.output.slice(0, 1000) + "\n...[truncated]"
                  : task.output}
              </pre>
            </div>
          )}

          {task.status === "failed" && task.error && (
            <div className="planTaskError">{task.error}</div>
          )}

          <div className="planTaskActions">
            {task.status === "running" && task.terminalSessionId && (
              <button
                type="button"
                className="btnSmall planTaskActionBtn"
                onClick={(e) => {
                  e.stopPropagation();
                  onViewTerminal?.(task.terminalSessionId!);
                }}
              >
                View Terminal
              </button>
            )}
            {task.status === "running" && (
              <button
                type="button"
                className="btnSmall planTaskActionBtn planTaskCancelBtn"
                onClick={(e) => {
                  e.stopPropagation();
                  onCancel?.(task.id);
                }}
              >
                Cancel
              </button>
            )}
            {task.status === "failed" && (
              <button
                type="button"
                className="btnSmall planTaskActionBtn"
                onClick={(e) => {
                  e.stopPropagation();
                  onRetry?.(task.id);
                }}
              >
                Retry
              </button>
            )}
            {task.status === "done" && task.terminalSessionId && (
              <button
                type="button"
                className="btnSmall planTaskActionBtn"
                onClick={(e) => {
                  e.stopPropagation();
                  onViewTerminal?.(task.terminalSessionId!);
                }}
              >
                View Terminal
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
