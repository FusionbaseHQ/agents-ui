import type { AgentMessage, AgentToolCall } from "./agentTypes";

/**
 * Claude Code `--output-format stream-json --include-partial-messages` emits NDJSON.
 *
 * With --include-partial-messages, event types include:
 *   { "type": "stream_event", "event": { "type": "message_start"|"content_block_start"|... } }
 *   { "type": "system", "subtype": "init", "session_id": "...", ... }
 *   { "type": "assistant", "message": { "id": "msg_xxx", "content": [...], ... } }
 *   { "type": "result", "subtype": "success"|"error", ... }
 *
 * Stream events give us real-time text/tool deltas.
 * Complete "assistant" events arrive after each turn for reconciliation.
 */

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[] };

type AssistantMessage = {
  id?: string;
  content?: ContentBlock[];
  model?: string;
  stop_reason?: string;
};

/** What we want to apply to the messages array. */
export type ParsedUpdate =
  | { kind: "session"; sessionId: string }
  | { kind: "message_start"; messageId: string }
  | { kind: "text_delta"; text: string }
  | { kind: "thinking_delta"; text: string }
  | { kind: "tool_start"; id: string; name: string; input?: Record<string, unknown> }
  | { kind: "tool_input_delta"; id: string; json: string }
  | { kind: "tool_result"; callId: string; result: string }
  | { kind: "tool_end" }
  | { kind: "message_complete"; messageId: string; text: string; thinking?: string; toolCalls?: AgentToolCall[] }
  | { kind: "done"; sessionId?: string; error?: string; cost?: number }
  | { kind: "finalize" };

let idCounter = 0;
function nextId(): string {
  return `tc-${Date.now()}-${++idCounter}`;
}

/** Parse a single NDJSON line from Claude Code stream-json output. */
export function parseStreamLine(line: string): ParsedUpdate | null {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }

  if (!event || typeof event !== "object" || !event.type) return null;

  switch (event.type) {
    case "system": {
      const sessionId = event.session_id as string | undefined;
      return sessionId ? { kind: "session", sessionId } : null;
    }

    case "stream_event": {
      return parseStreamEvent(event.event as Record<string, unknown>);
    }

    case "assistant": {
      return parseAssistantComplete(event);
    }

    case "result": {
      const subtype = event.subtype as string | undefined;
      const sessionId = event.session_id as string | undefined;
      const costUsd = event.cost_usd as number | undefined;
      const errText = subtype === "error" ? (event.result as string | undefined) : undefined;
      return { kind: "done", sessionId, error: errText, cost: costUsd };
    }

    // ── Codex event types ──

    case "thread.started": {
      const threadId = event.thread_id as string | undefined;
      return threadId ? { kind: "session", sessionId: threadId } : null;
    }

    case "turn.started":
      // Create a new assistant message for this turn — all items accumulate into it
      return { kind: "message_start", messageId: `codex-turn-${Date.now()}-${++idCounter}` };

    case "item.completed": {
      return parseCodexItem(event.item as Record<string, unknown>);
    }

    case "turn.completed": {
      // Finalize tool calls for this turn; process exit triggers "done" via agent-done event
      return { kind: "finalize" };
    }

    default:
      return null;
  }
}

/** Parse a Codex item.completed payload into streaming primitives. */
function parseCodexItem(item: Record<string, unknown>): ParsedUpdate | null {
  if (!item) return null;

  switch (item.type) {
    case "agent_message":
      return { kind: "text_delta", text: (item.text as string) || "" };

    case "reasoning":
      return { kind: "thinking_delta", text: (item.text as string) || "" };

    case "tool_call": {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse((item.arguments as string) || "{}");
      } catch { /* arguments may not be valid JSON */ }
      const id = (item.call_id as string) || `codex-tc-${Date.now()}-${++idCounter}`;
      return { kind: "tool_start", id, name: (item.name as string) || "unknown", input };
    }

    case "tool_call_output": {
      const callId = (item.call_id as string) || "";
      const output = (item.output as string) || "";
      return { kind: "tool_result", callId, result: output };
    }

    default:
      return null;
  }
}

