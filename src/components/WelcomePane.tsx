import { KEY_BINDINGS, formatCombo, IS_MAC } from "../keymap";

type WelcomeAction = {
  id: string;
  title: string;
  hint: string;
  onClick: () => void;
};

type WelcomePaneProps = {
  projectTitle: string | null;
  isSshProject: boolean;
  /** Label of the first configured agent quick-start (e.g. "Claude"), if any. */
  agentLabel: string | null;
  onNewTerminal: () => void;
  onNewTerminalWithShell: () => void;
  onStartAgent: () => void;
  onConnectSsh: () => void;
  onShowShortcuts: () => void;
};

const WELCOME_SHORTCUT_IDS = ["palette.open", "session.new", "files.search", "shortcuts.show"] as const;

/**
 * Shown in the terminal area when the active project has no sessions — the
 * app's first-run screen and every project's empty state. Cards call the same
 * handlers as the sidebar "+" menu.
 */
export function WelcomePane(props: WelcomePaneProps) {
  const {
    projectTitle, isSshProject, agentLabel,
    onNewTerminal, onNewTerminalWithShell, onStartAgent, onConnectSsh, onShowShortcuts,
  } = props;

  const actions: WelcomeAction[] = [
    {
      id: "terminal",
      title: "New terminal",
      hint: isSshProject ? "Connect to the project host" : "Opens the project's default shell",
      onClick: onNewTerminal,
    },
    ...(!isSshProject
      ? [
          {
            id: "shell",
            title: "Terminal with shell…",
            hint: "Pick agsh, Nushell, or an installed shell",
            onClick: onNewTerminalWithShell,
          },
        ]
      : []),
    ...(agentLabel
      ? [
          {
            id: "agent",
            title: `Start ${agentLabel}`,
            hint: "Launch the agent in this project",
            onClick: onStartAgent,
          },
        ]
      : []),
    {
      id: "ssh",
      title: "Connect SSH",
      hint: "Open a remote session",
      onClick: onConnectSsh,
    },
  ];

  const shortcuts = WELCOME_SHORTCUT_IDS
    .map((id) => KEY_BINDINGS.find((b) => b.id === id))
    .filter((b): b is (typeof KEY_BINDINGS)[number] => Boolean(b));

  return (
    <div className="welcomePane" role="region" aria-label="Getting started">
      <div className="welcomeInner">
        <div className="welcomeTitle">
          {projectTitle ? `No sessions in ${projectTitle}` : "No sessions yet"}
        </div>
        <div className="welcomeSubtitle">Start something:</div>
        <div className="welcomeCards">
          {actions.map((a) => (
            <button key={a.id} type="button" className="welcomeCard" onClick={a.onClick}>
              <span className="welcomeCardTitle">{a.title}</span>
              <span className="welcomeCardHint">{a.hint}</span>
            </button>
          ))}
        </div>
        <div className="welcomeShortcuts">
          {shortcuts.map((b) => (
            <button
              key={b.id}
              type="button"
              className="welcomeShortcut"
              onClick={b.id === "shortcuts.show" ? onShowShortcuts : undefined}
              disabled={b.id !== "shortcuts.show"}
            >
              <kbd className="shortcutsKeys">{formatCombo(b, IS_MAC)}</kbd>
              <span>{b.title}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
