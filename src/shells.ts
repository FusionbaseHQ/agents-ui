// Bring-your-own-shell: shared types + helpers for selecting which shell a
// terminal session launches with. The app defaults to bundled Nushell; a user
// can pick one of their own installed shells per project or per terminal.
import { invoke } from "@tauri-apps/api/core";

/** A shell selection. `bundled-nu` is the default; `system` is an installed shell. */
export type ShellChoice =
  | { kind: "bundled-nu" }
  | { kind: "system"; path: string; family: string };

/** One detected shell, as returned by the `detect_shells` backend command. */
export type ShellInfo = {
  id: string;
  kind: "bundled-nu" | "system";
  family: string;
  displayName: string;
  path: string;
  version: string | null;
  verified: boolean;
  isLoginDefault: boolean;
  supportsIntegration: boolean;
};

/** The default choice when nothing is selected. */
export const BUNDLED_NU: ShellChoice = { kind: "bundled-nu" };

/**
 * Enumerate installed shells. Backend-cached; pass `refresh` for a re-scan.
 * Never throws — returns `[]` if the command is unavailable (e.g. on Windows).
 */
export async function detectShells(refresh = false): Promise<ShellInfo[]> {
  try {
    return await invoke<ShellInfo[]>("detect_shells", { refresh });
  } catch {
    return [];
  }
}

/** Map a stored choice to the `create_session` payload (`null` ⇒ bundled default). */
export function shellChoiceToPayload(
  choice: ShellChoice | null | undefined,
): ShellChoice | null {
  if (!choice || choice.kind === "bundled-nu") return null;
  return choice;
}

/** Turn a detected shell into a stored choice. */
export function shellInfoToChoice(info: ShellInfo): ShellChoice {
  if (info.kind === "bundled-nu") return BUNDLED_NU;
  return { kind: "system", path: info.path, family: info.family };
}

/** Does this stored choice refer to this detected shell? */
export function choiceMatchesInfo(
  choice: ShellChoice | null | undefined,
  info: ShellInfo,
): boolean {
  const c = choice ?? BUNDLED_NU;
  if (c.kind === "bundled-nu") return info.kind === "bundled-nu";
  return info.kind === "system" && info.path === c.path;
}

/** Short, tab-friendly name for a choice (e.g. "fish", "zsh"). */
export function shellChoiceShortName(
  choice: ShellChoice | null | undefined,
): string | undefined {
  if (!choice || choice.kind === "bundled-nu") return undefined;
  return choice.family || undefined;
}

/** Human label for a choice, used in menus and settings. */
export function shellChoiceLabel(
  choice: ShellChoice | null | undefined,
  shells: ShellInfo[] = [],
): string {
  const c = choice ?? BUNDLED_NU;
  if (c.kind === "bundled-nu") return "Bundled Nushell";
  const match = shells.find((s) => choiceMatchesInfo(c, s));
  if (match) return match.displayName;
  return c.family ? c.family.charAt(0).toUpperCase() + c.family.slice(1) : c.path;
}
