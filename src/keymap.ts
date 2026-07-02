// Declarative keyboard map. One table describes every global shortcut — its
// combo per platform, its display label, and its cheat-sheet grouping. The
// App keydown handler matches against this table and dispatches on binding id,
// replacing the old duplicated mac/non-mac if-ladders. The shortcuts modal
// renders the same table, so the cheat sheet can never drift from reality.

export type KeyBindingId =
  | "palette.open"
  | "files.search"
  | "terminal.search"
  | "shortcuts.show"
  | "session.new"
  | "session.close"
  | "session.next"
  | "session.prev"
  | "panel.prompts"
  | "panel.recordings"
  | "panel.assets"
  | "panel.agent"
  | "prompt.1"
  | "prompt.2"
  | "prompt.3"
  | "prompt.4"
  | "prompt.5";

export type KeyBinding = {
  id: KeyBindingId;
  title: string;
  section: "General" | "Sessions" | "Panels" | "Quick prompts";
  /** Combo string, e.g. "mod+shift+p", "ctrl+tab". "mod" = Cmd on macOS, Ctrl elsewhere. */
  mac: string;
  other: string;
};

const quickPrompt = (n: 1 | 2 | 3 | 4 | 5): KeyBinding => ({
  id: `prompt.${n}` as KeyBindingId,
  title: `Send pinned prompt ${n}`,
  section: "Quick prompts",
  mac: `mod+${n}`,
  other: `mod+${n}`,
});

export const KEY_BINDINGS: KeyBinding[] = [
  { id: "palette.open", title: "Open command palette", section: "General", mac: "mod+k", other: "mod+k" },
  { id: "files.search", title: "Search workspace files", section: "General", mac: "mod+p", other: "mod+p" },
  { id: "terminal.search", title: "Find in terminal", section: "General", mac: "mod+f", other: "ctrl+shift+f" },
  { id: "shortcuts.show", title: "Show keyboard shortcuts", section: "General", mac: "mod+/", other: "mod+/" },
  { id: "session.new", title: "New terminal", section: "Sessions", mac: "mod+t", other: "ctrl+shift+t" },
  { id: "session.close", title: "Close session", section: "Sessions", mac: "mod+w", other: "ctrl+shift+w" },
  { id: "session.next", title: "Next session", section: "Sessions", mac: "ctrl+tab", other: "ctrl+tab" },
  { id: "session.prev", title: "Previous session", section: "Sessions", mac: "ctrl+shift+tab", other: "ctrl+shift+tab" },
  { id: "panel.prompts", title: "Toggle Prompts panel", section: "Panels", mac: "mod+shift+p", other: "mod+shift+p" },
  { id: "panel.recordings", title: "Toggle Recordings panel", section: "Panels", mac: "mod+shift+r", other: "mod+shift+r" },
  { id: "panel.assets", title: "Toggle Assets panel", section: "Panels", mac: "mod+shift+a", other: "mod+shift+a" },
  { id: "panel.agent", title: "Toggle Agent panel", section: "Panels", mac: "mod+shift+g", other: "mod+shift+g" },
  quickPrompt(1),
  quickPrompt(2),
  quickPrompt(3),
  quickPrompt(4),
  quickPrompt(5),
];

type ParsedCombo = {
  key: string;
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
};

function parseCombo(combo: string): ParsedCombo {
  const parts = combo.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  return {
    key,
    mod: parts.includes("mod"),
    ctrl: parts.includes("ctrl"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
  };
}

function comboMatches(e: KeyboardEvent, combo: string, isMac: boolean): boolean {
  const c = parseCombo(combo);
  if (e.key.toLowerCase() !== c.key) return false;
  // Normalize "mod" per platform, then require an exact modifier match so
  // e.g. mod+t and mod+shift+t can never both fire.
  const metaRequired = isMac && c.mod;
  const ctrlRequired = c.ctrl || (!isMac && c.mod);
  if (e.metaKey !== metaRequired) return false;
  if (e.ctrlKey !== ctrlRequired) return false;
  if (e.shiftKey !== c.shift) return false;
  if (e.altKey !== c.alt) return false;
  return true;
}

/** Match a keydown against the table. Returns the binding id or null. */
export function matchBinding(e: KeyboardEvent, isMac: boolean): KeyBindingId | null {
  for (const b of KEY_BINDINGS) {
    if (comboMatches(e, isMac ? b.mac : b.other, isMac)) return b.id;
  }
  return null;
}

const MAC_KEY_GLYPHS: Record<string, string> = {
  mod: "⌘",
  ctrl: "⌃",
  shift: "⇧",
  alt: "⌥",
  tab: "⇥",
};

/** Human-readable combo for tooltips/menus/cheat sheet ("⌘⇧P" / "Ctrl+Shift+P"). */
export function formatCombo(binding: KeyBinding, isMac: boolean): string {
  const combo = isMac ? binding.mac : binding.other;
  const parts = combo.split("+");
  if (isMac) {
    return parts
      .map((p) => MAC_KEY_GLYPHS[p] ?? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
      .join("");
  }
  return parts
    .map((p) => (p === "mod" ? "Ctrl" : p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
    .join("+");
}

/** Cheat-sheet convenience: bindings grouped by section, in table order. */
export function bindingsBySection(): Array<{ section: KeyBinding["section"]; bindings: KeyBinding[] }> {
  const out: Array<{ section: KeyBinding["section"]; bindings: KeyBinding[] }> = [];
  for (const b of KEY_BINDINGS) {
    const group = out.find((g) => g.section === b.section);
    if (group) group.bindings.push(b);
    else out.push({ section: b.section, bindings: [b] });
  }
  return out;
}

export const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