function parseStreamEvent(ev: Record<string, unknown>): ParsedUpdate | null {
  if (!ev || typeof ev !== "object") return null;

  switch (ev.type) {
    case "message_start": {
      const msg = ev.message as { id?: string } | undefined;
      const id = msg?.id;
      if (id) return { kind: "message_start", messageId: id };
      return null;
    }

    case "content_block_start": {
      const block = ev.content_block as Record<string, unknown> | undefined;
      if (!block) return null;
      if (block.type === "tool_use") {
        return {
          kind: "tool_start",
          id: (block.id as string) || nextId(),
          name: (block.name as string) || "unknown",
        };
      }
      // text and thinking block starts don't need special handling
      return null;
    }

    case "content_block_delta": {
      const delta = ev.delta as Record<string, unknown> | undefined;
      if (!delta) return null;

      if (delta.type === "text_delta") {
        const text = delta.text as string;
        if (text) return { kind: "text_delta", text };
      } else if (delta.type === "thinking_delta") {
        const text = delta.thinking as string;
        if (text) return { kind: "thinking_delta", text };
      } else if (delta.type === "input_json_delta") {
        // We'd need the current tool ID from context — handled via toolInputAccumulator in applyUpdate
        const json = delta.partial_json as string;
        if (json) return { kind: "tool_input_delta", id: "", json };
      }
      return null;
    }

    case "content_block_stop": {
      return { kind: "tool_end" };
    }

    default:
      return null;
  }
}

