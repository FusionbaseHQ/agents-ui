import React, { useState } from "react";
import type { AgentMessage as AgentMessageType, AgentToolCall } from "./agentTypes";
import { AgentMarkdown } from "./AgentMarkdown";
import { McpToolCard, isAgentsUiTool } from "./McpToolCard";
import { NativeToolCard, isNativeTool } from "./NativeToolCard";

type Props = {
  message: AgentMessageType;
};

class MessageErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="agentMessage agentMessage-system">
          <div className="agentMessageContent" style={{ whiteSpace: "pre-wrap" }}>
            {this.props.fallback || "[Render error]"}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const TOOL_RESULT_TRUNCATE = 500;

function ThinkingBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);

  // Show first ~120 chars as preview
  const preview = text.length > 120 ? text.slice(0, 120) + "\u2026" : text;

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

function ToolResultText({ text }: { text: string }) {
  const [showFull, setShowFull] = useState(false);

  if (text.length <= TOOL_RESULT_TRUNCATE) {
    return <pre className="agentToolCallResult">{text}</pre>;
  }

  return (
    <div>
      <pre className="agentToolCallResult">
        {showFull ? text : text.slice(0, TOOL_RESULT_TRUNCATE) + "\u2026"}
      </pre>
      <button
        type="button"
        className="agentToolResultToggle"
        onClick={() => setShowFull((p) => !p)}
      >
        {showFull ? "Show less" : "Show more"}
      </button>
    </div>
  );
}

function ToolCallCard({ tc }: { tc: AgentToolCall }) {
  const [expanded, setExpanded] = useState(false);

  const statusLabel =
    tc.status === "running"
      ? "Running\u2026"
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
          {tc.result != null && <ToolResultText text={tc.result} />}
        </div>
      )}
    </div>
  );
}

const AgentMessageInner = React.memo(function AgentMessageInner({ message }: Props) {
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
      {message.content && <AgentMarkdown content={message.content} />}
      {message.toolCalls?.map((tc) => {
        const name = tc.name || "";
        return isAgentsUiTool(name)
          ? <McpToolCard key={tc.id} tc={tc} />
          : isNativeTool(name)
            ? <NativeToolCard key={tc.id} tc={tc} />
            : <ToolCallCard key={tc.id} tc={tc} />;
      })}
    </div>
  );
});

export function AgentMessageView({ message }: Props) {
  return (
    <MessageErrorBoundary fallback={message.content || "[Message render error]"}>
      <AgentMessageInner message={message} />
    </MessageErrorBoundary>
  );
}

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
