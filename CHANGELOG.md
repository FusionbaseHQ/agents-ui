# Changelog

All notable changes to this project will be documented in this file.

This project aims to follow Semantic Versioning.

## Unreleased

- **UI/UX overhaul (phase 1)**:
  - **Welcome pane**: projects with no sessions (including first run) now show action cards — New terminal, Terminal with shell…, first agent quick-start, Connect SSH — plus the key shortcuts, instead of a blank area. All empty states across the app gained hints and call-to-action buttons.
  - **Unified Settings** (gear button): Appearance with a hover-to-preview theme grid, Terminal with a new **app-global default shell** (precedence: per-terminal pick > project default > app default > bundled agsh), Power, Keyboard cheat sheet, and Storage & updates.
  - **Toasts**: transient events (shell fallback, recording start/stop, notices, errors) now appear as bottom-right toasts; the ActivityCenter remains the persistent log.
  - **Session tab strip**: the bar under the terminal is now the active project's sessions in stable order, always visible; tabs close their session (× or middle-click).
  - **Status bar**: new bottom bar with the session's shell (click to open a terminal with a different shell), cwd, SSH state, REC (moved from the topbar), keep-awake, update-available, and app version.
  - **Keyboard**: one declarative keymap drives all shortcuts and a new cheat sheet on **⌘/**; modifier matching is now exact per combo.
  - **⌘K**: palette now also reaches Settings, Keyboard Shortcuts, Terminal with Shell…, New Project, Persistent Terminals, Agent Shortcuts, Check for Updates, Toggle Agent Panel.
  - **Consistency/internal**: new shared UI primitives (Modal/Menu/Toast/EmptyState/Badge); every dialog in the app and the sidebar's four bespoke portal menus migrated onto them (keyboard navigation + focus traps everywhere); the two one-off delete confirms consolidated into the shared confirm dialog.
  - **Unified new session (⌘T)**: one keyboard-first list — Terminal with the default shell, Terminal with shell…, agent quick-starts, SSH connection, custom command — replacing four separate entry points.
  - **Session timeline**: new SlidePanel tab (**⌘⇧E**) showing every command run in the active terminal with exit status, duration (live while running), and start time; click jumps the terminal to that command, hover offers Copy output. Powered by OSC 133 shell integration, now emitted by all bundled/managed shells (agsh, Nushell, zsh, bash).
  - Inline color affordance on sidebar session rows (hover wand → color picker).

- **Bring your own shell**: terminals can now launch with one of your own installed shells (zsh, bash, fish, …) instead of the bundled Nushell. Set a per-project **Default shell** in Project settings (default stays Bundled Nushell), and use the new **Terminal with shell…** menu item to open a one-off terminal with any detected shell. Shell detection is multi-source (`/etc/shells`, `$SHELL`, `PATH`, well-known locations) and never blocks a launch — if a chosen shell goes missing the session falls back to the default with a toast.
- **Bundled agsh, now the default shell**: the app ships [agsh](https://github.com/FusionbaseHQ/agsh) as a second bundled shell and makes it the default for new terminals (projects with no explicit default shell now open agsh; bundled Nushell remains available as an option). The picker recommends agsh, Nushell, and your login shell — with bundled shells marked by a **Bundled** badge — and lists all other installed shells below; the project **Default shell** select groups bundled and installed shells separately.

## 0.10.0

- Introduce **Workspaces** as a top-level tier: organization is now **Workspaces → Projects → Sessions**. Group projects into a workspace and switch workspaces from the sidebar header, with optional custom workspace icons.
- Overhaul the sidebar into a single tree: every project in the active workspace shows as a collapsible group with its sessions nested inline (replacing the one-project-at-a-time view).
- Add keyboard quick-switch: type in the sidebar search, then `↑`/`↓`/`Enter` to jump to any project or session.
- Add a per-project **+** menu to start a Terminal, agent (Claude/Codex), or SSH session in that project. On SSH projects, Claude/Codex now start **on the remote host** in the project's root directory instead of locally.
- Distinguish SSH sessions from local ones with a dedicated remote icon; fix per-session colors so they show in every state; restore pinned and disconnected indicators.
- Clean up the sidebar typography and layout (calmer weights, no boxes/dividers, stable-width search), add a `Collapse/Expand all` action, and add a per-workspace delete flow that lets you move or remove the workspace's projects.
- Allow `data:`/`blob:` images in the CSP (workspace icons; also unblocks existing data-URL images for production builds).

## 0.5.0

- Add split views (saved 2-pane terminal layouts) with sidebar grouping and full-layout switching.
- Add in-terminal find (`Cmd/Ctrl+F`) with synced search across split panes.
- Make `Cmd/Ctrl+F` context-aware: Monaco find when editor is focused, terminal find otherwise.
- Improve sidebar UX: scrollable sessions list, split view members inherit session colors.
- Theme overhaul: neutral dark gray surfaces with gold/yellow accents.

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
