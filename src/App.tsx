import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { initBridge, registerHandlers, destroyBridge, notifyStateChange } from "./apiBridge";
import React, { useEffect, useMemo, useRef, useState, useCallback, useLayoutEffect } from "react";
import { type PendingDataBuffer, type TerminalRegistry } from "./SessionTerminal";
import {
  commandTagFromCommandLine,
  detectProcessEffect,
  getProcessEffectById,
  PROCESS_EFFECTS,
  type ProcessEffect,
} from "./processEffects";
import { shortenPathSmart } from "./pathDisplay";
import { SlidePanel } from "./SlidePanel";
import { PanelErrorBoundary } from "./ErrorBoundary";
import { CommandPalette } from "./CommandPalette";
import { QuickPromptsSection } from "./components/QuickPromptsSection";
import {
  WorkspaceSidebar,
  type SidebarProject,
  type SidebarSession,
  type WorkspaceDeleteOptions,
} from "./components/WorkspaceSidebar";
import { TerminalPane, type TerminalPaneSession } from "./components/TerminalPane";
import { Icon } from "./components/Icon";
import { ActivityCenter, type ActivityCenterItem } from "./components/ActivityCenter";
import { FileExplorerPanel, type FileExplorerPersistedState } from "./components/FileExplorerPanel";
import { WorkspaceFileSearch } from "./components/WorkspaceFileSearch";
import { EDITOR_THEME_BY_UI_THEME } from "./monaco/editorThemes";
import { TabSymbolIcon, normalizeTabSymbolValue } from "./tabSymbols";
import type {
  CodeEditorFsEvent,
  CodeEditorOpenFileRequest,
  CodeEditorOpenWorkspaceTabRequest,
  CodeEditorPanelHandle,
  CodeEditorPersistedState,
  CodeEditorWorkspaceSnapshot,
  CodeEditorWorkspaceTab,
} from "./components/CodeEditorPanel";
import { AgentShortcutsModal } from "./components/AgentShortcutsModal";
import { parseStreamLine, type ParsedUpdate } from "./agent/agentStreamParser";
import { loadAgentSettings } from "./agent/agentStorage";
import type { AgentLaunchSettings } from "./agent/agentTypes";
import { NewSessionModal, type NewSessionModalHandle, type NewSessionSubmitData } from "./components/modals/NewSessionModal";
import { ShellPickerModal } from "./components/modals/ShellPickerModal";
import {
  type ShellChoice,
  type ShellInfo,
  shellChoiceToPayload,
  shellChoiceShortName,
  shellChoiceLabel,
} from "./shells";
import { StatusBar } from "./components/StatusBar";
import {
  useShellsStore,
  loadShells,
  setAppDefaultShell,
  shellChoiceForProject,
} from "./stores/shells";
import {
  useDialogsStore,
  openDialog,
  closeDialog,
  toggleDialog,
  closeTopDialog,
  anyDialogOpen,
} from "./stores/dialogs";
import {
  useUpdatesStore,
  fetchAppInfo,
  checkForUpdates,
  checkForUpdatesSilently,
  parseGithubRepo,
} from "./stores/updates";
import {
  PersistentSessionsModal,
  type PersistentSessionsModalItem,
} from "./components/modals/PersistentSessionsModal";
import { ProjectModal, type ProjectModalHandle, type ProjectSubmitData } from "./components/modals/ProjectModal";
import { ApplyAssetModal } from "./components/modals/ApplyAssetModal";
import { ConfirmActionModal } from "./components/modals/ConfirmActionModal";
import { ShortcutsModal } from "./components/modals/ShortcutsModal";
import { SettingsModal } from "./components/modals/SettingsModal";
import { WelcomePane } from "./components/WelcomePane";
import { SessionTimeline } from "./components/SessionTimeline";
import { NewSessionFlow, type NewSessionFlowItem } from "./components/modals/NewSessionFlow";
import { matchBinding } from "./keymap";
import { ToastHost, showToast, EmptyState, Modal } from "./ui";
import { PathPickerModal } from "./components/modals/PathPickerModal";
import { UpdateModal } from "./components/modals/UpdateModal";
import {
  SshManagerModal,
  type SshConnectData,
  type SshHistoryEntry,
  type SshHostEntry,
} from "./components/modals/SshManagerModal";

const LazyCodeEditorPanel = React.lazy(() => import("./components/CodeEditorPanel"));
const LazyAgentPanel = React.lazy(() =>
  import("./agent/AgentPanel").then((module) => ({ default: module.AgentPanel })),
);

type Project = {
  id: string;
  title: string;
  basePath: string | null;
  environmentId: string | null;
  assetsEnabled?: boolean;
  symbol?: string | null;
  color?: string | null;
  sshTarget?: string | null;
  sshRemotePath?: string | null;
  // Per-project default shell. Absent ⇒ bundled Nushell (the app default).
  defaultShell?: ShellChoice | null;
};

// A Workspace groups projects (Workspace → Project → Session). Workspaces are a
// frontend-only tier persisted separately (see STORAGE_WORKSPACES_KEY); the Rust
// PersistedStateV1 blob drops unknown fields, so workspace membership is kept in
// its own localStorage record rather than on the Project rows.
type Workspace = {
  id: string;
  name: string;
  symbol?: string | null;
  color?: string | null;
  iconImage?: string | null; // data URL of a custom workspace icon
};

type PersistedWorkspacesV1 = {
  schemaVersion: 1;
  workspaces: Workspace[];
  activeWorkspaceId: string;
  projectWorkspace: Record<string, string>;
};

type SessionInfo = {
  id: string;
  name: string;
  command: string;
  cwd?: string | null;
};

type Session = SessionInfo & {
  projectId: string;
  persistId: string;
  persistent: boolean;
  createdAt: number;
  pinned?: boolean;
  sidebarOrder?: number | null;
  launchCommand: string | null;
  restoreCommand?: string | null;
  sshTarget: string | null;
  sshRootDir: string | null;
  lastRecordingId?: string | null;
  recordingActive?: boolean;
  cwd: string | null;
  effectId?: string | null;
  processTag?: string | null;
  runningCommand?: string | null;
  symbol?: string | null;
  color?: string | null;
  exited?: boolean;
  closing?: boolean;
  exitCode?: number | null;
  /** Shell this session was launched with (null/absent ⇒ the default). Not restored across app restarts. */
  shellChoice?: ShellChoice | null;
  connectionState?: "connected" | "reconnecting" | "disconnected";
  reconnectAttempt?: number;
  nextReconnectAt?: number | null;
  disconnectReason?: string | null;
  manualReconnectAvailable?: boolean;
};

type WorkspaceView = {
  projectId: string;
  fileExplorerOpen: boolean;
  fileExplorerRootDir: string | null;
  fileExplorerPersistedState: FileExplorerPersistedState | null;
  codeEditorOpen: boolean;
  codeEditorRootDir: string | null;
  openFileRequest: CodeEditorOpenFileRequest | null;
  openWorkspaceTabRequest: CodeEditorOpenWorkspaceTabRequest | null;
  codeEditorActiveFilePath: string | null;
  codeEditorPersistedState: CodeEditorPersistedState | null;
  codeEditorFsEvent: CodeEditorFsEvent | null;
  editorWidth: number;
  treeWidth: number;
};

type SplitView = {
  id: string;
  projectId: string;
  aId: string;
  bId: string;
  direction: "horizontal" | "vertical";
  ratio: number;
  createdAt: number;
  lastFocusedId: string;
};

type PtyOutput = { id: string; data: string };
type PtyExit = { id: string; exit_code?: number | null };
type AgentOutputPayload = { runId: string; data: string };
type AgentDonePayload = { runId: string; exitCode: number | null };
type AgentStderrPayload = { runId: string; data: string };
type AppMenuEventPayload = { id: string };
type StartupFlags = { clearData: boolean };
type TrayMenuEventPayload = {
  id: string;
  effectId?: string | null;
  projectId?: string | null;
  persistId?: string | null;
};
type SystemHealthStats = {
  cpuPercent?: number | null;
  memoryUsedBytes?: number | null;
  memoryFreeBytes?: number | null;
  memoryTotalBytes?: number | null;
  diskUsedBytes?: number | null;
  diskFreeBytes?: number | null;
  diskTotalBytes?: number | null;
};
type SystemHealthDisplayItem = {
  key: string;
  label: string;
  value: string;
  title: string;
};
type RecentSessionKey = { projectId: string; persistId: string };
type TrayRecentSession = { label: string; projectId: string; persistId: string };
type OutputQueueBySession = Map<string, string[]>;
type SessionRestoreProgress = { remaining: number; total: number };
type UiTheme =
  | "dawn"
  | "sepia"
  | "ember"
  | "slate"
  | "midnight"
  | "cobalt"
  | "neon"
  | "forest"
  | "matrix"
  | "synthwave"
  | "quantum";

const STORAGE_PROJECTS_KEY = "agents-ui-projects";
const STORAGE_ACTIVE_PROJECT_KEY = "agents-ui-active-project-id";
const STORAGE_SESSIONS_KEY = "agents-ui-sessions-v1";
const STORAGE_ACTIVE_SESSION_BY_PROJECT_KEY = "agents-ui-active-session-by-project-v1";
const STORAGE_WORKSPACE_EDITOR_WIDTH_KEY = "agents-ui-workspace-editor-width-v1";
const STORAGE_WORKSPACE_FILE_TREE_WIDTH_KEY = "agents-ui-workspace-file-tree-width-v1";
const STORAGE_WORKSPACE_VIEW_BY_KEY = "agents-ui-workspace-view-by-key-v1";
const STORAGE_RECENT_SESSIONS_KEY = "agents-ui-recent-sessions-v1";
const STORAGE_SSH_HISTORY_KEY = "agents-ui-ssh-history-v1";
const STORAGE_SPLIT_VIEWS_KEY = "agents-ui-split-views-v1";
const STORAGE_AGENT_PANEL_WIDTH_KEY = "agents-ui-agent-panel-width-v1";
const STORAGE_UI_THEME_KEY = "agents-ui-ui-theme-v1";
const STORAGE_AUTO_CAFFEINATE_KEY = "agents-ui-auto-caffeinate-v1";
const STORAGE_WORKSPACES_KEY = "agents-ui-workspaces-v1";
const STORAGE_SIDEBAR_COLLAPSED_KEY = "agents-ui-sidebar-collapsed-v1";
const DEFAULT_UI_THEME: UiTheme = "midnight";
// Long enough to outlast the pauses inside one agent run (output gaps of a
// few seconds happen constantly; thinking pauses can reach ~10s).
const SHORTCUT_HINT_REAPPEAR_DELAY_MS = 15_000;
const MAX_SSH_HISTORY = 10;

const MAX_PENDING_SESSIONS = 32;
const MAX_PENDING_CHUNKS_PER_SESSION = 200;
const MAX_OUTPUT_QUEUE_CHUNKS_PER_SESSION = 64;
// Byte cap for output deferred for a hidden session. The terminal keeps 5000
// lines of scrollback (~1.25 MB of typical text), so anything beyond the
// newest few MiB could never survive switch-in anyway — dropping the oldest
// overflow bounds memory during background floods (`yes`, runaway logs) and
// keeps switch-in fast, with no reachable scrollback lost.
const MAX_DEFERRED_OUTPUT_BYTES_PER_SESSION = 4 * 1024 * 1024;
const SSH_RECONNECT_BASE_MS = 1000;
const SSH_RECONNECT_MAX_MS = 30_000;
const SSH_RECONNECT_MAX_ATTEMPTS = 6;
const SESSION_HEALTHCHECK_VISIBLE_INTERVAL_MS = 30_000;
const SESSION_HEALTHCHECK_MIN_GAP_MS = 5_000;
const SLEEP_DETECTION_GAP_MS = 15_000;
const DISPLAY_WAKE_RENDER_GAP_MS = 8_000;
const DISPLAY_WAKE_TIMER_INTERVAL_MS = 2_000;
const DISPLAY_WAKE_RECOVERY_MIN_GAP_MS = 4_000;
const DISPLAY_WAKE_RECOVERY_COALESCE_MS = 2_000;
// Let the native WKWebView pulse and WindowServer presentation settle before
// replacing xterm's renderer. Later passes share the generation and refresh only.
const DISPLAY_WAKE_RECOVERY_DELAYS_MS = [250, 750, 1_500, 3_000] as const;
let displayWakeRecoveryGeneration = 0;
const SYSTEM_HEALTH_REFRESH_MS = 5_000;
// Cursor Position Report echo (ESC[row;colR). TUI apps query via ESC[6n and the
// PTY kernel can echo xterm's response back as visible garbage, so we strip it.
// Non-global RE is used as a cheap presence gate (no lastIndex state); the
// global RE only runs the allocating .replace when a real CPR is actually present.
const CPR_RESPONSE_RE = /\x1b\[\d{1,4};\d{1,4}R/;
const CPR_RESPONSE_RE_GLOBAL = /\x1b\[\d{1,4};\d{1,4}R/g;
const COMMAND_ACTIVITY_IDLE_MS = 3_000;

const DEFAULT_AGENT_SHORTCUT_IDS = ["codex", "claude"];
const DEFAULT_WORKSPACE_EDITOR_WIDTH = 520;
const DEFAULT_WORKSPACE_FILE_TREE_WIDTH = 320;
const DEFAULT_AGENT_PANEL_WIDTH = 420;
const MIN_WORKSPACE_TERMINAL_WIDTH = 160;
const MIN_WORKSPACE_EDITOR_WIDTH = 260;
const MIN_WORKSPACE_FILE_TREE_WIDTH = 200;
const MIN_AGENT_PANEL_WIDTH = 320;
const MAX_AGENT_PANEL_WIDTH = 700;
const AUTO_RENAME_LOG_ENTRY_LIMIT = 6;
const AGENTS_UI_MCP_PREFIX = "mcp__agents-ui__";

function selectEditableElement(element: Element | null): boolean {
  const editable = element?.closest("input, textarea, [contenteditable]") ?? null;
  if (!editable) return false;

  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
    if (editable.disabled) return false;
    try {
      editable.select();
      return true;
    } catch {
      return false;
    }
  }

  if (editable instanceof HTMLElement && editable.isContentEditable) {
    const selection = window.getSelection();
    if (!selection) return false;
    try {
      const range = document.createRange();
      range.selectNodeContents(editable);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

function selectDocumentContents(): void {
  try {
    if (document.execCommand("selectAll")) return;
  } catch {
    /* fall through to Selection API */
  }

  const selection = window.getSelection();
  const body = document.body;
  if (!selection || !body) return;
  try {
    const range = document.createRange();
    range.selectNodeContents(body);
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    /* ignore */
  }
}

type AutoRenameLogTone = "info" | "success" | "error";
type AutoRenameActivity = {
  projectId: string;
  providerLabel: string;
  status: "running" | "success" | "error";
  summary: string;
  entries: Array<{
    id: string;
    text: string;
    tone: AutoRenameLogTone;
  }>;
};

const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeSmartQuotes(input: string): string {
  return input.replace(/[“”„‟«»]/g, '"').replace(/[‘’‚‛‹›]/g, "'");
}

function truncateInlineText(input: string, max: number): string {
  const compact = input.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function resolveSessionLogLabel(sessionId: string | undefined, sessions: Session[]): string {
  if (!sessionId) return "session";
  const session = sessions.find((entry) => entry.id === sessionId);
  if (session?.name?.trim()) return session.name.trim();
  return sessionId;
}

function summarizeAutoRenameUpdate(update: ParsedUpdate, sessions: Session[]): Array<{
  text: string;
  tone: AutoRenameLogTone;
}> {
  if (update.kind === "batch") {
    return update.updates.flatMap((nested) => summarizeAutoRenameUpdate(nested, sessions));
  }

  if (update.kind === "message_complete") {
    const text = truncateInlineText(update.text, 140);
    return text ? [{ text, tone: "success" }] : [];
  }

  if (update.kind !== "tool_start") return [];

  const toolName = update.name.startsWith(AGENTS_UI_MCP_PREFIX)
    ? update.name.slice(AGENTS_UI_MCP_PREFIX.length)
    : update.name;
  const input = update.input ?? {};
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : undefined;
  const sessionLabel = resolveSessionLogLabel(sessionId, sessions);

  switch (toolName) {
    case "list_sessions":
      return [{ text: "Listing project sessions", tone: "info" }];
    case "read_screen":
      return [{ text: `Reading screen: ${sessionLabel}`, tone: "info" }];
    case "read_scrollback":
      return [{ text: `Reading scrollback: ${sessionLabel}`, tone: "info" }];
    case "get_session_status":
      return [{ text: `Checking session state: ${sessionLabel}`, tone: "info" }];
    case "rename_session": {
      const nextName = typeof input.name === "string" ? input.name.trim() : "";
      if (!nextName) return [];
      return [{ text: `${sessionLabel} → ${nextName}`, tone: "success" }];
    }
    default:
      return [];
  }
}

const VALID_THEMES = new Set<UiTheme>([
  "dawn",
  "sepia",
  "ember",
  "slate",
  "midnight",
  "cobalt",
  "neon",
  "forest",
  "matrix",
  "synthwave",
  "quantum",
]);
const LEGACY_THEME_MAP: Record<string, UiTheme> = {
  "paper-light": "dawn",
  "paper-sepia": "sepia",
  "paper-dark": "ember",
  "paper-slate": "slate",
  "paper-black": "midnight",
  "paper-blueprint": "cobalt",
  "paper-neon": "neon",
};
function parseUiTheme(input: string | null): UiTheme {
  if (!input) return DEFAULT_UI_THEME;
  if (VALID_THEMES.has(input as UiTheme)) return input as UiTheme;
  const legacy = LEGACY_THEME_MAP[input];
  if (legacy) return legacy;
  return DEFAULT_UI_THEME;
}

function readStoredUiTheme(): UiTheme {
  try {
    return parseUiTheme(localStorage.getItem(STORAGE_UI_THEME_KEY));
  } catch {
    return DEFAULT_UI_THEME;
  }
}

function readStoredAutoCaffeinate(): boolean {
  try {
    // Default on: only an explicit "off" disables it.
    return localStorage.getItem(STORAGE_AUTO_CAFFEINATE_KEY) !== "off";
  } catch {
    return true;
  }
}

const INITIAL_AUTO_CAFFEINATE: boolean = readStoredAutoCaffeinate();

const INITIAL_UI_THEME: UiTheme = readStoredUiTheme();
if (typeof document !== "undefined") {
  document.documentElement.setAttribute("data-theme", INITIAL_UI_THEME);
}

function isValidEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key.trim());
}

function unescapeDoubleQuotedEnvValue(input: string): string {
  return input
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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

function shellEscapePosix(value: string): string {
  let out = "'";
  for (const ch of value) {
    if (ch === "'") out += "'\"'\"'";
    else out += ch;
  }
  out += "'";
  return out;
}

function basenamePath(input: string): string {
  const normalized = input.trim().replace(/[\\/]+$/, "");
  if (!normalized) return "";
  if (normalized === "/") return "/";
  const parts = normalized.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? "";
}

function formatCommandTokenLabel(token: string): string {
  const normalized = token.trim().toLowerCase();
  if (!normalized) return "Shell";

  const known: Record<string, string> = {
    bash: "Shell",
    bun: "Bun",
    bunx: "Bunx",
    cargo: "Cargo",
    claude: "Claude",
    codex: "Codex",
    deno: "Deno",
    git: "Git",
    go: "Go",
    node: "Node",
    npm: "npm",
    nu: "Shell",
    pnpm: "pnpm",
    python: "Python",
    python3: "Python",
    rails: "Rails",
    ruby: "Ruby",
    sh: "Shell",
    ssh: "SSH",
    uv: "uv",
    yarn: "Yarn",
    zsh: "Shell",
  };
  if (known[normalized]) return known[normalized];

  return normalized
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildSmartSessionName(input: {
  explicitName?: string | null;
  launchCommand?: string | null;
  restoreCommand?: string | null;
  sshTarget?: string | null;
  cwd?: string | null;
  persistent?: boolean;
}): string {
  const explicitName = input.explicitName?.trim();
  if (explicitName) return explicitName;

  const commandLine = (input.launchCommand ?? input.restoreCommand ?? "").trim();
  const cwdLabel = basenamePath(input.cwd ?? "");
  const effect = detectProcessEffect({ command: commandLine || null, name: null });
  const sshTarget =
    input.sshTarget?.trim() ||
    sshTargetFromCommandLine(commandLine || null) ||
    null;

  if (sshTarget) return `SSH ${sshTarget}`;

  if (effect) {
    const effectLabel = formatCommandTokenLabel(effect.id);
    if (
      cwdLabel &&
      cwdLabel !== "/" &&
      cwdLabel.toLowerCase() !== effectLabel.toLowerCase()
    ) {
      return `${effectLabel} - ${cwdLabel}`;
    }
    return effectLabel;
  }

  const commandToken = commandTagFromCommandLine(commandLine);
  if (commandToken) {
    const commandLabel = formatCommandTokenLabel(commandToken);
    if (
      cwdLabel &&
      cwdLabel !== "/" &&
      cwdLabel.toLowerCase() !== commandToken.toLowerCase()
    ) {
      return `${commandLabel} - ${cwdLabel}`;
    }
    return commandLabel;
  }

  if (cwdLabel && cwdLabel !== "/") return cwdLabel;
  return input.persistent ? "Persistent Shell" : "Shell";
}

function sessionSidebarOrderValue(input: { sidebarOrder?: number | null; createdAt: number }): number {
  return typeof input.sidebarOrder === "number" && Number.isFinite(input.sidebarOrder)
    ? input.sidebarOrder
    : input.createdAt;
}

function compareSessionsForSidebar(
  a: Pick<Session, "pinned" | "sidebarOrder" | "createdAt" | "name" | "id">,
  b: Pick<Session, "pinned" | "sidebarOrder" | "createdAt" | "name" | "id">,
): number {
  const aPinned = Boolean(a.pinned);
  const bPinned = Boolean(b.pinned);
  if (aPinned !== bPinned) return aPinned ? -1 : 1;

  const byOrder = sessionSidebarOrderValue(a) - sessionSidebarOrderValue(b);
  if (byOrder !== 0) return byOrder;

  const byCreatedAt = a.createdAt - b.createdAt;
  if (byCreatedAt !== 0) return byCreatedAt;

  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;

  return a.id.localeCompare(b.id);
}

function sortProjectSessionsForSidebar(sessions: Session[], projectId: string): Session[] {
  return sessions
    .filter((session) => session.projectId === projectId)
    .slice()
    .sort(compareSessionsForSidebar);
}

function normalizeProjectSessionLayout(projectSessions: Session[]): Session[] {
  return projectSessions.map((session, index) => {
    const nextPinned = Boolean(session.pinned);
    if (nextPinned === Boolean(session.pinned) && (session.sidebarOrder ?? null) === index) {
      return session;
    }
    return {
      ...session,
      pinned: nextPinned,
      sidebarOrder: index,
    };
  });
}

function mergeProjectSessionLayout(
  sessions: Session[],
  projectId: string,
  projectSessions: Session[],
): Session[] {
  const byId = new Map(projectSessions.map((session) => [session.id, session] as const));
  let changed = false;
  const next = sessions.map((session) => {
    if (session.projectId !== projectId) return session;
    const replacement = byId.get(session.id);
    if (!replacement) return session;
    if (
      Boolean(session.pinned) === Boolean(replacement.pinned) &&
      (session.sidebarOrder ?? null) === (replacement.sidebarOrder ?? null)
    ) {
      return session;
    }
    changed = true;
    return replacement;
  });
  return changed ? next : sessions;
}

function isProjectSsh(project: Project | null | undefined): boolean {
  return Boolean(project?.sshTarget?.trim());
}

function buildSshCommandAtRemoteDir(input: {
  baseCommandLine: string | null;
  target: string;
  remoteDir: string;
}): string {
  const target = input.target.trim();
  const remoteDir = input.remoteDir.trim();
  const base = input.baseCommandLine?.trim() ?? "";

  const parts = base && isSshCommandLine(base) ? base.split(/\s+/).filter(Boolean) : [];
  const program = parts[0] ?? "ssh";

  // Best-effort reuse of SSH options from the current session's command line.
  // IMPORTANT: Never assume the last token is the target; SSH commands may already include a remote command.
  const idxTarget = parts.findIndex((p) => p === target);
  const optionsRaw = idxTarget > 0 ? parts.slice(1, idxTarget) : [];
  const options = optionsRaw.filter(
    (tok) => tok !== "-N" && tok !== "-n" && tok !== "-f" && tok !== "-T" && tok !== "-t" && tok !== "-tt",
  );

  const script = `cd -- "$1" 2>/dev/null || echo "cd failed: $1" >&2; exec "\${SHELL:-sh}"`;
  const remoteCommand = `sh -lc ${shellEscapePosix(script)} -- ${shellEscapePosix(remoteDir)}`;
  // IMPORTANT: pass the remote command as a *single* ssh argument so remote quoting survives.
  const remoteCommandArg = shellEscapePosix(remoteCommand);

  return ensureSshKeepAliveOptions([program, ...options, "-t", target, remoteCommandArg].join(" ")) ?? "ssh";
}

// Build an SSH command that opens the project's remote host, cd's into the
// project's remote root dir, runs an agent (claude/codex/…) in the user's
// interactive shell (so PATH from the shell rc is available), and drops back to
// an interactive shell when the agent exits — i.e. the SSH equivalent of the
// local "quick start an agent" flow.
function buildSshAgentCommandAtRemoteDir(input: {
  target: string;
  remoteDir: string;
  agentCommand: string;
}): string {
  const target = input.target.trim();
  const remoteDir = input.remoteDir.trim();
  const agentCommand = input.agentCommand.trim();
  // Literal text for the remote shell to expand (NOT interpolated locally).
  const SH = "${SHELL:-sh}";
  const cdPart = remoteDir
    ? `cd -- ${shellEscapePosix(remoteDir)} 2>/dev/null || echo ${shellEscapePosix(
        `cd failed: ${remoteDir}`,
      )} >&2; `
    : "";
  // Runs inside the remote interactive shell ($SHELL -ic): cd, run agent, fall
  // back to an interactive shell when it exits.
  const innerScript = `${cdPart}${agentCommand}; exec "${SH}"`;
  const remoteCommand = `"${SH}" -ic ${shellEscapePosix(innerScript)}`;
  return (
    ensureSshKeepAliveOptions(`ssh -t ${target} ${shellEscapePosix(remoteCommand)}`) ??
    `ssh ${target}`
  );
}

function isSshCommandLine(commandLine: string | null | undefined): boolean {
  const trimmed = commandLine?.trim() ?? "";
  if (!trimmed) return false;
  const token = trimmed.split(/\s+/)[0];
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.toLowerCase().replace(/\.exe$/, "") === "ssh";
}

function shouldTrackLaunchCommandAsRunning(
  commandLine: string | null | undefined,
  persistent: boolean,
): boolean {
  if (persistent) return false;
  const trimmed = commandLine?.trim() ?? "";
  if (!trimmed) return false;
  if (isSshCommandLine(trimmed)) return false;
  const token = commandTagFromCommandLine(trimmed);
  if (!token) return false;
  return !new Set([
    "bash",
    "sh",
    "zsh",
    "fish",
    "nu",
    "pwsh",
    "powershell",
    "cmd",
    "tmux",
    "screen",
    "zellij",
  ]).has(token);
}

function hasSshOption(parts: string[], keyLower: string): boolean {
  for (let i = 1; i < parts.length; i += 1) {
    const token = parts[i];
    const tokenLower = token.toLowerCase();
    if (tokenLower.startsWith("-o")) {
      if (tokenLower === "-o") {
        const value = (parts[i + 1] ?? "").trim().toLowerCase();
        if (value.startsWith(`${keyLower}=`)) return true;
        i += 1;
        continue;
      }
      const value = token.slice(2).trim().toLowerCase();
      if (value.startsWith(`${keyLower}=`)) return true;
    }
  }
  return false;
}

function ensureSshKeepAliveOptions(commandLine: string | null | undefined): string | null {
  const trimmed = commandLine?.trim() ?? "";
  if (!trimmed) return null;
  if (!isSshCommandLine(trimmed)) return trimmed;

  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return trimmed;

  // Keep the connection alive across brief network pauses (Wi-Fi power-save when
  // the display turns off, VPN re-handshakes, roaming) so the session doesn't
  // drop and force a reconnect. A probe every 15s keeps the server's idle timer
  // and any NAT/firewall state fresh; tolerating 6 missed probes (~90s of
  // silence) survives moderate pauses. A full system sleep takes the network
  // down for minutes and will still drop — the auto-reconnect on exit covers
  // that. Bumping CountMax also slows detection of a truly-dead link, which is
  // an acceptable trade now that reconnect is automatic.
  const inject: string[] = [];
  if (!hasSshOption(parts, "serveraliveinterval")) inject.push("-o", "ServerAliveInterval=15");
  if (!hasSshOption(parts, "serveralivecountmax")) inject.push("-o", "ServerAliveCountMax=6");
  if (!hasSshOption(parts, "tcpkeepalive")) inject.push("-o", "TCPKeepAlive=yes");
  if (inject.length === 0) return trimmed;

  return [parts[0], ...inject, ...parts.slice(1)].join(" ");
}

function sshTargetFromCommandLine(commandLine: string | null | undefined): string | null {
  const trimmed = commandLine?.trim() ?? "";
  if (!trimmed) return null;
  if (!isSshCommandLine(trimmed)) return null;
  const parts = trimmed.split(/\s+/);
  const target = parts[parts.length - 1]?.trim() ?? "";
  return target ? target : null;
}

function sshTargetFromSessionName(name: string | null | undefined): string | null {
  const trimmed = name?.trim() ?? "";
  if (!trimmed) return null;
  if (!/^ssh\s+/i.test(trimmed)) return null;
  const remainder = trimmed.replace(/^ssh\s+/i, "");
  const target = remainder.split(":")[0]?.trim() ?? "";
  return target ? target : null;
}

function isSshSession(session: {
  sshTarget?: string | null;
  launchCommand?: string | null;
  restoreCommand?: string | null;
} | null | undefined): boolean {
  if (!session) return false;
  return (
    Boolean((session.sshTarget ?? "").trim()) ||
    isSshCommandLine(session.launchCommand ?? session.restoreCommand ?? null)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasSystemHealthStats(stats: SystemHealthStats | null | undefined): stats is SystemHealthStats {
  if (!stats) return false;
  return (
    isFiniteNumber(stats.cpuPercent) ||
    isFiniteNumber(stats.memoryUsedBytes) ||
    isFiniteNumber(stats.memoryFreeBytes) ||
    isFiniteNumber(stats.diskUsedBytes) ||
    isFiniteNumber(stats.diskFreeBytes)
  );
}

// Exact field comparison so an unchanged poll result (common while idle / when
// CPU% holds steady) can bail the state update entirely instead of re-running
// App's body every few seconds. Compares every field buildSystemHealthDisplay
// reads — cpuPercent plus all six byte fields (the *Total fields feed tooltips).
// Object.is so a steady NaN doesn't read as a perpetual change.
function sameHealthStats(a: SystemHealthStats | null, b: SystemHealthStats | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    Object.is(a.cpuPercent, b.cpuPercent) &&
    Object.is(a.memoryUsedBytes, b.memoryUsedBytes) &&
    Object.is(a.memoryFreeBytes, b.memoryFreeBytes) &&
    Object.is(a.memoryTotalBytes, b.memoryTotalBytes) &&
    Object.is(a.diskUsedBytes, b.diskUsedBytes) &&
    Object.is(a.diskFreeBytes, b.diskFreeBytes) &&
    Object.is(a.diskTotalBytes, b.diskTotalBytes)
  );
}

function formatHealthBytes(bytes: number | null | undefined): string | null {
  if (!isFiniteNumber(bytes) || bytes < 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

function buildSystemHealthDisplay(stats: SystemHealthStats | null): SystemHealthDisplayItem[] {
  if (!hasSystemHealthStats(stats)) return [];

  const items: SystemHealthDisplayItem[] = [];
  if (isFiniteNumber(stats.cpuPercent)) {
    const rounded = Math.round(stats.cpuPercent);
    items.push({
      key: "cpu",
      label: "CPU",
      value: `${rounded}%`,
      title: `CPU usage: ${stats.cpuPercent.toFixed(1)}%`,
    });
  }

  const memoryUsed = formatHealthBytes(stats.memoryUsedBytes);
  const memoryFree = formatHealthBytes(stats.memoryFreeBytes);
  if (memoryUsed && memoryFree) {
    const memoryTotal = formatHealthBytes(stats.memoryTotalBytes);
    items.push({
      key: "memory",
      label: "MEM",
      value: `${memoryUsed} used / ${memoryFree} free`,
      title: `Memory: ${memoryUsed} used, ${memoryFree} free${memoryTotal ? `, ${memoryTotal} total` : ""}`,
    });
  }

  const diskUsed = formatHealthBytes(stats.diskUsedBytes);
  const diskFree = formatHealthBytes(stats.diskFreeBytes);
  if (diskUsed && diskFree) {
    const diskTotal = formatHealthBytes(stats.diskTotalBytes);
    items.push({
      key: "disk",
      label: "DISK",
      value: `${diskUsed} used / ${diskFree} free`,
      title: `Disk: ${diskUsed} used, ${diskFree} free${diskTotal ? `, ${diskTotal} total` : ""}`,
    });
  }

  return items;
}

// Self-contained so the 5s poll re-renders only this span, not the whole App
// (setSystemHealthStats used to live at App's top level, re-running every memo
// in the 11k-line component on each tick).
const SystemHealthIndicator = React.memo(function SystemHealthIndicator(props: {
  hydrated: boolean;
  sessionId: string | null;
  isSsh: boolean;
  sshTarget: string | null;
  connectionState: string;
}) {
  const { hydrated, sessionId, isSsh, sshTarget, connectionState } = props;
  const [stats, setStats] = useState<SystemHealthStats | null>(null);

  useEffect(() => {
    if (!hydrated || !sessionId) {
      setStats(null);
      return;
    }

    const target = sshTarget?.trim() ?? "";
    if (isSsh && (!target || connectionState !== "connected")) {
      setStats(null);
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let interval: number | null = null;

    const refresh = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const next = isSsh
          ? await invoke<SystemHealthStats | null>("ssh_system_health_stats", { target })
          : await invoke<SystemHealthStats | null>("system_health_stats");
        if (!cancelled) {
          const normalized = hasSystemHealthStats(next) ? next : null;
          setStats((prev) => (sameHealthStats(prev, normalized) ? prev : normalized));
        }
      } catch {
        if (!cancelled) setStats(null);
      } finally {
        inFlight = false;
      }
    };

    // Only poll while the window is visible: a backgrounded window issuing a
    // backend IPC (and, for SSH, a remote command that wakes the radio + host)
    // every few seconds defeats App Nap. On returning to visible we refresh
    // immediately, so the status-bar snapshot is at most one tick stale.
    const startPolling = () => {
      if (interval !== null) return;
      void refresh();
      interval = window.setInterval(() => {
        void refresh();
      }, SYSTEM_HEALTH_REFRESH_MS);
    };
    const stopPolling = () => {
      if (interval !== null) {
        window.clearInterval(interval);
        interval = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") startPolling();
      else stopPolling();
    };

    if (document.visibilityState === "visible") startPolling();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [connectionState, sessionId, isSsh, sshTarget, hydrated]);

  const items = useMemo(() => buildSystemHealthDisplay(stats), [stats]);
  if (items.length === 0) return null;
  return (
    <span className="systemHealthStats" aria-label="System health">
      {items.map((item) => (
        <span key={item.key} className="systemHealthItem" title={item.title}>
          <span className="systemHealthLabel">{item.label}</span>
          <span className="systemHealthValue">{item.value}</span>
        </span>
      ))}
    </span>
  );
});

type SessionActivityState = {
  effect: ProcessEffect | null;
  command: string | null;
  processTag: string | null;
  isAgentWorking: boolean;
  isRunningCommand: boolean;
  isRecording: boolean;
  isReconnecting: boolean;
  isDisconnected: boolean;
  isActive: boolean;
};

function getSessionActivityState(
  session: Session,
  agentWorkingIds: ReadonlySet<string>,
): SessionActivityState {
  const inactive =
    Boolean(session.exited) ||
    Boolean(session.closing);
  const connectionState = session.connectionState ?? "connected";
  const launchOrRestore =
    session.launchCommand ??
    (session.restoreCommand?.trim() ? session.restoreCommand.trim() : null) ??
    null;
  const activeCommand = session.runningCommand?.trim() || "";
  const command =
    activeCommand ||
    (launchOrRestore?.trim() || "") ||
    "";
  const processTag =
    session.processTag?.trim() ||
    commandTagFromCommandLine(activeCommand || launchOrRestore || null) ||
    null;
  const sessionEffect =
    getProcessEffectById(session.effectId) ??
    detectProcessEffect({ command: launchOrRestore, name: session.name });
  const effect =
    detectProcessEffect({ command: command || null, name: null }) ??
    sessionEffect;
  const isConnected = connectionState !== "reconnecting" && connectionState !== "disconnected";
  const isAgentWorking = !inactive && isConnected && Boolean(sessionEffect) && agentWorkingIds.has(session.id);
  const isRunningCommand = !inactive && isConnected && Boolean(activeCommand);
  const isRecording = !inactive && isConnected && Boolean(session.recordingActive);
  const isReconnecting = !inactive && connectionState === "reconnecting" && isSshSession(session);
  const isDisconnected =
    !inactive &&
    connectionState === "disconnected" &&
    Boolean(session.manualReconnectAvailable) &&
    isSshSession(session);

  return {
    effect,
    command: command || null,
    processTag,
    isAgentWorking,
    isRunningCommand,
    isRecording,
    isReconnecting,
    isDisconnected,
    isActive: isAgentWorking || isRecording || isReconnecting,
  };
}

function reconnectDelayMsForAttempt(attempt: number): number {
  const bounded = Math.max(1, attempt);
  const exp = bounded - 1;
  return Math.min(SSH_RECONNECT_MAX_MS, SSH_RECONNECT_BASE_MS * 2 ** exp);
}

function parseEnvContentToVars(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const normalized = normalizeSmartQuotes(content);
  for (const rawLine of normalized.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();

    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!isValidEnvKey(key)) continue;

    let value = line.slice(eq + 1).trim();
    if (!value) {
      out[key] = "";
      continue;
    }

    const first = value[0];
    const last = value[value.length - 1];
    const isDouble = first === '"' && last === '"';
    const isSingle = first === "'" && last === "'";
    if (isDouble || isSingle) {
      value = value.slice(1, -1);
      if (isDouble) value = unescapeDoubleQuotedEnvValue(value);
      out[key] = value;
      continue;
    }

    // Strip trailing comments for unquoted values when preceded by whitespace.
    for (let i = 0; i < value.length; i++) {
      if (value[i] !== "#") continue;
      if (i === 0 || /\s/.test(value[i - 1])) {
        value = value.slice(0, i).trimEnd();
        break;
      }
    }
    out[key] = value;
  }
  return out;
}

function envVarsForProjectId(
  projectId: string,
  projects: Project[],
  environments: EnvironmentConfig[],
): Record<string, string> | null {
  const project = projects.find((p) => p.id === projectId) ?? null;
  const envId = project?.environmentId ?? null;
  if (!envId) return null;
  const env = environments.find((e) => e.id === envId) ?? null;
  if (!env) return null;
  const vars = parseEnvContentToVars(env.content);
  return Object.keys(vars).length ? vars : null;
}

function defaultProjectState(): { projects: Project[]; activeProjectId: string } {
  const id = makeId();
  return {
    projects: [{ id, title: "Default", basePath: null, environmentId: null, assetsEnabled: true }],
    activeProjectId: id,
  };
}

function defaultWorkspaceState(): PersistedWorkspacesV1 {
  const id = makeId();
  return {
    schemaVersion: 1,
    workspaces: [{ id, name: "Workspace" }],
    activeWorkspaceId: id,
    projectWorkspace: {},
  };
}

function loadWorkspaceState(): PersistedWorkspacesV1 {
  try {
    const raw = localStorage.getItem(STORAGE_WORKSPACES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedWorkspacesV1>;
      const workspaces = Array.isArray(parsed.workspaces)
        ? parsed.workspaces.filter(
            (w): w is Workspace => Boolean(w) && typeof w.id === "string" && typeof w.name === "string",
          )
        : [];
      if (workspaces.length) {
        const activeWorkspaceId =
          typeof parsed.activeWorkspaceId === "string" &&
          workspaces.some((w) => w.id === parsed.activeWorkspaceId)
            ? parsed.activeWorkspaceId
            : workspaces[0].id;
        const projectWorkspace =
          parsed.projectWorkspace && typeof parsed.projectWorkspace === "object"
            ? (parsed.projectWorkspace as Record<string, string>)
            : {};
        return { schemaVersion: 1, workspaces, activeWorkspaceId, projectWorkspace };
      }
    }
  } catch {
    // ignore — fall through to default
  }
  return defaultWorkspaceState();
}

type PersistedSession = {
  persistId: string;
  projectId: string;
  name: string;
  pinned?: boolean;
  sidebarOrder?: number | null;
  launchCommand: string | null;
  restoreCommand?: string | null;
  sshTarget?: string | null;
  sshRootDir?: string | null;
  lastRecordingId?: string | null;
  cwd: string | null;
  persistent?: boolean;
  symbol?: string | null;
  color?: string | null;
  createdAt: number;
};

type SecureStorageMode = "keychain" | "plaintext";

type PersistedStateV1 = {
  schemaVersion: number;
  secureStorageMode?: SecureStorageMode;
  projects: Project[];
  activeProjectId: string;
  sessions: PersistedSession[];
  activeSessionByProject: Record<string, string>;
  prompts?: Prompt[];
  environments?: EnvironmentConfig[];
  assets?: AssetTemplate[];
  assetSettings?: AssetSettings;
  agentShortcutIds?: string[];
};

type PersistedStateMetaV1 = {
  schemaVersion: number;
  environmentCount: number;
  encryptedEnvironmentCount: number;
  secureStorageMode?: SecureStorageMode;
};

type DirectoryEntry = { name: string; path: string };
type DirectoryListing = { path: string; parent: string | null; entries: DirectoryEntry[] };

type PersistentSessionInfo = { persistId: string; sessionName: string };

type Prompt = {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  pinned?: boolean;
  pinOrder?: number;
};

type EnvironmentConfig = {
  id: string;
  name: string;
  content: string;
  createdAt: number;
};

type AssetTemplate = {
  id: string;
  name: string;
  relativePath: string;
  content: string;
  createdAt: number;
  autoApply?: boolean;
};

type AssetSettings = {
  autoApplyEnabled: boolean;
};

type ApplyAssetTarget = "project" | "tab";

type ApplyAssetRequest = {
  assetId: string;
  target: ApplyAssetTarget;
  dir: string;
};

type RecordingMeta = {
  schemaVersion: number;
  createdAt: number;
  name?: string | null;
  projectId: string;
  sessionPersistId: string;
  cwd: string | null;
  effectId?: string | null;
  bootstrapCommand?: string | null;
  encrypted?: boolean | null;
};

type RecordingEvent = { t: number; data: string };

type LoadedRecording = {
  recordingId: string;
  meta: RecordingMeta | null;
  events: RecordingEvent[];
};

type RecordingIndexEntry = {
  recordingId: string;
  meta: RecordingMeta | null;
};

function toPersistedSession(session: Session): PersistedSession {
  return {
    persistId: session.persistId,
    projectId: session.projectId,
    name: session.name,
    pinned: Boolean(session.pinned),
    sidebarOrder: session.sidebarOrder ?? null,
    launchCommand: session.launchCommand,
    restoreCommand: session.restoreCommand ?? null,
    sshTarget: session.sshTarget ?? null,
    sshRootDir: session.sshRootDir ?? null,
    lastRecordingId: session.lastRecordingId ?? null,
    cwd: session.cwd,
    persistent: session.persistent,
    symbol: session.symbol ?? null,
    color: session.color ?? null,
    createdAt: session.createdAt,
  };
}

function persistedSessionEquals(a: PersistedSession, b: PersistedSession): boolean {
  return (
    a.persistId === b.persistId &&
    a.projectId === b.projectId &&
    a.name === b.name &&
    a.launchCommand === b.launchCommand &&
    (a.restoreCommand ?? null) === (b.restoreCommand ?? null) &&
    (a.sshTarget ?? null) === (b.sshTarget ?? null) &&
    (a.sshRootDir ?? null) === (b.sshRootDir ?? null) &&
    (a.lastRecordingId ?? null) === (b.lastRecordingId ?? null) &&
    a.cwd === b.cwd &&
    Boolean(a.persistent) === Boolean(b.persistent) &&
    Boolean(a.pinned) === Boolean(b.pinned) &&
    (a.sidebarOrder ?? null) === (b.sidebarOrder ?? null) &&
    (a.symbol ?? null) === (b.symbol ?? null) &&
    (a.color ?? null) === (b.color ?? null) &&
    a.createdAt === b.createdAt
  );
}

function persistedSessionsEqual(a: PersistedSession[], b: PersistedSession[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!persistedSessionEquals(a[i], b[i])) return false;
  }
  return true;
}

function loadLegacyPersistedSessions(): PersistedSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_SESSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is PersistedSession => {
        if (!s || typeof s !== "object") return false;
        const rec = s as Record<string, unknown>;
        return (
          typeof rec.persistId === "string" &&
          typeof rec.projectId === "string" &&
          typeof rec.name === "string" &&
          (rec.launchCommand === null || typeof rec.launchCommand === "string") &&
          (rec.cwd === undefined || rec.cwd === null || typeof rec.cwd === "string") &&
          typeof rec.createdAt === "number"
        );
      })
      .map((s) => ({
        persistId: s.persistId,
        projectId: s.projectId,
        name: s.name,
        pinned: false,
        sidebarOrder: s.createdAt,
        launchCommand: s.launchCommand,
        restoreCommand: null,
        lastRecordingId: null,
        cwd: s.cwd ?? null,
        createdAt: s.createdAt,
      }));
  } catch {
    return [];
  }
}

function dedupePersistedSessions(input: PersistedSession[]): PersistedSession[] {
  const sorted = input.slice().sort((a, b) => a.createdAt - b.createdAt);
  const byKey = new Map<string, PersistedSession>();
  for (const session of sorted) {
    const persistId = (session.persistId ?? "").trim();
    if (!persistId) continue;
    const key = session.persistent
      ? `persistent:${persistId}`
      : `session:${session.projectId}:${persistId}`;
    if (!byKey.has(key)) byKey.set(key, session);
  }
  return Array.from(byKey.values());
}

function loadLegacyActiveSessionByProject(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_ACTIVE_SESSION_BY_PROJECT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === "string" && typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

type SplitViewsStorageV1 = {
  schemaVersion: 1;
  views: SplitView[];
};

function coerceSplitView(value: unknown): SplitView | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;

  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  const projectId = typeof rec.projectId === "string" ? rec.projectId.trim() : "";
  const aId = typeof rec.aId === "string" ? rec.aId.trim() : "";
  const bId = typeof rec.bId === "string" ? rec.bId.trim() : "";
  const direction = rec.direction === "horizontal" || rec.direction === "vertical" ? rec.direction : null;
  const ratioRaw = typeof rec.ratio === "number" && Number.isFinite(rec.ratio) ? rec.ratio : NaN;
  const createdAt = typeof rec.createdAt === "number" && Number.isFinite(rec.createdAt) ? rec.createdAt : Date.now();

  if (!id || !projectId || !aId || !bId || aId === bId || !direction) return null;

  const ratio = Math.max(0.15, Math.min(0.85, Number.isFinite(ratioRaw) ? ratioRaw : 0.5));

  const lastRaw = typeof rec.lastFocusedId === "string" ? rec.lastFocusedId.trim() : "";
  const lastFocusedId = lastRaw === aId || lastRaw === bId ? lastRaw : aId;

  return {
    id,
    projectId,
    aId,
    bId,
    direction,
    ratio,
    createdAt,
    lastFocusedId,
  };
}

function loadPersistedSplitViews(): SplitView[] {
  try {
    const raw = localStorage.getItem(STORAGE_SPLIT_VIEWS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return [];
    const rec = parsed as Partial<SplitViewsStorageV1> & Record<string, unknown>;
    if (rec.schemaVersion !== 1 || !Array.isArray(rec.views)) return [];
    const out: SplitView[] = [];
    for (const v of rec.views) {
      const coerced = coerceSplitView(v);
      if (coerced) out.push(coerced);
      if (out.length >= 60) break;
    }
    return out;
  } catch {
    return [];
  }
}

function persistSplitViews(views: SplitView[]) {
  try {
    const payload: SplitViewsStorageV1 = { schemaVersion: 1, views: views.slice(0, 60) };
    localStorage.setItem(STORAGE_SPLIT_VIEWS_KEY, JSON.stringify(payload));
  } catch {
    // Best-effort.
  }
}

function loadLegacyProjectState(): { projects: Project[]; activeProjectId: string } | null {
  let projects: Project[] = [];
  try {
    const raw = localStorage.getItem(STORAGE_PROJECTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        projects = parsed
          .filter(
            (p): p is { id: string; title: string } =>
              Boolean(p) &&
              typeof (p as { id?: unknown }).id === "string" &&
              typeof (p as { title?: unknown }).title === "string",
          )
          .map((p) => ({
            id: p.id,
            title: p.title,
            basePath: null,
            environmentId: null,
            assetsEnabled: true,
            symbol: (p as { symbol?: string | null }).symbol ?? null,
            color: (p as { color?: string | null }).color ?? null,
            sshTarget: (p as { sshTarget?: string | null }).sshTarget ?? null,
            sshRemotePath: (p as { sshRemotePath?: string | null }).sshRemotePath ?? null,
          }));
      }
    }
  } catch {
    projects = [];
  }

  if (projects.length === 0) return null;

  let activeProjectId: string | null = null;
  try {
    activeProjectId = localStorage.getItem(STORAGE_ACTIVE_PROJECT_KEY);
  } catch {
    activeProjectId = null;
  }

  if (!activeProjectId || !projects.some((p) => p.id === activeProjectId)) {
    activeProjectId = projects[0].id;
  }

  return { projects, activeProjectId };
}

type WorkspaceViewStorageV1 = {
  schemaVersion: 1;
  views: Record<string, StoredWorkspaceViewV1>;
};

type StoredWorkspaceViewV1 = {
  projectId: string;
  fileExplorerOpen?: boolean;
  fileExplorerRootDir?: string | null;
  fileExplorerPersistedState?: FileExplorerPersistedState | null;
  codeEditorOpen?: boolean;
  codeEditorRootDir?: string | null;
  codeEditorActiveFilePath?: string | null;
  codeEditorPersistedState?: CodeEditorPersistedState | null;
};

function projectIdFromWorkspaceKey(workspaceKey: string): string | null {
  const key = workspaceKey.trim();
  if (!key) return null;
  if (!key.startsWith("ssh:")) return key;
  const rest = key.slice("ssh:".length);
  const idx = rest.indexOf(":");
  if (idx <= 0) return null;
  return rest.slice(0, idx);
}

function coerceFileExplorerPersistedState(
  value: unknown,
  rootOverride: string | null,
): FileExplorerPersistedState | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  const root =
    (typeof rootOverride === "string" && rootOverride.trim()) ||
    (typeof rec.root === "string" && rec.root.trim()) ||
    "";
  if (!root) return null;

  const expandedDirs = Array.isArray(rec.expandedDirs)
    ? rec.expandedDirs.filter((x): x is string => typeof x === "string").slice(0, 400)
    : [];

  const scrollTop =
    typeof rec.scrollTop === "number" && Number.isFinite(rec.scrollTop) ? Math.max(0, rec.scrollTop) : 0;

  return { root, expandedDirs, dirStateByPath: {}, scrollTop };
}

function coerceCodeEditorPersistedState(value: unknown): CodeEditorPersistedState | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  const rawTabs = rec.tabs;
  if (!Array.isArray(rawTabs)) return null;

  const tabs = rawTabs
    .filter((t): t is { path: unknown } => Boolean(t) && typeof t === "object" && "path" in (t as object))
    .map((t) => {
      const rec = t as Record<string, unknown>;
      const path = typeof rec.path === "string" ? rec.path.trim() : "";
      const viewerKind: CodeEditorPersistedState["tabs"][number]["viewerKind"] =
        rec.viewerKind === "largeText" ||
        rec.viewerKind === "image" ||
        rec.viewerKind === "bytes" ||
        rec.viewerKind === "text" ||
        rec.viewerKind === "xlsx"
          ? rec.viewerKind
          : null;
      return { path, viewerKind };
    })
    .filter((it) => Boolean(it.path))
    .slice(0, 40)
    .map(({ path, viewerKind }) => ({ path, dirty: false, content: null, viewerKind }));

  if (tabs.length === 0) return null;

  const desiredActive = typeof rec.activePath === "string" ? rec.activePath.trim() : "";
  const activePath =
    (desiredActive && tabs.some((t) => t.path === desiredActive) && desiredActive) || tabs[0]?.path || null;

  return { tabs, activePath };
}

function sanitizeFileExplorerPersistedStateForStorage(
  state: FileExplorerPersistedState | null,
  rootOverride: string | null,
): FileExplorerPersistedState | null {
  if (!state) return null;
  return coerceFileExplorerPersistedState(state, rootOverride);
}

function sanitizeCodeEditorPersistedStateForStorage(
  state: CodeEditorPersistedState | null,
): CodeEditorPersistedState | null {
  if (!state) return null;
  return coerceCodeEditorPersistedState(state);
}

function shouldPersistWorkspaceView(view: WorkspaceView): boolean {
  if (!view.fileExplorerOpen) return true;
  if (view.fileExplorerRootDir) return true;
  if (view.fileExplorerPersistedState) return true;
  if (view.codeEditorOpen) return true;
  if (view.codeEditorRootDir) return true;
  if (view.codeEditorPersistedState) return true;
  if (view.codeEditorActiveFilePath) return true;
  return false;
}

function loadWorkspaceViewStorageV1(): WorkspaceViewStorageV1 | null {
  try {
    const raw = localStorage.getItem(STORAGE_WORKSPACE_VIEW_BY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if ((parsed as { schemaVersion?: unknown }).schemaVersion !== 1) return null;

    const viewsRaw = (parsed as { views?: unknown }).views;
    if (!viewsRaw || typeof viewsRaw !== "object") return null;

    const out: Record<string, StoredWorkspaceViewV1> = {};
    for (const [workspaceKey, value] of Object.entries(viewsRaw as Record<string, unknown>)) {
      if (!workspaceKey || !value || typeof value !== "object") continue;
      const rec = value as Record<string, unknown>;
      const projectId =
        (typeof rec.projectId === "string" && rec.projectId.trim()) || projectIdFromWorkspaceKey(workspaceKey);
      if (!projectId) continue;

      const fileExplorerRootDir =
        rec.fileExplorerRootDir === null || typeof rec.fileExplorerRootDir === "string"
          ? (rec.fileExplorerRootDir as string | null)
          : null;
      const codeEditorRootDir =
        rec.codeEditorRootDir === null || typeof rec.codeEditorRootDir === "string"
          ? (rec.codeEditorRootDir as string | null)
          : null;

      out[workspaceKey] = {
        projectId,
        fileExplorerOpen: typeof rec.fileExplorerOpen === "boolean" ? rec.fileExplorerOpen : undefined,
        fileExplorerRootDir,
        fileExplorerPersistedState: coerceFileExplorerPersistedState(
          rec.fileExplorerPersistedState,
          fileExplorerRootDir ?? codeEditorRootDir,
        ),
        codeEditorOpen: typeof rec.codeEditorOpen === "boolean" ? rec.codeEditorOpen : undefined,
        codeEditorRootDir,
        codeEditorActiveFilePath:
          rec.codeEditorActiveFilePath === null || typeof rec.codeEditorActiveFilePath === "string"
            ? (rec.codeEditorActiveFilePath as string | null)
            : null,
        codeEditorPersistedState: coerceCodeEditorPersistedState(rec.codeEditorPersistedState),
      };
    }

    return { schemaVersion: 1, views: out };
  } catch {
    return null;
  }
}

function buildWorkspaceViewStorageV1(
  workspaceViewByKey: Record<string, WorkspaceView>,
  validProjectIds: Set<string>,
): WorkspaceViewStorageV1 {
  const entries: Array<[string, StoredWorkspaceViewV1]> = [];
  for (const [workspaceKey, view] of Object.entries(workspaceViewByKey)) {
    if (!view) continue;
    if (!shouldPersistWorkspaceView(view)) continue;

    const projectId = projectIdFromWorkspaceKey(workspaceKey) ?? view.projectId;
    if (!projectId || !validProjectIds.has(projectId)) continue;

    const rootOverride = view.fileExplorerRootDir ?? view.codeEditorRootDir ?? null;
    entries.push([
      workspaceKey,
      {
        projectId,
        fileExplorerOpen: view.fileExplorerOpen,
        fileExplorerRootDir: view.fileExplorerRootDir ?? null,
        fileExplorerPersistedState: sanitizeFileExplorerPersistedStateForStorage(
          view.fileExplorerPersistedState,
          rootOverride,
        ),
        codeEditorOpen: view.codeEditorOpen,
        codeEditorRootDir: view.codeEditorRootDir ?? null,
        codeEditorActiveFilePath: view.codeEditorActiveFilePath ?? null,
        codeEditorPersistedState: sanitizeCodeEditorPersistedStateForStorage(view.codeEditorPersistedState),
      },
    ]);
  }

  entries.sort(([a], [b]) => a.localeCompare(b));
  if (entries.length > 200) entries.length = 200;

  return { schemaVersion: 1, views: Object.fromEntries(entries) };
}

async function createSession(input: {
  projectId: string;
  name?: string;
  launchCommand?: string | null;
  restoreCommand?: string | null;
  sshTarget?: string | null;
  sshRootDir?: string | null;
  lastRecordingId?: string | null;
  cwd?: string | null;
  envVars?: Record<string, string> | null;
  persistent?: boolean;
  persistId?: string;
  createdAt?: number;
  pinned?: boolean;
  sidebarOrder?: number | null;
  shellChoice?: ShellChoice | null;
}): Promise<Session> {
  const persistent = input.persistent ?? false;
  const persistId = input.persistId ?? makeId();
  const createdAt = input.createdAt ?? Date.now();

  const trimmedCommand = (input.launchCommand ?? "").trim();
  const launchCommandRaw = persistent ? null : trimmedCommand ? trimmedCommand : null;
  const launchCommand = ensureSshKeepAliveOptions(launchCommandRaw);
  const trimmedRestoreCommand = (input.restoreCommand ?? "").trim();
  const restoreCommandRaw = trimmedRestoreCommand ? trimmedRestoreCommand : null;
  const restoreCommand = ensureSshKeepAliveOptions(restoreCommandRaw)
    ?? (persistent ? null : launchCommand);
  const explicitSshTarget = input.sshTarget?.trim() || null;
  const commandForDetection = launchCommand ?? restoreCommand;
  const isSshSession = Boolean(explicitSshTarget) || isSshCommandLine(commandForDetection);
  const sshTarget = isSshSession
    ? (explicitSshTarget || sshTargetFromCommandLine(commandForDetection))
    : null;
  const sshRootDir = isSshSession ? input.sshRootDir?.trim() || null : null;
  const sessionName = buildSmartSessionName({
    explicitName: input.name ?? null,
    launchCommand,
    restoreCommand,
    sshTarget,
    cwd: input.cwd ?? null,
    persistent,
  });
  const processTag = commandForDetection ? commandTagFromCommandLine(commandForDetection) : null;
  const effect = detectProcessEffect({
    command: commandForDetection,
    name: sessionName,
  });
  const info = await invoke<SessionInfo>("create_session", {
    name: sessionName,
    command: launchCommand,
    cwd: input.cwd ?? null,
    envVars: input.envVars ?? null,
    persistent,
    persistId,
    shellChoice: shellChoiceToPayload(input.shellChoice),
  });
  return {
    ...info,
    projectId: input.projectId,
    persistId,
    persistent,
    createdAt,
    pinned: Boolean(input.pinned),
    sidebarOrder:
      typeof input.sidebarOrder === "number" && Number.isFinite(input.sidebarOrder)
        ? input.sidebarOrder
        : createdAt,
    launchCommand,
    restoreCommand,
    sshTarget,
    sshRootDir,
    lastRecordingId: input.lastRecordingId ?? null,
    recordingActive: false,
    cwd: info.cwd ?? input.cwd ?? null,
    effectId: effect?.id ?? null,
    processTag,
    runningCommand: shouldTrackLaunchCommandAsRunning(launchCommand, persistent) ? launchCommand : null,
    shellChoice: input.shellChoice ?? null,
    connectionState: "connected",
    reconnectAttempt: 0,
    nextReconnectAt: null,
    disconnectReason: null,
    manualReconnectAvailable: false,
  };
}

async function closeSession(id: string): Promise<void> {
  await invoke("close_session", { id });
}

async function detachSession(id: string): Promise<void> {
  await invoke("detach_session", { id });
}

function agentProviderLabel(provider: string | undefined): string {
  return provider === "codex" ? "Codex" : "Claude Code";
}

function buildSessionAgentPrompt(projectId: string, projectTitle: string | null | undefined, instruction: string): string {
  const scope = projectTitle?.trim()
    ? `the project "${projectTitle}" (${projectId})`
    : `project ${projectId}`;

  const preamble = [
    "Use MCP tools only.",
    `1. Call list_sessions with {\"projectId\":\"${projectId}\"}.`,
    "2. For every session in that list, inspect the current terminal output with read_screen and recent terminal history with read_scrollback.",
  ];

  const safety = [
    "",
    "Safety constraints:",
    "- Do not send commands, write to sessions, create or close sessions, edit files, or change projects.",
  ];

  if (instruction === "rename") {
    return [
      `Rename terminal sessions for ${scope}.`,
      "",
      ...preamble,
      "3. Infer a short semantic name that reflects the work currently shown in the terminal.",
      "4. Use rename_session only when the new name is meaningfully better than the current one.",
      "",
      "Naming constraints:",
      "- Keep names in Title Case.",
      "- Prefer 2 to 4 words and keep names under 28 characters.",
      "- Avoid generic names like Terminal, Shell, Session, Codex, Claude, Working, or Untitled.",
      "- If a session is empty, ambiguous, or already clearly named, leave it unchanged.",
      ...safety,
      "",
      "Return a brief summary of renamed sessions and skipped sessions.",
    ].join("\n");
  }

  if (instruction === "reorder") {
    return [
      `Reorder terminal sessions for ${scope}.`,
      "",
      ...preamble,
      "3. Determine a logical order based on the purpose, activity, and relationships between sessions.",
      "4. Use reorder_session to move sessions into the determined order.",
      "",
      "Ordering guidelines:",
      "- Group related sessions together (e.g. server + client, build + test).",
      "- Place primary/active sessions before secondary/idle ones.",
      "- Pin important long-running sessions if appropriate.",
      ...safety,
      "",
      "Return a brief summary of the new order.",
    ].join("\n");
  }

  if (instruction === "rename-and-reorder") {
    return [
      `Rename and reorder terminal sessions for ${scope}.`,
      "",
      ...preamble,
      "3. First rename: infer a short semantic name that reflects the work currently shown. Use rename_session only when the new name is meaningfully better.",
      "4. Then reorder: arrange sessions in a logical order based on purpose and relationships. Use reorder_session to apply.",
      "",
      "Naming constraints:",
      "- Keep names in Title Case.",
      "- Prefer 2 to 4 words and keep names under 28 characters.",
      "- Avoid generic names like Terminal, Shell, Session, Codex, Claude, Working, or Untitled.",
      "- If a session is empty, ambiguous, or already clearly named, leave it unchanged.",
      "",
      "Ordering guidelines:",
      "- Group related sessions together.",
      "- Place primary/active sessions before secondary/idle ones.",
      ...safety,
      "",
      "Return a brief summary of changes.",
    ].join("\n");
  }

  // Custom instruction
  return [
    `Perform the following task on terminal sessions for ${scope}:`,
    "",
    instruction,
    "",
    ...preamble,
    "3. Follow the user instruction above using available MCP tools (rename_session, reorder_session, etc.).",
    ...safety,
    "",
    "Return a brief summary of what you did.",
  ].join("\n");
}

export default function App() {
  const [initialProjectState] = useState(() => defaultProjectState());
  const [projects, setProjects] = useState<Project[]>(initialProjectState.projects);
  const [activeProjectId, setActiveProjectId] = useState<string>(initialProjectState.activeProjectId);
  const [activeSessionByProject, setActiveSessionByProject] = useState<Record<string, string>>({});
  const [initialWorkspaceState] = useState(() => loadWorkspaceState());
  const [workspaces, setWorkspaces] = useState<Workspace[]>(initialWorkspaceState.workspaces);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(initialWorkspaceState.activeWorkspaceId);
  const [projectWorkspace, setProjectWorkspace] = useState<Record<string, string>>(
    initialWorkspaceState.projectWorkspace,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_SIDEBAR_COLLAPSED_KEY) === "on";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? "on" : "off");
    } catch {
      // Best-effort.
    }
  }, [sidebarCollapsed]);
  const [uiTheme, setUiTheme] = useState<UiTheme>(INITIAL_UI_THEME);
  const uiThemeRef = useRef<UiTheme>(INITIAL_UI_THEME);
  uiThemeRef.current = uiTheme;
  const [autoCaffeinate, setAutoCaffeinate] = useState<boolean>(INITIAL_AUTO_CAFFEINATE);
  // True while the backend holds the keep-awake power assertion.
  const [keepAwakeActive, setKeepAwakeActive] = useState(false);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [agentWorkingIds, setAgentWorkingIds] = useState<ReadonlySet<string>>(EMPTY_STRING_SET);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentConfig[]>([]);
  const [assets, setAssets] = useState<AssetTemplate[]>([]);
  const [assetSettings, setAssetSettings] = useState<AssetSettings>({ autoApplyEnabled: true });
  const [agentShortcutIds, setAgentShortcutIds] = useState<string[]>(DEFAULT_AGENT_SHORTCUT_IDS);
  const [agentShortcutsOpen, setAgentShortcutsOpen] = useState(false);
  const [activityCenterOpen, setActivityCenterOpen] = useState(false);
  const [activityCenterAutoOpenSource, setActivityCenterAutoOpenSource] = useState<"auto-rename" | null>(
    null,
  );
  const activityCenterMenuRef = useRef<HTMLDivElement | null>(null);
  // Shells domain lives in src/stores/shells.ts (App.tsx decomposition).
  const { detectedShells, shellsLoading, appDefaultShell } = useShellsStore();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [splitViews, setSplitViews] = useState<SplitView[]>(() => loadPersistedSplitViews());
  const splitViewsRef = useRef(splitViews);
  useEffect(() => {
    splitViewsRef.current = splitViews;
    persistSplitViews(splitViews);
  }, [splitViews]);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", uiTheme);
    try {
      localStorage.setItem(STORAGE_UI_THEME_KEY, uiTheme);
    } catch {
      // Best-effort: localStorage may be unavailable in some contexts.
    }
  }, [uiTheme]);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_AUTO_CAFFEINATE_KEY, autoCaffeinate ? "on" : "off");
    } catch {
      // Best-effort: localStorage may be unavailable in some contexts.
    }
    // Runs on mount too, syncing the backend (which defaults to enabled) with
    // a persisted "off" before any SSH session can engage the assertion.
    invoke("set_auto_caffeinate", { enabled: autoCaffeinate }).catch(() => {});
  }, [autoCaffeinate]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    listen<boolean>("power-assertion-changed", (event) => {
      setKeepAwakeActive(Boolean(event.payload));
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    if (!activityCenterOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (activityCenterMenuRef.current?.contains(target)) return;
      setActivityCenterOpen(false);
      setActivityCenterAutoOpenSource(null);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [activityCenterOpen]);

  const [activeSplitViewId, setActiveSplitViewId] = useState<string | null>(null);
  const activeSplitViewIdRef = useRef(activeSplitViewId);
  useEffect(() => {
    activeSplitViewIdRef.current = activeSplitViewId;
  }, [activeSplitViewId]);

  const activeSplitView = useMemo(() => {
    if (!activeSplitViewId) return null;
    const view = splitViews.find((v) => v.id === activeSplitViewId) ?? null;
    if (!view || view.projectId !== activeProjectId) return null;
    return view;
  }, [activeProjectId, activeSplitViewId, splitViews]);
  const activeSplitViewRef = useRef<typeof activeSplitView>(null);
  useEffect(() => {
    activeSplitViewRef.current = activeSplitView;
  }, [activeSplitView]);

  const splitPane = useMemo(() => {
    if (!activeSplitView || !activeId) return null;
    const { aId, bId } = activeSplitView;
    if (activeId !== aId && activeId !== bId) return null;
    const secondaryId = activeId === aId ? bId : aId;
    return { secondaryId, direction: activeSplitView.direction, ratio: activeSplitView.ratio };
  }, [activeId, activeSplitView]);
  const splitPaneRef = useRef<typeof splitPane>(null);
  useEffect(() => {
    splitPaneRef.current = splitPane;
  }, [splitPane]);
  const [hydrated, setHydrated] = useState(false);

  // Persist the workspace tier (separate from the Rust state blob). Gated on
  // `hydrated` so we never overwrite the saved record with the pre-hydration
  // placeholder state (initial `projects` is a synthetic Default project).
  useEffect(() => {
    if (!hydrated) return;
    try {
      const payload: PersistedWorkspacesV1 = {
        schemaVersion: 1,
        workspaces,
        activeWorkspaceId,
        projectWorkspace,
      };
      localStorage.setItem(STORAGE_WORKSPACES_KEY, JSON.stringify(payload));
    } catch {
      // Best-effort.
    }
  }, [hydrated, workspaces, activeWorkspaceId, projectWorkspace]);

  // Self-heal workspace membership: assign any project lacking a workspace to the
  // active workspace, drop stale mappings, and keep activeWorkspaceId valid. This
  // also migrates pre-workspace installs (all existing projects join the default
  // workspace) and absorbs newly created projects into the current workspace.
  // Gated on `hydrated`: before real projects load, `projects` only holds the
  // synthetic Default project, so running this early would strip every saved
  // mapping.
  useEffect(() => {
    if (!hydrated) return;
    if (!workspaces.length) return;
    const validWorkspaceIds = new Set(workspaces.map((w) => w.id));
    const fallbackWorkspaceId = validWorkspaceIds.has(activeWorkspaceId)
      ? activeWorkspaceId
      : workspaces[0].id;
    if (!validWorkspaceIds.has(activeWorkspaceId)) {
      setActiveWorkspaceId(fallbackWorkspaceId);
    }
    setProjectWorkspace((prev) => {
      const next: Record<string, string> = {};
      let changed = false;
      const projectIds = new Set(projects.map((p) => p.id));
      for (const p of projects) {
        const current = prev[p.id];
        if (current && validWorkspaceIds.has(current)) {
          next[p.id] = current;
        } else {
          next[p.id] = fallbackWorkspaceId;
          changed = true;
        }
      }
      // Drop mappings for deleted projects.
      for (const key of Object.keys(prev)) {
        if (!projectIds.has(key)) changed = true;
      }
      return changed ? next : prev;
    });
  }, [hydrated, projects, workspaces, activeWorkspaceId]);

  const [sessionRestoreProgress, setSessionRestoreProgress] = useState<SessionRestoreProgress | null>(
    null,
  );
  const [newOpen, setNewOpen] = useState(false);
  // Bring-your-own-shell: detected shells (lazy-loaded) + the per-terminal picker.
  const [shellPicker, setShellPicker] = useState<{ projectId: string } | null>(null);
  const [sshManagerOpen, setSshManagerOpen] = useState(false);
  const [sshHosts, setSshHosts] = useState<SshHostEntry[]>([]);
  const [sshHostsLoading, setSshHostsLoading] = useState(false);
  const [sshHostsError, setSshHostsError] = useState<string | null>(null);
  const [sshHistory, setSshHistory] = useState<SshHistoryEntry[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_SSH_HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  });
  const [projectOpen, setProjectOpen] = useState(false);
  const [confirmDeleteProjectOpen, setConfirmDeleteProjectOpen] = useState(false);
  const [confirmDeleteRecordingId, setConfirmDeleteRecordingId] = useState<string | null>(null);
  const [confirmDeletePromptId, setConfirmDeletePromptId] = useState<string | null>(null);
  const [confirmDeleteEnvironmentId, setConfirmDeleteEnvironmentId] = useState<string | null>(null);
  const [confirmDeleteAssetId, setConfirmDeleteAssetId] = useState<string | null>(null);
  const [pathPickerOpen, setPathPickerOpen] = useState(false);
  const [pathPickerTarget, setPathPickerTarget] = useState<"project" | "session" | "ssh-remote" | null>(null);
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [replayRecording, setReplayRecording] = useState<LoadedRecording | null>(null);
  const [replaySteps, setReplaySteps] = useState<string[]>([]);
  const [replayIndex, setReplayIndex] = useState(0);
  const [replayTargetSessionId, setReplayTargetSessionId] = useState<string | null>(null);
  const [replayShowAll, setReplayShowAll] = useState(false);
  const [replayFlowExpanded, setReplayFlowExpanded] = useState<Record<string, boolean>>({});
  const replayNextItemRef = useRef<HTMLDivElement | null>(null);
  const [recordPromptOpen, setRecordPromptOpen] = useState(false);
  const [recordPromptName, setRecordPromptName] = useState("");
  const [recordPromptSessionId, setRecordPromptSessionId] = useState<string | null>(null);
  const [recordingsOpen, setRecordingsOpen] = useState(false);
  const [recordingsLoading, setRecordingsLoading] = useState(false);
  const [recordingsError, setRecordingsError] = useState<string | null>(null);
  const [recordings, setRecordings] = useState<RecordingIndexEntry[]>([]);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);
  const [promptEditorId, setPromptEditorId] = useState<string | null>(null);
  const [promptEditorTitle, setPromptEditorTitle] = useState("");
  const [promptEditorContent, setPromptEditorContent] = useState("");
  const [environmentsOpen, setEnvironmentsOpen] = useState(false);
  const [environmentEditorOpen, setEnvironmentEditorOpen] = useState(false);
  const [environmentEditorId, setEnvironmentEditorId] = useState<string | null>(null);
  const [environmentEditorName, setEnvironmentEditorName] = useState("");
  const [environmentEditorContent, setEnvironmentEditorContent] = useState("");
  const [environmentEditorLocked, setEnvironmentEditorLocked] = useState(false);
  const [assetEditorOpen, setAssetEditorOpen] = useState(false);
  const [assetEditorId, setAssetEditorId] = useState<string | null>(null);
  const [assetEditorName, setAssetEditorName] = useState("");
  const [assetEditorPath, setAssetEditorPath] = useState("");
  const [assetEditorAutoApply, setAssetEditorAutoApply] = useState(true);
  const [assetEditorContent, setAssetEditorContent] = useState("");
  const [applyAssetRequest, setApplyAssetRequest] = useState<ApplyAssetRequest | null>(null);
  const [applyAssetApplying, setApplyAssetApplying] = useState(false);
  const [applyAssetError, setApplyAssetError] = useState<string | null>(null);
  const [persistenceDisabledReason, setPersistenceDisabledReason] = useState<string | null>(null);
  const [secureStorageMode, setSecureStorageMode] = useState<SecureStorageMode | null>(null);
  const [secureStorageSettingsOpen, setSecureStorageSettingsOpen] = useState(false);
  const [secureStorageSettingsMode, setSecureStorageSettingsMode] =
    useState<SecureStorageMode>("keychain");
  const [secureStorageSettingsBusy, setSecureStorageSettingsBusy] = useState(false);
  const [secureStorageSettingsError, setSecureStorageSettingsError] = useState<string | null>(null);
  const [secureStorageRetrying, setSecureStorageRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [screenCapturePermissionIssue, setScreenCapturePermissionIssue] = useState<string | null>(null);
  const [autoRenamingSessions, setAutoRenamingSessions] = useState(false);
  const [autoRenameActivity, setAutoRenameActivity] = useState<AutoRenameActivity | null>(null);
  useEffect(() => {
    if (activityCenterAutoOpenSource !== "auto-rename") return;
    if (autoRenameActivity) return;
    setActivityCenterOpen(false);
    setActivityCenterAutoOpenSource(null);
  }, [activityCenterAutoOpenSource, autoRenameActivity]);
  const secureStoragePromptedRef = useRef(false);
  // Updates domain lives in src/stores/updates.ts (App.tsx decomposition).
  const { appInfo, updateCheckState } = useUpdatesStore();
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [pendingTrayAction, setPendingTrayAction] = useState<TrayMenuEventPayload | null>(null);
  const [recentSessionKeys, setRecentSessionKeys] = useState<RecentSessionKey[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_RECENT_SESSIONS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(
          (entry): entry is { projectId: string; persistId: string } =>
            Boolean(entry) &&
            typeof (entry as { projectId?: unknown }).projectId === "string" &&
            typeof (entry as { persistId?: unknown }).persistId === "string",
        )
        .map((entry) => ({ projectId: entry.projectId, persistId: entry.persistId }))
        .slice(0, 50);
    } catch {
      return [];
    }
  });

  const [persistentSessionsOpen, setPersistentSessionsOpen] = useState(false);
  const [persistentSessionsLoading, setPersistentSessionsLoading] = useState(false);
  const [persistentSessionsError, setPersistentSessionsError] = useState<string | null>(null);
  const [persistentSessions, setPersistentSessions] = useState<PersistentSessionInfo[]>([]);
  const [confirmKillPersistentId, setConfirmKillPersistentId] = useState<string | null>(null);
  const [confirmKillPersistentBusy, setConfirmKillPersistentBusy] = useState(false);

  // New UI state for SlidePanel and CommandPalette
  const [slidePanelOpen, setSlidePanelOpen] = useState(false);
  const [slidePanelTab, setSlidePanelTab] = useState<"prompts" | "recordings" | "assets" | "timeline">("prompts");
  const [slidePanelWidth, setSlidePanelWidth] = useState(360);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [workspaceFileSearchOpen, setWorkspaceFileSearchOpen] = useState(false);
  // Simple dialog open/closed state lives in src/stores/dialogs.ts.
  const dialogs = useDialogsStore();
  // Tab-strip drag-reorder indicator (drop target + side).
  const [tabDrop, setTabDrop] = useState<{ id: string; position: "before" | "after" } | null>(null);
  // Portal host inside the terminal pane for terminal-scoped overlays.
  const [terminalOverlayHost, setTerminalOverlayHost] = useState<HTMLDivElement | null>(null);
  const terminalOverlayRef = useCallback((el: HTMLDivElement | null) => setTerminalOverlayHost(el), []);
  const [promptSearch, setPromptSearch] = useState("");
  const [recordingSearch, setRecordingSearch] = useState("");
  const [assetSearch, setAssetSearch] = useState("");
  const [recordingStartTime, setRecordingStartTime] = useState<number | null>(null);
  const [recordingElapsed, setRecordingElapsed] = useState(0);

  // Agent panel state
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const [agentPanelWidth, setAgentPanelWidth] = useState(() => {
    const saved = localStorage.getItem(STORAGE_AGENT_PANEL_WIDTH_KEY);
    return saved ? Math.max(MIN_AGENT_PANEL_WIDTH, parseInt(saved, 10) || DEFAULT_AGENT_PANEL_WIDTH) : DEFAULT_AGENT_PANEL_WIDTH;
  });

  const [workspaceViewByKey, setWorkspaceViewByKey] = useState<Record<string, WorkspaceView>>({});
  const workspaceRowRef = useRef<HTMLDivElement | null>(null);

  const workspaceEditorWidthStorageKey = useCallback(
    (projectId: string) => `${STORAGE_WORKSPACE_EDITOR_WIDTH_KEY}:${projectId}`,
    [],
  );
  const workspaceFileTreeWidthStorageKey = useCallback(
    (projectId: string) => `${STORAGE_WORKSPACE_FILE_TREE_WIDTH_KEY}:${projectId}`,
    [],
  );

  const readStoredNumber = useCallback((key: string, fallback: number) => {
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw != null ? Number(raw) : NaN;
      return Number.isFinite(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }, []);

  const createInitialWorkspaceView = useCallback(
    (projectId: string): WorkspaceView => {
      const editorWidth = Math.max(
        MIN_WORKSPACE_EDITOR_WIDTH,
        readStoredNumber(workspaceEditorWidthStorageKey(projectId), DEFAULT_WORKSPACE_EDITOR_WIDTH),
      );
      const treeWidth = Math.max(
        MIN_WORKSPACE_FILE_TREE_WIDTH,
        readStoredNumber(workspaceFileTreeWidthStorageKey(projectId), DEFAULT_WORKSPACE_FILE_TREE_WIDTH),
      );
      return {
        projectId,
        fileExplorerOpen: true,
        fileExplorerRootDir: null,
        fileExplorerPersistedState: null,
        codeEditorOpen: false,
        codeEditorRootDir: null,
        openFileRequest: null,
        openWorkspaceTabRequest: null,
        codeEditorActiveFilePath: null,
        codeEditorPersistedState: null,
        codeEditorFsEvent: null,
        editorWidth,
        treeWidth,
      };
    },
    [readStoredNumber, workspaceEditorWidthStorageKey, workspaceFileTreeWidthStorageKey],
  );

  const activeWorkspaceKey = useMemo(() => {
    const active = sessions.find((s) => s.id === activeId) ?? null;
    if (!active) return activeProjectId;
    const isSsh =
      Boolean((active.sshTarget ?? "").trim()) ||
      isSshCommandLine(active.launchCommand ?? active.restoreCommand ?? null);
    if (isSsh) {
      const target =
        active.sshTarget?.trim() ||
        sshTargetFromCommandLine(active.launchCommand ?? active.restoreCommand ?? null) ||
        "";
      if (target) return `ssh:${active.projectId}:${target}`;
      return `ssh:${active.projectId}:${active.persistId}`;
    }
    return active.projectId;
  }, [activeId, activeProjectId, sessions]);

  const activeWorkspaceView = useMemo(() => {
    return workspaceViewByKey[activeWorkspaceKey] ?? createInitialWorkspaceView(activeProjectId);
  }, [activeProjectId, activeWorkspaceKey, createInitialWorkspaceView, workspaceViewByKey]);

  const activeWorkspaceKeyRef = useRef(activeWorkspaceKey);
  const activeWorkspaceViewRef = useRef(activeWorkspaceView);
  useEffect(() => {
    activeWorkspaceKeyRef.current = activeWorkspaceKey;
    activeWorkspaceViewRef.current = activeWorkspaceView;
  }, [activeWorkspaceKey, activeWorkspaceView]);

  const updateWorkspaceViewForKey = useCallback(
    (key: string, projectId: string, updater: (prev: WorkspaceView) => WorkspaceView) => {
      setWorkspaceViewByKey((prev) => {
        const current = prev[key] ?? createInitialWorkspaceView(projectId);
        const next = updater(current);
        if (next === current) return prev;
        return { ...prev, [key]: next };
      });
    },
    [createInitialWorkspaceView],
  );

  const updateActiveWorkspaceView = useCallback(
    (updater: (prev: WorkspaceView) => WorkspaceView) =>
      updateWorkspaceViewForKey(activeWorkspaceKey, activeProjectId, updater),
    [activeProjectId, activeWorkspaceKey, updateWorkspaceViewForKey],
  );

  const workspaceEditorWidthRef = useRef(activeWorkspaceView.editorWidth);
  const workspaceFileTreeWidthRef = useRef(activeWorkspaceView.treeWidth);
  useEffect(() => {
    workspaceEditorWidthRef.current = activeWorkspaceView.editorWidth;
  }, [activeWorkspaceView.editorWidth]);
  useEffect(() => {
    workspaceFileTreeWidthRef.current = activeWorkspaceView.treeWidth;
  }, [activeWorkspaceView.treeWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(
        workspaceEditorWidthStorageKey(activeProjectId),
        String(Math.max(MIN_WORKSPACE_EDITOR_WIDTH, Math.floor(activeWorkspaceView.editorWidth))),
      );
    } catch {
      // Best-effort.
    }
  }, [activeProjectId, activeWorkspaceView.editorWidth, workspaceEditorWidthStorageKey]);

  useEffect(() => {
    try {
      localStorage.setItem(
        workspaceFileTreeWidthStorageKey(activeProjectId),
        String(Math.max(MIN_WORKSPACE_FILE_TREE_WIDTH, Math.floor(activeWorkspaceView.treeWidth))),
      );
    } catch {
      // Best-effort.
    }
  }, [activeProjectId, activeWorkspaceView.treeWidth, workspaceFileTreeWidthStorageKey]);

  // Persist agent panel width
  useEffect(() => {
    try { localStorage.setItem(STORAGE_AGENT_PANEL_WIDTH_KEY, String(agentPanelWidth)); } catch {}
  }, [agentPanelWidth]);

  const [workspaceResizeMode, setWorkspaceResizeMode] = useState<"editor" | "tree" | "agent" | null>(null);
  const workspaceResizeStartRef = useRef<
    { x: number; editorWidth: number; treeWidth: number; agentWidth?: number; projectId: string; workspaceKey: string } | null
  >(null);
  const workspaceResizeDraftRef = useRef<{ editorWidth: number; treeWidth: number } | null>(null);

  const updateSourceLabel = useMemo(() => {
    const repo = parseGithubRepo(appInfo?.homepage);
    if (repo) return `${repo.owner}/${repo.repo}`;
    const homepage = appInfo?.homepage?.trim();
    return homepage ? homepage : null;
  }, [appInfo]);

  const fallbackReleaseUrl = useMemo(() => {
    const repo = parseGithubRepo(appInfo?.homepage);
    if (!repo) return null;
    return `https://github.com/${repo.owner}/${repo.repo}/releases/latest`;
  }, [appInfo]);

  const updateCheckUrl = useMemo(() => {
    const repo = parseGithubRepo(appInfo?.homepage);
    if (!repo) return null;
    return `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`;
  }, [appInfo]);

  const quickStarts = useMemo(() => {
    const presets: Array<{ id: string; title: string; command: string | null; iconSrc: string | null }> = [];

    const seen = new Set<string>();
    for (const id of agentShortcutIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const effect = getProcessEffectById(id);
      if (!effect) continue;
      presets.push({
        id: effect.id,
        title: effect.label,
        command: effect.matchCommands[0] ?? effect.label,
        iconSrc: effect.iconSrc ?? null,
      });
    }

    const pinned = new Set(presets.map((p) => p.id));
    const rest = PROCESS_EFFECTS
      .filter((e) => !pinned.has(e.id))
      .slice()
      .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()))
      .map((effect) => ({
        id: effect.id,
        title: effect.label,
        command: effect.matchCommands[0] ?? effect.label,
        iconSrc: effect.iconSrc ?? null,
      }));

    return [
      ...presets,
      ...rest,
      { id: "shell", title: "shell", command: null as string | null, iconSrc: null as string | null },
    ];
  }, [agentShortcutIds]);

  const agentShortcuts = useMemo(() => {
    const seen = new Set<string>();
    return agentShortcutIds
      .filter((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .map((id) => getProcessEffectById(id))
      .filter((effect): effect is NonNullable<ReturnType<typeof getProcessEffectById>> => Boolean(effect));
  }, [agentShortcutIds]);

  const registry = useRef<TerminalRegistry>(new Map());
  const pendingData = useRef<PendingDataBuffer>(new Map());
  const [terminalSearchSessions, setTerminalSearchSessions] = useState<Set<string>>(() => new Set());
  const terminalSearchSessionsRef = useRef(terminalSearchSessions);
  terminalSearchSessionsRef.current = terminalSearchSessions;
  const terminalSearchTriggerAtRef = useRef(0);
  const codeEditorPanelRef = useRef<CodeEditorPanelHandle | null>(null);
  const handleTerminalRegistryChanged = useCallback(() => {
    setTerminalSearchSessions((prev) => (prev.size === 0 ? prev : new Set(prev)));
  }, []);
  const outputQueueRef = useRef<OutputQueueBySession>(new Map());
  const outputFlushRafRef = useRef<number | null>(null);
  const pendingExitCodes = useRef<Map<string, number | null>>(new Map());
  const closingSessions = useRef<Map<string, number>>(new Map());
  const exitedCleanupTimers = useRef<Map<string, number>>(new Map());
  const sessionIdsRef = useRef<string[]>([]);
  const sessionsRef = useRef<Session[]>([]);
  const sessionByIdRef = useRef<Map<string, Session>>(new Map());
  const pendingAgentWorkingRef = useRef<Set<string>>(new Set());
  const hydratedRef = useRef<boolean>(hydrated);
  const activeIdRef = useRef<string | null>(null);
  const projectsRef = useRef<Project[]>(projects);
  const environmentsRef = useRef<EnvironmentConfig[]>(environments);
  const projectByIdRef = useRef<Map<string, Project>>(new Map());
  const activeProjectIdRef = useRef<string>(activeProjectId);
  const projectWorkspaceRef = useRef<Record<string, string>>(projectWorkspace);
  projectWorkspaceRef.current = projectWorkspace;
  const activeWorkspaceIdRef = useRef<string>(activeWorkspaceId);
  activeWorkspaceIdRef.current = activeWorkspaceId;
  const workspacesRef = useRef<Workspace[]>(workspaces);
  workspacesRef.current = workspaces;
  const reconnectTimersRef = useRef<Map<string, number>>(new Map());
  const reconnectInFlightRef = useRef<Set<string>>(new Set());
  const healthCheckInFlightRef = useRef(false);
  const lastHealthCheckAtRef = useRef(0);
  const lastActiveByProject = useRef<Map<string, string>>(new Map());
  const newSessionModalRef = useRef<NewSessionModalHandle>(null);
  const projectModalRef = useRef<ProjectModalHandle>(null);
  const projectModalInitialRef = useRef({ mode: "new" as "new" | "rename", title: "", basePath: "", environmentId: "", assetsEnabled: true, sshTarget: "", sshRemotePath: "", defaultShell: null as ShellChoice | null });
  const pathPickerInitialPathRef = useRef<string | null>(null);
  const sshPathPickerTargetRef = useRef<string | null>(null);
  const recordNameRef = useRef<HTMLInputElement | null>(null);
  const promptTitleRef = useRef<HTMLInputElement | null>(null);
  const envNameRef = useRef<HTMLInputElement | null>(null);
  const assetNameRef = useRef<HTMLInputElement | null>(null);
  const homeDirRef = useRef<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const pendingSaveRef = useRef<PersistedStateV1 | null>(null);
  // Appearance choices are low-frequency, user-authored metadata. Save them on
  // the next task so a crash immediately after using a picker cannot strand
  // the change inside the normal autosave debounce window.
  const urgentPersistenceRef = useRef(false);
  const workspaceViewSaveTimerRef = useRef<number | null>(null);
  const pendingWorkspaceViewSaveRef = useRef<WorkspaceViewStorageV1 | null>(null);
  const agentIdleTimersRef = useRef<Map<string, number>>(new Map());
  const commandActivityTimersRef = useRef<Map<string, number>>(new Map());
  const agentWorkingMapRef = useRef<Map<string, boolean>>(new Map());
  const keyHandlerStateRef = useRef({
    newOpen: false,
    sshManagerOpen: false,
    agentShortcutsOpen: false,
    projectOpen: false,
    pathPickerOpen: false,
    confirmDeleteProjectOpen: false,
    confirmDeleteRecordingId: null as string | null,
    confirmDeletePromptId: null as string | null,
    confirmDeleteEnvironmentId: null as string | null,
    confirmDeleteAssetId: null as string | null,
    applyAssetRequest: null as ApplyAssetRequest | null,
    applyAssetApplying: false,
    replayOpen: false,
    recordPromptOpen: false,
    recordingsOpen: false,
    secureStorageSettingsOpen: false,
    promptsOpen: false,
    promptEditorOpen: false,
    environmentsOpen: false,
    environmentEditorOpen: false,
    assetEditorOpen: false,
    commandPaletteOpen: false,
    slidePanelOpen: false,
    slidePanelTab: "prompts" as string,
    prompts: [] as Prompt[],
  });
  const agentWorkingSyncTimerRef = useRef<number | null>(null);
  const commandLifecycleSessionsRef = useRef<Set<string>>(new Set());
  const secureStorageRetryingRef = useRef(false);
  const secureStorageModeRef = useRef(secureStorageMode);
  const lastResizeAtRef = useRef<Map<string, number>>(new Map());
  const attachingPersistentIdsRef = useRef<Set<string>>(new Set());

  // Wrapper that keeps refs in sync immediately inside the setState updater,
  // eliminating the stale-ref window between state update and effect execution.
  const setSessionsSync = useCallback((updater: React.SetStateAction<Session[]>) => {
    setSessions((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      sessionsRef.current = next;
      sessionIdsRef.current = next.map(s => s.id);
      sessionByIdRef.current = new Map(next.map(s => [s.id, s]));
      return next;
    });
  }, []);

  const flushPendingSave = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const state = pendingSaveRef.current;
    if (state) {
      void invoke("save_persisted_state", { state }).catch(() => {});
      pendingSaveRef.current = null;
    }
  }, []);

  // Maintenance-free update notifications: quietly check the GitHub latest
  // release shortly after launch and every 6 hours, toast once per new
  // version (the status-bar chip stays lit as the ambient reminder).
  useEffect(() => {
    const NOTIFIED_KEY = "agents-ui-update-notified-version";
    let disposed = false;
    const run = async () => {
      const result = await checkForUpdatesSilently();
      if (disposed || result.status !== "updateAvailable") return;
      let notified: string | null = null;
      try {
        notified = localStorage.getItem(NOTIFIED_KEY);
      } catch {
        // Best-effort: localStorage may be unavailable in some contexts.
      }
      if (notified === result.latestVersion) return;
      try {
        localStorage.setItem(NOTIFIED_KEY, result.latestVersion);
      } catch {
        // Best-effort.
      }
      showToast({
        tone: "info",
        title: "Update available",
        message: `Agents UI ${result.latestVersion} has been released.`,
        duration: 12000,
        action: { label: "View", onClick: () => setUpdatesOpen(true) },
      });
    };
    const initial = window.setTimeout(() => void run(), 10_000);
    const interval = window.setInterval(() => void run(), 6 * 60 * 60 * 1000);
    return () => {
      disposed = true;
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchAppInfo();

    return () => {
      cancelled = true;
    };
  }, []);

  const clearAgentIdleTimer = useCallback((id: string) => {
    const existing = agentIdleTimersRef.current.get(id);
    if (existing !== undefined) {
      window.clearTimeout(existing);
      agentIdleTimersRef.current.delete(id);
    }
  }, []);

  const clearCommandActivityTimer = useCallback((id: string) => {
    const existing = commandActivityTimersRef.current.get(id);
    if (existing !== undefined) {
      window.clearTimeout(existing);
      commandActivityTimersRef.current.delete(id);
    }
  }, []);

  const syncAgentWorkingToState = useCallback(() => {
    agentWorkingSyncTimerRef.current = null;
    const map = agentWorkingMapRef.current;
    const nextIds = new Set<string>();
    for (const [id, working] of map) {
      if (working) nextIds.add(id);
    }
    setAgentWorkingIds((prev) => {
      if (prev.size === nextIds.size) {
        let same = true;
        for (const id of nextIds) {
          if (!prev.has(id)) { same = false; break; }
        }
        if (same) return prev;
      }
      return nextIds;
    });
  }, []);

  const scheduleAgentWorkingSync = useCallback(() => {
    if (agentWorkingSyncTimerRef.current !== null) return;
    agentWorkingSyncTimerRef.current = window.setTimeout(syncAgentWorkingToState, 500);
  }, [syncAgentWorkingToState]);

  const scheduleAgentIdle = useCallback((id: string, effectId: string | null) => {
    clearAgentIdleTimer(id);
    if (!effectId) return;
    const effect = getProcessEffectById(effectId);
    const idleAfterMs = effect?.idleAfterMs ?? 2000;
    const timeout = window.setTimeout(() => {
      agentIdleTimersRef.current.delete(id);
      agentWorkingMapRef.current.set(id, false);
      scheduleAgentWorkingSync();
    }, idleAfterMs);
    agentIdleTimersRef.current.set(id, timeout);
  }, [clearAgentIdleTimer, scheduleAgentWorkingSync]);

  const scheduleRunningCommandActivityTimeout = useCallback((id: string) => {
    clearCommandActivityTimer(id);
    // OSC 133 sessions get a longer fallback timeout as safety net
    // (e.g. if user enters subshell/SSH where OSC 133 stops working)
    const timeoutMs = commandLifecycleSessionsRef.current.has(id)
      ? 10_000
      : COMMAND_ACTIVITY_IDLE_MS;
    const timeout = window.setTimeout(() => {
      commandActivityTimersRef.current.delete(id);
      setSessionsSync((prev) => {
        const index = prev.findIndex((session) => session.id === id);
        if (index < 0) return prev;
        const current = prev[index];
        if (!(current.runningCommand ?? "").trim()) return prev;
        const next = prev.slice();
        next[index] = { ...current, runningCommand: null };
        return next;
      });
    }, timeoutMs);
    commandActivityTimersRef.current.set(id, timeout);
  }, [clearCommandActivityTimer, setSessions]);

  const RESIZE_OUTPUT_SUPPRESS_MS = 900;

  const coercePtyDataToString = (data: unknown): string | null => {
    if (typeof data === "string") return data;
    if (!data) return null;
    try {
      if (data instanceof Uint8Array) {
        return new TextDecoder().decode(data);
      }
      if (data instanceof ArrayBuffer) {
        return new TextDecoder().decode(new Uint8Array(data));
      }
      if (Array.isArray(data) && data.every((x) => typeof x === "number")) {
        return new TextDecoder().decode(new Uint8Array(data as number[]));
      }
    } catch {
      return null;
    }
    return null;
  };

  const pushPendingData = useCallback((id: string, text: string) => {
    if (!pendingData.current.has(id) && pendingData.current.size >= MAX_PENDING_SESSIONS) {
      // Evict the oldest buffer, but never the active session's — dropping the
      // visible terminal's pre-mount output would be user-visible data loss.
      let victim: string | undefined;
      for (const key of pendingData.current.keys()) {
        if (key !== activeIdRef.current) {
          victim = key;
          break;
        }
      }
      if (victim !== undefined) pendingData.current.delete(victim);
    }
    const buffer = pendingData.current.get(id) || [];
    buffer.push(text);
    if (buffer.length > MAX_PENDING_CHUNKS_PER_SESSION) {
      buffer.splice(0, buffer.length - MAX_PENDING_CHUNKS_PER_SESSION);
    }
    pendingData.current.delete(id);
    pendingData.current.set(id, buffer);
  }, []);

  const flushQueuedOutput = useCallback((preferredActiveId?: string | null) => {
    if (outputQueueRef.current.size === 0) return;
    const queue = outputQueueRef.current;
    outputQueueRef.current = new Map();
    const activeId = preferredActiveId === undefined ? activeIdRef.current : preferredActiveId;
    const secondaryId = splitPaneRef.current?.secondaryId ?? null;
    const visibleCount = (activeId && queue.has(activeId) ? 1 : 0) + (secondaryId && secondaryId !== activeId && queue.has(secondaryId) ? 1 : 0);
    const hiddenCount = Math.max(1, queue.size - visibleCount);
    const PER_HIDDEN_SESSION_BUDGET = 32 * 1024;
    let hiddenBudget = Math.min(hiddenCount * PER_HIDDEN_SESSION_BUDGET, 256 * 1024);

    const requeueDeferredChunks = (id: string, chunks: string[]) => {
      if (!chunks.length) return;
      const existing = outputQueueRef.current.get(id) ?? [];
      let merged = chunks.concat(existing);

      // Bound deferred bytes by dropping the OLDEST chunks (ordering here is
      // oldest → newest). Without this, the count cap below still allows one
      // ever-growing merged tail string during a background flood.
      let totalBytes = 0;
      for (const chunk of merged) totalBytes += chunk.length;
      let start = 0;
      while (totalBytes > MAX_DEFERRED_OUTPUT_BYTES_PER_SESSION && start < merged.length - 1) {
        totalBytes -= merged[start].length;
        start += 1;
      }
      if (start > 0) merged = merged.slice(start);

      if (merged.length <= MAX_OUTPUT_QUEUE_CHUNKS_PER_SESSION) {
        outputQueueRef.current.set(id, merged);
        return;
      }
      const head = merged.slice(0, MAX_OUTPUT_QUEUE_CHUNKS_PER_SESSION - 1);
      const tail = merged.slice(MAX_OUTPUT_QUEUE_CHUNKS_PER_SESSION - 1).join("");
      outputQueueRef.current.set(id, [...head, tail]);
    };

    const flushAllChunks = (id: string, chunks: string[]) => {
      if (closingSessions.current.has(id) || chunks.length === 0) return;
      const text = chunks.length === 1 ? chunks[0] : chunks.join("");
      const entry = registry.current.get(id);
      if (entry) {
        // One write() per flush rather than per chunk: the VT stream parser
        // sees the identical byte sequence, but with a single WriteBuffer
        // entry/exit transition instead of N.
        entry.term.write(text);
        return;
      }
      pushPendingData(id, text);
    };

    if (activeId && queue.size === 1) {
      const activeChunks = queue.get(activeId);
      if (activeChunks) {
        flushAllChunks(activeId, activeChunks);
        return;
      }
    }

    const flushHiddenChunksWithBudget = (id: string, chunks: string[]) => {
      if (closingSessions.current.has(id) || chunks.length === 0) return;
      const entry = registry.current.get(id);
      if (!entry) {
        const text = chunks.length === 1 ? chunks[0] : chunks.join("");
        pushPendingData(id, text);
        return;
      }
      if (hiddenBudget <= 0) {
        requeueDeferredChunks(id, chunks);
        return;
      }

      let consumedChars = 0;
      let consumedCount = 0;
      while (consumedCount < chunks.length) {
        const chunk = chunks[consumedCount];
        if (consumedChars > 0 && consumedChars + chunk.length > hiddenBudget) break;
        consumedChars += chunk.length;
        consumedCount += 1;
        if (consumedChars >= hiddenBudget) break;
      }

      if (consumedCount === 0) {
        consumedCount = 1;
        consumedChars = chunks[0].length;
      }

      const visible = chunks.slice(0, consumedCount);
      const deferred = chunks.slice(consumedCount);
      entry.term.write(visible.length === 1 ? visible[0] : visible.join(""));
      hiddenBudget -= consumedChars;
      if (deferred.length > 0) {
        requeueDeferredChunks(id, deferred);
      }
    };

    if (activeId) {
      const activeChunks = queue.get(activeId);
      if (activeChunks) {
        flushAllChunks(activeId, activeChunks);
        queue.delete(activeId);
      }
    }

    if (secondaryId && secondaryId !== activeId) {
      const secondaryChunks = queue.get(secondaryId);
      if (secondaryChunks) {
        flushAllChunks(secondaryId, secondaryChunks);
        queue.delete(secondaryId);
      }
    }

    for (const [id, chunks] of queue) {
      if (id === activeId || id === secondaryId) continue;
      flushHiddenChunksWithBudget(id, chunks);
    }
  }, [pushPendingData]);

  const scheduleOutputFlush = useCallback(() => {
    if (outputFlushRafRef.current !== null) return;
    const flush = () => {
      outputFlushRafRef.current = null;
      flushQueuedOutput();
      if (outputQueueRef.current.size > 0) {
        outputFlushRafRef.current = window.requestAnimationFrame(flush);
      }
    };
    outputFlushRafRef.current = window.requestAnimationFrame(flush);
  }, [flushQueuedOutput]);

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

  const hasMeaningfulOutput = (data: string): boolean => {
    let visibleNonWhitespace = 0;
    let hasAlphaNum = false;

    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      const cc = ch.charCodeAt(0);
      if (ch === "\u001b") {
        i = skipEscapeSequence(data, i + 1);
        continue;
      }
      if (ch < " " || ch === "\u007f") {
        i += 1;
        continue;
      }
      // Whitespace at code >= 0x20 — mirrors String.prototype.trim's set
      // (SP, NBSP, the Unicode Zs separators, LS/PS, ZWNBSP/BOM) without the
      // per-char string allocation of `ch.trim() === ""`.
      if (
        cc === 0x20 || cc === 0xa0 || cc === 0x1680 ||
        (cc >= 0x2000 && cc <= 0x200a) ||
        cc === 0x2028 || cc === 0x2029 || cc === 0x202f ||
        cc === 0x205f || cc === 0x3000 || cc === 0xfeff
      ) {
        i += 1;
        continue;
      }

      visibleNonWhitespace += 1;
      if (visibleNonWhitespace >= 2) return true;
      // ASCII digit / letter via code ranges (no regex, no allocation).
      if ((cc >= 0x30 && cc <= 0x39) || (cc >= 0x41 && cc <= 0x5a) || (cc >= 0x61 && cc <= 0x7a)) hasAlphaNum = true;

      i += 1;
    }
    return hasAlphaNum;
  };

  function markAgentWorkingFromOutput(id: string, data: string) {
    if (!hydratedRef.current) return;
    const session = sessionByIdRef.current.get(id);
    if (!session) return;
    if (!session.effectId || session.exited || session.closing) return;
    if (session.connectionState === "reconnecting" || session.connectionState === "disconnected") {
      return;
    }

    if (!data) return;

    const lastResizeAt = lastResizeAtRef.current.get(id);
    if (lastResizeAt !== undefined && Date.now() - lastResizeAt < RESIZE_OUTPUT_SUPPRESS_MS) {
      return;
    }
    if (!hasMeaningfulOutput(data)) return;

    // Persistent sessions (zellij) can emit background output even when "idle".
    // Avoid re-activating a background persistent session unless it's already marked working
    // (or it's the visible active tab).
    const currentWorking = agentWorkingMapRef.current.get(id) ?? false;
    if (session.persistent && !currentWorking && activeIdRef.current !== id) return;

    if (!currentWorking) {
      agentWorkingMapRef.current.set(id, true);
      scheduleAgentWorkingSync();
    }
    scheduleAgentIdle(id, session.effectId);
  }

  const clearReconnectTimer = useCallback((id: string) => {
    const existing = reconnectTimersRef.current.get(id);
    if (existing !== undefined) {
      window.clearTimeout(existing);
      reconnectTimersRef.current.delete(id);
    }
  }, []);

  const clearSessionRuntimeBuffers = useCallback((id: string) => {
    clearAgentIdleTimer(id);
    clearCommandActivityTimer(id);
    // delete (not set false) so the map doesn't accrue a permanent key per
    // session ever opened — all readers use `?? false`, so this is identical.
    agentWorkingMapRef.current.delete(id);
    lastResizeAtRef.current.delete(id);
    pendingData.current.delete(id);
    outputQueueRef.current.delete(id);
    pendingExitCodes.current.delete(id);
    clearReconnectTimer(id);
    reconnectInFlightRef.current.delete(id);
  }, [clearAgentIdleTimer, clearCommandActivityTimer, clearReconnectTimer]);

  const markSessionAliveFromOutput = useCallback((id: string) => {
    const current = sessionByIdRef.current.get(id);
    if (!current) return;
    const state = current.connectionState ?? "connected";
    const attempt = current.reconnectAttempt ?? 0;
    if (
      state === "connected" &&
      attempt === 0 &&
      !current.manualReconnectAvailable &&
      !current.disconnectReason &&
      !current.exited
    ) {
      return;
    }

    setSessionsSync((prev) => {
      const index = prev.findIndex((s) => s.id === id);
      if (index < 0) return prev;
      const session = prev[index];
      const next = prev.slice();
      next[index] = {
        ...session,
        exited: false,
        exitCode: null,
        connectionState: "connected",
        reconnectAttempt: 0,
        nextReconnectAt: null,
        disconnectReason: null,
        manualReconnectAvailable: false,
      };
      return next;
    });
  }, []);

  const active = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId],
  );

  const activeIsSsh = useMemo(() => {
    return isSshSession(active);
  }, [active]);

  const activeSshTarget = useMemo(() => {
    if (!active) return null;
    const stored = active.sshTarget?.trim() ?? "";
    if (stored) return stored;
    return sshTargetFromCommandLine(active.launchCommand ?? active.restoreCommand ?? null);
  }, [active]);

  const activeHealthSessionId = active?.id ?? null;
  const activeHealthConnectionState = active?.connectionState ?? "connected";

  const sshRootResolveInFlightRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const curProject = projectByIdRef.current.get(activeProjectId) ?? null;
    const projectSsh = isProjectSsh(curProject);
    if (!activeIsSsh && !projectSsh) return;
    if (active && (active.exited || active.closing) && !projectSsh) return;
    if (!activeWorkspaceView.fileExplorerOpen && !activeWorkspaceView.codeEditorOpen) return;

    const currentRoot = (
      activeWorkspaceView.fileExplorerRootDir ??
      activeWorkspaceView.codeEditorRootDir ??
      ""
    ).trim();
    if (currentRoot) return;

    const persistedRoot = (active?.sshRootDir ?? curProject?.sshRemotePath ?? "").trim();
    if (persistedRoot) {
      updateWorkspaceViewForKey(activeWorkspaceKey, activeProjectId, (prev) => {
        const existing = (prev.fileExplorerRootDir ?? prev.codeEditorRootDir ?? "").trim();
        if (existing) return prev;
        return { ...prev, fileExplorerRootDir: persistedRoot, codeEditorRootDir: persistedRoot };
      });
      return;
    }

    const target = activeSshTarget ?? curProject?.sshTarget?.trim() ?? null;
    if (!target) return;
    if (sshRootResolveInFlightRef.current.has(activeWorkspaceKey)) return;

    let cancelled = false;
    sshRootResolveInFlightRef.current.add(activeWorkspaceKey);
    void (async () => {
      try {
        const root = await invoke<string>("ssh_default_root", { target });
        if (cancelled) return;
        updateWorkspaceViewForKey(activeWorkspaceKey, activeProjectId, (prev) => {
          const existing = (prev.fileExplorerRootDir ?? prev.codeEditorRootDir ?? "").trim();
          if (existing) return prev;
          return { ...prev, fileExplorerRootDir: root, codeEditorRootDir: root };
        });
        if (active) {
          setSessionsSync((prev) =>
            prev.map((s) =>
              s.id === active.id
                ? { ...s, sshTarget: s.sshTarget ?? target, sshRootDir: root }
                : s,
            ),
          );
        }
      } catch (err) {
        if (!cancelled) reportError(`Failed to load remote files for ${target}`, err);
      } finally {
        sshRootResolveInFlightRef.current.delete(activeWorkspaceKey);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    active,
    activeIsSsh,
    activeProjectId,
    activeSshTarget,
    activeWorkspaceKey,
    activeWorkspaceView.codeEditorOpen,
    activeWorkspaceView.codeEditorRootDir,
    activeWorkspaceView.fileExplorerOpen,
    activeWorkspaceView.fileExplorerRootDir,
    updateWorkspaceViewForKey,
  ]);

  const closeCodeEditor = useCallback(() => {
    updateActiveWorkspaceView((prev) => ({
      ...prev,
      codeEditorOpen: false,
      openFileRequest: null,
      openWorkspaceTabRequest: null,
    }));
  }, [updateActiveWorkspaceView]);

  const handleSelectWorkspaceFile = useCallback(
    (path: string, mode: CodeEditorOpenFileRequest["mode"] = "auto") => {
      updateActiveWorkspaceView((prev) => {
        const project = projectByIdRef.current.get(activeProjectId) ?? null;
        const root = (
          prev.codeEditorRootDir ??
          prev.fileExplorerRootDir ??
          (!activeIsSsh ? project?.basePath : null) ??
          (!activeIsSsh ? active?.cwd : null) ??
          ""
        )
          .trim();
        if (!root) return prev;
        return {
          ...prev,
          codeEditorOpen: true,
          codeEditorActiveFilePath: path,
          codeEditorRootDir: prev.codeEditorRootDir ?? root,
          fileExplorerRootDir: prev.fileExplorerRootDir ?? root,
          openFileRequest: { path, mode, nonce: Date.now() },
        };
      });
    },
    [active?.cwd, activeIsSsh, activeProjectId, updateActiveWorkspaceView],
  );

  const handleRenameWorkspacePath = useCallback(
    (fromPath: string, toPath: string) => {
      updateActiveWorkspaceView((prev) => ({
        ...prev,
        codeEditorFsEvent: { type: "rename", from: fromPath, to: toPath, nonce: Date.now() } satisfies CodeEditorFsEvent,
      }));
    },
    [updateActiveWorkspaceView],
  );

  const handleDeleteWorkspacePath = useCallback(
    (path: string) => {
      updateActiveWorkspaceView((prev) => ({
        ...prev,
        codeEditorFsEvent: { type: "delete", path, nonce: Date.now() } satisfies CodeEditorFsEvent,
      }));
    },
    [updateActiveWorkspaceView],
  );

  const workspaceEditorVisible = activeWorkspaceView.codeEditorOpen;
  const workspaceTreeVisible = activeWorkspaceView.fileExplorerOpen;

  const agentPanelWidthRef = useRef(agentPanelWidth);
  useEffect(() => { agentPanelWidthRef.current = agentPanelWidth; }, [agentPanelWidth]);

  const beginWorkspaceResize = useCallback(
    (mode: "editor" | "tree" | "agent") => (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      setWorkspaceResizeMode(mode);
      const editorWidth = workspaceEditorWidthRef.current;
      const treeWidth = workspaceFileTreeWidthRef.current;
      workspaceResizeStartRef.current = { x: e.clientX, editorWidth, treeWidth, agentWidth: agentPanelWidthRef.current, projectId: activeProjectId, workspaceKey: activeWorkspaceKey };
      workspaceResizeDraftRef.current = { editorWidth, treeWidth };
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";
    },
    [activeProjectId, activeWorkspaceKey],
  );

  useEffect(() => {
    if (!workspaceResizeMode) return;

    const handleMouseMove = (e: MouseEvent) => {
      const start = workspaceResizeStartRef.current;
      const container = workspaceRowRef.current;
      if (!start || !container) return;

      const dx = e.clientX - start.x;
      const rect = container.getBoundingClientRect();
      const containerWidth = rect.width;

      const currentDraft = workspaceResizeDraftRef.current ?? { editorWidth: start.editorWidth, treeWidth: start.treeWidth };

      if (workspaceResizeMode === "editor" && workspaceEditorVisible) {
        const treeWidth = workspaceTreeVisible ? currentDraft.treeWidth : 0;
        const max = Math.max(
          MIN_WORKSPACE_EDITOR_WIDTH,
          containerWidth - treeWidth - MIN_WORKSPACE_TERMINAL_WIDTH,
        );
        const next = Math.min(max, Math.max(MIN_WORKSPACE_EDITOR_WIDTH, start.editorWidth - dx));
        workspaceResizeDraftRef.current = { ...currentDraft, editorWidth: next };
        container.style.setProperty("--workspaceEditorWidthPx", `${next}px`);
        return;
      }

      if (workspaceResizeMode === "tree" && workspaceTreeVisible) {
        const editorWidth = workspaceEditorVisible ? currentDraft.editorWidth : 0;
        const max = Math.max(
          MIN_WORKSPACE_FILE_TREE_WIDTH,
          containerWidth - editorWidth - MIN_WORKSPACE_TERMINAL_WIDTH,
        );
        const next = Math.min(max, Math.max(MIN_WORKSPACE_FILE_TREE_WIDTH, start.treeWidth - dx));
        workspaceResizeDraftRef.current = { ...currentDraft, treeWidth: next };
        container.style.setProperty("--workspaceFileTreeWidthPx", `${next}px`);
        return;
      }

      if (workspaceResizeMode === "agent" && start.agentWidth != null) {
        const max = Math.max(MIN_AGENT_PANEL_WIDTH, containerWidth - MIN_WORKSPACE_TERMINAL_WIDTH);
        const next = Math.min(MAX_AGENT_PANEL_WIDTH, Math.max(MIN_AGENT_PANEL_WIDTH, Math.min(max, start.agentWidth - dx)));
        container.style.setProperty("--workspaceAgentWidthPx", `${next}px`);
      }
    };

    const handleMouseUp = () => {
      const draft = workspaceResizeDraftRef.current;
      const start = workspaceResizeStartRef.current;

      // Agent panel resize — just persist the width from the CSS variable
      if (workspaceResizeMode === "agent" && start) {
        const container = workspaceRowRef.current;
        if (container) {
          const raw = getComputedStyle(container).getPropertyValue("--workspaceAgentWidthPx");
          const parsed = parseInt(raw, 10);
          if (parsed && parsed >= MIN_AGENT_PANEL_WIDTH) {
            setAgentPanelWidth(parsed);
          }
        }
      } else if (draft && start) {
        const editorWidth = Math.max(MIN_WORKSPACE_EDITOR_WIDTH, Math.floor(draft.editorWidth));
        const treeWidth = Math.max(MIN_WORKSPACE_FILE_TREE_WIDTH, Math.floor(draft.treeWidth));
        setWorkspaceViewByKey((prev) => {
          let changed = false;
          const next: Record<string, WorkspaceView> = { ...prev };

          for (const [key, view] of Object.entries(prev)) {
            if (view.projectId !== start.projectId) continue;
            if (view.editorWidth === editorWidth && view.treeWidth === treeWidth) continue;
            next[key] = { ...view, editorWidth, treeWidth };
            changed = true;
          }

          const current = prev[start.workspaceKey] ?? createInitialWorkspaceView(start.projectId);
          if (!prev[start.workspaceKey] || current.editorWidth !== editorWidth || current.treeWidth !== treeWidth) {
            next[start.workspaceKey] = { ...current, editorWidth, treeWidth };
            changed = true;
          }

          return changed ? next : prev;
        });
      }
      workspaceResizeStartRef.current = null;
      workspaceResizeDraftRef.current = null;
      setWorkspaceResizeMode(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [createInitialWorkspaceView, workspaceEditorVisible, workspaceResizeMode, workspaceTreeVisible]);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  const activeWorkspaceFileRoot = useMemo(
    () =>
      (
        activeWorkspaceView.fileExplorerRootDir ??
        activeWorkspaceView.codeEditorRootDir ??
        (activeIsSsh ? active?.sshRootDir ?? activeProject?.sshRemotePath : activeProject?.basePath ?? active?.cwd) ??
        ""
      ).trim(),
    [
      active?.cwd,
      active?.sshRootDir,
      activeIsSsh,
      activeProject?.basePath,
      activeProject?.sshRemotePath,
      activeWorkspaceView.codeEditorRootDir,
      activeWorkspaceView.fileExplorerRootDir,
    ],
  );

  const projectSessions = useMemo(
    () => sortProjectSessionsForSidebar(sessions, activeProjectId),
    [sessions, activeProjectId],
  );

  // Projects belonging to the active workspace, in their existing order.
  // Unmapped projects fall back to the active workspace so nothing vanishes
  // before the self-heal effect runs.
  const workspaceProjects = useMemo<SidebarProject[]>(
    () =>
      projects
        .filter((p) => (projectWorkspace[p.id] ?? activeWorkspaceId) === activeWorkspaceId)
        .map((p) => ({
          id: p.id,
          title: p.title,
          basePath: p.basePath,
          symbol: p.symbol ?? null,
          color: p.color ?? null,
          sshTarget: p.sshTarget ?? null,
          sshRemotePath: p.sshRemotePath ?? null,
          branch: null,
        })),
    [projects, projectWorkspace, activeWorkspaceId],
  );

  // Sorted sessions per project for the active workspace's tree.
  const sessionsByProject = useMemo(() => {
    const map = new Map<string, SidebarSession[]>();
    for (const p of workspaceProjects) {
      map.set(p.id, sortProjectSessionsForSidebar(sessions, p.id));
    }
    return map;
  }, [sessions, workspaceProjects]);

  const persistentSessionItems = useMemo<PersistentSessionsModalItem[]>(() => {
    if (!persistentSessions.length) return [];
    const projectTitleById = new Map(projects.map((p) => [p.id, p.title]));
    const activeByPersistId = new Map<string, Session>();
    for (const s of sessions) {
      if (s.exited || s.closing) continue;
      if (s.connectionState === "reconnecting" || s.connectionState === "disconnected") continue;
      if (!activeByPersistId.has(s.persistId)) activeByPersistId.set(s.persistId, s);
    }
    const out: PersistentSessionsModalItem[] = [];

    for (const ps of persistentSessions) {
      const activeSession = activeByPersistId.get(ps.persistId) ?? null;
      const openInUi = Boolean(activeSession);
      const projectTitle = activeSession ? projectTitleById.get(activeSession.projectId) ?? null : null;
      const label = activeSession
        ? projectTitle
          ? `${activeSession.name} — ${projectTitle}`
          : activeSession.name
        : ps.sessionName;
      out.push({
        persistId: ps.persistId,
        sessionName: ps.sessionName,
        label,
        openInUi,
      });
    }

    out.sort((a, b) => {
      if (a.openInUi !== b.openInUi) return a.openInUi ? -1 : 1;
      return a.persistId.localeCompare(b.persistId);
    });
    return out;
  }, [persistentSessions, projects, sessions]);

  const applyPendingExit = useCallback((session: Session): Session => {
    const pending = pendingExitCodes.current.get(session.id);
    if (pending === undefined) return session;
    pendingExitCodes.current.delete(session.id);
    agentWorkingMapRef.current.set(session.id, false);
    const reconnectable = isSshSession(session);
    return {
      ...session,
      exited: true,
      exitCode: pending,
      recordingActive: false,
      connectionState: reconnectable ? "disconnected" : session.connectionState ?? "connected",
      manualReconnectAvailable: reconnectable,
      disconnectReason: reconnectable ? "Session exited before attach." : session.disconnectReason ?? null,
    };
  }, []);

  const reconnectSshSessionRef = useRef<
    (id: string, reason: string, options?: { immediate?: boolean; manual?: boolean }) => void
  >(() => {});

  const reconnectSshSession = useCallback(
    (id: string, reason: string, options?: { immediate?: boolean; manual?: boolean }) => {
      const manual = Boolean(options?.manual);
      const immediate = Boolean(options?.immediate);
      const base = sessionByIdRef.current.get(id) ?? null;
      if (!base) return;
      if (base.closing) return;
      if (!isSshSession(base)) return;
      if (base.manualReconnectAvailable && !manual) return;
      if (!manual && reconnectTimersRef.current.has(id)) return;
      if (!manual && reconnectInFlightRef.current.has(id)) return;

      clearReconnectTimer(id);
      if (manual) reconnectInFlightRef.current.delete(id);

      const previousAttempt = manual ? 0 : Math.max(0, base.reconnectAttempt ?? 0);
      const nextAttempt = previousAttempt + 1;
      if (nextAttempt > SSH_RECONNECT_MAX_ATTEMPTS) {
        setSessionsSync((prev) =>
          prev.map((s) =>
            s.id === id
              ? {
                  ...s,
                  connectionState: "disconnected",
                  nextReconnectAt: null,
                  disconnectReason: reason || "SSH disconnected.",
                  manualReconnectAvailable: true,
                  reconnectAttempt: SSH_RECONNECT_MAX_ATTEMPTS,
                  exited: false,
                  exitCode: null,
                }
              : s,
          ),
        );
        return;
      }

      const delayMs = immediate ? 0 : reconnectDelayMsForAttempt(nextAttempt);
      const nextReconnectAt = Date.now() + delayMs;

      setSessionsSync((prev) =>
        prev.map((s) =>
          s.id === id
            ? {
                ...s,
                exited: false,
                exitCode: null,
                recordingActive: false,
                connectionState: "reconnecting",
                reconnectAttempt: nextAttempt,
                nextReconnectAt,
                disconnectReason: reason || "SSH disconnected.",
                manualReconnectAvailable: false,
              }
            : s,
        ),
      );

      const attemptReconnect = async () => {
        const current = sessionByIdRef.current.get(id) ?? null;
        if (!current) return;
        if (current.closing) return;
        if (!isSshSession(current)) return;
        if (reconnectInFlightRef.current.has(id)) return;

        reconnectInFlightRef.current.add(id);
        let replacementId: string | null = null;
        try {
          const fallbackCommand =
            current.sshTarget && !current.launchCommand && !current.restoreCommand
              ? `ssh ${current.sshTarget}`
              : null;
          const baseCommand = ensureSshKeepAliveOptions(
            current.launchCommand ?? current.restoreCommand ?? fallbackCommand,
          );
          const launchCommand = current.persistent ? null : baseCommand;
          const restoreCommand = current.persistent
            ? baseCommand
            : ensureSshKeepAliveOptions(current.restoreCommand ?? baseCommand);
          const cwd =
            current.cwd ??
            projectByIdRef.current.get(current.projectId)?.basePath ??
            homeDirRef.current ??
            null;
          const envVars = envVarsForProjectId(
            current.projectId,
            projectsRef.current,
            environmentsRef.current,
          );

          const createdRaw = await createSession({
            projectId: current.projectId,
            name: current.name,
            launchCommand,
            restoreCommand,
            sshTarget: current.sshTarget,
            sshRootDir: current.sshRootDir,
            lastRecordingId: current.lastRecordingId ?? null,
            cwd,
            envVars,
            persistent: current.persistent,
            persistId: current.persistId,
            createdAt: current.createdAt,
          });
          const created = applyPendingExit(createdRaw);
          replacementId = created.id;

          if (current.persistent) {
            const bootstrap = (restoreCommand ?? launchCommand ?? "").trim();
            if (bootstrap) {
              await invoke("write_to_session", {
                id: created.id,
                data: bootstrap,
                source: "system",
              });
              await sleep(30);
              await invoke("write_to_session", { id: created.id, data: "\r", source: "system" });
            }
          }

          if (!sessionByIdRef.current.has(id)) {
            await closeSession(created.id).catch(() => {});
            replacementId = null;
            return;
          }

          clearSessionRuntimeBuffers(id);
          commandLifecycleSessionsRef.current.delete(id);

          setSessionsSync((prev) => {
            const index = prev.findIndex((s) => s.id === id);
            if (index < 0) return prev;
            const previous = prev[index];
            const next = prev.slice();
            next[index] = {
              ...previous,
              ...created,
              id: created.id,
              name: previous.name,
              projectId: previous.projectId,
              persistId: previous.persistId,
              persistent: previous.persistent,
              createdAt: previous.createdAt,
              launchCommand: previous.launchCommand ?? created.launchCommand,
              restoreCommand: previous.restoreCommand ?? created.restoreCommand,
              sshTarget: previous.sshTarget ?? created.sshTarget,
              sshRootDir: previous.sshRootDir ?? created.sshRootDir,
              lastRecordingId: previous.lastRecordingId ?? created.lastRecordingId,
              symbol: previous.symbol,
              // Keep an explicit agent classification (e.g. an SSH-wrapped
              // claude/codex session whose effect can't be re-detected from the
              // `ssh …` launch command).
              effectId: previous.effectId ?? created.effectId,
              recordingActive: false,
              exited: false,
              closing: false,
              exitCode: null,
              connectionState: "connected",
              reconnectAttempt: nextAttempt,
              nextReconnectAt: null,
              disconnectReason: null,
              manualReconnectAvailable: false,
            };
            return next;
          });

          lastActiveByProject.current.set(current.projectId, created.id);
          setActiveId((prevActive) => (prevActive === id ? created.id : prevActive));
        } catch (err) {
          const message = formatError(err);
          if (replacementId) {
            await closeSession(replacementId).catch(() => {});
          }
          const latest = sessionByIdRef.current.get(id) ?? null;
          if (!latest || latest.closing) return;
          if ((latest.reconnectAttempt ?? nextAttempt) >= SSH_RECONNECT_MAX_ATTEMPTS) {
            setSessionsSync((prev) =>
              prev.map((s) =>
                s.id === id
                  ? {
                      ...s,
                      connectionState: "disconnected",
                      disconnectReason: message || "SSH disconnected.",
                      manualReconnectAvailable: true,
                      nextReconnectAt: null,
                    }
                  : s,
              ),
            );
            return;
          }
          reconnectSshSessionRef.current(id, message || "SSH reconnect failed.", {
            immediate: false,
          });
        } finally {
          reconnectInFlightRef.current.delete(id);
        }
      };

      if (delayMs === 0) {
        void attemptReconnect();
        return;
      }

      const timeout = window.setTimeout(() => {
        reconnectTimersRef.current.delete(id);
        void attemptReconnect();
      }, delayMs);
      reconnectTimersRef.current.set(id, timeout);
    },
    [applyPendingExit, clearReconnectTimer, clearSessionRuntimeBuffers],
  );

  reconnectSshSessionRef.current = reconnectSshSession;

  const runSessionHealthCheckRef = useRef<(reason: string, force?: boolean) => void>(() => {});

  const runSessionHealthCheck = useCallback(
    (reason: string, force = false) => {
      if (!hydratedRef.current) return;
      if (!force && document.visibilityState !== "visible") return;
      const now = Date.now();
      if (!force && now - lastHealthCheckAtRef.current < SESSION_HEALTHCHECK_MIN_GAP_MS) return;
      if (healthCheckInFlightRef.current) return;

      healthCheckInFlightRef.current = true;
      lastHealthCheckAtRef.current = now;

      void (async () => {
        try {
          const backend = await invoke<SessionInfo[]>("list_sessions");
          const backendIds = new Set(backend.map((s) => s.id));
          const missingSsh: string[] = [];
          const missingOther: string[] = [];
          const missingPersistent: string[] = [];

          for (const session of sessionsRef.current) {
            if (session.exited || session.closing) continue;
            if ((session.connectionState ?? "connected") === "reconnecting") continue;
            if (backendIds.has(session.id)) continue;
            if (session.persistent) missingPersistent.push(session.id);
            else if (isSshSession(session)) missingSsh.push(session.id);
            else missingOther.push(session.id);
          }

          if (missingOther.length > 0) {
            const missingSet = new Set(missingOther);
            setSessionsSync((prev) =>
              prev.map((s) =>
                missingSet.has(s.id)
                  ? {
                      ...s,
                      exited: true,
                      exitCode: s.exitCode ?? null,
                      recordingActive: false,
                      connectionState: "disconnected",
                      disconnectReason: `Session lost (${reason}).`,
                      manualReconnectAvailable: false,
                    }
                  : s,
              ),
            );
            for (const id of missingOther) {
              clearSessionRuntimeBuffers(id);
            }
          }

          // Re-attach persistent sessions that lost their backend PTY
          for (const id of missingPersistent) {
            const s = sessionByIdRef.current.get(id);
            if (!s) continue;
            try {
              const created = await createSession({
                projectId: s.projectId,
                name: s.name,
                persistent: true,
                persistId: s.persistId,
                cwd: s.cwd,
                envVars: envVarsForProjectId(s.projectId, projectsRef.current, environmentsRef.current),
                createdAt: s.createdAt,
                pinned: s.pinned,
                sidebarOrder: s.sidebarOrder,
              });
              setSessionsSync(prev => prev.map(x => x.id === id ? { ...created, connectionState: "connected" as const } : x));
              setActiveId(prev => prev === id ? created.id : prev);
            } catch {
              setSessionsSync(prev => prev.map(x =>
                x.id === id ? { ...x, exited: true, connectionState: "disconnected" as const, disconnectReason: `Session lost after sleep (${reason}).` } : x
              ));
              clearSessionRuntimeBuffers(id);
            }
          }

          for (const id of missingSsh) {
            reconnectSshSessionRef.current(id, `SSH lost (${reason}).`, { immediate: true });
          }
        } catch {
          // Best-effort reconciliation.
        } finally {
          healthCheckInFlightRef.current = false;
        }
      })();
    },
    [clearSessionRuntimeBuffers],
  );

  runSessionHealthCheckRef.current = runSessionHealthCheck;

  useEffect(() => {
    if (!hydrated) return;

    let lastActiveAt = Date.now();
    let lastTimerTickAt = Date.now();
    let lastFrameAt = performance.now();
    let lastRecoveryRequestedAt = 0;
    let recoveryBatch = 0;
    let activeRecoveryBatch: {
      id: number;
      generation: number;
      source: string;
      force: boolean;
      healthCheckPending: boolean;
    } | null = null;
    let frameId: number | null = null;
    let frameProbeRemaining = 0;
    let disposed = false;
    const recoveryTimers: number[] = [];
    const windowUnlisteners: Array<() => void> = [];

    const clearRecoveryTimers = () => {
      for (const timer of recoveryTimers.splice(0)) {
        window.clearTimeout(timer);
      }
    };

    const forceWebviewRepaint = () => {
      const root = document.getElementById("root");
      if (!root) return;
      root.classList.remove("agentsUiWakeRepaint");
      void root.offsetHeight;
      root.classList.add("agentsUiWakeRepaint");
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          root.classList.remove("agentsUiWakeRepaint");
        });
      });
    };

    const recoverAllCanvases = (source: string, generation: number, force = false) => {
      forceWebviewRepaint();
      for (const [id, entry] of registry.current.entries()) {
        // SessionTerminal owns visibility-aware deferral. Passing the same
        // generation through every delayed probe guarantees one CanvasAddon
        // replacement at most; subsequent calls are refresh-only and hidden
        // terminals retain just one deferred request until activation.
        try { entry.recoverCanvas({ force, source, generation }); } catch { console.warn("[agents-ui] Failed to recover canvas for session", id); }
      }
    };

    const scheduleCanvasRecovery = (
      source: string,
      options: { force?: boolean; healthCheck?: boolean; bypassThrottle?: boolean } = {},
    ) => {
      const now = Date.now();
      // Several independent APIs report one physical wake (AppKit, Tauri,
      // pageshow/focus, and the timer-gap watchdog). Always collapse signals in
      // this small window, even for otherwise-authoritative sources. Merge the
      // stronger request into the live batch so an earlier scale notification
      // cannot discard a later native wake health check.
      if (
        now - lastRecoveryRequestedAt < DISPLAY_WAKE_RECOVERY_COALESCE_MS
        && activeRecoveryBatch !== null
      ) {
        activeRecoveryBatch.force ||= options.force ?? true;
        activeRecoveryBatch.source = source;
        if (options.healthCheck && !activeRecoveryBatch.healthCheckPending) {
          activeRecoveryBatch.healthCheckPending = true;
          const batch = activeRecoveryBatch;
          const timer = window.setTimeout(() => {
            const index = recoveryTimers.indexOf(timer);
            if (index >= 0) recoveryTimers.splice(index, 1);
            if (!disposed && activeRecoveryBatch?.id === batch.id) {
              batch.healthCheckPending = false;
              runSessionHealthCheckRef.current(batch.source, true);
            }
          }, 2_000);
          recoveryTimers.push(timer);
        }
        return;
      }
      if (!options.bypassThrottle && now - lastRecoveryRequestedAt < DISPLAY_WAKE_RECOVERY_MIN_GAP_MS) return;
      lastRecoveryRequestedAt = now;
      recoveryBatch += 1;
      const batch = recoveryBatch;
      displayWakeRecoveryGeneration += 1;
      const generation = displayWakeRecoveryGeneration;
      const healthCheckPending = options.healthCheck === true
        || activeRecoveryBatch?.healthCheckPending === true;
      clearRecoveryTimers();
      activeRecoveryBatch = {
        id: batch,
        generation,
        source,
        force: options.force ?? true,
        healthCheckPending,
      };

      console.warn(`[agents-ui] Recovering terminal canvases after ${source}.`);
      for (const delay of DISPLAY_WAKE_RECOVERY_DELAYS_MS) {
        const timer = window.setTimeout(() => {
          const index = recoveryTimers.indexOf(timer);
          if (index >= 0) recoveryTimers.splice(index, 1);
          const activeBatch = activeRecoveryBatch;
          if (disposed || batch !== recoveryBatch || activeBatch?.id !== batch) return;
          recoverAllCanvases(activeBatch.source, activeBatch.generation, activeBatch.force);
        }, delay);
        recoveryTimers.push(timer);
      }
      if (healthCheckPending) {
        const timer = window.setTimeout(() => {
          const index = recoveryTimers.indexOf(timer);
          if (index >= 0) recoveryTimers.splice(index, 1);
          const activeBatch = activeRecoveryBatch;
          if (!disposed && activeBatch?.id === batch) {
            activeBatch.healthCheckPending = false;
            runSessionHealthCheckRef.current(activeBatch.source, true);
          }
        }, 2_000);
        recoveryTimers.push(timer);
      }
    };

    const maybeTriggerCanvasRecovery = (elapsed: number, source: string) => {
      if (elapsed > SLEEP_DETECTION_GAP_MS) {
        console.warn(`[agents-ui] Detected possible wake from sleep via ${source} (gap=${elapsed}ms).`);
        scheduleCanvasRecovery(source, { force: true });
      }
    };

    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        lastActiveAt = Date.now();
        return;
      }
      const elapsed = Date.now() - lastActiveAt;
      lastActiveAt = Date.now();
      runSessionHealthCheckRef.current("visibility", true);
      maybeTriggerCanvasRecovery(elapsed, "visibilitychange");
      runFrameGapProbe();
    };
    const onFocus = () => {
      const elapsed = Date.now() - lastActiveAt;
      lastActiveAt = Date.now();
      runSessionHealthCheckRef.current("focus", true);
      maybeTriggerCanvasRecovery(elapsed, "focus");
      runFrameGapProbe();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      const elapsed = Date.now() - lastActiveAt;
      lastActiveAt = Date.now();
      runSessionHealthCheckRef.current("pageshow", true);
      if (event.persisted) {
        scheduleCanvasRecovery("pageshow-cache-restore", { force: true, healthCheck: true, bypassThrottle: true });
        return;
      }
      maybeTriggerCanvasRecovery(elapsed, "pageshow");
    };
    const onDocumentResume = () => {
      lastActiveAt = Date.now();
      scheduleCanvasRecovery("document-resume", { force: true, healthCheck: true, bypassThrottle: true });
    };
    const onWindowResize = () => {
      const elapsed = Date.now() - lastActiveAt;
      if (elapsed > SLEEP_DETECTION_GAP_MS) {
        lastActiveAt = Date.now();
        scheduleCanvasRecovery("window-resize-after-idle", { force: true });
      }
    };
    const onFrame = (timestamp: number) => {
      const elapsed = timestamp - lastFrameAt;
      lastFrameAt = timestamp;
      if (document.visibilityState === "visible" && elapsed > DISPLAY_WAKE_RENDER_GAP_MS) {
        scheduleCanvasRecovery(`render-frame-gap-${Math.round(elapsed)}ms`, { force: true, healthCheck: true });
      }
      // Self-limiting: only keep stepping while a probe is active, then stop.
      // A perpetual rAF here would pin the compositor at ~60fps even when fully
      // idle and defeat macOS low-power coalescing.
      if (frameProbeRemaining > 0) {
        frameProbeRemaining -= 1;
        frameId = window.requestAnimationFrame(onFrame);
      } else {
        frameId = null;
      }
    };

    // Run a short rAF burst to catch a render stall right around a wake/focus/
    // visibility signal. Real sleep/GPU-reset recovery is independently covered
    // by the 2s timer-gap watchdog, the explicit wake events (system-resumed,
    // visibility, focus, pageshow, scale, resize) and the per-canvas
    // contextlost/webglcontextlost listeners — so the burst is supplemental and
    // stops on its own, letting the app idle at ~0 wakeups when nothing happens.
    const runFrameGapProbe = () => {
      // Reset the baseline so the first probe frame doesn't false-positive on
      // the idle gap accumulated since the previous burst.
      lastFrameAt = performance.now();
      frameProbeRemaining = 12;
      if (frameId === null) {
        frameId = window.requestAnimationFrame(onFrame);
      }
    };
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      runSessionHealthCheckRef.current("interval");
    }, SESSION_HEALTHCHECK_VISIBLE_INTERVAL_MS);
    const displayWatchdogInterval = window.setInterval(() => {
      const now = Date.now();
      const elapsed = now - lastTimerTickAt;
      lastTimerTickAt = now;
      if (document.visibilityState === "visible" && elapsed > DISPLAY_WAKE_RENDER_GAP_MS) {
        scheduleCanvasRecovery(`timer-gap-${elapsed}ms`, { force: true, healthCheck: true });
        runFrameGapProbe();
      }
    }, DISPLAY_WAKE_TIMER_INTERVAL_MS);

    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("resume", onDocumentResume);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("resize", onWindowResize);
    runFrameGapProbe();
    runSessionHealthCheckRef.current("startup", true);

    // Tauri emits "system-resumed" when macOS wakes from sleep — more reliable than timestamp gaps
    let unlistenResumed: (() => void) | null = null;
    listen<number>("system-resumed", ({ payload: generation }) => {
      if (disposed) return;
      console.warn("[agents-ui] System resumed from sleep (Tauri event).");
      if (Number.isSafeInteger(generation) && generation > 0) {
        // This acknowledgement is deliberately only a renderer-liveness signal;
        // native recovery does not depend on the later canvas/browser work.
        void invoke("acknowledge_display_recovery_event", { generation }).catch((err) => {
          console.warn("[agents-ui] Failed to acknowledge display recovery event", err);
        });
      }
      lastActiveAt = Date.now();
      lastTimerTickAt = Date.now();
      scheduleCanvasRecovery("sleep-resume", { force: true, healthCheck: true, bypassThrottle: true });
    }).then((fn) => {
      if (disposed) fn();
      else unlistenResumed = fn;
    }).catch((err) => {
      console.warn("[agents-ui] Failed to register system resume listener", err);
    });

    const appWindow = getCurrentWindow();
    appWindow.onFocusChanged(({ payload: focused }) => {
      if (!focused) {
        lastActiveAt = Date.now();
        return;
      }
      const elapsed = Date.now() - lastActiveAt;
      lastActiveAt = Date.now();
      runSessionHealthCheckRef.current("tauri-focus", true);
      maybeTriggerCanvasRecovery(elapsed, "tauri-focus");
    }).then((fn) => {
      if (disposed) fn();
      else windowUnlisteners.push(fn);
    }).catch((err) => {
      console.warn("[agents-ui] Failed to register window focus listener", err);
    });
    appWindow.onScaleChanged(() => {
      scheduleCanvasRecovery("window-scale-change", { force: true, bypassThrottle: true });
    }).then((fn) => {
      if (disposed) fn();
      else windowUnlisteners.push(fn);
    }).catch((err) => {
      console.warn("[agents-ui] Failed to register window scale listener", err);
    });
    appWindow.onResized(() => {
      onWindowResize();
    }).then((fn) => {
      if (disposed) fn();
      else windowUnlisteners.push(fn);
    }).catch((err) => {
      console.warn("[agents-ui] Failed to register window resize listener", err);
    });

    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.clearInterval(displayWatchdogInterval);
      clearRecoveryTimers();
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("resume", onDocumentResume);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("resize", onWindowResize);
      for (const unlisten of windowUnlisteners.splice(0)) {
        unlisten();
      }
      unlistenResumed?.();
    };
  }, [hydrated]);

  const addSessionWithProjectSafeActivation = useCallback((session: Session) => {
    setSessionsSync((prev) => {
      if (prev.some((s) => s.id === session.id)) {
        if (import.meta.env.DEV) {
          console.warn(`[addSession] Duplicate session id=${session.id} name="${session.name}" — skipped`);
        }
        return prev;
      }
      return [...prev, session];
    });
    if ((session.runningCommand ?? "").trim()) {
      scheduleRunningCommandActivityTimeout(session.id);
    }
    if (activeProjectIdRef.current === session.projectId) {
      setActiveId(session.id);
      return;
    }
    if (import.meta.env.DEV) {
      console.warn(
        `[addSession] Session "${session.name}" (project=${session.projectId}) added but NOT activated ` +
        `— active project is ${activeProjectIdRef.current}`,
      );
    }
    lastActiveByProject.current.set(session.projectId, session.id);
    flushPendingSave();
  }, [scheduleRunningCommandActivityTimeout, flushPendingSave]);

  const handleOpenTerminalAtPath = useCallback(
    async (path: string, provider: "local" | "ssh", sshTarget: string | null) => {
      const desiredPath = path.trim();
      if (!desiredPath) return;

      const projectId = activeProjectId;
      const envVars = envVarsForProjectId(projectId, projects, environments);

      if (provider === "local") {
        const validatedCwd = await invoke<string | null>("validate_directory", { path: desiredPath }).catch(() => null);
        if (!validatedCwd) {
          showNotice("Working directory must be an existing folder.");
          return;
        }
        await ensureAutoAssets(validatedCwd, projectId);
        try {
          const createdRaw = await createSession({
            projectId,
            name: basenamePath(validatedCwd) || undefined,
            cwd: validatedCwd,
            envVars,
          });
          const s = applyPendingExit(createdRaw);
          addSessionWithProjectSafeActivation(s);
        } catch (err) {
          reportError("Failed to create session", err);
        }
        return;
      }

      const target = (sshTarget ?? "").trim();
      if (!target) {
        showNotice("Missing SSH target.");
        return;
      }

      const localDesiredCwd = activeProject?.basePath ?? homeDirRef.current ?? "";
      const localValidatedCwd = await invoke<string | null>("validate_directory", { path: localDesiredCwd }).catch(
        () => null,
      );
      if (localValidatedCwd) {
        await ensureAutoAssets(localValidatedCwd, projectId);
      }

      const baseCommandLine = (active?.restoreCommand ?? active?.launchCommand ?? "").trim() || null;
      const launchCommand = buildSshCommandAtRemoteDir({
        baseCommandLine,
        target,
        remoteDir: desiredPath,
      });

      try {
        const createdRaw = await createSession({
          projectId,
          name: `ssh ${target}: ${shortenPathSmart(desiredPath, 48)}`,
          launchCommand,
          cwd: localValidatedCwd ?? localDesiredCwd ?? null,
          envVars,
          sshTarget: target,
          sshRootDir:
            (activeWorkspaceView.fileExplorerRootDir ?? activeWorkspaceView.codeEditorRootDir ?? active?.sshRootDir) ??
            null,
        });
        const s = applyPendingExit(createdRaw);
        addSessionWithProjectSafeActivation(s);
      } catch (err) {
        reportError("Failed to create SSH session", err);
      }
    },
    [
      active?.launchCommand,
      active?.restoreCommand,
      active?.sshRootDir,
      activeProject?.basePath,
      activeProjectId,
      activeWorkspaceView.codeEditorRootDir,
      activeWorkspaceView.fileExplorerRootDir,
      applyPendingExit,
      addSessionWithProjectSafeActivation,
      assetSettings.autoApplyEnabled,
      assets,
      environments,
      projects,
    ],
  );

  useEffect(() => {
    // Dedup guard: if the sessions array has duplicates by id, fix it.
    // Ref sync is handled by setSessionsSync — this only handles the rare dedup case.
    const seenIds = new Set<string>();
    let hasDupes = false;
    for (const s of sessions) {
      if (seenIds.has(s.id)) { hasDupes = true; break; }
      seenIds.add(s.id);
    }
    if (hasDupes) {
      if (import.meta.env.DEV) {
        console.warn(`[sessions sync] Detected duplicate session IDs — deduplicating`);
      }
      const deduped: Session[] = [];
      const seen = new Set<string>();
      for (const s of sessions) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        deduped.push(s);
      }
      setSessionsSync(deduped);
    }
  }, [sessions, setSessionsSync]);

  useEffect(() => {
    const activeRunningCommands = new Set<string>();
    for (const session of sessions) {
      const hasRunningCommand = Boolean((session.runningCommand ?? "").trim());
      const canTrack =
        hasRunningCommand &&
        !session.exited &&
        !session.closing &&
        session.connectionState !== "reconnecting" &&
        session.connectionState !== "disconnected";
      if (!canTrack) {
        clearCommandActivityTimer(session.id);
        continue;
      }
      activeRunningCommands.add(session.id);
      if (!commandActivityTimersRef.current.has(session.id)) {
        scheduleRunningCommandActivityTimeout(session.id);
      }
    }

    for (const id of Array.from(commandActivityTimersRef.current.keys())) {
      if (!activeRunningCommands.has(id)) {
        clearCommandActivityTimer(id);
      }
    }
  }, [sessions, clearCommandActivityTimer, scheduleRunningCommandActivityTimeout]);

	  useLayoutEffect(() => {
	    activeIdRef.current = activeId;
	    if (outputFlushRafRef.current !== null) {
	      window.cancelAnimationFrame(outputFlushRafRef.current);
	      outputFlushRafRef.current = null;
	    }
    flushQueuedOutput(activeId);
    // Cancel exited-session auto-cleanup if user switches back to it
    if (activeId) {
      const cleanupTimer = exitedCleanupTimers.current.get(activeId);
      if (cleanupTimer !== undefined) {
        window.clearTimeout(cleanupTimer);
	        exitedCleanupTimers.current.delete(activeId);
	      }
	    }
	  }, [activeId, flushQueuedOutput]);

  // Split view invariant: while a split view is active, the focused session must be a member.
  // If the user switches to a different session (sidebar click, Ctrl+Tab, etc), exit the split view
  // rather than injecting the new session into the split layout.
  useEffect(() => {
    if (!activeSplitViewId) return;
    const view = activeSplitView;
    if (!view) {
      setActiveSplitViewId(null);
      return;
    }
    if (!activeId || (activeId !== view.aId && activeId !== view.bId)) {
      setActiveSplitViewId(null);
      return;
    }
    if (view.lastFocusedId !== activeId) {
      setSplitViews((prev) => {
        const idx = prev.findIndex((v) => v.id === view.id);
        if (idx < 0) return prev;
        if (prev[idx].lastFocusedId === activeId) return prev;
        const next = prev.slice();
        next[idx] = { ...prev[idx], lastFocusedId: activeId };
        return next;
      });
    }
  }, [activeId, activeSplitView, activeSplitViewId]);

  useEffect(() => {
    hydratedRef.current = hydrated;
  }, [hydrated]);

  // ── External Control API bridge ──
  useEffect(() => {
    if (!hydrated) return;

    // Shared helpers for recording start/stop (used by both sessions.* and recordings.* methods)
    async function doStartRecording(sessionId: string, name: string) {
      const s = sessionsRef.current.find((s) => s.id === sessionId);
      if (!s) throw new Error("session not found");
      if (s.recordingActive) throw new Error("recording already active");

      const recordingId = makeId();
      const effect = getProcessEffectById(s.effectId);
      const bootstrapCommand =
        (s.launchCommand ?? null) ||
        (s.restoreCommand?.trim() ? s.restoreCommand.trim() : null) ||
        (effect?.matchCommands?.[0] ?? null);
      const safeId = await invoke<string>("start_session_recording", {
        id: s.id,
        recordingId,
        recordingName: name,
        encrypt: secureStorageModeRef.current === "keychain",
        projectId: s.projectId,
        sessionPersistId: s.persistId,
        cwd: s.cwd,
        effectId: s.effectId ?? null,
        bootstrapCommand,
      });
      setSessionsSync((prev) =>
        prev.map((x) =>
          x.id === sessionId
            ? { ...x, recordingActive: true, lastRecordingId: safeId }
            : x,
        ),
      );
      showToast({ tone: "success", message: `Recording started — “${name}”` });
      return { sessionId, recordingId: safeId };
    }

    async function doStopRecording(sessionId: string) {
      const s = sessionsRef.current.find((s) => s.id === sessionId);
      if (!s) throw new Error("session not found");
      if (!s.recordingActive) throw new Error("no active recording");

      try {
        await invoke("stop_session_recording", { id: s.id });
      } finally {
        setSessionsSync((prev) =>
          prev.map((x) => (x.id === sessionId ? { ...x, recordingActive: false } : x)),
        );
      }
      showToast({ tone: "success", message: "Recording saved." });
      return { sessionId };
    }

    function activeWorkspaceProvider(): "local" | "ssh" {
      const activeSession = sessionsRef.current.find((s) => s.id === activeIdRef.current) ?? null;
      const project = projectByIdRef.current.get(activeProjectIdRef.current) ?? null;
      if (activeSession) return isSshSession(activeSession) ? "ssh" : "local";
      return (project?.sshTarget ?? "").trim() ? "ssh" : "local";
    }

    function activeWorkspaceRoot(): string {
      const view = activeWorkspaceViewRef.current;
      const project = projectByIdRef.current.get(activeProjectIdRef.current) ?? null;
      const activeSession = sessionsRef.current.find((s) => s.id === activeIdRef.current) ?? null;
      const provider = activeWorkspaceProvider();
      const root = (
        view.codeEditorRootDir ??
        view.fileExplorerRootDir ??
        (provider === "ssh"
          ? activeSession?.sshRootDir ?? project?.sshRemotePath ?? ""
          : project?.basePath ?? activeSession?.cwd ?? "")
      ).trim();
      if (root) return root;
      if (provider === "local") return "/";
      throw new Error("workspace root is not resolved yet");
    }

    function activeWorkspaceRootOrEmpty(): string {
      try {
        return activeWorkspaceRoot();
      } catch {
        return "";
      }
    }

    function fallbackWorkspaceSnapshot(): CodeEditorWorkspaceSnapshot {
      const view = activeWorkspaceViewRef.current;
      const activeTabId = view.codeEditorActiveFilePath ?? view.codeEditorPersistedState?.activePath ?? null;
      const tabs: CodeEditorWorkspaceTab[] = (view.codeEditorPersistedState?.tabs ?? []).map((tab) => ({
        id: tab.path,
        kind: "file",
        title: tab.path.split("/").filter(Boolean).slice(-1)[0] ?? tab.path,
        active: tab.path === activeTabId,
        path: tab.path,
        url: null,
        label: null,
        viewerKind: tab.viewerKind ?? null,
        requestedMode: "auto",
        dirty: Boolean(tab.dirty),
        loading: false,
        error: null,
        locked: Boolean(tab.locked),
        size: null,
        mime: null,
        imageType: null,
      }));
      return {
        provider: activeWorkspaceProvider(),
        rootDir: activeWorkspaceRootOrEmpty(),
        activeTabId,
        activeFilePath: activeTabId,
        tabs,
      };
    }

    function requireWorkspaceEditor(): CodeEditorPanelHandle {
      const handle = codeEditorPanelRef.current;
      if (!handle) throw new Error("file viewer/editor is not open");
      return handle;
    }

    function parseEditorMode(value: unknown): CodeEditorOpenFileRequest["mode"] | undefined {
      return value === "auto" ||
        value === "text" ||
        value === "image" ||
        value === "bytes" ||
        value === "markdown" ||
        value === "json" ||
        value === "csv" ||
        value === "xlsx"
        ? value
        : undefined;
    }

    function normalizeBrowserApiUrl(value: string): string {
      const trimmed = value.trim();
      if (!trimmed) throw new Error("url is required");
      const candidate = trimmed.includes("://") || trimmed.startsWith("about:") ? trimmed : `https://${trimmed}`;
      new URL(candidate);
      return candidate;
    }

    function queueWorkspaceTabRequest(request: CodeEditorOpenWorkspaceTabRequest) {
      const root = activeWorkspaceRoot();
      const workspaceKey = activeWorkspaceKeyRef.current;
      const projectId = activeProjectIdRef.current;
      updateWorkspaceViewForKey(workspaceKey, projectId, (prev) => ({
        ...prev,
        codeEditorOpen: true,
        codeEditorRootDir: prev.codeEditorRootDir ?? root,
        fileExplorerRootDir: prev.fileExplorerRootDir ?? root,
        codeEditorActiveFilePath:
          request.kind === "file" && request.path ? request.path : prev.codeEditorActiveFilePath,
        openWorkspaceTabRequest: request,
      }));
      return { queued: true, request, workspace: fallbackWorkspaceSnapshot() };
    }

    function listFileViewerTabs() {
      return codeEditorPanelRef.current?.workspaceSnapshot() ?? fallbackWorkspaceSnapshot();
    }

    async function openFileViewerTab(p: Record<string, unknown>) {
      const kind = p.kind === "browser" || p.kind === "file"
        ? p.kind
        : typeof p.url === "string"
          ? "browser"
          : "file";
      const request: CodeEditorOpenWorkspaceTabRequest = {
        nonce: Date.now(),
        kind,
        path: typeof p.path === "string" ? p.path : null,
        url: typeof p.url === "string" ? p.url : null,
        title: typeof p.title === "string" ? p.title : null,
      };
      if (kind === "file" && !request.path?.trim()) throw new Error("path is required");
      if (kind === "browser" && request.url?.trim()) request.url = normalizeBrowserApiUrl(request.url);
      const mode = parseEditorMode(p.mode);
      if (mode) request.mode = mode;
      const handle = codeEditorPanelRef.current;
      if (!handle) {
        const queued = queueWorkspaceTabRequest(request);
        notifyStateChange("file_viewer.tabs.open_queued", queued);
        return queued;
      }
      const tab = await handle.openWorkspaceTab(request);
      notifyStateChange("file_viewer.tabs.opened", { tab });
      return { queued: false, tab };
    }

    function focusFileViewerTab(p: Record<string, unknown>) {
      const tab = requireWorkspaceEditor().focusWorkspaceTab({
        tabId: typeof p.tabId === "string" ? p.tabId : null,
        path: typeof p.path === "string" ? p.path : null,
      });
      notifyStateChange("file_viewer.tabs.focused", { tabId: tab.id });
      return tab;
    }

    function closeFileViewerTab(p: Record<string, unknown>) {
      const tab = requireWorkspaceEditor().closeWorkspaceTab({
        tabId: typeof p.tabId === "string" ? p.tabId : null,
        path: typeof p.path === "string" ? p.path : null,
        force: p.force === true,
      });
      notifyStateChange("file_viewer.tabs.closed", { tabId: tab.id });
      return tab;
    }

    function captureScreenshot(p: Record<string, unknown>) {
      try {
        return requireWorkspaceEditor().captureScreenshot({
          target: p.target === "browser" || p.target === "file_viewer" ? p.target : null,
          tabId: typeof p.tabId === "string" ? p.tabId : null,
          path: typeof p.path === "string" ? p.path : null,
          maxWidth: typeof p.maxWidth === "number" ? p.maxWidth : undefined,
          maxHeight: typeof p.maxHeight === "number" ? p.maxHeight : undefined,
        }).then((result) => {
          if (result.target === "browser") setScreenCapturePermissionIssue(null);
          return result;
        }).catch((err) => {
          if (isScreenRecordingPermissionError(err)) showScreenCapturePermissionRequired(err);
          throw err;
        });
      } catch (err) {
        if (isScreenRecordingPermissionError(err)) showScreenCapturePermissionRequired(err);
        throw err;
      }
    }

    registerHandlers({
      // ── sessions ──
      "sessions.list": (p) => {
        const pid = p?.projectId as string | undefined;
        const all = sessionsRef.current;
        return pid ? all.filter((s) => s.projectId === pid) : all;
      },
      "sessions.get": (p) => {
        const s = sessionsRef.current.find((s) => s.id === p.id);
        if (!s) throw new Error("session not found");
        return s;
      },
      "sessions.create": async (p) => {
        const projectId = p.projectId as string;
        const proj = projectsRef.current.find((pr) => pr.id === projectId);
        if (!proj) throw new Error("project not found");
        const envVars = envVarsForProjectId(projectId, projectsRef.current, environmentsRef.current);
        const createdRaw = await createSession({
          projectId,
          name: (p.name as string) || undefined,
          launchCommand: (p.command as string) || undefined,
          cwd: (p.cwd as string) || proj.basePath || undefined,
          envVars,
          persistent: p.persistent as boolean | undefined,
          persistId: p.persistId as string | undefined,
        });
        const s = applyPendingExit(createdRaw);
        addSessionWithProjectSafeActivation(s);
        notifyStateChange("sessions.created", { sessionId: s.id, projectId: s.projectId });
        return s;
      },
      "sessions.close": async (p) => {
        const id = p.id as string;
        await closeSession(id);
        notifyStateChange("sessions.closed", { sessionId: id });
        return null;
      },
      "sessions.rename": (p) => {
        const id = p.id as string;
        const name = p.name as string;
        setSessionsSync((prev) => prev.map((s) => s.id === id ? { ...s, name } : s));
        invoke("rename_session", { id, name }).catch(() => {});
        flushPendingSave();
        const s = sessionsRef.current.find((s) => s.id === id);
        notifyStateChange("sessions.renamed", { sessionId: id, name });
        return s ? { ...s, name } : null;
      },
      "sessions.set_symbol": (p) => {
        const id = p.id as string;
        const symbol = normalizeTabSymbolValue(p.symbol as string | null);
        setSessionsSync((prev) => prev.map((s) => {
          if (s.id !== id || (s.symbol ?? null) === symbol) return s;
          urgentPersistenceRef.current = true;
          return { ...s, symbol };
        }));
        notifyStateChange("sessions.updated", { sessionId: id, symbol });
        return null;
      },
      "sessions.set_color": (p) => {
        const id = p.id as string;
        const color = (p.color as string) || null;
        setSessionsSync((prev) => prev.map((s) => {
          if (s.id !== id || (s.color ?? null) === color) return s;
          urgentPersistenceRef.current = true;
          return { ...s, color };
        }));
        notifyStateChange("sessions.updated", { sessionId: id, color });
        return null;
      },
      "sessions.activate": (p) => {
        const id = p.id as string;
        const s = sessionsRef.current.find((s) => s.id === id);
        if (!s) throw new Error("session not found");
        if (activeProjectIdRef.current !== s.projectId) {
          setActiveProjectId(s.projectId);
        }
        setActiveId(id);
        setActiveSplitViewId(null);
        notifyStateChange("sessions.activated", { sessionId: id });
        return { activeSessionId: id };
      },
      "sessions.reconnect": (p) => {
        const id = p.sessionId as string;
        const reason = (p.reason as string) || "API reconnect request";
        const immediate = p.immediate as boolean | undefined;
        const manual = p.manual as boolean | undefined;
        reconnectSshSessionRef.current(id, reason, { immediate, manual });
        notifyStateChange("sessions.reconnecting", { sessionId: id, reason });
        return { sessionId: id };
      },
      "sessions.start_recording": async (p) => {
        const result = await doStartRecording(p.sessionId as string, p.name as string);
        notifyStateChange("recordings.started", result);
        return result;
      },
      "sessions.stop_recording": async (p) => {
        const result = await doStopRecording(p.sessionId as string);
        notifyStateChange("recordings.stopped", result);
        return result;
      },
      "sessions.split": (p) => {
        const sv: SplitView = {
          id: makeId(),
          projectId: p.projectId as string,
          aId: p.aId as string,
          bId: p.bId as string,
          direction: p.direction as "horizontal" | "vertical",
          ratio: (p.ratio as number) ?? 0.5,
          createdAt: Date.now(),
          lastFocusedId: p.aId as string,
        };
        setSplitViews((prev) => [...prev, sv]);
        setActiveSplitViewId(sv.id);
        notifyStateChange("split_views.created", { splitViewId: sv.id, projectId: sv.projectId });
        return sv;
      },
      "sessions.unsplit": (p) => {
        const id = p.id as string;
        setSplitViews((prev) => prev.filter((sv) => sv.id !== id));
        if (activeSplitViewIdRef.current === id) setActiveSplitViewId(null);
        notifyStateChange("split_views.closed", { splitViewId: id });
        return null;
      },
      // ── persistent_sessions ──
      "persistent_sessions.attach": async (p) => {
        const projectId = p.projectId as string;
        const proj = projectsRef.current.find((pr) => pr.id === projectId);
        if (!proj) throw new Error("project not found");
        const envVars = envVarsForProjectId(projectId, projectsRef.current, environmentsRef.current);
        const createdRaw = await createSession({
          projectId,
          name: (p.name as string) || undefined,
          cwd: proj.basePath || undefined,
          envVars,
          persistent: true,
          persistId: p.persistId as string,
        });
        const s = applyPendingExit(createdRaw);
        addSessionWithProjectSafeActivation(s);
        notifyStateChange("sessions.created", { sessionId: s.id, projectId: s.projectId });
        return s;
      },
      // ── projects ──
      "projects.list": () => projectsRef.current,
      "projects.get": (p) => {
        const proj = projectsRef.current.find((pr) => pr.id === p.id);
        if (!proj) throw new Error("project not found");
        return proj;
      },
      "projects.create": async (p) => {
        const title = (p.title as string).trim();
        if (!title) throw new Error("title is required");
        const desiredBasePath = (p.basePath as string | undefined) || "";
        const validatedBasePath = desiredBasePath
          ? await invoke<string | null>("validate_directory", { path: desiredBasePath }).catch(() => null)
          : null;
        const sshTarget = ((p.sshTarget as string | undefined) ?? "").trim() || null;
        const sshRemotePath = ((p.sshRemotePath as string | undefined) ?? "").trim() || null;
        const id = makeId();
        const project: Project = {
          id,
          title,
          basePath: validatedBasePath,
          environmentId: (p.environmentId as string) || null,
          assetsEnabled: p.assetsEnabled !== false,
          sshTarget,
          sshRemotePath,
        };
        setProjects((prev) => [...prev, project]);
        notifyStateChange("projects.created", { projectId: id });
        return project;
      },
      "projects.update": (p) => {
        const id = p.id as string;
        setProjects((prev) => prev.map((proj) => {
          if (proj.id !== id) return proj;
          if (p.symbol !== undefined || p.color !== undefined) {
            urgentPersistenceRef.current = true;
          }
          return {
            ...proj,
            ...(p.title !== undefined && { title: (p.title as string).trim() }),
            ...(p.basePath !== undefined && { basePath: p.basePath as string | null }),
            ...(p.environmentId !== undefined && { environmentId: p.environmentId as string | null }),
            ...(p.assetsEnabled !== undefined && { assetsEnabled: p.assetsEnabled as boolean }),
            ...(p.symbol !== undefined && { symbol: normalizeTabSymbolValue(p.symbol as string | null) }),
            ...(p.color !== undefined && { color: p.color as string | null }),
            ...(p.sshTarget !== undefined && { sshTarget: (p.sshTarget as string | null)?.trim() || null }),
            ...(p.sshRemotePath !== undefined && { sshRemotePath: (p.sshRemotePath as string | null)?.trim() || null }),
          };
        }));
        notifyStateChange("projects.updated", { projectId: id });
        return projectsRef.current.find((pr) => pr.id === id) ?? null;
      },
      "projects.delete": async (p) => {
        const id = p.id as string;
        const idsToClose = sessionsRef.current.filter((s) => s.projectId === id).map((s) => s.id);
        for (const sid of idsToClose) {
          await closeSession(sid).catch(() => {});
        }
        setSessionsSync((prev) => prev.filter((s) => s.projectId !== id));
        setProjects((prev) => {
          const next = prev.filter((pr) => pr.id !== id);
          if (next.length === 0) {
            const fallback = makeId();
            next.push({ id: fallback, title: "Default", basePath: null, environmentId: null, assetsEnabled: true });
            setActiveProjectId(fallback);
          } else if (activeProjectIdRef.current === id) {
            setActiveProjectId(next[0].id);
          }
          return next;
        });
        notifyStateChange("projects.deleted", { projectId: id });
        return null;
      },
      "projects.activate": (p) => {
        const id = p.id as string;
        if (!projectsRef.current.some((pr) => pr.id === id)) throw new Error("project not found");
        setActiveProjectId(id);
        const lastSession = sessionsRef.current.find((s) => s.projectId === id);
        if (lastSession) setActiveId(lastSession.id);
        notifyStateChange("projects.activated", { projectId: id });
        return { activeProjectId: id };
      },
      "projects.reorder": (p) => {
        const ids = p.ids as string[];
        setProjects((prev) => {
          const byId = new Map(prev.map((pr) => [pr.id, pr]));
          const reordered = ids.map((id) => byId.get(id)).filter(Boolean) as Project[];
          for (const pr of prev) {
            if (!ids.includes(pr.id)) reordered.push(pr);
          }
          return reordered;
        });
        notifyStateChange("projects.reordered", { projectIds: ids });
        return null;
      },
      "projects.apply_assets": async (p) => {
        const projectId = p.projectId as string;
        const proj = projectsRef.current.find((pr) => pr.id === projectId);
        if (!proj) throw new Error("project not found");
        const dir = proj.basePath;
        if (!dir) throw new Error("project has no basePath");
        const overwrite = (p.overwrite as boolean) ?? false;
        let allAssets: AssetTemplate[] = [];
        setAssets((prev) => { allAssets = prev; return prev; });
        const assetIds = p.assetIds as string[] | undefined;
        const templates = assetIds
          ? allAssets.filter((a) => assetIds.includes(a.id))
          : allAssets;
        if (templates.length === 0) throw new Error("no assets to apply");
        const applied = await applyTextAssetsRaw(dir, templates, overwrite);
        notifyStateChange("assets.applied", { projectId, applied });
        return { applied };
      },
      // ── prompts ──
      "prompts.list": () => {
        let result: Prompt[] = [];
        setPrompts((prev) => { result = prev; return prev; });
        return result;
      },
      "prompts.get": (p) => {
        let result: Prompt | null = null;
        setPrompts((prev) => {
          result = prev.find((pr) => pr.id === p.id) ?? null;
          return prev;
        });
        if (!result) throw new Error("prompt not found");
        return result;
      },
      "prompts.create": (p) => {
        const id = makeId();
        const prompt: Prompt = {
          id,
          title: (p.title as string).trim(),
          content: p.content as string,
          createdAt: Date.now(),
        };
        setPrompts((prev) => [...prev, prompt]);
        notifyStateChange("prompts.created", { promptId: id });
        return prompt;
      },
      "prompts.update": (p) => {
        const id = p.id as string;
        let updated: Prompt | null = null;
        setPrompts((prev) => prev.map((pr) => {
          if (pr.id !== id) return pr;
          updated = {
            ...pr,
            ...(p.title !== undefined && { title: (p.title as string).trim() }),
            ...(p.content !== undefined && { content: p.content as string }),
            ...(p.pinned !== undefined && { pinned: p.pinned as boolean }),
          };
          return updated!;
        }));
        notifyStateChange("prompts.updated", { promptId: id });
        return updated;
      },
      "prompts.delete": (p) => {
        const id = p.id as string;
        setPrompts((prev) => prev.filter((pr) => pr.id !== id));
        notifyStateChange("prompts.deleted", { promptId: id });
        return null;
      },
      "prompts.search": (p) => {
        const q = ((p?.q as string) || "").toLowerCase();
        let result: Prompt[] = [];
        setPrompts((prev) => { result = prev; return prev; });
        return result.filter((pr) => pr.title.toLowerCase().includes(q) || pr.content.toLowerCase().includes(q));
      },
      "prompts.send": async (p) => {
        const sessionId = p.sessionId as string;
        const mode = (p.mode as "paste" | "send") || "send";
        const s = sessionsRef.current.find((s) => s.id === sessionId);
        if (!s) throw new Error("session not found");
        if (s.exited || s.closing || s.connectionState === "reconnecting" || s.connectionState === "disconnected") {
          throw new Error("session is not currently interactive");
        }
        let prompt: Prompt;
        if (p.promptId) {
          let found: Prompt | null = null;
          setPrompts((prev) => { found = prev.find((pr) => pr.id === p.promptId) ?? null; return prev; });
          if (!found) throw new Error("prompt not found");
          prompt = found;
        } else if (p.content) {
          prompt = { id: makeId(), title: "api", content: p.content as string, createdAt: Date.now() };
        } else {
          throw new Error("promptId or content is required");
        }
        if (mode === "paste") {
          await invoke("write_to_session", { id: sessionId, data: prompt.content, source: "user" });
        } else {
          const text = prompt.content.replace(/[\r\n]+$/, "");
          if (text) {
            await invoke("write_to_session", { id: sessionId, data: text, source: "user" });
            await sleep(30);
          }
          await invoke("write_to_session", { id: sessionId, data: "\r", source: "user" });
          if (text) onCommandChange(sessionId, text, "input");
        }
        notifyStateChange("prompts.sent", { sessionId, promptId: prompt.id, mode });
        return { sessionId, promptId: prompt.id, mode };
      },
      // ── environments ──
      "environments.list": () => environmentsRef.current,
      "environments.get": (p) => {
        const env = environmentsRef.current.find((e) => e.id === p.id);
        if (!env) throw new Error("environment not found");
        return env;
      },
      "environments.create": (p) => {
        const id = makeId();
        const env: EnvironmentConfig = {
          id,
          name: (p.name as string).trim(),
          content: p.content as string,
          createdAt: Date.now(),
        };
        setEnvironments((prev) => [...prev, env]);
        notifyStateChange("environments.created", { environmentId: id });
        return env;
      },
      "environments.update": (p) => {
        const id = p.id as string;
        let updated: EnvironmentConfig | null = null;
        setEnvironments((prev) => prev.map((e) => {
          if (e.id !== id) return e;
          updated = {
            ...e,
            ...(p.name !== undefined && { name: (p.name as string).trim() }),
            ...(p.content !== undefined && { content: p.content as string }),
          };
          return updated!;
        }));
        notifyStateChange("environments.updated", { environmentId: id });
        return updated;
      },
      "environments.delete": (p) => {
        const id = p.id as string;
        setEnvironments((prev) => prev.filter((e) => e.id !== id));
        notifyStateChange("environments.deleted", { environmentId: id });
        return null;
      },
      // ── assets ──
      "assets.list": () => {
        let result: AssetTemplate[] = [];
        let settings: AssetSettings = { autoApplyEnabled: true };
        setAssets((prev) => { result = prev; return prev; });
        setAssetSettings((prev) => { settings = prev; return prev; });
        return { settings, assets: result };
      },
      "assets.get": (p) => {
        let result: AssetTemplate | null = null;
        setAssets((prev) => { result = prev.find((a) => a.id === p.id) ?? null; return prev; });
        if (!result) throw new Error("asset not found");
        return result;
      },
      "assets.create": (p) => {
        const id = makeId();
        const asset: AssetTemplate = {
          id,
          name: (p.name as string).trim(),
          relativePath: p.relativePath as string,
          content: p.content as string,
          createdAt: Date.now(),
          autoApply: (p.autoApply as boolean) || false,
        };
        setAssets((prev) => [...prev, asset]);
        notifyStateChange("assets.created", { assetId: id });
        return asset;
      },
      "assets.update": (p) => {
        const id = p.id as string;
        let updated: AssetTemplate | null = null;
        setAssets((prev) => prev.map((a) => {
          if (a.id !== id) return a;
          updated = {
            ...a,
            ...(p.name !== undefined && { name: (p.name as string).trim() }),
            ...(p.relativePath !== undefined && { relativePath: p.relativePath as string }),
            ...(p.content !== undefined && { content: p.content as string }),
            ...(p.autoApply !== undefined && { autoApply: p.autoApply as boolean }),
          };
          return updated!;
        }));
        notifyStateChange("assets.updated", { assetId: id });
        return updated;
      },
      "assets.delete": (p) => {
        const id = p.id as string;
        setAssets((prev) => prev.filter((a) => a.id !== id));
        notifyStateChange("assets.deleted", { assetId: id });
        return null;
      },
      "assets.update_settings": (p) => {
        const settings: AssetSettings = { autoApplyEnabled: p.autoApplyEnabled as boolean };
        setAssetSettings(settings);
        notifyStateChange("assets.settings_updated", { settings });
        return settings;
      },
      "assets.apply": async (p) => {
        const assetId = p.assetId as string;
        const dir = p.dir as string;
        const overwrite = (p.overwrite as boolean) ?? false;
        let asset: AssetTemplate | null = null;
        setAssets((prev) => { asset = prev.find((a) => a.id === assetId) ?? null; return prev; });
        if (!asset) throw new Error("asset not found");
        const applied = await applyTextAssetsRaw(dir, [asset], overwrite);
        notifyStateChange("assets.applied", { assetId, dir, applied });
        return { applied };
      },
      // ── split_views ──
      "split_views.list": (p) => {
        const pid = p?.projectId as string | undefined;
        const all = splitViewsRef.current;
        return pid ? all.filter((sv) => sv.projectId === pid) : all;
      },
      "split_views.create": (p) => {
        const sv: SplitView = {
          id: makeId(),
          projectId: p.projectId as string,
          aId: p.aId as string,
          bId: p.bId as string,
          direction: p.direction as "horizontal" | "vertical",
          ratio: (p.ratio as number) ?? 0.5,
          createdAt: Date.now(),
          lastFocusedId: p.aId as string,
        };
        setSplitViews((prev) => [...prev, sv]);
        setActiveSplitViewId(sv.id);
        notifyStateChange("split_views.created", { splitViewId: sv.id, projectId: sv.projectId });
        return sv;
      },
      "split_views.update": (p) => {
        const id = p.id as string;
        let updated: SplitView | null = null;
        setSplitViews((prev) => prev.map((sv) => {
          if (sv.id !== id) return sv;
          updated = {
            ...sv,
            ...(p.ratio !== undefined && { ratio: p.ratio as number }),
            ...(p.lastFocusedId !== undefined && { lastFocusedId: p.lastFocusedId as string }),
          };
          return updated!;
        }));
        notifyStateChange("split_views.updated", { splitViewId: id });
        return updated;
      },
      "split_views.close": (p) => {
        const id = p.id as string;
        setSplitViews((prev) => prev.filter((sv) => sv.id !== id));
        if (activeSplitViewIdRef.current === id) setActiveSplitViewId(null);
        notifyStateChange("split_views.closed", { splitViewId: id });
        return null;
      },
      // ── file viewer / embedded browser tabs ──
      "file_viewer.tabs.list": listFileViewerTabs,
      "file_viewer.tabs.open": openFileViewerTab,
      "file_viewer.tabs.focus": focusFileViewerTab,
      "file_viewer.tabs.close": closeFileViewerTab,
      // Compatibility aliases for clients created before the clearer naming.
      "workspace.tabs.list": listFileViewerTabs,
      "workspace.tabs.open": openFileViewerTab,
      "workspace.tabs.focus": focusFileViewerTab,
      "workspace.tabs.close": closeFileViewerTab,
      "browser.navigate": async (p) => {
        const url = normalizeBrowserApiUrl(typeof p.url === "string" ? p.url : "");
        const tabId = typeof p.tabId === "string" ? p.tabId : null;
        const handle = codeEditorPanelRef.current;
        if (!handle) {
          if (tabId) throw new Error("file viewer/editor is not open");
          const queued = queueWorkspaceTabRequest({
            nonce: Date.now(),
            kind: "browser",
            url,
            title: typeof p.title === "string" ? p.title : null,
          });
          notifyStateChange("browser.navigate_queued", queued);
          return queued;
        }
        const tab = await handle.browserNavigate({
          tabId,
          url,
          activate: p.activate !== false,
        });
        notifyStateChange("browser.navigated", { tabId: tab.id, url: tab.url });
        return tab;
      },
      "browser.action": async (p) => {
        const action = p.action === "back" || p.action === "forward" || p.action === "reload" ? p.action : null;
        if (!action) throw new Error("unknown browser action");
        const tab = await requireWorkspaceEditor().browserAction({
          tabId: typeof p.tabId === "string" ? p.tabId : null,
          action,
        });
        notifyStateChange("browser.action", { tabId: tab.id, action });
        return tab;
      },
      "browser.snapshot": (p) => {
        const handle = codeEditorPanelRef.current;
        if (!handle) {
          if (typeof p.tabId === "string" && p.tabId.trim()) throw new Error("file viewer/editor is not open");
          return { activeTabId: null, activeBrowserTabId: null, tabs: [] };
        }
        return handle.browserSnapshot({ tabId: typeof p.tabId === "string" ? p.tabId : null });
      },
      "file_viewer.snapshot": (p) => {
        const input: { tabId?: string | null; path?: string | null; maxContentLength?: number } = {
          tabId: typeof p.tabId === "string" ? p.tabId : null,
          path: typeof p.path === "string" ? p.path : null,
        };
        if (typeof p.maxContentLength === "number") input.maxContentLength = p.maxContentLength;
        return requireWorkspaceEditor().fileViewerSnapshot(input);
      },
      "capture.screenshot": captureScreenshot,
      // ── ui ──
      "ui.state": () => ({
        activeProjectId: activeProjectIdRef.current,
        activeSessionId: activeIdRef.current,
        activeSplitViewId: activeSplitViewIdRef.current,
        theme: uiThemeRef.current,
        workspace: codeEditorPanelRef.current?.workspaceSnapshot() ?? fallbackWorkspaceSnapshot(),
      }),
      "ui.get_theme": () => ({ theme: uiThemeRef.current }),
      "ui.set_theme": (p) => {
        const theme = parseUiTheme(p.theme as string | null);
        setUiTheme(theme);
        notifyStateChange("ui.theme_changed", { theme });
        return { theme };
      },
      "ui.activate_session": (p) => {
        const id = p.sessionId as string;
        const s = sessionsRef.current.find((s) => s.id === id);
        if (!s) throw new Error("session not found");
        if (activeProjectIdRef.current !== s.projectId) setActiveProjectId(s.projectId);
        setActiveId(id);
        setActiveSplitViewId(null);
        notifyStateChange("sessions.activated", { sessionId: id });
        return { activeSessionId: id };
      },
      "ui.navigate_session": (p) => {
        const dir = p.direction as "next" | "prev";
        const projectSessions = sessionsRef.current.filter((s) => s.projectId === activeProjectIdRef.current);
        if (projectSessions.length === 0) return { activeSessionId: null };
        const curIdx = projectSessions.findIndex((s) => s.id === activeIdRef.current);
        const nextIdx = dir === "next"
          ? (curIdx + 1) % projectSessions.length
          : (curIdx - 1 + projectSessions.length) % projectSessions.length;
        const nextId = projectSessions[nextIdx].id;
        setActiveId(nextId);
        notifyStateChange("sessions.activated", { sessionId: nextId });
        return { activeSessionId: nextId };
      },
      "ui.toggle_panel": (p) => {
        const panel = p.panel as "prompts" | "recordings" | "assets";
        let wasOpen = false;
        let wasTab = "prompts";
        setSlidePanelOpen((prev) => { wasOpen = prev; return prev; });
        setSlidePanelTab((prev) => { wasTab = prev; return prev; });
        const explicitOpen = p.open as boolean | undefined;
        const shouldOpen = explicitOpen !== undefined ? explicitOpen : !(wasOpen && wasTab === panel);
        if (shouldOpen) {
          setSlidePanelTab(panel);
          setSlidePanelOpen(true);
        } else {
          setSlidePanelOpen(false);
        }
        notifyStateChange("ui.panel_toggled", { panel, open: shouldOpen });
        return { panel, open: shouldOpen };
      },
      "ui.command_palette": (p) => {
        const explicitOpen = p.open as boolean | undefined;
        let wasOpen = false;
        setCommandPaletteOpen((prev) => { wasOpen = prev; return prev; });
        const shouldOpen = explicitOpen !== undefined ? explicitOpen : !wasOpen;
        setCommandPaletteOpen(shouldOpen);
        notifyStateChange("ui.command_palette_toggled", { open: shouldOpen });
        return { open: shouldOpen };
      },
      // ── shell integration ──
      "shell.command_history": (p) => {
        const sessionId = p.sessionId as string;
        const limit = (p.limit as number) || 20;
        const entry = registry.current.get(sessionId);
        if (!entry?.shellInt) return [];
        const blocks = entry.shellInt.completedBlocks;
        const sliced = blocks.slice(-limit);
        return sliced.map((b) => entry.shellInt!.serializeBlock(entry.term, b));
      },
      "shell.last_result": (p) => {
        const sessionId = p.sessionId as string;
        const entry = registry.current.get(sessionId);
        if (!entry?.shellInt) return null;
        const blocks = entry.shellInt.completedBlocks;
        if (blocks.length === 0) return null;
        return entry.shellInt.serializeBlock(entry.term, blocks[blocks.length - 1]);
      },
      "shell.read_screen": (p) => {
        const sessionId = p.sessionId as string;
        const entry = registry.current.get(sessionId);
        if (!entry) throw new Error("session not found in terminal registry");
        const term = entry.term;
        const buf = term.buffer.active;
        const lines: string[] = [];
        for (let i = 0; i < term.rows; i++) {
          const line = buf.getLine(buf.viewportY + i);
          lines.push(line ? line.translateToString(true) : "");
        }
        return {
          content: lines.join("\n"),
          rows: term.rows,
          cols: term.cols,
          cursorX: buf.cursorX,
          cursorY: buf.cursorY,
        };
      },
      "shell.read_scrollback": (p) => {
        const sessionId = p.sessionId as string;
        const requestedLines = (p.lines as number) || 100;
        const offset = (p.offset as number) || 0;
        const entry = registry.current.get(sessionId);
        if (!entry) throw new Error("session not found in terminal registry");
        const buf = entry.term.buffer.active;
        const totalLines = buf.length;
        const endLine = Math.max(0, totalLines - offset);
        const startLine = Math.max(0, endLine - requestedLines);
        const lines: string[] = [];
        for (let i = startLine; i < endLine; i++) {
          const line = buf.getLine(i);
          lines.push(line ? line.translateToString(true) : "");
        }
        return {
          content: lines.join("\n"),
          startLine,
          endLine,
          totalLines,
        };
      },
      "shell.get_status": (p) => {
        const sessionId = p.sessionId as string;
        const session = sessionsRef.current.find((s) => s.id === sessionId);
        if (!session) throw new Error("session not found");
        const entry = registry.current.get(sessionId);
        const shellInt = entry?.shellInt;
        let shellState: "idle" | "running" | "unknown" = "unknown";
        let shellIntegration = false;
        if (shellInt?.activated) {
          shellIntegration = true;
          // If there's a pending block with a commandMarker (B fired) but no endMarker (D),
          // a command is running. We check commandMarker rather than outputMarker because
          // commands like `sleep` may block without producing output (no C marker).
          const pending = shellInt.pendingBlock;
          if (pending && pending.commandMarker && !pending.endMarker) {
            shellState = "running";
          } else {
            shellState = "idle";
          }
        }
        return {
          sessionId,
          shell: session.command ?? null,
          cwd: session.cwd ?? null,
          shellIntegration,
          shellState,
          exited: session.exited ?? false,
          exitCode: session.exitCode ?? null,
        };
      },
      // ── app ──
      "app.state": async () => {
        const state = await invoke("load_persisted_state");
        return state;
      },
      // ── recordings (bridge-routed start/stop) ──
      "recordings.start": async (p) => {
        const result = await doStartRecording(p.sessionId as string, p.name as string);
        notifyStateChange("recordings.started", result);
        return result;
      },
      "recordings.stop": async (p) => {
        const result = await doStopRecording(p.sessionId as string);
        notifyStateChange("recordings.stopped", result);
        return result;
      },
      // ── ssh (bridge-routed) ──
      "ssh.history": () => {
        let result: SshHistoryEntry[] = [];
        setSshHistory((prev) => { result = prev; return prev; });
        return result;
      },
      "ssh.connect": async (p) => {
        const projectId = p.projectId as string;
        const target = (p.target as string).trim();
        if (!target) throw new Error("target is required");
        const proj = projectsRef.current.find((pr) => pr.id === projectId);
        if (!proj) throw new Error("project not found");
        const remoteDir = ((p.remoteDir as string) || "").trim();
        const envVars = envVarsForProjectId(projectId, projectsRef.current, environmentsRef.current);
        const launchCommand = buildSshCommandAtRemoteDir({
          baseCommandLine: null,
          target,
          remoteDir,
        });
        const cwd = (p.cwd as string) || proj.basePath || undefined;
        const name = (p.name as string) || `ssh ${target}${remoteDir ? `: ${remoteDir}` : ""}`;
        const createdRaw = await createSession({
          projectId,
          name,
          launchCommand,
          cwd: cwd ?? null,
          envVars,
          sshTarget: target,
          persistent: p.persistent as boolean | undefined,
        });
        const s = applyPendingExit(createdRaw);
        addSessionWithProjectSafeActivation(s);
        pushSshHistory({ host: target, command: launchCommand, persistent: Boolean(p.persistent), connectedAt: Date.now() });
        notifyStateChange("sessions.created", { sessionId: s.id, projectId, sshTarget: target });
        return s;
      },
      "ssh.delete_history": (p) => {
        const index = p.index as number;
        setSshHistory((prev) => prev.filter((_, i) => i !== index));
        notifyStateChange("ssh.history_deleted", { index });
        return null;
      },
    });
    initBridge();
    return () => { destroyBridge(); };
  }, [hydrated]);

  useEffect(() => {
    projectsRef.current = projects;
    projectByIdRef.current = new Map(projects.map((p) => [p.id, p]));
  }, [projects]);

  useEffect(() => {
    environmentsRef.current = environments;
  }, [environments]);

  useEffect(() => {
    activeProjectIdRef.current = activeProjectId;
  }, [activeProjectId]);

  // Clean up sessions with invalid projectId or duplicate persistId+projectId.
  // This handles corrupted persisted state, orphaned sessions, and ghost duplicates.
  useEffect(() => {
    if (!hydrated) return;
    const validProjectIds = new Set(projects.map((p) => p.id));
    setSessionsSync((prev) => {
      // Step 1: Remove sessions with invalid projectId.
      let next = prev.filter((s) => validProjectIds.has(s.projectId));

      // Step 2: Deduplicate by persistId + projectId (keep earliest by createdAt).
      const seen = new Map<string, string>(); // key → session.id (winner)
      const dupeIds = new Set<string>();
      for (const s of next) {
        const key = `${s.projectId}:${s.persistId}`;
        const existing = seen.get(key);
        if (existing) {
          dupeIds.add(s.id); // later duplicate — remove
        } else {
          seen.set(key, s.id);
        }
      }
      if (dupeIds.size > 0) {
        if (import.meta.env.DEV) {
          console.warn(
            `[session cleanup] Removing ${dupeIds.size} duplicate session(s)`,
            next.filter((s) => dupeIds.has(s.id)).map((s) => ({ id: s.id, name: s.name, persistId: s.persistId, projectId: s.projectId })),
          );
        }
        next = next.filter((s) => !dupeIds.has(s.id));
      }

      if (next.length === prev.length) return prev;
      if (import.meta.env.DEV) {
        const orphaned = prev.filter((s) => !validProjectIds.has(s.projectId));
        if (orphaned.length > 0) {
          console.warn(
            `[session cleanup] Removed ${orphaned.length} orphaned session(s):`,
            orphaned.map((s) => ({ id: s.id, name: s.name, projectId: s.projectId })),
          );
        }
      }
      return next;
    });
  }, [hydrated, projects]);

  useEffect(() => {
    secureStorageModeRef.current = secureStorageMode;
  }, [secureStorageMode]);

  useLayoutEffect(() => {
    const s = keyHandlerStateRef.current;
    s.newOpen = newOpen;
    s.sshManagerOpen = sshManagerOpen;
    s.agentShortcutsOpen = agentShortcutsOpen;
    s.projectOpen = projectOpen;
    s.pathPickerOpen = pathPickerOpen;
    s.confirmDeleteProjectOpen = confirmDeleteProjectOpen;
    s.confirmDeleteRecordingId = confirmDeleteRecordingId;
    s.confirmDeletePromptId = confirmDeletePromptId;
    s.confirmDeleteEnvironmentId = confirmDeleteEnvironmentId;
    s.confirmDeleteAssetId = confirmDeleteAssetId;
    s.applyAssetRequest = applyAssetRequest;
    s.applyAssetApplying = applyAssetApplying;
    s.replayOpen = replayOpen;
    s.recordPromptOpen = recordPromptOpen;
    s.recordingsOpen = recordingsOpen;
    s.secureStorageSettingsOpen = secureStorageSettingsOpen;
    s.promptsOpen = promptsOpen;
    s.promptEditorOpen = promptEditorOpen;
    s.environmentsOpen = environmentsOpen;
    s.environmentEditorOpen = environmentEditorOpen;
    s.assetEditorOpen = assetEditorOpen;
    s.commandPaletteOpen = commandPaletteOpen;
    s.slidePanelOpen = slidePanelOpen;
    s.slidePanelTab = slidePanelTab;
    s.prompts = prompts;
  });

  useEffect(() => {
    if (!activeId) return;
    const s = sessionByIdRef.current.get(activeId);
    if (!s) return;
    lastActiveByProject.current.set(s.projectId, s.id);
    setActiveSessionByProject((prev) => {
      if (prev[s.projectId] === s.persistId) return prev;
      return { ...prev, [s.projectId]: s.persistId };
    });
  }, [activeId, sessions]);

  useEffect(() => {
    const valid = new Set(projects.map((p) => p.id));
    setActiveSessionByProject((prev) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [projectId, persistId] of Object.entries(prev)) {
        if (valid.has(projectId)) next[projectId] = persistId;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [projects]);

  const persistedSessionsRef = useRef<PersistedSession[]>([]);
  const persistedSessions = useMemo<PersistedSession[]>(() => {
    const next = sessions
      .filter((session) => !session.closing)
      .map(toPersistedSession)
      .sort((a, b) => a.createdAt - b.createdAt);
    const prev = persistedSessionsRef.current;
    if (persistedSessionsEqual(prev, next)) return prev;
    persistedSessionsRef.current = next;
    return next;
  }, [sessions]);

  const commandSuggestions = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (raw: string | null | undefined) => {
      const trimmed = (raw ?? "").trim();
      if (!trimmed) return;
      if (seen.has(trimmed)) return;
      seen.add(trimmed);
      out.push(trimmed);
    };

    [...persistedSessions]
      .sort((a, b) => b.createdAt - a.createdAt)
      .forEach((s) => {
        add(s.launchCommand ?? null);
        add((s.restoreCommand ?? null) as string | null);
      });

    for (const preset of quickStarts) add(preset.command ?? null);
    for (const effect of PROCESS_EFFECTS) for (const cmd of effect.matchCommands) add(cmd);

    return out.slice(0, 50);
  }, [persistedSessions, quickStarts]);

  const terminalPaneSessionsRef = useRef<TerminalPaneSession[]>([]);
  const terminalPaneSessions = useMemo<TerminalPaneSession[]>(() => {
    const next = sessions
      .map((s) => ({
        id: s.id,
        projectId: s.projectId,
        persistent: s.persistent,
        name: s.name,
        cwd: s.cwd,
        color: s.color ?? null,
        exited: Boolean(s.exited),
        closing: Boolean(s.closing),
        connectionState: s.connectionState ?? "connected",
      }));
    const prev = terminalPaneSessionsRef.current;
    if (
      prev.length === next.length &&
      prev.every(
        (p, i) =>
          p.id === next[i].id &&
          p.projectId === next[i].projectId &&
          p.persistent === next[i].persistent &&
          p.name === next[i].name &&
          p.cwd === next[i].cwd &&
          p.color === next[i].color &&
          p.exited === next[i].exited &&
          p.closing === next[i].closing &&
          p.connectionState === next[i].connectionState,
      )
    ) {
      return prev;
    }
    terminalPaneSessionsRef.current = next;
    return next;
  }, [sessions]);

  useEffect(() => {
    if (!hydrated || persistenceDisabledReason) return;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }

    pendingSaveRef.current = {
      schemaVersion: 1,
      secureStorageMode: secureStorageMode ?? undefined,
      projects,
      activeProjectId,
      sessions: persistedSessions,
      activeSessionByProject,
      prompts,
      environments,
      assets,
      assetSettings,
      agentShortcutIds,
    };

    const saveDelayMs = urgentPersistenceRef.current ? 0 : 400;
    urgentPersistenceRef.current = false;
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      const state = pendingSaveRef.current;
      if (!state) return;
      void invoke("save_persisted_state", { state }).catch((err) => {
        const msg = formatError(err);
        const lower = msg.toLowerCase();
        if (
          secureStorageMode === "keychain" &&
          (lower.includes("keychain") || lower.includes("keyring"))
        ) {
          setPersistenceDisabledReason(`Secure storage is locked (changes won’t be saved): ${msg}`);
          return;
        }
        reportError("Failed to save state", err);
      });
    }, saveDelayMs);
  }, [projects, activeProjectId, activeSessionByProject, persistedSessions, prompts, environments, assets, assetSettings, agentShortcutIds, secureStorageMode, hydrated, persistenceDisabledReason]);

  useEffect(() => {
    if (!hydrated) return;
    if (workspaceViewSaveTimerRef.current !== null) {
      window.clearTimeout(workspaceViewSaveTimerRef.current);
    }

    const validProjectIds = new Set(projects.map((p) => p.id));
    pendingWorkspaceViewSaveRef.current = buildWorkspaceViewStorageV1(workspaceViewByKey, validProjectIds);

    workspaceViewSaveTimerRef.current = window.setTimeout(() => {
      workspaceViewSaveTimerRef.current = null;
      const state = pendingWorkspaceViewSaveRef.current;
      if (!state) return;
      try {
        localStorage.setItem(STORAGE_WORKSPACE_VIEW_BY_KEY, JSON.stringify(state));
      } catch {
        // Best-effort.
      }
    }, 500);
  }, [hydrated, projects, workspaceViewByKey]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(
        STORAGE_PROJECTS_KEY,
        JSON.stringify(projects.map((p) => ({ id: p.id, title: p.title, symbol: p.symbol ?? null, color: p.color ?? null, sshTarget: p.sshTarget ?? null, sshRemotePath: p.sshRemotePath ?? null }))),
      );
      localStorage.setItem(STORAGE_ACTIVE_PROJECT_KEY, activeProjectId);
    } catch {
      // Best-effort: localStorage may be unavailable in some contexts.
    }
  }, [activeProjectId, hydrated, projects]);

  useEffect(() => {
    if (!hydrated) return;
    if (!active) return;

    const key: RecentSessionKey = { projectId: active.projectId, persistId: active.persistId };
    setRecentSessionKeys((prev) => {
      const head = prev[0] ?? null;
      if (head && head.projectId === key.projectId && head.persistId === key.persistId) return prev;
      const next = [
        key,
        ...prev.filter((s) => !(s.projectId === key.projectId && s.persistId === key.persistId)),
      ].slice(0, 50);
      try {
        localStorage.setItem(STORAGE_RECENT_SESSIONS_KEY, JSON.stringify(next));
      } catch {
        // Best-effort.
      }
      return next;
    });
  }, [active?.persistId, active?.projectId, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    const validProjects = new Set(projects.map((p) => p.id));
    setRecentSessionKeys((prev) => {
      const next = prev.filter((s) => validProjects.has(s.projectId));
      if (next.length === prev.length) return prev;
      try {
        localStorage.setItem(STORAGE_RECENT_SESSIONS_KEY, JSON.stringify(next));
      } catch {
        // Best-effort.
      }
      return next;
    });
  }, [hydrated, projects]);

  const trayStatus = useMemo(() => {
    let runningCount = 0;
    let sessionsOpen = 0;
    let recordingCount = 0;

    for (const session of sessions) {
      if (session.exited || session.closing) continue;
      sessionsOpen += 1;
      const activity = getSessionActivityState(session, agentWorkingIds);
      if (activity.isActive) {
        runningCount += 1;
      }
      if (activity.isRecording) {
        recordingCount += 1;
      }
    }

    return {
      runningCount,
      sessionsOpen,
      recordingCount,
      activeProject: activeProject?.title ?? null,
      activeSession: active?.name ?? null,
    };
  }, [active?.name, activeProject?.title, sessions, agentWorkingIds]);

  const lastTrayStatusRef = useRef<string | null>(null);
  const trayStatusTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!hydrated) return;
    const key = JSON.stringify(trayStatus);
    if (lastTrayStatusRef.current === key) return;
    lastTrayStatusRef.current = key;
    if (trayStatusTimerRef.current !== null) {
      window.clearTimeout(trayStatusTimerRef.current);
    }
    trayStatusTimerRef.current = window.setTimeout(() => {
      trayStatusTimerRef.current = null;
      void invoke("set_tray_status", {
        workingCount: trayStatus.runningCount,
        sessionsOpen: trayStatus.sessionsOpen,
        activeProject: trayStatus.activeProject,
        activeSession: trayStatus.activeSession,
        recordingCount: trayStatus.recordingCount,
      }).catch(() => {});
    }, 250);
  }, [trayStatus, hydrated]);

  const trayRecentSessions = useMemo<TrayRecentSession[]>(() => {
    const open = sessions.filter(
      (s) =>
        !s.exited &&
        !s.closing &&
        s.connectionState !== "reconnecting" &&
        s.connectionState !== "disconnected",
    );
    const byKey = new Map<string, Session>();
    for (const s of open) byKey.set(`${s.projectId}:${s.persistId}`, s);

    const projectTitleById = new Map(
      projects.map((p) => [p.id, p.title?.trim?.() ? p.title.trim() : p.title]),
    );

    const out: TrayRecentSession[] = [];
    const seen = new Set<string>();

    const add = (s: Session) => {
      const key = `${s.projectId}:${s.persistId}`;
      if (seen.has(key)) return;
      seen.add(key);
      const projectTitle = projectTitleById.get(s.projectId) ?? "—";
      const rec = s.recordingActive ? " (REC)" : "";
      const label = `${s.name}${rec} — ${projectTitle}`;
      out.push({ label, projectId: s.projectId, persistId: s.persistId });
    };

    if (
      active &&
      !active.exited &&
      !active.closing &&
      active.connectionState !== "reconnecting" &&
      active.connectionState !== "disconnected"
    ) {
      add(active);
    }

    for (const key of recentSessionKeys) {
      const s = byKey.get(`${key.projectId}:${key.persistId}`);
      if (s) add(s);
      if (out.length >= 10) break;
    }

    return out.slice(0, 10);
  }, [projects, recentSessionKeys, sessions, activeId]);

  const lastTrayRecentsRef = useRef<string | null>(null);
  useEffect(() => {
    if (!hydrated) return;
    const key = JSON.stringify(trayRecentSessions);
    if (lastTrayRecentsRef.current === key) return;
    lastTrayRecentsRef.current = key;
    void invoke("set_tray_recent_sessions", { sessions: trayRecentSessions }).catch(() => {});
  }, [trayRecentSessions, hydrated]);

  useEffect(() => {
    if (!pendingTrayAction) return;
    if (!hydrated) return;

    const action = pendingTrayAction;
    setPendingTrayAction(null);

    if (action.id === "recent-session") {
      const projectId = action.projectId ?? null;
      const persistId = action.persistId ?? null;
      if (!projectId || !persistId) return;
      const target =
        sessionsRef.current.find(
          (s) =>
            s.projectId === projectId &&
            s.persistId === persistId &&
            !s.exited &&
            !s.closing,
        ) ?? null;
      if (!target) return;

      activeProjectIdRef.current = projectId;
      activeIdRef.current = target.id;
      setActiveProjectId(projectId);
      setActiveId(target.id);
      return;
    }

    if (action.id === "new-terminal") {
      handleOpenNewSession();
      return;
    }

    if (action.id === "start-agent") {
      const effect = getProcessEffectById(action.effectId ?? null);
      if (!effect) return;
      void quickStart({
        id: effect.id,
        title: effect.label,
        command: effect.matchCommands[0] ?? effect.label,
      });
    }
  }, [hydrated, pendingTrayAction, quickStart]);

  useEffect(() => {
    if (!sshManagerOpen) return;
    void refreshSshHosts();
  }, [sshManagerOpen]);

  useEffect(() => {
    if (!hydrated) return;
    void refreshRecordings();
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    if (secureStoragePromptedRef.current) return;
    if (secureStorageMode !== null) return;
    secureStoragePromptedRef.current = true;
    setSecureStorageSettingsError(null);
    setSecureStorageSettingsMode("keychain");
    setSecureStorageSettingsOpen(true);
  }, [hydrated, secureStorageMode]);

  useEffect(() => {
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    const onKeyDown = (e: KeyboardEvent) => {
      const ks = keyHandlerStateRef.current;
      const {
        newOpen, sshManagerOpen, agentShortcutsOpen, projectOpen,
        pathPickerOpen, confirmDeleteProjectOpen, confirmDeleteRecordingId,
        confirmDeletePromptId, confirmDeleteEnvironmentId, confirmDeleteAssetId,
        applyAssetRequest, replayOpen, recordPromptOpen, recordingsOpen,
        secureStorageSettingsOpen, promptsOpen, promptEditorOpen,
        environmentsOpen, environmentEditorOpen, assetEditorOpen,
        commandPaletteOpen, slidePanelOpen, slidePanelTab, prompts,
        applyAssetApplying,
      } = ks;
      const modalOpen =
        anyDialogOpen() ||
        newOpen ||
        sshManagerOpen ||
        agentShortcutsOpen ||
        projectOpen ||
        pathPickerOpen ||
        confirmDeleteProjectOpen ||
        Boolean(confirmDeleteRecordingId) ||
        Boolean(confirmDeletePromptId) ||
        Boolean(confirmDeleteEnvironmentId) ||
        Boolean(confirmDeleteAssetId) ||
        Boolean(applyAssetRequest) ||
        replayOpen ||
        recordPromptOpen ||
        recordingsOpen ||
        secureStorageSettingsOpen ||
        promptsOpen ||
        promptEditorOpen ||
        environmentsOpen ||
        environmentEditorOpen ||
        assetEditorOpen;

      const resolveVisibleTerminalSearchTargets = (): string[] => {
        const activeProjectId = activeProjectIdRef.current;
        const allSessions = sessionsRef.current;
        const activeId = activeIdRef.current;
        const activeSession = activeId ? allSessions.find((s) => s.id === activeId) ?? null : null;
        const inProject = allSessions.filter((s) => s.projectId === activeProjectId);
        const primaryId =
          (activeSession && activeSession.projectId === activeProjectId ? activeSession.id : null) ??
          inProject.find((s) => !s.closing)?.id ??
          inProject[0]?.id ??
          null;
        const split = splitPaneRef.current;
        const secondaryId = split?.secondaryId ?? null;
        const ids: string[] = [];
        if (primaryId) ids.push(primaryId);
        if (secondaryId && secondaryId !== primaryId) {
          const secondarySession = allSessions.find((s) => s.id === secondaryId) ?? null;
          if (secondarySession && secondarySession.projectId === activeProjectId) {
            ids.push(secondaryId);
          }
        }
        return ids;
      };

      const closeTerminalSearchForIds = (sessionIds: string[]) => {
        if (sessionIds.length === 0) return;
        setTerminalSearchSessions((prev) => {
          const next = new Set(prev);
          let changed = false;
          for (const id of sessionIds) {
            if (next.delete(id)) changed = true;
          }
          return changed ? next : prev;
        });
        for (const id of sessionIds) {
          try { registry.current.get(id)?.search.clearDecorations(); } catch { /* ignore */ }
        }
        registry.current.get(sessionIds[0])?.term.focus();
      };

      const toggleTerminalSearchForIds = (sessionIds: string[]) => {
        if (sessionIds.length === 0) return;
        const allOpen = sessionIds.every((id) => terminalSearchSessionsRef.current.has(id));
        if (allOpen) {
          closeTerminalSearchForIds(sessionIds);
          return;
        }
        setTerminalSearchSessions((prev) => {
          const next = new Set(prev);
          for (const id of sessionIds) {
            next.add(id);
          }
          return next;
        });
      };

      // Match the declarative keymap once; dispatch on the binding id below.
      const binding = matchBinding(e, isMac);

      // Command palette takes priority - mod+K
      if (binding === "palette.open" && !commandPaletteOpen) {
        e.preventDefault();
        e.stopPropagation();
        (document.activeElement as HTMLElement | null)?.blur?.();
        setCommandPaletteOpen(true);
        return;
      }

      if (binding === "files.search" && !workspaceFileSearchOpen && activeWorkspaceFileRoot) {
        e.preventDefault();
        e.stopPropagation();
        (document.activeElement as HTMLElement | null)?.blur?.();
        setWorkspaceFileSearchOpen(true);
        return;
      }

      // Shortcut cheat sheet - mod+/ (toggles; also closeable via Escape cascade)
      if (binding === "shortcuts.show" && !commandPaletteOpen) {
        e.preventDefault();
        e.stopPropagation();
        toggleDialog("shortcuts");
        return;
      }

        // Close command palette with Escape
        if (e.key === "Escape" && commandPaletteOpen) {
          e.preventDefault();
          e.stopPropagation();
          setCommandPaletteOpen(false);
          return;
        }

      if (binding === "terminal.search") {
        const activeEl = document.activeElement;
        const inCodeEditor = isMac && activeEl instanceof Element && Boolean(activeEl.closest(".codeEditorPanel"));
        if (inCodeEditor) {
          const now = Date.now();
          if (now - terminalSearchTriggerAtRef.current < 180) return;
          const ran = codeEditorPanelRef.current?.openFind() ?? false;
          if (ran) {
            terminalSearchTriggerAtRef.current = now;
            e.preventDefault();
            e.stopPropagation();
          }
          return;
        }

        const resolvedTargets = resolveVisibleTerminalSearchTargets();
        const targets = resolvedTargets.length > 0 ? resolvedTargets : Array.from(registry.current.keys()).slice(0, 2);
        if (targets.length === 0) {
          showNotice("No terminal available for search.", 2000);
          return;
        }
        const now = Date.now();
        if (now - terminalSearchTriggerAtRef.current < 180) return;
        terminalSearchTriggerAtRef.current = now;
        e.preventDefault();
        e.stopPropagation();
        toggleTerminalSearchForIds(targets);
        return;
      }

      if (e.key === "Escape" && !commandPaletteOpen && !modalOpen) {
        const targets = resolveVisibleTerminalSearchTargets();
        const hasOpenSearch = targets.some((id) => terminalSearchSessionsRef.current.has(id));
        if (hasOpenSearch) {
          e.preventDefault();
          e.stopPropagation();
          closeTerminalSearchForIds(targets);
          return;
        }
      }

        // Close slide panel with Escape
        if (e.key === "Escape" && slidePanelOpen && !modalOpen) {
          e.preventDefault();
          setSlidePanelOpen(false);
          return;
        }

      if (e.key === "Escape" && modalOpen) {
        e.preventDefault();
        if (closeTopDialog()) return;
        if (applyAssetRequest) {
          if (applyAssetApplying) return;
          closeApplyAssetModal();
          return;
        }
        if (confirmDeleteAssetId) {
          setConfirmDeleteAssetId(null);
          return;
        }
        if (confirmDeleteEnvironmentId) {
          setConfirmDeleteEnvironmentId(null);
          return;
        }
        if (confirmDeletePromptId) {
          setConfirmDeletePromptId(null);
          return;
        }
        if (confirmDeleteRecordingId) {
          setConfirmDeleteRecordingId(null);
          return;
        }
        if (agentShortcutsOpen) {
          setAgentShortcutsOpen(false);
          return;
        }
        if (secureStorageSettingsOpen) {
          closeSecureStorageSettings();
          return;
        }
          if (environmentEditorOpen) {
            setEnvironmentEditorOpen(false);
            return;
          }
          if (environmentsOpen) {
            setEnvironmentsOpen(false);
            return;
          }
          if (assetEditorOpen) {
            closeAssetEditor();
            return;
          }
          if (promptEditorOpen) {
            setPromptEditorOpen(false);
            return;
          }
          if (promptsOpen) {
            setPromptsOpen(false);
            return;
          }
          if (recordingsOpen) {
            setRecordingsOpen(false);
            return;
          }
          if (recordPromptOpen) {
            closeRecordPrompt();
            return;
          }
          if (replayOpen) {
            closeReplayModal();
            return;
          }
          if (pathPickerOpen) {
            setPathPickerOpen(false);
            setPathPickerTarget(null);
            return;
          }
          if (confirmDeleteProjectOpen) {
            setConfirmDeleteProjectOpen(false);
            return;
          }
          if (projectOpen) {
            setProjectOpen(false);
            return;
          }
          if (sshManagerOpen) {
            setSshManagerOpen(false);
            return;
          }
          if (newOpen) {
            setNewOpen(false);
            return;
          }
          return;
	      }

        if (commandPaletteOpen || modalOpen) return;
        if (!binding) return;

      const activeProjectId = activeProjectIdRef.current;
      const sessions = sessionsRef.current.filter((s) => s.projectId === activeProjectId);
      const activeId = activeIdRef.current;

      const toggleSlidePanel = (tab: "prompts" | "recordings" | "assets" | "timeline") => {
        setSlidePanelOpen((prev) => {
          if (!prev) {
            setSlidePanelTab(tab);
            return true;
          }
          if (slidePanelTab === tab) return false;
          setSlidePanelTab(tab);
          return true;
        });
      };

      const cycleSession = (delta: number) => {
        if (!sessions.length) return;
        const idx = sessions.findIndex((s) => s.id === activeId);
        const next = sessions[(idx + delta + sessions.length) % sessions.length];
        setActiveId(next.id);
      };

      switch (binding) {
        case "session.new":
          e.preventDefault();
          handleOpenNewSessionFlow();
          return;
        case "session.close":
          if (!activeId) return;
          e.preventDefault();
          void onClose(activeId);
          return;
        case "session.next":
          e.preventDefault();
          cycleSession(1);
          return;
        case "session.prev":
          e.preventDefault();
          cycleSession(-1);
          return;
        case "panel.prompts":
          e.preventDefault();
          toggleSlidePanel("prompts");
          return;
        case "panel.recordings":
          e.preventDefault();
          void refreshRecordings();
          toggleSlidePanel("recordings");
          return;
        case "panel.assets":
          e.preventDefault();
          toggleSlidePanel("assets");
          return;
        case "panel.timeline":
          e.preventDefault();
          toggleSlidePanel("timeline");
          return;
        case "panel.agent":
          e.preventDefault();
          setAgentPanelOpen((prev) => !prev);
          return;
        case "prompt.1":
        case "prompt.2":
        case "prompt.3":
        case "prompt.4":
        case "prompt.5": {
          const idx = Number(binding.slice("prompt.".length)) - 1;
          const pinnedPrompts = prompts
            .filter((p) => p.pinned)
            .sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0));
          if (pinnedPrompts[idx] && activeId) {
            e.preventDefault();
            void sendPromptToActive(pinnedPrompts[idx], "send");
          }
          return;
        }
        default:
          return;
      }
    };

		    window.addEventListener("keydown", onKeyDown, true);
		    return () => window.removeEventListener("keydown", onKeyDown, true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);

  useEffect(() => {
    return () => {
      if (trayStatusTimerRef.current !== null) {
        window.clearTimeout(trayStatusTimerRef.current);
        trayStatusTimerRef.current = null;
      }
    };
  }, []);

  function formatError(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }

  function isScreenRecordingPermissionError(err: unknown): boolean {
    const message = formatError(err);
    return (
      message.includes("SCREEN_RECORDING_PERMISSION_REQUIRED") ||
      /screen recording permission/i.test(message)
    );
  }

  function showScreenCapturePermissionRequired(err: unknown) {
    const message = formatError(err).replace(/^SCREEN_RECORDING_PERMISSION_REQUIRED:\s*/, "");
    setScreenCapturePermissionIssue(message);
    setActivityCenterAutoOpenSource(null);
    setActivityCenterOpen(true);
  }

  const KNOWN_XTERM_RESIZE_RACE_SIGNATURES = [
    "this._renderer.value.handleresize",
    "undefined is not an object (evaluating 'this._renderer.value.handleresize')",
  ];

  function isKnownXtermRendererResizeRace(err: unknown): boolean {
    const message = formatError(err).toLowerCase();
    return KNOWN_XTERM_RESIZE_RACE_SIGNATURES.some((signature) => message.includes(signature));
  }
  const reportError = useCallback((prefix: string, err: unknown) => {
    const message = `${prefix}: ${formatError(err)}`;
    // Persistent copy in the ActivityCenter; transient toast so it's noticed.
    setError(message);
    showToast({ tone: "error", message });
  }, []);

  const openScreenRecordingSettings = useCallback(async () => {
    try {
      await invoke("open_screen_recording_settings");
    } catch (err) {
      reportError("Failed to open Screen Recording settings", err);
    }
  }, [reportError]);

  const reportErrorRef = useRef(reportError);
  const suppressedKnownXtermResizeRaceRef = useRef(false);
  useEffect(() => {
    reportErrorRef.current = reportError;
  }, [reportError]);

  useEffect(() => {
    const logKnownXtermRaceSuppression = () => {
      if (suppressedKnownXtermResizeRaceRef.current) return;
      suppressedKnownXtermResizeRaceRef.current = true;
      console.warn("[agents-ui] Suppressed known xterm renderer resize race");
    };

    const handleError = (event: ErrorEvent) => {
      const cause = event.error ?? event.message;
      if (isKnownXtermRendererResizeRace(cause)) {
        event.preventDefault();
        logKnownXtermRaceSuppression();
        return;
      }
      reportErrorRef.current("Unexpected error", cause);
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      if (isKnownXtermRendererResizeRace(event.reason)) {
        event.preventDefault();
        logKnownXtermRaceSuppression();
        return;
      }
      reportErrorRef.current("Unhandled promise rejection", event.reason);
    };
    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);
    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, []);

  // Transient tier of the two-tier notification model: notices are toasts
  // (bottom-right, auto-dismiss); persistent state lives in the ActivityCenter.
  const showNotice = useCallback((message: string, timeoutMs = 4500) => {
    showToast({ message, duration: timeoutMs });
  }, []);

  // The backend emits this when a session's requested shell couldn't be launched
  // and it fell back to the default — surface it as a non-fatal toast.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void listen<{ sessionId: string; message: string }>("shell-fallback", (e) => {
      showToast({ tone: "warning", title: "Shell fallback", message: e.payload.message });
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [showNotice]);

  const runBackgroundAgentPrompt = useCallback(
    async (
      prompt: string,
      settings: AgentLaunchSettings,
      options?: {
        onOutputLine?: (line: string) => void;
      },
    ) => {
      let runId: string | null = null;
      const stderrLines: string[] = [];
      let resolveDone: (() => void) | null = null;
      let rejectDone: ((error: Error) => void) | null = null;
      let unlistenOutput: (() => void) | null = null;
      let unlistenDone: (() => void) | null = null;
      let unlistenStderr: (() => void) | null = null;

      const completion = new Promise<void>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = (error: Error) => reject(error);
      });

      const cleanup = () => {
        if (unlistenOutput) {
          unlistenOutput();
          unlistenOutput = null;
        }
        if (unlistenDone) {
          unlistenDone();
          unlistenDone = null;
        }
        if (unlistenStderr) {
          unlistenStderr();
          unlistenStderr = null;
        }
      };

      try {
        const handleOutput = options?.onOutputLine;
        unlistenOutput = await listen<AgentOutputPayload>("agent-output", (event) => {
          if (event.payload.runId !== runId) return;
          handleOutput?.(event.payload.data);
        });

        unlistenStderr = await listen<AgentStderrPayload>("agent-stderr", (event) => {
          if (event.payload.runId !== runId) return;
          stderrLines.push(event.payload.data);
        });

        unlistenDone = await listen<AgentDonePayload>("agent-done", (event) => {
          if (event.payload.runId !== runId) return;
          cleanup();
          if (event.payload.exitCode === 0) {
            resolveDone?.();
            return;
          }
          const stderr = stderrLines.join("\n").trim();
          const exitCode =
            event.payload.exitCode == null ? "unknown" : String(event.payload.exitCode);
          rejectDone?.(new Error(stderr || `Agent exited with code ${exitCode}`));
        });

        runId = await invoke<string>("start_agent_prompt", {
          prompt,
          settings,
        });

        await completion;
      } catch (err) {
        cleanup();
        throw err;
      }
    },
    [],
  );

  function openSecureStorageSettings() {
    setSecureStorageSettingsError(null);
    setSecureStorageSettingsMode(secureStorageMode ?? "keychain");
    setSecureStorageSettingsOpen(true);
  }

  function closeSecureStorageSettings() {
    if (secureStorageSettingsBusy) return;
    setSecureStorageSettingsOpen(false);
    setSecureStorageSettingsError(null);
  }

  async function applySecureStorageSettings() {
    if (secureStorageSettingsBusy) return;
    setSecureStorageSettingsError(null);

    const nextMode = secureStorageSettingsMode;
    if (nextMode === secureStorageMode) {
      setSecureStorageSettingsOpen(false);
      return;
    }

    const persistedSessions: PersistedSession[] = sessionsRef.current
      .filter((s) => !s.closing)
      .map(toPersistedSession)
      .sort((a, b) => a.createdAt - b.createdAt);

    const state: PersistedStateV1 = {
      schemaVersion: 1,
      secureStorageMode: nextMode,
      projects,
      activeProjectId,
      sessions: persistedSessions,
      activeSessionByProject,
      prompts,
      environments,
      assets,
      assetSettings,
      agentShortcutIds,
    };

    if (nextMode === "plaintext") {
      setSecureStorageMode("plaintext");
      setPersistenceDisabledReason(null);
      try {
        await invoke("save_persisted_state", { state });
      } catch (err) {
        reportError("Failed to save state", err);
      }
      setSecureStorageSettingsOpen(false);
      showNotice(
        "Secure storage disabled: environments + recordings will be stored unencrypted on disk.",
        12000,
      );
      return;
    }

    setSecureStorageSettingsBusy(true);
    showNotice(
      "macOS Keychain access is needed to enable encryption. You may see 1–2 prompts; choose “Always Allow” to avoid future prompts.",
      20000,
    );
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    try {
      await invoke("reset_secure_storage");
      await invoke("prepare_secure_storage");

      await invoke("save_persisted_state", { state });
      setSecureStorageMode("keychain");
      setPersistenceDisabledReason(null);

      const refreshed = await invoke<PersistedStateV1 | null>("load_persisted_state").catch(() => null);
      if (refreshed?.schemaVersion === 1) {
        setEnvironments(refreshed.environments ?? []);
      }

      setSecureStorageSettingsOpen(false);
      showNotice(
        "Secure storage enabled: environments + recording inputs are encrypted at rest (key stored in macOS Keychain).",
        10000,
      );
    } catch (err) {
      setSecureStorageSettingsError(formatError(err));
    } finally {
      setSecureStorageSettingsBusy(false);
    }
  }

  const retrySecureStorage = useCallback(async () => {
    if (secureStorageRetryingRef.current) return;
    secureStorageRetryingRef.current = true;
    setSecureStorageRetrying(true);
    showNotice(
      "macOS Keychain access is needed to decrypt/encrypt your environments + recordings. Choose \u201CAlways Allow\u201D to avoid future prompts.",
      20000,
    );
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    try {
      await invoke("reset_secure_storage");
      await invoke("prepare_secure_storage");
      setPersistenceDisabledReason(null);

      const refreshed = await invoke<PersistedStateV1 | null>("load_persisted_state").catch(() => null);
      if (refreshed?.schemaVersion === 1) {
        setEnvironments(refreshed.environments ?? []);
      }

      showNotice("Secure storage unlocked.", 7000);
    } catch (err) {
      setPersistenceDisabledReason(`Secure storage is locked (changes won't be saved): ${formatError(err)}`);
    } finally {
      secureStorageRetryingRef.current = false;
      setSecureStorageRetrying(false);
    }
  }, [showNotice]);

  const handleCopySshCommand = useCallback(async (text: string) => {
    const ok = await copyToClipboard(text);
    showNotice(ok ? "Copied SSH command" : "Could not copy SSH command");
  }, []);

  const openExternal = useCallback(
    async (url: string) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
          throw new Error("refusing to open untrusted URL");
        }
        await invoke("plugin:shell|open", { path: parsed.toString() });
      } catch (err) {
        reportError("Failed to open link", err);
      }
    },
    [reportError],
  );

  function sanitizeRecordedInputForReplay(input: string): string {
    // Remove common ANSI/terminal control sequences; recordings should be replayable as plain input.
    let out = input;
    out = out.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    out = out.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "");
    out = out.replace(/\x1bP[\s\S]*?\x1b\\/g, "");
    out = out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
    return out;
  }

  function splitRecordingIntoSteps(events: RecordingEvent[]): string[] {
    const steps: string[] = [];
    let buffer = "";
    for (const ev of events) {
      buffer += sanitizeRecordedInputForReplay(ev.data);
      while (true) {
        const r = buffer.indexOf("\r");
        const n = buffer.indexOf("\n");
        const idx = r === -1 ? n : n === -1 ? r : Math.min(r, n);
        if (idx === -1) break;
        steps.push(buffer.slice(0, idx + 1));
        buffer = buffer.slice(idx + 1);
      }
    }
    if (buffer) steps.push(buffer);
    return steps;
  }

  function formatRecordingT(ms: number): string {
    const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
    if (safe < 1000) return `+${safe}ms`;
    const totalSeconds = Math.floor(safe / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) return `+${minutes}m${seconds.toString().padStart(2, "0")}s`;
    const tenths = Math.floor((safe % 1000) / 100);
    return `+${seconds}.${tenths}s`;
  }

  const replayFlow = useMemo(() => {
    const rec = replayRecording;
    if (!rec) return [];
    const events = rec.events ?? [];
    if (!events.length) return [];

    const groups: Array<{
      key: string;
      t: number;
      startIndex: number;
      endIndex: number;
      preview: string;
      items: Array<{ index: number; text: string }>;
    }> = [];

    let groupIndex = -1;
    let currentT: number | null = null;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const clean = sanitizeRecordedInputForReplay(ev.data ?? "");
      const text = clean.replace(/[\r\n]+$/, "");

      if (currentT === null || ev.t !== currentT) {
        groupIndex += 1;
        currentT = ev.t;
        groups.push({
          key: `${ev.t}-${groupIndex}`,
          t: ev.t,
          startIndex: i,
          endIndex: i,
          preview: "",
          items: [{ index: i, text }],
        });
      } else {
        const group = groups[groups.length - 1];
        group.endIndex = i;
        group.items.push({ index: i, text });
      }
    }

    for (const group of groups) {
      const firstNonEmpty = group.items.find((it) => it.text.trim())?.text.trim();
      group.preview = firstNonEmpty ? firstNonEmpty : "⏎";
    }

    return groups;
  }, [replayRecording]);

  useEffect(() => {
    if (!replayShowAll) return;
    if (!replayFlow.length) return;
    if (replayIndex >= replaySteps.length) return;

    const nextGroup = replayFlow.find(
      (g) => replayIndex >= g.startIndex && replayIndex <= g.endIndex,
    );
    if (!nextGroup) return;
    setReplayFlowExpanded((prev) => {
      if (prev[nextGroup.key]) return prev;
      return { ...prev, [nextGroup.key]: true };
    });
  }, [replayFlow, replayIndex, replayShowAll, replaySteps.length]);

  useEffect(() => {
    if (!replayShowAll) return;
    const raf = window.requestAnimationFrame(() => {
      replayNextItemRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [replayShowAll, replayIndex, replayFlowExpanded]);

  const refreshRecordings = useCallback(async () => {
    setRecordingsLoading(true);
    setRecordingsError(null);
    try {
      const list = await invoke<RecordingIndexEntry[]>("list_recordings");
      setRecordings(list);
    } catch (err) {
      setRecordingsError(formatError(err));
    } finally {
      setRecordingsLoading(false);
    }
  }, []);

  async function refreshPersistentSessions() {
    setPersistentSessionsLoading(true);
    setPersistentSessionsError(null);
    try {
      const list = await invoke<PersistentSessionInfo[]>("list_persistent_sessions");
      setPersistentSessions(list);
    } catch (err) {
      setPersistentSessionsError(formatError(err));
    } finally {
      setPersistentSessionsLoading(false);
    }
  }

  async function refreshSshHosts() {
    setSshHostsLoading(true);
    setSshHostsError(null);
    try {
      const list = await invoke<SshHostEntry[]>("list_ssh_hosts");
      setSshHosts(list);
    } catch (err) {
      setSshHostsError(formatError(err));
    } finally {
      setSshHostsLoading(false);
    }
  }

  function defaultRecordingName(s: Session): string {
    const effect = getProcessEffectById(s.effectId);
    const base = effect?.label ?? s.name ?? "recording";
    const when = new Date().toISOString().slice(0, 16).replace("T", " ");
    return `${base} ${when}`;
  }

  const openRecordPrompt = useCallback((sessionId: string) => {
    const s = sessionsRef.current.find((s) => s.id === sessionId);
    if (!s) return;
    setRecordPromptSessionId(sessionId);
    setRecordPromptName(defaultRecordingName(s));
    setRecordPromptOpen(true);
    window.setTimeout(() => recordNameRef.current?.focus(), 0);
  }, []);

  function closeRecordPrompt() {
    setRecordPromptOpen(false);
    setRecordPromptSessionId(null);
    setRecordPromptName("");
  }

  async function startRecording(sessionId: string, name: string) {
    const s = sessionsRef.current.find((s) => s.id === sessionId);
    if (!s) return;
    if (s.recordingActive) return;

    try {
      const recordingId = makeId();
      const effect = getProcessEffectById(s.effectId);
      const bootstrapCommand =
        (s.launchCommand ?? null) ||
        (s.restoreCommand?.trim() ? s.restoreCommand.trim() : null) ||
        (effect?.matchCommands?.[0] ?? null);
      const safeId = await invoke<string>("start_session_recording", {
        id: s.id,
        recordingId,
        recordingName: name,
        encrypt: secureStorageMode === "keychain",
        projectId: s.projectId,
        sessionPersistId: s.persistId,
        cwd: s.cwd,
        effectId: s.effectId ?? null,
        bootstrapCommand,
      });
      setSessionsSync((prev) =>
        prev.map((x) =>
          x.id === sessionId
            ? { ...x, recordingActive: true, lastRecordingId: safeId }
            : x,
        ),
      );
      void refreshRecordings();
    } catch (err) {
      reportError("Failed to start recording", err);
    }
  }

  const stopRecording = useCallback(async (sessionId: string) => {
    const s = sessionsRef.current.find((s) => s.id === sessionId);
    if (!s) return;
    if (!s.recordingActive) return;

    try {
      await invoke("stop_session_recording", { id: s.id });
    } catch (err) {
      reportError("Failed to stop recording", err);
    } finally {
      setSessionsSync((prev) =>
        prev.map((x) => (x.id === sessionId ? { ...x, recordingActive: false } : x)),
      );
    }
  }, [reportError]);

  function closeReplayModal() {
    setReplayOpen(false);
    setReplayLoading(false);
    setReplayError(null);
    setReplayRecording(null);
    setReplaySteps([]);
    setReplayIndex(0);
    setReplayTargetSessionId(null);
    setReplayShowAll(false);
    setReplayFlowExpanded({});
  }

  const openReplay = useCallback(async (recordingId: string, mode: "step" | "all" = "step") => {
    setReplayOpen(true);
    setReplayLoading(true);
    setReplayError(null);
    setReplayRecording(null);
    setReplaySteps([]);
    setReplayIndex(0);
    setReplayTargetSessionId(null);
    setReplayShowAll(mode === "all");
    setReplayFlowExpanded({});

    try {
      const rec = await invoke<LoadedRecording>("load_recording", {
        recordingId,
        decrypt: secureStorageModeRef.current === "keychain",
      });
      setReplayRecording(rec);
      setReplaySteps(splitRecordingIntoSteps(rec.events));
    } catch (err) {
      setReplayError(formatError(err));
    } finally {
      setReplayLoading(false);
    }
  }, []);

  const openReplayForActive = useCallback(async () => {
    const activeSession = sessionByIdRef.current.get(activeIdRef.current ?? "");
    if (!activeSession?.lastRecordingId) return;
    await openReplay(activeSession.lastRecordingId);
  }, [openReplay]);

  const getTerminalText = useCallback((sessionId: string): string => {
    const entry = registry.current.get(sessionId);
    if (!entry) return "";
    const buf = entry.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join("\n");
  }, []);

  function requestDeleteRecording(recordingId: string) {
    setRecordingsOpen(false);
    setConfirmDeleteRecordingId(recordingId);
  }

  async function deleteRecording(recordingId: string) {
    const label =
      recordings.find((r) => r.recordingId === recordingId)?.meta?.name?.trim() || recordingId;
    try {
      await invoke("delete_recording", { recordingId });
      setRecordings((prev) => prev.filter((r) => r.recordingId !== recordingId));
      setSessionsSync((prev) =>
        prev.map((s) =>
          s.lastRecordingId === recordingId ? { ...s, lastRecordingId: null } : s,
        ),
      );
      if (replayRecording?.recordingId === recordingId) {
        closeReplayModal();
      }
      showNotice(`Deleted recording "${label}"`);
    } catch (err) {
      reportError("Failed to delete recording", err);
    }
  }

  const openPromptEditor = useCallback((prompt?: Prompt) => {
    setPromptsOpen(false);
    setPromptEditorId(prompt?.id ?? null);
    setPromptEditorTitle(prompt?.title ?? "");
    setPromptEditorContent(prompt?.content ?? "");
    setPromptEditorOpen(true);
    window.setTimeout(() => promptTitleRef.current?.focus(), 0);
  }, []);

  function closePromptEditor() {
    setPromptEditorOpen(false);
    setPromptEditorId(null);
    setPromptEditorTitle("");
    setPromptEditorContent("");
  }

  function savePromptFromEditor() {
    const title = promptEditorTitle.trim();
    if (!title) return;
    const content = promptEditorContent;
    const now = Date.now();
    const id = promptEditorId ?? makeId();
    const next: Prompt = { id, title, content, createdAt: now };

    setPrompts((prev) => {
      if (!promptEditorId) return [...prev, next].sort((a, b) => b.createdAt - a.createdAt);
      return prev
        .map((p) => (p.id === promptEditorId ? { ...p, title, content } : p))
        .sort((a, b) => b.createdAt - a.createdAt);
    });
    closePromptEditor();
  }

  function requestDeletePrompt(id: string) {
    setConfirmDeletePromptId(id);
  }

  function confirmDeletePrompt() {
    const id = confirmDeletePromptId;
    setConfirmDeletePromptId(null);
    if (!id) return;

    const prompt = prompts.find((p) => p.id === id);
    const label = prompt?.title?.trim() ? prompt.title.trim() : "prompt";

    if (promptEditorId === id) closePromptEditor();
    setPrompts((prev) => prev.filter((p) => p.id !== id));
    showNotice(`Deleted prompt "${label}"`);
  }

  function togglePromptPin(id: string) {
    setPrompts((prev) => {
      const prompt = prev.find(p => p.id === id);
      if (!prompt) return prev;

      if (prompt.pinned) {
        // Unpin: remove pinned status
        return prev.map(p => p.id === id ? { ...p, pinned: false, pinOrder: undefined } : p);
      } else {
        // Pin: add to end of pinned list
        const maxPinOrder = Math.max(0, ...prev.filter(p => p.pinned).map(p => p.pinOrder ?? 0));
        return prev.map(p => p.id === id ? { ...p, pinned: true, pinOrder: maxPinOrder + 1 } : p);
      }
    });
  }

  function formatTimeAgo(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return new Date(timestamp).toLocaleDateString();
  }

  async function sendPromptToSession(sessionId: string, prompt: Prompt, mode: "paste" | "send") {
    const session = sessionByIdRef.current.get(sessionId) ?? null;
    if (
      session &&
      (session.exited ||
        session.closing ||
        session.connectionState === "reconnecting" ||
        session.connectionState === "disconnected")
    ) {
      showNotice("Session is not currently interactive.");
      return;
    }

    if (mode === "paste") {
      try {
        registry.current.get(sessionId)?.term.focus();
        await invoke("write_to_session", { id: sessionId, data: prompt.content, source: "user" });
      } catch (err) {
        reportError("Failed to send prompt", err);
      }
      return;
    }

    const text = prompt.content.replace(/[\r\n]+$/, "");
    try {
      registry.current.get(sessionId)?.term.focus();
      if (text) {
        // Check if the terminal app has enabled bracketed paste mode.
        // If so, wrap text in paste markers so the app treats it as an
        // atomic paste rather than character-by-character raw input.
        const entry = registry.current.get(sessionId);
        const useBracketedPaste = entry?.term.modes.bracketedPasteMode ?? false;
        const payload = useBracketedPaste
          ? `\x1b[200~${text}\x1b[201~`
          : text;
        await invoke("write_to_session", { id: sessionId, data: payload, source: "user" });
      }
      if (text) await sleep(50);
      await invoke("write_to_session", { id: sessionId, data: "\r", source: "user" });
      if (text) onCommandChange(sessionId, text, "input");
    } catch (err) {
      reportError("Failed to send prompt", err);
    }
  }

  async function sendPromptToActive(prompt: Prompt, mode: "paste" | "send") {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    await sendPromptToSession(sessionId, prompt, mode);
  }

  async function sendPromptFromCommandPalette(prompt: Prompt, mode: "paste" | "send") {
    const projectId = activeProjectId;

    const activeSessionId = activeId;
    const activeSession = activeSessionId ? sessionByIdRef.current.get(activeSessionId) ?? null : null;

    const defaultAgentId = agentShortcutIds[0] ?? null;
    const effect =
      getProcessEffectById(activeSession?.effectId) ?? getProcessEffectById(defaultAgentId);

    if (!effect) {
      await sendPromptToActive(prompt, mode);
      return;
    }

    const cwd =
      activeSession?.cwd ?? activeProject?.basePath ?? homeDirRef.current ?? null;
    try {
      if (cwd) await ensureAutoAssets(cwd, projectId);
      const createdRaw = await createSession({
        projectId,
        name: prompt.title.trim() ? prompt.title.trim() : effect.label,
        launchCommand: effect.matchCommands[0] ?? effect.label,
        cwd,
        envVars: envVarsForProjectId(projectId, projects, environments),
        shellChoice: shellChoiceForProject(projects.find((p) => p.id === projectId)),
      });
      const s = applyPendingExit(createdRaw);
      addSessionWithProjectSafeActivation(s);
      await sleep(50);
      await sendPromptToSession(s.id, prompt, mode);
    } catch (err) {
      reportError("Failed to start new session for prompt", err);
    }
  }

  function openEnvironmentEditor(env?: EnvironmentConfig) {
    setEnvironmentsOpen(false);
    setEnvironmentEditorId(env?.id ?? null);
    setEnvironmentEditorName(env?.name ?? "");
    const locked = Boolean((env?.content ?? "").trimStart().startsWith("enc:v1:"));
    setEnvironmentEditorLocked(locked);
    setEnvironmentEditorContent(locked ? "" : env?.content ?? "");
    setEnvironmentEditorOpen(true);
    window.setTimeout(() => envNameRef.current?.focus(), 0);
  }

  function closeEnvironmentEditor() {
    setEnvironmentEditorOpen(false);
    setEnvironmentEditorId(null);
    setEnvironmentEditorName("");
    setEnvironmentEditorContent("");
    setEnvironmentEditorLocked(false);
  }

  function saveEnvironmentFromEditor() {
    if (environmentEditorLocked) return;
    const name = environmentEditorName.trim();
    if (!name) return;
    const content = environmentEditorContent;
    const now = Date.now();
    const id = environmentEditorId ?? makeId();
    const next: EnvironmentConfig = { id, name, content, createdAt: now };

    setEnvironments((prev) => {
      if (!environmentEditorId) return [...prev, next].sort((a, b) => b.createdAt - a.createdAt);
      return prev
        .map((e) => (e.id === environmentEditorId ? { ...e, name, content } : e))
        .sort((a, b) => b.createdAt - a.createdAt);
    });
    closeEnvironmentEditor();
  }

  function requestDeleteEnvironment(id: string) {
    setConfirmDeleteEnvironmentId(id);
  }

  function confirmDeleteEnvironment() {
    const id = confirmDeleteEnvironmentId;
    setConfirmDeleteEnvironmentId(null);
    if (!id) return;

    const env = environments.find((e) => e.id === id);
    const label = env?.name?.trim() ? env.name.trim() : "environment";

    if (environmentEditorId === id) closeEnvironmentEditor();
    setEnvironments((prev) => prev.filter((e) => e.id !== id));
    setProjects((prev) =>
      prev.map((p) => (p.environmentId === id ? { ...p, environmentId: null } : p)),
    );
    showNotice(`Deleted environment "${label}"`);
  }

  function openAssetEditor(asset?: AssetTemplate) {
    setAssetEditorId(asset?.id ?? null);
    setAssetEditorName(asset?.name ?? "");
    setAssetEditorPath(asset?.relativePath ?? "");
    setAssetEditorContent(asset?.content ?? "");
    setAssetEditorAutoApply(asset?.autoApply ?? true);
    setAssetEditorOpen(true);
    window.setTimeout(() => assetNameRef.current?.focus(), 0);
  }

  function closeAssetEditor() {
    setAssetEditorOpen(false);
    setAssetEditorId(null);
    setAssetEditorName("");
    setAssetEditorPath("");
    setAssetEditorContent("");
    setAssetEditorAutoApply(true);
  }

  function saveAssetFromEditor() {
    const name = assetEditorName.trim();
    const relativePath = assetEditorPath.trim();
    if (!name || !relativePath) return;
    const now = Date.now();
    const id = assetEditorId ?? makeId();
    const next: AssetTemplate = {
      id,
      name,
      relativePath,
      content: assetEditorContent,
      createdAt: assetEditorId ? (assets.find((a) => a.id === assetEditorId)?.createdAt ?? now) : now,
      autoApply: assetEditorAutoApply,
    };
    setAssets((prev) => {
      if (!assetEditorId) return [...prev, next].sort((a, b) => b.createdAt - a.createdAt);
      return prev
        .map((a) => (a.id === assetEditorId ? next : a))
        .sort((a, b) => b.createdAt - a.createdAt);
    });
    closeAssetEditor();
  }

  function requestDeleteAsset(id: string) {
    setConfirmDeleteAssetId(id);
  }

  function confirmDeleteAsset() {
    const id = confirmDeleteAssetId;
    setConfirmDeleteAssetId(null);
    if (!id) return;

    const asset = assets.find((a) => a.id === id);
    const label = asset?.name?.trim() ? asset.name.trim() : "template";

    if (assetEditorId === id) closeAssetEditor();
    if (applyAssetRequest?.assetId === id) {
      setApplyAssetRequest(null);
      setApplyAssetError(null);
      setApplyAssetApplying(false);
    }
    setAssets((prev) => prev.filter((a) => a.id !== id));
    showNotice(`Deleted template "${label}"`);
  }

  function toggleAssetAutoApply(id: string) {
    setAssets((prev) =>
      prev.map((a) => (a.id === id ? { ...a, autoApply: !(a.autoApply ?? true) } : a)),
    );
  }

  async function applyTextAssetsRaw(
    baseDir: string,
    templates: AssetTemplate[],
    overwrite: boolean,
  ): Promise<string[]> {
    const dir = baseDir.trim();
    if (!dir) return [];
    const payload = templates
      .map((t) => ({
        relativePath: t.relativePath,
        content: t.content,
      }))
      .filter((t) => t.relativePath.trim());
    if (payload.length === 0) return [];
    return invoke<string[]>("apply_text_assets", { baseDir: dir, assets: payload, overwrite });
  }

  async function applyTextAssets(
    baseDir: string,
    templates: AssetTemplate[],
    overwrite: boolean,
  ): Promise<string[]> {
    try {
      return await applyTextAssetsRaw(baseDir, templates, overwrite);
    } catch (err) {
      reportError("Failed to apply assets", err);
      return [];
    }
  }

  async function ensureAutoAssets(baseDir: string, projectId: string, assetsEnabledOverride?: boolean) {
    const enabledGlobal = assetSettings.autoApplyEnabled;
    if (!enabledGlobal) return;

    const enabledProject =
      assetsEnabledOverride ??
      (projectByIdRef.current.get(projectId)?.assetsEnabled ?? true);
    if (!enabledProject) return;

    const templates = assets.filter((a) => a.autoApply ?? true);
    if (templates.length === 0) return;

    await applyTextAssets(baseDir, templates, false);
  }

  function joinPathDisplay(baseDir: string, relativePath: string): string {
    const base = baseDir.replace(/[\\/]+$/, "");
    const rel = relativePath.replace(/^[\\/]+/, "");
    if (!base) return rel;
    if (!rel) return base;
    return `${base}/${rel}`;
  }

  function openApplyAssetModal(target: ApplyAssetTarget, dir: string, assetId: string) {
    setApplyAssetError(null);
    setApplyAssetApplying(false);
    setApplyAssetRequest({ target, dir, assetId });
  }

  function closeApplyAssetModal() {
    if (applyAssetApplying) return;
    setApplyAssetRequest(null);
    setApplyAssetError(null);
  }

  async function confirmApplyAsset(overwrite: boolean) {
    const req = applyAssetRequest;
    if (!req) return;
    const asset = assets.find((a) => a.id === req.assetId);
    if (!asset) {
      setApplyAssetRequest(null);
      return;
    }

	    setApplyAssetApplying(true);
	    setApplyAssetError(null);
	    try {
	      const written = await applyTextAssetsRaw(req.dir, [asset], overwrite);
	      setApplyAssetRequest(null);

	      const templateLabel = asset.name.trim() || "template";
	      const targetLabel = req.target === "project" ? "project" : "tab";
	      const targetPath = shortenPathSmart(joinPathDisplay(req.dir, asset.relativePath), 72);
	      if (written.length === 0) {
	        showNotice(`Skipped "${templateLabel}" (${targetLabel}): ${targetPath}`);
	        return;
	      }
	      const verb = overwrite ? "Applied (overwrite)" : "Applied";
	      showNotice(
	        `${verb} "${templateLabel}" (${targetLabel}): ${shortenPathSmart(written[0] ?? targetPath, 72)}`,
	      );
	    } catch (err) {
	      setApplyAssetError(formatError(err));
	      reportError("Failed to apply asset", err);
	    } finally {
	      setApplyAssetApplying(false);
    }
  }

  async function ensureReplayTargetSession(): Promise<string | null> {
    if (replayTargetSessionId) return replayTargetSessionId;

    const rec = replayRecording;
    const cwd = rec?.meta?.cwd ?? active?.cwd ?? activeProject?.basePath ?? homeDirRef.current ?? null;
    const projectId =
      (rec?.meta?.projectId && projects.some((p) => p.id === rec.meta?.projectId)
        ? rec.meta.projectId
        : null) ?? activeProjectId;
    const bootstrapCommand = (() => {
      const fromMeta = rec?.meta?.bootstrapCommand?.trim() ?? "";
      if (fromMeta) return fromMeta;
      const effect = getProcessEffectById(rec?.meta?.effectId ?? null);
      return effect?.matchCommands?.[0] ?? null;
    })();
    const name = rec?.meta?.name?.trim()
      ? `replay: ${rec.meta.name.trim()}`
      : bootstrapCommand
        ? `replay ${bootstrapCommand}`
        : "replay";

    try {
      const createdRaw = await createSession({
        projectId,
        name,
        launchCommand: bootstrapCommand,
        cwd,
        envVars: envVarsForProjectId(projectId, projects, environments),
      });
      const created = applyPendingExit(createdRaw);
      setSessionsSync((prev) => {
        if (prev.some((s) => s.id === created.id)) return prev;
        return [...prev, created];
      });
      setActiveProjectId(projectId);
      setActiveId(created.id);
      setReplayTargetSessionId(created.id);
      return created.id;
    } catch (err) {
      reportError("Failed to create replay session", err);
      return null;
    }
  }

  async function sendNextReplayStep() {
    if (!replaySteps.length) return;
    if (replayIndex >= replaySteps.length) return;

    const targetId = (await ensureReplayTargetSession()) ?? null;
    if (!targetId) return;

    const chunk = replaySteps[replayIndex];
    try {
      registry.current.get(targetId)?.term.focus();

      // Similar to prompt sending: avoid delivering the final newline in the
      // same burst as the pasted text. Some interactive CLIs treat this as a
      // paste/newline (insert line) rather than an Enter (submit).
      const newlineMatch = chunk.match(/[\r\n]+$/);
      const trailing = newlineMatch?.[0] ?? "";
      const body = trailing ? chunk.slice(0, -trailing.length) : chunk;

      if (body) {
        await invoke("write_to_session", { id: targetId, data: body, source: "system" });
      }

      if (trailing) {
        if (body) await sleep(30);
        const enterCount = trailing.replace(/[^\r\n]/g, "").length;
        for (let i = 0; i < enterCount; i++) {
          await invoke("write_to_session", { id: targetId, data: "\r", source: "system" });
          if (i < enterCount - 1) await sleep(10);
        }
      }

      setReplayIndex((i) => i + 1);
    } catch (err) {
      reportError("Failed to replay input", err);
    }
  }

  const loadDirectoryForPicker = useCallback(
    (path: string | null) => invoke<DirectoryListing>("list_directories", { path }),
    [],
  );

  const loadRemoteDirectoryForPicker = useCallback(
    async (path: string | null): Promise<DirectoryListing> => {
      const target = sshPathPickerTargetRef.current;
      if (!target) throw new Error("No SSH target");
      const resolvedPath = path ?? await invoke<string>("ssh_default_root", { target });
      type FsEntry = { name: string; path: string; isDir: boolean; size: number };
      const entries = await invoke<FsEntry[]>("ssh_list_fs_entries", {
        target,
        root: resolvedPath,
        path: resolvedPath,
      });
      const dirs = entries
        .filter((e) => e.isDir)
        .map((e) => ({ name: e.name, path: e.path }));
      const parent =
        resolvedPath === "/"
          ? null
          : resolvedPath.replace(/\/[^/]+\/?$/, "") || "/";
      return { path: resolvedPath, parent, entries: dirs };
    },
    [],
  );

  const updateSessionById = useCallback(
    (id: string, updater: (session: Session) => Session) => {
      setSessionsSync((prev) => {
        const index = prev.findIndex((s) => s.id === id);
        if (index < 0) return prev;
        const current = prev[index];
        const next = updater(current);
        if (next === current) return prev;
        const out = prev.slice();
        out[index] = next;
        return out;
      });
    },
    [],
  );

  function openPathPicker(target: "project" | "session" | "ssh-remote", initial: string | null) {
    setPathPickerTarget(target);
    pathPickerInitialPathRef.current = initial;
    setPathPickerOpen(true);
  }

  const onSessionResize = useCallback((id: string, _size: { cols: number; rows: number }) => {
    lastResizeAtRef.current.set(id, Date.now());
  }, []);

  const onSessionTransportError = useCallback(
    (id: string, operation: "write" | "resize", errorMessage: string) => {
      if (closingSessions.current.has(id)) return;
      const session = sessionByIdRef.current.get(id) ?? null;
      if (!session) {
        runSessionHealthCheckRef.current("transport-error", true);
        return;
      }
      if (session.exited || session.closing) return;

      if (operation === "resize") {
        runSessionHealthCheckRef.current("transport-error", true);
        return;
      }

      if (isSshSession(session)) {
        reconnectSshSessionRef.current(
          id,
          `${operation} failed${errorMessage ? `: ${errorMessage}` : ""}`,
          { immediate: true },
        );
        return;
      }

      runSessionHealthCheckRef.current("transport-error", true);
    },
    [],
  );

  const onCwdChange = useCallback((id: string, cwd: string) => {
    const trimmed = cwd.trim();
    if (!trimmed) return;

    const hasExplicitCommandLifecycle = commandLifecycleSessionsRef.current.has(id);
    if (!hasExplicitCommandLifecycle) {
      // Fallback for terminals that only expose cwd updates: treat this as prompt-ready.
      clearAgentIdleTimer(id);
      clearCommandActivityTimer(id);
      agentWorkingMapRef.current.set(id, false);
      scheduleAgentWorkingSync();
    }

    updateSessionById(id, (s) => {
      const nextCwd = s.cwd !== trimmed ? trimmed : s.cwd;
      if (hasExplicitCommandLifecycle) {
        return nextCwd === s.cwd ? s : { ...s, cwd: nextCwd };
      }
      if (nextCwd === s.cwd && !s.effectId && !(s.runningCommand ?? "").trim() && !s.processTag) return s;
      return { ...s, cwd: nextCwd, effectId: null, processTag: null, runningCommand: null };
    });
  }, [clearAgentIdleTimer, clearCommandActivityTimer, scheduleAgentWorkingSync, updateSessionById]);

  const onCommandChange = useCallback((id: string, commandLine: string, source: "osc" | "osc133" | "input" = "input") => {
    const trimmed = commandLine.trim();

    if (source === "osc" || source === "osc133") {
      if (source === "osc133") {
        commandLifecycleSessionsRef.current.add(id);
      }

      // Shell integration sends an empty command when the prompt is shown again.
      // Treat this as "no foreground command running" (back at prompt).
      if (!trimmed) {
        clearAgentIdleTimer(id);
        clearCommandActivityTimer(id);
        agentWorkingMapRef.current.set(id, false);
        scheduleAgentWorkingSync();
        updateSessionById(id, (s) => {
          if (!s.effectId && !(s.runningCommand ?? "").trim()) return s;
          return { ...s, effectId: null, processTag: null, runningCommand: null };
        });
        return;
      }

      const effect = detectProcessEffect({ command: trimmed, name: null });
      const nextEffectId = effect?.id ?? null;
      clearAgentIdleTimer(id);
      clearCommandActivityTimer(id);
      agentWorkingMapRef.current.set(id, false);
      scheduleAgentWorkingSync();
      updateSessionById(id, (s) => {
        const nextRestoreCommand = effect && !s.persistent ? trimmed : null;
        const nextProcessTag = commandTagFromCommandLine(trimmed);
        if (
          s.effectId === nextEffectId &&
          (s.restoreCommand ?? null) === nextRestoreCommand &&
          (s.runningCommand ?? null) === trimmed &&
          (s.processTag ?? null) === nextProcessTag
        ) {
          return s;
        }
        return {
          ...s,
          effectId: nextEffectId,
          restoreCommand: nextRestoreCommand,
          processTag: nextProcessTag,
          runningCommand: trimmed,
        };
      });
      scheduleRunningCommandActivityTimeout(id);
      return;
    }

    if (!trimmed) return;

    // If the session already has an agent effect, the user is sending a prompt
    // to the agent, not starting a new shell command.  Preserve the existing
    // effectId / restoreCommand / runningCommand so agent-activity tracking
    // keeps working.
    const existing = sessionByIdRef.current.get(id);
    if (existing?.effectId && getProcessEffectById(existing.effectId)) {
      return;
    }

    const effect = detectProcessEffect({ command: trimmed, name: null });
    const nextEffectId = effect?.id ?? null;
    clearAgentIdleTimer(id);
    clearCommandActivityTimer(id);
    agentWorkingMapRef.current.set(id, false);
    scheduleAgentWorkingSync();
    updateSessionById(id, (s) => {
      const nextRestoreCommand = effect && !s.persistent ? trimmed : null;
      const nextProcessTag = commandTagFromCommandLine(trimmed);
      if (
        s.effectId === nextEffectId &&
        (s.restoreCommand ?? null) === nextRestoreCommand &&
        (s.runningCommand ?? null) === trimmed &&
        (s.processTag ?? null) === nextProcessTag
      )
        return s;
      return {
        ...s,
        effectId: nextEffectId,
        restoreCommand: nextRestoreCommand,
        processTag: nextProcessTag,
        runningCommand: trimmed,
      };
    });
    scheduleRunningCommandActivityTimeout(id);
  }, [clearAgentIdleTimer, clearCommandActivityTimer, scheduleAgentWorkingSync, scheduleRunningCommandActivityTimeout, updateSessionById]);

  function pickActiveSessionIdFromList(projectId: string, sessions: Session[]): string | null {
    const orderedProjectSessions = sortProjectSessionsForSidebar(sessions, projectId);
    const last = lastActiveByProject.current.get(projectId);
    if (last) {
      const lastSession = orderedProjectSessions.find(
        (s) =>
          s.id === last &&
          !s.closing &&
          s.connectionState !== "reconnecting" &&
          s.connectionState !== "disconnected",
      );
      if (lastSession) return lastSession.id;
    }
    // Prefer live (non-exited, non-closing) sessions
    const firstLive = orderedProjectSessions.find(
      (s) =>
        !s.exited &&
        !s.closing &&
        s.connectionState !== "reconnecting" &&
        s.connectionState !== "disconnected",
    );
    if (firstLive) return firstLive.id;
    // Fall back to non-closing (includes exited)
    const firstOpen = orderedProjectSessions.find((s) => !s.closing);
    if (firstOpen) return firstOpen.id;
    // Last resort: any session in this project
    const firstAny = orderedProjectSessions[0] ?? null;
    return firstAny ? firstAny.id : null;
  }

  function pickActiveSessionId(projectId: string): string | null {
    return pickActiveSessionIdFromList(projectId, sessionsRef.current);
  }

  function pickActiveSessionIdFrom(projectId: string, sessions: Session[]): string | null {
    return pickActiveSessionIdFromList(projectId, sessions);
  }

  const selectProject = useCallback((projectId: string) => {
    setActiveProjectId(projectId);
    setActiveId(pickActiveSessionId(projectId));
    setActiveSplitViewId(null);
  }, []);

  const selectSessionById = useCallback((sessionId: string) => {
    const session = sessionsRef.current.find((s) => s.id === sessionId);
    if (!session) return;
    if (session.projectId !== activeProjectIdRef.current) {
      setActiveProjectId(session.projectId);
    }
    setActiveId(sessionId);
    setActiveSplitViewId(null);
  }, []);

  const moveProject = useCallback((projectId: string, targetProjectId: string, position: "before" | "after") => {
    setProjects((prev) => {
      if (projectId === targetProjectId) return prev;
      const project = prev.find((p) => p.id === projectId);
      if (!project) return prev;

      const next = prev.filter((p) => p.id !== projectId);
      const targetIndex = next.findIndex((p) => p.id === targetProjectId);
      if (targetIndex < 0) return prev;
      const insertIndex = position === "after" ? targetIndex + 1 : targetIndex;
      next.splice(insertIndex, 0, project);

      const unchanged =
        prev.length === next.length && prev.every((p, index) => p.id === next[index]?.id);
      return unchanged ? prev : next;
    });
  }, []);

  const openNewProject = useCallback(() => {
    const activeSession = sessionByIdRef.current.get(activeIdRef.current ?? "");
    const curProject = projectByIdRef.current.get(activeProjectIdRef.current ?? "") ?? null;
    setNewOpen(false);
    projectModalInitialRef.current = {
      mode: "new",
      title: "",
      basePath: activeSession?.cwd ?? curProject?.basePath ?? homeDirRef.current ?? "",
      environmentId: curProject?.environmentId ?? "",
      assetsEnabled: curProject?.assetsEnabled ?? true,
      sshTarget: "",
      sshRemotePath: "",
      defaultShell: null,
    };
    setProjectOpen(true);
    void refreshSshHosts();
  }, []);

  const openProjectSettings = useCallback((projectId: string) => {
    const project = projectByIdRef.current.get(projectId);
    if (!project) return;

    setNewOpen(false);
    projectModalInitialRef.current = {
      mode: "rename",
      title: project.title,
      basePath: project.basePath ?? "",
      environmentId: project.environmentId ?? "",
      assetsEnabled: project.assetsEnabled ?? true,
      sshTarget: project.sshTarget ?? "",
      sshRemotePath: project.sshRemotePath ?? "",
      defaultShell: project.defaultShell ?? null,
    };
    setProjectOpen(true);
    void refreshSshHosts();
  }, []);

  async function createSshSessionForProject(project: Project, allProjects?: Project[]) {
    const target = project.sshTarget!.trim();
    const remoteDir = project.sshRemotePath?.trim() || "";
    const launchCommand = remoteDir
      ? buildSshCommandAtRemoteDir({ baseCommandLine: null, target, remoteDir })
      : ensureSshKeepAliveOptions(`ssh ${target}`);
    const localCwd = project.basePath ?? homeDirRef.current ?? "";
    const validatedCwd = await invoke<string | null>("validate_directory", { path: localCwd }).catch(() => localCwd);
    const createdRaw = await createSession({
      projectId: project.id,
      name: `ssh ${target}`,
      launchCommand,
      sshTarget: target,
      sshRootDir: remoteDir || null,
      cwd: validatedCwd,
      envVars: envVarsForProjectId(project.id, allProjects ?? projects, environments),
    });
    const s = applyPendingExit(createdRaw);
    addSessionWithProjectSafeActivation(s);
  }

  async function createSshAgentSessionForProject(project: Project, effect: ProcessEffect) {
    const target = project.sshTarget!.trim();
    const remoteDir = project.sshRemotePath?.trim() || "";
    const agentCommand = effect.matchCommands[0] ?? effect.label;
    const launchCommand = buildSshAgentCommandAtRemoteDir({ target, remoteDir, agentCommand });
    const localCwd = project.basePath ?? homeDirRef.current ?? "";
    const validatedCwd = await invoke<string | null>("validate_directory", { path: localCwd }).catch(
      () => localCwd,
    );
    const createdRaw = await createSession({
      projectId: project.id,
      name: effect.label,
      launchCommand,
      sshTarget: target,
      sshRootDir: remoteDir || null,
      cwd: validatedCwd,
      envVars: envVarsForProjectId(project.id, projects, environments),
    });
    const s = applyPendingExit(createdRaw);
    // The agent runs inside an ssh invocation, so effect detection on the launch
    // command can miss it — tag the session explicitly so it shows the agent
    // icon and is tracked for activity.
    addSessionWithProjectSafeActivation({ ...s, effectId: effect.id });
  }

  async function onProjectSubmit(data: ProjectSubmitData) {
    const title = data.title.trim();
    if (!title) return;

    const isSshProject = Boolean(data.sshTarget?.trim());

    const desiredBasePath =
      data.basePath.trim() || activeProject?.basePath || homeDirRef.current || "";
    const validatedBasePath = isSshProject
      ? (await invoke<string | null>("validate_directory", { path: desiredBasePath }).catch(() => null) ?? homeDirRef.current ?? "")
      : await invoke<string | null>("validate_directory", { path: desiredBasePath }).catch(() => null);
    if (!isSshProject && !validatedBasePath) {
      setError("Project base path must be an existing directory.");
      return;
    }

    const environmentId = data.environmentId && environments.some((e) => e.id === data.environmentId)
      ? data.environmentId
      : null;

    if (projectModalInitialRef.current.mode === "rename") {
      setProjects((prev) =>
        prev.map((p) =>
          p.id === activeProjectId
            ? {
                ...p,
                title,
                basePath: validatedBasePath || p.basePath,
                environmentId,
                assetsEnabled: data.assetsEnabled,
                sshTarget: isSshProject ? data.sshTarget.trim() : null,
                sshRemotePath: isSshProject ? data.sshRemotePath.trim() || null : null,
                defaultShell: isSshProject ? null : data.defaultShell,
              }
            : p,
        ),
      );
      setProjectOpen(false);
      return;
    }

    const id = makeId();
    const project: Project = {
      id,
      title,
      basePath: validatedBasePath || null,
      environmentId,
      assetsEnabled: data.assetsEnabled,
      sshTarget: isSshProject ? data.sshTarget.trim() : null,
      sshRemotePath: isSshProject ? data.sshRemotePath.trim() || null : null,
      defaultShell: isSshProject ? null : data.defaultShell,
    };
    setProjects((prev) => [...prev, project]);
    setProjectOpen(false);
    setActiveProjectId(id);
    setActiveId(null); // No sessions yet; prevents flash of previous project's terminal

    try {
      if (isSshProject) {
        await createSshSessionForProject(project, [...projects, project]);
      } else {
        await ensureAutoAssets(validatedBasePath!, id, data.assetsEnabled);
        const createdRaw = await createSession({
          projectId: id,
          cwd: validatedBasePath!,
          envVars: envVarsForProjectId(id, [...projects, project], environments),
          shellChoice: shellChoiceForProject(project),
        });
        const s = applyPendingExit(createdRaw);
        addSessionWithProjectSafeActivation(s);
      }
    } catch (err) {
      reportError("Failed to create session", err);
      setActiveId(null);
    }
  }

  async function deleteActiveProject() {
    const project = projectByIdRef.current.get(activeProjectId);
    if (!project) return;

    const idsToClose = sessionsRef.current
      .filter((s) => s.projectId === activeProjectId)
      .map((s) => s.id);

    for (const id of idsToClose) {
      removeSessionFromState(id);
    }
    lastActiveByProject.current.delete(activeProjectId);
    setActiveSessionByProject((prev) => {
      if (!(activeProjectId in prev)) return prev;
      const next = { ...prev };
      delete next[activeProjectId];
      return next;
    });
    void Promise.all(idsToClose.map((id) => closeSession(id).catch(() => {})));

    const remaining = projects.filter((p) => p.id !== activeProjectId);
    if (remaining.length === 0) {
      const fallback: Project = {
        id: makeId(),
        title: "Default",
        basePath: homeDirRef.current,
        environmentId: null,
      };
      setProjects([fallback]);
      setActiveProjectId(fallback.id);
      setActiveId(null);
      try {
        const createdRaw = await createSession({
          projectId: fallback.id,
          cwd: fallback.basePath ?? null,
          envVars: envVarsForProjectId(fallback.id, [fallback], environments),
        });
        const s = applyPendingExit(createdRaw);
        setSessionsSync([s]);
        setActiveId(s.id);
      } catch (err) {
        reportError("Failed to create session", err);
        setActiveId(null);
      }
      return;
    }

    setProjects(remaining);
    const nextProjectId = remaining[0].id;
    setActiveProjectId(nextProjectId);
    setActiveId(pickActiveSessionId(nextProjectId));
  }

  useEffect(() => {
    const activeSession = activeId ? sessions.find((s) => s.id === activeId) ?? null : null;
    if (activeSession && activeSession.projectId === activeProjectId && !activeSession.closing) return;
    if (import.meta.env.DEV && activeSession && activeSession.projectId !== activeProjectId) {
      console.warn(
        `[activeId sync] Correcting cross-project activeId. ` +
        `activeId session project: ${activeSession.projectId}, activeProjectId: ${activeProjectId}, ` +
        `session: ${activeSession.name}`,
      );
    }
    const next = pickActiveSessionIdFrom(activeProjectId, sessions);
    if (next !== activeId) setActiveId(next);
  }, [activeId, activeProjectId, sessions]);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

	    const setup = async () => {
	      // Set up event listeners FIRST, before creating any sessions
      const unlistenOutput = await listen<PtyOutput>("pty-output", (event) => {
        if (cancelled) return;
        const { id, data } = event.payload as { id: string; data?: unknown };
        let text = coercePtyDataToString(data);
        if (!text) return;
              // Strip echoed Cursor Position Report responses (ESC[row;colR).
              // TUI apps send ESC[6n to query cursor position; xterm.js responds
              // via onData which the PTY kernel may echo back as visible garbage.
              if (CPR_RESPONSE_RE.test(text)) {
                text = text.replace(CPR_RESPONSE_RE_GLOBAL, "");
                if (!text) return;
              }

		        // Ignore events for sessions being closed
		        if (closingSessions.current.has(id)) return;
              markSessionAliveFromOutput(id);
			        markAgentWorkingFromOutput(id, text);
              const queue = outputQueueRef.current.get(id) ?? [];
              if (queue.length === 0) {
                queue.push(text);
              } else if (queue.length >= MAX_OUTPUT_QUEUE_CHUNKS_PER_SESSION) {
                const last = queue[queue.length - 1];
                if (last.length >= 64 * 1024) {
                  queue.shift();
                  queue.push(text);
                } else {
                  queue[queue.length - 1] += text;
                }
              } else {
                queue.push(text);
              }
              outputQueueRef.current.set(id, queue);
              scheduleOutputFlush();
      });
      unlisteners.push(unlistenOutput);

      const unlistenExit = await listen<PtyExit>("pty-exit", (event) => {
        if (cancelled) return;
        const { id, exit_code } = event.payload;

        clearAgentIdleTimer(id);
        clearCommandActivityTimer(id);
        agentWorkingMapRef.current.set(id, false);
        lastResizeAtRef.current.delete(id);

        const timeout = closingSessions.current.get(id);
        if (timeout !== undefined) {
          window.clearTimeout(timeout);
          closingSessions.current.delete(id);
          return;
        }

        const exitedSession = sessionByIdRef.current.get(id) ?? null;
        if (
          exitedSession &&
          isSshSession(exitedSession) &&
          !exitedSession.manualReconnectAvailable
        ) {
          reconnectSshSessionRef.current(
            id,
            `SSH exited${exit_code != null ? ` (${exit_code})` : ""}.`,
          );
          return;
        }

        setSessionsSync((prev) => {
          let found = false;
          const next = prev.map((s) => {
            if (s.id !== id) return s;
            found = true;
            return {
              ...s,
              exited: true,
              exitCode: exit_code ?? null,
              runningCommand: null,
              recordingActive: false,
              connectionState: isSshSession(s) ? "disconnected" : s.connectionState ?? "connected",
              manualReconnectAvailable: Boolean(isSshSession(s)),
              disconnectReason:
                isSshSession(s) && !s.disconnectReason
                  ? `SSH exited${exit_code != null ? ` (${exit_code})` : ""}.`
                  : s.disconnectReason ?? null,
            };
          });
          if (!found) pendingExitCodes.current.set(id, exit_code ?? null);
          return next;
        });

        // Auto-cleanup exited sessions after 120s if user is not viewing them
        if (!exitedCleanupTimers.current.has(id)) {
          const timer = window.setTimeout(() => {
            exitedCleanupTimers.current.delete(id);
            if (activeIdRef.current !== id) {
              removeSessionFromState(id);
            }
          }, 120_000);
          exitedCleanupTimers.current.set(id, timer);
        }
      });
      unlisteners.push(unlistenExit);

      const unlistenMenu = await listen<AppMenuEventPayload>("app-menu", (event) => {
        if (cancelled) return;
        if (event.payload.id === "help-check-updates") {
          setUpdatesOpen(true);
          void checkForUpdates();
          return;
        }
        if (event.payload.id === "edit-select-all") {
          const activeEl = document.activeElement;
          const activeElement = activeEl instanceof Element ? activeEl : null;
          const inCodeEditor = activeElement ? Boolean(activeElement.closest(".codeEditorPanel")) : false;
          if (inCodeEditor && codeEditorPanelRef.current?.selectAll()) return;

          const terminalElement = activeElement?.closest(".xterm") ?? null;
          const terminalId = terminalElement?.closest<HTMLElement>("[data-session-id]")?.dataset.sessionId ?? null;
          const terminalEntry = terminalId ? registry.current.get(terminalId) ?? null : null;
          if (terminalEntry) {
            terminalEntry.term.selectAll();
            terminalEntry.term.focus();
            return;
          }

          if (selectEditableElement(activeElement)) return;
          selectDocumentContents();
          return;
        }
        if (event.payload.id === "window-toggle-terminal-search") {
          const now = Date.now();
          if (now - terminalSearchTriggerAtRef.current < 180) return;
          const activeEl = document.activeElement;
          const inCodeEditor = activeEl instanceof Element && Boolean(activeEl.closest(".codeEditorPanel"));
          if (inCodeEditor) {
            const ran = codeEditorPanelRef.current?.openFind() ?? false;
            if (ran) terminalSearchTriggerAtRef.current = now;
            return;
          }
          const activeProjectId = activeProjectIdRef.current;
          const allSessions = sessionsRef.current;
          const activeId = activeIdRef.current;
          const activeSession = activeId ? allSessions.find((s) => s.id === activeId) ?? null : null;
          const inProject = allSessions.filter((s) => s.projectId === activeProjectId);
          const primaryId =
            (activeSession && activeSession.projectId === activeProjectId ? activeSession.id : null) ??
            inProject.find((s) => !s.closing)?.id ??
            inProject[0]?.id ??
            null;
          const split = splitPaneRef.current;
          const secondaryId = split?.secondaryId ?? null;
          const targets: string[] = [];
          if (primaryId) targets.push(primaryId);
          if (secondaryId && secondaryId !== primaryId) {
            const secondarySession = allSessions.find((s) => s.id === secondaryId) ?? null;
            if (secondarySession && secondarySession.projectId === activeProjectId) {
              targets.push(secondaryId);
            }
          }
          const resolvedTargets = targets.length > 0 ? targets : Array.from(registry.current.keys()).slice(0, 2);
          if (resolvedTargets.length === 0) return;
          terminalSearchTriggerAtRef.current = now;
          const allOpen = resolvedTargets.every((id) => terminalSearchSessionsRef.current.has(id));
          if (allOpen) {
            setTerminalSearchSessions((prev) => {
              const next = new Set(prev);
              let changed = false;
              for (const id of resolvedTargets) {
                if (next.delete(id)) changed = true;
              }
              return changed ? next : prev;
            });
            for (const id of resolvedTargets) {
              try { registry.current.get(id)?.search.clearDecorations(); } catch { /* ignore */ }
            }
            registry.current.get(resolvedTargets[0])?.term.focus();
            return;
          }
          setTerminalSearchSessions((prev) => {
            const next = new Set(prev);
            for (const id of resolvedTargets) next.add(id);
            return next;
          });
          return;
        }
      });
      unlisteners.push(unlistenMenu);

      const unlistenTray = await listen<TrayMenuEventPayload>("tray-menu", (event) => {
        if (cancelled) return;
        setPendingTrayAction(event.payload);
      });
      unlisteners.push(unlistenTray);

      // Intercept window close to flush pending state before shutdown
      const unlistenClose = await getCurrentWindow().onCloseRequested(async (event) => {
        event.preventDefault();
        // Flush pending save immediately
        if (saveTimerRef.current !== null) {
          window.clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        const state = pendingSaveRef.current;
        if (state) {
          await invoke("save_persisted_state", { state }).catch(() => {});
          pendingSaveRef.current = null;
        }
        // Detach persistent sessions (keep alive), close others
        const promises: Promise<void>[] = [];
        for (const s of sessionsRef.current) {
          if (s.persistent && !s.exited) {
            promises.push(detachSession(s.id).catch(() => {}));
          } else if (!s.exited) {
            promises.push(closeSession(s.id).catch(() => {}));
          }
        }
        await Promise.allSettled(promises);
        await getCurrentWindow().destroy();
      });
      unlisteners.push(unlistenClose);

      // Check if we were cancelled during async setup
      if (cancelled) {
        unlisteners.forEach(fn => fn());
        return;
      }

      let resolvedHome: string | null = null;
      try {
        resolvedHome = await homeDir();
        homeDirRef.current = resolvedHome;
      } catch {
        resolvedHome = null;
        homeDirRef.current = null;
      }

      const startupFlags = await invoke<StartupFlags>("get_startup_flags").catch(() => null);
      if (startupFlags?.clearData) {
	        try {
	          localStorage.removeItem(STORAGE_PROJECTS_KEY);
	          localStorage.removeItem(STORAGE_ACTIVE_PROJECT_KEY);
	          localStorage.removeItem(STORAGE_SESSIONS_KEY);
	          localStorage.removeItem(STORAGE_ACTIVE_SESSION_BY_PROJECT_KEY);
	          localStorage.removeItem(STORAGE_WORKSPACE_VIEW_BY_KEY);
	        } catch {
	          // Best-effort: localStorage may be unavailable in some contexts.
	        }
        showNotice("Cleared saved app data for a fresh start.", 8000);
      }

      const stateMeta = await invoke<PersistedStateMetaV1 | null>("load_persisted_state_meta").catch(
        () => null,
      );
      const metaMode = stateMeta?.secureStorageMode ?? null;
      const needsSecureStorage = Boolean(
        stateMeta &&
          stateMeta.schemaVersion === 1 &&
          metaMode === "keychain" &&
          stateMeta.encryptedEnvironmentCount > 0,
      );
      if (needsSecureStorage) {
        showNotice(
          "macOS Keychain access is needed to decrypt/encrypt your environments + recordings. You may see 1–2 prompts (first run can create the encryption key). Choose “Always Allow” to avoid future prompts.",
          60000,
        );
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        try {
          await invoke("prepare_secure_storage");
          showNotice(
            "Secure storage enabled: environments + recording inputs are encrypted at rest (key stored in macOS Keychain).",
            20000,
          );
        } catch (err) {
          if (!cancelled) {
            setPersistenceDisabledReason(`Secure storage is locked (changes won’t be saved): ${formatError(err)}`);
          }
        }
      }

      const legacyProjects = loadLegacyProjectState();
      const legacySessions = loadLegacyPersistedSessions();
      const legacyActiveSessionByProject = loadLegacyActiveSessionByProject();

      let diskState: PersistedStateV1 | null = null;
      try {
        diskState = await invoke<PersistedStateV1 | null>("load_persisted_state");
      } catch (err) {
        const msg = formatError(err);
        if (!cancelled) {
          setPersistenceDisabledReason(
            `Failed to load saved state (changes won't be saved until restart): ${msg}`,
          );
        }
        diskState = null;
      }

      let state: PersistedStateV1 | null = diskState;
      if (!state && legacyProjects) {
        const basePathByProject = new Map<string, string | null>();
        for (const s of legacySessions) {
          const existing = basePathByProject.get(s.projectId);
          if (!existing && s.cwd) basePathByProject.set(s.projectId, s.cwd);
        }
        state = {
          schemaVersion: 1,
          projects: legacyProjects.projects.map((p) => ({
            ...p,
            basePath: basePathByProject.get(p.id) ?? resolvedHome,
          })),
          activeProjectId: legacyProjects.activeProjectId,
          sessions: legacySessions,
          activeSessionByProject: legacyActiveSessionByProject,
        };
      }

      if (!state) {
        const initial = defaultProjectState();
        state = {
          schemaVersion: 1,
          projects: initial.projects.map((p) => ({ ...p, basePath: resolvedHome })),
          activeProjectId: initial.activeProjectId,
          sessions: [],
          activeSessionByProject: {},
        };
      }

      if (cancelled) return;

      state.projects = state.projects.map((p) => ({
        ...p,
        basePath: p.basePath ?? null,
        environmentId: (p as { environmentId?: string | null }).environmentId ?? null,
        assetsEnabled: (p as { assetsEnabled?: boolean }).assetsEnabled ?? true,
      }));

      const projectById = new Map(state.projects.map((p) => [p.id, p]));
      if (projectById.size === 0) {
        const initial = defaultProjectState();
        state.projects = initial.projects.map((p) => ({ ...p, basePath: resolvedHome }));
        state.activeProjectId = initial.activeProjectId;
        state.sessions = [];
        state.activeSessionByProject = {};
        projectById.clear();
        for (const p of state.projects) projectById.set(p.id, p);
      }

      const activeProjectId = projectById.has(state.activeProjectId)
        ? state.activeProjectId
        : state.projects[0].id;

      const activeSessionByProject = Object.fromEntries(
        Object.entries(state.activeSessionByProject).filter(([projectId]) =>
          projectById.has(projectId),
        ),
      );

      setProjects(state.projects);
      setActiveProjectId(activeProjectId);
      activeProjectIdRef.current = activeProjectId;
      setActiveSessionByProject(activeSessionByProject);

      const workspaceStorage = loadWorkspaceViewStorageV1();
      if (workspaceStorage?.schemaVersion === 1) {
        const validProjectIds = new Set(state.projects.map((p) => p.id));
        const nextWorkspaceViews: Record<string, WorkspaceView> = {};
        for (const [workspaceKey, stored] of Object.entries(workspaceStorage.views)) {
          const projectId = projectIdFromWorkspaceKey(workspaceKey) ?? stored.projectId;
          if (!projectId || !validProjectIds.has(projectId)) continue;

          const base = createInitialWorkspaceView(projectId);
          const fileExplorerRootDir = stored.fileExplorerRootDir ?? base.fileExplorerRootDir;
          const codeEditorRootDir = stored.codeEditorRootDir ?? base.codeEditorRootDir;
          const rootOverride = fileExplorerRootDir ?? codeEditorRootDir ?? null;

          const codeEditorPersistedState = coerceCodeEditorPersistedState(stored.codeEditorPersistedState);
          const codeEditorActiveFilePath =
            stored.codeEditorActiveFilePath ?? codeEditorPersistedState?.activePath ?? base.codeEditorActiveFilePath;

          nextWorkspaceViews[workspaceKey] = {
            ...base,
            projectId,
            fileExplorerOpen:
              typeof stored.fileExplorerOpen === "boolean" ? stored.fileExplorerOpen : base.fileExplorerOpen,
            fileExplorerRootDir,
            fileExplorerPersistedState: coerceFileExplorerPersistedState(
              stored.fileExplorerPersistedState,
              rootOverride,
            ),
            codeEditorOpen: typeof stored.codeEditorOpen === "boolean" ? stored.codeEditorOpen : base.codeEditorOpen,
            codeEditorRootDir,
            codeEditorActiveFilePath,
            codeEditorPersistedState,
            openFileRequest: null,
            openWorkspaceTabRequest: null,
            codeEditorFsEvent: null,
          };
        }
        setWorkspaceViewByKey(nextWorkspaceViews);
      }

      const loadedSecureStorageMode =
        (state as { secureStorageMode?: SecureStorageMode | null }).secureStorageMode ?? metaMode;
      setSecureStorageMode(loadedSecureStorageMode ?? null);
      setPrompts(state.prompts ?? []);
      setEnvironments(state.environments ?? []);
      const encryptedEnvCount = (state.environments ?? []).filter((e) =>
        (e.content ?? "").trimStart().startsWith("enc:v1:"),
      ).length;
      if (encryptedEnvCount > 0) {
        if (loadedSecureStorageMode === "keychain") {
          showNotice(
            `Some environments could not be decrypted (${encryptedEnvCount}). Check macOS Keychain access.`,
            9000,
          );
        } else {
          showNotice(
            `Some environments are encrypted (${encryptedEnvCount}). Enable macOS Keychain encryption to unlock them.`,
            12000,
          );
        }
      }
      setAssetSettings(state.assetSettings ?? { autoApplyEnabled: true });
      setAgentShortcutIds(() => {
        const loaded = state.agentShortcutIds ?? null;
        if (!loaded) return cleanAgentShortcutIds(DEFAULT_AGENT_SHORTCUT_IDS);
        const cleaned = cleanAgentShortcutIds(loaded);
        if (loaded.length > 0 && cleaned.length === 0) {
          return cleanAgentShortcutIds(DEFAULT_AGENT_SHORTCUT_IDS);
        }
        return cleaned;
      });
      setAssets(() => {
        const loaded = (state.assets ?? [])
          .map((a) => ({
            ...a,
            name: a.name?.trim?.() ? a.name.trim() : a.name,
            relativePath: a.relativePath?.trim?.() ? a.relativePath.trim() : a.relativePath,
            autoApply: a.autoApply ?? true,
          }))
          .filter((a) => a && a.id && a.relativePath && a.name);
        if (loaded.length) return loaded;
        return [
          {
            id: makeId(),
            name: "AGENTS.md",
            relativePath: "AGENTS.md",
            content: "# AGENTS.md\n\n<INSTRUCTIONS>\n- Add project-specific agent instructions here.\n</INSTRUCTIONS>\n",
            createdAt: Date.now(),
            autoApply: true,
          },
        ];
      });

      const envVarsForProject = (projectId: string): Record<string, string> | null => {
        return envVarsForProjectId(projectId, state.projects, state.environments ?? []);
      };

      const persisted = dedupePersistedSessions(
        state.sessions
          .filter((s) => projectById.has(s.projectId))
          .map((s) => ({
            ...s,
            pinned: Boolean((s as { pinned?: boolean }).pinned),
            sidebarOrder:
              typeof (s as { sidebarOrder?: unknown }).sidebarOrder === "number" &&
              Number.isFinite((s as { sidebarOrder?: number }).sidebarOrder)
                ? ((s as { sidebarOrder?: number }).sidebarOrder ?? null)
                : s.createdAt,
          })),
      );

      const syncLastActiveByProject = (items: Session[]) => {
        for (const p of state.projects) {
          const desired = activeSessionByProject[p.id];
          const session =
            (desired ? items.find((s) => s.projectId === p.id && s.persistId === desired) : null) ??
            items.find((s) => s.projectId === p.id) ??
            null;
          if (session) lastActiveByProject.current.set(p.id, session.id);
          else lastActiveByProject.current.delete(p.id);
        }
      };

      const pickActiveFromProject = (items: Session[]): Session | null => {
        const desired = activeSessionByProject[activeProjectId];
        return (
          (desired
            ? items.find((s) => s.projectId === activeProjectId && s.persistId === desired)
            : null) ??
          items.find((s) => s.projectId === activeProjectId) ??
          null
        );
      };

      const restorePersistedSession = async (s: PersistedSession): Promise<Session | null> => {
        try {
          const createdRaw = await createSession({
            projectId: s.projectId,
            name: s.name,
            launchCommand: s.launchCommand,
            restoreCommand: s.restoreCommand ?? null,
            sshTarget:
              s.sshTarget ??
              sshTargetFromCommandLine(s.launchCommand ?? s.restoreCommand ?? null) ??
              sshTargetFromSessionName(s.name),
            sshRootDir: s.sshRootDir ?? null,
            lastRecordingId: s.lastRecordingId ?? null,
            cwd: s.cwd ?? projectById.get(s.projectId)?.basePath ?? resolvedHome ?? null,
            envVars: envVarsForProject(s.projectId),
            persistent: s.persistent ?? false,
            persistId: s.persistId,
            createdAt: s.createdAt,
            pinned: Boolean(s.pinned),
            sidebarOrder:
              typeof s.sidebarOrder === "number" && Number.isFinite(s.sidebarOrder)
                ? s.sidebarOrder
                : s.createdAt,
          });
          const created = applyPendingExit(createdRaw);
          if (s.symbol) created.symbol = s.symbol;
          if (s.color) created.color = s.color;
          const restoreCmd =
            (s.persistent
              ? null
              : (s.launchCommand ? null : (s.restoreCommand ?? null))?.trim()) ?? null;
          if (restoreCmd) {
            const singleLine = restoreCmd.replace(/\r?\n/g, " ");
            void (async () => {
              try {
                if (singleLine) {
                  await invoke("write_to_session", {
                    id: created.id,
                    data: singleLine,
                    source: "system",
                  });
                  await sleep(30);
                }
                await invoke("write_to_session", {
                  id: created.id,
                  data: "\r",
                  source: "system",
                });
                if (singleLine) onCommandChange(created.id, singleLine, "input");
              } catch {
                // Best-effort restore: if this fails, the tab still opens as a shell.
              }
            })();
          }
          return created;
        } catch (err) {
          if (!cancelled) reportError("Failed to restore session", err);
          return null;
        }
      };

      const desiredActivePersistId = activeSessionByProject[activeProjectId];
      const prioritizedFirst =
        (desiredActivePersistId
          ? persisted.find(
              (s) => s.projectId === activeProjectId && s.persistId === desiredActivePersistId,
            )
          : null) ??
        persisted.find((s) => s.projectId === activeProjectId) ??
        null;
      const orderedPersisted = prioritizedFirst
        ? [prioritizedFirst, ...persisted.filter((s) => s !== prioritizedFirst)]
        : persisted;
      const totalToRestore = orderedPersisted.length;
      if (totalToRestore > 0) {
        setSessionRestoreProgress({ remaining: totalToRestore, total: totalToRestore });
        showNotice(
          `Restoring ${totalToRestore} saved terminal${totalToRestore === 1 ? "" : "s"}…`,
          20_000,
        );
      } else {
        setSessionRestoreProgress(null);
      }

      let restored: Session[] = [];
      let firstRestoreIndex = -1;
      for (let i = 0; i < orderedPersisted.length; i += 1) {
        if (cancelled) break;
        const created = await restorePersistedSession(orderedPersisted[i]);
        if (!created) continue;
        restored = [...restored, created];
        firstRestoreIndex = i;
        break;
      }

      if (cancelled) {
        await Promise.all(restored.map((s) => closeSession(s.id).catch(() => {})));
        return;
      }

      if (restored.length === 0) {
        let first: Session;
        try {
          const basePath = projectById.get(activeProjectId)?.basePath ?? resolvedHome ?? null;
          const createdRaw = await createSession({
            projectId: activeProjectId,
            cwd: basePath,
            envVars: envVarsForProject(activeProjectId),
          });
          first = applyPendingExit(createdRaw);
        } catch (err) {
          if (!cancelled) reportError("Failed to create session", err);
          setSessionRestoreProgress(null);
          setSessionsSync([]);
          setActiveId(null);
          setHydrated(true);
          return;
        }
        if (cancelled) {
          await closeSession(first.id).catch(() => {});
          return;
        }
        syncLastActiveByProject([first]);
        setSessionRestoreProgress(null);
        setSessionsSync([first]);
        setActiveId(first.id);
        setHydrated(true);
        if (totalToRestore > 0) {
          showNotice(
            `Restored 0/${totalToRestore} saved terminal${totalToRestore === 1 ? "" : "s"}. Opened a new terminal.`,
            9000,
          );
        }
        return;
      }

      syncLastActiveByProject(restored);
      const initialActive = pickActiveFromProject(restored);
      // Never pass a mutable working array reference into React state.
      // If we later mutate that same array during the restore loop, React can
      // miss updates because the state reference is unchanged.
      setSessionsSync([...restored]);
      setActiveId(initialActive ? initialActive.id : null);
      const attemptedCount = Math.max(1, firstRestoreIndex + 1);
      const remainingAfterInitial = Math.max(0, totalToRestore - attemptedCount);
      if (remainingAfterInitial > 0) {
        setSessionRestoreProgress({ remaining: remainingAfterInitial, total: totalToRestore });
      } else {
        setSessionRestoreProgress(null);
      }
      setHydrated(true);

      if (remainingAfterInitial === 0) {
        if (totalToRestore > 0) {
          showNotice(
            `Restored ${restored.length}/${totalToRestore} saved terminal${totalToRestore === 1 ? "" : "s"}.`,
            7000,
          );
        }
        return;
      }

      let attempted = attemptedCount;
      const remainingCandidates = orderedPersisted.slice(firstRestoreIndex + 1);
      for (const s of remainingCandidates) {
        if (cancelled) break;
        const created = await restorePersistedSession(s);
        attempted += 1;
        if (created) {
          restored = [...restored, created].sort((a, b) => a.createdAt - b.createdAt);
          syncLastActiveByProject(restored);
          setSessionsSync((prev) => {
            if (prev.some((s) => s.id === created.id)) return prev; // dedup guard
            return [...prev, created].sort((a, b) => a.createdAt - b.createdAt);
          });
          // Only update activeId if the restored session belongs to the
          // user's current project — they may have switched away since
          // the restore loop started.
          if (created.projectId === activeProjectIdRef.current) {
            const nextActive = pickActiveFromProject(restored);
            if (nextActive) setActiveId(nextActive.id);
          }
        }
        if (!cancelled) {
          const remaining = Math.max(0, totalToRestore - attempted);
          if (remaining > 0) setSessionRestoreProgress({ remaining, total: totalToRestore });
          else setSessionRestoreProgress(null);
        }
      }

      if (!cancelled) {
        setSessionRestoreProgress(null);
        if (totalToRestore > 0) {
          showNotice(
            `Restored ${restored.length}/${totalToRestore} saved terminal${totalToRestore === 1 ? "" : "s"}.`,
            7000,
          );
        }
      }
    };
		
	    void setup().catch((err) => {
	      if (cancelled) return;
	      reportError("Startup failed", err);
	      setSessionRestoreProgress(null);
	      setHydrated(true);
	    });

	    return () => {
	      cancelled = true;
	      unlisteners.forEach(fn => fn());
        if (outputFlushRafRef.current !== null) {
          window.cancelAnimationFrame(outputFlushRafRef.current);
          outputFlushRafRef.current = null;
        }
        outputQueueRef.current.clear();
        pendingAgentWorkingRef.current.clear();
        if (agentWorkingSyncTimerRef.current !== null) {
          window.clearTimeout(agentWorkingSyncTimerRef.current);
          agentWorkingSyncTimerRef.current = null;
        }
        agentWorkingMapRef.current.clear();
        setAgentWorkingIds(EMPTY_STRING_SET);
	      if (saveTimerRef.current !== null) {
	        window.clearTimeout(saveTimerRef.current);
	        saveTimerRef.current = null;
	      }
	      // Flush pending state instead of discarding it
	      const pendingState = pendingSaveRef.current;
	      if (pendingState) {
	        void invoke("save_persisted_state", { state: pendingState }).catch(() => {});
	      }
	      pendingSaveRef.current = null;
	      if (workspaceViewSaveTimerRef.current !== null) {
	        window.clearTimeout(workspaceViewSaveTimerRef.current);
	        workspaceViewSaveTimerRef.current = null;
	      }
	      pendingWorkspaceViewSaveRef.current = null;
	      for (const timeout of closingSessions.current.values()) {
	        window.clearTimeout(timeout);
	      }
	      closingSessions.current.clear();
        for (const timeout of reconnectTimersRef.current.values()) {
          window.clearTimeout(timeout);
        }
        reconnectTimersRef.current.clear();
        reconnectInFlightRef.current.clear();
        healthCheckInFlightRef.current = false;
	      for (const timeout of agentIdleTimersRef.current.values()) {
	        window.clearTimeout(timeout);
	      }
	      agentIdleTimersRef.current.clear();
        for (const timeout of commandActivityTimersRef.current.values()) {
          window.clearTimeout(timeout);
        }
        commandActivityTimersRef.current.clear();
	      for (const id of sessionIdsRef.current) {
        const s = sessionsRef.current.find((x) => x.id === id) ?? null;
        if (s?.persistent && !s.exited) void detachSession(id).catch(() => {});
        else void closeSession(id).catch(() => {});
      }
    };
  }, []);

  async function onNewSubmit(data: NewSessionSubmitData) {
    const name = data.name.trim() || undefined;
    try {
      const launchCommand = data.command.trim() || null;
      const usePersistent = data.persistent && !launchCommand;
      const desiredCwd =
        data.cwd.trim() || activeProject?.basePath || homeDirRef.current || "";
      const validatedCwd = await invoke<string | null>("validate_directory", {
        path: desiredCwd,
      }).catch(() => null);
      if (!validatedCwd) {
        setError("Working directory must be an existing folder.");
        return;
      }
      await ensureAutoAssets(validatedCwd, activeProjectId);
      const createdRaw = await createSession({
        projectId: activeProjectId,
        name,
        launchCommand,
        persistent: usePersistent,
        cwd: validatedCwd,
        envVars: envVarsForProjectId(activeProjectId, projects, environments),
        // Fast default flow: inherit the project's default shell.
        shellChoice: shellChoiceForProject(activeProject),
      });
      const s = applyPendingExit(createdRaw);
      addSessionWithProjectSafeActivation(s);
      setNewOpen(false);
    } catch (err) {
      reportError("Failed to create session", err);
    }
  }

  // Second flow: open an individual terminal with an explicitly chosen shell.
  async function createTerminalWithShell(projectId: string, choice: ShellChoice) {
    try {
      const project = projects.find((p) => p.id === projectId) ?? null;
      const desiredCwd = project?.basePath || homeDirRef.current || "";
      const validatedCwd = desiredCwd
        ? await invoke<string | null>("validate_directory", { path: desiredCwd }).catch(() => null)
        : null;
      if (validatedCwd) await ensureAutoAssets(validatedCwd, projectId);
      const createdRaw = await createSession({
        projectId,
        name: shellChoiceShortName(choice),
        launchCommand: null,
        cwd: validatedCwd,
        envVars: envVarsForProjectId(projectId, projects, environments),
        shellChoice: choice,
      });
      const s = applyPendingExit(createdRaw);
      addSessionWithProjectSafeActivation(s);
    } catch (err) {
      reportError("Failed to create session", err);
    }
  }

  async function onSshConnect(data: SshConnectData) {
    const desiredCwd = activeProject?.basePath ?? homeDirRef.current ?? "";
    const validatedCwd = await invoke<string | null>("validate_directory", {
      path: desiredCwd,
    }).catch(() => null);
    if (!validatedCwd) {
      throw new Error("Working directory must be an existing folder.");
    }

    await ensureAutoAssets(validatedCwd, activeProjectId);

    const name = `ssh ${data.host}`;
    const createdRaw = await createSession({
      projectId: activeProjectId,
      name,
      launchCommand: data.persistent ? null : data.command,
      restoreCommand: data.persistent ? data.command : null,
      sshTarget: data.host,
      persistent: data.persistent,
      cwd: validatedCwd,
      envVars: envVarsForProjectId(activeProjectId, projects, environments),
    });
    const s = applyPendingExit(createdRaw);
    addSessionWithProjectSafeActivation(s);
    setSshManagerOpen(false);

    // Save to SSH history
    pushSshHistory({ host: data.host, command: data.command, persistent: data.persistent, connectedAt: Date.now() });

    if (data.persistent) {
      void (async () => {
        try {
          await invoke("write_to_session", { id: s.id, data: data.command, source: "system" });
          await sleep(30);
          await invoke("write_to_session", { id: s.id, data: "\r", source: "system" });
          onCommandChange(s.id, data.command, "input");
        } catch (err) {
          reportError("Failed to start SSH inside persistent session", err);
        }
      })();
    }
  }

  function pushSshHistory(entry: SshHistoryEntry) {
    setSshHistory((prev) => {
      const next = [entry, ...prev.filter((e) => e.command !== entry.command)].slice(0, MAX_SSH_HISTORY);
      try { localStorage.setItem(STORAGE_SSH_HISTORY_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }

  function removeSshHistoryEntry(index: number) {
    setSshHistory((prev) => {
      const next = prev.filter((_, i) => i !== index);
      try { localStorage.setItem(STORAGE_SSH_HISTORY_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }

  function onSshHistoryConnect(entry: SshHistoryEntry) {
    void onSshConnect({
      host: entry.host,
      persistent: entry.persistent,
      forwardOnly: false,
      exitOnForwardFailure: true,
      forwards: [],
      command: entry.command,
    });
  }

  // Immediately remove a session from UI state. Synchronous — never blocks.
  // Backend cleanup is fire-and-forget.
  function removeSessionFromState(id: string) {
    const exitTimer = exitedCleanupTimers.current.get(id);
    if (exitTimer !== undefined) {
      window.clearTimeout(exitTimer);
      exitedCleanupTimers.current.delete(id);
    }
    clearSessionRuntimeBuffers(id);
    commandLifecycleSessionsRef.current.delete(id);
    setTerminalSearchSessions((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    // Mark as closing so output/exit handlers ignore stale backend events.
    const prevTimeout = closingSessions.current.get(id);
    if (prevTimeout !== undefined) window.clearTimeout(prevTimeout);
    const cleanupTimeout = window.setTimeout(() => {
      closingSessions.current.delete(id);
	    }, 10_000);
	    closingSessions.current.set(id, cleanupTimeout);
	    setSplitViews((prev) => prev.filter((v) => v.aId !== id && v.bId !== id));
      setActiveSplitViewId((prev) => {
        if (!prev) return prev;
        const view = splitViewsRef.current.find((v) => v.id === prev) ?? null;
        if (view && (view.aId === id || view.bId === id)) return null;
        return prev;
      });
	    setSessionsSync((prev) => {
	      const removed = prev.find((s) => s.id === id);
	      const next = prev.filter((s) => s.id !== id);
	      if (next.length === prev.length) return prev; // not found — no-op
      setActiveId((prevActive) => {
        if (prevActive !== id) return prevActive;
        const projectId = removed?.projectId ?? activeProjectIdRef.current;
        return pickActiveSessionIdFromList(projectId, next);
      });
      return next;
    });
  }

  // Close a session: remove from UI immediately, then async backend cleanup.
  function onClose(id: string) {
    // Snapshot session data before removal (for async cleanup).
    const session = sessionsRef.current.find((s) => s.id === id) ?? null;

    // Step 1: Remove from UI state immediately. No "closing" intermediate state.
    removeSessionFromState(id);
    flushPendingSave();

    // Step 2: Fire-and-forget backend + persistent session cleanup.
    void (async () => {
      try {
        if (session?.recordingActive) {
          await invoke("stop_session_recording", { id }).catch(() => {});
        }
        await closeSession(id).catch(() => {});

        const wasPersistent = Boolean(session?.persistent && !session?.exited);
        if (wasPersistent && session?.persistId) {
          let killedPersistent = false;
          let killErr: string | null = null;
          try {
            await invoke("kill_persistent_session", { persistId: session.persistId });
            killedPersistent = true;
          } catch (err) {
            killErr = formatError(err);
          } finally {
            void refreshPersistentSessions();
          }
          if (killedPersistent) {
            showNotice(`Closed "${session.name}" and killed persistent terminal.`);
          } else if (killErr) {
            showNotice(
              `Closed "${session.name}" but failed to kill persistent terminal. Manage via Persistent terminals (∞).`,
            );
          } else {
            showNotice(`Closed "${session.name}".`);
          }
        }
      } catch {
        // All cleanup is best-effort.
      }
    })();
  }

  async function attachPersistentSession(persistId: string) {
    const normalizedPersistId = persistId.trim();
    if (!normalizedPersistId) return;
    if (attachingPersistentIdsRef.current.has(normalizedPersistId)) return;
    attachingPersistentIdsRef.current.add(normalizedPersistId);
    try {
      const existing = sessionsRef.current.find(
        (s) =>
          s.persistId === normalizedPersistId &&
          !s.exited &&
          !s.closing &&
          s.connectionState !== "reconnecting" &&
          s.connectionState !== "disconnected",
      ) ?? null;
      if (existing) {
        setActiveProjectId(existing.projectId);
        setActiveId(existing.id);
        return;
      }

      const projectId = activeProjectIdRef.current;
      const cwd = projectByIdRef.current.get(projectId)?.basePath ?? homeDirRef.current ?? null;
      if (cwd) await ensureAutoAssets(cwd, projectId);
      const createdRaw = await createSession({
        projectId,
        name: `persist ${normalizedPersistId.slice(0, 8)}`,
        persistent: true,
        persistId: normalizedPersistId,
        cwd,
        envVars: envVarsForProjectId(projectId, projects, environments),
      });
      const created = applyPendingExit(createdRaw);
      addSessionWithProjectSafeActivation(created);
    } catch (err) {
      reportError("Failed to attach persistent session", err);
    } finally {
      attachingPersistentIdsRef.current.delete(normalizedPersistId);
    }
  }

  async function confirmKillPersistentSession() {
    const persistId = confirmKillPersistentId;
    if (!persistId) return;
    setConfirmKillPersistentBusy(true);
    try {
      const toClose = sessionsRef.current.filter((s) => s.persistId === persistId).map((s) => s.id);
      await Promise.all(toClose.map((id) => closeSession(id).catch(() => {})));
      await invoke("kill_persistent_session", { persistId });

      setSessionsSync((prev) => {
        const next = prev.filter((s) => s.persistId !== persistId);
        setActiveId((prevActive) => {
          if (!prevActive) return prevActive;
          if (next.some((s) => s.id === prevActive)) return prevActive;
          return pickActiveSessionIdFromList(activeProjectIdRef.current, next);
        });
        return next;
      });

      showNotice(`Killed persistent session ${persistId.slice(0, 8)}`);
      void refreshPersistentSessions();
    } catch (err) {
      reportError("Failed to kill persistent session", err);
    } finally {
      setConfirmKillPersistentBusy(false);
      setConfirmKillPersistentId(null);
    }
  }

  function cleanAgentShortcutIds(input: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of input) {
      const id = raw.trim();
      if (!id || seen.has(id)) continue;
      if (!getProcessEffectById(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  function addAgentShortcut(id: string) {
    setAgentShortcutIds((prev) => cleanAgentShortcutIds([...prev, id]));
  }

  function removeAgentShortcut(id: string) {
    setAgentShortcutIds((prev) => cleanAgentShortcutIds(prev.filter((x) => x !== id)));
  }

  function moveAgentShortcut(id: string, direction: -1 | 1) {
    setAgentShortcutIds((prev) => {
      const cleaned = cleanAgentShortcutIds(prev);
      const index = cleaned.indexOf(id);
      const nextIndex = index + direction;
      if (index < 0) return cleaned;
      if (nextIndex < 0 || nextIndex >= cleaned.length) return cleaned;
      const next = cleaned.slice();
      const [item] = next.splice(index, 1);
      next.splice(nextIndex, 0, item);
      return next;
    });
  }

  async function quickStart(
    preset: { id: string; title: string; command: string | null },
    projectIdArg?: string,
  ) {
    try {
      const targetProjectId = projectIdArg ?? activeProjectId;
      const targetProject = projects.find((p) => p.id === targetProjectId) ?? activeProject ?? null;
      const cwd = targetProject?.basePath ?? homeDirRef.current ?? null;
      if (cwd) await ensureAutoAssets(cwd, targetProjectId);
      const createdRaw = await createSession({
        projectId: targetProjectId,
        name: preset.title,
        launchCommand: null,
        cwd,
        envVars: envVarsForProjectId(targetProjectId, projects, environments),
        // Agent quick-starts run under the project's default shell.
        shellChoice: shellChoiceForProject(targetProject),
      });
      const created = applyPendingExit(createdRaw);
      const next = created;
      addSessionWithProjectSafeActivation(next);

      const commandLine = (preset.command ?? "").trim();
      if (commandLine) {
        void invoke("write_to_session", { id: next.id, data: `${commandLine}\r`, source: "ui" })
          .then(() => onCommandChange(next.id, commandLine, "input"))
          .catch((err) => reportError(`Failed to start ${preset.title}`, err));
      }
    } catch (err) {
      reportError(`Failed to start ${preset.title}`, err);
    }
  }

  const pendingApplyAsset = applyAssetRequest
    ? assets.find((a) => a.id === applyAssetRequest.assetId) ?? null
    : null;

  const pendingDeletePrompt = confirmDeletePromptId
    ? prompts.find((p) => p.id === confirmDeletePromptId) ?? null
    : null;
  const pendingDeleteEnvironment = confirmDeleteEnvironmentId
    ? environments.find((e) => e.id === confirmDeleteEnvironmentId) ?? null
    : null;
  const pendingDeleteAsset = confirmDeleteAssetId
    ? assets.find((a) => a.id === confirmDeleteAssetId) ?? null
    : null;

  // -- Stable callback props for memoized sidebar sections --

  const handleCloseSession = useCallback(
    (id: string) => void onClose(id),
    // onClose reads from refs/state setters internally; safe with []
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const handleReconnectSession = useCallback((id: string) => {
    reconnectSshSessionRef.current(id, "Manual reconnect", {
      immediate: true,
      manual: true,
    });
  }, []);

  const handleToggleSessionPin = useCallback((sessionId: string) => {
    setSessionsSync((prev) => {
      const target = prev.find((session) => session.id === sessionId);
      if (!target) return prev;

      const projectId = target.projectId;
      const sorted = sortProjectSessionsForSidebar(prev, projectId);
      const source = sorted.find((session) => session.id === sessionId);
      if (!source) return prev;

      const nextPinned = !Boolean(source.pinned);
      const remaining = sorted.filter((session) => session.id !== sessionId);
      const insertIndex = nextPinned
        ? 0
        : (() => {
            const firstUnpinned = remaining.findIndex((session) => !Boolean(session.pinned));
            return firstUnpinned >= 0 ? firstUnpinned : remaining.length;
          })();

      const reordered = [
        ...remaining.slice(0, insertIndex),
        { ...source, pinned: nextPinned },
        ...remaining.slice(insertIndex),
      ];

      return mergeProjectSessionLayout(
        prev,
        projectId,
        normalizeProjectSessionLayout(reordered),
      );
    });
  }, []);

  const handleReorderSession = useCallback((sourceSessionId: string, targetSessionId: string, position: "before" | "after" = "before") => {
    if (!sourceSessionId || !targetSessionId || sourceSessionId === targetSessionId) return;

    setSessionsSync((prev) => {
      const source = prev.find((session) => session.id === sourceSessionId);
      const target = prev.find((session) => session.id === targetSessionId);
      if (!source || !target || source.projectId !== target.projectId) return prev;

      const projectId = source.projectId;
      const sorted = sortProjectSessionsForSidebar(prev, projectId);
      const sourceIndex = sorted.findIndex((session) => session.id === sourceSessionId);
      const targetIndex = sorted.findIndex((session) => session.id === targetSessionId);
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return prev;

      const moving = { ...sorted[sourceIndex], pinned: Boolean(sorted[targetIndex].pinned) };
      const remaining = sorted.filter((session) => session.id !== sourceSessionId);
      const targetIdx = remaining.findIndex((session) => session.id === targetSessionId);
      if (targetIdx < 0) return prev;
      const insertIndex = position === "after" ? targetIdx + 1 : targetIdx;

      const reordered = [...remaining];
      reordered.splice(insertIndex, 0, moving);

      return mergeProjectSessionLayout(
        prev,
        projectId,
        normalizeProjectSessionLayout(reordered),
      );
    });
  }, []);

  const dismissAutoRenameActivity = useCallback(() => {
    setAutoRenameActivity(null);
  }, []);

  const handleAgentInstruction = useCallback(async (instruction: string) => {
    if (autoRenamingSessions) return;
    const projectId = activeProjectIdRef.current;
    if (!projectId) return;

    const projectSessions = sessionsRef.current.filter(
      (session) => session.projectId === projectId && !session.closing,
    );
    if (projectSessions.length === 0) return;

    const projectTitle = projectByIdRef.current.get(projectId)?.title ?? null;
    const agentSettings = loadAgentSettings();
    const provider = agentSettings.provider === "codex" ? "codex" : "claude-code";
    const providerLabel = agentProviderLabel(provider);
    const prompt = buildSessionAgentPrompt(projectId, projectTitle, instruction);
    const taskLabel = instruction === "rename" ? "Renaming"
      : instruction === "reorder" ? "Reordering"
      : instruction === "rename-and-reorder" ? "Renaming & reordering"
      : "Running agent on";
    const launchSettings: AgentLaunchSettings = {
      provider,
      model: agentSettings.model,
      effort: agentSettings.effort,
      allowedTools: agentSettings.allowedTools,
    };

    if (!activityCenterOpen) {
      setActivityCenterAutoOpenSource("auto-rename");
      setActivityCenterOpen(true);
    }

    setAutoRenameActivity({
      projectId,
      providerLabel,
      status: "running",
      summary: `${taskLabel} ${projectSessions.length} session${projectSessions.length === 1 ? "" : "s"} with ${providerLabel}`,
      entries: [
        {
          id: makeId(),
          text: `${providerLabel} is inspecting the active project sessions`,
          tone: "info",
        },
      ],
    });
    setAutoRenamingSessions(true);

    try {
      await runBackgroundAgentPrompt(prompt, launchSettings, {
        onOutputLine: (line) => {
          const update = parseStreamLine(line);
          if (!update) return;
          const nextEntries = summarizeAutoRenameUpdate(update, sessionsRef.current);
          if (nextEntries.length === 0) return;
          setAutoRenameActivity((prev) => {
            if (!prev || prev.projectId !== projectId) return prev;
            return {
              ...prev,
              entries: [
                ...prev.entries,
                ...nextEntries.map((entry) => ({ id: makeId(), ...entry })),
              ].slice(-AUTO_RENAME_LOG_ENTRY_LIMIT),
            };
          });
        },
      });
      setAutoRenameActivity((prev) =>
        prev?.projectId === projectId ? null : prev,
      );
    } catch (err) {
      const message = formatError(err);
      setAutoRenameActivity((prev) => {
        if (!prev || prev.projectId !== projectId) return prev;
        return {
          ...prev,
          status: "error",
          summary: `${providerLabel} could not finish the rename run`,
          entries: [
            ...prev.entries.slice(-(AUTO_RENAME_LOG_ENTRY_LIMIT - 1)),
            { id: makeId(), text: message, tone: "error" },
          ],
        };
      });
      reportError(`Agent task failed with ${providerLabel}`, err);
    } finally {
      setAutoRenamingSessions(false);
    }
  }, [
    activityCenterOpen,
    autoRenamingSessions,
    reportError,
    runBackgroundAgentPrompt,
  ]);

  const handleRenameSession = useCallback((sessionId: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setSessionsSync((prev) => {
      const idx = prev.findIndex((s) => s.id === sessionId);
      if (idx < 0 || prev[idx].name === trimmed) return prev;
      const next = prev.slice();
      next[idx] = { ...prev[idx], name: trimmed };
      return next;
    });
    invoke("rename_session", { id: sessionId, name: trimmed }).catch(() => {});
  }, []);

  const handleSetSessionSymbol = useCallback((sessionId: string, symbol: string | null) => {
    const nextSymbol = normalizeTabSymbolValue(symbol);
    setSessionsSync((prev) => {
      const idx = prev.findIndex((s) => s.id === sessionId);
      if (idx < 0) return prev;
      const current = prev[idx].symbol ?? null;
      if (current === nextSymbol) return prev;
      urgentPersistenceRef.current = true;
      const next = prev.slice();
      next[idx] = { ...prev[idx], symbol: nextSymbol };
      return next;
    });
  }, []);

  const handleSetSessionColor = useCallback((sessionId: string, color: string | null) => {
    setSessionsSync((prev) => {
      const idx = prev.findIndex((s) => s.id === sessionId);
      if (idx < 0) return prev;
      const current = prev[idx].color ?? null;
      if (current === color) return prev;
      urgentPersistenceRef.current = true;
      const next = prev.slice();
      next[idx] = { ...prev[idx], color };
      return next;
    });
  }, []);

  const handleSplitSession = useCallback((sessionId: string, direction: "horizontal" | "vertical") => {
    const projectId = activeProjectIdRef.current;
    const primaryId = activeIdRef.current;
    if (!primaryId || primaryId === sessionId) return;

    const now = Date.now();
    const existingViews = splitViewsRef.current;
    const activeViewId = activeSplitViewIdRef.current;

    if (activeViewId) {
      const idx = existingViews.findIndex((v) => v.id === activeViewId);
      const view = idx >= 0 ? existingViews[idx] : null;
      if (view && view.projectId === projectId) {
        const keepId =
          primaryId === view.aId || primaryId === view.bId ? primaryId : view.lastFocusedId;
        if (keepId === sessionId) return;
        const next = existingViews.slice();
        next[idx] = {
          ...view,
          aId: keepId,
          bId: sessionId,
          direction,
          lastFocusedId: keepId,
        };
        setSplitViews(next);
        setActiveSplitViewId(view.id);
        setActiveId(keepId);
        return;
      }
    }

    const reusable =
      existingViews.find(
        (v) =>
          v.projectId === projectId &&
          v.direction === direction &&
          ((v.aId === primaryId && v.bId === sessionId) || (v.aId === sessionId && v.bId === primaryId)),
      ) ?? null;
    if (reusable) {
      setActiveSplitViewId(reusable.id);
      setActiveId(primaryId);
      return;
    }

    const id = makeId();
    setSplitViews([
      ...existingViews,
      {
        id,
        projectId,
        aId: primaryId,
        bId: sessionId,
        direction,
        ratio: 0.5,
        createdAt: now,
        lastFocusedId: primaryId,
      },
    ]);
    setActiveSplitViewId(id);
    setActiveId(primaryId);
  }, []);

  const handleUnsplit = useCallback(() => {
    setActiveSplitViewId(null);
  }, []);

  const handleSplitRatioChange = useCallback((ratio: number) => {
    const viewId = activeSplitViewIdRef.current;
    if (!viewId) return;
    const clamped = Math.max(0.15, Math.min(0.85, ratio));
    setSplitViews((prev) => {
      const idx = prev.findIndex((v) => v.id === viewId);
      if (idx < 0) return prev;
      if (prev[idx].ratio === clamped) return prev;
      const next = prev.slice();
      next[idx] = { ...prev[idx], ratio: clamped };
      return next;
    });
  }, []);

  const handleCloseSplitPane = useCallback((closedSessionId: string) => {
    const split = splitPaneRef.current;
    if (!split) return;
    // If closing the primary pane, make secondary the active session
    if (closedSessionId !== split.secondaryId) {
      setActiveId(split.secondaryId);
    }
    setActiveSplitViewId(null);
  }, []);

  const handleActivateSplitView = useCallback((viewId: string, focusSessionId?: string) => {
    const view = splitViewsRef.current.find((v) => v.id === viewId) ?? null;
    if (!view) return;
    const focus =
      focusSessionId && (focusSessionId === view.aId || focusSessionId === view.bId)
        ? focusSessionId
        : view.lastFocusedId;
    const resolvedFocus = focus === view.aId || focus === view.bId ? focus : view.aId;
    setActiveSplitViewId(viewId);
    setActiveId(resolvedFocus);
  }, []);

  const handleRemoveSplitView = useCallback((viewId: string) => {
    setSplitViews((prev) => prev.filter((v) => v.id !== viewId));
    setActiveSplitViewId((prev) => (prev === viewId ? null : prev));
  }, []);

  const handleSearchClose = useCallback((sessionId: string) => {
    const activeProjectId = activeProjectIdRef.current;
    const allSessions = sessionsRef.current;
    const activeId = activeIdRef.current;
    const activeSession = activeId ? allSessions.find((s) => s.id === activeId) ?? null : null;
    const inProject = allSessions.filter((s) => s.projectId === activeProjectId);
    const primaryId =
      (activeSession && activeSession.projectId === activeProjectId ? activeSession.id : null) ??
      inProject.find((s) => !s.closing)?.id ??
      inProject[0]?.id ??
      null;
    const split = splitPaneRef.current;
    const secondaryId = split?.secondaryId ?? null;
    const visibleTargets: string[] = [];
    if (primaryId) visibleTargets.push(primaryId);
    if (secondaryId && secondaryId !== primaryId) {
      const secondarySession = allSessions.find((s) => s.id === secondaryId) ?? null;
      if (secondarySession && secondarySession.projectId === activeProjectId) {
        visibleTargets.push(secondaryId);
      }
    }
    const targets = visibleTargets.includes(sessionId) ? visibleTargets : [sessionId];
    setTerminalSearchSessions((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of targets) {
        if (next.delete(id)) changed = true;
      }
      return changed ? next : prev;
    });
    for (const id of targets) {
      try { registry.current.get(id)?.search.clearDecorations(); } catch { /* ignore */ }
    }
    registry.current.get(targets[0])?.term.focus();
  }, []);

  const handleRenameProjectInline = useCallback((projectId: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setProjects((prev) => {
      const idx = prev.findIndex((p) => p.id === projectId);
      if (idx < 0) return prev;
      if (prev[idx].title === trimmed) return prev;
      const next = prev.slice();
      next[idx] = { ...prev[idx], title: trimmed };
      return next;
    });
  }, []);

  const handleSetProjectSymbol = useCallback((projectId: string, symbol: string | null) => {
    const nextSymbol = normalizeTabSymbolValue(symbol);
    setProjects((prev) => {
      const idx = prev.findIndex((p) => p.id === projectId);
      if (idx < 0) return prev;
      const current = prev[idx].symbol ?? null;
      if (current === nextSymbol) return prev;
      urgentPersistenceRef.current = true;
      const next = prev.slice();
      next[idx] = { ...prev[idx], symbol: nextSymbol };
      return next;
    });
  }, []);

  const handleSetProjectColor = useCallback((projectId: string, color: string | null) => {
    setProjects((prev) => {
      const idx = prev.findIndex((p) => p.id === projectId);
      if (idx < 0) return prev;
      const current = prev[idx].color ?? null;
      if (current === color) return prev;
      urgentPersistenceRef.current = true;
      const next = prev.slice();
      next[idx] = { ...prev[idx], color };
      return next;
    });
  }, []);


  const handleOpenNewSession = useCallback(() => {
    const project = projectByIdRef.current.get(activeProjectIdRef.current ?? "");
    if (isProjectSsh(project)) {
      void createSshSessionForProject(project!);
      return;
    }
    setProjectOpen(false);
    setNewOpen(true);
  }, []);

  // ⌘T and the palette's "New Session" open the unified flow (terminal /
  // shells / agents / SSH / custom command in one keyboard-first list).
  const handleOpenNewSessionFlow = useCallback(() => {
    setProjectOpen(false);
    setNewOpen(false);
    openDialog("newSessionFlow");
  }, []);

  const handleOpenPersistentSessions = useCallback(() => {
    setPersistentSessionsOpen(true);
    void refreshPersistentSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOpenSshManager = useCallback(() => {
    setProjectOpen(false);
    setNewOpen(false);
    setSshManagerOpen(true);
  }, []);

  const handleOpenAgentShortcuts = useCallback(() => setAgentShortcutsOpen(true), []);

  const handleDeleteProject = useCallback(() => setConfirmDeleteProjectOpen(true), []);

  // --- Project-targeted session creation (per-project "+" popover) ---

  const handleNewTerminalForProject = useCallback(
    (projectId: string) => {
      selectProject(projectId);
      const project = projectByIdRef.current.get(projectId);
      if (isProjectSsh(project)) {
        void createSshSessionForProject(project!);
        return;
      }
      setProjectOpen(false);
      setNewOpen(true);
    },
    [selectProject],
  );

  // Second button: prompt for which shell to open this terminal with.
  const handleNewTerminalWithShellForProject = useCallback(
    (projectId: string) => {
      selectProject(projectId);
      const project = projectByIdRef.current.get(projectId);
      // Shell choice doesn't apply to remote sessions; fall back to the normal flow.
      if (isProjectSsh(project)) {
        void createSshSessionForProject(project!);
        return;
      }
      setProjectOpen(false);
      void loadShells();
      setShellPicker({ projectId });
    },
    [selectProject, loadShells],
  );

  const handleNewSshForProject = useCallback(
    (projectId: string) => {
      selectProject(projectId);
      const project = projectByIdRef.current.get(projectId);
      if (project?.sshTarget) {
        void createSshSessionForProject(project);
        return;
      }
      setProjectOpen(false);
      setNewOpen(false);
      setSshManagerOpen(true);
    },
    [selectProject],
  );

  const handleQuickStartForProject = useCallback(
    (projectId: string, effect: ProcessEffect) => {
      selectProject(projectId);
      const project = projectByIdRef.current.get(projectId);
      // On an SSH project, run the agent ON the remote in the project's root dir
      // (the same place a new terminal session opens) instead of locally.
      if (isProjectSsh(project)) {
        void createSshAgentSessionForProject(project!, effect);
        return;
      }
      void quickStart(
        {
          id: effect.id,
          title: effect.label,
          command: effect.matchCommands[0] ?? effect.label,
        },
        projectId,
      );
    },
    [selectProject, quickStart],
  );

  const handleRequestDeleteProject = useCallback(
    (projectId: string) => {
      selectProject(projectId);
      setConfirmDeleteProjectOpen(true);
    },
    [selectProject],
  );

  const handleToggleSidebarCollapsed = useCallback(() => setSidebarCollapsed((prev) => !prev), []);

  // Selecting a session from the tree exits any in-pane split and focuses it
  // (switching the active project if the session lives in another project).
  const handleSelectSessionFromTree = useCallback(
    (sessionId: string) => {
      handleUnsplit();
      selectSessionById(sessionId);
    },
    [handleUnsplit, selectSessionById],
  );

  // --- Workspace tier handlers ---

  const handleSelectWorkspace = useCallback((workspaceId: string) => {
    setActiveWorkspaceId(workspaceId);
    // Keep the active project inside the chosen workspace.
    const map = projectWorkspaceRef.current;
    const currentActive = activeProjectIdRef.current;
    const inWorkspace = (id: string) => (map[id] ?? workspaceId) === workspaceId;
    if (!inWorkspace(currentActive)) {
      const first = projectsRef.current.find((p) => inWorkspace(p.id));
      if (first) selectProject(first.id);
    }
  }, [selectProject]);

  const handleCreateWorkspace = useCallback(() => {
    // window.prompt() is a no-op in Tauri's WKWebView, so create immediately
    // with an auto-incremented name; the sidebar drops it into inline rename.
    const id = makeId();
    setWorkspaces((prev) => {
      const names = new Set(prev.map((w) => w.name));
      let n = prev.length + 1;
      let name = `Workspace ${n}`;
      while (names.has(name)) {
        n += 1;
        name = `Workspace ${n}`;
      }
      return [...prev, { id, name }];
    });
    setActiveWorkspaceId(id);
  }, []);

  const handleRenameWorkspace = useCallback((workspaceId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setWorkspaces((prev) => prev.map((w) => (w.id === workspaceId ? { ...w, name: trimmed } : w)));
  }, []);

  const handleSetWorkspaceImage = useCallback((workspaceId: string, image: string | null) => {
    setWorkspaces((prev) => prev.map((w) => (w.id === workspaceId ? { ...w, iconImage: image } : w)));
  }, []);

  const handleDeleteWorkspace = useCallback(
    (workspaceId: string, options: WorkspaceDeleteOptions) => {
      const remaining = workspacesRef.current.filter((w) => w.id !== workspaceId);
      if (remaining.length === 0) return; // never delete the last workspace

      const map = projectWorkspaceRef.current;
      const wsProjectIds = projectsRef.current
        .filter((p) => (map[p.id] ?? activeWorkspaceIdRef.current) === workspaceId)
        .map((p) => p.id);
      const wsProjectIdSet = new Set(wsProjectIds);

      // Where does the active workspace land after deletion?
      const moveTarget =
        options.mode === "move" &&
        options.targetWorkspaceId &&
        remaining.some((w) => w.id === options.targetWorkspaceId)
          ? options.targetWorkspaceId
          : remaining[0].id;
      const nextActiveWorkspaceId = moveTarget;

      if (options.mode === "remove" && wsProjectIds.length > 0) {
        // Delete the projects entirely: drop their sessions + close the PTYs.
        const sessionIdsToClose = sessionsRef.current
          .filter((s) => wsProjectIdSet.has(s.projectId))
          .map((s) => s.id);
        for (const sid of sessionIdsToClose) removeSessionFromState(sid);
        for (const pid of wsProjectIds) lastActiveByProject.current.delete(pid);
        setActiveSessionByProject((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const pid of wsProjectIds) {
            if (pid in next) {
              delete next[pid];
              changed = true;
            }
          }
          return changed ? next : prev;
        });
        void Promise.all(sessionIdsToClose.map((id) => closeSession(id).catch(() => {})));

        setProjectWorkspace((m) => {
          const next = { ...m };
          for (const pid of wsProjectIds) delete next[pid];
          return next;
        });

        let nextProjects = projectsRef.current.filter((p) => !wsProjectIdSet.has(p.id));
        if (nextProjects.length === 0) {
          const fallback: Project = {
            id: makeId(),
            title: "Default",
            basePath: homeDirRef.current,
            environmentId: null,
            assetsEnabled: true,
          };
          nextProjects = [fallback];
          setProjects(nextProjects);
          setActiveProjectId(fallback.id);
          setActiveId(null);
        } else {
          setProjects(nextProjects);
          if (wsProjectIdSet.has(activeProjectIdRef.current)) {
            const np = nextProjects[0].id;
            setActiveProjectId(np);
            setActiveId(pickActiveSessionId(np));
          }
        }
      } else {
        // Move mode: reassign this workspace's projects to the target.
        setProjectWorkspace((m) => {
          const next = { ...m };
          for (const pid of wsProjectIds) next[pid] = moveTarget;
          return next;
        });
      }

      setWorkspaces(remaining);
      setActiveWorkspaceId((curr) => (curr === workspaceId ? nextActiveWorkspaceId : curr));
    },
    [],
  );

  const handleSendPromptToActive = useCallback(
    (prompt: Prompt) => void sendPromptToActive(prompt, "send"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const handleOpenPromptsPanel = useCallback(() => {
    setSlidePanelTab("prompts");
    setSlidePanelOpen(true);
  }, []);

  // -- Ref-stable split views for the active project (sidebar tree) --

  const projectSplitViewsRef = useRef<SplitView[]>([]);
  const stableProjectSplitViews = useMemo(() => {
    const next = splitViews.filter((v) => v.projectId === activeProjectId);
    const prev = projectSplitViewsRef.current;
    if (prev.length === next.length && prev.every((p, i) => p === next[i])) {
      return prev;
    }
    projectSplitViewsRef.current = next;
    return next;
  }, [activeProjectId, splitViews]);

  const handleToggleActivityCenter = useCallback(() => {
    setActivityCenterAutoOpenSource(null);
    setActivityCenterOpen((prev) => !prev);
  }, []);

  const handleOpenSettings = useCallback(() => {
    setActivityCenterOpen(false);
    setActivityCenterAutoOpenSource(null);
    openDialog("settings");
  }, []);

  const activityItems = useMemo<ActivityCenterItem[]>(() => {
    const items: ActivityCenterItem[] = [];
    const projectTitleById = new Map(
      projects.map((project) => [project.id, project.title?.trim?.() || project.title || "—"] as const),
    );

    const sessionActivityItems = sessions
      .flatMap((session): ActivityCenterItem[] => {
        const activity = getSessionActivityState(session, agentWorkingIds);
        if (!activity.isActive) return [];

        const details: string[] = [];
        const projectTitle = projectTitleById.get(session.projectId) ?? "—";
        if (projectTitle) details.push(`Project: ${projectTitle}`);
        if (session.disconnectReason?.trim()) details.push(session.disconnectReason.trim());
        if (session.cwd?.trim()) details.push(shortenPathSmart(session.cwd.trim(), 68));
        if (activity.command) details.push(truncateInlineText(activity.command, 96));

        const summaryParts: string[] = [];
        if (activity.isAgentWorking && activity.effect) {
          summaryParts.push(`${activity.effect.label} active`);
        }
        if (activity.isRecording) summaryParts.push("Recording");
        if (activity.isReconnecting) {
          const attempt = session.reconnectAttempt
            ? ` (${Math.min(session.reconnectAttempt, SSH_RECONNECT_MAX_ATTEMPTS)}/${SSH_RECONNECT_MAX_ATTEMPTS})`
            : "";
          summaryParts.push(`SSH reconnecting${attempt}`);
        }
        if (activity.isDisconnected) summaryParts.push("SSH disconnected");

        return [
          {
            id: `session-activity-${session.id}`,
            title: session.name,
            summary: summaryParts.join(" • "),
            tone: activity.isDisconnected ? "warning" : "info",
            running: activity.isActive,
            details,
            actionLabel: activity.isDisconnected ? "Reconnect" : undefined,
            onAction: activity.isDisconnected ? () => handleReconnectSession(session.id) : undefined,
          },
        ];
      })
      .sort((a, b) => {
        if (a.running !== b.running) return a.running ? -1 : 1;
        if (a.tone !== b.tone) return a.tone === "warning" ? -1 : 1;
        return a.title.localeCompare(b.title);
      });

    items.push(...sessionActivityItems);

    if (sessionRestoreProgress) {
      const completed = Math.max(0, sessionRestoreProgress.total - sessionRestoreProgress.remaining);
      items.push({
        id: "restore-sessions",
        title: "Restoring sessions",
        summary: `${completed}/${sessionRestoreProgress.total} restored`,
        tone: "info",
        running: true,
        details: [`${sessionRestoreProgress.remaining} remaining`],
      });
    }

    if (autoRenameActivity) {
      items.push({
        id: "auto-rename",
        title: `Auto-rename (${autoRenameActivity.providerLabel})`,
        summary: autoRenameActivity.summary,
        tone: autoRenameActivity.status === "error" ? "error" : "info",
        running: autoRenameActivity.status === "running",
        details: autoRenameActivity.entries.map((entry) => entry.text),
        onDismiss: autoRenameActivity.status === "error" ? dismissAutoRenameActivity : undefined,
      });
    }

    if (persistenceDisabledReason) {
      const isKeychainIssue =
        secureStorageMode === "keychain" &&
        /keychain|keyring/i.test(persistenceDisabledReason);
      items.push({
        id: "persistence-disabled",
        title: "Secure persistence paused",
        summary: persistenceDisabledReason,
        tone: "warning",
        actionLabel: isKeychainIssue ? (secureStorageRetrying ? "Retrying…" : "Retry") : undefined,
        onAction: isKeychainIssue ? () => retrySecureStorage() : undefined,
        actionDisabled: secureStorageRetrying,
        onDismiss: () => setPersistenceDisabledReason(null),
      });
    }

    if (screenCapturePermissionIssue) {
      items.push({
        id: "screen-capture-permission",
        title: "Screen Recording permission required",
        summary: "macOS blocked browser screenshot capture.",
        tone: "warning",
        details: [
          screenCapturePermissionIssue,
          "Enable Agents UI, or the terminal/editor that launched the dev app, then restart the app.",
        ],
        actionLabel: "Open Settings",
        onAction: () => openScreenRecordingSettings(),
        onDismiss: () => setScreenCapturePermissionIssue(null),
      });
    }

    if (error) {
      items.push({
        id: "app-error",
        title: "Error",
        summary: error,
        tone: "error",
        onDismiss: () => setError(null),
      });
    }

    return items;
  }, [
    autoRenameActivity,
    dismissAutoRenameActivity,
    error,
    screenCapturePermissionIssue,
    openScreenRecordingSettings,
    agentWorkingIds,
    handleReconnectSession,
    persistenceDisabledReason,
    projects,
    retrySecureStorage,
    secureStorageMode,
    secureStorageRetrying,
    sessionRestoreProgress,
    sessions,
  ]);
  const hasRunningActivityItems = useMemo(
    () => activityItems.some((item) => item.running),
    [activityItems],
  );
  // The running signal is inherently bursty: an agent session counts as
  // "working" while output flows and drops out after ~2s of silence, so it
  // toggles every few seconds during a normal agent run. Rendering the ⌘K
  // hint straight off it made the hint blink in and out of the topbar.
  // Hysteresis instead: hide as soon as activity starts, but only bring the
  // hint back once things have stayed quiet for a sustained stretch.
  const [showShortcutHint, setShowShortcutHint] = useState(true);
  useEffect(() => {
    if (hasRunningActivityItems) {
      setShowShortcutHint(false);
      return;
    }
    const timer = window.setTimeout(
      () => setShowShortcutHint(true),
      SHORTCUT_HINT_REAPPEAR_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [hasRunningActivityItems]);

  const sidebarJsx = useMemo(() => (
    <div className={`sidebar${sidebarCollapsed ? " sidebarCollapsed" : ""}`}>
      <WorkspaceSidebar
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onSelectWorkspace={handleSelectWorkspace}
        onCreateWorkspace={handleCreateWorkspace}
        onRenameWorkspace={handleRenameWorkspace}
        onSetWorkspaceImage={handleSetWorkspaceImage}
        onDeleteWorkspace={handleDeleteWorkspace}
        projects={workspaceProjects}
        activeProjectId={activeProjectId}
        activeSessionId={activeId}
        sessionsByProject={sessionsByProject}
        workingSessionIds={agentWorkingIds}
        agentShortcuts={agentShortcuts}
        onSelectProject={selectProject}
        onNewProject={openNewProject}
        onOpenProjectSettings={openProjectSettings}
        onRequestDeleteProject={handleRequestDeleteProject}
        onRenameProjectInline={handleRenameProjectInline}
        onMoveProject={moveProject}
        onSetProjectSymbol={handleSetProjectSymbol}
        onSetProjectColor={handleSetProjectColor}
        onSelectSession={handleSelectSessionFromTree}
        onCloseSession={handleCloseSession}
        onReconnectSession={handleReconnectSession}
        onReorderSession={handleReorderSession}
        onToggleSessionPin={handleToggleSessionPin}
        onRenameSession={handleRenameSession}
        onSetSessionSymbol={handleSetSessionSymbol}
        onSetSessionColor={handleSetSessionColor}
        onNewTerminalForProject={handleNewTerminalForProject}
        onNewTerminalWithShellForProject={handleNewTerminalWithShellForProject}
        onNewSshForProject={handleNewSshForProject}
        onQuickStartForProject={handleQuickStartForProject}
        onOpenPersistentSessions={handleOpenPersistentSessions}
        onOpenAgentShortcuts={handleOpenAgentShortcuts}
        onOpenSshManager={handleOpenSshManager}
        onAgentInstruction={handleAgentInstruction}
        agentInstructionRunning={
          autoRenamingSessions || autoRenameActivity?.status === "running"
        }
        splitViews={stableProjectSplitViews}
        activeSplitViewId={activeSplitViewId}
        splitPane={splitPane}
        onActivateSplitView={handleActivateSplitView}
        onRemoveSplitView={handleRemoveSplitView}
        onUnsplit={handleUnsplit}
        onSplitSession={handleSplitSession}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={handleToggleSidebarCollapsed}
      />

      {!sidebarCollapsed && (
        <QuickPromptsSection
          prompts={prompts}
          activeSessionId={activeId}
          onSendPrompt={handleSendPromptToActive}
          onEditPrompt={openPromptEditor}
          onOpenPromptsPanel={handleOpenPromptsPanel}
        />
      )}
    </div>
  ), [
    sidebarCollapsed, workspaces, activeWorkspaceId, workspaceProjects, sessionsByProject,
    activeProjectId, activeId, agentWorkingIds, agentShortcuts,
    prompts, stableProjectSplitViews, splitPane, activeSplitViewId,
    autoRenamingSessions, autoRenameActivity,
    handleSelectWorkspace, handleCreateWorkspace, handleRenameWorkspace, handleSetWorkspaceImage, handleDeleteWorkspace,
    selectProject, openNewProject, openProjectSettings, handleRequestDeleteProject,
    handleRenameProjectInline, moveProject, handleSetProjectSymbol, handleSetProjectColor,
    handleSelectSessionFromTree, handleCloseSession, handleReconnectSession, handleReorderSession,
    handleToggleSessionPin, handleRenameSession, handleSetSessionSymbol, handleSetSessionColor,
    handleNewTerminalForProject, handleNewSshForProject, handleQuickStartForProject,
    handleOpenPersistentSessions, handleOpenAgentShortcuts, handleOpenSshManager,
    handleAgentInstruction, handleActivateSplitView, handleRemoveSplitView, handleUnsplit,
    handleSplitSession, handleToggleSidebarCollapsed,
    handleSendPromptToActive, openPromptEditor, handleOpenPromptsPanel,
  ]);

  const topbarJsx = useMemo(() => (
    <div className="topbar">
      <div className="activeTitle">
        <span className="activeTitleText">
          <span>{activeProject ? `Project: ${activeProject.title}` : "Project: —"}</span>
          <span>{active ? ` • ${active.name}` : " • No session"}</span>
        </span>
        {activeIsSsh ? (
          <span className="chip chip-ssh" title="SSH">
            <span className="chipLabel">ssh</span>
          </span>
        ) : null}
        <SystemHealthIndicator
          hydrated={hydrated}
          sessionId={activeHealthSessionId}
          isSsh={activeIsSsh}
          sshTarget={activeSshTarget}
          connectionState={activeHealthConnectionState}
        />
      </div>
      <div className="topbarRight">
        <ActivityCenter
          menuRef={activityCenterMenuRef}
          open={activityCenterOpen}
          items={activityItems}
          onToggle={handleToggleActivityCenter}
          onActionError={(item, err) => reportError(`Activity action failed: ${item.title}`, err)}
        />
        <button
          type="button"
          className={`iconBtn ${dialogs.settings ? "iconBtnActive" : ""}`}
          onClick={handleOpenSettings}
          title="Settings"
          aria-label="Settings"
        >
          <Icon name="settings" />
        </button>

        {showShortcutHint && (
          <div className="shortcutHint">
            <kbd>{"\u2318"}K</kbd> Quick Access
          </div>
        )}

        {active && (
          <>
            {!activeIsSsh ? (
              <>
                <div className="topbarExternalActions">
                  <button
                    className="iconBtn iconBtnText"
                    onClick={() => {
                      const cwd = active.cwd?.trim() ?? "";
                      if (!cwd) return;
                      void invoke("open_path_in_file_manager", { path: cwd }).catch((err) =>
                        reportError("Failed to open folder in Finder", err),
                      );
                    }}
                    disabled={!active.cwd}
                    title={active.cwd ? `Open in Finder — ${active.cwd}` : "Open in Finder"}
                  >
                    Open in Finder
                  </button>

                  <button
                    className="iconBtn iconBtnText"
                    onClick={() => {
                      const cwd = active.cwd?.trim() ?? "";
                      if (!cwd) return;
                      void invoke("open_path_in_vscode", { path: cwd }).catch((err) =>
                        reportError("Failed to open VS Code", err),
                      );
                    }}
                    disabled={!active.cwd}
                    title={active.cwd ? `Open in VS Code — ${active.cwd}` : "Open in VS Code"}
                  >
                    Open in VS Code
                  </button>
                </div>
              </>
            ) : null}

            <button
              className={`iconBtn ${activeWorkspaceView.fileExplorerOpen ? "iconBtnActive" : ""}`}
              onClick={() => {
                updateActiveWorkspaceView((prev) => {
                  if (prev.fileExplorerOpen) {
                    return { ...prev, fileExplorerOpen: false };
                  }
                  if (activeIsSsh) {
                    return { ...prev, fileExplorerOpen: true };
                  }
                  const root = (
                    prev.fileExplorerRootDir ??
                    prev.codeEditorRootDir ??
                    activeProject?.basePath ??
                    active?.cwd ??
                    ""
                  ).trim();
                  if (!root) return prev;
                  return {
                    ...prev,
                    fileExplorerOpen: true,
                    fileExplorerRootDir: prev.fileExplorerRootDir ?? root,
                  };
                });
              }}
              disabled={
                activeIsSsh
                  ? !activeWorkspaceView.fileExplorerOpen && !activeSshTarget
                  : !activeWorkspaceView.fileExplorerOpen &&
                    !(
                      activeWorkspaceView.fileExplorerRootDir ??
                      activeWorkspaceView.codeEditorRootDir ??
                      activeProject?.basePath ??
                      active?.cwd ??
                      ""
                    ).trim()
              }
              title={
                activeWorkspaceView.fileExplorerOpen
                  ? activeIsSsh
                    ? "Close remote file tree"
                    : "Close file tree"
                  : activeIsSsh
                    ? `Open remote file tree — ${activeSshTarget ?? "ssh"}`
                    : `Open file tree — ${
                        (
                          activeWorkspaceView.fileExplorerRootDir ??
                          activeWorkspaceView.codeEditorRootDir ??
                          activeProject?.basePath ??
                          active?.cwd ??
                          ""
                        ).trim() || "—"
                      }`
              }
            >
              <Icon name="folder" />
            </button>

            <button
              className="iconBtn"
              onClick={() => setWorkspaceFileSearchOpen(true)}
              disabled={!activeWorkspaceFileRoot}
              title={activeWorkspaceFileRoot ? "Open file (Ctrl/Cmd+P)" : "Open file"}
            >
              <Icon name="search" />
            </button>

            {/* Panels Button */}
            <button
              className={`iconBtn ${slidePanelOpen ? "iconBtnActive" : ""}`}
              onClick={() => {
                if (slidePanelOpen) {
                  setSlidePanelOpen(false);
                } else {
                  void refreshRecordings();
                  setSlidePanelOpen(true);
                }
              }}
              title={`${slidePanelOpen ? "Close" : "Open"} panels (\u2318\u21E7P / \u2318\u21E7R / \u2318\u21E7A)`}
            >
              <Icon name="panel" />
            </button>

            {/* Agent Panel Button */}
            <button
              className={`iconBtn ${agentPanelOpen ? "iconBtnActive" : ""}`}
              onClick={() => setAgentPanelOpen(prev => !prev)}
              title={`${agentPanelOpen ? "Close" : "Open"} Agent panel (\u2318\u21E7G)`}
            >
              <Icon name="wand" size={19} />
            </button>

          </>
        )}
      </div>
    </div>
  ), [
    active, activeProject, activeIsSsh, activeSshTarget, activeWorkspaceView, hydrated,
    activityCenterOpen, activityItems, slidePanelOpen, agentPanelOpen, dialogs.settings,
    uiTheme, autoCaffeinate, keepAwakeActive, showShortcutHint,
    handleToggleActivityCenter, handleOpenSettings, reportError,
    updateActiveWorkspaceView, refreshRecordings,
  ]);

  const workspaceRowJsx = useMemo(() => (
      <div
        ref={workspaceRowRef}
        className={`workspaceRow ${workspaceResizeMode ? "workspaceResizing" : ""}`}
        style={
          {
            "--workspaceEditorWidthPx": `${activeWorkspaceView.editorWidth}px`,
            "--workspaceFileTreeWidthPx": `${activeWorkspaceView.treeWidth}px`,
            "--workspaceAgentWidthPx": `${agentPanelWidth}px`,
          } as React.CSSProperties
        }
      >
        <div className="terminalPaneStack">
          <TerminalPane
            sessions={terminalPaneSessions}
            activeId={activeId}
            activeProjectId={activeProjectId}
            uiTheme={uiTheme}
            splitPane={splitPane}
            onSplitRatioChange={handleSplitRatioChange}
            onCloseSplitPane={handleCloseSplitPane}
            onCwdChange={onCwdChange}
            onCommandChange={onCommandChange}
            onSessionResize={onSessionResize}
            onSessionTransportError={onSessionTransportError}
            registry={registry}
            pendingData={pendingData}
            onRegistryChanged={handleTerminalRegistryChanged}
            searchOpenSessions={terminalSearchSessions}
            onSearchClose={handleSearchClose}
          />
          {/* Portal target for terminal-scoped overlays (welcome pane, session
              banner) so they center over the terminal, not the whole row. */}
          <div className="terminalOverlays" ref={terminalOverlayRef} />
        </div>

        {activeWorkspaceView.codeEditorOpen &&
        (
          activeWorkspaceView.codeEditorRootDir ??
          activeWorkspaceView.fileExplorerRootDir ??
          (!activeIsSsh ? activeProject?.basePath ?? active?.cwd ?? "" : "")
        ).trim() ? (
          <>
            <div
              className="workspaceResize"
              onMouseDown={beginWorkspaceResize("editor")}
              aria-hidden="true"
            />
            <PanelErrorBoundary label="File viewer">
            <React.Suspense
              fallback={
                <section className="codeEditorPanel" aria-label="Editor">
                  <div className="empty">Loading editor…</div>
                </section>
              }
            >
              <LazyCodeEditorPanel
                key={`code-editor:${activeWorkspaceKey}`}
                ref={codeEditorPanelRef}
                provider={activeIsSsh ? "ssh" : "local"}
                editorTheme={EDITOR_THEME_BY_UI_THEME[uiTheme]}
                sshTarget={activeIsSsh ? activeSshTarget : null}
                rootDir={
                  (
                    activeWorkspaceView.codeEditorRootDir ??
                    activeWorkspaceView.fileExplorerRootDir ??
                    (!activeIsSsh ? activeProject?.basePath ?? active?.cwd ?? "" : "")
                  ).trim()
                }
                openFileRequest={activeWorkspaceView.openFileRequest}
                openWorkspaceTabRequest={activeWorkspaceView.openWorkspaceTabRequest}
                persistedState={activeWorkspaceView.codeEditorPersistedState}
                fsEvent={activeWorkspaceView.codeEditorFsEvent}
                onPersistState={(state) =>
                  updateWorkspaceViewForKey(activeWorkspaceKey, activeProjectId, (prev) => ({
                    ...prev,
                    codeEditorPersistedState: state,
                  }))
                }
                onConsumeOpenFileRequest={() =>
                  updateWorkspaceViewForKey(activeWorkspaceKey, activeProjectId, (prev) => ({
                    ...prev,
                    openFileRequest: null,
                  }))
                }
                onConsumeOpenWorkspaceTabRequest={() =>
                  updateWorkspaceViewForKey(activeWorkspaceKey, activeProjectId, (prev) => ({
                    ...prev,
                    openWorkspaceTabRequest: null,
                  }))
                }
                onActiveFilePathChange={(path) =>
                  updateWorkspaceViewForKey(activeWorkspaceKey, activeProjectId, (prev) => {
                    if (prev.codeEditorActiveFilePath === path) return prev;
                    return { ...prev, codeEditorActiveFilePath: path };
                  })
                }
                onCloseEditor={closeCodeEditor}
              />
            </React.Suspense>
            </PanelErrorBoundary>
          </>
        ) : null}

        {activeWorkspaceView.fileExplorerOpen &&
        (
          activeWorkspaceView.fileExplorerRootDir ??
          activeWorkspaceView.codeEditorRootDir ??
          (!(activeIsSsh || isProjectSsh(activeProject)) ? activeProject?.basePath ?? active?.cwd ?? "" : activeProject?.sshRemotePath ?? "")
        ).trim() ? (
          <>
            <div
              className="workspaceResize"
              onMouseDown={beginWorkspaceResize("tree")}
              aria-hidden="true"
            />
            <PanelErrorBoundary label="File tree">
            <FileExplorerPanel
              key={`file-tree:${activeWorkspaceKey}`}
              isOpen
              provider={(activeIsSsh || isProjectSsh(activeProject)) ? "ssh" : "local"}
              sshTarget={(activeIsSsh || isProjectSsh(activeProject)) ? (activeSshTarget ?? activeProject?.sshTarget ?? null) : null}
              sshConnectionState={(activeIsSsh || isProjectSsh(activeProject)) ? (active?.connectionState ?? "connected") : undefined}
              rootDir={
                (
                  activeWorkspaceView.fileExplorerRootDir ??
                  activeWorkspaceView.codeEditorRootDir ??
                  (!(activeIsSsh || isProjectSsh(activeProject)) ? activeProject?.basePath ?? active?.cwd ?? "" : activeProject?.sshRemotePath ?? "")
                ).trim()
              }
              persistedState={activeWorkspaceView.fileExplorerPersistedState}
              activeFilePath={activeWorkspaceView.codeEditorActiveFilePath}
              onSelectFile={handleSelectWorkspaceFile}
              onOpenTerminalAtPath={handleOpenTerminalAtPath}
              onPersistState={(state) =>
                updateWorkspaceViewForKey(activeWorkspaceKey, activeProjectId, (prev) => ({
                  ...prev,
                  fileExplorerPersistedState: state,
                }))
              }
              onPathRenamed={handleRenameWorkspacePath}
              onPathDeleted={handleDeleteWorkspacePath}
              onClose={() =>
                updateWorkspaceViewForKey(activeWorkspaceKey, activeProjectId, (prev) => ({
                  ...prev,
                  fileExplorerOpen: false,
                }))
              }
            />
            </PanelErrorBoundary>
          </>
        ) : activeWorkspaceView.fileExplorerOpen && activeIsSsh ? (
          <>
            <div
              className="workspaceResize"
              onMouseDown={beginWorkspaceResize("tree")}
              aria-hidden="true"
            />
            <aside className="fileExplorerPanel" aria-label="Files">
              <div className="fileExplorerHeader">
                <div className="fileExplorerTitle">
                  <span>Files</span>
                  <span className="fileExplorerPath">remote</span>
                </div>
                <div className="fileExplorerActions">
                  <button
                    type="button"
                    className="btnSmall btnIcon"
                    onClick={() =>
                      updateWorkspaceViewForKey(activeWorkspaceKey, activeProjectId, (prev) => ({
                        ...prev,
                        fileExplorerOpen: false,
                      }))
                    }
                    title="Close"
                  >
                    <Icon name="close" />
                  </button>
                </div>
              </div>
              <div className="fileExplorerList" role="tree">
                <div className="fileExplorerRow fileExplorerMeta">
                  {activeSshTarget ? "Loading remote files…" : "Missing SSH target."}
                </div>
              </div>
            </aside>
          </>
        ) : null}

        {agentPanelOpen && (
          <>
            <div
              className="workspaceResize"
              onMouseDown={beginWorkspaceResize("agent")}
              aria-hidden="true"
            />
            <PanelErrorBoundary label="Agent panel">
            <React.Suspense
              fallback={
                <section className="agentPanel">
                  <div className="empty">Loading agent...</div>
                </section>
              }
            >
              <LazyAgentPanel
                onClose={() => setAgentPanelOpen(false)}
                projectBasePath={activeProject?.basePath || homeDirRef.current || undefined}
                onCreateTerminalSession={async (command) => {
                  try {
                    const cwd = activeProject?.basePath || homeDirRef.current || "";
                    const createdRaw = await createSession({
                      projectId: activeProjectId,
                      name: "Agent",
                      launchCommand: command,
                      cwd,
                      envVars: envVarsForProjectId(activeProjectId, projects, environments),
                      shellChoice: shellChoiceForProject(activeProject),
                    });
                    const s = applyPendingExit(createdRaw);
                    addSessionWithProjectSafeActivation(s);
                  } catch (err) {
                    reportError("Failed to create agent terminal", err);
                  }
                }}
                onCreateTaskSession={async (command, name) => {
                  const cwd = activeProject?.basePath || homeDirRef.current || "";
                  const createdRaw = await createSession({
                    projectId: activeProjectId,
                    name,
                    launchCommand: command,
                    cwd,
                    envVars: envVarsForProjectId(activeProjectId, projects, environments),
                    shellChoice: shellChoiceForProject(activeProject),
                  });
                  const s = applyPendingExit(createdRaw);
                  addSessionWithProjectSafeActivation(s);
                  return s.id;
                }}
                onActivateSession={(sessionId) => {
                  setActiveId(sessionId);
                }}
              />
            </React.Suspense>
            </PanelErrorBoundary>
          </>
        )}
      </div>
	  ), [
	    terminalPaneSessions, activeId, activeProjectId, splitPane, handleSplitRatioChange, handleCloseSplitPane,
	    terminalSearchSessions, handleTerminalRegistryChanged, handleSearchClose,
	    activeWorkspaceView, activeWorkspaceKey,
	    activeIsSsh, activeSshTarget, activeProject, active,
	    workspaceResizeMode, activeProjectId, agentPanelOpen, agentPanelWidth,
	    uiTheme,
	    onCwdChange, onCommandChange, onSessionResize, onSessionTransportError,
	    beginWorkspaceResize, updateWorkspaceViewForKey,
	    handleSelectWorkspaceFile, handleOpenTerminalAtPath,
	    handleRenameWorkspacePath, handleDeleteWorkspacePath, closeCodeEditor,
	    addSessionWithProjectSafeActivation, applyPendingExit, projects, environments, reportError,
	  ]);

  return (
    <div className="app">
      {sidebarJsx}

      <main className="main">
        {topbarJsx}

        <div className="terminalArea">
          {workspaceRowJsx}

          {terminalOverlayHost && createPortal(
            <>
          {active && (active.connectionState === "disconnected" || active.connectionState === "reconnecting") && !active.closing && (
            <div className={`sessionBanner${active.connectionState === "reconnecting" ? " reconnecting" : ""}`} role="status">
              <span className="sessionBannerText">
                {active.connectionState === "reconnecting"
                  ? `Reconnecting${active.reconnectAttempt ? ` (attempt ${active.reconnectAttempt})` : ""}…`
                  : active.disconnectReason?.trim() || "Session disconnected."}
              </span>
              {active.connectionState === "disconnected" && active.manualReconnectAvailable ? (
                <button
                  type="button"
                  className="btnSmall sessionBannerBtn"
                  onClick={() => handleReconnectSession(active.id)}
                >
                  Reconnect
                </button>
              ) : null}
              <button type="button" className="btnSmall sessionBannerBtn" onClick={() => void onClose(active.id)}>
                Close session
              </button>
            </div>
          )}

          {hydrated && !sessions.some((s) => s.projectId === activeProjectId) && (
            <WelcomePane
              projectTitle={activeProject?.title ?? null}
              isSshProject={isProjectSsh(activeProject)}
              agents={agentShortcutIds
                .map((id) => getProcessEffectById(id))
                .filter((e): e is NonNullable<typeof e> => Boolean(e))
                .slice(0, 4)
                .map((e) => ({ id: e.id, label: e.label, iconSrc: e.iconSrc ?? null }))}
              onNewTerminal={() => handleNewTerminalForProject(activeProjectId)}
              onNewTerminalWithShell={() => handleNewTerminalWithShellForProject(activeProjectId)}
              onStartAgent={(agentId) => {
                const effect = getProcessEffectById(agentId);
                if (effect) handleQuickStartForProject(activeProjectId, effect);
              }}
              onConnectSsh={() => handleNewSshForProject(activeProjectId)}
              onShowShortcuts={() => openDialog("shortcuts")}
            />
          )}
            </>,
            terminalOverlayHost,
          )}



          {newOpen && <NewSessionModal
            ref={newSessionModalRef}
            projectTitle={activeProject?.title ?? null}
            commandSuggestions={commandSuggestions}
            initialCwd={activeProject?.basePath ?? homeDirRef.current ?? ""}
            cwdPlaceholder={activeProject?.basePath ?? "~"}
            onBrowseCwd={(currentCwd) =>
              openPathPicker("session", currentCwd.trim() || activeProject?.basePath || null)
            }
            canUseProjectBase={Boolean(activeProject?.basePath)}
            projectBasePath={activeProject?.basePath ?? null}
            canUseCurrentTab={Boolean(active?.cwd)}
            currentTabCwd={active?.cwd ?? null}
            onClose={() => setNewOpen(false)}
            onSubmit={onNewSubmit}
          />}

          {dialogs.shortcuts && <ShortcutsModal onClose={() => closeDialog("shortcuts")} />}

          {dialogs.newSessionFlow && (() => {
            const pid = activeProjectId;
            const isSshProj = isProjectSsh(activeProject);
            const items: NewSessionFlowItem[] = [];
            if (isSshProj) {
              items.push({
                id: "terminal",
                group: "start",
                title: `Terminal — ssh ${activeProject?.sshTarget ?? ""}`,
                subtitle: "Connect to the project host",
                glyph: "ssh",
                onPick: () => handleNewTerminalForProject(pid),
              });
            } else {
              items.push({
                id: "terminal",
                group: "start",
                title: `Terminal — ${shellChoiceLabel(shellChoiceForProject(activeProject), detectedShells)}`,
                subtitle: activeProject?.basePath ?? undefined,
                glyph: "❯",
                onPick: () =>
                  void createTerminalWithShell(
                    pid,
                    shellChoiceForProject(activeProject) ?? { kind: "bundled-agsh" },
                  ),
              });
              items.push({
                id: "shell",
                group: "start",
                title: "Terminal with shell…",
                subtitle: "Pick agsh, Nushell, or an installed shell",
                glyph: "sh",
                onPick: () => handleNewTerminalWithShellForProject(pid),
              });
            }
            for (const preset of quickStarts.slice(0, 4)) {
              items.push({
                id: `agent-${preset.id}`,
                group: "agents",
                title: preset.title,
                subtitle: preset.command ?? undefined,
                iconSrc: preset.iconSrc,
                glyph: "ai",
                onPick: () => {
                  const effect = getProcessEffectById(preset.id);
                  if (effect) handleQuickStartForProject(pid, effect);
                },
              });
            }
            items.push({
              id: "ssh",
              group: "more",
              title: "SSH connection…",
              subtitle: "Connect to a host from ~/.ssh/config",
              glyph: "ssh",
              onPick: () => setSshManagerOpen(true),
            });
            if (!isSshProj) {
              items.push({
                id: "custom",
                group: "more",
                title: "Custom command…",
                subtitle: "Run a specific command in a new session",
                glyph: ">_",
                onPick: handleOpenNewSession,
              });
            }
            return (
              <NewSessionFlow
                projectTitle={activeProject?.title ?? null}
                items={items}
                onClose={() => closeDialog("newSessionFlow")}
              />
            );
          })()}

          {dialogs.settings && (
            <SettingsModal
              themes={[
                { id: "dawn", label: "Dawn" },
                { id: "sepia", label: "Sepia" },
                { id: "ember", label: "Ember" },
                { id: "slate", label: "Slate" },
                { id: "midnight", label: "Midnight" },
                { id: "cobalt", label: "Cobalt" },
                { id: "neon", label: "Neon" },
                { id: "forest", label: "Forest" },
                { id: "matrix", label: "Matrix" },
                { id: "synthwave", label: "Synthwave" },
                { id: "quantum", label: "Quantum" },
              ]}
              uiTheme={uiTheme}
              onSetTheme={(id) => setUiTheme(id as UiTheme)}
              autoCaffeinate={autoCaffeinate}
              keepAwakeActive={keepAwakeActive}
              onToggleAutoCaffeinate={() => setAutoCaffeinate((prev) => !prev)}
              appDefaultShell={appDefaultShell}
              onSetAppDefaultShell={setAppDefaultShell}
              shells={detectedShells}
              shellsLoading={shellsLoading}
              onLoadShells={() => void loadShells()}
              onOpenSecureStorage={() => {
                closeDialog("settings");
                openSecureStorageSettings();
              }}
              onOpenUpdates={() => {
                closeDialog("settings");
                setUpdatesOpen(true);
              }}
              onClose={() => closeDialog("settings")}
            />
          )}

          {shellPicker && (
            <ShellPickerModal
              projectTitle={
                projects.find((p) => p.id === shellPicker.projectId)?.title ?? null
              }
              shells={detectedShells}
              loading={shellsLoading}
              projectDefault={shellChoiceForProject(
                projects.find((p) => p.id === shellPicker.projectId),
              )}
              onRescan={() => void loadShells(true)}
              onClose={() => setShellPicker(null)}
              onPick={(choice) => {
                const pid = shellPicker.projectId;
                setShellPicker(null);
                void createTerminalWithShell(pid, choice);
              }}
            />
          )}

          {sshManagerOpen && <SshManagerModal
            hosts={sshHosts}
            hostsLoading={sshHostsLoading}
            hostsError={sshHostsError}
            history={sshHistory}
            onRefreshHosts={() => void refreshSshHosts()}
            onCopyToClipboard={(text) => void handleCopySshCommand(text)}
            onClose={() => setSshManagerOpen(false)}
            onConnect={onSshConnect}
            onHistoryConnect={onSshHistoryConnect}
            onHistoryRemove={removeSshHistoryEntry}
          />}

          {persistentSessionsOpen && <PersistentSessionsModal
            isOpen={persistentSessionsOpen}
            loading={persistentSessionsLoading}
            error={persistentSessionsError}
            sessions={persistentSessionItems}
            onClose={() => {
              if (confirmKillPersistentBusy) return;
              setPersistentSessionsOpen(false);
              setPersistentSessionsError(null);
            }}
            onRefresh={() => void refreshPersistentSessions()}
            onAttach={(persistId) => void attachPersistentSession(persistId)}
            onRequestKill={(persistId) => setConfirmKillPersistentId(persistId)}
          />}

          {agentShortcutsOpen && <AgentShortcutsModal
            isOpen={agentShortcutsOpen}
            agentShortcuts={agentShortcuts}
            onClose={() => setAgentShortcutsOpen(false)}
            onMoveUp={(id) => moveAgentShortcut(id, -1)}
            onMoveDown={(id) => moveAgentShortcut(id, 1)}
            onRemove={removeAgentShortcut}
            onAdd={addAgentShortcut}
            onResetDefaults={() =>
              setAgentShortcutIds(cleanAgentShortcutIds(DEFAULT_AGENT_SHORTCUT_IDS))
            }
          />}

          {confirmKillPersistentId && <ConfirmActionModal
            isOpen={Boolean(confirmKillPersistentId)}
            title="Kill persistent session"
            message={
              <>
                Kill{" "}
                {confirmKillPersistentId ? `agents-ui-${confirmKillPersistentId.slice(0, 8)}…` : "this"}
                ? This will terminate any running shells/ssh inside the session.
              </>
            }
            confirmLabel="Kill"
            confirmDanger
            busy={confirmKillPersistentBusy}
            onClose={() => {
              if (confirmKillPersistentBusy) return;
              setConfirmKillPersistentId(null);
            }}
            onConfirm={() => void confirmKillPersistentSession()}
          />}

          {projectOpen && <ProjectModal
            ref={projectModalRef}
            mode={projectModalInitialRef.current.mode}
            initialTitle={projectModalInitialRef.current.title}
            initialBasePath={projectModalInitialRef.current.basePath}
            basePathPlaceholder={homeDirRef.current ?? "~"}
            initialEnvironmentId={projectModalInitialRef.current.environmentId}
            initialAssetsEnabled={projectModalInitialRef.current.assetsEnabled}
            initialSshTarget={projectModalInitialRef.current.sshTarget}
            initialSshRemotePath={projectModalInitialRef.current.sshRemotePath}
            initialDefaultShell={projectModalInitialRef.current.defaultShell}
            shells={detectedShells}
            shellsLoading={shellsLoading}
            onLoadShells={() => void loadShells()}
            sshHosts={sshHosts}
            sshHostsLoading={sshHostsLoading}
            onBrowseBasePath={(currentBasePath) =>
              openPathPicker("project", currentBasePath.trim() || activeProject?.basePath || null)
            }
            onBrowseRemotePath={(target, currentPath) => {
              sshPathPickerTargetRef.current = target;
              openPathPicker("ssh-remote", currentPath || null);
            }}
            canUseCurrentTab={Boolean(active?.cwd)}
            currentTabCwd={active?.cwd ?? null}
            canUseHome={Boolean(homeDirRef.current)}
            homeDir={homeDirRef.current}
            environments={environments}
            onOpenEnvironments={() => setEnvironmentsOpen(true)}
            onClose={() => setProjectOpen(false)}
            onSubmit={onProjectSubmit}
          />}

          {confirmDeleteProjectOpen && activeProject && <ConfirmActionModal
            isOpen={confirmDeleteProjectOpen && Boolean(activeProject)}
            title="Delete project"
            message={`Delete "${activeProject?.title ?? ""}"? All sessions in this project will be closed.`}
            confirmLabel="Delete"
            confirmDanger
            onClose={() => setConfirmDeleteProjectOpen(false)}
            onConfirm={() => {
              setConfirmDeleteProjectOpen(false);
              void deleteActiveProject();
            }}
          />}

          {confirmDeleteRecordingId && <ConfirmActionModal
            isOpen={Boolean(confirmDeleteRecordingId)}
            title="Delete recording"
            message={`Delete "${
              recordings.find((r) => r.recordingId === confirmDeleteRecordingId)?.meta?.name?.trim() ||
              confirmDeleteRecordingId
            }"? This cannot be undone.`}
            confirmLabel="Delete"
            confirmDanger
            onClose={() => setConfirmDeleteRecordingId(null)}
            onConfirm={() => {
              const id = confirmDeleteRecordingId;
              setConfirmDeleteRecordingId(null);
              if (id) void deleteRecording(id);
            }}
          />}

          {confirmDeletePromptId && <ConfirmActionModal
            isOpen={Boolean(confirmDeletePromptId)}
            title="Delete prompt"
            message={
              <>
                Delete{" "}
                {pendingDeletePrompt?.title?.trim() ? `"${pendingDeletePrompt.title.trim()}"` : "this prompt"}?
                {" "}This cannot be undone.
              </>
            }
            confirmLabel="Delete"
            confirmDanger
            onClose={() => setConfirmDeletePromptId(null)}
            onConfirm={confirmDeletePrompt}
          />}

          {confirmDeleteEnvironmentId && <ConfirmActionModal
            isOpen={Boolean(confirmDeleteEnvironmentId)}
            title="Delete environment"
            message={
              <>
                Delete{" "}
                {pendingDeleteEnvironment?.name?.trim()
                  ? `"${pendingDeleteEnvironment.name.trim()}"`
                  : "this environment"}
                ? Projects using it will fall back to no environment.
              </>
            }
            confirmLabel="Delete"
            confirmDanger
            onClose={() => setConfirmDeleteEnvironmentId(null)}
            onConfirm={confirmDeleteEnvironment}
          />}

          {confirmDeleteAssetId && <ConfirmActionModal
            isOpen={Boolean(confirmDeleteAssetId)}
            title="Delete template"
            message={
              <>
                Delete{" "}
                {pendingDeleteAsset?.name?.trim() ? `"${pendingDeleteAsset.name.trim()}"` : "this template"}?
                <br />
                Relative path: {pendingDeleteAsset?.relativePath ?? "—"}
              </>
            }
            confirmLabel="Delete"
            confirmDanger
            onClose={() => setConfirmDeleteAssetId(null)}
            onConfirm={confirmDeleteAsset}
          />}

          {applyAssetRequest && pendingApplyAsset && <ApplyAssetModal
            isOpen={Boolean(applyAssetRequest && pendingApplyAsset)}
            templateName={pendingApplyAsset?.name ?? ""}
            relativePath={pendingApplyAsset?.relativePath ?? ""}
            targetLabel={applyAssetRequest?.target === "project" ? "project base path" : "tab working directory"}
            targetDir={applyAssetRequest?.dir ?? ""}
            applying={applyAssetApplying}
            error={applyAssetError}
            onClose={closeApplyAssetModal}
            onApply={(overwrite) => void confirmApplyAsset(overwrite)}
          />}

          {pathPickerOpen && <PathPickerModal
            initialPath={pathPickerInitialPathRef.current}
            placeholder={pathPickerTarget === "ssh-remote" ? "~ (remote)" : (homeDirRef.current ?? "~")}
            loadDirectory={pathPickerTarget === "ssh-remote" ? loadRemoteDirectoryForPicker : loadDirectoryForPicker}
            onClose={() => {
              setPathPickerOpen(false);
              setPathPickerTarget(null);
              sshPathPickerTargetRef.current = null;
            }}
            onSelect={(selectedPath) => {
              if (pathPickerTarget === "project") projectModalRef.current?.setBasePath(selectedPath);
              if (pathPickerTarget === "session") newSessionModalRef.current?.setCwd(selectedPath);
              if (pathPickerTarget === "ssh-remote") projectModalRef.current?.setSshRemotePath(selectedPath);
              setPathPickerOpen(false);
              setPathPickerTarget(null);
              sshPathPickerTargetRef.current = null;
            }}
          />}

          {updatesOpen && <UpdateModal
            isOpen={updatesOpen}
            appName={appInfo?.name ?? "Agents UI"}
            currentVersion={appInfo?.version ?? null}
            updateSourceLabel={updateSourceLabel}
            checkUrl={updateCheckUrl}
            fallbackReleaseUrl={fallbackReleaseUrl}
            state={updateCheckState}
            onClose={() => setUpdatesOpen(false)}
            onCheck={() => void checkForUpdates()}
            onOpenRelease={(url) => void openExternal(url)}
          />}

          {secureStorageSettingsOpen && (
            <Modal
              top
              title="Secure storage"
              onClose={() => {
                if (secureStorageSettingsBusy) return;
                closeSecureStorageSettings();
              }}
            >
                {secureStorageSettingsError && (
                  <div className="pathPickerError" role="alert">
                    {secureStorageSettingsError}
                  </div>
                )}

                <div className="hint" style={{ marginTop: 0 }}>
                  Agents UI stores environment configs and recording inputs on disk. Choose whether to encrypt them on this Mac.
                </div>

                <div className="formRow">
                  <div className="label">Encryption</div>
                  <label className="checkRow">
                    <input
                      type="radio"
                      name="secureStorageMode"
                      checked={secureStorageSettingsMode === "keychain"}
                      onChange={() => setSecureStorageSettingsMode("keychain")}
                      disabled={secureStorageSettingsBusy}
                    />
                    Encrypt with macOS Keychain (recommended)
                  </label>
                  <div className="hint" style={{ marginTop: 0 }}>
                    Stores a master key in macOS Keychain; you may see 1–2 system prompts when enabling for the first time.
                  </div>

                  <label className="checkRow" style={{ marginTop: 10 }}>
                    <input
                      type="radio"
                      name="secureStorageMode"
                      checked={secureStorageSettingsMode === "plaintext"}
                      onChange={() => setSecureStorageSettingsMode("plaintext")}
                      disabled={secureStorageSettingsBusy}
                    />
                    Store unencrypted (no Keychain prompts)
                  </label>
                  <div className="hint" style={{ marginTop: 0 }}>
                    Environments and recordings are stored in plaintext in the app data directory. Anyone with access to your account can read them.
                  </div>
                </div>

                {secureStorageSettingsMode !== "keychain" &&
                  environments.some((e) => (e.content ?? "").trimStart().startsWith("enc:v1:")) && (
                    <div className="pathPickerError" role="alert">
                      Some environments are currently encrypted and will remain locked until Keychain encryption is enabled.
                    </div>
                  )}

                <div className="modalActions">
                  <button
                    type="button"
                    className="btn"
                    onClick={closeSecureStorageSettings}
                    disabled={secureStorageSettingsBusy}
                  >
                    {secureStorageMode === null ? "Not now" : "Cancel"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void applySecureStorageSettings()}
                    disabled={secureStorageSettingsBusy}
                  >
                    {secureStorageSettingsBusy ? "Working…" : secureStorageMode === null ? "Continue" : "Apply"}
                  </button>
                </div>
            </Modal>
          )}

          {recordPromptOpen && (
            <Modal title="Start recording" onClose={closeRecordPrompt}>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const name = recordPromptName.trim();
                    if (!recordPromptSessionId || !name) return;
                    void startRecording(recordPromptSessionId, name);
                    closeRecordPrompt();
                  }}
                >
                  <div className="formRow">
                    <div className="label">Name</div>
                    <input
                      ref={recordNameRef}
                      className="input"
                      value={recordPromptName}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(e) => setRecordPromptName(normalizeSmartQuotes(e.target.value))}
                      placeholder="e.g. Fix failing tests"
                    />
                    <div className="hint" style={{ marginTop: 0 }}>
                      Records only your input (may include secrets).{" "}
                      {secureStorageMode === "keychain"
                        ? "Stored encrypted at rest (key in macOS Keychain)."
                        : "Stored unencrypted on disk (secure storage disabled)."}
                    </div>
                  </div>
                  <div className="modalActions">
                    <button type="button" className="btn" onClick={closeRecordPrompt}>
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="btn"
                      disabled={!recordPromptSessionId || !recordPromptName.trim()}
                    >
                      Start
                    </button>
                  </div>
                </form>
            </Modal>
          )}

          {recordingsOpen && (
            <Modal title="Recordings" onClose={() => setRecordingsOpen(false)} className="recordingsModal">
                {recordingsError && (
                  <div className="pathPickerError" role="alert">
                    {recordingsError}
                  </div>
                )}

                <div className="recordingsList">
                  {recordingsLoading ? (
                    <div className="empty">Loading…</div>
                  ) : recordings.length === 0 ? (
                    <EmptyState
                      title="No recordings yet"
                      hint="Record a session to replay it later or share what happened."
                      action={
                        active
                          ? {
                              label: "Start recording",
                              onClick: () => {
                                setRecordingsOpen(false);
                                openRecordPrompt(active.id);
                              },
                            }
                          : undefined
                      }
                    />
                  ) : (
                    recordings.map((r) => {
                      const meta = r.meta;
                      const displayName = meta?.name?.trim() || r.recordingId;
                      const projectTitle =
                        (meta?.projectId
                          ? projects.find((p) => p.id === meta.projectId)?.title
                          : null) ?? "Unknown project";
                      const effectLabel = getProcessEffectById(meta?.effectId)?.label ?? null;
                      const when = meta?.createdAt ? new Date(meta.createdAt).toLocaleString() : null;
                      const cwd = meta?.cwd ? shortenPathSmart(meta.cwd, 52) : null;
                      return (
                        <div key={r.recordingId} className="recordingItem">
                          <div className="recordingMain">
                            <div className="recordingName" title={displayName}>
                              {displayName}
                            </div>
                            <div className="recordingMeta">
                              {[when, projectTitle, effectLabel, cwd].filter(Boolean).join(" • ")}
                            </div>
                          </div>
                          <div className="recordingActions">
                            <button
                              type="button"
                              className="btnSmall"
                              onClick={() => {
                                setRecordingsOpen(false);
                                void openReplay(r.recordingId, "step");
                              }}
                              title="View / replay"
                            >
                              Open
                            </button>
                            <button
                              type="button"
                              className="btnSmall"
                              onClick={() => {
                                setRecordingsOpen(false);
                                void openReplay(r.recordingId, "all");
                              }}
                              title="View all inputs"
                            >
                              View
                            </button>
	                            <button
	                              type="button"
	                              className="btnSmall btnDanger"
	                              onClick={() => requestDeleteRecording(r.recordingId)}
	                              title="Delete recording"
	                            >
	                              Delete
	                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                <div className="modalActions">
                  <button type="button" className="btn" onClick={() => setRecordingsOpen(false)}>
                    Close
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void refreshRecordings()}
                    disabled={recordingsLoading}
                  >
                    Refresh
                  </button>
                </div>
            </Modal>
          )}

          {promptsOpen && (
            <Modal title="Prompts" onClose={() => setPromptsOpen(false)} className="recordingsModal">
                <div className="recordingsList">
                  {prompts.length === 0 ? (
                    <EmptyState
                      title="No prompts yet"
                      hint="Save reusable prompts; pin your top five to send them with ⌘1–⌘5."
                      action={{ label: "New prompt", onClick: () => openPromptEditor() }}
                    />
                  ) : (
                    prompts
                      .slice()
                      .sort((a, b) => b.createdAt - a.createdAt)
                      .map((p) => {
                        const when = p.createdAt ? new Date(p.createdAt).toLocaleString() : null;
                        const firstLine =
                          p.content.trim().split(/\r?\n/)[0]?.slice(0, 80) ?? "";
                        return (
                          <div key={p.id} className="recordingItem">
                            <div className="recordingMain">
                              <div className="recordingName" title={p.title}>
                                {p.title}
                              </div>
                              <div className="recordingMeta">
                                {[when, firstLine].filter(Boolean).join(" • ")}
                              </div>
                            </div>
                            <div className="recordingActions">
                              <button
                                type="button"
                                className="btnSmall"
                                onClick={() => void sendPromptToActive(p, "paste")}
                                disabled={!active}
                                title={active ? "Paste into active session" : "No active session"}
                              >
                                Paste
                              </button>
                              <button
                                type="button"
                                className="btnSmall"
                                onClick={() => void sendPromptToActive(p, "send")}
                                disabled={!active}
                                title={active ? "Send (paste + Enter)" : "No active session"}
                              >
                                Send
                              </button>
                              <button
                                type="button"
                                className="btnSmall"
                                onClick={() => openPromptEditor(p)}
                                title="Edit prompt"
                              >
                                Edit
                              </button>
	                              <button
	                                type="button"
	                                className="btnSmall btnDanger"
	                                onClick={() => requestDeletePrompt(p.id)}
	                                title="Delete prompt"
	                              >
	                                Delete
	                              </button>
                            </div>
                          </div>
                        );
                      })
                  )}
                </div>

                <div className="modalActions">
                  <button type="button" className="btn" onClick={() => setPromptsOpen(false)}>
                    Close
                  </button>
                  <button type="button" className="btn" onClick={() => openPromptEditor()}>
                    New
                  </button>
                </div>
            </Modal>
          )}

          {promptEditorOpen && (
            <Modal
              title={promptEditorId ? "Edit prompt" : "New prompt"}
              onClose={closePromptEditor}
              className="recordingsModal"
            >
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    savePromptFromEditor();
                  }}
                >
                  <div className="formRow">
                    <div className="label">Title</div>
                    <input
                      ref={promptTitleRef}
                      className="input"
                      value={promptEditorTitle}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(e) => setPromptEditorTitle(normalizeSmartQuotes(e.target.value))}
                      placeholder="e.g. Write a test plan"
                    />
                  </div>
                  <div className="formRow">
                    <div className="label">Prompt</div>
                    <textarea
                      className="textarea"
                      value={promptEditorContent}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(e) => setPromptEditorContent(normalizeSmartQuotes(e.target.value))}
                      placeholder="Prompt text…"
                    />
                  </div>
                  <div className="modalActions">
                    <button type="button" className="btn" onClick={closePromptEditor}>
                      Cancel
                    </button>
                    <button type="submit" className="btn" disabled={!promptEditorTitle.trim()}>
                      Save
                    </button>
                  </div>
                </form>
            </Modal>
          )}

          {environmentsOpen && (
            <Modal title="Environments" onClose={() => setEnvironmentsOpen(false)} className="recordingsModal">
                <div className="recordingsList">
                  {environments.length === 0 ? (
                    <EmptyState
                      title="No environments yet"
                      hint="Define sets of environment variables to inject into a project's new sessions."
                      action={{ label: "New environment", onClick: () => openEnvironmentEditor() }}
                    />
                  ) : (
                    environments
                      .slice()
                      .sort((a, b) => b.createdAt - a.createdAt)
                      .map((env) => {
                        const when = env.createdAt ? new Date(env.createdAt).toLocaleString() : null;
                        const locked = Boolean((env.content ?? "").trimStart().startsWith("enc:v1:"));
                        const count = locked ? null : Object.keys(parseEnvContentToVars(env.content)).length;
                        return (
                          <div key={env.id} className="recordingItem">
                            <div className="recordingMain">
                              <div className="recordingName" title={env.name}>
                                {env.name}
                              </div>
                              <div className="recordingMeta">
                                {[when, locked ? "Encrypted" : `${count} vars`].filter(Boolean).join(" • ")}
                              </div>
                            </div>
                            <div className="recordingActions">
                              <button
                                type="button"
                                className="btnSmall"
                                onClick={() => openEnvironmentEditor(env)}
                                title="Edit environment"
                              >
                                Edit
                              </button>
	                              <button
	                                type="button"
	                                className="btnSmall btnDanger"
	                                onClick={() => requestDeleteEnvironment(env.id)}
	                                title="Delete environment"
	                              >
	                                Delete
	                              </button>
                            </div>
                          </div>
                        );
                      })
                  )}
                </div>

                <div className="modalActions">
                  <button type="button" className="btn" onClick={() => setEnvironmentsOpen(false)}>
                    Close
                  </button>
                  <button type="button" className="btn" onClick={() => openEnvironmentEditor()}>
                    New
                  </button>
                </div>
            </Modal>
          )}

          {environmentEditorOpen && (
            <Modal
              title={environmentEditorId ? "Edit environment" : "New environment"}
              onClose={closeEnvironmentEditor}
              className="recordingsModal"
            >
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    saveEnvironmentFromEditor();
                  }}
                >
                  <div className="formRow">
                    <div className="label">Name</div>
                    <input
                      ref={envNameRef}
                      className="input"
                      value={environmentEditorName}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(e) =>
                        setEnvironmentEditorName(normalizeSmartQuotes(e.target.value))
                      }
                      placeholder="e.g. staging"
                    />
                  </div>
                  <div className="formRow">
                    <div className="label">.env</div>
                    <textarea
                      className="textarea"
                      value={environmentEditorContent}
                      disabled={environmentEditorLocked}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(e) => setEnvironmentEditorContent(normalizeSmartQuotes(e.target.value))}
                      placeholder={
                        environmentEditorLocked
                          ? "Encrypted environment (locked)"
                          : "KEY=value\n# Comments supported"
                      }
                    />
                    <div className="hint" style={{ marginTop: 0 }}>
                      {environmentEditorLocked ? (
                        <>
                          This environment is encrypted and locked. Enable macOS Keychain encryption to view/edit it.
                          <div style={{ marginTop: 8 }}>
                            <button
                              type="button"
                              className="btnSmall"
                              onClick={openSecureStorageSettings}
                            >
                              Secure storage…
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          Parsed like an <code>.env</code> file. Applied to new sessions in a project.{" "}
                          {secureStorageMode === "keychain"
                            ? "Stored encrypted at rest (key in macOS Keychain)."
                            : "Stored unencrypted on disk (secure storage disabled)."}
                        </>
                      )}
                    </div>
                  </div>
                  <div className="modalActions">
                    <button type="button" className="btn" onClick={closeEnvironmentEditor}>
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="btn"
                      disabled={environmentEditorLocked || !environmentEditorName.trim()}
                    >
                      Save
                    </button>
                  </div>
                </form>
            </Modal>
          )}

          {assetEditorOpen && (
            <Modal
              title={assetEditorId ? "Edit asset" : "New asset"}
              onClose={closeAssetEditor}
              className="recordingsModal"
            >
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    saveAssetFromEditor();
                  }}
                >
                  <div className="formRow">
                    <div className="label">Name</div>
                    <input
                      ref={assetNameRef}
                      className="input"
                      value={assetEditorName}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(e) => setAssetEditorName(normalizeSmartQuotes(e.target.value))}
                      placeholder="e.g. AGENTS.md"
                    />
                  </div>
                  <div className="formRow">
                    <div className="label">Relative path</div>
                    <input
                      className="input"
                      value={assetEditorPath}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(e) => setAssetEditorPath(normalizeSmartQuotes(e.target.value))}
                      placeholder="e.g. AGENTS.md or .github/ISSUE_TEMPLATE.md"
                    />
                    <div className="hint" style={{ marginTop: 0 }}>
                      Written relative to the session/project directory.
                    </div>
                  </div>
                  <div className="formRow" style={{ marginBottom: 0 }}>
                    <div className="label">Auto-create</div>
                    <label className="checkRow">
                      <input
                        type="checkbox"
                        checked={assetEditorAutoApply}
                        onChange={(e) => setAssetEditorAutoApply(e.target.checked)}
                      />
                      Create on new sessions
                    </label>
                  </div>
                  <div className="formRow">
                    <div className="label">Content</div>
                    <textarea
                      className="textarea"
                      value={assetEditorContent}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(e) => setAssetEditorContent(normalizeSmartQuotes(e.target.value))}
                      placeholder="File contents…"
                    />
                  </div>
                  <div className="modalActions">
                    <button type="button" className="btn" onClick={closeAssetEditor}>
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="btn"
                      disabled={!assetEditorName.trim() || !assetEditorPath.trim()}
                    >
                      Save
                    </button>
                  </div>
                </form>
            </Modal>
          )}

          {replayOpen && (
            <Modal title="Replay recording" onClose={closeReplayModal} className="recordingsModal">
                {replayError && (
                  <div className="pathPickerError" role="alert">
                    {replayError}
                  </div>
                )}

                {replayLoading ? (
                  <div className="empty">Loading…</div>
                ) : replayRecording ? (
                  <>
                    <div className="hint" style={{ marginTop: 0 }}>
                      {(() => {
                        const parts: string[] = [];
                        parts.push(
                          replayRecording.meta?.cwd
                            ? `CWD: ${shortenPathSmart(replayRecording.meta.cwd, 64)}`
                            : "CWD: —",
                        );
                        if (replayRecording.meta?.name?.trim()) {
                          parts.push(`Name: ${replayRecording.meta.name.trim()}`);
                        }
                        const boot =
                          replayRecording.meta?.bootstrapCommand?.trim() ||
                          getProcessEffectById(replayRecording.meta?.effectId)?.matchCommands?.[0] ||
                          null;
                        if (boot) parts.push(`Boot: ${boot}`);
                        parts.push(`${replayIndex}/${replaySteps.length} steps sent`);
                        return parts.join(" • ");
                      })()}
                    </div>

                    <div className="formRow" style={{ marginBottom: 0 }}>
                      <div className="label">{replayShowAll ? "Flow" : "Next input"}</div>
                      <div className={`replayPreview ${replayShowAll ? "replayPreviewFlow" : ""}`}>
                        {replayShowAll ? (
                          <div className="replayFlow">
                            {replayFlow.length === 0 ? (
                              <div className="empty">No inputs recorded.</div>
                            ) : (
                              replayFlow.map((group) => {
                                const hasNext =
                                  replayIndex < replaySteps.length &&
                                  replayIndex >= group.startIndex &&
                                  replayIndex <= group.endIndex;
                                const expanded =
                                  replayFlowExpanded[group.key] ??
                                  group.items.length <= 3;
                                const range =
                                  group.startIndex === group.endIndex
                                    ? `#${group.startIndex + 1}`
                                    : `#${group.startIndex + 1}\u2013${group.endIndex + 1}`;
                                const headerPreview = (() => {
                                  if (!hasNext) return group.preview;
                                  const nextItem = group.items.find((it) => it.index === replayIndex);
                                  const text = nextItem?.text?.trim() ?? "";
                                  return text ? text : group.preview;
                                })();
                                return (
                                  <div
                                    key={group.key}
                                    className={`replayFlowGroup ${hasNext ? "replayFlowGroupNext" : ""}`}
                                  >
                                    <button
                                      type="button"
                                      className="replayFlowGroupHeader"
                                      onClick={() =>
                                        setReplayFlowExpanded((prev) => ({
                                          ...prev,
                                          [group.key]: !expanded,
                                        }))
                                      }
                                      aria-expanded={expanded}
                                    >
                                      <span className="replayFlowCaret" aria-hidden="true">
                                        {expanded ? "\u25BE" : "\u25B8"}
                                      </span>
                                      <span className="replayFlowTime">{formatRecordingT(group.t)}</span>
                                      <span className="replayFlowRange">{range}</span>
                                      {group.items.length > 1 ? (
                                        <span className={`replayFlowCount ${hasNext ? "replayFlowCountNext" : ""}`}>
                                          {hasNext ? "NEXT" : `${group.items.length} lines`}
                                        </span>
                                      ) : null}
                                      <span className="replayFlowPreview" title={headerPreview}>
                                        {headerPreview}
                                      </span>
                                    </button>

                                    {expanded ? (
                                      <div className="replayFlowItems">
                                        {group.items.map((it, idx) => {
                                          const marker =
                                            idx === group.items.length - 1 ? "\u2514\u2500" : "\u251C\u2500";
                                          const display = it.text.length ? it.text : "\u23CE";
                                          const isSent = it.index < replayIndex;
                                          const isNext = it.index === replayIndex && replayIndex < replaySteps.length;
                                          return (
                                            <div
                                              key={it.index}
                                              ref={(el) => {
                                                if (isNext) replayNextItemRef.current = el;
                                              }}
                                              className={`replayFlowItem ${isSent ? "replayFlowItemSent" : ""} ${
                                                isNext ? "replayFlowItemNext" : ""
                                              }`}
                                              aria-current={isNext ? "step" : undefined}
                                            >
                                              <span className="replayFlowItemMarker" aria-hidden="true">
                                                {marker}
                                              </span>
                                              <span className="replayFlowItemIndex">
                                                {it.index + 1}
                                                {isNext ? <span className="replayFlowNextBadge">next</span> : null}
                                              </span>
                                              <pre className="replayFlowItemText">{display}</pre>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    ) : null}
                                  </div>
                                );
                              })
                            )}
                          </div>
                        ) : replaySteps[replayIndex] ? (
                          replaySteps[replayIndex]
                        ) : (
                          "Done."
                        )}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="empty">No recording loaded.</div>
                )}

                <div className="modalActions">
                  <button type="button" className="btn" onClick={closeReplayModal}>
                    Close
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setReplayShowAll((v) => !v)}
                    disabled={replayLoading || Boolean(replayError) || !replayRecording}
                  >
                    {replayShowAll ? "View next" : "View flow"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void sendNextReplayStep()}
                    disabled={
                      replayLoading ||
                      Boolean(replayError) ||
                      replayIndex >= replaySteps.length
                    }
                    title="Creates a new replay tab if needed"
                  >
                    Send next
                  </button>
                </div>
            </Modal>
          )}

          {/* Slide Panel */}
          {slidePanelOpen && <SlidePanel
            isOpen={slidePanelOpen}
            onClose={() => setSlidePanelOpen(false)}
            activeTab={slidePanelTab}
            onTabChange={(tab) => {
              setSlidePanelTab(tab);
              if (tab === "recordings") void refreshRecordings();
            }}
            width={slidePanelWidth}
            onWidthChange={setSlidePanelWidth}
          >
            {slidePanelTab === "prompts" ? (
              <>
                {/* Prompts Search */}
                <div className="panelSearch">
                  <span className="panelSearchIcon" aria-hidden="true">
                    <Icon name="search" size={14} />
                  </span>
                  <input
                    className="panelSearchInput"
                    type="text"
                    placeholder="Search prompts..."
                    value={promptSearch}
                    onChange={(e) => setPromptSearch(e.target.value)}
                  />
                </div>

                {/* Pinned Prompts */}
                {(() => {
                  const pinnedPrompts = prompts
                    .filter(p => p.pinned)
                    .filter(p => !promptSearch || p.title.toLowerCase().includes(promptSearch.toLowerCase()))
                    .sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0));
                  if (pinnedPrompts.length === 0) return null;
                  return (
                    <div className="panelSection">
                      <div className="panelSectionTitle">Pinned</div>
                      <div className="panelList">
                        {pinnedPrompts.map((p) => (
                          <div key={p.id} className="panelCard">
                            <div className="panelCardHeader">
                              <span className="panelCardPin">{"\u2605"}</span>
                              <span className="panelCardTitle">{p.title}</span>
                            </div>
                            <div className="panelCardPreview">{p.content.slice(0, 100)}</div>
                            <div className="panelCardActions">
                              <button className="panelCardBtn" onClick={() => void sendPromptToActive(p, "paste")} disabled={!activeId}>Paste</button>
                              <button className="panelCardBtn" onClick={() => void sendPromptToActive(p, "send")} disabled={!activeId}>Send</button>
                              <button className="panelCardBtn" onClick={() => openPromptEditor(p)}>Edit</button>
                              <button className="panelCardBtn" onClick={() => togglePromptPin(p.id)}>Unpin</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* All Prompts */}
                <div className="panelSection">
                  <div className="panelSectionTitle">All Prompts</div>
                  <div className="panelList">
                    {prompts
                      .filter(p => !p.pinned)
                      .filter(p => !promptSearch || p.title.toLowerCase().includes(promptSearch.toLowerCase()))
                      .sort((a, b) => b.createdAt - a.createdAt)
                      .map((p) => (
                        <div key={p.id} className="panelCard">
                          <div className="panelCardHeader">
                            <span className="panelCardTitle">{p.title}</span>
                          </div>
                          <div className="panelCardMeta">{formatTimeAgo(p.createdAt)}</div>
                          <div className="panelCardPreview">{p.content.slice(0, 100)}</div>
                          <div className="panelCardActions">
                            <button className="panelCardBtn" onClick={() => void sendPromptToActive(p, "paste")} disabled={!activeId}>Paste</button>
                            <button className="panelCardBtn" onClick={() => void sendPromptToActive(p, "send")} disabled={!activeId}>Send</button>
                            <button className="panelCardBtn" onClick={() => openPromptEditor(p)}>Edit</button>
                            <button className="panelCardBtn" onClick={() => togglePromptPin(p.id)}>Pin</button>
                          </div>
                        </div>
                      ))}
                    {prompts.filter(p => !p.pinned).length === 0 && (
                      <EmptyState compact title="No prompts yet" hint="Create one with “New Prompt” below." />
                    )}
                  </div>
                </div>

                {/* New Prompt Footer */}
                <div className="panelFooter">
                  <button className="panelFooterBtn" onClick={() => openPromptEditor()}>
                    + New Prompt
                  </button>
                </div>
              </>
            ) : slidePanelTab === "recordings" ? (
              <>
                {/* Recordings Search */}
                <div className="panelSearch">
                  <span className="panelSearchIcon" aria-hidden="true">
                    <Icon name="search" size={14} />
                  </span>
                  <input
                    className="panelSearchInput"
                    type="text"
                    placeholder="Search recordings..."
                    value={recordingSearch}
                    onChange={(e) => setRecordingSearch(e.target.value)}
                  />
                </div>

                {/* Recordings List */}
                <div className="panelList">
                  {recordingsLoading ? (
                    <div className="panelCardMeta" style={{ textAlign: "center", padding: "16px" }}>
                      Loading...
                    </div>
                  ) : (
                    (() => {
                      const filteredRecordings = recordings.filter(r => {
                        if (!recordingSearch) return true;
                        const name = r.meta?.name || r.recordingId;
                        return name.toLowerCase().includes(recordingSearch.toLowerCase());
                      });

                      // Group by date
                      const today = new Date();
                      const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
                      const yesterdayStart = todayStart - 86400000;
                      const weekStart = todayStart - 7 * 86400000;

                      const groups: { label: string; items: typeof recordings }[] = [];
                      const todayItems = filteredRecordings.filter(r => (r.meta?.createdAt ?? 0) >= todayStart);
                      const yesterdayItems = filteredRecordings.filter(r => {
                        const t = r.meta?.createdAt ?? 0;
                        return t >= yesterdayStart && t < todayStart;
                      });
                      const weekItems = filteredRecordings.filter(r => {
                        const t = r.meta?.createdAt ?? 0;
                        return t >= weekStart && t < yesterdayStart;
                      });
                      const olderItems = filteredRecordings.filter(r => (r.meta?.createdAt ?? 0) < weekStart);

                      if (todayItems.length) groups.push({ label: "Today", items: todayItems });
                      if (yesterdayItems.length) groups.push({ label: "Yesterday", items: yesterdayItems });
                      if (weekItems.length) groups.push({ label: "This Week", items: weekItems });
                      if (olderItems.length) groups.push({ label: "Older", items: olderItems });

                      if (groups.length === 0) {
                        return (
                          <EmptyState
                            compact
                            title="No recordings yet"
                            hint="Use “Record Session” below to capture the active terminal."
                          />
                        );
                      }

                      return groups.map(group => (
                        <div key={group.label} className="panelSection">
                          <div className="dateGroupHeader">{group.label}</div>
                          {group.items.map((r) => {
                            const meta = r.meta;
                            const displayName = meta?.name || r.recordingId.slice(0, 12);
                            const effect = meta?.effectId ? getProcessEffectById(meta.effectId) : null;
                            return (
                              <div key={r.recordingId} className="panelCard">
                                <div className="panelCardHeader">
                                  <span className="panelCardTitle">{displayName}</span>
                                </div>
                                <div className="panelCardMeta">
                                  {[
                                    effect?.label,
                                    meta?.cwd ? shortenPathSmart(meta.cwd, 30) : null,
                                  ].filter(Boolean).join(" • ")}
                                </div>
                                <div className="panelCardActions">
                                  <button className="panelCardBtn" onClick={() => void openReplay(r.recordingId, "step")}>Replay</button>
                                  <button className="panelCardBtn" onClick={() => void openReplay(r.recordingId, "all")}>View</button>
	                                  <button className="panelCardBtn panelCardBtnDanger" onClick={() => requestDeleteRecording(r.recordingId)}>Delete</button>
	                                </div>
	                              </div>
	                            );
	                          })}
                        </div>
                      ));
                    })()
                  )}
                </div>

                {/* Recording Actions */}
                <div className="panelFooter">
                  {active && (
                    <button
                      className={`panelFooterBtn ${active.recordingActive ? "panelFooterBtnDanger" : ""}`}
                      onClick={() =>
                        active.recordingActive ? void stopRecording(active.id) : openRecordPrompt(active.id)
                      }
                      disabled={Boolean(active.exited || active.closing || active.connectionState === "reconnecting" || active.connectionState === "disconnected")}
                    >
                      {active.recordingActive ? "Stop Recording" : "Record Session"}
                    </button>
                  )}
                  {active?.lastRecordingId && (
                    <button
                      className="panelFooterBtn"
                      onClick={() => void openReplayForActive()}
                    >
                      Replay Last
                    </button>
                  )}
                  <button className="panelFooterBtn" onClick={() => void refreshRecordings()}>
                    Refresh
                  </button>
                </div>
              </>
            ) : slidePanelTab === "timeline" ? (
              <SessionTimeline
                term={activeId ? registry.current.get(activeId)?.term ?? null : null}
                shellInt={activeId ? registry.current.get(activeId)?.shellInt ?? null : null}
                sessionName={active?.name ?? null}
                onCopyOutput={(text) => {
                  void navigator.clipboard
                    .writeText(text)
                    .then(() => showToast({ tone: "success", message: "Output copied." }))
                    .catch(() => showToast({ tone: "error", message: "Could not copy output." }));
                }}
              />
            ) : (
              <>
                {/* Assets Search */}
                <div className="panelSearch">
                  <span className="panelSearchIcon" aria-hidden="true">
                    <Icon name="search" size={14} />
                  </span>
                  <input
                    className="panelSearchInput"
                    type="text"
                    placeholder="Search assets..."
                    value={assetSearch}
                    onChange={(e) => setAssetSearch(e.target.value)}
                  />
                </div>

                {/* Auto-create Settings */}
                <div className="panelSection">
                  <div className="panelSectionTitle">Auto-create</div>
                  <div className="panelCard">
                    <div className="panelCardHeader">
                      <span className="panelCardTitle">Create missing files on new sessions</span>
                    </div>
                    <label className="checkRow">
                      <input
                        type="checkbox"
                        checked={assetSettings.autoApplyEnabled}
                        onChange={(e) =>
                          setAssetSettings((prev) => ({ ...prev, autoApplyEnabled: e.target.checked }))
                        }
                      />
                      Enabled
                    </label>
                    <div className="panelCardMeta">
                      Applies enabled templates to the session working directory (only if missing).
                    </div>
                    {activeProject?.assetsEnabled === false && (
                      <div className="panelCardMeta">
                        Disabled for this project in Project settings.
                      </div>
                    )}
                  </div>
                </div>

                {/* Templates */}
                <div className="panelSection">
                  <div className="panelSectionTitle">Templates</div>
                  <div className="panelList">
                    {(() => {
                      const q = assetSearch.trim().toLowerCase();
                      const filtered = assets
                        .filter((a) => {
                          if (!q) return true;
                          return (
                            a.name.toLowerCase().includes(q) ||
                            a.relativePath.toLowerCase().includes(q)
                          );
                        })
                        .sort((a, b) => b.createdAt - a.createdAt);

                      if (filtered.length === 0) {
                        return (
                          <EmptyState
                            compact
                            title="No templates yet"
                            hint="Templates are files auto-created in new sessions — add one with “New Template” below."
                          />
                        );
                      }

                      return filtered.map((a) => (
                        <div key={a.id} className="panelCard">
                          <div className="panelCardHeader">
                            <span className="panelCardTitle">{a.name}</span>
                          </div>
                          <div className="panelCardMeta">
                            {[a.relativePath, a.autoApply ?? true ? "Auto" : "Manual"].join(" • ")}
                          </div>
                          <div className="panelCardPreview">{a.content.slice(0, 140)}</div>
                          <div className="panelCardActions">
	                            <button
	                              className="panelCardBtn"
	                              onClick={() => {
	                                const dir = activeProject?.basePath ?? null;
	                                if (!dir) return;
	                                openApplyAssetModal("project", dir, a.id);
	                              }}
	                              disabled={!activeProject?.basePath}
	                              title={activeProject?.basePath ? "Apply to project base path" : "Project has no base path"}
	                            >
	                              To project
                            </button>
	                            <button
	                              className="panelCardBtn"
	                              onClick={() => {
	                                const dir = active?.cwd ?? null;
	                                if (!dir) return;
	                                openApplyAssetModal("tab", dir, a.id);
	                              }}
	                              disabled={!active?.cwd}
	                              title={active?.cwd ? "Apply to current tab working directory" : "No active tab cwd"}
	                            >
	                              To tab
                            </button>
                            <button className="panelCardBtn" onClick={() => openAssetEditor(a)}>
                              Edit
                            </button>
                            <button className="panelCardBtn" onClick={() => toggleAssetAutoApply(a.id)}>
                              {a.autoApply ?? true ? "Disable auto" : "Enable auto"}
                            </button>
	                            <button className="panelCardBtn panelCardBtnDanger" onClick={() => requestDeleteAsset(a.id)}>
	                              Delete
	                            </button>
                          </div>
                        </div>
                      ));
                    })()}
                  </div>
                </div>

                {/* New Asset Footer */}
                <div className="panelFooter">
                  <button className="panelFooterBtn" onClick={() => openAssetEditor()}>
                    + New Asset
                  </button>
                </div>
              </>
            )}
          </SlidePanel>}
        </div>

        {/* One bottom bar: session tabs (left, scrollable) + status (right). */}
        <div className="bottomBar">
            {(() => {
              // Session tab strip: the active project's sessions in the same
              // order as the sidebar — a real tab strip, not a recency list.
              // Tabs drag-reorder via the same handler the sidebar uses.
              const tabSessions = sortProjectSessionsForSidebar(sessions, activeProjectId).filter(
                (s) => !s.closing,
              );
              if (tabSessions.length === 0) return null;
              return (
                <div className="historyBar" role="tablist" aria-label="Sessions">
                  {tabSessions.map((s) => {
                    const sid = s.id;
                    const isActive = sid === activeId;
                    const isSsh = isSshCommandLine(s.launchCommand ?? s.restoreCommand ?? null);
                    const isPersistent = Boolean(s.persistent);
                    const isSshType = isSsh && !isPersistent;
                    const isDefaultType = !isPersistent && !isSshType;
                    const tabEffect =
                      getProcessEffectById(s.effectId) ??
                      detectProcessEffect({
                        command:
                          s.launchCommand ??
                          (s.restoreCommand?.trim() ? s.restoreCommand.trim() : null) ??
                          null,
                        name: s.name,
                      });
                    return (
                      <div
                        key={sid}
                        role="tab"
                        aria-selected={isActive}
                        className={`historyTab ${isActive ? "historyTabActive" : ""} ${
                          isSshType ? "sessionItemSsh" : ""
                        } ${isPersistent ? "sessionItemPersistent" : ""} ${
                          isDefaultType ? "sessionItemDefault" : ""
                        } ${s.color ? "sessionItemColored" : ""} ${
                          s.exited ? "sessionItemExited" : ""
                        } ${
                          tabDrop?.id === sid
                            ? tabDrop.position === "before"
                              ? "historyTabDropBefore"
                              : "historyTabDropAfter"
                            : ""
                        }`}
                        style={s.color ? { "--tab-color": s.color } as React.CSSProperties : undefined}
                        onClick={() => selectSessionById(sid)}
                        onAuxClick={(e) => {
                          if (e.button === 1) {
                            e.preventDefault();
                            void onClose(sid);
                          }
                        }}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData("text/x-session-id", sid);
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onDragOver={(e) => {
                          if (!e.dataTransfer.types.includes("text/x-session-id")) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                          const r = e.currentTarget.getBoundingClientRect();
                          const position = e.clientX < r.left + r.width / 2 ? "before" : "after";
                          setTabDrop((prev) =>
                            prev?.id === sid && prev.position === position ? prev : { id: sid, position },
                          );
                        }}
                        onDragLeave={() => setTabDrop((prev) => (prev?.id === sid ? null : prev))}
                        onDrop={(e) => {
                          const sourceId = e.dataTransfer.getData("text/x-session-id");
                          setTabDrop(null);
                          if (!sourceId || sourceId === sid) return;
                          e.preventDefault();
                          const r = e.currentTarget.getBoundingClientRect();
                          const position = e.clientX < r.left + r.width / 2 ? "before" : "after";
                          handleReorderSession(sourceId, sid, position);
                        }}
                        onDragEnd={() => setTabDrop(null)}
                        title={s.cwd ?? s.name}
                      >
                        {s.symbol ? (
                          <TabSymbolIcon symbol={s.symbol} />
                        ) : tabEffect?.iconSrc ? (
                          <span className={`agentBadge historyAgentBadge chip-${tabEffect.id}`} title={tabEffect.label}>
                            <img className="agentIcon" src={tabEffect.iconSrc} alt={tabEffect.label} />
                          </span>
                        ) : null}
                        <span className="historyTabName">{s.name}</span>
                        <button
                          className="historyTabClose"
                          title="Close session"
                          onClick={(e) => {
                            e.stopPropagation();
                            void onClose(sid);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          <StatusBar
            shellLabel={
              active && !active.launchCommand && !activeIsSsh && !active.exited
                ? shellChoiceLabel(active.shellChoice ?? shellChoiceForProject(activeProject), detectedShells)
                : null
            }
            onShellClick={() => handleNewTerminalWithShellForProject(activeProjectId)}
            cwd={active?.cwd ? shortenPathSmart(active.cwd, 44) : null}
            sshTarget={activeIsSsh ? activeSshTarget : null}
            connectionState={active?.connectionState ?? null}
            recordingActive={Boolean(active?.recordingActive)}
            keepAwake={autoCaffeinate && keepAwakeActive}
            updateAvailable={updateCheckState.status === "updateAvailable"}
            onOpenUpdates={() => setUpdatesOpen(true)}
            version={appInfo?.version ?? null}
          />
        </div>
      </main>

      {/* Command Palette */}
      {commandPaletteOpen && <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        prompts={prompts}
        recordings={recordings}
        sessions={sessions}
        projects={projects}
        activeSessionId={activeId}
        activeProjectId={activeProjectId}
        quickStarts={quickStarts}
        onQuickStart={(preset) => void quickStart(preset)}
        onSendPrompt={(prompt, mode) => void sendPromptFromCommandPalette(prompt, mode)}
        onEditPrompt={openPromptEditor}
        onOpenRecording={(id, mode) => void openReplay(id, mode)}
        onSwitchSession={(sessionId) => {
          const s = sessions.find(x => x.id === sessionId);
          if (s && s.projectId !== activeProjectId) {
            setActiveProjectId(s.projectId);
          }
          setActiveId(sessionId);
        }}
        onSelectProject={setActiveProjectId}
        onNewSession={handleOpenNewSessionFlow}
        getTerminalText={getTerminalText}
        onOpenSshManager={() => {
          setProjectOpen(false);
          setNewOpen(false);
          setSshManagerOpen(true);
        }}
        onNewPrompt={() => openPromptEditor()}
        onStartRecording={() => activeId && openRecordPrompt(activeId)}
        onStopRecording={() => activeId && void stopRecording(activeId)}
        onOpenSecureStorageSettings={openSecureStorageSettings}
        isRecording={Boolean(active?.recordingActive)}
        onOpenPromptsPanel={() => {
          setSlidePanelTab("prompts");
          setSlidePanelOpen(true);
        }}
        onOpenRecordingsPanel={() => {
          void refreshRecordings();
          setSlidePanelTab("recordings");
          setSlidePanelOpen(true);
        }}
        extraActions={[
          {
            id: "settings",
            title: "Open Settings",
            subtitle: "Theme, default shell, power, keyboard, storage",
            run: handleOpenSettings,
          },
          {
            id: "shortcuts",
            title: "Keyboard Shortcuts",
            shortcut: "/",
            run: () => openDialog("shortcuts"),
          },
          {
            id: "terminal-with-shell",
            title: "Terminal with Shell…",
            subtitle: "Pick agsh, Nushell, or an installed shell for a one-off terminal",
            icon: "plus",
            run: () => handleNewTerminalWithShellForProject(activeProjectId),
          },
          {
            id: "new-project",
            title: "New Project",
            icon: "plus",
            run: openNewProject,
          },
          {
            id: "persistent-terminals",
            title: "Persistent Terminals",
            run: handleOpenPersistentSessions,
          },
          {
            id: "agent-shortcuts",
            title: "Agent Shortcuts…",
            run: () => setAgentShortcutsOpen(true),
          },
          {
            id: "check-updates",
            title: "Check for Updates",
            run: () => {
              setUpdatesOpen(true);
              void checkForUpdates();
            },
          },
          {
            id: "toggle-agent-panel",
            title: "Toggle Agent Panel",
            shortcut: "Shift+G",
            icon: "panel",
            run: () => setAgentPanelOpen((prev) => !prev),
          },
          {
            id: "session-timeline",
            title: "Session Timeline",
            subtitle: "Commands run in the active terminal, with exit status and duration",
            shortcut: "Shift+E",
            icon: "panel",
            run: () => {
              setSlidePanelTab("timeline");
              setSlidePanelOpen(true);
            },
          },
        ]}
        onOpenAssetsPanel={() => {
          setSlidePanelTab("assets");
          setSlidePanelOpen(true);
        }}
      />}
      <WorkspaceFileSearch
        isOpen={workspaceFileSearchOpen}
        provider={activeIsSsh ? "ssh" : "local"}
        rootDir={activeWorkspaceFileRoot}
        sshTarget={activeIsSsh ? activeSshTarget : null}
        onOpenFile={(path) => handleSelectWorkspaceFile(path, "auto")}
        onClose={() => setWorkspaceFileSearchOpen(false)}
      />
      <ToastHost />
    </div>
  );
}