function parseAssistantComplete(event: Record<string, unknown>): ParsedUpdate | null {
  const msg = event.message as AssistantMessage | undefined;
  if (!msg?.content) return null;

  const messageId = msg.id || `msg-${Date.now()}-${++idCounter}`;
  let text = "";
  let thinking = "";
  const toolCalls: AgentToolCall[] = [];

  for (const block of msg.content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "thinking") {
      thinking += (block as { type: "thinking"; thinking: string }).thinking;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id || nextId(),
        name: block.name,
        input: block.input,
        status: "running",
      });
    } else if (block.type === "tool_result") {
      const resultText =
        typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? (block.content as ContentBlock[])
                .filter((b): b is { type: "text"; text: string } => b.type === "text")
                .map((b) => b.text)
                .join("\n")
            : "";
      const tc = toolCalls.find((t) => t.id === block.tool_use_id);
      if (tc) {
        tc.result = resultText;
        tc.status = "done";
      }
    }
  }

  if (msg.stop_reason === "end_turn") {
    for (const tc of toolCalls) {
      if (tc.status === "running") tc.status = "done";
    }
  }

  return {
    kind: "message_complete",
    messageId,
    text,
    thinking: thinking || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

// ── State-based message builder ──

/**
 * Manages the streaming state and applies updates to messages.
 * This must be used as a class since stream deltas need accumulated state
 * (current message ID, current tool ID, etc.).
 */
export class StreamingMessageBuilder {
  private currentMessageId: string | null = null;
  private currentToolId: string | null = null;

  apply(messages: AgentMessage[], update: ParsedUpdate): AgentMessage[] {
    switch (update.kind) {
      case "session":
        // No visual change
        return messages;

      case "message_start": {
        // Finalize previous tool calls, then create a new empty assistant message
        let result = finalizeAllToolCalls(messages);
        this.currentMessageId = update.messageId;
        this.currentToolId = null;
        result = [...result, {
          id: update.messageId,
          role: "assistant" as const,
          content: "",
          timestamp: Date.now(),
        }];
        return result;
      }

      case "text_delta": {
        // Append text to the current in-progress message
        const msgId = this.currentMessageId;
        if (!msgId) return messages;
        return updateMessage(messages, msgId, (msg) => ({
          ...msg,
          content: msg.content + update.text,
        }));
      }

      case "thinking_delta": {
        const msgId = this.currentMessageId;
        if (!msgId) return messages;
        return updateMessage(messages, msgId, (msg) => ({
          ...msg,
          thinking: (msg.thinking ?? "") + update.text,
        }));
      }

      case "tool_start": {
        const msgId = this.currentMessageId;
        if (!msgId) return messages;
        this.currentToolId = update.id;
        return updateMessage(messages, msgId, (msg) => ({
          ...msg,
          toolCalls: [...(msg.toolCalls ?? []), {
            id: update.id,
            name: update.name,
            input: update.input ?? {},
            status: "running" as const,
          }],
        }));
      }

      case "tool_input_delta": {
        // We accumulate input JSON but don't parse until tool_end.
        // For now, we can skip this — the complete assistant message will have parsed input.
        return messages;
      }

      case "tool_result": {
        // Attach result to the matching tool call by callId
        const msgId = this.currentMessageId;
        if (!msgId) {
          // Find the tool call across all messages
          for (let i = messages.length - 1; i >= 0; i--) {
            const tc = messages[i].toolCalls?.find((t) => t.id === update.callId);
            if (tc) {
              return updateMessage(messages, messages[i].id, (msg) => ({
                ...msg,
                toolCalls: msg.toolCalls?.map((t) =>
                  t.id === update.callId ? { ...t, result: update.result, status: "done" as const } : t,
                ),
              }));
            }
          }
          return messages;
        }
        return updateMessage(messages, msgId, (msg) => ({
          ...msg,
          toolCalls: msg.toolCalls?.map((t) =>
            t.id === update.callId ? { ...t, result: update.result, status: "done" as const } : t,
          ),
        }));
      }

      case "tool_end": {
        this.currentToolId = null;
        return messages;
      }

      case "message_complete": {
        // Complete assistant message — reconcile with the streamed version.
        // Replace the message content with the authoritative complete version.
        this.currentMessageId = null;
        this.currentToolId = null;

        let result = [...messages];

        // Finalize all previous tool calls
        result = finalizeAllToolCalls(result);

        const idx = result.findIndex((m) => m.id === update.messageId);
        if (idx >= 0) {
          // Replace with complete data
          result[idx] = {
            ...result[idx],
            content: update.text,
            thinking: update.thinking ?? result[idx].thinking,
            toolCalls: update.toolCalls
              ? mergeToolCalls(result[idx].toolCalls, update.toolCalls)
              : result[idx].toolCalls,
          };
        } else {
          // Message wasn't created via stream_event (no --include-partial-messages)
          result.push({
            id: update.messageId,
            role: "assistant",
            content: update.text,
            thinking: update.thinking,
            toolCalls: update.toolCalls,
            timestamp: Date.now(),
          });
        }

        return result;
      }

      case "done": {
        this.currentMessageId = null;
        this.currentToolId = null;
        let result = finalizeAllToolCalls(messages);
        if (update.error) {
          result = [...result, {
            id: `err-${Date.now()}-${++idCounter}`,
            role: "system" as const,
            content: update.error,
            timestamp: Date.now(),
          }];
        }
        return result;
      }

      case "finalize":
        return finalizeAllToolCalls(messages);

      default:
        return messages;
    }
  }
}

/** Mark all "running" tool calls across all messages as "done". */
function finalizeAllToolCalls(messages: AgentMessage[]): AgentMessage[] {
  let changed = false;
  const result = messages.map((msg) => {
    if (!msg.toolCalls?.some((tc) => tc.status === "running")) return msg;
    changed = true;
    return {
      ...msg,
      toolCalls: msg.toolCalls!.map((tc) =>
        tc.status === "running" ? { ...tc, status: "done" as const } : tc,
      ),
    };
  });
  return changed ? result : messages;
}

/** Update a specific message by ID. */
function updateMessage(
  messages: AgentMessage[],
  id: string,
  updater: (msg: AgentMessage) => AgentMessage,
): AgentMessage[] {
  const idx = messages.findIndex((m) => m.id === id);
  if (idx < 0) return messages;
  const result = [...messages];
  result[idx] = updater(result[idx]);
  return result;
}

/** Merge new tool calls into existing ones by ID. */
function mergeToolCalls(
  existing: AgentToolCall[] | undefined,
  incoming: AgentToolCall[] | undefined,
): AgentToolCall[] | undefined {
  if (!incoming?.length) return existing;
  if (!existing?.length) return incoming;

  const merged = [...existing];
  for (const tc of incoming) {
    const idx = merged.findIndex((m) => m.id === tc.id);
    if (idx >= 0) {
      merged[idx] = { ...merged[idx], ...tc };
    } else {
      merged.push(tc);
    }
  }
  return merged;
}
