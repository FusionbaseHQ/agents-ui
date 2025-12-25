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
  cwd: string | null;
  effectId?: string | null;
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

function defaultProjectState(): { projects: Project[]; activeProjectId: string } {
  const id = makeId();
  return { projects: [{ id, title: "Default", basePath: null }], activeProjectId: id };
}

type PersistedSession = {
  persistId: string;
  projectId: string;
  name: string;
  launchCommand: string | null;
  cwd: string | null;
  createdAt: number;
};

type PersistedStateV1 = {
  schemaVersion: number;
  projects: Project[];
  activeProjectId: string;
  sessions: PersistedSession[];
  activeSessionByProject: Record<string, string>;
};

type DirectoryEntry = { name: string; path: string };
type DirectoryListing = { path: string; parent: string | null; entries: DirectoryEntry[] };

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
          .map((p) => ({ id: p.id, title: p.title, basePath: null }));
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
  cwd?: string | null;
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
  });
  return {
    ...info,
    projectId: input.projectId,
    persistId: input.persistId ?? makeId(),
    createdAt: input.createdAt ?? Date.now(),
    launchCommand,
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
  const [confirmDeleteProjectOpen, setConfirmDeleteProjectOpen] = useState(false);
  const [pathPickerOpen, setPathPickerOpen] = useState(false);
  const [pathPickerTarget, setPathPickerTarget] = useState<"project" | "session" | null>(null);
  const [pathPickerListing, setPathPickerListing] = useState<DirectoryListing | null>(null);
  const [pathPickerInput, setPathPickerInput] = useState("");
  const [pathPickerLoading, setPathPickerLoading] = useState(false);
  const [pathPickerError, setPathPickerError] = useState<string | null>(null);
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
  const projectTitleRef = useRef<HTMLInputElement | null>(null);
  const homeDirRef = useRef<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const pendingSaveRef = useRef<PersistedStateV1 | null>(null);

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
    };

    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      const state = pendingSaveRef.current;
      if (!state) return;
      void invoke("save_persisted_state", { state }).catch((err) => {
        reportError("Failed to save state", err);
      });
    }, 400);
  }, [projects, activeProjectId, activeSessionByProject, sessions, hydrated]);

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
	    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
	    const onKeyDown = (e: KeyboardEvent) => {
	      if (e.key === "Escape" && (newOpen || projectOpen || pathPickerOpen || confirmDeleteProjectOpen)) {
	        e.preventDefault();
	        setNewOpen(false);
	        setProjectOpen(false);
	        setPathPickerOpen(false);
	        setConfirmDeleteProjectOpen(false);
	        return;
	      }

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
	  }, [newOpen, projectOpen, pathPickerOpen, confirmDeleteProjectOpen]);

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
    setProjectOpen(true);
  }

  function openRenameProject() {
    if (!activeProject) return;
    setNewOpen(false);
    setProjectMode("rename");
    setProjectTitle(activeProject.title);
    setProjectBasePath(activeProject.basePath ?? "");
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

    if (projectMode === "rename") {
      setProjects((prev) =>
        prev.map((p) =>
          p.id === activeProjectId ? { ...p, title, basePath: validatedBasePath } : p,
        ),
      );
      setProjectOpen(false);
      return;
    }

    const id = makeId();
    const project: Project = { id, title, basePath: validatedBasePath };
    setProjects((prev) => [...prev, project]);
    setProjectOpen(false);
    setActiveProjectId(id);

    try {
      const s = await createSession({ projectId: id, cwd: validatedBasePath });
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
      const fallback: Project = { id: makeId(), title: "Default", basePath: homeDirRef.current };
      setProjects([fallback]);
      setActiveProjectId(fallback.id);
      try {
        const s = await createSession({ projectId: fallback.id, cwd: fallback.basePath ?? null });
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

        const timeout = closingSessions.current.get(id);
        if (timeout !== undefined) {
          window.clearTimeout(timeout);
          closingSessions.current.delete(id);
          return;
        }

        setSessions((prev) =>
          prev.map((s) =>
            s.id === id
              ? { ...s, exited: true, exitCode: exit_code ?? null }
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
            cwd: s.cwd ?? projectById.get(s.projectId)?.basePath ?? resolvedHome ?? null,
            persistId: s.persistId,
            createdAt: s.createdAt,
          });
          restored.push(created);
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
          first = await createSession({ projectId: activeProjectId, cwd: basePath });
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
                      {chipLabel && <span className={chipClass}>{chipLabel}</span>}
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
        </div>
      </main>
    </div>
  );
}
