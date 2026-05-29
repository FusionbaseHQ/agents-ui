// Shared byte helpers for the file viewers. Range reads now return raw bytes
// (tauri::ipc::Response → ArrayBuffer), so there is no base64 to decode; this
// just concatenates the chunks a viewer accumulates.

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
