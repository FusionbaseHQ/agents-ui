# Bring Your Own Shell — Design Plan

**Status:** Proposed (no implementation yet)
**Branch:** `feature/bring-your-own-shell`
**Author:** design pass, 2026-06-27

---

## 1. Goal

Today the app is a self-contained appliance: it bundles **Nushell** (`nu`) and
**Zellij** as external binaries and always launches `nu` as the interactive
shell, reconstructing a clean login `PATH` from the user's real login shell so
everything "just works" with zero setup. This is great for the out-of-the-box
experience and **must stay the default**.

Many developers, however, have heavily customized shells (zsh + oh-my-zsh /
starship / zinit, fish + fisher, bash + bash-it, etc.). They want their own
prompt, aliases, completions, and plugins inside the app. The feature lets a
user **bring their own terminal**: choose, per project (and optionally
per-session), which installed shell a new session launches with — while keeping
bundled Nushell as the safe default.

### Non-goals (this iteration)

- Bundling additional shells. We only *use* shells the user already has.
- Windows shell selection (PowerShell/cmd). Keep the existing Windows path
  untouched; the feature is macOS/Unix-first (matches the rest of the app).
- Changing how Zellij is bundled or how persistence works.
- Per-session shell *plugins* management. We launch the user's existing config;
  we don't manage it.

---

## 2. How shells are spawned today (ground truth)

All session spawning goes through **`src-tauri/src/pty.rs :: create_session`**
(line ~1372). Relevant facts:

| Concern | Current behavior | Code |
| --- | --- | --- |
| Default shell resolution | `default_user_shell()` → `$SHELL`, then `/etc/passwd`, then `/bin/zsh` on macOS | `pty.rs:190` |
| Interactive shell choice | If `find_bundled_nu()` returns a path → launch **bundled nu** (`use_nu=true`); else fall back to `$SHELL -l` | `pty.rs:1482-1508` |
| Run-a-command session | `$SHELL -lc <command>` (used by agent quick-starts like `claude`, `codex`) | `pty.rs:1500-1508` |
| Persistent session | bundled **zellij `attach -c`**, whose inner shell is set via a `SHELL` wrapper script that `exec`s `$AGENTS_UI_ZELLIJ_REAL_SHELL -l`; inner shell = bundled nu if present else `$SHELL` | `pty.rs:1432-1481`, wrapper `pty.rs:616-666` |
| PATH reconstruction (macOS) | `login_shell_path(shell, fallback)` spawns the user's login shell to capture `$PATH`, cached in `login_path_cache` keyed by shell. Supports **zsh/bash/fish/nu** arg-sets, PTY first then non-PTY fallback. | `pty.rs:286-410`, `pty.rs:1655-1699` |
| Nu sandboxing | When `use_nu`, `ensure_nu_config()` writes a managed `config.nu` into an app-private XDG dir and points `XDG_CONFIG_HOME/...` at it, so bundled nu does **not** read the user's real nu config and gets our shell-integration hooks. | `pty.rs:1124+`, `pty.rs:1711-1728` |
| zsh integration | When the shell is zsh (non-nu), a temp `ZDOTDIR` is created that sources the user's real zsh config + injects OSC shell-integration. | `pty.rs:1755-1778`, `write_zsh_startup_files` |
| bash integration | When the shell is bash (non-nu), `PROMPT_COMMAND` is injected for OSC `CurrentDir`. | `pty.rs:1741-1753` |
| Shell-integration assets | `src-tauri/resources/shell-integration/{bash,zsh}-integration.sh` (OSC 133 + CurrentDir) already ship. | resources dir |

**Key takeaway:** the machinery to run zsh/bash/fish as a real interactive shell
**already exists and is exercised** (PATH import, OSC integration, ZDOTDIR
shimming, the zellij "real shell" wrapper). What is missing is:

