<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Agents UI Logo" width="128" height="128">
</p>

<h1 align="center">Agents UI</h1>

<p align="center">
  <strong>Native desktop workspace for AI coding agents, terminals, and files</strong>
</p>

<p align="center">
  <a href="#demo">Demo</a> •
  <a href="#features">Features</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#usage">Usage</a> •
  <a href="#development">Development</a> •
  <a href="#security--privacy">Security &amp; Privacy</a> •
  <a href="#faq">FAQ</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-AGPL%203.0-blue.svg" alt="License">
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey.svg" alt="Platform">
  <img src="https://img.shields.io/badge/version-0.2.2-green.svg" alt="Version">
  <img src="https://img.shields.io/badge/tauri-v2-orange.svg" alt="Tauri">
</p>

---

<p align="center">
  <strong>The terminal that runs AI agents</strong>
</p>

<p align="center">
  A native desktop terminal for running AI coding agents alongside regular shells — with persistent zellij sessions, an SSH host picker, recording &amp; replay, and project organization.
</p>

<p align="center">
  <a href="https://github.com/FusionbaseHQ/agents-ui/releases/tag/v0.2.2">
    <img src="https://img.shields.io/badge/Download-v0.2.2%20(macOS)-brightgreen" alt="Download v0.2.2 for macOS">
  </a>
</p>

## Demo

[![Agents UI demo](docs/agents-ui-demo-video.gif)](docs/agents-ui-demo-video.mp4)

## Highlights

- Real PTY sessions
- Persistent zellij sessions
- SSH host picker (and port forwards)
- Projects, prompts & assets
- Recording & replay
- Local + SSH file explorer + Monaco editor
- Drag & drop file transfers: **Finder ↔ local ↔ SSH**

## Features

### Terminals & Sessions
- Multiple concurrent sessions (shells and agent CLIs)
- Real embedded terminals powered by xterm.js + PTY backend
- Session persistence across app restarts (optional)
- Working directory tracking and session status (exit codes, closed state)
- Session recording and replay

### Multi-Agent Support
- Quick-start shortcuts for **Claude**, **Codex**, and **Gemini** (and configurable shortcuts for other agents)
- Activity indicators show when agents are working
- Automatic agent detection with branded icons

### Projects & Workspace
- Project-based organization (sessions, base paths, and environment sets)
- Resizable workspace layout (terminals + file tree + editor + slide panels)
- Per-project environments (env vars), optionally encrypted at rest on macOS

### Files Workspace (Local + SSH)
- File explorer with a fast, scrollable tree view
- Open folders in Finder / VS Code (local)
- Rename/delete files and folders (local + SSH)
- Upload/download via SSH (SCP-based)
- Drag & drop:
  - Finder → local/SSH folder to copy/upload
  - SSH/local → Finder (SSH items are downloaded to a temp file for the drag)

### Code Editor (Monaco)
- Multi-tab editor with syntax highlighting for common languages
- Save with `Cmd/Ctrl+S`, close tabs with `Cmd/Ctrl+W`
- Works with both local and SSH-backed files

### Command Palette
- Quick access with `Cmd+K` / `Ctrl+K`
- Fuzzy search across prompts, recordings, and sessions
- Keyboard-driven workflow

### Prompts & Templates
- Create and save reusable prompts
- Pin up to 5 prompts for quick access (`Cmd+1-5`)
- Paste or send-with-enter modes
- Asset templates for one-click file creation

