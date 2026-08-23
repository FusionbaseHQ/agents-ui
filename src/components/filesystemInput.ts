import type { InputHTMLAttributes } from "react";

type WritingSuggestionsAttribute = {
  // React's currently installed DOM types predate this standard attribute.
  // Lower-case spelling makes React forward it to the underlying input.
  writingsuggestions: "false";
};

type FilesystemTextInputProps = Pick<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "autoComplete" | "autoCapitalize" | "autoCorrect" | "spellCheck"
> &
  WritingSuggestionsAttribute;

/** Browser text services must never rewrite literal filesystem names or paths. */
export const FILESYSTEM_TEXT_INPUT_PROPS = {
  type: "text",
  autoComplete: "off",
  autoCapitalize: "none",
  autoCorrect: "off",
  spellCheck: false,
  writingsuggestions: "false",
} satisfies FilesystemTextInputProps;

/** POSIX/macOS basenames may contain backslashes; only `/` and NUL are separators here. */
export function isInvalidPosixBasename(name: string): boolean {
  return name.length === 0 || name === "." || name === ".." || name.includes("/") || name.includes("\0");
}

/** Keep unsupported byte-oriented names explicit instead of showing a replacement glyph. */
export function isUnsupportedFilenameEncodingError(message: string): boolean {
  return message.includes("not valid UTF-8");
}

/**
 * Preserve normal text-editor bindings while retaining the small set of
 * application shortcuts that are intentionally global. Monaco owns its other
 * bindings (notably Cmd+/), while Cmd+F remains routed to Monaco find.
 */
export function isShortcutAllowedWhileEditing(binding: string | null, codeEditorTarget: boolean): boolean {
  if (codeEditorTarget) return binding === "terminal.search";
  return binding === "palette.open" || binding === "files.search" || binding === "shortcuts.show";
}

/** Safari/WebKit may report either signal while an IME consumes Enter. */
export function isImeCompositionKey(event: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean {
  return event.isComposing || event.keyCode === 229;
}

export type ImeEnterDisposition = "none" | "active-composition" | "trailing-enter";

/**
 * Active composition must keep the keydown default so the IME can accept its
 * candidate. Safari emits a second, non-composing keydown with keyCode 229
 * after compositionend; only that trailing Enter is safe to cancel.
 */
export function classifyImeEnter(
  event: Pick<KeyboardEvent, "key" | "isComposing" | "keyCode">,
  compositionActive: boolean,
): ImeEnterDisposition {
  if (event.key !== "Enter") return "none";
  if (compositionActive || event.isComposing) return "active-composition";
  if (event.keyCode === 229) return "trailing-enter";
  return "none";
}

type MutableNumberRef = { current: number };
let nextImeSubmitSuppressionGeneration = 1;

/** Keep an IME-accepting Enter from implicitly submitting during the same task. */
export function armImeSubmitSuppression(ref: MutableNumberRef): void {
  const generation = nextImeSubmitSuppressionGeneration++;
  ref.current = generation;
  window.setTimeout(() => {
    if (ref.current === generation) ref.current = 0;
  }, 0);
}

/** Consume a same-gesture IME submit suppression without affecting later Enter presses. */
export function consumeImeSubmitSuppression(ref: MutableNumberRef): boolean {
  if (ref.current === 0) return false;
  ref.current = 0;
  return true;
}
