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

export const QuickPromptsSection = React.memo(function QuickPromptsSection({
  prompts,
  activeSessionId,
  onSendPrompt,
  onEditPrompt,
  onOpenPromptsPanel,
}: QuickPromptsSectionProps) {
  const pinnedPrompts = React.useMemo(
    () =>
      prompts
        .filter((p) => p.pinned)
        .sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0))
        .slice(0, 5),
    [prompts],
  );

  if (pinnedPrompts.length === 0) return null;

  return (
    <section className="quickPromptsTreeGroup" aria-label="Quick prompts">
      <div className="quickPromptsSection sidebarTreeList">
        <button
          type="button"
          className="quickPromptItem quickPromptManageItem sidebarTreeItem"
          onClick={onOpenPromptsPanel}
          title="Manage prompts"
        >
          <Icon name="panel" size={13} />
          <span className="quickPromptTitle">Prompts</span>
          <span className="quickPromptShortcut">{pinnedPrompts.length}</span>
        </button>
        {pinnedPrompts.map((p, idx) => (
          <button
            key={p.id}
            className="quickPromptItem sidebarTreeItem"
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
    </section>
  );
});
