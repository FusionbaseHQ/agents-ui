import React from "react";
import { Icon } from "./Icon";

type Prompt = {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  pinned?: boolean;
  pinOrder?: number;
};

type QuickPromptsSectionProps = {
  prompts: Prompt[];
  activeSessionId: string | null;
  onSendPrompt: (prompt: Prompt) => void;
  onEditPrompt: (prompt: Prompt) => void;
  onOpenPromptsPanel: () => void;
};

export function QuickPromptsSection({
  prompts,
  activeSessionId,
  onSendPrompt,
  onEditPrompt,
  onOpenPromptsPanel,
}: QuickPromptsSectionProps) {
  const pinnedPrompts = prompts
    .filter((p) => p.pinned)
    .sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0))
    .slice(0, 5);

  if (pinnedPrompts.length === 0) return null;

  return (
    <>
      <div className="sidebarHeader">
        <div className="title">Quick Prompts</div>
        <button className="btn" onClick={onOpenPromptsPanel} title="Manage prompts">
          <Icon name="panel" />
        </button>
      </div>
      <div className="quickPromptsSection">
        {pinnedPrompts.map((p, idx) => (
          <button
            key={p.id}
            className="quickPromptItem"
            onClick={() => onSendPrompt(p)}
            onDoubleClick={() => onEditPrompt(p)}
            disabled={!activeSessionId}
            title={`${p.title}\n\nClick to send, double-click to edit`}
          >
            <span className="quickPromptIcon">{"\u2605"}</span>
            <span className="quickPromptTitle">{p.title}</span>
            <span className="quickPromptShortcut">
              {"\u2318"}
              {idx + 1}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
