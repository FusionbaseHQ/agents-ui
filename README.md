<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Agents UI Logo" width="128" height="128">
</p>

<h1 align="center">Agents UI</h1>

<p align="center">
  <strong>A native desktop terminal for AI coding agents</strong>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#usage">Usage</a> •
  <a href="#development">Development</a> •
  <a href="#faq">FAQ</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg" alt="Platform">
  <img src="https://img.shields.io/badge/version-0.1.0-green.svg" alt="Version">
  <img src="https://img.shields.io/badge/tauri-v2-orange.svg" alt="Tauri">
</p>

---

Agents UI is a native desktop application for managing multiple AI coding agent sessions alongside regular shell terminals. Run Claude, Codex, Gemini, and shell sessions in a unified interface with real embedded terminals, session recording, and project organization.

<!--
## Screenshots

Add your screenshots here:
![Main Interface](docs/images/screenshot-main.png)
![Command Palette](docs/images/screenshot-palette.png)
-->

## Features

### Multi-Agent Support
- **Claude** (Anthropic), **Codex** (OpenAI), and **Gemini** (Google) integrations
- Activity indicators show when agents are working
- Automatic agent detection with branded icons
- One-click quick-start buttons for each agent

### Native Terminal Experience
- Real embedded terminals powered by xterm.js
- Full PTY support with bidirectional communication
- 5000-line scrollback buffer
- Working directory tracking

### Session Management
- Create and manage multiple concurrent sessions
- Project-based organization
- Session persistence across app restarts
- Exit code tracking and status indicators

### Recording & Replay
- Record terminal sessions for later review
- Step-by-step or full replay modes
- Recording metadata with agent type and timestamps

### Command Palette
- Quick access with `Cmd+K` / `Ctrl+K`
- Fuzzy search across prompts, recordings, and sessions
- Keyboard-driven workflow

### Prompts System
- Create and save reusable prompts
- Pin up to 5 prompts for quick access (`Cmd+1-5`)
- Paste or send-with-enter modes

### Additional Features
- System tray integration with active agent count
- Asset templates for automatic file creation
- Environment variable management
- Resizable slide panel for prompts, recordings, and assets

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later recommended)
- [Rust](https://rustup.rs/) toolchain
- [Tauri prerequisites](https://tauri.app/v1/guides/getting-started/prerequisites) for your OS

### Installation

```bash
# Clone the repository
git clone https://github.com/your-username/agents-ui.git
cd agents-ui/desktop

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
- Assign environment configurations
- Enable asset templates per project

## Keyboard Shortcuts

| Action | macOS | Windows/Linux |
|--------|-------|---------------|
| Command Palette | `Cmd+K` | `Ctrl+K` |
| New Session | `Cmd+T` | `Ctrl+Shift+T` |
| Close Session | `Cmd+W` | `Ctrl+Shift+W` |
| Next Session | `Cmd+Tab` | `Ctrl+Tab` |
| Previous Session | `Cmd+Shift+Tab` | `Ctrl+Shift+Tab` |
| Prompts Panel | `Cmd+Shift+P` | `Ctrl+Shift+P` |
| Recordings Panel | `Cmd+Shift+R` | `Ctrl+Shift+R` |
| Assets Panel | `Cmd+Shift+A` | `Ctrl+Shift+A` |
| Quick Prompt 1-5 | `Cmd+1-5` | `Ctrl+1-5` |

## Development

### Prerequisites

1. **Node.js** - [Download](https://nodejs.org/)
2. **Rust** - Install via [rustup](https://rustup.rs/):
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```
3. **Tauri Prerequisites** - Follow the [official guide](https://tauri.app/v1/guides/getting-started/prerequisites) for your OS

### Development Mode

```bash
cd desktop
npm install
npm run tauri dev
```

This starts the Vite dev server and Tauri development window with hot reload.

### Production Build

```bash
npm run tauri build
```

### Project Structure

```
desktop/
├── src/                      # React frontend
│   ├── App.tsx              # Main application component
│   ├── SessionTerminal.tsx  # Terminal embedding (xterm.js)
│   ├── CommandPalette.tsx   # Command palette UI
│   ├── SlidePanel.tsx       # Side panel component
│   ├── processEffects.ts    # Agent detection logic
│   ├── styles.css           # Application styles
│   └── assets/              # Agent icons
├── src-tauri/               # Rust backend
│   ├── src/
│   │   ├── main.rs         # Tauri entry point, IPC handlers
│   │   ├── pty.rs          # PTY session management
│   │   ├── persist.rs      # State persistence
│   │   ├── recording.rs    # Session recording
│   │   └── tray.rs         # System tray integration
│   ├── Cargo.toml          # Rust dependencies
│   └── tauri.conf.json     # Tauri configuration
├── package.json            # Node dependencies
└── vite.config.ts          # Vite configuration
```

## Architecture

Agents UI is built with:

- **[Tauri v2](https://tauri.app/)** - Native app framework with Rust backend
- **[React 18](https://react.dev/)** - Frontend UI framework
- **[xterm.js](https://xtermjs.org/)** - Terminal emulator for the web
- **[Vite](https://vitejs.dev/)** - Frontend build tool

### How It Works

1. **Frontend (React)** handles the UI, session tabs, command palette, and terminal rendering
2. **Backend (Rust)** manages PTY sessions, state persistence, and system integration
3. **IPC Bridge (Tauri)** enables communication between frontend and backend
4. **xterm.js** provides the terminal emulator with full PTY support

## Supported Agents

| Agent | Provider | CLI Command | Installation |
|-------|----------|-------------|--------------|
| Claude | Anthropic | `claude` | [Claude Code](https://claude.ai/code) |
| Codex | OpenAI | `codex` | [OpenAI Codex](https://openai.com/codex) |
| Gemini | Google | `gemini` | [Google Gemini](https://gemini.google.com) |

The application automatically detects running agents and displays their branded icons and activity status.

### Adding Custom Agents

Edit `src/processEffects.ts` to add support for additional CLI tools:

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
- **macOS:** `~/Library/Application Support/com.example.agentsui/`
- **Linux:** `~/.local/share/com.example.agentsui/`
- **Windows:** `%APPDATA%\com.example.agentsui\`

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

Contributions are welcome! Here's how you can help:

1. **Report bugs** - Open an issue describing the problem
2. **Suggest features** - Open an issue with your idea
3. **Submit PRs** - Fork the repo and submit a pull request

### Development Guidelines

- Follow existing code style and patterns
- Test changes on multiple platforms when possible
- Update documentation for new features
- Keep commits focused and well-described

## License

```
Copyright 2024 Agents UI Contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## Acknowledgments

- [Tauri](https://tauri.app/) - The native app framework that makes this possible
- [xterm.js](https://xtermjs.org/) - Terminal emulator for the web
- [Anthropic](https://anthropic.com/), [OpenAI](https://openai.com/), [Google](https://google.com/) - AI agent providers

---

<p align="center">
  Made with Tauri, React, and Rust
</p>
