export type AgentProvider = "claude-code" | "codex" | "terminal";
export type AgentMode = "chat" | "terminal";

export type AgentMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  thinking?: string;
  toolCalls?: AgentToolCall[];
  timestamp: number;
};

export type AgentToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  status: "pending" | "running" | "done" | "error";
};

export type AgentConversation = {
  id: string;
  sessionId: string | null; // claude --resume session ID
  messages: AgentMessage[];
  provider: AgentProvider;
  model?: string;
  createdAt: number;
};

export type ReasoningEffort = "low" | "medium" | "high";

export type AgentSettings = {
  mode: AgentMode;
  provider: AgentProvider;
  model?: string;
  effort?: ReasoningEffort;
  allowedTools?: string;
  apiEnabled: boolean;
  mcpEnabled: boolean;
};

export type AgentLaunchSettings = {
  provider?: string;
  allowedTools?: string;
  model?: string;
  effort?: string;
};
