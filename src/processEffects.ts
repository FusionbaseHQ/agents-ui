const claudeIcon = "/agent-icons/claude-code-icon.png";
const codexIcon = "/agent-icons/openai-codex-icon.png";
const geminiIcon = "/agent-icons/gemini-logo.png";

export type ProcessEffect = {
  id: string;
  label: string;
  matchCommands: string[];
  idleAfterMs?: number;
  iconSrc?: string;
};

export const PROCESS_EFFECTS: ProcessEffect[] = [
  { id: "codex", label: "codex", matchCommands: ["codex"], idleAfterMs: 2000, iconSrc: codexIcon },
  { id: "claude", label: "claude", matchCommands: ["claude"], idleAfterMs: 2000, iconSrc: claudeIcon },
  { id: "gemini", label: "gemini", matchCommands: ["gemini"], idleAfterMs: 2000, iconSrc: geminiIcon },
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
