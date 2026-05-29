// Shared byte helpers for the file viewers.
//
// decodeBase64Bytes is the hot path for every image chunk, byte-viewer scroll,
// large-text index step, and PDF page range. The backend currently ships chunks
// as base64 (see roadmap Theme A: move to raw binary). Until then, prefer the
// native `Uint8Array.fromBase64` (TC39 base64 proposal) where the engine has it
// — it decodes in one native call instead of a per-character JS loop — and fall
// back to the portable `atob` loop otherwise.

const nativeFromBase64 = (Uint8Array as unknown as {
  fromBase64?: (input: string) => Uint8Array;
}).fromBase64;

export function decodeBase64Bytes(value: string): Uint8Array {
  if (typeof nativeFromBase64 === "function") {
    try {
      return nativeFromBase64.call(Uint8Array, value);
    } catch {
      // Malformed input or an unexpected option default — use the loop below.
    }
  }
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
