import type { AgentConversation, AgentSettings } from "./agentTypes";

const SETTINGS_KEY = "agents-ui-agent-settings-v1";
const CONVERSATIONS_KEY = "agents-ui-agent-conversations-v1";
const MAX_CONVERSATIONS = 20;

export function loadAgentSettings(): AgentSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {
    mode: "chat",
    provider: "claude-code",
    apiEnabled: true,
    mcpEnabled: true,
  };
}

export function saveAgentSettings(settings: AgentSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadConversations(): AgentConversation[] {
  try {
    const raw = localStorage.getItem(CONVERSATIONS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

export function saveConversations(conversations: AgentConversation[]): void {
  const capped = conversations.slice(0, MAX_CONVERSATIONS);
  localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(capped));
}
