import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import React, { useEffect, useMemo, useRef, useState } from "react";
import SessionTerminal, { TerminalRegistry } from "./SessionTerminal";
import { commandTagFromCommandLine, detectProcessEffect, getProcessEffectById } from "./processEffects";
import { shortenPathSmart } from "./pathDisplay";

type Project = {
  id: string;
  title: string;
  basePath: string | null;
  environmentId: string | null;
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
  createdAt: number;
  launchCommand: string | null;
  restoreCommand?: string | null;
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

type PtyOutput = { id: string; data: string };
type PtyExit = { id: string; exit_code?: number | null };

// Buffer for data that arrives before terminal is ready
export type PendingDataBuffer = Map<string, string[]>;

const STORAGE_PROJECTS_KEY = "agents-ui-projects";
const STORAGE_ACTIVE_PROJECT_KEY = "agents-ui-active-project-id";
const STORAGE_SESSIONS_KEY = "agents-ui-sessions-v1";
const STORAGE_ACTIVE_SESSION_BY_PROJECT_KEY = "agents-ui-active-session-by-project-v1";

const MAX_PENDING_SESSIONS = 32;
const MAX_PENDING_CHUNKS_PER_SESSION = 200;

const PRESETS: Array<{ name: string; command: string }> = [
  { name: "codex", command: "codex" },
  { name: "claude", command: "claude" }
];

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

function parseEnvContentToVars(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
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
    projects: [{ id, title: "Default", basePath: null, environmentId: null }],
    activeProjectId: id,
  };
}

type PersistedSession = {
  persistId: string;
  projectId: string;
  name: string;
  launchCommand: string | null;
  restoreCommand?: string | null;
  lastRecordingId?: string | null;
  cwd: string | null;
  createdAt: number;
};

type PersistedStateV1 = {
  schemaVersion: number;
  projects: Project[];
  activeProjectId: string;
  sessions: PersistedSession[];
  activeSessionByProject: Record<string, string>;
  prompts?: Prompt[];
  environments?: EnvironmentConfig[];
};

type DirectoryEntry = { name: string; path: string };
type DirectoryListing = { path: string; parent: string | null; entries: DirectoryEntry[] };

type Prompt = {
  id: string;
  title: string;
  content: string;
  createdAt: number;
};

