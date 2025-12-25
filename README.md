# Desktop app (Tauri + xterm.js)

This is the GUI version: a native desktop window with real embedded terminals and session tabs.

## Prereqs

- Node.js
- Rust toolchain
- Tauri prerequisites for your OS

## Dev

```bash
cd desktop
npm install
npm run tauri dev
```

## Use

- Click `New` to create a session (blank command = shell).
- Use the quick buttons (`codex`, `claude`) to start agent sessions if those CLIs are on your PATH.

## Build

```bash
cd desktop
npm install
npm run tauri build
```
