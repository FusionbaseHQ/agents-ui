import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

interface BridgeCommand {
  requestId: string;
  method: string;
  params: Record<string, unknown>;
}

type CommandHandler = (
  params: Record<string, unknown>
) => unknown | Promise<unknown>;

let handlers: Map<string, CommandHandler> = new Map();
let unlisten: (() => void) | null = null;

export function registerHandler(method: string, handler: CommandHandler) {
  handlers.set(method, handler);
}

export function registerHandlers(
  entries: Record<string, CommandHandler>
) {
  for (const [method, handler] of Object.entries(entries)) {
    handlers.set(method, handler);
  }
}

export function notifyStateChange(event: string, data: unknown) {
  invoke("api_notify_state_change", {
    notification: { event, data },
  }).catch(() => {});
}

export async function initBridge() {
  if (unlisten) return;

  unlisten = await listen<BridgeCommand>("api-command", async (event) => {
    const { requestId, method, params } = event.payload;

    const handler = handlers.get(method);
    if (!handler) {
      await invoke("api_respond", {
        response: {
          requestId,
          result: null,
          error: `Unknown method: ${method}`,
        },
      });
      return;
    }

    try {
      const result = await handler(params);
      await invoke("api_respond", {
        response: {
          requestId,
          result: result === undefined ? null : result,
          error: null,
        },
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : String(err);
      await invoke("api_respond", {
        response: {
          requestId,
          result: null,
          error: message,
        },
      });
    }
  });
}

export function destroyBridge() {
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
  handlers.clear();
}
