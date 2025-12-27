import React from "react";
import { PROCESS_EFFECTS, type ProcessEffect } from "../processEffects";

type AgentShortcutsModalProps = {
  isOpen: boolean;
  agentShortcuts: ProcessEffect[];
  onClose: () => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: (id: string) => void;
  onResetDefaults: () => void;
};

export function AgentShortcutsModal({
  isOpen,
  agentShortcuts,
  onClose,
  onMoveUp,
  onMoveDown,
  onRemove,
  onAdd,
  onResetDefaults,
}: AgentShortcutsModalProps) {
  if (!isOpen) return null;

  const pinned = new Set(agentShortcuts.map((e) => e.id));
  const available = PROCESS_EFFECTS
    .filter((e) => !pinned.has(e.id))
    .slice()
    .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modalTitle">Agent shortcuts</h3>
        <div className="hint" style={{ marginTop: 0 }}>
          Used for quick starts (sidebar + Cmd+K).
        </div>

        <div className="agentShortcutEditorSection">
          <div className="agentShortcutEditorTitle">Shortcuts</div>
          {agentShortcuts.length === 0 ? (
            <div className="empty">No shortcuts configured.</div>
          ) : (
            <div className="agentShortcutEditorList">
              {agentShortcuts.map((effect, idx) => (
                <div key={effect.id} className="agentShortcutEditorItem">
                  <div className="agentShortcutEditorMain">
                    {effect.iconSrc ? (
                      <img
                        className="agentShortcutEditorIcon"
                        src={effect.iconSrc}
                        alt=""
                        aria-hidden="true"
                      />
                    ) : (
                      <span className="agentShortcutEditorIconFallback" aria-hidden="true">
                        {"\u25B6"}
                      </span>
                    )}
                    <div className="agentShortcutEditorName">{effect.label}</div>
                  </div>
                  <div className="agentShortcutEditorActions">
                    <button
                      type="button"
                      className="btnSmall btnIcon"
                      disabled={idx === 0}
                      onClick={() => onMoveUp(effect.id)}
                      title="Move up"
                      aria-label="Move up"
                    >
                      <span aria-hidden="true">{"\u2191"}</span>
                    </button>
                    <button
                      type="button"
                      className="btnSmall btnIcon"
                      disabled={idx === agentShortcuts.length - 1}
                      onClick={() => onMoveDown(effect.id)}
                      title="Move down"
                      aria-label="Move down"
                    >
                      <span aria-hidden="true">{"\u2193"}</span>
                    </button>
                    <button
                      type="button"
                      className="btnSmall btnIcon btnDanger"
                      onClick={() => onRemove(effect.id)}
                      title="Remove"
                      aria-label="Remove"
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="agentShortcutEditorSection">
          <div className="agentShortcutEditorTitle">Add agent</div>
          <div className="agentShortcutAddRow">
            {available.length === 0 ? (
              <div className="empty">No more agents available.</div>
            ) : (
              available.map((effect) => (
                <button
                  key={effect.id}
                  type="button"
                  className="agentShortcutAddBtn"
                  onClick={() => onAdd(effect.id)}
                  title={`Add ${effect.label}`}
                >
                  {effect.iconSrc ? (
                    <img
                      className="agentShortcutAddIcon"
                      src={effect.iconSrc}
                      alt=""
                      aria-hidden="true"
                    />
                  ) : (
                    <span className="agentShortcutAddIconFallback" aria-hidden="true">
                      {"\u25B6"}
                    </span>
                  )}
                  <span className="agentShortcutAddLabel">{effect.label}</span>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="modalActions">
          <button type="button" className="btnSmall" onClick={onResetDefaults}>
            Reset defaults
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

