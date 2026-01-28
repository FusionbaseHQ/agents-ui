import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import React, { useEffect, useMemo, useRef, useState, useCallback, useLayoutEffect } from "react";
import SessionTerminal, { TerminalRegistry } from "./SessionTerminal";
import {
  commandTagFromCommandLine,
  detectProcessEffect,
  getProcessEffectById,
  PROCESS_EFFECTS,
} from "./processEffects";
import { shortenPathSmart } from "./pathDisplay";
import { SlidePanel } from "./SlidePanel";
import { CommandPalette } from "./CommandPalette";
import { ProjectsSection } from "./components/ProjectsSection";
import { QuickPromptsSection } from "./components/QuickPromptsSection";
import { SessionsSection } from "./components/SessionsSection";
import { Icon } from "./components/Icon";
import { FileExplorerPanel } from "./components/FileExplorerPanel";
import type {
  CodeEditorFsEvent,
  CodeEditorOpenFileRequest,
  CodeEditorPersistedState,
} from "./components/CodeEditorPanel";
import { AgentShortcutsModal } from "./components/AgentShortcutsModal";
import { NewSessionModal } from "./components/modals/NewSessionModal";
import {
  PersistentSessionsModal,
  type PersistentSessionsModalItem,
} from "./components/modals/PersistentSessionsModal";
import { ProjectModal } from "./components/modals/ProjectModal";
import { ConfirmDeleteProjectModal } from "./components/modals/ConfirmDeleteProjectModal";
import { ConfirmDeleteRecordingModal } from "./components/modals/ConfirmDeleteRecordingModal";
import { ApplyAssetModal } from "./components/modals/ApplyAssetModal";
import { ConfirmActionModal } from "./components/modals/ConfirmActionModal";
import { PathPickerModal } from "./components/modals/PathPickerModal";
import { UpdateModal, UpdateCheckState } from "./components/modals/UpdateModal";
import {
  SshManagerModal,
  type SshForward,
  type SshForwardType,
  type SshHostEntry,
} from "./components/modals/SshManagerModal";

const LazyCodeEditorPanel = React.lazy(() => import("./components/CodeEditorPanel"));

type Project = {
  id: string;
  title: string;
  basePath: string | null;
  environmentId: string | null;
  assetsEnabled?: boolean;
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
  launchCommand: string | null;
  restoreCommand?: string | null;
  sshTarget: string | null;
  sshRootDir: string | null;
  lastRecordingId?: string | null;
  recordingActive?: boolean;
  cwd: string | null;
  effectId?: string | null;
  agentWorking?: boolean;
  processTag?: string | null;
  exited?: boolean;
  closing?: boolean;
  exitCode?: number | null;
};

type WorkspaceView = {
  projectId: string;
  fileExplorerOpen: boolean;
  fileExplorerRootDir: string | null;
  codeEditorOpen: boolean;
  codeEditorRootDir: string | null;
  openFileRequest: CodeEditorOpenFileRequest | null;
  codeEditorActiveFilePath: string | null;
  codeEditorPersistedState: CodeEditorPersistedState | null;
  codeEditorFsEvent: CodeEditorFsEvent | null;
  editorWidth: number;
  treeWidth: number;
};

type PtyOutput = { id: string; data: string };
type PtyExit = { id: string; exit_code?: number | null };
type AppInfo = { name: string; version: string; homepage?: string | null };
type AppMenuEventPayload = { id: string };
type StartupFlags = { clearData: boolean };
type TrayMenuEventPayload = {
  id: string;
  effectId?: string | null;
  projectId?: string | null;
  persistId?: string | null;
};
type RecentSessionKey = { projectId: string; persistId: string };
type TrayRecentSession = { label: string; projectId: string; persistId: string };

// Buffer for data that arrives before terminal is ready
export type PendingDataBuffer = Map<string, string[]>;

const STORAGE_PROJECTS_KEY = "agents-ui-projects";
const STORAGE_ACTIVE_PROJECT_KEY = "agents-ui-active-project-id";
const STORAGE_SESSIONS_KEY = "agents-ui-sessions-v1";
const STORAGE_ACTIVE_SESSION_BY_PROJECT_KEY = "agents-ui-active-session-by-project-v1";
const STORAGE_SIDEBAR_PROJECTS_LIST_MAX_HEIGHT_KEY = "agents-ui-sidebar-projects-list-max-height-v1";
const STORAGE_WORKSPACE_EDITOR_WIDTH_KEY = "agents-ui-workspace-editor-width-v1";
const STORAGE_WORKSPACE_FILE_TREE_WIDTH_KEY = "agents-ui-workspace-file-tree-width-v1";
const STORAGE_RECENT_SESSIONS_KEY = "agents-ui-recent-sessions-v1";

const MAX_PENDING_SESSIONS = 32;
const MAX_PENDING_CHUNKS_PER_SESSION = 200;

const DEFAULT_AGENT_SHORTCUT_IDS = ["codex", "claude", "gemini"];
const DEFAULT_SIDEBAR_PROJECTS_LIST_MAX_HEIGHT = 290;
const MIN_SIDEBAR_PROJECTS_LIST_MAX_HEIGHT = 0;
const MAX_SIDEBAR_PROJECTS_LIST_MAX_HEIGHT = 1200;
const SIDEBAR_RESIZE_BOTTOM_MIN_PX = 200;
const SIDEBAR_PROJECTS_LIST_AUTO_MAX_VISIBLE = 6;
const DEFAULT_WORKSPACE_EDITOR_WIDTH = 520;
const DEFAULT_WORKSPACE_FILE_TREE_WIDTH = 320;
const MIN_WORKSPACE_TERMINAL_WIDTH = 160;
const MIN_WORKSPACE_EDITOR_WIDTH = 260;
const MIN_WORKSPACE_FILE_TREE_WIDTH = 200;

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeSmartQuotes(input: string): string {
  return input.replace(/[“”„‟«»]/g, '"').replace(/[‘’‚‛‹›]/g, "'");
}

function parseGithubRepo(value: string | null | undefined): { owner: string; repo: string } | null {
  const raw = value?.trim() ?? "";
  if (!raw) return null;

  const direct = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?\/?$/);
  if (direct) {
    return { owner: direct[1], repo: direct[2] };
  }

  try {
    const url = new URL(raw);
    if (url.hostname !== "github.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    let repo = parts[1];
    if (repo.endsWith(".git")) repo = repo.slice(0, -4);
    return { owner: parts[0], repo };
  } catch {
    return null;
  }
}

function parseSemver(input: string): number[] | null {
  const match = input.trim().match(/\d+(?:\.\d+)+/);
  if (!match) return null;
  const parts = match[0].split(".").filter(Boolean);
  const nums = parts.map((p) => Number.parseInt(p, 10));
  if (nums.some((n) => Number.isNaN(n))) return null;
  return nums;
}

function compareSemver(a: string, b: string): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
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

function parsePort(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const num = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(num) || num < 1 || num > 65535) return null;
  return num;
}

function sshForwardFlag(type: SshForwardType): "-L" | "-R" | "-D" {
  if (type === "remote") return "-R";
  if (type === "dynamic") return "-D";
  return "-L";
}

function sshForwardSpec(f: SshForward): string | null {
  const listenPort = parsePort(f.listenPort);
  if (!listenPort) return null;

  const bind = f.bindAddress.trim();
  if (f.type === "dynamic") {
    return bind ? `${bind}:${listenPort}` : `${listenPort}`;
  }

  const destHost = f.destinationHost.trim();
  const destPort = parsePort(f.destinationPort);
  if (!destHost || !destPort) return null;

  const prefix = bind ? `${bind}:${listenPort}` : `${listenPort}`;
  return `${prefix}:${destHost}:${destPort}`;
}

function buildSshCommand(input: {
  host: string;
  forwards: SshForward[];
  exitOnForwardFailure: boolean;
  forwardOnly: boolean;
}): string | null {
  const host = input.host.trim();
  if (!host) return null;

  const args: string[] = ["ssh"];
  if (input.exitOnForwardFailure && input.forwards.length > 0) {
    args.push("-o", "ExitOnForwardFailure=yes");
  }
  if (input.forwardOnly) {
    args.push("-N");
  }
  for (const f of input.forwards) {
    const spec = sshForwardSpec(f);
    if (!spec) return null;
    args.push(sshForwardFlag(f.type), spec);
  }
  args.push(host);

  return args.join(" ");
}

function isSshCommandLine(commandLine: string | null | undefined): boolean {
  const trimmed = commandLine?.trim() ?? "";
  if (!trimmed) return false;
  const token = trimmed.split(/\s+/)[0];
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.toLowerCase().replace(/\.exe$/, "") === "ssh";
}

function sshTargetFromCommandLine(commandLine: string | null | undefined): string | null {
  const trimmed = commandLine?.trim() ?? "";
  if (!trimmed) return null;
  if (!isSshCommandLine(trimmed)) return null;
  const parts = trimmed.split(/\s+/);
  const target = parts[parts.length - 1]?.trim() ?? "";
  return target ? target : null;
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

type PersistedSession = {
  persistId: string;
  projectId: string;
  name: string;
  launchCommand: string | null;
  restoreCommand?: string | null;
  sshTarget?: string | null;
  sshRootDir?: string | null;
  lastRecordingId?: string | null;
  cwd: string | null;
  persistent?: boolean;
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
}): Promise<Session> {
  const persistent = Boolean(input.persistent);
  const persistId = input.persistId ?? makeId();

  const trimmedCommand = (input.launchCommand ?? "").trim();
  const launchCommand = persistent ? null : trimmedCommand ? trimmedCommand : null;
  const isSshSession = isSshCommandLine(launchCommand ?? input.restoreCommand ?? null);
  const sshTarget = isSshSession
    ? (input.sshTarget?.trim() || sshTargetFromCommandLine(launchCommand ?? input.restoreCommand ?? null))
    : null;
  const sshRootDir = isSshSession ? input.sshRootDir?.trim() || null : null;
  const processTag = launchCommand ? commandTagFromCommandLine(launchCommand) : null;
  const effect = detectProcessEffect({
    command: launchCommand,
    name: input.name ?? null,
  });
  const info = await invoke<SessionInfo>("create_session", {
    name: input.name ?? null,
    command: launchCommand,
    cwd: input.cwd ?? null,
    envVars: input.envVars ?? null,
    persistent,
    persistId,
  });
  return {
    ...info,
    projectId: input.projectId,
    persistId,
    persistent,
    createdAt: input.createdAt ?? Date.now(),
    launchCommand,
    restoreCommand: input.restoreCommand ?? null,
    sshTarget,
    sshRootDir,
    lastRecordingId: input.lastRecordingId ?? null,
    recordingActive: false,
    cwd: info.cwd ?? input.cwd ?? null,
    effectId: effect?.id ?? null,
    processTag,
  };
}

