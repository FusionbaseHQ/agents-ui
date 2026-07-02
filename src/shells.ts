// Bring-your-own-shell: shared types + helpers for selecting which shell a
// terminal session launches with. The app bundles two shells — agsh (the
// default) and Nushell — and a user can instead pick one of their own
// installed shells per project or per terminal.
import { invoke } from "@tauri-apps/api/core";

/** Shells that ship inside the app bundle (resolved to a binary at spawn time). */
export type BundledShellKind = "bundled-nu" | "bundled-agsh";

/** A shell selection. `bundled-agsh` is the default; `system` is an installed shell. */
export type ShellChoice =
  | { kind: "bundled-nu" }
  | { kind: "bundled-agsh" }
  | { kind: "system"; path: string; family: string };

/** One detected shell, as returned by the `detect_shells` backend command. */
export type ShellInfo = {
  id: string;
  kind: BundledShellKind | "system";
  family: string;
  displayName: string;
  path: string;
  version: string | null;
  verified: boolean;
  isLoginDefault: boolean;
  supportsIntegration: boolean;
};

/** The bundled Nushell shell. */
export const BUNDLED_NU: ShellChoice = { kind: "bundled-nu" };

/** The bundled agsh shell — the default choice when nothing is selected. */
export const BUNDLED_AGSH: ShellChoice = { kind: "bundled-agsh" };

/** Is this a shell that ships with the app (vs. one installed on the system)? */
export function isBundledKind(kind: string): kind is BundledShellKind {
  return kind === "bundled-nu" || kind === "bundled-agsh";
}

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

/** Map a stored choice to the `create_session` payload (`null` ⇒ bundled agsh, the default). */
export function shellChoiceToPayload(
  choice: ShellChoice | null | undefined,
): ShellChoice | null {
  if (!choice || choice.kind === "bundled-agsh") return null;
  return choice;
}

/** Turn a detected shell into a stored choice. */
export function shellInfoToChoice(info: ShellInfo): ShellChoice {
  if (isBundledKind(info.kind)) return { kind: info.kind };
  return { kind: "system", path: info.path, family: info.family };
}

/** Does this stored choice refer to this detected shell? */
export function choiceMatchesInfo(
  choice: ShellChoice | null | undefined,
  info: ShellInfo,
): boolean {
  const c = choice ?? BUNDLED_AGSH;
  if (c.kind !== "system") return info.kind === c.kind;
  return info.kind === "system" && info.path === c.path;
}

/** Short, tab-friendly name for a choice (e.g. "fish", "nu"). */
export function shellChoiceShortName(
  choice: ShellChoice | null | undefined,
): string | undefined {
  if (!choice || choice.kind === "bundled-agsh") return undefined;
  if (choice.kind === "bundled-nu") return "nu";
  return choice.family || undefined;
}

/** Human label for a choice, used in menus and settings. */
export function shellChoiceLabel(
  choice: ShellChoice | null | undefined,
  shells: ShellInfo[] = [],
): string {
  const c = choice ?? BUNDLED_AGSH;
  if (c.kind === "bundled-nu") return "Bundled Nushell";
  if (c.kind === "bundled-agsh") return "Bundled agsh";
  const match = shells.find((s) => choiceMatchesInfo(c, s));
  if (match) return match.displayName;
  return c.family ? c.family.charAt(0).toUpperCase() + c.family.slice(1) : c.path;
}
