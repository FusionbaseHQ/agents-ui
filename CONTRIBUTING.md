# Contributing to Agents UI

Thanks for your interest in contributing!

By participating, you agree to follow our `CODE_OF_CONDUCT.md`.

## Ways to contribute

- File bug reports and feature requests (use the issue templates).
- Improve docs (README, troubleshooting, screenshots).
- Submit code changes (bugfixes, UX improvements, new features).

## Development setup

### Prerequisites

- Node.js 18+ (recommended)
- Rust toolchain (via rustup)
- Tauri prerequisites for your OS (macOS required today)

### Install & run

```bash
cd desktop
npm install
npm run tauri dev
```

### Build

```bash
npm run build
npm run tauri build
```

### Rust checks (backend)

```bash
cd src-tauri
cargo test
cargo clippy
```

## Project guidelines

- Keep PRs focused and easy to review.
- Prefer small, incremental changes over large refactors.
- Add/update docs when behavior changes.
- Don’t include secrets in issues/PRs/logs (recordings and env configs can contain credentials).

## Submitting a PR

1. Fork the repo and create a feature branch.
2. Make your change and ensure it builds locally.
3. Open a PR using the template and include:
   - what changed,
   - how you tested it,
   - screenshots/GIFs for UI changes.

## Reporting security issues

Please do not open a public issue for security-sensitive reports. See `SECURITY.md`.

