# UI/UX Overhaul — Phase 1 (2026-07-02)

**Branch:** `feature/ui-ux-overhaul` (from `feature/bring-your-own-shell`)
**Origin:** full-app UX review (consistency, discoverability, architecture);
this phase implements the review's foundation + IA + feedback + onboarding
items. Agent-native features and the deep state refactor are deferred (§ Deferred).

## Shipped (one commit per block)

1. **`src/ui/` primitive kit** — `Modal` (shared chrome + Escape/click-outside/
   focus), `Menu` (portal, viewport-clamped, arrows/Home/End/Enter, same
   `.wsMenu` styling), `Toast`/`ToastHost` (module-level store via
   `useSyncExternalStore`, tones, action button), `EmptyState`, `Badge`.
2. **Declarative keymap** — `src/keymap.ts` is the single binding table
   (id/title/section/per-platform combo) with an exact-modifier matcher;
   App's keydown handler dispatches on binding id (old duplicated mac/non-mac
   ladders deleted). `ShortcutsModal` on **mod+/** renders the same table.
3. **Two-tier notifications** — `showNotice()` and `reportError()` raise
   toasts (errors additionally stay in the ActivityCenter as the persistent
   log); shell-fallback events are titled warning toasts; recording start/stop
   get success toasts.
4. **Welcome pane + empty-state CTAs** — `WelcomePane` overlays the terminal
   area when the active project has no sessions (backdrop is
   `pointer-events: none` so an open file viewer stays interactive). All
   bare-text empty states upgraded to `EmptyState` with actions.
5. **Unified Settings** (`SettingsModal`, replaces the gear dropdown) —
   Appearance (theme grid; hover live-previews by setting `data-theme` on the
   document root, restore on leave), Terminal (**app-global default shell**,
   persisted in localStorage `agents-ui-app-default-shell-v1`; precedence:
   per-terminal pick > project default > app default > bundled agsh via
   `shellChoiceForProject()`), Power, Keyboard, Storage & updates.
6. **Status bar** (`StatusBar`) — session facts left (shell chip — sessions
   now carry their launch `shellChoice`; cwd; ssh + connection state), app
   status right (REC moved from topbar, keep-awake, update-available,
   version).
7. **Session tab strip** — the old recency-only history bar is now the active
   project's sessions in stable sidebar order, always visible; × / middle-
   click closes the session. `sessionHistory` state removed.
8. **Menu migration** — sidebar's four bespoke portal menus (new-session "+",
   project context, session context, section overflow) on the `Menu`
   primitive; symbol/color pickers and workspace switcher intentionally stay
   hand-rolled (they're grids/popovers, not menus).
9. **Modal migration** — the nine inline `.modalBackdrop` dialogs in App.tsx
   plus PersistentSessions/AgentShortcuts modals on `Modal`;
   ConfirmDeleteProject/Recording deleted in favor of `ConfirmActionModal`
   (itself on `Modal`).
10. **⌘K completeness** — `CommandPalette` gained `extraActions`; App feeds
    Settings, Shortcuts, Terminal with Shell…, New Project, Persistent
    Terminals, Agent Shortcuts, Check for Updates, Toggle Agent Panel.

## Behavior notes

- Modifier matching is exact: Cmd+Shift+T no longer triggers Cmd+T; mac
  terminal search is Cmd+F only (the accidental Ctrl+Shift+F alias is gone).
- Tab strip closes sessions (real tabs), not "remove from list".
- Settings' theme hover-preview mutates `data-theme` live and restores the
  committed theme on grid mouse-leave/unmount.

## Deferred (next phases)

## Phase 2 (same day) — the previously-deferred items

11. **Unified new-session flow** (`NewSessionFlow`, on ⌘T + palette "New
    Session") — one keyboard-first list: Terminal with the effective default
    shell (created directly), Terminal with shell…, agent quick-starts, SSH
    connection…, Custom command… (the old command+cwd modal remains as that
    last option's implementation).
12. **Semantic command timeline** — `SessionTimeline` (SlidePanel "Timeline"
    tab, mod+shift+e, ⌘K): per-command rows from the OSC 133 blocks that
    `SessionShellIntegration` tracks (exit dot, duration — live while
    running, start time; click scrolls the terminal to the command; hover →
    Copy output). `SessionShellIntegration` gained change events. Backend:
    OSC 133 emission wired for every managed shell — agsh (B marker added
    upstream + sidecars rebuilt), managed zsh ZDOTDIR startup, injected bash
    PROMPT_COMMAND/PS0/PS1, and the bundled Nushell config.
13. **Store decomposition begun** — `src/stores/` with the module-store +
    `useSyncExternalStore` pattern (no new deps): `shells.ts` (detected
    shells, app default shell, launch-precedence helper) and `updates.ts`
    (app info + GitHub release check). Toasts already live in `src/ui/toast`.
    Remaining domains (sessions, projects/workspaces, panels, recordings,
    prompts, environments, assets, ssh) follow the same pattern; migrate one
    per PR. App.tsx shrinks with each tranche.
14. **Modal consistency completed** — the remaining component dialogs
    (ShellPicker, NewSession, Project, SshManager, PathPicker, ApplyAsset,
    Update) migrated onto the `Modal` primitive as well.
15. Inline session-color affordance on sidebar row hover (wand button opens
    the color picker directly; right-click keeps symbol & the rest).

## Roadmap (beyond this branch)

- Finish the store migration domain-by-domain until App.tsx is a composition
  root; then a `ModalHost` registry for dialog state.
- Agent-native, next level: agsh output-mode/confine controls as first-class
  session UI; agent activity feed (commands/min, sandbox status) in the
  sidebar; collapsible output folding inside the terminal view itself.
- Drag-to-reorder tabs in the tab strip (sidebar rows already drag).
- styles.css split per component / design-token extraction.
- Broader ARIA pass beyond modals/menus/timeline.