type EnvironmentConfig = {
  id: string;
  name: string;
  content: string;
  createdAt: number;
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
          .map((p) => ({ id: p.id, title: p.title, basePath: null, environmentId: null }));
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
  lastRecordingId?: string | null;
  cwd?: string | null;
  envVars?: Record<string, string> | null;
  persistId?: string;
  createdAt?: number;
}): Promise<Session> {
  const trimmedCommand = (input.launchCommand ?? "").trim();
  const launchCommand = trimmedCommand ? trimmedCommand : null;
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
  });
  return {
    ...info,
    projectId: input.projectId,
    persistId: input.persistId ?? makeId(),
    createdAt: input.createdAt ?? Date.now(),
    launchCommand,
    restoreCommand: input.restoreCommand ?? null,
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

export default function App() {
  const [initialProjectState] = useState(() => defaultProjectState());
  const [projects, setProjects] = useState<Project[]>(initialProjectState.projects);
  const [activeProjectId, setActiveProjectId] = useState<string>(initialProjectState.activeProjectId);
  const [activeSessionByProject, setActiveSessionByProject] = useState<Record<string, string>>({});

  const [sessions, setSessions] = useState<Session[]>([]);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentConfig[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCommand, setNewCommand] = useState("");
  const [newCwd, setNewCwd] = useState("");
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectMode, setProjectMode] = useState<"new" | "rename">("new");
  const [projectTitle, setProjectTitle] = useState("");
  const [projectBasePath, setProjectBasePath] = useState("");
  const [projectEnvironmentId, setProjectEnvironmentId] = useState<string>("");
  const [confirmDeleteProjectOpen, setConfirmDeleteProjectOpen] = useState(false);
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
  const [error, setError] = useState<string | null>(null);

  const registry = useRef<TerminalRegistry>(new Map());
  const pendingData = useRef<PendingDataBuffer>(new Map());
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
  const projectTitleRef = useRef<HTMLInputElement | null>(null);
  const homeDirRef = useRef<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const pendingSaveRef = useRef<PersistedStateV1 | null>(null);
  const agentIdleTimersRef = useRef<Map<string, number>>(new Map());

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

  function markAgentWorking(id: string) {
    const s = sessionsRef.current.find((s) => s.id === id);
    if (!s) return;
    if (!s.effectId || s.exited || s.closing) return;

    if (!s.agentWorking) {
      setSessions((prev) =>
        prev.map((session) =>
          session.id === id ? { ...session, agentWorking: true } : session,
        ),
      );
    }
    scheduleAgentIdle(id, s.effectId);
  }

  const active = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId],
  );

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
    if (!hydrated) return;
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
        lastRecordingId: s.lastRecordingId ?? null,
        cwd: s.cwd,
        createdAt: s.createdAt,
      }))
      .sort((a, b) => a.createdAt - b.createdAt);

    pendingSaveRef.current = {
      schemaVersion: 1,
      projects,
      activeProjectId,
      sessions: persistedSessions,
      activeSessionByProject,
      prompts,
      environments,
    };

    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      const state = pendingSaveRef.current;
      if (!state) return;
      void invoke("save_persisted_state", { state }).catch((err) => {
        reportError("Failed to save state", err);
      });
    }, 400);
  }, [projects, activeProjectId, activeSessionByProject, sessions, prompts, environments, hydrated]);

  const activeAgentCount = useMemo(() => {
    return sessions.filter(
      (s) => s.projectId === activeProjectId && Boolean(s.effectId) && !s.exited && !s.closing,
    ).length;
  }, [sessions, activeProjectId]);

  const lastTrayCountRef = useRef<number | null>(null);
  useEffect(() => {
    if (!hydrated) return;
    if (lastTrayCountRef.current === activeAgentCount) return;
    lastTrayCountRef.current = activeAgentCount;
    void invoke("set_tray_agent_count", { count: activeAgentCount }).catch(() => {});
  }, [activeAgentCount, hydrated]);

  useEffect(() => {
    if (!newOpen) return;
    const base = activeProject?.basePath ?? homeDirRef.current ?? "";
    setNewCwd(base);
    window.setTimeout(() => {
      newNameRef.current?.focus();
    }, 0);
  }, [newOpen, activeProject?.basePath]);

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
	    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
	    const onKeyDown = (e: KeyboardEvent) => {
        const modalOpen =
          newOpen ||
          projectOpen ||
          pathPickerOpen ||
          confirmDeleteProjectOpen ||
          replayOpen ||
          recordPromptOpen ||
          recordingsOpen ||
          promptsOpen ||
          promptEditorOpen ||
          environmentsOpen ||
          environmentEditorOpen;

	      if (e.key === "Escape" && modalOpen) {
	        e.preventDefault();
          if (environmentEditorOpen) {
            setEnvironmentEditorOpen(false);
            return;
          }
          if (environmentsOpen) {
            setEnvironmentsOpen(false);
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
          if (newOpen) {
            setNewOpen(false);
            return;
          }
          return;
	      }

        if (modalOpen) return;

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

	    window.addEventListener("keydown", onKeyDown);
	    return () => window.removeEventListener("keydown", onKeyDown);
	  }, [
      newOpen,
      projectOpen,
      pathPickerOpen,
      confirmDeleteProjectOpen,
      replayOpen,
      recordPromptOpen,
      recordingsOpen,
      promptsOpen,
      promptEditorOpen,
      environmentsOpen,
      environmentEditorOpen,
    ]);

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

    try {
      const rec = await invoke<LoadedRecording>("load_recording", {
        recordingId,
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

  async function deleteRecording(recordingId: string) {
    if (!window.confirm("Delete this recording?")) return;
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

  function deletePrompt(id: string) {
    if (!window.confirm("Delete this prompt?")) return;
    setPrompts((prev) => prev.filter((p) => p.id !== id));
  }

  async function sendPromptToActive(prompt: Prompt, mode: "paste" | "send") {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    const data = (() => {
      if (mode === "paste") return prompt.content;
      const text = prompt.content;
      if (text.endsWith("\n") || text.endsWith("\r")) return text;
      return `${text}\n`;
    })();
    try {
      await invoke("write_to_session", { id: sessionId, data, source: "user" });
    } catch (err) {
      reportError("Failed to send prompt", err);
    }
  }

  function openEnvironmentEditor(env?: EnvironmentConfig) {
    setEnvironmentsOpen(false);
    setEnvironmentEditorId(env?.id ?? null);
    setEnvironmentEditorName(env?.name ?? "");
    setEnvironmentEditorContent(env?.content ?? "");
    setEnvironmentEditorOpen(true);
    window.setTimeout(() => envNameRef.current?.focus(), 0);
  }

  function closeEnvironmentEditor() {
    setEnvironmentEditorOpen(false);
    setEnvironmentEditorId(null);
    setEnvironmentEditorName("");
    setEnvironmentEditorContent("");
  }

  function saveEnvironmentFromEditor() {
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

  function deleteEnvironment(id: string) {
    if (!window.confirm("Delete this environment?")) return;
    setEnvironments((prev) => prev.filter((e) => e.id !== id));
    setProjects((prev) =>
      prev.map((p) => (p.environmentId === id ? { ...p, environmentId: null } : p)),
    );
    if (projectEnvironmentId === id) setProjectEnvironmentId("");
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
      const created = await createSession({
        projectId,
        name,
        launchCommand: bootstrapCommand,
        cwd,
        envVars: envVarsForProjectId(projectId, projects, environments),
      });
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
      await invoke("write_to_session", { id: targetId, data: chunk, source: "system" });
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
    const nextRestoreCommand = effect ? trimmed : null;
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

  function openNewProject() {
    setNewOpen(false);
    setProjectMode("new");
    setProjectTitle("");
    setProjectBasePath(active?.cwd ?? activeProject?.basePath ?? homeDirRef.current ?? "");
    setProjectEnvironmentId(activeProject?.environmentId ?? "");
    setProjectOpen(true);
  }

  function openRenameProject() {
    if (!activeProject) return;
    setNewOpen(false);
    setProjectMode("rename");
    setProjectTitle(activeProject.title);
    setProjectBasePath(activeProject.basePath ?? "");
    setProjectEnvironmentId(activeProject.environmentId ?? "");
    setProjectOpen(true);
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
            ? { ...p, title, basePath: validatedBasePath, environmentId }
            : p,
        ),
      );
      setProjectOpen(false);
      return;
    }

    const id = makeId();
    const project: Project = { id, title, basePath: validatedBasePath, environmentId };
    setProjects((prev) => [...prev, project]);
    setProjectOpen(false);
    setActiveProjectId(id);

    try {
      const s = await createSession({
        projectId: id,
        cwd: validatedBasePath,
        envVars: envVarsForProjectId(id, [...projects, project], environments),
      });
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
        const s = await createSession({
          projectId: fallback.id,
          cwd: fallback.basePath ?? null,
          envVars: envVarsForProjectId(fallback.id, [fallback], environments),
        });
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
      // Set up event listeners FIRST, before creating any sessions
      const unlistenOutput = await listen<PtyOutput>("pty-output", (event) => {
        if (cancelled) return;
        const { id, data } = event.payload;

        // Ignore events for sessions being closed
        if (closingSessions.current.has(id)) return;

        markAgentWorking(id);

        const entry = registry.current.get(id);
        if (entry) {
          entry.term.write(data);
        } else {
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

        pendingData.current.delete(id);
        clearAgentIdleTimer(id);

        const timeout = closingSessions.current.get(id);
        if (timeout !== undefined) {
          window.clearTimeout(timeout);
          closingSessions.current.delete(id);
          return;
        }

        setSessions((prev) =>
          prev.map((s) =>
            s.id === id
              ? {
                  ...s,
                  exited: true,
                  exitCode: exit_code ?? null,
                  agentWorking: false,
                  recordingActive: false,
                }
              : s,
          ),
        );
      });
      unlisteners.push(unlistenExit);

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

      const legacyProjects = loadLegacyProjectState();
      const legacySessions = loadLegacyPersistedSessions();
      const legacyActiveSessionByProject = loadLegacyActiveSessionByProject();

      const diskState = await invoke<PersistedStateV1 | null>("load_persisted_state").catch(
        () => null,
      );

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
      setPrompts(state.prompts ?? []);
      setEnvironments(state.environments ?? []);

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
          const created = await createSession({
            projectId: s.projectId,
            name: s.name,
            launchCommand: s.launchCommand,
            restoreCommand: s.restoreCommand ?? null,
            lastRecordingId: s.lastRecordingId ?? null,
            cwd: s.cwd ?? projectById.get(s.projectId)?.basePath ?? resolvedHome ?? null,
            envVars: envVarsForProject(s.projectId),
            persistId: s.persistId,
            createdAt: s.createdAt,
          });
          restored.push(created);

          const restoreCmd =
            (s.launchCommand ? null : (s.restoreCommand ?? null))?.trim() ?? null;
          if (restoreCmd) {
            const singleLine = restoreCmd.replace(/\r?\n/g, " ");
            void invoke("write_to_session", {
              id: created.id,
              data: `${singleLine}\n`,
              source: "system",
            }).catch(() => {});
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
          first = await createSession({
            projectId: activeProjectId,
            cwd: basePath,
            envVars: envVarsForProject(activeProjectId),
          });
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
        void closeSession(id).catch(() => {});
      }
    };
  }, []);

  async function onNewSubmit(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim() || undefined;
    try {
      const launchCommand = newCommand.trim() || null;
      const desiredCwd =
        newCwd.trim() || activeProject?.basePath || homeDirRef.current || "";
      const validatedCwd = await invoke<string | null>("validate_directory", {
        path: desiredCwd,
      }).catch(() => null);
      if (!validatedCwd) {
        setError("Working directory must be an existing folder.");
        return;
      }
      const s = await createSession({
        projectId: activeProjectId,
        name,
        launchCommand,
        cwd: validatedCwd,
        envVars: envVarsForProjectId(activeProjectId, projects, environments),
      });
      setSessions((prev) => [...prev, s]);
      setActiveId(s.id);
      setNewOpen(false);
      setNewName("");
      setNewCommand("");
      setNewCwd("");
    } catch (err) {
      reportError("Failed to create session", err);
    }
  }

  async function onClose(id: string) {
    clearAgentIdleTimer(id);
    const session = sessionsRef.current.find((s) => s.id === id) ?? null;
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

    try {
      await closeSession(id);
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

  async function quickStart(preset: { name: string; command: string }) {
    try {
      const cwd = activeProject?.basePath ?? homeDirRef.current ?? null;
      const s = await createSession({
        projectId: activeProjectId,
        name: preset.name,
        launchCommand: preset.command,
        cwd,
        envVars: envVarsForProjectId(activeProjectId, projects, environments),
      });
      setSessions((prev) => [...prev, s]);
      setActiveId(s.id);
    } catch (err) {
      reportError(`Failed to start ${preset.name}`, err);
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebarHeader">
          <div className="title">Projects</div>
          <button className="btn" onClick={openNewProject}>
            New
          </button>
        </div>

        <div className="projectList">
          {projects.map((p) => {
            const isActive = p.id === activeProjectId;
            const count = sessionCountByProject.get(p.id) ?? 0;
            return (
	              <button
	                key={p.id}
	                className={`projectItem ${isActive ? "projectItemActive" : ""}`}
	                onClick={() => selectProject(p.id)}
	                title={p.basePath ? `${p.title} — ${p.basePath}` : p.title}
	              >
                <span className="projectTitle">{p.title}</span>
                <span className="projectCount">{count}</span>
              </button>
            );
          })}
        </div>

        <div className="projectActions">
          <button className="btn" onClick={openRenameProject} disabled={!activeProject}>
            Rename
          </button>
          <button className="btn" onClick={() => setConfirmDeleteProjectOpen(true)} disabled={!activeProject}>
            Delete
          </button>
        </div>

        <div className="divider" />

        <div className="sidebarHeader">
          <div className="title">Sessions</div>
          <button
            className="btn"
            onClick={() => {
              setProjectOpen(false);
              setNewOpen(true);
            }}
          >
            New
          </button>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {PRESETS.map((p) => (
            <button key={p.name} className="btn" onClick={() => quickStart(p)}>
              {p.name}
            </button>
          ))}
        </div>

        <div className="sessionList">
          {projectSessions.length === 0 ? (
            <div className="empty">No sessions in this project.</div>
          ) : (
            projectSessions.map((s) => {
              const isActive = s.id === activeId;
              const isExited = Boolean(s.exited);
              const isClosing = Boolean(s.closing);
              const effect = getProcessEffectById(s.effectId);
              const chipLabel = effect?.label ?? s.processTag ?? null;
              const isWorking = Boolean(effect && s.agentWorking && !isExited && !isClosing);
              const isRecording = Boolean(s.recordingActive && !isExited && !isClosing);
              const chipClass = effect ? `chip chip-${effect.id}` : "chip";
              return (
                <div
                  key={s.id}
                  className={`sessionItem ${isActive ? "sessionItemActive" : ""} ${
                    isExited ? "sessionItemExited" : ""
                  } ${isClosing ? "sessionItemClosing" : ""}`}
                  onClick={() => setActiveId(s.id)}
                >
                  <div className={`dot ${isActive ? "dotActive" : ""}`} />
                  <div className="sessionMeta">
                    <div className="sessionName">
                      <span className="sessionNameText">{s.name}</span>
                      {chipLabel && (
                        <span className={chipClass}>
                          <span className="chipLabel">{chipLabel}</span>
                          {isWorking && <span className="chipActivity" aria-label="Working" />}
                        </span>
                      )}
                      {isRecording && <span className="recordingDot" title="Recording" />}
                      {isClosing ? (
                        <span className="sessionStatus">closing…</span>
                      ) : isExited ? (
                        <span className="sessionStatus">
                          exited{s.exitCode != null ? ` ${s.exitCode}` : ""}
                        </span>
                      ) : null}
                    </div>
                    <div className="sessionCmd">
                      {(() => {
                        const parts: string[] = [];
                        if (s.cwd) parts.push(shortenPathSmart(s.cwd, 44));
                        if (s.launchCommand) parts.push(s.launchCommand);
                        if (!parts.length) parts.push(s.command);
                        return parts.join(" • ");
                      })()}
                    </div>
                  </div>
                  <button
                    className="closeBtn"
                    disabled={isClosing}
                    onClick={(e) => {
                      e.stopPropagation();
                      void onClose(s.id);
                    }}
                    title="Close session"
                  >
                    ×
                  </button>
                </div>
              );
            })
          )}
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div className="activeTitle">
            {activeProject ? `Project: ${activeProject.title}` : "Project: —"}
            {activeProject?.basePath ? ` • ${shortenPathSmart(activeProject.basePath, 44)}` : ""}
            {active ? ` • Session: ${active.name}` : " • No active session"}
          </div>
          <div className="topbarRight">
            {error ? (
              <div className="errorBanner" role="alert">
                <div className="errorText">{error}</div>
                <button className="errorClose" onClick={() => setError(null)} title="Dismiss">
                  ×
                </button>
              </div>
            ) : (
              <div className="hint">New: ⌘T / Ctrl+Shift+T • Close: ⌘W / Ctrl+Shift+W</div>
            )}

            {active && (
              <>
                <button
                  className={`btnSmall ${active.recordingActive ? "btnRecording" : ""}`}
                  onClick={() =>
                    active.recordingActive ? void stopRecording(active.id) : openRecordPrompt(active.id)
                  }
                  disabled={Boolean(active.exited || active.closing)}
                  title={active.recordingActive ? "Stop recording" : "Start recording"}
                >
                  {active.recordingActive ? "Stop" : "Record"}
                </button>
                <button
                  className="btnSmall"
                  onClick={() => {
                    setRecordingsOpen(true);
                    void refreshRecordings();
                  }}
                  title="Browse recordings"
                >
                  Recordings
                </button>
                <button
                  className="btnSmall"
                  onClick={() => setPromptsOpen(true)}
                  title="Prompt library"
                >
                  Prompts
                </button>
                <button
                  className="btnSmall"
                  onClick={() => void openReplayForActive()}
                  disabled={!active.lastRecordingId}
                  title={active.lastRecordingId ? "Replay last recording" : "No recording yet"}
                >
                  Replay
                </button>
              </>
            )}
          </div>
        </div>

        <div className="terminalArea">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`terminalContainer ${
                s.id === activeId ? "" : "terminalHidden"
              }`}
            >
              <SessionTerminal
                id={s.id}
                active={s.id === activeId}
                readOnly={Boolean(s.exited || s.closing)}
                onCwdChange={onCwdChange}
                onCommandChange={onCommandChange}
                onUserEnter={() => markAgentWorking(s.id)}
                registry={registry}
                pendingData={pendingData}
              />
            </div>
          ))}

          {newOpen && (
            <div className="modalBackdrop" onClick={() => setNewOpen(false)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <h3 className="modalTitle">
                  New session{activeProject ? ` — ${activeProject.title}` : ""}
                </h3>
                <form onSubmit={onNewSubmit}>
                  <div className="formRow">
                    <div className="label">Name (optional)</div>
                    <input
                      className="input"
                      ref={newNameRef}
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="e.g. codex"
                    />
                  </div>
                  <div className="formRow">
                    <div className="label">Command (optional)</div>
                    <input
                      className="input"
                      value={newCommand}
                      onChange={(e) => setNewCommand(e.target.value)}
                      placeholder="e.g. codex  (leave blank for a shell)"
                    />
                    <div className="hint">
                      Uses your $SHELL by default; commands run as "$SHELL -lc".
                    </div>
                  </div>
                  <div className="formRow">
                    <div className="label">Working directory</div>
                    <div className="pathRow">
                      <input
                        className="input"
                        value={newCwd}
                        onChange={(e) => setNewCwd(e.target.value)}
                        placeholder={activeProject?.basePath ?? "~"}
                      />
                      <button
                        type="button"
                        className="btn"
                        onClick={() =>
                          openPathPicker(
                            "session",
                            newCwd.trim() || activeProject?.basePath || null,
                          )
                        }
                      >
                        Browse
                      </button>
                    </div>
                    <div className="pathActions">
                      <button
                        type="button"
                        className="btnSmall"
                        onClick={() => setNewCwd(activeProject?.basePath ?? "")}
                        disabled={!activeProject?.basePath}
                      >
                        Use project base
                      </button>
                      <button
                        type="button"
                        className="btnSmall"
                        onClick={() => setNewCwd(active?.cwd ?? "")}
                        disabled={!active?.cwd}
                      >
                        Use current tab
                      </button>
                    </div>
                  </div>
                  <div className="modalActions">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setNewOpen(false)}
                    >
                      Cancel
                    </button>
                    <button type="submit" className="btn">
                      Create
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {projectOpen && (
            <div className="modalBackdrop" onClick={() => setProjectOpen(false)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <h3 className="modalTitle">
                  {projectMode === "new" ? "New project" : "Project settings"}
                </h3>
                <form onSubmit={onProjectSubmit}>
                  <div className="formRow">
                    <div className="label">Title</div>
                    <input
                      className="input"
                      ref={projectTitleRef}
                      value={projectTitle}
                      onChange={(e) => setProjectTitle(e.target.value)}
                      placeholder="e.g. my-repo"
                    />
                  </div>
                  <div className="formRow">
                    <div className="label">Base path</div>
                    <div className="pathRow">
                      <input
                        className="input"
                        value={projectBasePath}
                        onChange={(e) => setProjectBasePath(e.target.value)}
                        placeholder={homeDirRef.current ?? "~"}
                      />
                      <button
                        type="button"
                        className="btn"
                        onClick={() =>
                          openPathPicker(
                            "project",
                            projectBasePath.trim() || activeProject?.basePath || null,
                          )
                        }
                      >
                        Browse
                      </button>
                    </div>
                    <div className="pathActions">
                      <button
                        type="button"
                        className="btnSmall"
                        onClick={() => setProjectBasePath(active?.cwd ?? "")}
                        disabled={!active?.cwd}
                      >
                        Use current tab
                      </button>
                      <button
                        type="button"
                        className="btnSmall"
                        onClick={() => setProjectBasePath(homeDirRef.current ?? "")}
                        disabled={!homeDirRef.current}
                      >
                        Home
                      </button>
                    </div>
                    <div className="hint">New sessions in this project start here.</div>
                  </div>
                  <div className="formRow">
                    <div className="label">Environment (.env)</div>
                    <div className="pathRow">
                      <select
                        className="input"
                        value={projectEnvironmentId}
                        onChange={(e) => setProjectEnvironmentId(e.target.value)}
                      >
                        <option value="">None</option>
                        {environments
                          .slice()
                          .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
                          .map((env) => (
                            <option key={env.id} value={env.id}>
                              {env.name}
                            </option>
                          ))}
                      </select>
                      <button type="button" className="btn" onClick={() => setEnvironmentsOpen(true)}>
                        Manage
                      </button>
                    </div>
                    <div className="hint">Applied to new sessions in this project.</div>
                  </div>
                  <div className="modalActions">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setProjectOpen(false)}
                    >
                      Cancel
                    </button>
                    <button type="submit" className="btn">
                      {projectMode === "new" ? "Create" : "Save"}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {confirmDeleteProjectOpen && activeProject && (
            <div
              className="modalBackdrop"
              onClick={() => setConfirmDeleteProjectOpen(false)}
            >
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <h3 className="modalTitle">Delete project</h3>
                <div className="hint" style={{ marginTop: 0 }}>
                  Delete "{activeProject.title}"? All sessions in this project will be closed.
                </div>
                <div className="modalActions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setConfirmDeleteProjectOpen(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setConfirmDeleteProjectOpen(false);
                      void deleteActiveProject();
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          )}

          {pathPickerOpen && (
            <div
              className="modalBackdrop"
              onClick={() => {
                setPathPickerOpen(false);
                setPathPickerTarget(null);
              }}
            >
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <h3 className="modalTitle">Select folder</h3>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void loadPathPicker(pathPickerInput.trim() || null);
                  }}
                >
                  <div className="pathPickerHeader">
                    <button
                      type="button"
                      className="btn"
                      disabled={!pathPickerListing?.parent || pathPickerLoading}
                      onClick={() => void loadPathPicker(pathPickerListing?.parent ?? null)}
                      title="Up"
                    >
                      Up
                    </button>
                    <input
                      className="input"
                      value={pathPickerInput}
                      onChange={(e) => setPathPickerInput(e.target.value)}
                      placeholder={homeDirRef.current ?? "~"}
                    />
                    <button type="submit" className="btn" disabled={pathPickerLoading}>
                      Go
                    </button>
                  </div>
                </form>

                {pathPickerError && (
                  <div className="pathPickerError" role="alert">
                    {pathPickerError}
                  </div>
                )}

                <div className="pathPickerList">
                  {pathPickerLoading ? (
                    <div className="empty">Loading…</div>
                  ) : pathPickerListing && pathPickerListing.entries.length === 0 ? (
                    <div className="empty">No subfolders.</div>
                  ) : (
                    pathPickerListing?.entries.map((e) => (
                      <button
                        key={e.path}
                        type="button"
                        className="pathPickerItem"
                        onClick={() => void loadPathPicker(e.path)}
                        title={e.path}
                      >
                        {e.name}
                      </button>
                    ))
                  )}
                </div>

                <div className="modalActions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setPathPickerOpen(false);
                      setPathPickerTarget(null);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={!pathPickerListing}
                    onClick={() => {
                      const selected = pathPickerListing?.path;
                      if (!selected) return;
                      if (pathPickerTarget === "project") setProjectBasePath(selected);
                      if (pathPickerTarget === "session") setNewCwd(selected);
                      setPathPickerOpen(false);
                      setPathPickerTarget(null);
                    }}
                  >
                    Select
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
                      onChange={(e) => setRecordPromptName(e.target.value)}
                      placeholder="e.g. Fix failing tests"
                    />
                    <div className="hint" style={{ marginTop: 0 }}>
                      Records only your input. Replay is manual step-by-step.
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
                              className="btnSmall"
                              onClick={() => void deleteRecording(r.recordingId)}
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
                                className="btnSmall"
                                onClick={() => deletePrompt(p.id)}
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
                      onChange={(e) => setPromptEditorTitle(e.target.value)}
                      placeholder="e.g. Write a test plan"
                    />
                  </div>
                  <div className="formRow">
                    <div className="label">Prompt</div>
                    <textarea
                      className="textarea"
                      value={promptEditorContent}
                      onChange={(e) => setPromptEditorContent(e.target.value)}
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
                        const vars = parseEnvContentToVars(env.content);
                        const count = Object.keys(vars).length;
                        return (
                          <div key={env.id} className="recordingItem">
                            <div className="recordingMain">
                              <div className="recordingName" title={env.name}>
                                {env.name}
                              </div>
                              <div className="recordingMeta">
                                {[when, `${count} vars`].filter(Boolean).join(" • ")}
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
                                className="btnSmall"
                                onClick={() => deleteEnvironment(env.id)}
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
                      onChange={(e) => setEnvironmentEditorName(e.target.value)}
                      placeholder="e.g. staging"
                    />
                  </div>
                  <div className="formRow">
                    <div className="label">.env</div>
                    <textarea
                      className="textarea"
                      value={environmentEditorContent}
                      onChange={(e) => setEnvironmentEditorContent(e.target.value)}
                      placeholder={"KEY=value\n# Comments supported"}
                    />
                    <div className="hint" style={{ marginTop: 0 }}>
                      Parsed like an <code>.env</code> file. Applied to new sessions in a project.
                    </div>
                  </div>
                  <div className="modalActions">
                    <button type="button" className="btn" onClick={closeEnvironmentEditor}>
                      Cancel
                    </button>
                    <button type="submit" className="btn" disabled={!environmentEditorName.trim()}>
                      Save
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {replayOpen && (
            <div className="modalBackdrop" onClick={closeReplayModal}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
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
                      <div className="label">{replayShowAll ? "All inputs" : "Next input"}</div>
                      <div className="replayPreview">
                        {replayShowAll
                          ? replaySteps.join("")
                          : replaySteps[replayIndex]
                            ? replaySteps[replayIndex]
                            : "Done."}
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
                    {replayShowAll ? "View step" : "View all"}
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
        </div>
      </main>
    </div>
  );
}
