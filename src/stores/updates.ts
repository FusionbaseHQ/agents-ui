// Updates domain store (App.tsx decomposition, tranche 2): app info (name,
// version, homepage) and the GitHub-release update check. Same module-store
// pattern as stores/shells.ts.
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UpdateCheckState } from "../components/modals/UpdateModal";

export type AppInfo = { name: string; version: string; homepage?: string | null };

type UpdatesState = {
  appInfo: AppInfo | null;
  updateCheckState: UpdateCheckState;
};

let state: UpdatesState = {
  appInfo: null,
  updateCheckState: { status: "idle" },
};

const listeners = new Set<() => void>();

function setState(partial: Partial<UpdatesState>) {
  state = { ...state, ...partial };
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): UpdatesState {
  return state;
}

/** React subscription to the updates domain. */
export function useUpdatesStore(): UpdatesState {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function parseGithubRepo(value: string | null | undefined): { owner: string; repo: string } | null {
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

function formatUpdateError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}

/** Fetch app name/version/homepage from the backend (idempotent). */
export async function fetchAppInfo(): Promise<AppInfo | null> {
  try {
    const info = await invoke<AppInfo>("get_app_info");
    setState({ appInfo: info });
    return info;
  } catch {
    return null;
  }
}

/** Query the GitHub latest release and compare against the running version. */
async function queryLatestRelease(): Promise<UpdateCheckState> {
  const info = await fetchAppInfo();
  if (!info) {
    return { status: "error", message: "Unable to read app info." };
  }

  const repo = parseGithubRepo(info.homepage);
  if (!repo) {
    return {
      status: "error",
      message: "Update source not configured. Set bundle.homepage to your GitHub repo URL.",
    };
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
      return { status: "error", message: "Latest release has no tag name." };
    }

    const current = info.version;
    const cmp = compareSemver(tag, current);

    const releaseUrl = fallbackReleaseUrl;
    const isNewer =
      cmp === null
        ? tag.trim().replace(/^v/i, "") !== current.trim().replace(/^v/i, "")
        : cmp > 0;

    return isNewer
      ? { status: "updateAvailable", latestVersion: tag, releaseUrl }
      : { status: "upToDate", latestVersion: tag, releaseUrl };
  } catch (err) {
    return { status: "error", message: `Update check failed: ${formatUpdateError(err)}` };
  }
}

/** Explicit check (Updates dialog / ⌘K): shows progress and surfaces errors. */
export async function checkForUpdates(): Promise<void> {
  setState({ updateCheckState: { status: "checking" } });
  setState({ updateCheckState: await queryLatestRelease() });
}

/**
 * Background check (startup + periodic): commits only definitive results —
 * errors (offline, rate limit) neither surface nor clobber existing state,
 * and no transient "checking" state flashes through the UI.
 */
export async function checkForUpdatesSilently(): Promise<UpdateCheckState> {
  const result = await queryLatestRelease();
  if (result.status === "updateAvailable" || result.status === "upToDate") {
    setState({ updateCheckState: result });
  }
  return result;
}
