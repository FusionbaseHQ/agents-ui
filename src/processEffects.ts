export type ProcessEffect = {
  id: string;
  label: string;
  matchCommands: string[];
};

export const PROCESS_EFFECTS: ProcessEffect[] = [
  { id: "codex", label: "codex", matchCommands: ["codex"] },
  { id: "claude", label: "claude", matchCommands: ["claude"] },
];

function normalizeCommandToken(token: string): string {
  const base = token.trim().split(/[\\/]/).pop() ?? token.trim();
  return base.toLowerCase().replace(/\.exe$/, "");
}

function firstToken(commandLine: string): string | null {
  const trimmed = commandLine.trim();
  if (!trimmed) return null;
  const token = trimmed.split(/\s+/)[0];
  return normalizeCommandToken(token);
}

export function commandTagFromCommandLine(commandLine: string | null | undefined): string | null {
  if (!commandLine) return null;
  return firstToken(commandLine);
}

export function detectProcessEffect(input: {
  command?: string | null;
  name?: string | null;
}): ProcessEffect | null {
  const cmd = input.command ? firstToken(input.command) : null;
  const name = input.name ? normalizeCommandToken(input.name) : null;

  if (!cmd && !name) return null;

  for (const effect of PROCESS_EFFECTS) {
    const matches =
      (cmd && effect.matchCommands.includes(cmd)) ||
      (name && effect.matchCommands.includes(name));
    if (matches) return effect;
  }
  return null;
}

export function getProcessEffectById(id: string | null | undefined): ProcessEffect | null {
  if (!id) return null;
  return PROCESS_EFFECTS.find((e) => e.id === id) ?? null;
}
