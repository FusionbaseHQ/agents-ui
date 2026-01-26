import React from "react";
import { getProcessEffectById, type ProcessEffect } from "../processEffects";
import { shortenPathSmart } from "../pathDisplay";
import { Icon } from "./Icon";

function isSshCommand(commandLine: string | null | undefined): boolean {
  const trimmed = commandLine?.trim() ?? "";
  if (!trimmed) return false;
  const token = trimmed.split(/\s+/)[0];
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.toLowerCase().replace(/\.exe$/, "") === "ssh";
}

type Session = {
  id: string;
  name: string;
  command: string;
  cwd: string | null;
  launchCommand: string | null;
  restoreCommand?: string | null;
  persistent?: boolean;
  effectId?: string | null;
  processTag?: string | null;
  agentWorking?: boolean;
  recordingActive?: boolean;
  exited?: boolean;
  closing?: boolean;
  exitCode?: number | null;
};

type SessionsSectionProps = {
  agentShortcuts: ProcessEffect[];
  sessions: Session[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onQuickStart: (effect: ProcessEffect) => void;
  onOpenNewSession: () => void;
  onOpenAgentShortcuts: () => void;
  onOpenPersistentSessions: () => void;
  onOpenSshManager: () => void;
};

export function SessionsSection({
  agentShortcuts,
  sessions,
  activeSessionId,
  onSelectSession,
  onCloseSession,
  onQuickStart,
  onOpenNewSession,
  onOpenAgentShortcuts,
  onOpenPersistentSessions,
  onOpenSshManager,
}: SessionsSectionProps) {
  const createMenuRef = React.useRef<HTMLDivElement | null>(null);
  const settingsMenuRef = React.useRef<HTMLDivElement | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);

  React.useEffect(() => {
    if (!createOpen && !settingsOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (createMenuRef.current?.contains(target)) return;
      if (settingsMenuRef.current?.contains(target)) return;
      setCreateOpen(false);
      setSettingsOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setCreateOpen(false);
      setSettingsOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [createOpen, settingsOpen]);

  return (
    <>
      <div className="sidebarHeader">
        <div className="title">Sessions</div>
        <div className="sidebarHeaderActions">
          <div className="sidebarActionMenu" ref={createMenuRef}>
            <button
              type="button"
              className={`btnSmall btnIcon ${createOpen ? "btnIconActive" : ""}`}
              onClick={() =>
                setCreateOpen((prev) => {
                  const next = !prev;
                  if (next) setSettingsOpen(false);
                  return next;
                })
              }
              title="New terminal"
              aria-label="New terminal"
              aria-haspopup="menu"
              aria-expanded={createOpen}
            >
              <Icon name="plus" />
            </button>
            {createOpen && (
              <div className="sidebarActionMenuDropdown" role="menu" aria-label="New terminal">
                <button
                  type="button"
                  className="sidebarActionMenuItem"
                  role="menuitem"
                  onClick={() => {
                    setCreateOpen(false);
                    onOpenNewSession();
                  }}
                >
                  <Icon name="plus" />
                  <span
                    className="sessionLegendSwatch sessionLegendSwatchDefault"
                    aria-hidden="true"
                  />
                  <span>New terminal</span>
                </button>
                <button
                  type="button"
                  className="sidebarActionMenuItem"
                  role="menuitem"
                  onClick={() => {
                    setCreateOpen(false);
                    onOpenSshManager();
                  }}
                >
                  <Icon name="ssh" />
                  <span className="sessionLegendSwatch sessionLegendSwatchSsh" aria-hidden="true" />
                  <span>SSH connect</span>
                </button>
              </div>
            )}
          </div>

          <div className="sidebarActionMenu" ref={settingsMenuRef}>
            <button
              type="button"
              className={`btnSmall btnIcon ${settingsOpen ? "btnIconActive" : ""}`}
              onClick={() =>
                setSettingsOpen((prev) => {
                  const next = !prev;
                  if (next) setCreateOpen(false);
                  return next;
                })
              }
              title="Session tools"
              aria-label="Session tools"
              aria-haspopup="menu"
              aria-expanded={settingsOpen}
            >
              <Icon name="settings" />
            </button>
            {settingsOpen && (
              <div className="sidebarActionMenuDropdown" role="menu" aria-label="Session tools">
                <button
                  type="button"
                  className="sidebarActionMenuItem"
                  role="menuitem"
                  onClick={() => {
                    setSettingsOpen(false);
                    onOpenAgentShortcuts();
                  }}
                >
                  <Icon name="bolt" />
                  <span>Agent shortcuts</span>
                </button>
                <button
                  type="button"
                  className="sidebarActionMenuItem"
                  role="menuitem"
                  onClick={() => {
                    setSettingsOpen(false);
                    onOpenPersistentSessions();
                  }}
                >
                  <Icon name="layers" />
                  <span
                    className="sessionLegendSwatch sessionLegendSwatchPersistent"
                    aria-hidden="true"
                  />
                  <span>Manage persistent terminals</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {agentShortcuts.length > 0 && (
        <div className="agentShortcutRow" role="toolbar" aria-label="Agent shortcuts">
          {agentShortcuts.map((effect) => (
            <button
              key={effect.id}
              type="button"
              className="agentShortcutBtn"
              onClick={() => onQuickStart(effect)}
              title={`Start ${effect.label}`}
            >
              {effect.iconSrc ? (
                <img className="agentShortcutIcon" src={effect.iconSrc} alt="" aria-hidden="true" />
              ) : (
                <span className="agentShortcutIconFallback" aria-hidden="true">
                  {"\u25B6"}
                </span>
              )}
              <span className="agentShortcutLabel">{effect.label}</span>
            </button>
          ))}
        </div>
      )}

      <div className="sessionList">
        {sessions.length === 0 ? (
          <div className="empty">No sessions in this project.</div>
        ) : (
          sessions.map((s) => {
            const isActive = s.id === activeSessionId;
            const isExited = Boolean(s.exited);
            const isClosing = Boolean(s.closing);
            const effect = getProcessEffectById(s.effectId);
            const chipLabel = effect?.label ?? s.processTag ?? null;
            const hasAgentIcon = Boolean(effect?.iconSrc);
            const isWorking = Boolean(effect && s.agentWorking && !isExited && !isClosing);
            const isRecording = Boolean(s.recordingActive && !isExited && !isClosing);
            const launchOrRestore =
              s.launchCommand ??
              (s.restoreCommand?.trim() ? s.restoreCommand.trim() : null) ??
              null;
            const isSsh = isSshCommand(launchOrRestore);
            const isPersistent = Boolean(s.persistent);
            const isSshType = isSsh && !isPersistent;
            const isDefaultType = !isPersistent && !isSshType;
            const chipClass = effect
              ? `chip chip-${effect.id}`
              : isSshType
                ? "chip chip-ssh"
                : "chip";
            const showChipLabel =
              Boolean(chipLabel) &&
              !hasAgentIcon &&
              !(isSshType && (chipLabel ?? "").trim().toLowerCase() === "ssh");
            return (
              <div
                key={s.id}
                className={`sessionItem ${isActive ? "sessionItemActive" : ""} ${
                  isExited ? "sessionItemExited" : ""
                } ${isClosing ? "sessionItemClosing" : ""} ${
                  isSshType ? "sessionItemSsh" : ""
                } ${isPersistent ? "sessionItemPersistent" : ""} ${
                  isDefaultType ? "sessionItemDefault" : ""
                }`}
                onClick={() => onSelectSession(s.id)}
              >
                <div className={`dot ${isActive ? "dotActive" : ""}`} />
                <div className="sessionMeta">
                  <div className="sessionName">
                    {hasAgentIcon && chipLabel && effect?.iconSrc && (
                      <span className={`agentBadge chip-${effect.id}`} title={chipLabel}>
                        <img className="agentIcon" src={effect.iconSrc} alt={chipLabel} />
                        {isWorking && (
                          <span className="chipActivity agentBadgeDot" aria-label="Working" />
                        )}
                      </span>
                    )}
                    <span className="sessionNameText">{s.name}</span>
                    {showChipLabel && chipLabel && (
                      <span className={chipClass} title={chipLabel}>
                        <span className="chipLabel">{chipLabel}</span>
                        {isWorking && <span className="chipActivity" aria-label="Working" />}
                      </span>
                    )}
                    {isRecording && <span className="recordingDot" title="Recording" />}
                    {isClosing ? (
                      <span className="sessionStatus">closing…</span>
                    ) : isExited ? (
                      <span className="sessionStatus">
                        exited{s.exitCode != null ? ` ${s.exitCode}` : ""}
                      </span>
                    ) : null}
                  </div>
                  <div className="sessionCmd">
                    {(() => {
                      const parts: string[] = [];
                      if (s.cwd) parts.push(shortenPathSmart(s.cwd, 44));
                      if (launchOrRestore) parts.push(launchOrRestore);
                      if (!parts.length) parts.push(s.command);
                      return parts.join(" • ");
                    })()}
                  </div>
                </div>
                <button
                  className="closeBtn"
                  disabled={isClosing}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseSession(s.id);
                  }}
                  title="Close session"
                >
                  ×
                </button>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
