// Dialogs domain store (App.tsx decomposition, tranche 3) — the seed of a
// ModalHost registry: simple open/closed dialog state lives here instead of
// scattered useStates. Same module-store pattern as stores/shells.ts. The
// global keydown handler reads isDialogOpen() synchronously (module state is
// always current — no ref mirroring needed).
import { useSyncExternalStore } from "react";

export type DialogId = "shortcuts" | "settings" | "newSessionFlow";

/** Escape-cascade priority: first open dialog in this order closes first. */
const CASCADE_ORDER: DialogId[] = ["shortcuts", "settings", "newSessionFlow"];

type DialogsState = Readonly<Record<DialogId, boolean>>;

let state: DialogsState = {
  shortcuts: false,
  settings: false,
  newSessionFlow: false,
};

const listeners = new Set<() => void>();

function setState(next: DialogsState) {
  state = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): DialogsState {
  return state;
}

/** React subscription to dialog open state. */
export function useDialogsStore(): DialogsState {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function openDialog(id: DialogId) {
  if (!state[id]) setState({ ...state, [id]: true });
}

export function closeDialog(id: DialogId) {
  if (state[id]) setState({ ...state, [id]: false });
}

export function toggleDialog(id: DialogId) {
  setState({ ...state, [id]: !state[id] });
}

export function isDialogOpen(id: DialogId): boolean {
  return state[id];
}

export function anyDialogOpen(): boolean {
  return CASCADE_ORDER.some((id) => state[id]);
}

/** Close the topmost open dialog (Escape cascade). Returns true if one closed. */
export function closeTopDialog(): boolean {
  for (const id of CASCADE_ORDER) {
    if (state[id]) {
      closeDialog(id);
      return true;
    }
  }
  return false;
}