1. A way to **enumerate** installed shells safely.
2. A **selection** plumbed from a project/session setting into `create_session`.
3. A small generalization of the "prefer bundled nu" branch so it honors that
   selection instead of being hardcoded.

This makes the feature mostly *plumbing + UX*, not new shell-launching logic —
which keeps risk low.

`create_session` currently takes **no shell parameter** (`pty.rs:1372-1383`).
Frontend invokes it from `createSession()` (`src/App.tsx:1776`, the `invoke` at
`:1823`) and passes `name / command / cwd / envVars / persistent / persistId`.

---

## 3. Design principles

1. **Default unchanged.** A user who never touches the setting gets bundled
   Nushell, exactly as today. The bundled-nu fast path stays the literal default
   of the new "shell kind" enum.
2. **Detection must never break a session.** Shell discovery is advisory: it
   populates a picker. Launch never depends on discovery succeeding — if the
   chosen shell is missing at spawn time we fall back to bundled nu (or `$SHELL`)
   and surface a non-fatal warning. The terminal always opens.
3. **No hangs.** Any process we spawn to detect/validate a shell uses the
   existing `run_command_output_with_timeout` (or PTY variant) with a short
   timeout. We never block the UI thread; detection runs async and is cached.
4. **Re-use, don't reinvent.** Honor the selection by steering the *existing*
   `use_nu` / inner-shell branch and the existing per-shell integration paths.
   No second code path for "custom shells."
5. **Graceful degradation by shell family.** Known shells (nu, zsh, bash, fish)
   get full treatment (PATH import + OSC integration). Unknown-but-runnable
   shells (ksh, tcsh, dash, pwsh, xonsh, elvish, …) launch in "best-effort"
   mode: login flag if known-safe, generic PATH fallback, no OSC injection.

---

## 4. Shell detection (battle-proof)

New backend command: **`detect_shells() -> Vec<ShellInfo>`** (in `pty.rs`, or a
new `shells.rs` module). Runs on demand and is cached; the picker requests it
when opened and on a manual "Rescan".

### 4.1 Candidate sources (union, then validate)

Gather candidate paths from multiple independent sources so one failing source
never blanks the list:

1. **`/etc/shells`** — the canonical macOS list of login-approved shells. Parse
   lines, ignore comments/blanks.
2. **`$SHELL`** — the user's configured login shell.
3. **`/etc/passwd` entry** — via the existing `shell_from_passwd()` (`pty.rs`).
4. **Well-known absolute paths** — probe a fixed allowlist of common locations:
   - `/bin/{zsh,bash,sh,dash,ksh,tcsh,csh}`
   - `/usr/local/bin/{zsh,bash,fish,nu,pwsh,xonsh,elvish,dash,ksh,tcsh}`
   - `/opt/homebrew/bin/{zsh,bash,fish,nu,pwsh,xonsh,elvish,dash,ksh,tcsh}`
   - `/usr/bin/{zsh,bash,sh,ksh,tcsh,csh}`
5. **`PATH` lookup** — using the already-reconstructed login `PATH` (reuse the
   `login_path_cache`), look up each known shell name on `PATH`. This catches
   shells installed in nonstandard prefixes (nix, asdf, custom).
6. **Bundled Nushell** — always present; surfaced as the special built-in entry
   (see 4.4).

### 4.2 Validation pipeline

For each candidate path:

1. **Exists & is a regular file** (follow symlinks).
2. **Is executable** (mode `& 0o111`, Unix).
3. **Canonicalize** (`fs::canonicalize`) and **dedupe** by canonical path, so
   `/bin/zsh`, a symlinked `/usr/local/bin/zsh`, and the `$SHELL` value collapse
   to one entry. Keep the most "user-friendly" display path.
4. **Classify family** from the file name: `nu | zsh | bash | fish | sh | dash |
   ksh | tcsh | csh | pwsh | xonsh | elvish | unknown`.
