import type { AgentConversation, AgentSettings, Plan } from "./agentTypes";

const SETTINGS_KEY = "agents-ui-agent-settings-v1";
const CONVERSATIONS_KEY = "agents-ui-agent-conversations-v1";
const PLANS_KEY = "agents-ui-agent-plans-v1";
const MAX_CONVERSATIONS = 20;
const MAX_PLANS = 20;

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

export function loadPlans(): Plan[] {
  try {
    const raw = localStorage.getItem(PLANS_KEY);
    if (raw) {
      const plans: Plan[] = JSON.parse(raw);
      // Migrate old plans that don't have resultDir
      return plans.map((p) => ({
        ...p,
        resultDir: p.resultDir || `/tmp/.agents-ui/orchestrate/${p.id}`,
      }));
    }
  } catch { /* ignore */ }
  return [];
}

export function savePlans(plans: Plan[]): void {
  const capped = plans.slice(0, MAX_PLANS);
  localStorage.setItem(PLANS_KEY, JSON.stringify(capped));
}