async function closeSession(id: string): Promise<void> {
  await invoke("close_session", { id });
}

async function detachSession(id: string): Promise<void> {
  await invoke("detach_session", { id });
}

export default function App() {
  const [initialProjectState] = useState(() => defaultProjectState());
  const [projects, setProjects] = useState<Project[]>(initialProjectState.projects);
  const [activeProjectId, setActiveProjectId] = useState<string>(initialProjectState.activeProjectId);
  const [activeSessionByProject, setActiveSessionByProject] = useState<Record<string, string>>({});

  const [sessions, setSessions] = useState<Session[]>([]);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentConfig[]>([]);
  const [assets, setAssets] = useState<AssetTemplate[]>([]);
  const [assetSettings, setAssetSettings] = useState<AssetSettings>({ autoApplyEnabled: true });
  const [agentShortcutIds, setAgentShortcutIds] = useState<string[]>(DEFAULT_AGENT_SHORTCUT_IDS);
  const [agentShortcutsOpen, setAgentShortcutsOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const [projectsListHeightMode, setProjectsListHeightMode] = useState<"auto" | "manual">(() => {
    try {
      const raw = localStorage.getItem(STORAGE_SIDEBAR_PROJECTS_LIST_MAX_HEIGHT_KEY);
      const parsed = raw != null ? Number(raw) : NaN;
      return Number.isFinite(parsed) ? "manual" : "auto";
    } catch {
      // Best-effort: localStorage may be unavailable in some contexts.
      return "auto";
    }
  });
  const [projectsListMaxHeight, setProjectsListMaxHeight] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_SIDEBAR_PROJECTS_LIST_MAX_HEIGHT_KEY);
      const parsed = raw != null ? Number(raw) : NaN;
      if (Number.isFinite(parsed)) {
        return Math.min(
          MAX_SIDEBAR_PROJECTS_LIST_MAX_HEIGHT,
          Math.max(MIN_SIDEBAR_PROJECTS_LIST_MAX_HEIGHT, parsed),
        );
      }
    } catch {
      // Best-effort: localStorage may be unavailable in some contexts.
    }
    return DEFAULT_SIDEBAR_PROJECTS_LIST_MAX_HEIGHT;
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCommand, setNewCommand] = useState("");
  const [newPersistent, setNewPersistent] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [sshManagerOpen, setSshManagerOpen] = useState(false);
  const [sshHosts, setSshHosts] = useState<SshHostEntry[]>([]);
  const [sshHostsLoading, setSshHostsLoading] = useState(false);
  const [sshHostsError, setSshHostsError] = useState<string | null>(null);
  const [sshHost, setSshHost] = useState("");
  const sshHostInputRef = useRef<HTMLInputElement>(null);
  const [sshPersistent, setSshPersistent] = useState(false);
  const [sshForwardOnly, setSshForwardOnly] = useState(false);
  const [sshExitOnForwardFailure, setSshExitOnForwardFailure] = useState(true);
  const [sshForwards, setSshForwards] = useState<SshForward[]>([]);
  const [sshError, setSshError] = useState<string | null>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectMode, setProjectMode] = useState<"new" | "rename">("new");
  const [projectTitle, setProjectTitle] = useState("");
  const [projectBasePath, setProjectBasePath] = useState("");
  const [projectEnvironmentId, setProjectEnvironmentId] = useState<string>("");
  const [projectAssetsEnabled, setProjectAssetsEnabled] = useState(true);
  const [confirmDeleteProjectOpen, setConfirmDeleteProjectOpen] = useState(false);
  const [confirmDeleteRecordingId, setConfirmDeleteRecordingId] = useState<string | null>(null);
  const [confirmDeletePromptId, setConfirmDeletePromptId] = useState<string | null>(null);
  const [confirmDeleteEnvironmentId, setConfirmDeleteEnvironmentId] = useState<string | null>(null);
  const [confirmDeleteAssetId, setConfirmDeleteAssetId] = useState<string | null>(null);
  const [pathPickerOpen, setPathPickerOpen] = useState(false);
  const [pathPickerTarget, setPathPickerTarget] = useState<"project" | "session" | null>(null);
  const [pathPickerListing, setPathPickerListing] = useState<DirectoryListing | null>(null);
  const [pathPickerInput, setPathPickerInput] = useState("");
  const [pathPickerLoading, setPathPickerLoading] = useState(false);
  const [pathPickerError, setPathPickerError] = useState<string | null>(null);
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
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const secureStoragePromptedRef = useRef(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [updateCheckState, setUpdateCheckState] = useState<UpdateCheckState>({ status: "idle" });
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
  const [slidePanelTab, setSlidePanelTab] = useState<"prompts" | "recordings" | "assets">("prompts");
  const [slidePanelWidth, setSlidePanelWidth] = useState(360);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [promptSearch, setPromptSearch] = useState("");
  const [recordingSearch, setRecordingSearch] = useState("");
  const [assetSearch, setAssetSearch] = useState("");
  const [recordingStartTime, setRecordingStartTime] = useState<number | null>(null);
  const [recordingElapsed, setRecordingElapsed] = useState(0);

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
        codeEditorOpen: false,
        codeEditorRootDir: null,
        openFileRequest: null,
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
    const isSsh = isSshCommandLine(active.launchCommand ?? active.restoreCommand ?? null);
    if (isSsh) return `ssh:${active.persistId}`;
    return activeProjectId;
  }, [activeId, activeProjectId, sessions]);

  const activeWorkspaceView = useMemo(() => {
    return workspaceViewByKey[activeWorkspaceKey] ?? createInitialWorkspaceView(activeProjectId);
  }, [activeProjectId, activeWorkspaceKey, createInitialWorkspaceView, workspaceViewByKey]);

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

  const [workspaceResizeMode, setWorkspaceResizeMode] = useState<"editor" | "tree" | null>(null);
  const workspaceResizeStartRef = useRef<
    { x: number; editorWidth: number; treeWidth: number; projectId: string; workspaceKey: string } | null
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

    sessions
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .forEach((s) => {
        add(s.launchCommand ?? null);
        add((s.restoreCommand ?? null) as string | null);
      });

    for (const preset of quickStarts) add(preset.command ?? null);
    for (const effect of PROCESS_EFFECTS) for (const cmd of effect.matchCommands) add(cmd);

    return out.slice(0, 50);
  }, [sessions, quickStarts]);

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
  const pendingExitCodes = useRef<Map<string, number | null>>(new Map());
  const closingSessions = useRef<Map<string, number>>(new Map());
  const sessionIdsRef = useRef<string[]>([]);
  const sessionsRef = useRef<Session[]>([]);
  const activeIdRef = useRef<string | null>(null);
  const activeProjectIdRef = useRef<string>(activeProjectId);
  const lastActiveByProject = useRef<Map<string, string>>(new Map());
  const newNameRef = useRef<HTMLInputElement | null>(null);
  const recordNameRef = useRef<HTMLInputElement | null>(null);
  const promptTitleRef = useRef<HTMLInputElement | null>(null);
  const envNameRef = useRef<HTMLInputElement | null>(null);
  const assetNameRef = useRef<HTMLInputElement | null>(null);
  const projectTitleRef = useRef<HTMLInputElement | null>(null);
  const homeDirRef = useRef<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const pendingSaveRef = useRef<PersistedStateV1 | null>(null);
  const agentIdleTimersRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    let cancelled = false;
    invoke<AppInfo>("get_app_info")
      .then((info) => {
        if (cancelled) return;
        setAppInfo(info);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  function clearAgentIdleTimer(id: string) {
    const existing = agentIdleTimersRef.current.get(id);
    if (existing !== undefined) {
      window.clearTimeout(existing);
      agentIdleTimersRef.current.delete(id);
    }
  }

  function scheduleAgentIdle(id: string, effectId: string | null) {
    clearAgentIdleTimer(id);
    if (!effectId) return;
    const effect = getProcessEffectById(effectId);
    const idleAfterMs = effect?.idleAfterMs ?? 2000;
    const timeout = window.setTimeout(() => {
      agentIdleTimersRef.current.delete(id);
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== id) return s;
          if (!s.agentWorking) return s;
          return { ...s, agentWorking: false };
        }),
      );
    }, idleAfterMs);
    agentIdleTimersRef.current.set(id, timeout);
  }

  function markAgentWorkingFromOutput(id: string) {
    const session = sessionsRef.current.find((s) => s.id === id);
    if (!session) return;
    if (!session.effectId || session.exited || session.closing) return;

    // Persistent sessions (zellij) can emit background output even when "idle".
    // Avoid re-activating a background persistent session unless it's already marked working
    // (or it's the visible active tab).
    if (session.persistent && !session.agentWorking && activeIdRef.current !== id) return;

    if (!session.agentWorking) {
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, agentWorking: true } : s)),
      );
    }
    scheduleAgentIdle(id, session.effectId);
  }

  const active = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId],
  );

  const activeIsSsh = useMemo(() => {
    if (!active) return false;
    return isSshCommandLine(active.launchCommand ?? active.restoreCommand ?? null);
  }, [active]);

  const activeSshTarget = useMemo(() => {
    if (!activeIsSsh || !active) return null;
    const stored = active.sshTarget?.trim() ?? "";
    if (stored) return stored;
    return sshTargetFromCommandLine(active.launchCommand ?? active.restoreCommand ?? null);
  }, [active, activeIsSsh]);

  const sshRootResolveInFlightRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!activeIsSsh || !active) return;
    if (active.exited || active.closing) return;
    if (!activeWorkspaceView.fileExplorerOpen && !activeWorkspaceView.codeEditorOpen) return;

    const currentRoot = (
      activeWorkspaceView.fileExplorerRootDir ??
      activeWorkspaceView.codeEditorRootDir ??
      ""
    ).trim();
    if (currentRoot) return;

    const persistedRoot = (active.sshRootDir ?? "").trim();
    if (persistedRoot) {
      updateWorkspaceViewForKey(activeWorkspaceKey, activeProjectId, (prev) => {
        const existing = (prev.fileExplorerRootDir ?? prev.codeEditorRootDir ?? "").trim();
        if (existing) return prev;
        return { ...prev, fileExplorerRootDir: persistedRoot, codeEditorRootDir: persistedRoot };
      });
      return;
    }

    const target = activeSshTarget;
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
        setSessions((prev) =>
          prev.map((s) =>
            s.id === active.id
              ? { ...s, sshTarget: s.sshTarget ?? target, sshRootDir: root }
              : s,
          ),
        );
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
    }));
  }, [updateActiveWorkspaceView]);

  const handleSelectWorkspaceFile = useCallback(
    (path: string) => {
      updateActiveWorkspaceView((prev) => {
        const project = projects.find((p) => p.id === activeProjectId) ?? null;
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
          openFileRequest: { path, nonce: Date.now() },
        };
      });
    },
    [active?.cwd, activeIsSsh, activeProjectId, projects, updateActiveWorkspaceView],
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

  const beginWorkspaceResize = useCallback(
    (mode: "editor" | "tree") => (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      setWorkspaceResizeMode(mode);
      const editorWidth = workspaceEditorWidthRef.current;
      const treeWidth = workspaceFileTreeWidthRef.current;
      workspaceResizeStartRef.current = { x: e.clientX, editorWidth, treeWidth, projectId: activeProjectId, workspaceKey: activeWorkspaceKey };
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
      }
    };

    const handleMouseUp = () => {
      const draft = workspaceResizeDraftRef.current;
      const start = workspaceResizeStartRef.current;
      if (draft && start) {
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

  const projectSessions = useMemo(
    () => sessions.filter((s) => s.projectId === activeProjectId),
    [sessions, activeProjectId],
  );

  const sessionCountByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sessions) {
      counts.set(s.projectId, (counts.get(s.projectId) ?? 0) + 1);
    }
    return counts;
  }, [sessions]);

  const workingAgentCountByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sessions) {
      if (!s.effectId) continue;
      if (s.exited || s.closing) continue;
      if (!s.agentWorking) continue;
      counts.set(s.projectId, (counts.get(s.projectId) ?? 0) + 1);
    }
    return counts;
  }, [sessions]);

  const persistentSessionItems = useMemo<PersistentSessionsModalItem[]>(() => {
    if (!persistentSessions.length) return [];
    const projectTitleById = new Map(projects.map((p) => [p.id, p.title]));
    const out: PersistentSessionsModalItem[] = [];

    for (const ps of persistentSessions) {
      const activeSession =
        sessions.find((s) => s.persistId === ps.persistId && !s.exited && !s.closing) ?? null;
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
    return {
      ...session,
      exited: true,
      exitCode: pending,
      agentWorking: false,
      recordingActive: false,
    };
  }, []);

  useEffect(() => {
    sessionIdsRef.current = sessions.map((s) => s.id);
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    activeProjectIdRef.current = activeProjectId;
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeId) return;
    const s = sessions.find((s) => s.id === activeId);
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

  useEffect(() => {
    if (!hydrated || persistenceDisabledReason) return;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }

    const persistedSessions: PersistedSession[] = sessions
      .filter((s) => !s.closing)
      .map((s) => ({
        persistId: s.persistId,
        projectId: s.projectId,
        name: s.name,
        launchCommand: s.launchCommand,
        restoreCommand: s.restoreCommand ?? null,
        sshTarget: s.sshTarget ?? null,
        sshRootDir: s.sshRootDir ?? null,
        lastRecordingId: s.lastRecordingId ?? null,
        cwd: s.cwd,
        persistent: s.persistent,
        createdAt: s.createdAt,
      }))
      .sort((a, b) => a.createdAt - b.createdAt);

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
      }, 400);
  }, [projects, activeProjectId, activeSessionByProject, sessions, prompts, environments, assets, assetSettings, agentShortcutIds, secureStorageMode, hydrated, persistenceDisabledReason]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(
        STORAGE_PROJECTS_KEY,
        JSON.stringify(projects.map((p) => ({ id: p.id, title: p.title }))),
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
    const workingCount = sessions.filter(
      (s) => Boolean(s.effectId) && Boolean(s.agentWorking) && !s.exited && !s.closing,
    ).length;
    const sessionsOpen = sessions.filter((s) => !s.exited && !s.closing).length;
    const recordingCount = sessions.filter(
      (s) => Boolean(s.recordingActive) && !s.exited && !s.closing,
    ).length;
    return {
      workingCount,
      sessionsOpen,
      recordingCount,
      activeProject: activeProject?.title ?? null,
      activeSession: active?.name ?? null,
    };
  }, [active?.name, activeProject?.title, sessions]);

  const lastTrayStatusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!hydrated) return;
    const key = JSON.stringify(trayStatus);
    if (lastTrayStatusRef.current === key) return;
    lastTrayStatusRef.current = key;
    void invoke("set_tray_status", {
      workingCount: trayStatus.workingCount,
      sessionsOpen: trayStatus.sessionsOpen,
      activeProject: trayStatus.activeProject,
      activeSession: trayStatus.activeSession,
      recordingCount: trayStatus.recordingCount,
    }).catch(() => {});
  }, [trayStatus, hydrated]);

  const trayRecentSessions = useMemo<TrayRecentSession[]>(() => {
    const open = sessions.filter((s) => !s.exited && !s.closing);
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

    if (active && !active.exited && !active.closing) add(active);

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
      setProjectOpen(false);
      setNewOpen(true);
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
    if (!newOpen) return;
    const base = activeProject?.basePath ?? homeDirRef.current ?? "";
    setNewCwd(base);
    setNewPersistent(false);
    window.setTimeout(() => {
      newNameRef.current?.focus();
    }, 0);
  }, [newOpen, activeProject?.basePath]);

  useEffect(() => {
    if (!sshManagerOpen) return;
    setSshError(null);
    void refreshSshHosts();
    window.setTimeout(() => {
      sshHostInputRef.current?.focus();
    }, 0);
  }, [sshManagerOpen]);

  useEffect(() => {
    if (!projectOpen) return;
    window.setTimeout(() => {
      projectTitleRef.current?.focus();
    }, 0);
  }, [projectOpen]);

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
      const modalOpen =
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

        // Command palette takes priority - Cmd+K or Ctrl+K
        const modKey = isMac ? e.metaKey : e.ctrlKey;
        if (modKey && e.key.toLowerCase() === "k" && !commandPaletteOpen) {
          e.preventDefault();
          e.stopPropagation();
          (document.activeElement as HTMLElement | null)?.blur?.();
          setCommandPaletteOpen(true);
          return;
        }

        // Close command palette with Escape
        if (e.key === "Escape" && commandPaletteOpen) {
          e.preventDefault();
          e.stopPropagation();
          setCommandPaletteOpen(false);
          return;
        }

        // Close slide panel with Escape
        if (e.key === "Escape" && slidePanelOpen && !modalOpen) {
          e.preventDefault();
          setSlidePanelOpen(false);
          return;
        }

      if (e.key === "Escape" && modalOpen) {
        e.preventDefault();
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

      const activeProjectId = activeProjectIdRef.current;
      const sessions = sessionsRef.current.filter((s) => s.projectId === activeProjectId);
      const activeId = activeIdRef.current;

	      if (isMac) {
	        if (e.metaKey && e.key.toLowerCase() === "t") {
	          e.preventDefault();
	          setProjectOpen(false);
	          setNewOpen(true);
	          return;
	        }
        if (e.metaKey && e.key.toLowerCase() === "w") {
          if (!activeId) return;
          e.preventDefault();
          void onClose(activeId);
          return;
        }
        // Cmd+Shift+P - Toggle Prompts Panel
        if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "p") {
          e.preventDefault();
          setSlidePanelOpen(prev => {
            if (!prev) {
              setSlidePanelTab("prompts");
              return true;
            }
            if (slidePanelTab === "prompts") return false;
            setSlidePanelTab("prompts");
            return true;
          });
          return;
        }
        // Cmd+Shift+R - Toggle Recordings Panel
        if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "r") {
          e.preventDefault();
          void refreshRecordings();
          setSlidePanelOpen(prev => {
            if (!prev) {
              setSlidePanelTab("recordings");
              return true;
            }
            if (slidePanelTab === "recordings") return false;
            setSlidePanelTab("recordings");
            return true;
          });
          return;
        }
        // Cmd+Shift+A - Toggle Assets Panel
        if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "a") {
          e.preventDefault();
          setSlidePanelOpen(prev => {
            if (!prev) {
              setSlidePanelTab("assets");
              return true;
            }
            if (slidePanelTab === "assets") return false;
            setSlidePanelTab("assets");
            return true;
          });
          return;
        }
        // Cmd+1 through Cmd+5 - Quick prompts
        if (e.metaKey && /^[1-5]$/.test(e.key)) {
          const idx = parseInt(e.key) - 1;
          const pinnedPrompts = prompts
            .filter(p => p.pinned)
            .sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0));
          if (pinnedPrompts[idx] && activeId) {
            e.preventDefault();
            void sendPromptToActive(pinnedPrompts[idx], "send");
          }
          return;
        }
	      } else {
	        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "t") {
	          e.preventDefault();
	          setProjectOpen(false);
	          setNewOpen(true);
	          return;
	        }
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "w") {
          if (!activeId) return;
          e.preventDefault();
          void onClose(activeId);
          return;
        }
        // Ctrl+Shift+P - Toggle Prompts Panel
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "p") {
          e.preventDefault();
          setSlidePanelOpen(prev => {
            if (!prev) {
              setSlidePanelTab("prompts");
              return true;
            }
            if (slidePanelTab === "prompts") return false;
            setSlidePanelTab("prompts");
            return true;
          });
          return;
        }
        // Ctrl+Shift+R - Toggle Recordings Panel
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "r") {
          e.preventDefault();
          void refreshRecordings();
          setSlidePanelOpen(prev => {
            if (!prev) {
              setSlidePanelTab("recordings");
              return true;
            }
            if (slidePanelTab === "recordings") return false;
            setSlidePanelTab("recordings");
            return true;
          });
          return;
        }
        // Ctrl+Shift+A - Toggle Assets Panel
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "a") {
          e.preventDefault();
          setSlidePanelOpen(prev => {
            if (!prev) {
              setSlidePanelTab("assets");
              return true;
            }
            if (slidePanelTab === "assets") return false;
            setSlidePanelTab("assets");
            return true;
          });
          return;
        }
        // Ctrl+1 through Ctrl+5 - Quick prompts
        if (e.ctrlKey && /^[1-5]$/.test(e.key)) {
          const idx = parseInt(e.key) - 1;
          const pinnedPrompts = prompts
            .filter(p => p.pinned)
            .sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0));
          if (pinnedPrompts[idx] && activeId) {
            e.preventDefault();
            void sendPromptToActive(pinnedPrompts[idx], "send");
          }
          return;
        }
      }

      if (e.ctrlKey && e.shiftKey && e.key === "Tab") {
        e.preventDefault();
        if (!sessions.length) return;
        const idx = sessions.findIndex((s) => s.id === activeId);
        const next = sessions[(idx - 1 + sessions.length) % sessions.length];
        setActiveId(next.id);
        return;
      }
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        if (!sessions.length) return;
        const idx = sessions.findIndex((s) => s.id === activeId);
        const next = sessions[(idx + 1 + sessions.length) % sessions.length];
        setActiveId(next.id);
        return;
      }
    };

		    window.addEventListener("keydown", onKeyDown, true);
		    return () => window.removeEventListener("keydown", onKeyDown, true);
        }, [
          newOpen,
          agentShortcutsOpen,
          projectOpen,
          pathPickerOpen,
          confirmDeleteProjectOpen,
          confirmDeleteRecordingId,
          confirmDeletePromptId,
          confirmDeleteEnvironmentId,
          confirmDeleteAssetId,
          applyAssetRequest,
          applyAssetApplying,
          replayOpen,
          recordPromptOpen,
          recordingsOpen,
          promptsOpen,
          promptEditorOpen,
          environmentsOpen,
          environmentEditorOpen,
          assetEditorOpen,
          commandPaletteOpen,
          slidePanelOpen,
          slidePanelTab,
          prompts,
        ]);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) {
        window.clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = null;
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

  function reportError(prefix: string, err: unknown) {
    setError(`${prefix}: ${formatError(err)}`);
  }

  const reportErrorRef = useRef(reportError);
  useEffect(() => {
    reportErrorRef.current = reportError;
  }, [reportError]);

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      reportErrorRef.current("Unexpected error", event.error ?? event.message);
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      reportErrorRef.current("Unhandled promise rejection", event.reason);
    };
    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);
    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, []);

  function dismissNotice() {
    setNotice(null);
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
  }

  function showNotice(message: string, timeoutMs = 4500) {
    setNotice(message);
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
    }
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null;
      setNotice(null);
    }, timeoutMs);
  }

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
      .map((s) => ({
        persistId: s.persistId,
        projectId: s.projectId,
        name: s.name,
        launchCommand: s.launchCommand,
        restoreCommand: s.restoreCommand ?? null,
        sshTarget: s.sshTarget ?? null,
        sshRootDir: s.sshRootDir ?? null,
        lastRecordingId: s.lastRecordingId ?? null,
        cwd: s.cwd,
        persistent: s.persistent,
        createdAt: s.createdAt,
      }))
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

  async function retrySecureStorage() {
    if (secureStorageRetrying) return;
    setSecureStorageRetrying(true);
    showNotice(
      "macOS Keychain access is needed to decrypt/encrypt your environments + recordings. Choose “Always Allow” to avoid future prompts.",
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
      setPersistenceDisabledReason(`Secure storage is locked (changes won’t be saved): ${formatError(err)}`);
    } finally {
      setSecureStorageRetrying(false);
    }
  }

  const sshCommandPreview = useMemo(() => {
    return buildSshCommand({
      host: sshHost,
      forwards: sshForwards,
      exitOnForwardFailure: sshExitOnForwardFailure,
      forwardOnly: sshForwardOnly,
    });
  }, [sshHost, sshForwards, sshExitOnForwardFailure, sshForwardOnly]);

  async function copySshCommand() {
    if (!sshCommandPreview) return;
    const ok = await copyToClipboard(sshCommandPreview);
    showNotice(ok ? "Copied SSH command" : "Could not copy SSH command");
  }

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

  const checkForUpdates = useCallback(async () => {
    setUpdateCheckState({ status: "checking" });

    let info: AppInfo | null = null;
    try {
      info = await invoke<AppInfo>("get_app_info");
      setAppInfo(info);
    } catch {
      info = null;
    }

    if (!info) {
      setUpdateCheckState({ status: "error", message: "Unable to read app info." });
      return;
    }

    const repo = parseGithubRepo(info.homepage);
    if (!repo) {
      setUpdateCheckState({
        status: "error",
        message: "Update source not configured. Set bundle.homepage to your GitHub repo URL.",
      });
      return;
    }

    const fallbackReleaseUrl = `https://github.com/${repo.owner}/${repo.repo}/releases/latest`;
    const apiUrl = `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`;

    try {
      const response = await fetch(apiUrl, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!response.ok) {
        throw new Error(`GitHub API returned ${response.status}`);
      }
      const data = (await response.json()) as { tag_name?: string };
      const tag = data.tag_name?.trim();
      if (!tag) {
        setUpdateCheckState({ status: "error", message: "Latest release has no tag name." });
        return;
      }

      const current = info.version;
      const cmp = compareSemver(tag, current);

      const releaseUrl = fallbackReleaseUrl;
      const isNewer =
        cmp === null
          ? tag.trim().replace(/^v/i, "") !== current.trim().replace(/^v/i, "")
          : cmp > 0;

      if (isNewer) {
        setUpdateCheckState({
          status: "updateAvailable",
          latestVersion: tag,
          releaseUrl,
        });
        return;
      }

      setUpdateCheckState({
        status: "upToDate",
        latestVersion: tag,
        releaseUrl,
      });
    } catch (err) {
      setUpdateCheckState({
        status: "error",
        message: `Update check failed: ${formatError(err)}`,
      });
    }
  }, []);

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

  async function refreshRecordings() {
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
  }

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

  function openRecordPrompt(sessionId: string) {
    const s = sessionsRef.current.find((s) => s.id === sessionId);
    if (!s) return;
    setRecordPromptSessionId(sessionId);
    setRecordPromptName(defaultRecordingName(s));
    setRecordPromptOpen(true);
    window.setTimeout(() => recordNameRef.current?.focus(), 0);
  }

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
      setSessions((prev) =>
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

  async function stopRecording(sessionId: string) {
    const s = sessionsRef.current.find((s) => s.id === sessionId);
    if (!s) return;
    if (!s.recordingActive) return;

    try {
      await invoke("stop_session_recording", { id: s.id });
    } catch (err) {
      reportError("Failed to stop recording", err);
    } finally {
      setSessions((prev) =>
        prev.map((x) => (x.id === sessionId ? { ...x, recordingActive: false } : x)),
      );
    }
  }

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

  async function openReplay(recordingId: string, mode: "step" | "all" = "step") {
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
        decrypt: secureStorageMode === "keychain",
      });
      setReplayRecording(rec);
      setReplaySteps(splitRecordingIntoSteps(rec.events));
    } catch (err) {
      setReplayError(formatError(err));
    } finally {
      setReplayLoading(false);
    }
  }

  async function openReplayForActive() {
    if (!active?.lastRecordingId) return;
    await openReplay(active.lastRecordingId);
  }

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
      setSessions((prev) =>
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

  function openPromptEditor(prompt?: Prompt) {
    setPromptsOpen(false);
    setPromptEditorId(prompt?.id ?? null);
    setPromptEditorTitle(prompt?.title ?? "");
    setPromptEditorContent(prompt?.content ?? "");
    setPromptEditorOpen(true);
    window.setTimeout(() => promptTitleRef.current?.focus(), 0);
  }

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
        await invoke("write_to_session", { id: sessionId, data: text, source: "user" });
      }
      if (text) await sleep(30);
      await invoke("write_to_session", { id: sessionId, data: "\r", source: "user" });
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
    const activeSession = activeSessionId ? sessions.find((s) => s.id === activeSessionId) ?? null : null;

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
      });
      const s = applyPendingExit(createdRaw);
      setSessions((prev) => [...prev, s]);
      setActiveId(s.id);
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
    if (projectEnvironmentId === id) setProjectEnvironmentId("");
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
      (projects.find((p) => p.id === projectId)?.assetsEnabled ?? true);
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
      setSessions((prev) => [...prev, created]);
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

  async function loadPathPicker(path: string | null) {
    setPathPickerLoading(true);
    setPathPickerError(null);
    try {
      const listing = await invoke<DirectoryListing>("list_directories", { path });
      setPathPickerListing(listing);
      setPathPickerInput(listing.path);
    } catch (err) {
      setPathPickerError(formatError(err));
    } finally {
      setPathPickerLoading(false);
    }
  }

  function openPathPicker(target: "project" | "session", initial: string | null) {
    setPathPickerTarget(target);
    setPathPickerOpen(true);
    void loadPathPicker(initial);
  }

  function onCwdChange(id: string, cwd: string) {
    setSessions((prev) =>
      prev.map((s) => (s.id === id && s.cwd !== cwd ? { ...s, cwd } : s)),
    );
  }

  function onCommandChange(id: string, commandLine: string) {
    const trimmed = commandLine.trim();
    const effect = trimmed ? detectProcessEffect({ command: trimmed, name: null }) : null;
    const nextEffectId = effect?.id ?? null;
    const session = sessionsRef.current.find((s) => s.id === id) ?? null;
    const nextRestoreCommand = effect && !session?.persistent ? trimmed : null;
    const nextAgentWorking = Boolean(nextEffectId);

    if (nextEffectId) scheduleAgentIdle(id, nextEffectId);
    else clearAgentIdleTimer(id);

    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s;
        if (
          s.effectId === nextEffectId &&
          (s.restoreCommand ?? null) === nextRestoreCommand &&
          Boolean(s.agentWorking) === nextAgentWorking
        ) {
          return s;
        }
          return {
            ...s,
            effectId: nextEffectId,
            agentWorking: nextAgentWorking,
            restoreCommand: nextRestoreCommand,
            processTag: null,
          };
      }),
    );
  }

  function pickActiveSessionId(projectId: string): string | null {
    const sessions = sessionsRef.current;
    const last = lastActiveByProject.current.get(projectId);
    if (last && sessions.some((s) => s.id === last)) return last;
    const first = sessions.find((s) => s.projectId === projectId);
    return first ? first.id : null;
  }

  function selectProject(projectId: string) {
    setActiveProjectId(projectId);
    setActiveId(pickActiveSessionId(projectId));
  }

  function moveProject(projectId: string, targetProjectId: string, position: "before" | "after") {
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
  }

  function openNewProject() {
    setNewOpen(false);
    setProjectMode("new");
    setProjectTitle("");
    setProjectBasePath(active?.cwd ?? activeProject?.basePath ?? homeDirRef.current ?? "");
    setProjectEnvironmentId(activeProject?.environmentId ?? "");
    setProjectAssetsEnabled(activeProject?.assetsEnabled ?? true);
    setProjectOpen(true);
  }

  function openProjectSettings(projectId: string) {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;

    setNewOpen(false);
    setProjectMode("rename");
    setProjectTitle(project.title);
    setProjectBasePath(project.basePath ?? "");
    setProjectEnvironmentId(project.environmentId ?? "");
    setProjectAssetsEnabled(project.assetsEnabled ?? true);
    setProjectOpen(true);
    window.setTimeout(() => projectTitleRef.current?.focus(), 0);
  }

  function openRenameProject() {
    if (!activeProject) return;
    openProjectSettings(activeProject.id);
  }

  async function onProjectSubmit(e: React.FormEvent) {
    e.preventDefault();
    const title = projectTitle.trim();
    if (!title) return;

    const desiredBasePath =
      projectBasePath.trim() || activeProject?.basePath || homeDirRef.current || "";
    const validatedBasePath = await invoke<string | null>("validate_directory", {
      path: desiredBasePath,
    }).catch(() => null);
    if (!validatedBasePath) {
      setError("Project base path must be an existing directory.");
      return;
    }

    const environmentId = projectEnvironmentId && environments.some((e) => e.id === projectEnvironmentId)
      ? projectEnvironmentId
      : null;

    if (projectMode === "rename") {
      setProjects((prev) =>
        prev.map((p) =>
          p.id === activeProjectId
            ? {
                ...p,
                title,
                basePath: validatedBasePath,
                environmentId,
                assetsEnabled: projectAssetsEnabled,
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
      basePath: validatedBasePath,
      environmentId,
      assetsEnabled: projectAssetsEnabled,
    };
    setProjects((prev) => [...prev, project]);
    setProjectOpen(false);
    setActiveProjectId(id);

    try {
      await ensureAutoAssets(validatedBasePath, id, projectAssetsEnabled);
      const createdRaw = await createSession({
        projectId: id,
        cwd: validatedBasePath,
        envVars: envVarsForProjectId(id, [...projects, project], environments),
      });
      const s = applyPendingExit(createdRaw);
      setSessions((prev) => [...prev, s]);
      setActiveId(s.id);
    } catch (err) {
      reportError("Failed to create session", err);
      setActiveId(null);
    }
  }

  async function deleteActiveProject() {
    const project = projects.find((p) => p.id === activeProjectId);
    if (!project) return;

    const idsToClose = sessionsRef.current
      .filter((s) => s.projectId === activeProjectId)
      .map((s) => s.id);

    for (const id of idsToClose) {
      clearAgentIdleTimer(id);
      if (!closingSessions.current.has(id)) {
        const timeout = window.setTimeout(() => {
          closingSessions.current.delete(id);
          pendingData.current.delete(id);
        }, 30_000);
        closingSessions.current.set(id, timeout);
      }
      pendingData.current.delete(id);
    }

    setSessions((prev) => prev.filter((s) => s.projectId !== activeProjectId));
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
      try {
        const createdRaw = await createSession({
          projectId: fallback.id,
          cwd: fallback.basePath ?? null,
          envVars: envVarsForProjectId(fallback.id, [fallback], environments),
        });
        const s = applyPendingExit(createdRaw);
        setSessions([s]);
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
    const active = activeIdRef.current;
    if (active) {
      const session = sessionsRef.current.find((s) => s.id === active);
      if (session && session.projectId === activeProjectId) return;
    }
    setActiveId(pickActiveSessionId(activeProjectId));
  }, [activeProjectId]);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

	    const setup = async () => {
	      const isTerminalRendererReady = (term: unknown): boolean => {
	        try {
	          const anyTerm = term as any;
	          const core = anyTerm?._core;
	          const renderService = core?._renderService;
	          const rendererRef = renderService?._renderer;
	          const renderer = rendererRef?.value ?? rendererRef?._value ?? null;
	          return Boolean(renderer && renderer.dimensions);
	        } catch {
	          return false;
	        }
	      };

	      // Set up event listeners FIRST, before creating any sessions
	      const unlistenOutput = await listen<PtyOutput>("pty-output", (event) => {
	        if (cancelled) return;
	        const { id, data } = event.payload;

        // Ignore events for sessions being closed
        if (closingSessions.current.has(id)) return;

	        markAgentWorkingFromOutput(id);

		        const entry = registry.current.get(id);
		        if (entry && isTerminalRendererReady(entry.term)) {
		          entry.term.write(data);
		          return;
		        }
		        {
		          // Buffer the data - the terminal will catch up
		          if (
		            !pendingData.current.has(id) &&
		            pendingData.current.size >= MAX_PENDING_SESSIONS
          ) {
            const oldest = pendingData.current.keys().next().value as string | undefined;
            if (oldest) pendingData.current.delete(oldest);
          }
          const buffer = pendingData.current.get(id) || [];
          buffer.push(data);
          if (buffer.length > MAX_PENDING_CHUNKS_PER_SESSION) {
            buffer.splice(0, buffer.length - MAX_PENDING_CHUNKS_PER_SESSION);
	          }
	          pendingData.current.set(id, buffer);
	        }
	      });
      unlisteners.push(unlistenOutput);

      const unlistenExit = await listen<PtyExit>("pty-exit", (event) => {
        if (cancelled) return;
        const { id, exit_code } = event.payload;

        clearAgentIdleTimer(id);

        const timeout = closingSessions.current.get(id);
        if (timeout !== undefined) {
          window.clearTimeout(timeout);
          closingSessions.current.delete(id);
          return;
        }

        setSessions((prev) => {
          let found = false;
          const next = prev.map((s) => {
            if (s.id !== id) return s;
            found = true;
            return {
              ...s,
              exited: true,
              exitCode: exit_code ?? null,
              agentWorking: false,
              recordingActive: false,
            };
          });
          if (!found) pendingExitCodes.current.set(id, exit_code ?? null);
          return next;
        });
      });
      unlisteners.push(unlistenExit);

      const unlistenMenu = await listen<AppMenuEventPayload>("app-menu", (event) => {
        if (cancelled) return;
        if (event.payload.id === "help-check-updates") {
          setUpdatesOpen(true);
          void checkForUpdates();
        }
      });
      unlisteners.push(unlistenMenu);

      const unlistenTray = await listen<TrayMenuEventPayload>("tray-menu", (event) => {
        if (cancelled) return;
        setPendingTrayAction(event.payload);
      });
      unlisteners.push(unlistenTray);

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

      const persisted = state.sessions
        .filter((s) => projectById.has(s.projectId))
        .sort((a, b) => a.createdAt - b.createdAt);

      const restored: Session[] = [];
      for (const s of persisted) {
        if (cancelled) break;
        try {
          const createdRaw = await createSession({
            projectId: s.projectId,
            name: s.name,
            launchCommand: s.launchCommand,
            restoreCommand: s.restoreCommand ?? null,
            sshTarget: s.sshTarget ?? null,
            sshRootDir: s.sshRootDir ?? null,
            lastRecordingId: s.lastRecordingId ?? null,
            cwd: s.cwd ?? projectById.get(s.projectId)?.basePath ?? resolvedHome ?? null,
            envVars: envVarsForProject(s.projectId),
            persistent: s.persistent ?? false,
            persistId: s.persistId,
            createdAt: s.createdAt,
          });
          const created = applyPendingExit(createdRaw);
          restored.push(created);

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
              } catch {
                // Best-effort restore: if this fails, the tab still opens as a shell.
              }
            })();
          }
        } catch (err) {
          if (!cancelled) reportError("Failed to restore session", err);
        }
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
          return;
        }
        if (cancelled) {
          await closeSession(first.id).catch(() => {});
          return;
        }
        setSessions([first]);
        setActiveId(first.id);
        setHydrated(true);
        return;
      }

      for (const p of state.projects) {
        const desired = activeSessionByProject[p.id];
        const session =
          (desired
            ? restored.find((s) => s.projectId === p.id && s.persistId === desired)
            : null) ?? restored.find((s) => s.projectId === p.id) ?? null;
        if (session) lastActiveByProject.current.set(p.id, session.id);
      }

      setSessions(restored);
      const desired = activeSessionByProject[activeProjectId];
      const active =
        (desired
          ? restored.find(
              (s) => s.projectId === activeProjectId && s.persistId === desired,
            )
          : null) ??
        restored.find((s) => s.projectId === activeProjectId) ??
        null;
      setActiveId(active ? active.id : null);
      setHydrated(true);
    };

    setup();

    return () => {
      cancelled = true;
      unlisteners.forEach(fn => fn());
      for (const timeout of agentIdleTimersRef.current.values()) {
        window.clearTimeout(timeout);
      }
      agentIdleTimersRef.current.clear();
      for (const id of sessionIdsRef.current) {
        const s = sessionsRef.current.find((x) => x.id === id) ?? null;
        if (s?.persistent && !s.exited) void detachSession(id).catch(() => {});
        else void closeSession(id).catch(() => {});
      }
    };
  }, []);

  async function onNewSubmit(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim() || undefined;
    try {
      const launchCommand = newCommand.trim() || null;
      if (newPersistent && launchCommand) {
        setError("Persistent terminals require an empty command (run commands inside the terminal).");
        return;
      }
      const desiredCwd =
        newCwd.trim() || activeProject?.basePath || homeDirRef.current || "";
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
        persistent: newPersistent,
        cwd: validatedCwd,
        envVars: envVarsForProjectId(activeProjectId, projects, environments),
      });
      const s = applyPendingExit(createdRaw);
      setSessions((prev) => [...prev, s]);
      setActiveId(s.id);
      setNewOpen(false);
      setNewName("");
      setNewCommand("");
      setNewPersistent(false);
      setNewCwd("");
    } catch (err) {
      reportError("Failed to create session", err);
    }
  }

  function addSshForward() {
    setSshForwards((prev) => [
      ...prev,
      {
        id: makeId(),
        type: "local",
        bindAddress: "",
        listenPort: "",
        destinationHost: "localhost",
        destinationPort: "",
      },
    ]);
  }

  function removeSshForward(id: string) {
    setSshForwards((prev) => prev.filter((f) => f.id !== id));
  }

  function updateSshForward(id: string, patch: Partial<SshForward>) {
    setSshForwards((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  async function onSshConnect() {
    setSshError(null);

    const target = sshHost.trim();
    if (!target) {
      setSshError("Pick an SSH host.");
      return;
    }

    for (const [idx, f] of sshForwards.entries()) {
      const listenPort = parsePort(f.listenPort);
      if (!listenPort) {
        setSshError(`Forward #${idx + 1}: invalid listen port.`);
        return;
      }
      if (f.type !== "dynamic") {
        if (!f.destinationHost.trim()) {
          setSshError(`Forward #${idx + 1}: destination host is required.`);
          return;
        }
        const destPort = parsePort(f.destinationPort);
        if (!destPort) {
          setSshError(`Forward #${idx + 1}: invalid destination port.`);
          return;
        }
      }
    }

    const command = sshCommandPreview;
    if (!command) {
      setSshError("Invalid SSH configuration.");
      return;
    }

    try {
      const desiredCwd = activeProject?.basePath ?? homeDirRef.current ?? "";
      const validatedCwd = await invoke<string | null>("validate_directory", {
        path: desiredCwd,
      }).catch(() => null);
      if (!validatedCwd) {
        setSshError("Working directory must be an existing folder.");
        return;
      }

      await ensureAutoAssets(validatedCwd, activeProjectId);

      const name = `ssh ${target}`;
      const createdRaw = await createSession({
        projectId: activeProjectId,
        name,
        launchCommand: sshPersistent ? null : command,
        restoreCommand: sshPersistent ? command : null,
        persistent: sshPersistent,
        cwd: validatedCwd,
        envVars: envVarsForProjectId(activeProjectId, projects, environments),
      });
      const s = applyPendingExit(createdRaw);
      setSessions((prev) => [...prev, s]);
      setActiveId(s.id);
      setSshManagerOpen(false);

      if (sshPersistent) {
        void (async () => {
          try {
            await invoke("write_to_session", { id: s.id, data: command, source: "system" });
            await sleep(30);
            await invoke("write_to_session", { id: s.id, data: "\r", source: "system" });
          } catch (err) {
            reportError("Failed to start SSH inside persistent session", err);
          }
        })();
      }
    } catch (err) {
      setSshError(formatError(err));
    }
  }

  async function onClose(id: string) {
    clearAgentIdleTimer(id);
    const session = sessionsRef.current.find((s) => s.id === id) ?? null;
    const wasPersistent = Boolean(session?.persistent && !session?.exited);
    if (session?.recordingActive) {
      try {
        await invoke("stop_session_recording", { id });
      } catch {
        // ignore
      }
    }
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, closing: true } : s)));

    if (!closingSessions.current.has(id)) {
      const timeout = window.setTimeout(() => {
        closingSessions.current.delete(id);
        pendingData.current.delete(id);
      }, 30_000);
      closingSessions.current.set(id, timeout);
    }

    // Clean up pending buffer
    pendingData.current.delete(id);

    let killErr: string | null = null;
    let killedPersistent = false;
    let closeErr: unknown | null = null;
    try {
      try {
        // Close the attached client first so zellij is no longer "in use" when we kill the session.
        await closeSession(id);
      } catch (err) {
        closeErr = err;
      }

      if (wasPersistent && session?.persistId) {
        try {
          await invoke("kill_persistent_session", { persistId: session.persistId });
          killedPersistent = true;
        } catch (err) {
          killErr = formatError(err);
        } finally {
          void refreshPersistentSessions();
        }
      }

      if (closeErr) throw closeErr;
    } catch (err) {
      const timeout = closingSessions.current.get(id);
      if (timeout !== undefined) window.clearTimeout(timeout);
      closingSessions.current.delete(id);
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, closing: false } : s)),
      );
      reportError("Failed to close session", err);
      return;
    }

    if (wasPersistent && session) {
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

    setSessions((prev) => {
      const closing = prev.find((s) => s.id === id);
      const next = prev.filter((s) => s.id !== id);
      setActiveId((prevActive) => {
        if (prevActive !== id) return prevActive;
        if (!closing) return next.length ? next[0].id : null;
        const sameProject = next.filter((s) => s.projectId === closing.projectId);
        return sameProject.length ? sameProject[0].id : null;
      });
      return next;
    });
  }

  async function attachPersistentSession(persistId: string) {
    const existing = sessionsRef.current.find((s) => s.persistId === persistId) ?? null;
    if (existing && !existing.exited && !existing.closing) {
      setActiveProjectId(existing.projectId);
      setActiveId(existing.id);
      return;
    }

    const cwd = activeProject?.basePath ?? homeDirRef.current ?? null;
    try {
      if (cwd) await ensureAutoAssets(cwd, activeProjectId);
      const createdRaw = await createSession({
        projectId: activeProjectId,
        name: `persist ${persistId.slice(0, 8)}`,
        persistent: true,
        persistId,
        cwd,
        envVars: envVarsForProjectId(activeProjectId, projects, environments),
      });
      const created = applyPendingExit(createdRaw);
      setSessions((prev) => [...prev, created]);
      setActiveId(created.id);
    } catch (err) {
      reportError("Failed to attach persistent session", err);
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

      setSessions((prev) => prev.filter((s) => s.persistId !== persistId));
      setActiveId((prevActive) => {
        if (!prevActive) return prevActive;
        const stillExists = sessionsRef.current.some(
          (s) => s.id === prevActive && s.persistId !== persistId,
        );
        return stillExists ? prevActive : null;
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

  async function quickStart(preset: { id: string; title: string; command: string | null }) {
    try {
      const cwd = activeProject?.basePath ?? homeDirRef.current ?? null;
      if (cwd) await ensureAutoAssets(cwd, activeProjectId);
      const createdRaw = await createSession({
        projectId: activeProjectId,
        name: preset.title,
        launchCommand: null,
        cwd,
        envVars: envVarsForProjectId(activeProjectId, projects, environments),
      });
      const created = applyPendingExit(createdRaw);
      const next = created.effectId ? { ...created, agentWorking: true } : created;
      setSessions((prev) => [...prev, next]);
      setActiveId(next.id);
      if (next.effectId) scheduleAgentIdle(next.id, next.effectId);

      const commandLine = (preset.command ?? "").trim();
      if (commandLine) {
        void invoke("write_to_session", { id: next.id, data: `${commandLine}\r`, source: "ui" }).catch((err) =>
          reportError(`Failed to start ${preset.title}`, err),
        );
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

  const persistProjectsListMaxHeight = useCallback((value: number) => {
    setProjectsListHeightMode("manual");
    try {
      localStorage.setItem(
        STORAGE_SIDEBAR_PROJECTS_LIST_MAX_HEIGHT_KEY,
        String(Math.round(value)),
      );
    } catch {
      // Best-effort: localStorage may be unavailable in some contexts.
    }
  }, [setProjectsListHeightMode]);

  const clearPersistedProjectsListMaxHeight = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_SIDEBAR_PROJECTS_LIST_MAX_HEIGHT_KEY);
    } catch {
      // Best-effort: localStorage may be unavailable in some contexts.
    }
  }, []);

  const computeProjectsListMaxHeightLimit = useCallback(() => {
    const sidebar = sidebarRef.current;
    const projectList = sidebar?.querySelector<HTMLElement>(".projectList");
    if (!sidebar || !projectList) return MAX_SIDEBAR_PROJECTS_LIST_MAX_HEIGHT;
    const sidebarRect = sidebar.getBoundingClientRect();
    const listRect = projectList.getBoundingClientRect();
    const available = sidebarRect.bottom - listRect.top - SIDEBAR_RESIZE_BOTTOM_MIN_PX;
    return Math.min(
      MAX_SIDEBAR_PROJECTS_LIST_MAX_HEIGHT,
      Math.max(MIN_SIDEBAR_PROJECTS_LIST_MAX_HEIGHT, Math.floor(available)),
    );
  }, []);

  const projectsListResizingRef = useRef(false);
  const projectsListSyncRafRef = useRef<number | null>(null);

  const computeProjectsListAutoHeight = useCallback((): number => {
    const sidebar = sidebarRef.current;
    const projectList = sidebar?.querySelector<HTMLElement>(".projectList");
    if (!sidebar || !projectList) return DEFAULT_SIDEBAR_PROJECTS_LIST_MAX_HEIGHT;

    const items = Array.from(projectList.querySelectorAll<HTMLElement>(".projectItem"));
    const visibleCount = Math.min(items.length, SIDEBAR_PROJECTS_LIST_AUTO_MAX_VISIBLE);
    if (!visibleCount) return 0;

    const style = getComputedStyle(projectList);
    const gap = Number.parseFloat(style.rowGap || style.gap || "0") || 0;

    let height = 0;
    for (let i = 0; i < visibleCount; i++) {
      height += items[i].getBoundingClientRect().height;
    }
    height += gap * Math.max(0, visibleCount - 1);
    return height;
  }, []);

  const syncProjectsListHeight = useCallback(
    (modeOverride?: "auto" | "manual") => {
      if (projectsListResizingRef.current) return;

      const max = computeProjectsListMaxHeightLimit();
      const clamp = (value: number) =>
        Math.min(max, Math.max(MIN_SIDEBAR_PROJECTS_LIST_MAX_HEIGHT, value));

      const mode = modeOverride ?? projectsListHeightMode;
      if (mode === "auto") {
        setProjectsListMaxHeight(clamp(computeProjectsListAutoHeight()));
        return;
      }

      setProjectsListMaxHeight((prev) => {
        const clamped = clamp(prev);
        if (clamped !== prev) persistProjectsListMaxHeight(clamped);
        return clamped;
      });
    },
    [
      computeProjectsListAutoHeight,
      computeProjectsListMaxHeightLimit,
      persistProjectsListMaxHeight,
      projectsListHeightMode,
    ],
  );

  const scheduleProjectsListHeightSync = useCallback(
    (modeOverride?: "auto" | "manual") => {
      if (projectsListSyncRafRef.current != null) {
        cancelAnimationFrame(projectsListSyncRafRef.current);
      }

      projectsListSyncRafRef.current = requestAnimationFrame(() => {
        projectsListSyncRafRef.current = null;
        syncProjectsListHeight(modeOverride);
      });
    },
    [syncProjectsListHeight],
  );

  useLayoutEffect(() => {
    syncProjectsListHeight();
  }, [projects.length, projectsListHeightMode, syncProjectsListHeight]);

  const handleWindowResize = useCallback(() => {
    scheduleProjectsListHeightSync();
  }, [scheduleProjectsListHeightSync]);

  useEffect(() => {
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [handleWindowResize]);

  useEffect(() => {
    return () => {
      if (projectsListSyncRafRef.current != null) {
        cancelAnimationFrame(projectsListSyncRafRef.current);
      }
    };
  }, []);

  const resetProjectsListMaxHeight = useCallback(() => {
    setProjectsListHeightMode("auto");
    clearPersistedProjectsListMaxHeight();
    scheduleProjectsListHeightSync("auto");
  }, [clearPersistedProjectsListMaxHeight, scheduleProjectsListHeightSync, setProjectsListHeightMode]);

  const handleProjectsDividerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 60 : 20;
      const max = computeProjectsListMaxHeightLimit();
      const clamp = (value: number) =>
        Math.min(max, Math.max(MIN_SIDEBAR_PROJECTS_LIST_MAX_HEIGHT, value));

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setProjectsListMaxHeight((prev) => {
          const next = clamp(prev + step);
          persistProjectsListMaxHeight(next);
          return next;
        });
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setProjectsListMaxHeight((prev) => {
          const next = clamp(prev - step);
          persistProjectsListMaxHeight(next);
          return next;
        });
        return;
      }

      if (event.key === "Home") {
        event.preventDefault();
        setProjectsListMaxHeight(MIN_SIDEBAR_PROJECTS_LIST_MAX_HEIGHT);
        persistProjectsListMaxHeight(MIN_SIDEBAR_PROJECTS_LIST_MAX_HEIGHT);
        return;
      }

      if (event.key === "End") {
        event.preventDefault();
        setProjectsListMaxHeight(max);
        persistProjectsListMaxHeight(max);
      }
    },
    [computeProjectsListMaxHeightLimit, persistProjectsListMaxHeight],
  );

	  const handleProjectsDividerPointerDown = useCallback(
	    (event: React.PointerEvent<HTMLDivElement>) => {
	      if (event.button !== 0) return;
	      event.preventDefault();

	      projectsListResizingRef.current = true;
	      if (projectsListSyncRafRef.current != null) {
	        cancelAnimationFrame(projectsListSyncRafRef.current);
	        projectsListSyncRafRef.current = null;
	      }

	      const pointerId = event.pointerId;
	      const target = event.currentTarget;
	      const startY = event.clientY;
	      const startHeight = projectsListMaxHeight;
      const maxHeight = computeProjectsListMaxHeightLimit();

      const clamp = (value: number) =>
        Math.min(maxHeight, Math.max(MIN_SIDEBAR_PROJECTS_LIST_MAX_HEIGHT, value));

      let current = startHeight;
      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";

      try {
        target.setPointerCapture(pointerId);
      } catch {
        // ignore
      }

      const handlePointerMove = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        current = clamp(startHeight + (e.clientY - startY));
        setProjectsListMaxHeight(current);
      };

	      const handlePointerUp = (e: PointerEvent) => {
	        if (e.pointerId !== pointerId) return;
	        document.removeEventListener("pointermove", handlePointerMove);
	        document.removeEventListener("pointerup", handlePointerUp);
	        document.removeEventListener("pointercancel", handlePointerUp);
	        projectsListResizingRef.current = false;
	        document.body.style.cursor = prevCursor;
	        document.body.style.userSelect = prevUserSelect;
	        persistProjectsListMaxHeight(current);
	        try {
	          target.releasePointerCapture(pointerId);
        } catch {
          // ignore
        }
      };

	      document.addEventListener("pointermove", handlePointerMove);
	      document.addEventListener("pointerup", handlePointerUp);
	      document.addEventListener("pointercancel", handlePointerUp);
	    },
	    [computeProjectsListMaxHeightLimit, persistProjectsListMaxHeight, projectsListMaxHeight],
	  );

  return (
    <div className="app">
      <aside
        className="sidebar"
        ref={sidebarRef}
        style={
          { ["--projectsListMaxHeight" as any]: `${projectsListMaxHeight}px` } as React.CSSProperties
        }
      >
        <ProjectsSection
          projects={projects}
          activeProjectId={activeProjectId}
          activeProject={activeProject}
          environments={environments}
          sessionCountByProject={sessionCountByProject}
          workingAgentCountByProject={workingAgentCountByProject}
          onNewProject={openNewProject}
          onProjectSettings={openRenameProject}
          onDeleteProject={() => setConfirmDeleteProjectOpen(true)}
          onSelectProject={selectProject}
          onOpenProjectSettings={openProjectSettings}
          onMoveProject={moveProject}
        />

        <QuickPromptsSection
          prompts={prompts}
          activeSessionId={activeId}
          onSendPrompt={(prompt) => void sendPromptToActive(prompt, "send")}
          onEditPrompt={openPromptEditor}
          onOpenPromptsPanel={() => {
            setSlidePanelTab("prompts");
            setSlidePanelOpen(true);
          }}
        />

        <div
          className="sidebarResizeHandle"
          role="separator"
          aria-label="Resize Projects and Sessions"
          aria-orientation="horizontal"
          aria-valuemin={MIN_SIDEBAR_PROJECTS_LIST_MAX_HEIGHT}
          aria-valuemax={MAX_SIDEBAR_PROJECTS_LIST_MAX_HEIGHT}
          aria-valuenow={Math.round(projectsListMaxHeight)}
          tabIndex={0}
          onDoubleClick={resetProjectsListMaxHeight}
          onKeyDown={handleProjectsDividerKeyDown}
          onPointerDown={handleProjectsDividerPointerDown}
          title="Drag to resize • Double-click to auto-fit"
        />

        <SessionsSection
          agentShortcuts={agentShortcuts}
          sessions={projectSessions}
          activeSessionId={activeId}
          onSelectSession={setActiveId}
          onCloseSession={(id) => void onClose(id)}
          onQuickStart={(effect) =>
            void quickStart({
              id: effect.id,
              title: effect.label,
              command: effect.matchCommands[0] ?? effect.label,
            })
          }
          onOpenNewSession={() => {
            setProjectOpen(false);
            setNewOpen(true);
          }}
          onOpenPersistentSessions={() => {
            setPersistentSessionsOpen(true);
            void refreshPersistentSessions();
          }}
          onOpenSshManager={() => {
            setProjectOpen(false);
            setNewOpen(false);
            setSshManagerOpen(true);
          }}
          onOpenAgentShortcuts={() => setAgentShortcutsOpen(true)}
        />
      </aside>

      <main className="main">
	        <div className="topbar">
	          <div className="activeTitle">
            <span>{activeProject ? `Project: ${activeProject.title}` : "Project: —"}</span>
            <span>{active ? ` • ${active.name}` : " • No session"}</span>
            {activeIsSsh ? (
              <>
                {" "}
                <span className="chip chip-ssh" title="SSH">
                  <span className="chipLabel">ssh</span>
                </span>
              </>
            ) : null}
          </div>
		          <div className="topbarRight">
		            {persistenceDisabledReason && (
		              <div className="errorBanner" role="alert">
		                <div className="errorText" title={persistenceDisabledReason}>
		                  {persistenceDisabledReason}
		                </div>
		                {secureStorageMode === "keychain" &&
		                /keychain|keyring/i.test(persistenceDisabledReason) ? (
		                  <button
		                    type="button"
		                    className="errorClose"
		                    onClick={() => void retrySecureStorage()}
		                    disabled={secureStorageRetrying}
		                    title="Retry Keychain access"
		                  >
		                    {secureStorageRetrying ? "Retrying…" : "Retry"}
		                  </button>
		                ) : (
		                  <button
		                    className="errorClose"
		                    onClick={() => setPersistenceDisabledReason(null)}
		                    title="Dismiss"
		                  >
		                    ×
		                  </button>
		                )}
		              </div>
		            )}

	            {error && (
	              <div className="errorBanner" role="alert">
	                <div className="errorText" title={error}>
	                  {error}
	                </div>
	                <button className="errorClose" onClick={() => setError(null)} title="Dismiss">
	                  ×
	                </button>
	              </div>
	            )}

		            {notice && (
		              <div className="noticeBanner" role="status" aria-live="polite">
		                <div className="noticeText" title={notice}>
		                  {notice}
		                </div>
		                <button className="errorClose" onClick={dismissNotice} title="Dismiss">
		                  ×
		                </button>
		              </div>
		            )}

	            {!error && !notice && (
	              <div className="shortcutHint">
	                <kbd>{"\u2318"}K</kbd> Quick Access
	              </div>
	            )}

            {/* Recording Timer */}
            {active?.recordingActive && (
              <div className="recordingTimer">
                <span className="recordingTimerDot" />
                <span>REC</span>
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

                {/* Record Button */}
                <button
                  className={`iconBtn ${active.recordingActive ? "iconBtnRecording" : ""}`}
                  onClick={() =>
                    active.recordingActive ? void stopRecording(active.id) : openRecordPrompt(active.id)
                  }
                  disabled={Boolean(active.exited || active.closing)}
                  title={active.recordingActive ? "Stop recording (active)" : "Start recording"}
                >
                  <Icon name={active.recordingActive ? "stop" : "record"} />
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

                {/* Replay Button */}
                <button
                  className="iconBtn"
                  onClick={() => void openReplayForActive()}
                  disabled={!active.lastRecordingId}
                  title={active.lastRecordingId ? "Replay last recording" : "No recording yet"}
                >
                  <Icon name="play" />
                </button>
              </>
            )}
          </div>
        </div>

		        <div className="terminalArea">
	            <div
	              ref={workspaceRowRef}
	              className={`workspaceRow ${workspaceResizeMode ? "workspaceResizing" : ""}`}
	              style={
	                {
	                  "--workspaceEditorWidthPx": `${activeWorkspaceView.editorWidth}px`,
	                  "--workspaceFileTreeWidthPx": `${activeWorkspaceView.treeWidth}px`,
	                } as React.CSSProperties
	              }
	            >
              <div className="terminalPane" aria-label="Terminal">
                {sessions.map((s) => (
                  <div
                    key={s.id}
                    className={`terminalContainer ${s.id === activeId ? "" : "terminalHidden"}`}
                  >
                    <SessionTerminal
                      id={s.id}
                      active={s.id === activeId}
                      readOnly={Boolean(s.exited || s.closing)}
                      persistent={s.persistent}
                      onCwdChange={onCwdChange}
                      onCommandChange={onCommandChange}
                      registry={registry}
                      pendingData={pendingData}
                    />
                  </div>
                ))}
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
	                  <React.Suspense
	                    fallback={
	                      <section className="codeEditorPanel" aria-label="Editor">
	                        <div className="empty">Loading editor…</div>
	                      </section>
	                    }
	                  >
	                    <LazyCodeEditorPanel
	                      key={`code-editor:${activeWorkspaceKey}`}
                        provider={activeIsSsh ? "ssh" : "local"}
                        sshTarget={activeIsSsh ? activeSshTarget : null}
	                      rootDir={
	                        (
	                          activeWorkspaceView.codeEditorRootDir ??
	                          activeWorkspaceView.fileExplorerRootDir ??
	                          (!activeIsSsh ? activeProject?.basePath ?? active?.cwd ?? "" : "")
	                        ).trim()
	                      }
	                      openFileRequest={activeWorkspaceView.openFileRequest}
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
			                      onActiveFilePathChange={(path) =>
			                        updateWorkspaceViewForKey(activeWorkspaceKey, activeProjectId, (prev) => {
			                          if (prev.codeEditorActiveFilePath === path) return prev;
			                          return { ...prev, codeEditorActiveFilePath: path };
			                        })
			                      }
			                      onCloseEditor={closeCodeEditor}
			                    />
		                  </React.Suspense>
	                </>
	              ) : null}

	              {activeWorkspaceView.fileExplorerOpen &&
	              (
	                activeWorkspaceView.fileExplorerRootDir ??
	                activeWorkspaceView.codeEditorRootDir ??
                  (!activeIsSsh ? activeProject?.basePath ?? active?.cwd ?? "" : "")
	              ).trim() ? (
	                <>
	                  <div
	                    className="workspaceResize"
	                    onMouseDown={beginWorkspaceResize("tree")}
	                    aria-hidden="true"
	                  />
	                  <FileExplorerPanel
	                    key={`file-tree:${activeWorkspaceKey}`}
	                    isOpen
                      provider={activeIsSsh ? "ssh" : "local"}
                      sshTarget={activeIsSsh ? activeSshTarget : null}
	                    rootDir={
	                      (
	                        activeWorkspaceView.fileExplorerRootDir ??
	                        activeWorkspaceView.codeEditorRootDir ??
	                        (!activeIsSsh ? activeProject?.basePath ?? active?.cwd ?? "" : "")
	                      ).trim()
	                    }
	                    activeFilePath={activeWorkspaceView.codeEditorActiveFilePath}
	                    onSelectFile={handleSelectWorkspaceFile}
                      onPathRenamed={handleRenameWorkspacePath}
                      onPathDeleted={handleDeleteWorkspacePath}
	                    onClose={() =>
	                      updateWorkspaceViewForKey(activeWorkspaceKey, activeProjectId, (prev) => ({
	                        ...prev,
	                        fileExplorerOpen: false,
	                      }))
	                    }
	                  />
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
            </div>
	
	          <NewSessionModal
	            isOpen={newOpen}
	            projectTitle={activeProject?.title ?? null}
            name={newName}
            nameInputRef={newNameRef}
            onChangeName={(value) => setNewName(normalizeSmartQuotes(value))}
            command={newCommand}
            onChangeCommand={(value) => setNewCommand(normalizeSmartQuotes(value))}
            commandSuggestions={commandSuggestions}
            persistent={newPersistent}
            onChangePersistent={setNewPersistent}
            cwd={newCwd}
            onChangeCwd={(value) => setNewCwd(normalizeSmartQuotes(value))}
            cwdPlaceholder={activeProject?.basePath ?? "~"}
            onBrowseCwd={() =>
              openPathPicker("session", newCwd.trim() || activeProject?.basePath || null)
            }
            canUseProjectBase={Boolean(activeProject?.basePath)}
            onUseProjectBase={() => setNewCwd(activeProject?.basePath ?? "")}
            canUseCurrentTab={Boolean(active?.cwd)}
            onUseCurrentTab={() => setNewCwd(active?.cwd ?? "")}
            onClose={() => {
              setNewOpen(false);
              setNewPersistent(false);
            }}
            onSubmit={onNewSubmit}
          />

          <SshManagerModal
            isOpen={sshManagerOpen}
            hosts={sshHosts}
            hostsLoading={sshHostsLoading}
            hostsError={sshHostsError}
            onRefreshHosts={() => void refreshSshHosts()}
            host={sshHost}
            hostInputRef={sshHostInputRef}
            onChangeHost={setSshHost}
            persistent={sshPersistent}
            onChangePersistent={setSshPersistent}
            forwardOnly={sshForwardOnly}
            onChangeForwardOnly={setSshForwardOnly}
            exitOnForwardFailure={sshExitOnForwardFailure}
            onChangeExitOnForwardFailure={setSshExitOnForwardFailure}
            forwards={sshForwards}
            onAddForward={addSshForward}
            onRemoveForward={removeSshForward}
            onUpdateForward={updateSshForward}
            commandPreview={sshCommandPreview}
            onCopyCommand={() => void copySshCommand()}
            error={sshError}
            onClose={() => {
              setSshManagerOpen(false);
              setSshError(null);
            }}
            onConnect={() => void onSshConnect()}
          />

          <PersistentSessionsModal
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
          />

          <AgentShortcutsModal
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
          />

          <ConfirmActionModal
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
          />

          <ProjectModal
            isOpen={projectOpen}
            mode={projectMode}
            title={projectTitle}
            titleInputRef={projectTitleRef}
            onChangeTitle={(value) => setProjectTitle(normalizeSmartQuotes(value))}
            basePath={projectBasePath}
            onChangeBasePath={(value) => setProjectBasePath(normalizeSmartQuotes(value))}
            basePathPlaceholder={homeDirRef.current ?? "~"}
            onBrowseBasePath={() =>
              openPathPicker("project", projectBasePath.trim() || activeProject?.basePath || null)
            }
            canUseCurrentTab={Boolean(active?.cwd)}
            onUseCurrentTab={() => setProjectBasePath(active?.cwd ?? "")}
            canUseHome={Boolean(homeDirRef.current)}
            onUseHome={() => setProjectBasePath(homeDirRef.current ?? "")}
            environments={environments}
            selectedEnvironmentId={projectEnvironmentId}
            onChangeEnvironmentId={setProjectEnvironmentId}
            onOpenEnvironments={() => setEnvironmentsOpen(true)}
            assetsEnabled={projectAssetsEnabled}
            onChangeAssetsEnabled={setProjectAssetsEnabled}
            onClose={() => setProjectOpen(false)}
            onSubmit={onProjectSubmit}
          />

          <ConfirmDeleteProjectModal
            isOpen={confirmDeleteProjectOpen && Boolean(activeProject)}
            projectTitle={activeProject?.title ?? ""}
            onClose={() => setConfirmDeleteProjectOpen(false)}
            onConfirmDelete={() => {
              setConfirmDeleteProjectOpen(false);
              void deleteActiveProject();
            }}
          />

          <ConfirmDeleteRecordingModal
            isOpen={Boolean(confirmDeleteRecordingId)}
            recordingLabel={
              confirmDeleteRecordingId
                ? recordings.find((r) => r.recordingId === confirmDeleteRecordingId)?.meta?.name?.trim() ||
                  confirmDeleteRecordingId
                : ""
            }
            onClose={() => setConfirmDeleteRecordingId(null)}
            onConfirmDelete={() => {
              const id = confirmDeleteRecordingId;
              setConfirmDeleteRecordingId(null);
              if (id) void deleteRecording(id);
            }}
          />

          <ConfirmActionModal
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
          />

          <ConfirmActionModal
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
          />

          <ConfirmActionModal
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
          />

          <ApplyAssetModal
            isOpen={Boolean(applyAssetRequest && pendingApplyAsset)}
            templateName={pendingApplyAsset?.name ?? ""}
            relativePath={pendingApplyAsset?.relativePath ?? ""}
            targetLabel={applyAssetRequest?.target === "project" ? "project base path" : "tab working directory"}
            targetDir={applyAssetRequest?.dir ?? ""}
            applying={applyAssetApplying}
            error={applyAssetError}
            onClose={closeApplyAssetModal}
            onApply={(overwrite) => void confirmApplyAsset(overwrite)}
          />

          <PathPickerModal
            isOpen={pathPickerOpen}
            listing={pathPickerListing}
            input={pathPickerInput}
            placeholder={homeDirRef.current ?? "~"}
            loading={pathPickerLoading}
            error={pathPickerError}
            onInputChange={setPathPickerInput}
            onLoad={(path) => void loadPathPicker(path)}
            onClose={() => {
              setPathPickerOpen(false);
              setPathPickerTarget(null);
            }}
            onSelect={() => {
              const selected = pathPickerListing?.path;
              if (!selected) return;
              if (pathPickerTarget === "project") setProjectBasePath(selected);
              if (pathPickerTarget === "session") setNewCwd(selected);
              setPathPickerOpen(false);
              setPathPickerTarget(null);
            }}
          />

          <UpdateModal
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
          />

          {secureStorageSettingsOpen && (
            <div
              className="modalBackdrop modalBackdropTop"
              onClick={() => {
                if (secureStorageSettingsBusy) return;
                closeSecureStorageSettings();
              }}
            >
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <h3 className="modalTitle">Secure storage</h3>

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
              </div>
            </div>
          )}

          {recordPromptOpen && (
            <div className="modalBackdrop" onClick={closeRecordPrompt}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <h3 className="modalTitle">Start recording</h3>
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
              </div>
            </div>
          )}

          {recordingsOpen && (
            <div className="modalBackdrop" onClick={() => setRecordingsOpen(false)}>
              <div className="modal recordingsModal" onClick={(e) => e.stopPropagation()}>
                <h3 className="modalTitle">Recordings</h3>

                {recordingsError && (
                  <div className="pathPickerError" role="alert">
                    {recordingsError}
                  </div>
                )}

                <div className="recordingsList">
                  {recordingsLoading ? (
                    <div className="empty">Loading…</div>
                  ) : recordings.length === 0 ? (
                    <div className="empty">No recordings yet.</div>
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
              </div>
            </div>
          )}

          {promptsOpen && (
            <div className="modalBackdrop" onClick={() => setPromptsOpen(false)}>
              <div className="modal recordingsModal" onClick={(e) => e.stopPropagation()}>
                <h3 className="modalTitle">Prompts</h3>

                <div className="recordingsList">
                  {prompts.length === 0 ? (
                    <div className="empty">No prompts yet.</div>
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
              </div>
            </div>
          )}

          {promptEditorOpen && (
            <div className="modalBackdrop" onClick={closePromptEditor}>
              <div className="modal recordingsModal" onClick={(e) => e.stopPropagation()}>
                <h3 className="modalTitle">{promptEditorId ? "Edit prompt" : "New prompt"}</h3>
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
              </div>
            </div>
          )}

          {environmentsOpen && (
            <div className="modalBackdrop" onClick={() => setEnvironmentsOpen(false)}>
              <div className="modal recordingsModal" onClick={(e) => e.stopPropagation()}>
                <h3 className="modalTitle">Environments</h3>

                <div className="recordingsList">
                  {environments.length === 0 ? (
                    <div className="empty">No environments yet.</div>
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
              </div>
            </div>
          )}

          {environmentEditorOpen && (
            <div className="modalBackdrop" onClick={closeEnvironmentEditor}>
              <div className="modal recordingsModal" onClick={(e) => e.stopPropagation()}>
                <h3 className="modalTitle">
                  {environmentEditorId ? "Edit environment" : "New environment"}
                </h3>
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
              </div>
            </div>
          )}

          {assetEditorOpen && (
            <div className="modalBackdrop" onClick={closeAssetEditor}>
              <div className="modal recordingsModal" onClick={(e) => e.stopPropagation()}>
                <h3 className="modalTitle">{assetEditorId ? "Edit asset" : "New asset"}</h3>
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
              </div>
            </div>
          )}

          {replayOpen && (
            <div className="modalBackdrop" onClick={closeReplayModal}>
              <div className="modal recordingsModal" onClick={(e) => e.stopPropagation()}>
                <h3 className="modalTitle">Replay recording</h3>

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
              </div>
            </div>
          )}

          {/* Slide Panel */}
          <SlidePanel
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
                      <div className="panelCardMeta" style={{ textAlign: "center", padding: "16px" }}>
                        No prompts yet
                      </div>
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
                          <div className="panelCardMeta" style={{ textAlign: "center", padding: "16px" }}>
                            No recordings yet
                          </div>
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

                {/* Refresh Button */}
                <div className="panelFooter">
                  <button className="panelFooterBtn" onClick={() => void refreshRecordings()}>
                    Refresh
                  </button>
                </div>
              </>
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
                          <div className="panelCardMeta" style={{ textAlign: "center", padding: "16px" }}>
                            No assets yet
                          </div>
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
          </SlidePanel>
        </div>
      </main>

      {/* Command Palette */}
      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        prompts={prompts}
        recordings={recordings}
        sessions={projectSessions}
        activeSessionId={activeId}
        quickStarts={quickStarts}
        onQuickStart={(preset) => void quickStart(preset)}
        onSendPrompt={(prompt, mode) => void sendPromptFromCommandPalette(prompt, mode)}
        onEditPrompt={openPromptEditor}
        onOpenRecording={(id, mode) => void openReplay(id, mode)}
        onSwitchSession={setActiveId}
        onNewSession={() => setNewOpen(true)}
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
        onOpenAssetsPanel={() => {
          setSlidePanelTab("assets");
          setSlidePanelOpen(true);
        }}
      />
    </div>
  );
}