5. **Optional liveness probe (best-effort, timeout-guarded):** run
   `--version` (or the shell's equivalent) with a ≤1.5 s timeout via
   `run_command_output_with_timeout`. Capture a short version string. If it
   times out or errors, still list the shell but mark `verified=false`. **Never
   let a probe failure remove a shell from the list** — an unverified zsh is
   still launchable.

### 4.3 `ShellInfo` shape

```rust
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub id: String,        // stable key, e.g. canonical path or "bundled-nu"
    pub kind: String,      // "bundled-nu" | "system-nu" | "zsh" | "bash" | "fish" | ...
    pub display_name: String, // "Zsh", "Fish", "Bundled Nushell"
    pub path: String,      // absolute launch path ("" for bundled — resolved at spawn)
    pub version: Option<String>,
    pub verified: bool,    // liveness probe succeeded
    pub is_login_default: bool, // == $SHELL / passwd shell
    pub supports_integration: bool, // we have PATH-import + OSC for this family
    pub source: Vec<String>, // provenance: ["/etc/shells", "$SHELL", "PATH"] (debug/UI hint)
}
```

### 4.4 The bundled-Nushell entry

Always first in the list, `kind: "bundled-nu"`, `display_name: "Bundled Nushell
(default)"`, `path: ""`. At spawn time it resolves through the existing
`find_bundled_nu()` path. This means "default" is a real, selectable, explained
item — not a hidden fallback.

### 4.5 Caching & invalidation

- Cache the `Vec<ShellInfo>` in `AppState` (like `login_path_cache`).
- Invalidate on explicit **Rescan** from the UI.
- Cheap; detection is a few stats + a handful of timeout-bounded `--version`
  calls. Run it lazily (first picker open) so app startup is unaffected.

### 4.6 Safety notes

- The liveness probe runs the shell **non-interactively with a fixed
  `--version`-style arg and a clean env** — never sources user rc files, never
  opens a PTY, hard timeout. No recursion risk (we never spawn the app's own
  wrapper).
- We only ever *launch* a shell the user explicitly selected; detection itself
  is read-mostly (stat + version string).

---

## 5. Data model & selection precedence

A session's shell is resolved at creation time by precedence:

```
explicit per-session override  >  project.defaultShell  >  app.defaultShell  >  bundled nu
```

### 5.1 The shell selector value

Represent a choice as a small tagged value so it survives a shell being
moved/uninstalled and round-trips cleanly:

```ts
type ShellChoice =
  | { kind: "bundled-nu" }              // the default
  | { kind: "system"; path: string; family: string }; // e.g. zsh at /bin/zsh
```

- `bundled-nu` is the sentinel default (stored as absence/`null` for forward
  compat — see migration).
- `system` carries the **resolved absolute path** *and* the family, so the
  backend can pick the right integration without re-detecting, and the UI can
  show "Zsh (/bin/zsh)". If the path is gone at spawn time → fallback + warning.

### 5.2 Frontend type changes

- `Project` (`src/App.tsx:70`): add `defaultShell?: ShellChoice | null`.
- New app-level setting `appDefaultShell` (default `bundled-nu`), stored in
  localStorage like `uiTheme` / `autoCaffeinate`
  (`STORAGE_DEFAULT_SHELL_KEY = "agents-ui-default-shell-v1"`).
- `NewSessionModal` submit data: add optional `shell?: ShellChoice`.
- Persisted session (optional, nice-to-have): record the resolved shell on the
  `Session` so a relaunch/restore reuses it. (`PersistedSession`, `src/App.tsx`.)

### 5.3 Backend type changes

- `PersistedProjectV1` (`src-tauri/src/persist.rs:19`): add
  `pub default_shell: Option<ShellChoiceDto>` with `#[serde(default,
  skip_serializing_if = "Option::is_none")]` (back-compat: old files lack it).
- `create_session` gains a parameter `shell: Option<ShellChoiceDto>`
  (`pty.rs:1372`). `None` ⇒ today's behavior (bundled nu). The frontend resolves
  precedence and passes the concrete choice; the backend treats it as the source
  of truth for that session.

---

## 6. Backend: honoring the selection in `create_session`

The change is **localized to the shell-decision block** (`pty.rs:1432-1519`).
Today it is: persistent? → zellij; else empty command? → prefer bundled nu; else
→ `$SHELL -lc cmd`. Generalize the "which interactive shell" decision into one
helper:

```rust
enum ResolvedShell {
    BundledNu,                 // use_nu = true, current default path
    System { path: String, family: ShellFamily }, // run this binary
}

fn resolve_shell(choice: Option<ShellChoiceDto>) -> ResolvedShell {
    match choice {
        None | Some(bundled-nu) => BundledNu (if find_bundled_nu().is_some()),
        Some(system{path, family}) if path exists & executable => System{..},
        _ => /* fallback */ BundledNu or default_user_shell(),
    }
}
```

Then:

- **Interactive (empty command):**
  - `BundledNu` → unchanged (`use_nu=true`, nu config sandbox).
  - `System{zsh}` → `path -l`, plus the existing ZDOTDIR integration
    (`pty.rs:1755`). Today that block keys off `shell_name.contains("zsh")`;
    point it at the *resolved* shell name (it already uses `inner_shell`).
  - `System{bash}` → `path -l` + existing `PROMPT_COMMAND` integration.
  - `System{fish}` → `path -l -i`; PATH import already supported in
    `login_shell_path`. (OSC integration for fish = follow-up; see §11.)
  - `System{other}` → `path -l` if family known-safe, else `path` (no login
    flag if the shell is hostile to it, e.g. some `csh`); no OSC injection;
    `verified` gating decides whether we even offer it.
- **Run-a-command (agent quick-starts like claude/codex):** replace the
  hardcoded `default_user_shell()` with the resolved shell so `claude` runs under
  the user's chosen login shell (`<shell> -lc <command>`). Falls back to `sh -lc`
  for shells without a `-lc` convention.
- **Persistent (zellij):** set `inner_shell` = resolved shell path instead of
  "bundled nu if present else $SHELL". The wrapper already execs
  `$AGENTS_UI_ZELLIJ_REAL_SHELL -l` (`pty.rs:645-649`); set
  `AGENTS_UI_ZELLIJ_RESTORE_XDG` correctly (it already is `0` for nu, `1`
  otherwise — keep that: nu wants our sandboxed XDG, real shells want the user's).

### 6.1 PATH import per chosen shell

`login_shell_path` is keyed and cached by `shell` string (`pty.rs:1655`). It
already handles zsh/bash/fish/nu. Since the chosen shell may differ from
`$SHELL`, the cache key must be the *resolved* shell path, not `default_user_shell()`.
For an unknown family, fall back to the existing fabricated PATH (homebrew +
standard dirs, `pty.rs:1622-1652`) — that path already exists as the safety net.

### 6.2 Fallback & telemetry

If `resolve_shell` can't honor the choice (binary vanished, not executable),
spawn the default and **emit a session event** the frontend shows as a toast:
"Couldn't launch <shell> (not found); started Bundled Nushell instead." Never
error the whole `create_session`.

---

## 7. UX design

Three surfaces, increasing specificity. All show the bundled Nushell entry first
and clearly label it the default.

### 7.1 App-level default (global)

In the existing **Application settings menu** (`src/App.tsx:9809-9856`, where
Theme + Auto-Caffeinate live), add a **"Default shell"** section: a small
submenu / select listing detected shells + "Bundled Nushell (default)". Wiring
mirrors `autoCaffeinate`: `useState`, localStorage persist effect, no backend
call needed (resolution happens at session create). This sets the fallback for
projects that don't override.

### 7.2 Project-level default (primary surface)

In **`ProjectModal.tsx`** (where title / basePath / environment / assets live),
add a **"Default shell"** select:

```
Default shell:  [ Bundled Nushell (default) ▾ ]
                  • Bundled Nushell (default)
                  • Use app default (Zsh)
                  • ─────────────
                  • Zsh            /bin/zsh            ✓ login default
                  • Fish           /opt/homebrew/bin/fish
                  • Bash           /bin/bash
                  • Rescan…
                Sessions in this project start with this shell.
                Existing sessions are unaffected.
```

- Populated by `detect_shells` (invoked when the modal opens; show a tiny
  spinner while detecting, with the cached list shown instantly on reopen).
- Unverified shells render greyed with a tooltip ("couldn't confirm this shell
  runs; will try anyway"). Still selectable.
- Persisted into `Project.defaultShell` → `PersistedProjectV1.default_shell`
  through the existing `onProjectSubmit` flow (`src/App.tsx:7622`).

### 7.3 Per-session override (new-session moment)

In **`NewSessionModal`** (opened by the project "+" → "Terminal", handled at
`onNewSubmit`, `src/App.tsx:8525`), add a compact **shell dropdown** defaulting
to *"Project default (<name>)"* with the option to pick a specific shell for
just this session. This is the "I usually use nu here but let me pop a fish for
one task" path.

- Default selection label makes the inheritance explicit.
- The agent quick-starts ("Claude session", "Codex session" from
  `PROCESS_EFFECTS`, launched via `handleQuickStartForProject` → `quickStart`,
  `src/App.tsx:9318`) do **not** prompt — they silently inherit the project
  default shell (those run `<shell> -lc claude`). This keeps the one-click agent
  flow one-click.

### 7.4 Surfacing the active shell

- Show a subtle shell glyph/label on the session row or terminal header (e.g.
  "nu" / "zsh" / "fish") so users can tell what a session is running, especially
  after a fallback. Reuse the existing per-session `symbol`/badge slot.
- Fallback events (§6.2) raise a toast.

### 7.5 Selection flow (sequence)

```
User opens project "+" ──▶ "Terminal" ──▶ NewSessionModal
   shell field = "Project default (Zsh)"   (project.defaultShell = system zsh)
        │ user keeps default
        ▼
 createSession({ ..., shell: resolve(project, app) })  // = {kind:system, zsh, /bin/zsh}
        ▼
 invoke("create_session", { ..., shell })
        ▼
 pty.rs resolve_shell → System{zsh} → spawn `/bin/zsh -l` + ZDOTDIR integration
        ▼
 fallback? → toast + bundled nu      success? → session row shows "zsh"
```

---

## 8. Edge cases & failure modes

| Case | Handling |
| --- | --- |
| Chosen shell uninstalled between selection and launch | Spawn default, non-fatal toast (§6.2). Project setting left as-is (user may reinstall). |
| `$SHELL` points to a path not in `/etc/shells` | Still listed (source `$SHELL`); chsh-approval is irrelevant for our spawn. |
| Shell on a slow network mount (`--version` hangs) | Timeout → listed `verified=false`. Spawn still attempted on demand. |
| Non-POSIX shell picked but PATH import unsupported | Falls back to fabricated PATH (homebrew + standard dirs) — already the safety net. |
| Persistent (zellij) session + custom shell | Inner shell = chosen shell via wrapper; XDG restore = on for non-nu. Existing detached sessions keep whatever shell they were created with (don't retro-rewrite). |
| nu-specific config sandbox vs real shell | Only `use_nu` sessions get the sandboxed XDG + managed `config.nu`. Real shells read the user's real config (the whole point). The XDG restore in the wrapper guarantees this for persistent sessions too. |
| Windows | Feature hidden / no-op; keep `COMSPEC` path (`pty.rs:1387,1510`). |
| Detection returns empty (locked-down box) | Picker still shows Bundled Nushell + the `$SHELL`/passwd entry; never an empty list. |
| User selects "csh/tcsh" (no `-lc`, hostile to `-l` in some setups) | Family flagged `supports_integration=false`; launch with conservative args; documented as best-effort. |

---

## 9. Migration & backward compatibility

- **Persisted projects without `default_shell`** deserialize fine
  (`#[serde(default)]`) and resolve to app-default → bundled nu. No migration
  step required.
- **Frontend localStorage:** new `STORAGE_DEFAULT_SHELL_KEY`; absence ⇒
  `bundled-nu`. Mirrors how `autoCaffeinate` / `uiTheme` already degrade.
- **`create_session` signature:** new `shell` param is `Option`; existing
  callers (and the MCP `create_session` tool, if any) that omit it keep today's
  behavior. Audit `mcp_tools.rs` for a `create_session` wrapper and thread the
  optional param (default `None`).
- No change to the on-disk Zellij session naming, sockets, or recording.

---

## 10. Testing plan

**Rust (unit / integration):**
- `detect_shells` returns bundled nu even on a box with nothing else; dedupes
  symlinked zsh; never panics on a missing `/etc/shells`.
- `resolve_shell` precedence + fallback when path missing.
- `login_shell_path` cache keyed by resolved shell (zsh ≠ fish ≠ nu).
- Liveness probe respects timeout (point a candidate at a `sleep` script).

**Manual matrix (macOS, the supported platform):**
- Default (no setting) → bundled nu, banner suppressed, PATH correct. *(regression)*
- Project default = system zsh → prompt = user's zsh prompt, aliases work,
  `echo $PATH` matches login PATH, OSC CurrentDir + 133 markers work.
- Project default = fish → fish prompt/abbreviations load, PATH correct.
- Per-session override differs from project default.
- Agent quick-start (claude) runs under chosen shell.
- Persistent (zellij) session with system zsh; detach + reattach preserves it.
- Uninstall the chosen shell, open a session → fallback toast + bundled nu.
- Slow/hanging shell `--version` → picker still populates within timeout.

**Snapshot/regression:** confirm a clean install with no settings touched is
byte-for-byte the same launch (`shown_command == "nu"`, sandboxed XDG).

---

## 11. Phased implementation

1. **Backend detection** — `detect_shells` + `ShellInfo` + cache + tests. No UI
   yet; verify via a temporary devtools `invoke`.
2. **Backend selection** — `shell` param on `create_session`, `resolve_shell`,
   route through existing nu/zsh/bash/fish branches; fallback + event. Persist
   `default_shell` on `PersistedProjectV1`.
3. **Frontend plumbing** — `ShellChoice` type, precedence resolver, pass through
   `createSession`/`invoke`. App-default setting in the settings menu.
4. **Project setting UI** — shell select in `ProjectModal` + persistence.
5. **Per-session override UI** — shell dropdown in `NewSessionModal`; session-row
   shell badge; fallback toast.
6. **Polish / follow-ups** — fish OSC integration parity; remember resolved
   shell on persisted sessions; "Rescan" affordance; docs/README + CHANGELOG.

Each phase is independently shippable; after phase 2 the feature works end-to-end
via a hardcoded choice, de-risking the UI work.

---

## 12. Open questions

1. **Per-session shell badge** — reuse the session `symbol` slot, or add a
   dedicated small label? (Leaning: dedicated muted label so user symbols stay
   free.)
2. **Should agent quick-starts ever prompt for a shell?** (Leaning: no — inherit
   project default silently; power users override via a plain Terminal session.)
3. **Remember last-used per-session shell** as the NewSessionModal default, or
   always reset to project default? (Leaning: default to project, remember last
   as a future nicety.)
4. **Expose unverified shells** by default or behind an "show all" toggle?
   (Leaning: show, greyed, with tooltip — discovery beats hiding.)
5. **fish OSC integration** now or as the phase-6 follow-up? (Leaning: follow-up;
   PATH import already works, integration is cosmetic.)
