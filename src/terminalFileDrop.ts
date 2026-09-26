import React from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Dropping files onto a terminal types their paths, like Terminal.app/iTerm2.
 *
 * Tauri handles OS file drops natively (the webview never sees an HTML5 drop
 * with files), so without this a drop onto a terminal did nothing — which is
 * why dragging a screenshot into Claude Code "didn't work": Claude Code attaches
 * an image when its *path* is pasted into it.
 *
 * Paths are sent through xterm's `paste()`, so programs that enable bracketed
 * paste (Claude Code does) receive a real paste. For SSH sessions the caller
 * uploads the files first and pastes the remote paths instead.
 */

const SAFE_PATH_CHAR = /[A-Za-z0-9_\-.,/:@%+=^~]/;

/** Backslash-escape a path the way macOS terminals do for dropped files. */
export function shellEscapeDroppedPath(path: string): string {
  if (/[\n\r]/.test(path)) {
    // Backslash-newline is a line continuation; single-quote these instead.
    return `'${path.replace(/'/g, `'\\''`)}'`;
  }
  let out = "";
  for (const char of path) {
    // Non-ASCII (e.g. the narrow no-break space in macOS screenshot names) is
    // passed through literally, as Terminal.app does.
    out += SAFE_PATH_CHAR.test(char) || char.charCodeAt(0) > 0x7f ? char : `\\${char}`;
  }
  return out;
}

/** Text a terminal receives for a drop: escaped paths, space separated, trailing space. */
export function droppedPathsText(paths: string[]): string {
  return `${paths.map(shellEscapeDroppedPath).join(" ")} `;
}

type DropPosition = { x: number; y: number };

const DROP_TARGET_CLASS = "terminalDropTarget";

/**
 * The visible terminal container under a drop position. Tauri reports physical
 * pixels; try logical first and fall back to the raw value (as the file tree does).
 */
function terminalContainerAt(position: DropPosition): HTMLElement | null {
  const scale = window.devicePixelRatio || 1;
  for (const [x, y] of [
    [position.x / scale, position.y / scale],
    [position.x, position.y],
  ]) {
    const hit = document.elementFromPoint(x, y);
    const container = hit?.closest<HTMLElement>("[data-session-id]");
    if (container && !container.classList.contains("terminalHidden")) return container;
  }
  return null;
}

export function useTerminalFileDrop(onDropOnTerminal: (sessionId: string, paths: string[]) => void): void {
  const onDropRef = React.useRef(onDropOnTerminal);
  React.useEffect(() => {
    onDropRef.current = onDropOnTerminal;
  }, [onDropOnTerminal]);

  React.useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    let highlighted: HTMLElement | null = null;
    let lastDropSignature = "";
    let lastDropAt = 0;

    const highlight = (next: HTMLElement | null) => {
      if (highlighted === next) return;
      highlighted?.classList.remove(DROP_TARGET_CLASS);
      next?.classList.add(DROP_TARGET_CLASS);
      highlighted = next;
    };

    const handle = (event: { payload: unknown }) => {
      if (cancelled) return;
      const payload = event.payload as
        | { type: "enter" | "over"; position: DropPosition }
        | { type: "drop"; paths: string[]; position: DropPosition }
        | { type: "leave" };
      if (payload.type === "leave") {
        highlight(null);
        return;
      }
      const container = terminalContainerAt(payload.position);
      if (payload.type !== "drop") {
        highlight(container);
        return;
      }
      highlight(null);
      // Both the webview and window listeners report the same drop.
      const signature = `${payload.paths.join("\n")}@${payload.position.x},${payload.position.y}`;
      const now = Date.now();
      if (signature === lastDropSignature && now - lastDropAt < 200) return;
      lastDropSignature = signature;
      lastDropAt = now;
      const sessionId = container?.dataset.sessionId;
      if (!sessionId || payload.paths.length === 0) return;
      onDropRef.current(sessionId, payload.paths);
    };

    const register = async () => {
      for (const target of [getCurrentWebview(), getCurrentWindow()]) {
        try {
          const unlisten = await target.onDragDropEvent(handle);
          if (cancelled) unlisten();
          else unlisteners.push(unlisten);
        } catch (err) {
          console.warn("[drop] failed to register terminal drop listener", err);
        }
      }
    };
    void register();
    return () => {
      cancelled = true;
      highlight(null);
      for (const unlisten of unlisteners) unlisten();
    };
  }, []);
}
