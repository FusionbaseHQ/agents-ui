import React, { useState } from "react";
import { Icon } from "../components/Icon";
import type { AgentToolCall } from "./agentTypes";
import type { IconName } from "../components/Icon";

const MCP_PREFIX = "mcp__agents-ui__";

type ToolMeta = {
  label: string;
  icon: IconName;
  category: "session" | "project" | "ssh" | "file" | "app";
  /** Extract a concise summary string from the tool input */
  summary: (input: Record<string, unknown>) => string;
};

const TOOL_MAP: Record<string, ToolMeta> = {
  // Session management
  list_sessions:      { label: "List Sessions",      icon: "layers",  category: "session", summary: (i) => i.projectId ? `project: ${i.projectId}` : "" },
  get_session:        { label: "Get Session",        icon: "code",    category: "session", summary: (i) => str(i.sessionId) },
  create_session:     { label: "Create Session",     icon: "plus",    category: "session", summary: (i) => i.name ? str(i.name) : i.command ? str(i.command) : "" },
  close_session:      { label: "Close Session",      icon: "close",   category: "session", summary: (i) => str(i.sessionId) },
  write_to_session:   { label: "Write to Terminal",  icon: "code",    category: "session", summary: (i) => truncate(str(i.data), 60) },
  send_command:       { label: "Run Command",        icon: "play",    category: "session", summary: (i) => truncate(str(i.command), 80) },
  read_session_output:{ label: "Read Output",        icon: "file",    category: "session", summary: () => "" },
  wait_for_output:    { label: "Wait for Output",    icon: "file",    category: "session", summary: (i) => i.timeout ? `${i.timeout}ms` : "" },
  activate_session:   { label: "Focus Session",      icon: "bolt",    category: "session", summary: (i) => str(i.sessionId) },

  // Project management
  list_projects:      { label: "List Projects",      icon: "layers",  category: "project", summary: () => "" },
  create_project:     { label: "Create Project",     icon: "plus",    category: "project", summary: (i) => str(i.title) },
  get_project:        { label: "Get Project",        icon: "folder",  category: "project", summary: (i) => str(i.projectId) },
  update_project:     { label: "Update Project",     icon: "settings",category: "project", summary: (i) => i.title ? str(i.title) : "" },
  delete_project:     { label: "Delete Project",     icon: "trash",   category: "project", summary: (i) => str(i.projectId) },
  activate_project:   { label: "Focus Project",      icon: "bolt",    category: "project", summary: (i) => str(i.projectId) },
  reorder_projects:   { label: "Reorder Projects",   icon: "grip",    category: "project", summary: () => "" },

  // SSH
  ssh_connect:        { label: "SSH Connect",        icon: "ssh",     category: "ssh",     summary: (i) => str(i.target) },
  ssh_list_hosts:     { label: "SSH Hosts",          icon: "ssh",     category: "ssh",     summary: () => "" },

  // Local files
  list_files:         { label: "List Files",         icon: "files",   category: "file",    summary: (i) => joinPath(i.root, i.path) },
  read_file:          { label: "Read File",          icon: "file",    category: "file",    summary: (i) => joinPath(i.root, i.path) },
  write_file:         { label: "Write File",         icon: "file",    category: "file",    summary: (i) => joinPath(i.root, i.path) },

  // Remote SSH files
  ssh_files_list:     { label: "List Remote Files",  icon: "files",   category: "ssh",     summary: (i) => `${str(i.host)}:${joinPath(i.root, i.path)}` },
  ssh_files_read:     { label: "Read Remote File",   icon: "file",    category: "ssh",     summary: (i) => `${str(i.host)}:${joinPath(i.root, i.path)}` },
  ssh_files_write:    { label: "Write Remote File",  icon: "file",    category: "ssh",     summary: (i) => `${str(i.host)}:${joinPath(i.root, i.path)}` },

  // Prompts
  list_prompts:       { label: "List Prompts",       icon: "layers",  category: "app",     summary: () => "" },
  send_prompt:        { label: "Send Prompt",        icon: "play",    category: "session", summary: (i) => i.content ? truncate(str(i.content), 60) : str(i.promptId) },

  // App / UI
  get_app_info:       { label: "App Info",           icon: "bolt",    category: "app",     summary: () => "" },
  get_ui_state:       { label: "UI State",           icon: "layers",  category: "app",     summary: () => "" },
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\u2026";
}

function joinPath(root: unknown, path: unknown): string {
  const r = str(root);
  const p = str(path);
  if (!r && !p) return "";
  if (!r) return p;
  if (!p) return r;
  return r.endsWith("/") ? r + p : r + "/" + p;
}

/** Check if a tool call is an agents-ui MCP tool */
export function isAgentsUiTool(name: string): boolean {
  return name.startsWith(MCP_PREFIX);
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

export const McpToolCard = React.memo(function McpToolCard({ tc }: { tc: AgentToolCall }) {
  const [expanded, setExpanded] = useState(false);

  const toolKey = tc.name.slice(MCP_PREFIX.length);
  const meta = TOOL_MAP[toolKey];

  // Fallback for unknown agents-ui tools
  if (!meta) {
    return <GenericMcpCard tc={tc} toolKey={toolKey} />;
  }

  const summary = meta.summary(tc.input ?? {});
  const isRunning = tc.status === "running";
  const isError = tc.status === "error";
  const isDone = tc.status === "done";
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
          {isRunning && <span className="mcpCardSpinner" />}
          {isDone && <span className="mcpCardCheck">{"\u2713"}</span>}
          {isError && <span className="mcpCardError">{"\u2717"}</span>}
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

/** Fallback for agents-ui tools not in the map */
function GenericMcpCard({ tc, toolKey }: { tc: AgentToolCall; toolKey: string }) {
  const [expanded, setExpanded] = useState(false);
  const label = toolKey.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const hasDetails = (tc.input && Object.keys(tc.input).length > 0) || tc.result != null;

  return (
    <div className={`mcpCard mcpCard-app mcpCard-${tc.status}`}>
      <button
        type="button"
        className="mcpCardHeader"
        onClick={() => hasDetails && setExpanded((p) => !p)}
        style={{ cursor: hasDetails ? "pointer" : "default" }}
      >
        <span className="mcpCardIcon mcpCardIcon-app">
          <Icon name="bolt" size={13} />
        </span>
        <span className="mcpCardLabel">{label}</span>
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
}
