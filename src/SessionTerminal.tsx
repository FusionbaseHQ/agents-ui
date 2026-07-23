import { invoke } from "@tauri-apps/api/core";
import React, { useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { CanvasAddon } from "xterm-addon-canvas";
import { FitAddon } from "xterm-addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SessionShellIntegration, type CommandBlock } from "./shellIntegration";
import { notifyStateChange } from "./apiBridge";

export type CanvasRecoveryGeneration = string | number;
export type CanvasRecoveryOptions = {
  force?: boolean;
  source?: string;
  /** Bypass the recent-swap guard for a loss on the currently loaded canvas. */
  contextLoss?: boolean;
  /**
   * Opaque identity for one recovery request. Repeated calls with the same
   * generation rebuild this terminal's CanvasAddon at most once.
   */
  generation?: CanvasRecoveryGeneration;
};
export type TerminalRegistry = Map<string, { term: Terminal; fit: FitAddon; search: SearchAddon; shellInt?: SessionShellIntegration; recoverCanvas: (options?: CanvasRecoveryOptions) => void; needsCanvasRecovery?: boolean }>;
export type PendingDataBuffer = Map<string, string[]>;

type RenderDimension = { width: number; height: number };
type UiTheme =
  | "dawn"
  | "sepia"
  | "ember"
  | "slate"
  | "midnight"
  | "cobalt"
  | "neon"
  | "forest"
  | "matrix"
  | "synthwave"
  | "quantum";
type TerminalTheme = {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
};
type RenderDimensionsFallback = {
  css: { canvas: RenderDimension; cell: RenderDimension };
  device: {
    canvas: RenderDimension;
    cell: RenderDimension;
    char: { width: number; height: number; left: number; top: number };
  };
};

const KNOWN_XTERM_RESIZE_RACE_SIGNATURES = [
  "this._renderer.value.handleresize",
  "undefined is not an object (evaluating 'this._renderer.value.handleresize')",
];
const MAX_TRACKED_CANVAS_RECOVERY_GENERATIONS = 32;
const RECENT_CANVAS_REPLACEMENT_GAP_MS = 2_000;
const TERMINAL_FONT_FAMILY = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
const TERMINAL_THEME_BY_UI_THEME: Record<UiTheme, TerminalTheme> = {
  dawn: {
    background: "#1f1915",
    foreground: "#f4ead3",
    cursor: "#2a669c",
    selectionBackground: "rgba(42,102,156,0.24)",
  },
  sepia: {
    background: "#221912",
    foreground: "#f1e1c1",
    cursor: "#8f5f37",
    selectionBackground: "rgba(143,95,55,0.3)",
  },
  ember: {
    background: "#18120c",
    foreground: "#f7ead1",
    cursor: "#d2a566",
    selectionBackground: "rgba(210,165,102,0.26)",
  },
  slate: {
    background: "#13171b",
    foreground: "#e7e8e9",
    cursor: "#8ca3bb",
    selectionBackground: "rgba(140,163,187,0.28)",
  },
  midnight: {
    background: "#0d0f12",
    foreground: "#e2dfd7",
    cursor: "#7d93ad",
    selectionBackground: "rgba(125,147,173,0.28)",
  },
  cobalt: {
    background: "#08111d",
    foreground: "#dbe7f7",
    cursor: "#5ea4ff",
    selectionBackground: "rgba(94,164,255,0.28)",
  },
  neon: {
    background: "#070b14",
    foreground: "#dcfff9",
    cursor: "#2cf9ff",
    selectionBackground: "rgba(44,249,255,0.3)",
  },
  forest: {
    background: "#0a110c",
    foreground: "#d4e8db",
    cursor: "#4eca7a",
    selectionBackground: "rgba(78,202,122,0.26)",
  },
  matrix: {
    background: "#030704",
    foreground: "#b9ffc9",
    cursor: "#39ff88",
    selectionBackground: "rgba(57,255,136,0.25)",
  },
  synthwave: {
    background: "#10071a",
    foreground: "#f8e7ff",
    cursor: "#ff71ce",
    selectionBackground: "rgba(255,113,206,0.26)",
  },
  quantum: {
    background: "#061016",
    foreground: "#e1f7f3",
    cursor: "#8ee6d8",
    selectionBackground: "rgba(142,230,216,0.24)",
  },
};

function terminalThemeForUiTheme(uiTheme: UiTheme): TerminalTheme {
  return TERMINAL_THEME_BY_UI_THEME[uiTheme] ?? TERMINAL_THEME_BY_UI_THEME.midnight;
}

function createEmptyRenderDimensions(): RenderDimensionsFallback {
  const dim = (): RenderDimension => ({ width: 0, height: 0 });
  return {
    css: { canvas: dim(), cell: dim() },
    device: { canvas: dim(), cell: dim(), char: { width: 0, height: 0, left: 0, top: 0 } },
  };
}

function patchXtermRenderServiceDimensions(term: Terminal): void {
  try {
    const core = (term as unknown as { _core?: any })._core;
    const renderService = core?._renderService;
    if (!renderService) return;
    if (renderService.__agentsUiSafeDimensions) return;

    const fallback = createEmptyRenderDimensions();
    Object.defineProperty(renderService, "dimensions", {
      configurable: true,
      enumerable: true,
      get: () => {
        const rendererRef = renderService?._renderer;
        const renderer = rendererRef?.value ?? rendererRef?._value ?? null;
        return renderer?.dimensions ?? fallback;
      },
    });

    renderService.__agentsUiSafeDimensions = true;
  } catch {
    // ignore
  }
}

function isKnownXtermPausedResizeRace(err: unknown): boolean {
  const message = formatInvokeError(err).toLowerCase();
  return KNOWN_XTERM_RESIZE_RACE_SIGNATURES.some((signature) => message.includes(signature));
}

function patchXtermPausedResizeTask(term: Terminal): void {
  try {
    const core = (term as unknown as { _core?: any })._core;
    const renderService = core?._renderService;
    const pausedResizeTask = renderService?._pausedResizeTask;
    if (!pausedResizeTask || typeof pausedResizeTask.set !== "function") return;
    if (pausedResizeTask.__agentsUiSafePausedResizeTask) return;

    const originalSet = pausedResizeTask.set.bind(pausedResizeTask);
    pausedResizeTask.set = (task: () => boolean | void) => {
      originalSet(() => {
        try {
          return task();
        } catch (err) {
          if (isKnownXtermPausedResizeRace(err)) return;
          throw err;
        }
      });
    };

    pausedResizeTask.__agentsUiSafePausedResizeTask = true;
  } catch {
    // ignore
  }
}

function isXtermRendererReady(term: Terminal): boolean {
  const core = (term as unknown as { _core?: any })._core;
  const renderService = core?._renderService;
  const rendererRef = renderService?._renderer;
  const renderer = rendererRef?.value ?? rendererRef?._value ?? null;
  return Boolean(renderer && renderer.dimensions);
}

async function copyToClipboard(text: string): Promise<boolean> {
  const value = text ?? "";
  if (!value) return false;

  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // fall through
  }

  try {
    const el = document.createElement("textarea");
    el.value = value;
    el.setAttribute("readonly", "true");
    el.style.position = "fixed";
    el.style.left = "-9999px";
    el.style.top = "0";
    document.body.appendChild(el);
    el.focus();
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

function formatInvokeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// --- OSC 133 context menu (pure DOM, appended to document.body) ---

function dismissOsc133ContextMenu() {
  document.getElementById("osc133-context-menu")?.remove();
}

function fallbackCommandTextForBlock(term: Terminal, block: CommandBlock): string | null {
  const row = block.commandMarker?.line ?? block.promptMarker.line;
  const line = term.buffer.active.getLine(row);
  if (!line) return null;
  const text = line.translateToString(true).replace(/^[>$%#❯]\s+/, "").trim();
  return text || null;
}

function showOsc133ContextMenu(
  event: MouseEvent,
  block: CommandBlock,
  term: Terminal,
  shellInt: SessionShellIntegration,
  rerunCommand: (cmd: string) => void,
) {
  dismissOsc133ContextMenu();

  const items: Array<{ label: string; action: () => void; disabled?: boolean }> = [];

  const commandText = shellInt.getCommandText(term, block) ?? fallbackCommandTextForBlock(term, block);
  if (commandText) {
    items.push({ label: "Copy Command", action: () => void copyToClipboard(commandText) });
    items.push({ label: "Re-run Command", action: () => rerunCommand(commandText) });
  }

  const outputText = shellInt.getOutputText(term, block);
  if (outputText !== null) {
    items.push({ label: "Copy Output", action: () => void copyToClipboard(outputText) });
  }

  if (items.length === 0) {
    items.push({
      label: "No command details available",
      action: () => {},
      disabled: true,
    });
  }

  const menu = document.createElement("div");
  menu.id = "osc133-context-menu";
  menu.className = "osc133-context-menu";
  menu.style.left = `${Math.max(8, event.clientX)}px`;
  menu.style.top = `${Math.max(8, event.clientY)}px`;

  for (const item of items) {
    const row = document.createElement("div");
    row.className = item.disabled
      ? "osc133-context-menu-item osc133-context-menu-item-disabled"
      : "osc133-context-menu-item";
    row.textContent = item.label;
    if (item.disabled) row.setAttribute("aria-disabled", "true");
    row.addEventListener("click", (e) => {
      if (item.disabled) return;
      e.stopPropagation();
      item.action();
      menu.remove();
      cleanup();
    });
    menu.appendChild(row);
  }

  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const clampedX = Math.min(Math.max(8, event.clientX), Math.max(8, window.innerWidth - rect.width - 8));
  const clampedY = Math.min(Math.max(8, event.clientY), Math.max(8, window.innerHeight - rect.height - 8));
  menu.style.left = `${clampedX}px`;
  menu.style.top = `${clampedY}px`;

  const cleanup = () => document.removeEventListener("mousedown", onDocClick, true);
  const onDocClick = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      menu.remove();
      cleanup();
    }
  };
  setTimeout(() => document.addEventListener("mousedown", onDocClick, true), 0);
}

type SessionTerminalProps = {
  id: string;
  uiTheme: UiTheme;
  active: boolean;
  shouldFocus?: boolean;
  readOnly: boolean;
  persistent?: boolean;
  onCwdChange?: (id: string, cwd: string) => void;
  onCommandChange?: (id: string, commandLine: string, source?: "osc" | "osc133" | "input") => void;
  onResize?: (id: string, size: { cols: number; rows: number }) => void;
  onUserEnter?: (id: string) => void;
  onTransportError?: (id: string, operation: "write" | "resize", errorMessage: string) => void;
  registry: React.MutableRefObject<TerminalRegistry>;
  pendingData: React.MutableRefObject<PendingDataBuffer>;
  onRegistryChanged?: () => void;
};

function SessionTerminal(props: SessionTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const canvasAddonRef = useRef<CanvasAddon | null>(null);
  const recoverCanvasRef = useRef<(options?: CanvasRecoveryOptions) => void>(() => {});
  const lastCanvasRecoveryRef = useRef(0);
  const attemptedCanvasRecoveryGenerationsRef = useRef<Set<CanvasRecoveryGeneration>>(new Set());
  const attemptedCanvasRecoveryGenerationOrderRef = useRef<CanvasRecoveryGeneration[]>([]);
  const deferredCanvasRecoveryRef = useRef<CanvasRecoveryOptions | null>(null);
  const queuedCanvasRecoveryRef = useRef<CanvasRecoveryOptions | null>(null);
  const canvasRecoveryInProgressRef = useRef(false);
  const canvasContextRecoverySequenceRef = useRef(0);
  const canvasRecoveryTimersRef = useRef<number[]>([]);
  const resizeRafRef = useRef<number | null>(null);
  const resizeTimeoutRef = useRef<number | null>(null);
  const resizeRetryCountRef = useRef(0);
  const resizeCooldownRef = useRef(false);
  const resizeCooldownTimerRef = useRef<number | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const activeRef = useRef(props.active);
  React.useLayoutEffect(() => {
    // Commit visibility atomically with React. Mutating this ref during render
    // lets timers observe an uncommitted concurrent render and rebuild a canvas
    // while its container is still hidden.
    activeRef.current = props.active;
  }, [props.active]);
  const needsResizeRef = useRef(false);
  const zellijAutoScrollRef = useRef<{
    active: boolean;
    wheelRemainder: number;
  }>({ active: false, wheelRemainder: 0 });
  const commandBufferRef = useRef<string>("");
  const flushPendingRef = useRef<() => void>(() => {});
  const shellIntRef = useRef<SessionShellIntegration | null>(null);

  const onCwdChangeRef = useRef(props.onCwdChange);
  onCwdChangeRef.current = props.onCwdChange;
  const onCommandChangeRef = useRef(props.onCommandChange);
  onCommandChangeRef.current = props.onCommandChange;
  const onResizeRef = useRef(props.onResize);
  onResizeRef.current = props.onResize;
  const onUserEnterRef = useRef(props.onUserEnter);
  onUserEnterRef.current = props.onUserEnter;
  const onTransportErrorRef = useRef(props.onTransportError);
  onTransportErrorRef.current = props.onTransportError;
  const onRegistryChangedRef = useRef(props.onRegistryChanged);
  onRegistryChangedRef.current = props.onRegistryChanged;

  useEffect(() => {
    if (!containerRef.current) return;
    if (termRef.current) return;

    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      disableStdin: props.readOnly,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 13,
      theme: terminalThemeForUiTheme(props.uiTheme),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fit);
    term.open(container);
    const canvasAddon = new CanvasAddon();
    canvasAddonRef.current = canvasAddon;
    term.loadAddon(canvasAddon);
    term.loadAddon(searchAddon);
    patchXtermRenderServiceDimensions(term);
    patchXtermPausedResizeTask(term);

    const reportTransportError = (operation: "write" | "resize", err: unknown) => {
      onTransportErrorRef.current?.(props.id, operation, formatInvokeError(err));
    };
    const writeToSession = (data: string, source: "user" | "ui" | "system") =>
      invoke("write_to_session", { id: props.id, data, source }).catch((err) => {
        reportTransportError("write", err);
      });
    const resizeSession = (cols: number, rows: number) =>
      invoke("resize_session", { id: props.id, cols, rows }).catch((err) => {
        reportTransportError("resize", err);
      });

    const refreshTerminal = () => {
      const t = termRef.current;
      if (!t || !t.element) return;

      try {
        t.refresh(0, Math.max(0, t.rows - 1));
      } catch {
        // best-effort redraw
      }
    };

    const repaintTerminal = () => {
      const t = termRef.current;
      const fitAddon = fitRef.current;
      if (!t || !t.element) return;

      const width = container.clientWidth;
      const height = container.clientHeight;
      if (fitAddon && width > 0 && height > 0) {
        try {
          fitAddon.fit();
          const { cols, rows } = t;
          const last = lastSizeRef.current;
          if (!last || last.cols !== cols || last.rows !== rows) {
            lastSizeRef.current = { cols, rows };
            onResizeRef.current?.(props.id, { cols, rows });
            void resizeSession(cols, rows);
          }
        } catch {
          // best-effort repaint
        }
      }

      refreshTerminal();
    };

    const scheduleTerminalRefresh = (delayMs: number) => {
      const timer = window.setTimeout(() => {
        canvasRecoveryTimersRef.current = canvasRecoveryTimersRef.current.filter((id) => id !== timer);
        if (activeRef.current) refreshTerminal();
      }, delayMs);
      canvasRecoveryTimersRef.current.push(timer);
    };

    const clearCanvasRecoveryTimers = () => {
      for (const timer of canvasRecoveryTimersRef.current) {
        window.clearTimeout(timer);
      }
      canvasRecoveryTimersRef.current = [];
    };

    const hasAttemptedCanvasRecoveryGeneration = (generation: CanvasRecoveryGeneration | undefined) =>
      generation !== undefined && attemptedCanvasRecoveryGenerationsRef.current.has(generation);

    const markCanvasRecoveryGenerationAttempted = (generation: CanvasRecoveryGeneration | undefined) => {
      if (generation === undefined || attemptedCanvasRecoveryGenerationsRef.current.has(generation)) return;

      attemptedCanvasRecoveryGenerationsRef.current.add(generation);
      const order = attemptedCanvasRecoveryGenerationOrderRef.current;
      order.push(generation);
      if (order.length > MAX_TRACKED_CANVAS_RECOVERY_GENERATIONS) {
        const expired = order.shift();
        if (expired !== undefined) attemptedCanvasRecoveryGenerationsRef.current.delete(expired);
      }
    };

    const deferCanvasRecovery = (options?: CanvasRecoveryOptions) => {
      // Only the newest deferred request matters: one fresh CanvasAddon repairs
      // every recovery generation missed while this terminal was hidden. Keep
      // context-loss urgency sticky, though: a later routine wake request must
      // not let the recent-swap guard suppress a genuinely lost current canvas.
      const previous = deferredCanvasRecoveryRef.current;
      deferredCanvasRecoveryRef.current = {
        ...(options ?? {}),
        force: true,
        contextLoss: previous?.contextLoss === true || options?.contextLoss === true,
      };
      const entry = props.registry.current.get(props.id);
      if (entry) entry.needsCanvasRecovery = true;
    };

    // Recovery function for canvas context loss (e.g. after macOS sleep/GPU reset).
    // It is generation-idempotent and never rebuilds an inactive terminal. Hidden
    // terminals retain just the newest request and recover immediately on activation.
    const recoverCanvas = (options?: CanvasRecoveryOptions) => {
      const generation = options?.generation;
      if (hasAttemptedCanvasRecoveryGeneration(generation)) {
        // Later probes in one recovery generation should confirm that xterm can
        // draw without repeatedly swapping renderers or resizing the PTY.
        if (activeRef.current && !canvasRecoveryInProgressRef.current) refreshTerminal();
        return;
      }

      if (!activeRef.current) {
        deferCanvasRecovery(options);
        return;
      }

      if (canvasRecoveryInProgressRef.current) {
        // Re-entrant context events can fire while an addon is being replaced.
        // Coalesce them and drain the newest request after the current swap,
        // without allowing a routine request to erase a real context loss.
        const previous = queuedCanvasRecoveryRef.current;
        queuedCanvasRecoveryRef.current = {
          ...(options ?? {}),
          contextLoss: previous?.contextLoss === true || options?.contextLoss === true,
        };
        return;
      }

      const t = termRef.current;
      if (!t || !t.element) {
        deferCanvasRecovery(options);
        return;
      }

      const now = Date.now();
      if (
        !options?.contextLoss &&
        canvasAddonRef.current !== null &&
        now - lastCanvasRecoveryRef.current < RECENT_CANVAS_REPLACEMENT_GAP_MS
      ) {
        // A native wake and a canvas context event often describe the same GPU
        // reset. Treat the newer generation as satisfied by the recent healthy
        // replacement; a loss on the replacement canvas bypasses this guard.
        markCanvasRecoveryGenerationAttempted(generation);
        refreshTerminal();
        return;
      }
      if (!options?.force && now - lastCanvasRecoveryRef.current < 5_000) return;

      lastCanvasRecoveryRef.current = now;
      markCanvasRecoveryGenerationAttempted(generation);
      canvasRecoveryInProgressRef.current = true;
      clearCanvasRecoveryTimers();

      const registryEntry = props.registry.current.get(props.id);
      if (registryEntry) registryEntry.needsCanvasRecovery = false;
      // A successful renderer replacement also satisfies any older recovery
      // that was queued while the terminal was hidden.
      deferredCanvasRecoveryRef.current = null;

      const previous = canvasAddonRef.current;
      canvasAddonRef.current = null;
      try { previous?.dispose(); } catch { /* best-effort */ }

      let fresh: CanvasAddon | null = null;
      try {
        fresh = new CanvasAddon();
        // Publish identity before activation so a context-loss event raised
        // during addon setup is attributed to this fresh renderer, not to the
        // intentionally empty handoff state.
        canvasAddonRef.current = fresh;
        t.loadAddon(fresh);
        patchXtermRenderServiceDimensions(t);
        patchXtermPausedResizeTask(t);
        repaintTerminal();
        scheduleTerminalRefresh(250);
        scheduleTerminalRefresh(1_000);
      } catch {
        // CanvasAddon failed — terminal falls back to DOM renderer which still works
        try { fresh?.dispose(); } catch { /* best-effort */ }
        canvasAddonRef.current = null;
        repaintTerminal();
      } finally {
        canvasRecoveryInProgressRef.current = false;
        const queued = queuedCanvasRecoveryRef.current;
        queuedCanvasRecoveryRef.current = null;
        if (queued) {
          queueMicrotask(() => recoverCanvasRef.current(queued));
        }
      }
    };
    recoverCanvasRef.current = recoverCanvas;

    const contextRecoveryStates = new WeakMap<
      EventTarget,
      { generation: CanvasRecoveryGeneration; addonAtLoss: CanvasAddon | null }
    >();
    const contextRecoveryStateFor = (target: EventTarget) => {
      const currentAddon = canvasAddonRef.current;
      const existing = contextRecoveryStates.get(target);
      if (existing !== undefined && existing.addonAtLoss === currentAddon) return existing;
      canvasContextRecoverySequenceRef.current += 1;
      const generation = `context-${canvasContextRecoverySequenceRef.current}`;
      const state = { generation, addonAtLoss: currentAddon };
      contextRecoveryStates.set(target, state);
      return state;
    };
    const handleCanvasContextLost = (event: Event) => {
      event.preventDefault();
      const target = event.target ?? container;
      const { generation, addonAtLoss } = contextRecoveryStateFor(target);
      const source = event.type;
      const timer = window.setTimeout(() => {
        canvasRecoveryTimersRef.current = canvasRecoveryTimersRef.current.filter((id) => id !== timer);
        // Another wake/context callback already replaced the addon that owned
        // this event. Its delayed callback is stale and must not swap again.
        if (canvasAddonRef.current !== addonAtLoss) return;
        recoverCanvas({ force: true, source, generation, contextLoss: true });
      }, 250);
      canvasRecoveryTimersRef.current.push(timer);
    };
    const handleCanvasContextRestored = (event: Event) => {
      const target = event.target ?? container;
      const state = contextRecoveryStates.get(target);
      if (state === undefined) {
        refreshTerminal();
        return;
      }
      contextRecoveryStates.delete(target);
      if (canvasAddonRef.current !== state.addonAtLoss) {
        refreshTerminal();
        return;
      }
      recoverCanvas({
        force: true,
        source: event.type,
        generation: state.generation,
        contextLoss: true,
      });
    };
    container.addEventListener("contextlost", handleCanvasContextLost, true);
    container.addEventListener("contextrestored", handleCanvasContextRestored, true);
    container.addEventListener("webglcontextlost", handleCanvasContextLost, true);
    container.addEventListener("webglcontextrestored", handleCanvasContextRestored, true);

    const skipEscapeSequence = (data: string, start: number): number => {
      const next = data[start];
      if (!next) return start;
      if (next === "[") {
        let i = start + 1;
        while (i < data.length) {
          const ch = data[i];
          if (ch >= "@" && ch <= "~") return i + 1;
          i += 1;
        }
        return i;
      }
      if (next === "]") {
        let i = start + 1;
        while (i < data.length) {
          const ch = data[i];
          if (ch === "\u0007") return i + 1;
          if (ch === "\u001b" && data[i + 1] === "\\") return i + 2;
          i += 1;
        }
        return i;
      }
      if (next === "P" || next === "^" || next === "_") {
        let i = start + 1;
        while (i < data.length) {
          if (data[i] === "\u001b" && data[i + 1] === "\\") return i + 2;
          i += 1;
        }
        return i;
      }
      return start + 1;
    };

    const ingestUserInputForCommandDetection = (data: string) => {
      let buffer = commandBufferRef.current;
      const submitted: string[] = [];

      let i = 0;
      while (i < data.length) {
        const ch = data[i];
        if (ch === "\r") {
          if (data[i + 1] === "\n") i += 1;
          submitted.push(buffer);
          buffer = "";
          i += 1;
          continue;
        }
        if (ch === "\n") {
          submitted.push(buffer);
          buffer = "";
          i += 1;
          continue;
        }
        if (ch === "\u007f" || ch === "\b") {
          buffer = buffer.slice(0, -1);
          i += 1;
          continue;
        }
        if (ch === "\u0015") {
          buffer = "";
          i += 1;
          continue;
        }
        if (ch === "\u001b") {
          i = skipEscapeSequence(data, i + 1);
          continue;
        }
        if (ch < " " || ch === "\u007f") {
          i += 1;
          continue;
        }
        buffer += ch;
        i += 1;
      }

      commandBufferRef.current = buffer;

      for (const line of submitted) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        onCommandChangeRef.current?.(props.id, trimmed, "input");
      }
    };

    if (props.persistent) {
      const sendZellij = (data: string) => writeToSession(data, "ui");

      const ensureZellijScrollModePrefix = () => {
        const state = zellijAutoScrollRef.current;
        if (state.active) return "";
        state.active = true;
        return "\x13"; // Ctrl+s => zellij scroll mode
      };

      const scrollZellijLines = (lines: number) => {
        const count = Math.min(Math.abs(lines), 120);
        if (count === 0) return;
        if (lines > 0 && !zellijAutoScrollRef.current.active) return;
        const prefix = ensureZellijScrollModePrefix();
        const step = lines < 0 ? "k" : "j";
        void sendZellij(`${prefix}${step.repeat(count)}`);
      };

      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") return true;
        const key = event.key;
        // Let Cmd+F / Ctrl+Shift+F bubble to global handler
        if ((event.metaKey && key.toLowerCase() === "f") || (event.ctrlKey && event.shiftKey && key.toLowerCase() === "f")) return false;
        const isCopy =
          (event.metaKey || (event.ctrlKey && event.shiftKey)) &&
          !event.altKey &&
          key.toLowerCase() === "c";
        if (isCopy && term.hasSelection()) {
          void copyToClipboard(term.getSelection());
          return false;
        }
        const isPageUp = key === "PageUp";
        const isPageDown = key === "PageDown";
        const isHome = key === "Home";
        const isEnd = key === "End";
        const isUp = key === "ArrowUp";
        const isDown = key === "ArrowDown";

        if (event.shiftKey && isPageUp) {
          scrollZellijLines(-term.rows);
          return false;
        }
        if (event.shiftKey && isPageDown) {
          scrollZellijLines(term.rows);
          return false;
        }
        if (event.metaKey && event.shiftKey && (isUp || isDown)) {
          const si = shellIntRef.current;
          if (si?.activated) {
            const row = term.buffer.active.viewportY;
            const block = isUp ? si.getPreviousBlock(row + 1) : si.getNextBlock(row);
            if (block) si.navigateToBlock(term, block);
            return false;
          }
        }
        if (event.metaKey && !event.shiftKey && isUp) {
          scrollZellijLines(-term.rows);
          return false;
        }
        if (event.metaKey && !event.shiftKey && isDown) {
          scrollZellijLines(term.rows);
          return false;
        }

        if ((event.shiftKey || event.metaKey) && (isHome || isEnd)) {
          // Not supported in zellij defaults; keep default behavior.
          return true;
        }

        return true;
      });
      term.onData((data) => {
        const state = zellijAutoScrollRef.current;
        if (state.active) {
          state.active = false;
          if (data === "\x1b") {
            void writeToSession("\x1b", "ui");
          } else {
            void writeToSession("\x1b", "ui").then(() => writeToSession(data, "user"));
          }
        } else {
          void writeToSession(data, "user");
        }
        if (data.includes("\r") || data.includes("\n")) {
          onUserEnterRef.current?.(props.id);
        }
        ingestUserInputForCommandDetection(data);
      });
    } else {
      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") return true;
        const key = event.key;
        // Let Cmd+F / Ctrl+Shift+F bubble to global handler
        if ((event.metaKey && key.toLowerCase() === "f") || (event.ctrlKey && event.shiftKey && key.toLowerCase() === "f")) return false;
        const isCopy =
          (event.metaKey || (event.ctrlKey && event.shiftKey)) &&
          !event.altKey &&
          key.toLowerCase() === "c";
        if (isCopy && term.hasSelection()) {
          void copyToClipboard(term.getSelection());
          return false;
        }
        if (event.metaKey && event.shiftKey) {
          const isUp = key === "ArrowUp";
          const isDown = key === "ArrowDown";
          if (isUp || isDown) {
            const si = shellIntRef.current;
            if (si?.activated) {
              const row = term.buffer.active.viewportY;
              const block = isUp ? si.getPreviousBlock(row + 1) : si.getNextBlock(row);
              if (block) si.navigateToBlock(term, block);
              return false;
            }
          }
        }
        return true;
      });
      term.onData((data) => {
        void writeToSession(data, "user");
        if (data.includes("\r") || data.includes("\n")) {
          onUserEnterRef.current?.(props.id);
        }
        ingestUserInputForCommandDetection(data);
      });
    }

	    termRef.current = term;
	    fitRef.current = fit;

    const oscDisposables: Array<{ dispose: () => void }> = [];
    const reportCwd = (cwd: string) => {
      const trimmed = cwd.trim();
      if (!trimmed) return;
      onCwdChangeRef.current?.(props.id, trimmed);
    };
    const reportCommand = (commandLine: string, source: "osc" | "osc133" = "osc") => {
      onCommandChangeRef.current?.(props.id, commandLine, source);
    };

    const parseFileUrlPath = (data: string): string | null => {
      if (!data.startsWith("file://")) return null;
      const rest = data.slice("file://".length);
      const slashIdx = rest.indexOf("/");
      if (slashIdx < 0) return null;
      const rawPath = rest.slice(slashIdx);
      try {
        return decodeURIComponent(rawPath);
      } catch {
        return rawPath;
      }
    };

    // --- OSC 133 (FinalTerm) shell integration ---
    const shellInt = new SessionShellIntegration();
    shellIntRef.current = shellInt;
    const osc133Decorations: Array<{ dispose: () => void }> = [];
    const blockDecoMap = new Map<number, { dispose: () => void }>();
    let osc133Disposed = false;

    const createExitDecoration = (block: CommandBlock) => {
      if (osc133Disposed) return;
      if (blockDecoMap.has(block.id)) return;
      try {
        const deco = term.registerDecoration({
          marker: block.promptMarker,
          x: 0,
          width: 1,
          height: 1,
          layer: "top",
        });
        if (!deco) return;
        blockDecoMap.set(block.id, deco);
        osc133Decorations.push(deco);
        const isSuccess = block.exitCode === 0;
        deco.onRender((el) => {
          if (el.dataset.osc133Init) return;
          el.dataset.osc133Init = "1";
          el.classList.add("osc133-exit-dot", isSuccess ? "osc133-success" : "osc133-error");
          const openContextMenu = (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            showOsc133ContextMenu(e, block, term, shellInt, (cmd) =>
              void writeToSession(cmd + "\r", "ui"),
            );
          };
          el.addEventListener("contextmenu", openContextMenu);
        });
      } catch {
        // Decoration creation failed — non-fatal, skip silently
      }
    };

    let pendingWorkingDeco: { dispose: () => void } | null = null;
    let workingDecoBlockId: number | null = null;

    shellInt.setOnBlockEvicted((blockId) => {
      const deco = blockDecoMap.get(blockId);
      if (deco) {
        blockDecoMap.delete(blockId);
        const idx = osc133Decorations.indexOf(deco);
        if (idx >= 0) osc133Decorations.splice(idx, 1);
        // Defer disposal to avoid re-entrant issues during xterm marker teardown
        queueMicrotask(() => { try { deco.dispose(); } catch {} });
      }
    });

    const disposeWorkingDeco = () => {
      if (!pendingWorkingDeco) return;
      pendingWorkingDeco.dispose();
      const idx = osc133Decorations.indexOf(pendingWorkingDeco);
      if (idx >= 0) osc133Decorations.splice(idx, 1);
      pendingWorkingDeco = null;
    };

    const createWorkingDecoration = (block: CommandBlock) => {
      if (osc133Disposed) return;
      disposeWorkingDeco();
      try {
        const deco = term.registerDecoration({
          marker: block.promptMarker,
          x: 0,
          width: 1,
          height: 1,
          layer: "top",
        });
        if (!deco) return;
        pendingWorkingDeco = deco;
        osc133Decorations.push(deco);
        deco.onRender((el) => {
          if (el.dataset.osc133Init) return;
          el.dataset.osc133Init = "1";
          el.classList.add("osc133-exit-dot", "osc133-working");
        });
      } catch {}
    };

	    if (term.parser) {
	      oscDisposables.push(
	        term.parser.registerOscHandler(7, (data) => {
	          const path = parseFileUrlPath(data);
	          if (path) reportCwd(path);
	          return true;
	        }),
	      );
      oscDisposables.push(
        term.parser.registerOscHandler(1337, (data) => {
          const cwdPrefix = "CurrentDir=";
          if (data.startsWith(cwdPrefix)) {
            const cwd = data.slice(cwdPrefix.length);
            reportCwd(cwd);
            return true;
          }

          const cmdPrefix = "Command=";
          if (data.startsWith(cmdPrefix)) {
            const cmd = data.slice(cmdPrefix.length);
            reportCommand(cmd, "osc");
            return true;
          }

          return false;
        }),
      );

      oscDisposables.push(
        term.parser.registerOscHandler(133, (data) => {
          const code = data.charAt(0);
          switch (code) {
            case "A":
              shellInt.handlePromptStart(term);
              disposeWorkingDeco();
              // Defer React callback out of the write pipeline
              queueMicrotask(() => reportCommand("", "osc133"));
              // Notify MCP/API listeners that the shell is idle at prompt
              notifyStateChange("shell.prompt_ready", {
                sessionId: props.id,
                timestamp: Date.now(),
              });
              break;
            case "B":
              shellInt.handleCommandStart(term);
              queueMicrotask(() => {
                const block = shellInt.pendingBlock;
                const nextCommand =
                  block ? shellInt.getCommandText(term, block) : commandBufferRef.current;
                if (nextCommand?.trim()) reportCommand(nextCommand, "osc133");
              });
              break;
            case "C": {
              shellInt.handleOutputStart(term);
              const pending = shellInt.pendingBlock;
              if (pending?.commandMarker) {
                workingDecoBlockId = pending.id;
                const expectedId = pending.id;
                requestAnimationFrame(() => {
                  if (workingDecoBlockId === expectedId) {
                    createWorkingDecoration(pending);
                  }
                });
              }
              break;
            }
            case "D": {
              workingDecoBlockId = null;
              disposeWorkingDeco();
              const exitStr = data.length > 2 ? data.slice(2) : "0";
              const exitCode = parseInt(exitStr, 10) || 0;
              shellInt.handleCommandFinished(term, exitCode);
              // Defer decoration creation fully outside the write pipeline
              const completed = shellInt.completedBlocks;
              if (completed.length > 0) {
                const lastBlock = completed[completed.length - 1];
                requestAnimationFrame(() => createExitDecoration(lastBlock));
                // Notify MCP/API listeners of command completion
                const serialized = shellInt.serializeBlock(term, lastBlock);
                notifyStateChange("shell.command_complete", {
                  sessionId: props.id,
                  ...serialized,
                });
              }
              queueMicrotask(() => reportCommand("", "osc133"));
              break;
            }
          }
          return true;
        }),
      );

	      // keep zellij's alternate screen behavior intact
	    }

	    function scheduleResize() {
	      if (!activeRef.current) {
	        needsResizeRef.current = true;
	        return;
	      }
	      if (resizeRafRef.current !== null) return;
	      if (resizeTimeoutRef.current !== null) return;
	      if (resizeCooldownRef.current) return;

	      const attempts = resizeRetryCountRef.current;
	      if (attempts < 5) {
	        resizeRafRef.current = window.requestAnimationFrame(() => {
	          resizeRafRef.current = null;
	          sendResize();
	        });
	        return;
	      }

	      const exp = Math.min(attempts - 5, 6);
	      const delay = Math.min(500, 16 * 2 ** exp);
	      resizeTimeoutRef.current = window.setTimeout(() => {
	        resizeTimeoutRef.current = null;
	        sendResize();
	      }, delay);
	    }

	    function sendResize() {
	      const term = termRef.current;
	      const fit = fitRef.current;
	      if (!term || !fit) return;
	      if (!term.element) return;
	      if (container.clientWidth === 0 || container.clientHeight === 0) return;

	      if (!isXtermRendererReady(term)) {
	        resizeRetryCountRef.current += 1;
	        scheduleResize();
	        return;
	      }

	      try {
	        fit.fit();
	      } catch {
	        resizeRetryCountRef.current += 1;
	        scheduleResize();
	        return;
	      }

	      resizeRetryCountRef.current = 0;
	      const { cols, rows } = term;
	      const last = lastSizeRef.current;
	      if (last && last.cols === cols && last.rows === rows) return;
	      lastSizeRef.current = { cols, rows };
	      onResizeRef.current?.(props.id, { cols, rows });
	      void resizeSession(cols, rows);

	      // Cooldown: prevent rapid-fire resize during continuous window drag
	      resizeCooldownRef.current = true;
	      resizeCooldownTimerRef.current = window.setTimeout(() => {
	        resizeCooldownTimerRef.current = null;
	        resizeCooldownRef.current = false;
	        scheduleResize();
	      }, 80);
	    }

	    // Register BEFORE flushing to avoid race with incoming events
	    props.registry.current.set(props.id, { term, fit, search: searchAddon, shellInt, recoverCanvas });
    onRegistryChangedRef.current?.();

	    // Flush any buffered data that arrived before we were ready (but wait for renderer readiness)
	    const flushPending = () => {
	      const term = termRef.current;
	      if (!term) return;
	      const buffered = props.pendingData.current.get(props.id);
	      if (!buffered || buffered.length === 0) {
	        props.pendingData.current.delete(props.id);
	        return;
	      }
	      // xterm 5 safely queues writes before renderer init — no gate needed
	      term.write(buffered.length === 1 ? buffered[0] : buffered.join(""));
	      props.pendingData.current.delete(props.id);
	    };
	    flushPendingRef.current = flushPending;
	    flushPending();

		    // Create ResizeObserver inside useEffect for proper cleanup
		    const resizeObserver = new ResizeObserver(() => scheduleResize());

		    resizeObserver.observe(container);
		    scheduleResize();

    let wheelCleanup: (() => void) | null = null;
    if (props.persistent) {
      const PIXELS_PER_LINE = 40;

      const wheelListener = (event: WheelEvent) => {
        const term = termRef.current;
        if (!term) return;
        if (event.ctrlKey) return;
        if (event.deltaY === 0) return;

        event.preventDefault();
        event.stopPropagation();

        let lines = 0;
        if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
          lines = Math.trunc(event.deltaY);
        } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
          lines = Math.trunc(event.deltaY * term.rows);
        } else {
          const state = zellijAutoScrollRef.current;
          state.wheelRemainder += event.deltaY;
          lines = Math.trunc(state.wheelRemainder / PIXELS_PER_LINE);
          if (lines !== 0) {
            const state = zellijAutoScrollRef.current;
            state.wheelRemainder -= lines * PIXELS_PER_LINE;
          }
        }
        if (lines !== 0) {
          const state = zellijAutoScrollRef.current;
          if (lines > 0 && !state.active) return;
          const prefix = state.active ? "" : "\x13";
          state.active = true;
          const count = Math.min(Math.abs(lines), 120);
          const step = lines < 0 ? "k" : "j";
          void writeToSession(`${prefix}${step.repeat(count)}`, "ui");
        }
      };

	      container.addEventListener("wheel", wheelListener, {
	        passive: false,
	        capture: true,
	      });
	      wheelCleanup = () => {
	        container.removeEventListener("wheel", wheelListener, true);
	      };
	    }

		    return () => {
		      container.removeEventListener("contextlost", handleCanvasContextLost, true);
		      container.removeEventListener("contextrestored", handleCanvasContextRestored, true);
		      container.removeEventListener("webglcontextlost", handleCanvasContextLost, true);
		      container.removeEventListener("webglcontextrestored", handleCanvasContextRestored, true);
		      clearCanvasRecoveryTimers();
		      resizeObserver.disconnect();
		      if (resizeRafRef.current !== null) {
		        window.cancelAnimationFrame(resizeRafRef.current);
		      }
	      if (resizeTimeoutRef.current !== null) {
	        window.clearTimeout(resizeTimeoutRef.current);
	      }
	      osc133Disposed = true;
	      dismissOsc133ContextMenu();
	      blockDecoMap.clear();
	      for (const d of osc133Decorations) d.dispose();
	      shellInt.setOnBlockEvicted(null);
	      shellInt.dispose();
	      shellIntRef.current = null;
	      for (const d of oscDisposables) d.dispose();
	      props.registry.current.delete(props.id);
      onRegistryChangedRef.current?.();
	      props.pendingData.current.delete(props.id);
	      wheelCleanup?.();
	      searchAddon.dispose();
	      try { canvasAddonRef.current?.dispose(); } catch { /* best-effort */ }
	      canvasAddonRef.current = null;
        recoverCanvasRef.current = () => {};
	      deferredCanvasRecoveryRef.current = null;
	      queuedCanvasRecoveryRef.current = null;
	      canvasRecoveryInProgressRef.current = false;
	      term.dispose();
	      termRef.current = null;
	      fitRef.current = null;
	      flushPendingRef.current = () => {};
	      resizeRafRef.current = null;
	      resizeTimeoutRef.current = null;
	      resizeRetryCountRef.current = 0;
	      if (resizeCooldownTimerRef.current !== null) {
	        window.clearTimeout(resizeCooldownTimerRef.current);
	        resizeCooldownTimerRef.current = null;
	      }
	      resizeCooldownRef.current = false;
	    };
	  }, [props.id, props.persistent, props.registry, props.pendingData]);

  React.useLayoutEffect(() => {
    if (!props.active) return;

    // Drain deferred work before the browser paints the newly-visible terminal.
    // The generation token makes this safe under StrictMode and duplicate wake
    // callbacks, while the boolean branch preserves the existing App contract.
    const registryEntry = props.registry.current.get(props.id);
    const deferredCanvasRecovery = deferredCanvasRecoveryRef.current;
    if (registryEntry?.needsCanvasRecovery || deferredCanvasRecovery) {
      if (registryEntry) registryEntry.needsCanvasRecovery = false;
      deferredCanvasRecoveryRef.current = null;
      recoverCanvasRef.current({
        ...(deferredCanvasRecovery ?? {}),
        force: true,
        source: deferredCanvasRecovery?.source ?? "activation",
      });
    }
  }, [props.active, props.id, props.registry]);

  useEffect(() => {
    if (!props.active) return;
    needsResizeRef.current = false;
    flushPendingRef.current();
    const term = termRef.current;
    const fit = fitRef.current;
    const container = containerRef.current;
    if (!term || !fit || !container) return;

    let cancelled = false;
	    const attemptFit = (attemptsLeft: number) => {
	      if (cancelled) return;
	      if (container.clientWidth === 0 || container.clientHeight === 0) {
	        if (attemptsLeft > 0) {
	          window.requestAnimationFrame(() => attemptFit(attemptsLeft - 1));
	        }
	        return;
	      }
	      if (!isXtermRendererReady(term)) {
	        if (attemptsLeft > 0) {
	          window.requestAnimationFrame(() => attemptFit(attemptsLeft - 1));
	        }
	        return;
	      }

	      if (props.shouldFocus !== false) {
	        try {
	          term.focus();
	        } catch {
	          if (attemptsLeft > 0) {
	            window.requestAnimationFrame(() => attemptFit(attemptsLeft - 1));
	          }
	          return;
	        }
	      }
	      try {
	        fit.fit();
	      } catch {
	        if (attemptsLeft > 0) {
	          window.requestAnimationFrame(() => attemptFit(attemptsLeft - 1));
	        }
	        return;
	      }
      try {
        term.refresh(0, Math.max(0, term.rows - 1));
      } catch {
        // best-effort redraw
      }
	      const { cols, rows } = term;
	      const last = lastSizeRef.current;
	      if (!last || last.cols !== cols || last.rows !== rows) {
	        lastSizeRef.current = { cols, rows };
	        void invoke("resize_session", { id: props.id, cols, rows }).catch((err) => {
            onTransportErrorRef.current?.(props.id, "resize", formatInvokeError(err));
          });
      }
    };

    attemptFit(8);
    return () => {
      cancelled = true;
    };
  }, [props.active, props.shouldFocus, props.id]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    // Setting options.theme already fires xterm's color-change path, which
    // recolors the glyph atlas and triggers a full refresh. A full CanvasAddon
    // dispose+rebuild here is redundant and causes a visible multi-terminal
    // stutter on every theme toggle; clearing the texture atlas + one refresh
    // produces the identical new palette without tearing down the renderer.
    // Real GPU desyncs remain covered by the sleep/wake watchdog and the
    // per-canvas contextlost listeners.
    term.options.theme = terminalThemeForUiTheme(props.uiTheme);
    try {
      canvasAddonRef.current?.clearTextureAtlas?.();
      term.refresh(0, Math.max(0, term.rows - 1));
    } catch {
      // best-effort redraw
    }
  }, [props.uiTheme]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = props.readOnly;
  }, [props.readOnly]);

  return <div ref={containerRef} style={{ height: "100%", width: "100%" }} />;
}

export default React.memo(SessionTerminal);
