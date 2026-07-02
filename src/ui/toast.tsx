import { useSyncExternalStore } from "react";

export type ToastTone = "info" | "success" | "warning" | "error";

export type Toast = {
  id: number;
  tone: ToastTone;
  message: string;
  title?: string;
  /** Optional action button; the toast dismisses after the action runs. */
  action?: { label: string; onClick: () => void };
  /** Auto-dismiss delay in ms; 0 disables auto-dismiss. */
  duration: number;
};

type ToastInput = {
  tone?: ToastTone;
  message: string;
  title?: string;
  action?: { label: string; onClick: () => void };
  duration?: number;
};

// Module-level store so any code (event listeners, async handlers) can raise a
// toast without prop-drilling. <ToastHost/> subscribes and renders the stack.
let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, number>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Toast[] {
  return toasts;
}

export function dismissToast(id: number) {
  const timer = timers.get(id);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timers.delete(id);
  }
  if (toasts.some((t) => t.id === id)) {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }
}

const DEFAULT_DURATION: Record<ToastTone, number> = {
  info: 5000,
  success: 4000,
  warning: 8000,
  error: 10000,
};

const MAX_VISIBLE = 5;

export function showToast(input: ToastInput): number {
  const tone = input.tone ?? "info";
  const toast: Toast = {
    id: nextId++,
    tone,
    message: input.message,
    title: input.title,
    action: input.action,
    duration: input.duration ?? DEFAULT_DURATION[tone],
  };
  toasts = [...toasts, toast].slice(-MAX_VISIBLE);
  if (toast.duration > 0) {
    timers.set(
      toast.id,
      window.setTimeout(() => dismissToast(toast.id), toast.duration),
    );
  }
  emit();
  return toast.id;
}

/** Bottom-right transient notification stack. Mount once at the app root. */
export function ToastHost() {
  const items = useSyncExternalStore(subscribe, getSnapshot);
  if (!items.length) return null;
  return (
    <div className="toastHost" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>
          <div className="toastBody">
            {t.title ? <div className="toastTitle">{t.title}</div> : null}
            <div className="toastMessage">{t.message}</div>
          </div>
          {t.action ? (
            <button
              type="button"
              className="toastAction"
              onClick={() => {
                dismissToast(t.id);
                t.action?.onClick();
              }}
            >
              {t.action.label}
            </button>
          ) : null}
          <button type="button" className="toastClose" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
