import React, { useState } from "react";
import { Icon } from "../components/Icon";
import type { AgentToolCall } from "./agentTypes";
import type { IconName } from "../components/Icon";

type ToolMeta = {
  label: string;
  icon: IconName;
  category: "fs" | "exec" | "search" | "web" | "agent";
  summary: (input: Record<string, unknown>) => string;
};

const TOOL_MAP: Record<string, ToolMeta> = {
  // Claude Code — file system
  Read:         { label: "Read File",     icon: "file",     category: "fs",     summary: (i) => filePath(i.file_path) },
  Write:        { label: "Write File",    icon: "file",     category: "fs",     summary: (i) => filePath(i.file_path) },
  Edit:         { label: "Edit File",     icon: "file",     category: "fs",     summary: (i) => filePath(i.file_path) },
  NotebookEdit: { label: "Edit Notebook", icon: "file",     category: "fs",     summary: (i) => filePath(i.notebook_path) },

  // Claude Code — execution
  Bash:         { label: "Terminal",      icon: "play",     category: "exec",   summary: (i) => truncate(str(i.command), 80) },

  // Claude Code — search
  Glob:         { label: "Find Files",    icon: "search",   category: "search", summary: (i) => str(i.pattern) },
  Grep:         { label: "Search Code",   icon: "search",   category: "search", summary: (i) => str(i.pattern) },

  // Claude Code — web
  WebFetch:     { label: "Fetch URL",     icon: "download",  category: "web",   summary: (i) => str(i.url) },
  WebSearch:    { label: "Web Search",    icon: "search",   category: "web",    summary: (i) => str(i.query) },

  // Claude Code — agent
  Task:         { label: "Agent Task",    icon: "brain",    category: "agent",  summary: (i) => truncate(str(i.description || i.prompt), 60) },

  // Codex — command execution
  shell:        { label: "Run Command",   icon: "play",     category: "exec",   summary: (i) => truncate(str(i.command), 80) },
};

/** All recognized native tool names */
const KNOWN_TOOLS = new Set(Object.keys(TOOL_MAP));

export function isNativeTool(name: string): boolean {
  return KNOWN_TOOLS.has(name);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\u2026";
}

/** Show only the filename portion for long paths */
function filePath(v: unknown): string {
  const p = str(v);
  if (!p) return "";
  // Show last 2 segments for context
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return "\u2026/" + parts.slice(-2).join("/");
}

const TOOL_RESULT_TRUNCATE = 500;

function ToolResultText({ text }: { text: string }) {
  const [showFull, setShowFull] = useState(false);

  if (text.length <= TOOL_RESULT_TRUNCATE) {
    return <pre className="agentToolCallResult">{text}</pre>;
  }

  return (
    <div>
      <pre className="agentToolCallResult">
        {showFull ? text : text.slice(0, TOOL_RESULT_TRUNCATE) + "\u2026"}
      </pre>
      <button
        type="button"
        className="agentToolResultToggle"
        onClick={() => setShowFull((p) => !p)}
      >
        {showFull ? "Show less" : "Show more"}
      </button>
    </div>
  );
}

export const NativeToolCard = React.memo(function NativeToolCard({ tc }: { tc: AgentToolCall }) {
  const [expanded, setExpanded] = useState(false);

  const meta = TOOL_MAP[tc.name];
  if (!meta) return null;

  const summary = meta.summary(tc.input ?? {});
  const hasDetails = (tc.input && Object.keys(tc.input).length > 0) || tc.result != null;

  return (
    <div className={`mcpCard mcpCard-${meta.category} mcpCard-${tc.status}`}>
      <button
        type="button"
        className="mcpCardHeader"
        onClick={() => hasDetails && setExpanded((p) => !p)}
        style={{ cursor: hasDetails ? "pointer" : "default" }}
      >
        <span className={`mcpCardIcon mcpCardIcon-${meta.category}`}>
          <Icon name={meta.icon} size={13} />
        </span>
        <span className="mcpCardLabel">{meta.label}</span>
        {summary && <span className="mcpCardSummary">{summary}</span>}
        <span className="mcpCardRight">
          {tc.status === "running" && <span className="mcpCardSpinner" />}
          {tc.status === "done" && <span className="mcpCardCheck">{"\u2713"}</span>}
          {tc.status === "error" && <span className="mcpCardError">{"\u2717"}</span>}
          {hasDetails && (
            <span className="mcpCardChevron">{expanded ? "\u25B4" : "\u25BE"}</span>
          )}
        </span>
      </button>
      {expanded && (
        <div className="mcpCardBody">
          {tc.input && Object.keys(tc.input).length > 0 && (
            <pre className="agentToolCallArgs">
              {JSON.stringify(tc.input, null, 2)}
            </pre>
          )}
          {tc.result != null && <ToolResultText text={tc.result} />}
        </div>
      )}
    </div>
  );
});
