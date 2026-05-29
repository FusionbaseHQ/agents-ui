import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// PDF.js fetches its CMaps, standard fonts, and wasm image decoders at runtime.
// The app CSP only allows same-origin loads (no CDN), so copy them out of
// node_modules into public/ where Vite serves them at /pdfjs/* in dev and copies
// them into the build output. The dest is wiped first so a pdfjs-dist version
// bump can't leave stale files behind. Runs on config load; gitignored.
const rootDir = dirname(fileURLToPath(import.meta.url));
const pdfjsSrc = join(rootDir, "node_modules", "pdfjs-dist");
const pdfjsDest = join(rootDir, "public", "pdfjs");
if (existsSync(pdfjsSrc)) {
  rmSync(pdfjsDest, { recursive: true, force: true });
  for (const sub of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
    const from = join(pdfjsSrc, sub);
    if (existsSync(from)) {
      mkdirSync(pdfjsDest, { recursive: true });
      cpSync(from, join(pdfjsDest, sub), { recursive: true });
    }
  }
}

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2021",
    sourcemap: Boolean(process.env.TAURI_DEBUG),
    minify: process.env.TAURI_DEBUG ? false : "esbuild",
  },
});
