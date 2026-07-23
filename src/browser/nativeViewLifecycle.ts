import { invoke } from "@tauri-apps/api/core";

const NATIVE_VIEW_INVOKE_TIMEOUT_MS = 2_500;
const CLOSE_RETRY_DELAYS_MS = [50, 150, 400, 1_000] as const;
const CLOSE_BACKGROUND_RETRY_MS = 5_000;
let lastBrowserNativeOperationId = Date.now() * 1_000;
const browserNativeOperationTails = new Map<string, Promise<void>>();
const closingBrowserLabels = new Set<string>();
const browserClosePromises = new Map<string, Promise<void>>();

function nextBrowserNativeOperationId(): number {
  // A time base survives ordinary frontend reloads while the increment keeps
  // several commands in one millisecond strictly ordered and JS-safe.
  lastBrowserNativeOperationId = Math.max(
    lastBrowserNativeOperationId + 1,
    Date.now() * 1_000,
  );
  return lastBrowserNativeOperationId;
}

export function invokeBrowserNativeCommand<T>(
  command: "browser_open" | "browser_hide" | "browser_close",
  args: Record<string, unknown>,
  operationId: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${command} did not settle within ${NATIVE_VIEW_INVOKE_TIMEOUT_MS}ms`));
    }, NATIVE_VIEW_INVOKE_TIMEOUT_MS);

    void invoke<T>(command, { ...args, operationId }).then((value) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(value);
    }, (error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      reject(error);
    });
  });
}

/** Serialize and monotonically version native lifecycle operations per label. */
export function enqueueBrowserNativeOperation<T>(
  label: string,
  operation: (operationId: number) => Promise<T>,
): Promise<T> {
  const operationId = nextBrowserNativeOperationId();
  const previous = browserNativeOperationTails.get(label) ?? Promise.resolve();
  const result = previous.then(
    () => operation(operationId),
    () => operation(operationId),
  );
  const tail = result.then(() => undefined, () => undefined);
  browserNativeOperationTails.set(label, tail);
  void tail.then(() => {
    if (browserNativeOperationTails.get(label) === tail) {
      browserNativeOperationTails.delete(label);
    }
  });
  return result;
}

export function isBrowserNativeViewClosing(label: string): boolean {
  return closingBrowserLabels.has(label);
}

export function closeBrowserNativeView(label: string): Promise<void> {
  // Browser labels are process-unique, so close is a terminal intent. Mark it
  // synchronously before React unmount cleanup can enqueue a newer Hide that
  // would otherwise supersede a timed-out Close at the native mutex.
  closingBrowserLabels.add(label);
  const existing = browserClosePromises.get(label);
  if (existing) return existing;

  const closing = (async () => {
    let attempt = 0;
    while (true) {
      try {
        await enqueueBrowserNativeOperation(label, (operationId) =>
          invokeBrowserNativeCommand("browser_close", { label }, operationId));
        return;
      } catch (error) {
        if (attempt === CLOSE_RETRY_DELAYS_MS.length) {
          console.warn(
            `[browser] Native close still failing; continuing every ${CLOSE_BACKGROUND_RETRY_MS}ms`,
            error,
          );
        }
        const delay = CLOSE_RETRY_DELAYS_MS[attempt] ?? CLOSE_BACKGROUND_RETRY_MS;
        attempt += 1;
        await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
      }
    }
  })();
  browserClosePromises.set(label, closing);
  void closing.then(() => {
    if (browserClosePromises.get(label) === closing) browserClosePromises.delete(label);
  });
  return closing;
}
