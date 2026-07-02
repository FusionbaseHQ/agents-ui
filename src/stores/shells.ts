// Shells domain store — first tranche of the App.tsx state decomposition.
// Module-level state + useSyncExternalStore hook (same pattern as src/ui/toast):
// plain functions everywhere (event handlers, async code) read/write the
// current state without refs or prop drilling; React components subscribe via
// useShellsStore(). Owns: detected shells, detection loading, and the
// app-global default shell (Settings → Terminal, persisted in localStorage).
import { useSyncExternalStore } from "react";
import { type ShellChoice, type ShellInfo, detectShells } from "../shells";

const STORAGE_APP_DEFAULT_SHELL_KEY = "agents-ui-app-default-shell-v1";

type ShellsState = {
  detectedShells: ShellInfo[];
  shellsLoading: boolean;
  /** App-global default shell. null ⇒ bundled agsh (the app default). */
  appDefaultShell: ShellChoice | null;
};

function loadPersistedAppDefaultShell(): ShellChoice | null {
  try {
    const raw = localStorage.getItem(STORAGE_APP_DEFAULT_SHELL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ShellChoice;
    if (parsed && parsed.kind === "bundled-nu") return { kind: "bundled-nu" };
    if (parsed && parsed.kind === "system" && typeof parsed.path === "string" && parsed.path) {
      return { kind: "system", path: parsed.path, family: parsed.family ?? "" };
    }
    return null;
  } catch {
    return null;
  }
}

let state: ShellsState = {
  detectedShells: [],
  shellsLoading: false,
  appDefaultShell: loadPersistedAppDefaultShell(),
};

const listeners = new Set<() => void>();

function setState(partial: Partial<ShellsState>) {
  state = { ...state, ...partial };
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ShellsState {
  return state;
}

/** React subscription to the shells domain. */
export function useShellsStore(): ShellsState {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Enumerate installed shells (backend-cached); `refresh` forces a re-scan. */
export async function loadShells(refresh = false): Promise<ShellInfo[]> {
  setState({ shellsLoading: true });
  try {
    const list = await detectShells(refresh);
    setState({ detectedShells: list });
    return list;
  } finally {
    setState({ shellsLoading: false });
  }
}

export function setAppDefaultShell(choice: ShellChoice | null) {
  setState({ appDefaultShell: choice });
  try {
    if (choice) localStorage.setItem(STORAGE_APP_DEFAULT_SHELL_KEY, JSON.stringify(choice));
    else localStorage.removeItem(STORAGE_APP_DEFAULT_SHELL_KEY);
  } catch {
    // Best-effort: localStorage may be unavailable in some contexts.
  }
}

/** Shell for a new session: project default > app default (Settings) > bundled agsh. */
export function shellChoiceForProject(
  project: { defaultShell?: ShellChoice | null } | null | undefined,
): ShellChoice | null {
  return project?.defaultShell ?? state.appDefaultShell ?? null;
}
