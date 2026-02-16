import React, { useState } from "react";
import type { AgentMessage as AgentMessageType, AgentToolCall } from "./agentTypes";

type Props = {
  message: AgentMessageType;
};

function ThinkingBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);

  // Show first ~120 chars as preview
  const preview = text.length > 120 ? text.slice(0, 120) + "…" : text;

  return (
    <div className="agentThinking">
      <button
        type="button"
        className="agentThinkingHeader"
        onClick={() => setExpanded((p) => !p)}
      >
        <span className="agentThinkingIcon">&#x1F4AD;</span>
        <span className="agentThinkingLabel">Thinking</span>
        <span className="agentToolCallChevron">{expanded ? "\u25B4" : "\u25BE"}</span>
      </button>
      {expanded ? (
        <div className="agentThinkingBody">{text}</div>
      ) : (
        <div className="agentThinkingPreview">{preview}</div>
      )}
    </div>
  );
}

function ToolCallCard({ tc }: { tc: AgentToolCall }) {
  const [expanded, setExpanded] = useState(false);

  const statusLabel =
    tc.status === "running"
      ? "Running…"
      : tc.status === "done"
        ? "Done"
        : tc.status === "error"
          ? "Error"
          : "Pending";

  return (
    <div className={`agentToolCall agentToolCall-${tc.status}`}>
      <button
        type="button"
        className="agentToolCallHeader"
        onClick={() => setExpanded((p) => !p)}
      >
        <span className="agentToolCallDot" />
        <span className="agentToolCallName">{tc.name}</span>
        <span className="agentToolCallStatus">{statusLabel}</span>
        <span className="agentToolCallChevron">{expanded ? "\u25B4" : "\u25BE"}</span>
      </button>
      {expanded && (
        <div className="agentToolCallBody">
          {tc.input && Object.keys(tc.input).length > 0 && (
            <pre className="agentToolCallArgs">
              {JSON.stringify(tc.input, null, 2)}
            </pre>
          )}
          {tc.result != null && (
            <pre className="agentToolCallResult">{tc.result}</pre>
          )}
        </div>
      )}
    </div>
  );
}

export const AgentMessageView = React.memo(function AgentMessageView({ message }: Props) {
  if (message.role === "system") {
    return (
      <div className="agentMessage agentMessage-system">
        <div className="agentMessageContent">{message.content}</div>
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div className="agentMessage agentMessage-user">
        <div className="agentMessageContent">{message.content}</div>
      </div>
    );
  }

  // assistant
  return (
    <div className="agentMessage agentMessage-assistant">
      {message.thinking && <ThinkingBlock text={message.thinking} />}
      {message.content && (
        <div className="agentMessageContent">{message.content}</div>
      )}
      {message.toolCalls?.map((tc) => (
        <ToolCallCard key={tc.id} tc={tc} />
      ))}
    </div>
  );
});

/** Typing indicator shown while the agent is processing. */
export function AgentTypingIndicator() {
  return (
    <div className="agentMessage agentMessage-assistant">
      <div className="agentTypingIndicator">
        <span className="agentTypingDot" />
        <span className="agentTypingDot" />
        <span className="agentTypingDot" />
      </div>
    </div>
  );
}
