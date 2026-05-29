import React from "react";
import { decodeBase64Bytes } from "./bytes";

export type FileRangeRead = {
  offset: number;
  length: number;
  size: number;
  mtimeMs?: number | null;
  eof: boolean;
  dataBase64: string;
};
export type ReadRangeFn = (path: string, offset: number, length: number) => Promise<FileRangeRead>;

export type RangeChunk = { bytes: Uint8Array; eof: boolean; size: number };

// Per-mount, offset-keyed LRU cache of decoded chunks with in-flight dedup.
// Scoped to the component instance, so a file change (which remounts the viewer
// via its key) starts with a fresh cache — no cross-file staleness. Tier 2's
// shared viewer layer can lift this into a cross-viewer cache with explicit
// invalidation; until then this removes redundant re-fetches on scroll-back and
// collapses concurrent reads of the same offset into one IPC call.
export function useChunkCache(maxBytes = 8 * 1024 * 1024) {
  const cacheRef = React.useRef(new Map<number, { chunk: RangeChunk; touched: number }>());
  const inflightRef = React.useRef(new Map<number, Promise<RangeChunk>>());
  const bytesRef = React.useRef(0);
  const clockRef = React.useRef(0);

  return React.useCallback(
    (readRange: ReadRangeFn, path: string, offset: number, length: number): Promise<RangeChunk> => {
      const need = Math.min(length, Math.max(0, length)); // requested span
      const hit = cacheRef.current.get(offset);
      if (hit && (hit.chunk.eof || hit.chunk.bytes.length >= need)) {
        hit.touched = ++clockRef.current;
        return Promise.resolve(hit.chunk);
      }
      const pending = inflightRef.current.get(offset);
      if (pending) return pending;
      const p = (async () => {
        const result = await readRange(path, offset, length);
        const chunk: RangeChunk = { bytes: decodeBase64Bytes(result.dataBase64), eof: result.eof, size: result.size };
        const prev = cacheRef.current.get(offset);
        if (prev) bytesRef.current -= prev.chunk.bytes.length;
        cacheRef.current.set(offset, { chunk, touched: ++clockRef.current });
        bytesRef.current += chunk.bytes.length;
        while (bytesRef.current > maxBytes && cacheRef.current.size > 1) {
          let oldestKey: number | null = null;
          let oldest = Number.POSITIVE_INFINITY;
          for (const [key, value] of cacheRef.current) {
            if (value.touched < oldest) {
              oldest = value.touched;
              oldestKey = key;
            }
          }
          if (oldestKey == null) break;
          bytesRef.current -= cacheRef.current.get(oldestKey)!.chunk.bytes.length;
          cacheRef.current.delete(oldestKey);
        }
        return chunk;
      })().finally(() => inflightRef.current.delete(offset));
      inflightRef.current.set(offset, p);
      return p;
    },
    [maxBytes],
  );
}
