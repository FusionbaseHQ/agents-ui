import React, { useEffect, useRef } from "react";
import { Icon } from "../components/Icon";
import type { AgentConversation } from "./agentTypes";

type Props = {
  conversations: AgentConversation[];
  activeConvId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
};

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function convTitle(conv: AgentConversation): string {
  const firstUser = conv.messages.find((m) => m.role === "user");
  if (firstUser?.content) {
    const text = firstUser.content.replace(/\n/g, " ").trim();
    return text.length > 50 ? text.slice(0, 50) + "\u2026" : text;
  }
  return "New conversation";
}

const MODEL_LABELS: Record<string, string> = {
  fable: "Fable",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.3-codex": "GPT-5.3",
  "gpt-5.3-codex-spark": "Spark",
};

function providerModelLabel(conv: AgentConversation): string {
  const provider = conv.provider === "codex" ? "Codex" : "Claude";
  if (!conv.model) return provider;
  const modelLabel = MODEL_LABELS[conv.model] || conv.model;
  return `${provider} \u00B7 ${modelLabel}`;
}

export function ConversationList({ conversations, activeConvId, onSelect, onDelete, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  if (conversations.length === 0) {
    return (
      <div ref={ref} className="agentConvList">
        <div className="agentConvListEmpty">No conversations yet</div>
      </div>
    );
  }

  return (
    <div ref={ref} className="agentConvList">
      {conversations.map((conv) => (
        <div
          key={conv.id}
          className={`agentConvItem ${conv.id === activeConvId ? "agentConvItemActive" : ""}`}
          onClick={() => { onSelect(conv.id); onClose(); }}
        >
          <div className="agentConvItemMain">
            <span className="agentConvItemTitle">{convTitle(conv)}</span>
            <span className="agentConvItemMeta">
              <span className="agentConvItemBadge">{providerModelLabel(conv)}</span>
              <span className="agentConvItemTime">{relativeTime(conv.createdAt)}</span>
            </span>
          </div>
          <button
            type="button"
            className="agentConvItemDelete"
            onClick={(e) => { e.stopPropagation(); onDelete(conv.id); }}
            title="Delete conversation"
          >
            <Icon name="trash" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
