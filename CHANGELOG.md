# Changelog

All notable changes to this project will be documented in this file.

This project aims to follow Semantic Versioning.

## Unreleased

- No unreleased changes yet.

## 0.3.0

- Add per-project file tree + Monaco editor, including better tab manageability and close affordances.
- Add remote SSH file tree + editor.
- Add SSH file download + drag-and-drop support, including Finder drag & drop for local/SSH files.
- Add file tree context menu, “open terminal here”, and persistent file tree state per SSH workspace.
- Add project reordering and a resizable Projects sidebar.
- Improve terminal types + persistent terminal management.
- Improve terminal renderer stability and error handling; stabilize PTY lifecycle, resize, and workspace persistence.
- Improve tray menu (recent sessions, agent count behavior, clear count when idle).
- Relicense under AGPL-3.0 and add LICENSE file.
- Improve README copy.

## 0.2.2

- Add a VS Code button to the top bar.
- Fix PATH issues when the app is launched from Finder/Dock.
- Fix VS Code button reliability when the app is launched from Finder.

## 0.2.0

- Add VS Code integration.
- Fix embedded Nushell PATH and improve session UX.
- Update docs demo video/GIF.
- Fix Tauri bundle version.

## 0.1.1

- Harmonize project creation button with sessions (+).
- Import login shell PATH for bundled Nushell sessions on macOS.

## 0.1.0

- Initial open source release.
- Multi-session terminal UI with agent session shortcuts.
- Session recording + replay.
- Project organization, prompts, and asset templates.
- Optional macOS Keychain-backed encryption for environments and recording inputs.
