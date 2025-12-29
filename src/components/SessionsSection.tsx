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
  return (
    <>
      <div className="sidebarHeader">
        <div className="title">Sessions</div>
        <div className="sidebarHeaderActions">
          <button
            type="button"
            className="btnSmall btnIcon"
            onClick={onOpenNewSession}
            title="New session"
            aria-label="New session"
          >
            <Icon name="plus" />
          </button>
          <button
            type="button"
            className="btnSmall btnIcon"
            onClick={onOpenPersistentSessions}
            title="Persistent sessions"
            aria-label="Persistent sessions"
          >
            <Icon name="layers" />
          </button>
          <button
            type="button"
            className="btnSmall btnIcon"
            onClick={onOpenSshManager}
            title="SSH connect"
            aria-label="SSH connect"
          >
            <Icon name="ssh" />
          </button>
          <button
            type="button"
            className="btnSmall btnIcon"
            onClick={onOpenAgentShortcuts}
            title="Agent shortcuts"
            aria-label="Agent shortcuts"
          >
            <Icon name="bolt" />
          </button>
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
            const chipClass = effect ? `chip chip-${effect.id}` : isSsh ? "chip chip-ssh" : "chip";
            const showSshChip = isSsh && (!chipLabel || chipLabel.toLowerCase() !== "ssh");
            return (
              <div
                key={s.id}
                className={`sessionItem ${isActive ? "sessionItemActive" : ""} ${
                  isExited ? "sessionItemExited" : ""
                } ${isClosing ? "sessionItemClosing" : ""} ${isSsh ? "sessionItemSsh" : ""}`}
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
                    {showSshChip ? (
                      <span className="chip chip-ssh" title="SSH">
                        <span className="chipLabel">ssh</span>
                      </span>
                    ) : null}
                    {s.persistent ? (
                      <span className="chip" title="Persistent (zellij)">
                        <span className="chipLabel">persist</span>
                      </span>
                    ) : null}
                    {chipLabel && !hasAgentIcon && (
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
