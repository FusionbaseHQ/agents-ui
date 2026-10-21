import { normalizeOpenableUrl } from "./terminalLinks";

// A leading "name:" is a scheme ("ftp:/x", "mailto:a@b") unless a port
// follows, as in "localhost:3000".
const SCHEME_PREFIX = /^[a-z][a-z\d+.-]*:(?!\d)/i;

/**
 * Normalizes a project's preview URL as typed by a user or set by an agent.
 * A missing scheme means http ("localhost:3000" → "http://localhost:3000/").
 * Returns null for anything that isn't an http(s) URL; callers treat blank
 * input as "no preview URL" before calling this.
 */
export function normalizePreviewUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = SCHEME_PREFIX.test(trimmed) ? trimmed : `http://${trimmed}`;
  return normalizeOpenableUrl(withScheme);
}
