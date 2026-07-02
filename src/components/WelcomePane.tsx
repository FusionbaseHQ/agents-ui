import React from "react";
import { KEY_BINDINGS, formatCombo, IS_MAC } from "../keymap";
import { Icon } from "./Icon";

export type WelcomeAgent = {
  id: string;
  label: string;
  iconSrc: string | null;
};

type WelcomeAction = {
  id: string;
  title: string;
  hint: string;
  icon: React.ReactNode;
  onClick: () => void;
};

type WelcomePaneProps = {
  projectTitle: string | null;
  isSshProject: boolean;
  /** Configured agent quick-starts (same list and icons as the sidebar). */
  agents: WelcomeAgent[];
  onNewTerminal: () => void;
  onNewTerminalWithShell: () => void;
  onStartAgent: (agentId: string) => void;
  onConnectSsh: () => void;
  onShowShortcuts: () => void;
};

const WELCOME_SHORTCUT_IDS = ["palette.open", "session.new", "files.search", "shortcuts.show"] as const;

/**
 * Shown in the terminal area when the active project has no sessions — the
 * app's first-run screen and every project's empty state. Cards call the same
 * handlers as the sidebar "+" menu and use the same iconography: one card per
 * configured agent (Claude Code, Codex, …) with its sidebar icon chip.
 */
export function WelcomePane(props: WelcomePaneProps) {
  const {
    projectTitle, isSshProject, agents,
    onNewTerminal, onNewTerminalWithShell, onStartAgent, onConnectSsh, onShowShortcuts,
  } = props;

  const actions: WelcomeAction[] = [
    {
      id: "terminal",
      title: "New terminal",
      hint: isSshProject ? "Connect to the project host" : "Opens the project's default shell",
      icon: (
        <span className="welcomeCardIcon welcomeCardIconTerminal">
          <Icon name="terminal" size={14} />
        </span>
      ),
      onClick: onNewTerminal,
    },
    ...(!isSshProject
      ? [
          {
            id: "shell",
            title: "Terminal with shell…",
            hint: "Pick agsh, Nushell, or an installed shell",
            icon: (
              <span className="welcomeCardIcon">
                <Icon name="terminal" size={14} />
              </span>
            ),
            onClick: onNewTerminalWithShell,
          },
        ]
      : []),
    ...agents.map((a) => ({
      id: `agent-${a.id}`,
      title: `Start ${a.label}`,
      hint: "Launch the agent in this project",
      icon: (
        <span className={`welcomeCardIcon welcomeCardIconAgent chip-${a.id}`}>
          {a.iconSrc ? (
            <img className="agentIcon" src={a.iconSrc} alt="" aria-hidden="true" />
          ) : (
            <Icon name="bolt" size={14} />
          )}
        </span>
      ),
      onClick: () => onStartAgent(a.id),
    })),
    {
      id: "ssh",
      title: "Connect SSH",
      hint: "Open a remote session",
      icon: (
        <span className="welcomeCardIcon welcomeCardIconSsh">
          <Icon name="ssh" size={14} />
        </span>
      ),
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
              {a.icon}
              <span className="welcomeCardBody">
                <span className="welcomeCardTitle">{a.title}</span>
                <span className="welcomeCardHint">{a.hint}</span>
              </span>
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
