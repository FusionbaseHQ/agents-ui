import React from "react";

export type TabSymbol = {
  id: string;
  value: string;
  label: string;
  src: string;
  legacy: string[];
};

const TAB_SYMBOL_PREFIX = "tab-icon:";
const TAB_ICON_BASE = "/tab-icons/";

export const TAB_SYMBOLS: TabSymbol[] = [
  { id: "terminal", value: `${TAB_SYMBOL_PREFIX}terminal`, label: "Terminal", src: `${TAB_ICON_BASE}terminal.png`, legacy: ["\u{1F5A5}\uFE0F", "\u{1F4BB}"] },
  { id: "bot", value: `${TAB_SYMBOL_PREFIX}bot`, label: "Bot", src: `${TAB_ICON_BASE}bot.png`, legacy: ["\u{1F916}"] },
  { id: "git-branch", value: `${TAB_SYMBOL_PREFIX}git-branch`, label: "Git branch", src: `${TAB_ICON_BASE}git-branch.png`, legacy: [] },
  { id: "key", value: `${TAB_SYMBOL_PREFIX}key`, label: "Key", src: `${TAB_ICON_BASE}key.png`, legacy: ["\u{1F512}"] },
  { id: "database", value: `${TAB_SYMBOL_PREFIX}database`, label: "Database", src: `${TAB_ICON_BASE}database.png`, legacy: ["\u{1F5C4}\uFE0F", "\u{1F4CA}"] },
  { id: "rocket-launch", value: `${TAB_SYMBOL_PREFIX}rocket-launch`, label: "Rocket", src: `${TAB_ICON_BASE}rocket-launch.png`, legacy: ["\u{1F680}"] },
  { id: "bug", value: `${TAB_SYMBOL_PREFIX}bug`, label: "Bug", src: `${TAB_ICON_BASE}bug.png`, legacy: ["\u{1F41B}"] },
  { id: "server-stack", value: `${TAB_SYMBOL_PREFIX}server-stack`, label: "Server", src: `${TAB_ICON_BASE}server-stack.png`, legacy: ["\u{1F310}", "\u2601\uFE0F", "\u{1F4E1}"] },
  { id: "workflow", value: `${TAB_SYMBOL_PREFIX}workflow`, label: "Workflow", src: `${TAB_ICON_BASE}workflow.png`, legacy: ["\u{1F527}", "\u{1F6E0}\uFE0F", "\u26A1"] },
];

const SYMBOL_BY_VALUE = new Map<string, TabSymbol>();
for (const symbol of TAB_SYMBOLS) {
  SYMBOL_BY_VALUE.set(symbol.value, symbol);
  SYMBOL_BY_VALUE.set(symbol.id, symbol);
  SYMBOL_BY_VALUE.set(symbol.src, symbol);
  SYMBOL_BY_VALUE.set(`${TAB_ICON_BASE}${symbol.id}.png`, symbol);
  for (const legacy of symbol.legacy) SYMBOL_BY_VALUE.set(legacy, symbol);
}

export function resolveTabSymbol(value: string | null | undefined): TabSymbol | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  return SYMBOL_BY_VALUE.get(trimmed) ?? null;
}

export function normalizeTabSymbolValue(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  return resolveTabSymbol(trimmed)?.value ?? trimmed;
}

export function TabSymbolIcon({
  symbol,
  className = "sessionSymbol",
}: {
  symbol?: string | null;
  className?: string;
}) {
  const trimmed = (symbol ?? "").trim();
  if (!trimmed) return null;

  const resolved = resolveTabSymbol(trimmed);
  if (!resolved) {
    return <span className={className}>{trimmed}</span>;
  }

  return (
    <span className={className} title={resolved.label}>
      <img className="tabSymbolIcon" src={resolved.src} alt="" aria-hidden="true" draggable={false} />
    </span>
  );
}
