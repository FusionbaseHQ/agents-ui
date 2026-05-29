import { concatBytes } from "./bytes";
import type { ReadRangeFn } from "./useChunkCache";

const CHUNK = 256 * 1024;

// Read a whole (smallish) file as UTF-8 text via the raw-bytes range reader.
// Returns "" if cancellation is signalled mid-read. Callers should re-check
// their own cancelled flag before using the result.
export async function readAllText(
  readRange: ReadRangeFn,
  path: string,
  size: number,
  isCancelled: () => boolean,
): Promise<string> {
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < size; offset += CHUNK) {
    const reqLen = Math.min(CHUNK, size - offset);
    const chunk = await readRange(path, offset, reqLen);
    if (isCancelled()) return "";
    parts.push(chunk);
    if (chunk.length === 0 || chunk.length < reqLen) break;
  }
  return new TextDecoder("utf-8").decode(concatBytes(parts));
}