### SSH (Remote Sessions + Port Forwards)
- Host picker backed by `~/.ssh/config`
- Port forwards: local (`-L`), remote (`-R`), dynamic (`-D`)
- “Forward-only” mode (port-forward without starting an interactive shell)

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later recommended)
- [Rust](https://rustup.rs/) toolchain
- [Tauri prerequisites](https://tauri.app/start/prerequisites/) for macOS

### Installation

```bash
# Clone the repository
git clone https://github.com/FusionbaseHQ/agents-ui.git
cd agents-ui

# Install dependencies
npm install

# Run in development mode
npm run tauri dev
```

### Build for Production

```bash
npm run tauri build
```

The built application will be in `src-tauri/target/release/bundle/`.

## Usage

### Creating Sessions

1. Click **New** in the sidebar or press `Cmd+T` / `Ctrl+Shift+T`
2. Enter a session name
3. Optionally specify a command (leave blank for shell)
4. Choose a working directory
5. Click **Create**

### Quick Agent Sessions

Use the quick-start buttons in the sidebar to instantly launch agent sessions:
- **claude** - Start a Claude Code session
- **codex** - Start an OpenAI Codex session
- **gemini** - Start a Google Gemini session

> **Note:** Agent CLI tools must be installed and available on your PATH.

### Files & Editor

- Open the file explorer to browse local or SSH directories.
- Drag files/folders from Finder into a folder in the explorer to copy/upload.
- Drag files/folders out of the explorer into Finder/Desktop to export (SSH items are downloaded to a temp file for the drag).
- Open files in the Monaco editor for local/SSH editing.

### Command Palette

Press `Cmd+K` / `Ctrl+K` to open the command palette. Search and access:
- Pinned and saved prompts
- Recent recordings
- Active sessions
- Quick start actions

### Recording Sessions

1. Click the record button in the session topbar
2. Interact with your session as normal
3. Click stop to end recording
4. Access recordings in the slide panel (`Cmd+Shift+R`)

### Managing Prompts

1. Open the prompts panel (`Cmd+Shift+P`)
2. Click **+ New Prompt** to create a prompt
3. Pin important prompts for quick access
4. Use `Cmd+1-5` to quickly send pinned prompts

### Working with Projects

- Create projects to organize related sessions
- Set a base path for each project
- Assign environment configurations (optionally encrypted at rest on macOS)
- Enable asset templates per project

<details>
<summary><strong>Keyboard shortcuts</strong></summary>

| Action | macOS | Windows/Linux |
|--------|-------|---------------|
| Command Palette | `Cmd+K` | `Ctrl+K` |
| New Session | `Cmd+T` | `Ctrl+Shift+T` |
| Close Session | `Cmd+W` | `Ctrl+Shift+W` |
| Prompts Panel | `Cmd+Shift+P` | `Ctrl+Shift+P` |
| Recordings Panel | `Cmd+Shift+R` | `Ctrl+Shift+R` |
| Assets Panel | `Cmd+Shift+A` | `Ctrl+Shift+A` |
| Quick Prompt 1-5 | `Cmd+1-5` | `Ctrl+1-5` |
| Editor: Save | `Cmd+S` | `Ctrl+S` |
| Editor: Close tab | `Cmd+W` | `Ctrl+W` |

</details>

## Development

### Prerequisites

1. **Node.js** - [Download](https://nodejs.org/)
2. **Rust** - Install via [rustup](https://rustup.rs/):
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```
3. **Tauri Prerequisites** - Follow the [official guide](https://tauri.app/start/prerequisites/) for your OS

### Development Mode

```bash
npm install
npm run tauri dev
```

This starts the Vite dev server and Tauri development window with hot reload.

### Fresh Start (Clear Local Data)

To simulate a first launch, run the app with `--clear-data` to remove the saved state + recordings:

```bash
# Pass args through to the app binary (note the `--`)
npm run tauri dev -- -- --clear-data

# Or use the helper script
npm run tauri:dev:clear
```

On macOS you can also wipe app data from disk with:

```bash
scripts/purge-agents-ui-macos.sh --dry-run
scripts/purge-agents-ui-macos.sh
```

### Bundled Tools (macOS)

Agents UI bundles `nu` (Nushell) and `zellij` as Tauri sidecars under `src-tauri/bin` so the app runs without system dependencies.

```bash
./scripts/fetch-nu-macos.sh 0.104.0
./scripts/fetch-zellij-macos.sh latest
```

### Production Build

```bash
npm run tauri build
```

<details>
<summary><strong>Project structure</strong></summary>

```
.
├── src/                      # React frontend
│   ├── App.tsx               # Main application component
│   ├── SessionTerminal.tsx   # Terminal embedding (xterm.js)
│   ├── CommandPalette.tsx    # Command palette UI
│   ├── SlidePanel.tsx        # Side panel component
│   ├── components/           # Editor, file explorer, modals, sections
│   ├── processEffects.ts     # Agent detection + shortcut definitions
│   └── styles.css            # Application styles
├── src-tauri/                # Rust backend (Tauri)
│   ├── src/                  # Commands + PTY + SSH + persistence
│   └── bin/                  # Bundled sidecars (macOS)
├── scripts/                  # Dev + packaging utilities
└── docs/                     # Demo assets
```

</details>

<details>
<summary><strong>Architecture</strong></summary>

Agents UI is built with:

- **[Tauri v2](https://tauri.app/)** - Native app framework with Rust backend
- **[React 18](https://react.dev/)** - Frontend UI framework
- **[xterm.js](https://xtermjs.org/)** - Terminal emulator for the web
- **[Monaco Editor](https://microsoft.github.io/monaco-editor/)** - Code editor
- **[Vite](https://vitejs.dev/)** - Frontend build tool

</details>

## Supported Agents

| Agent | Provider | CLI Command | Installation |
|-------|----------|-------------|--------------|
| Claude | Anthropic | `claude` | [Claude Code](https://claude.ai/code) |
| Codex | OpenAI | `codex` | [OpenAI Codex](https://openai.com/codex) |
| Gemini | Google | `gemini` | [Google Gemini](https://gemini.google.com) |

The application automatically detects running agents and displays their branded icons and activity status.

### Adding Custom Agents

- Reorder/enable agent shortcuts in the UI (sidebar + command palette).
- To add a new CLI for detection/icons, edit `src/processEffects.ts` to add support for additional tools:

```typescript
export const PROCESS_EFFECTS: ProcessEffect[] = [
  // Add your agent here
  {
    id: "my-agent",
    label: "My Agent",
    matchCommands: ["my-agent-cli"],
    idleAfterMs: 2000,
    iconSrc: myAgentIcon // Import your icon
  },
  // ... existing agents
];
```

## Security & Privacy

Agents UI runs local shells and can execute commands with **your user permissions**. Treat agent output as untrusted, and avoid running commands you don’t understand.

- **Optional encryption at rest (macOS):** environment configs and recording inputs can be stored encrypted in the app data directory using a master key stored in **macOS Keychain**. You can also disable encryption (no Keychain prompts) and store data in plaintext.
- **Recordings may include secrets:** recordings can capture what you typed. Use recording sparingly when handling credentials.
- **SSH host list:** the SSH picker reads `~/.ssh/config` to list host aliases.
- **No telemetry:** Agents UI doesn’t send session contents anywhere. The only built-in network call is the optional “Check for updates” request to GitHub (agents you run may of course use the network).

## FAQ

<details>
<summary><strong>Why a native app instead of a web app?</strong></summary>

Native apps provide:
- **Real PTY access** - Full terminal emulation with proper signals and job control
- **Better performance** - Direct system access without browser overhead
- **System integration** - Tray icons, native menus, file system access
- **Offline capability** - Works without an internet connection (agents may require it)
</details>

<details>
<summary><strong>Can I use this without AI agents?</strong></summary>

Yes! Agents UI works as a regular terminal multiplexer. Create sessions with a blank command to get a standard shell. The agent features are optional enhancements.
</details>

<details>
<summary><strong>Where is my data stored?</strong></summary>

All data is stored locally on your machine via Tauri's app data directory:
- **macOS:** `~/Library/Application Support/` (under the app’s bundle identifier)

Data includes projects, sessions, prompts, recordings, and settings.
</details>

<details>
<summary><strong>Does it work offline?</strong></summary>

The application itself works fully offline. However, AI agents typically require internet connectivity to communicate with their respective APIs.
</details>

<details>
<summary><strong>How do I install the agent CLIs?</strong></summary>

Each agent has its own installation process:
- **Claude:** Visit [claude.ai/code](https://claude.ai/code) for installation instructions
- **Codex:** Install via OpenAI's tools
- **Gemini:** Follow Google's Gemini CLI setup

Ensure the CLI commands are available in your PATH.
</details>

<details>
<summary><strong>Can I customize the appearance?</strong></summary>

The app uses a dark theme by default. Custom theming is planned for future releases. You can modify `src/styles.css` for development builds.
</details>

## Contributing

Contributions are welcome!

- Start here: `CONTRIBUTING.md`
- Community standards: `CODE_OF_CONDUCT.md`
- Security reports: `SECURITY.md`
- Getting help: `SUPPORT.md`

### Development Guidelines

- Follow existing code style and patterns
- Test changes on macOS (other platforms are welcome but currently not the focus)
- Update documentation for new features
- Keep commits focused and well-described

## License

AGPL-3.0-only. See `LICENSE`.

## Acknowledgments

- [Tauri](https://tauri.app/) - The native app framework that makes this possible
- [xterm.js](https://xtermjs.org/) - Terminal emulator for the web
- [Anthropic](https://anthropic.com/), [OpenAI](https://openai.com/), [Google](https://google.com/) - AI agent providers

---

<p align="center">
  Made with Tauri, React, and Rust
</p>
