import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Icon } from "../components/Icon";
import { AgentMessageView, AgentTypingIndicator } from "./AgentMessage";
import { ConversationList } from "./ConversationList";
import { parseStreamLine, StreamingMessageBuilder, resetCodexTracking } from "./agentStreamParser";
import {
  loadAgentSettings,
  saveAgentSettings,
  loadConversations,
  saveConversations,
} from "./agentStorage";
import type {
  AgentMessage,
  AgentConversation,
  AgentMode,
  AgentProvider,
  AgentSettings,
  AgentLaunchSettings,
  ReasoningEffort,
} from "./agentTypes";

type Props = {
  onClose: () => void;
  onCreateTerminalSession?: (command: string) => void;
};

let msgIdCounter = 0;
function nextMsgId() {
  return `umsg-${Date.now()}-${++msgIdCounter}`;
}

type McpRegistrationResult = {
  mcpConfigOk: boolean;
  claudeCode: { success: boolean; error: string | null };
  codex: { success: boolean; error: string | null };
};

const CLAUDE_MODELS = [
  { value: "", label: "Default" },
  { value: "opus", label: "Opus 4.6" },
  { value: "sonnet", label: "Sonnet 4.6" },
  { value: "haiku", label: "Haiku 4.5" },
];

const CODEX_MODELS = [
  { value: "", label: "Default" },
  { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { value: "gpt-5.3-codex-spark", label: "GPT-5.3 Spark" },
  { value: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
];

const ALL_MODELS = [...CLAUDE_MODELS, ...CODEX_MODELS];

function modelsForProvider(provider: string): { value: string; label: string }[] {
  return provider === "codex" ? CODEX_MODELS : CLAUDE_MODELS;
}

function modelDisplayLabel(model: string | undefined, provider: string): string {
  if (!model) return "Default";
  const opt = ALL_MODELS.find((o) => o.value === model);
  return opt ? opt.label : model;
}

const EFFORT_OPTIONS: { value: ReasoningEffort | ""; label: string; short: string }[] = [
  { value: "", label: "Default", short: "Auto" },
  { value: "high", label: "High", short: "High" },
  { value: "medium", label: "Medium", short: "Med" },
  { value: "low", label: "Low", short: "Low" },
];

function effortDisplayLabel(effort: ReasoningEffort | undefined): string {
  if (!effort) return "Auto";
  const opt = EFFORT_OPTIONS.find((o) => o.value === effort);
  return opt ? opt.short : effort;
}

export function AgentPanel({ onClose, onCreateTerminalSession }: Props) {
  const [settings, setSettings] = useState<AgentSettings>(loadAgentSettings);
  const [conversations, setConversations] = useState<AgentConversation[]>(() => loadConversations());
  const [activeConvId, setActiveConvId] = useState<string | null>(() => {
    const convs = loadConversations();
    return convs.length > 0 ? convs[0].id : null;
  });
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showConvList, setShowConvList] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [providerSwitchNotice, setProviderSwitchNotice] = useState<string | null>(null);
  const [showEffortDropdown, setShowEffortDropdown] = useState(false);
  const [mcpRegResult, setMcpRegResult] = useState<McpRegistrationResult | null>(null);
  const [mcpRegLoading, setMcpRegLoading] = useState(false);
  const runIdRef = useRef<string | null>(null);
  const stderrRef = useRef<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const modelDropdownRef = useRef<HTMLDivElement | null>(null);
  const effortDropdownRef = useRef<HTMLDivElement | null>(null);
  const builderRef = useRef(new StreamingMessageBuilder());
  const activeConvIdRef = useRef(activeConvId);

  const doMcpRegistration = useCallback(async () => {
    setMcpRegLoading(true);
    try {
      const result = await invoke<McpRegistrationResult>("register_mcp_with_agents", {});
      setMcpRegResult(result);
    } catch (err) {
      setMcpRegResult({
        mcpConfigOk: false,
        claudeCode: { success: false, error: String(err) },
        codex: { success: false, error: String(err) },
      });
    } finally {
      setMcpRegLoading(false);
    }
  }, []);

  activeConvIdRef.current = activeConvId;
  const activeConv = conversations.find((c) => c.id === activeConvId) ?? null;

  // Persist settings
  useEffect(() => {
    saveAgentSettings(settings);
  }, [settings]);

  // Persist conversations
  useEffect(() => {
    saveConversations(conversations);
  }, [conversations]);

  // Sync provider/model to active conversation when switching
  useEffect(() => {
    if (activeConv) {
      setSettings((s) => {
        const convProvider = activeConv.provider === "codex" ? "codex" : "claude-code";
        const convModel = activeConv.model;
        if (s.provider === convProvider && s.model === convModel) return s;
        return { ...s, provider: convProvider as AgentProvider, model: convModel };
      });
    }
  }, [activeConvId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeConv?.messages]);

  // Close model dropdown on click outside
  useEffect(() => {
    if (!showModelDropdown) return;
    function handleClick(e: MouseEvent) {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showModelDropdown]);

  // Close effort dropdown on click outside
  useEffect(() => {
    if (!showEffortDropdown) return;
    function handleClick(e: MouseEvent) {
      if (effortDropdownRef.current && !effortDropdownRef.current.contains(e.target as Node)) {
        setShowEffortDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showEffortDropdown]);

  // Auto-dismiss provider switch notice
  useEffect(() => {
    if (!providerSwitchNotice) return;
    const timer = setTimeout(() => setProviderSwitchNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [providerSwitchNotice]);

  // Auto-resize textarea
  const autoResize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
  }, []);

  // Listen for agent events. Uses refs to avoid stale closures.
  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];

    listen<{ runId: string; data: string }>("agent-output", (event) => {
      if (event.payload.runId !== runIdRef.current) return;
      const update = parseStreamLine(event.payload.data);
      if (!update) return;

      setConversations((prev) => {
        const convId = activeConvIdRef.current;
        const idx = prev.findIndex((c) => c.id === convId);
        if (idx < 0) return prev;
        const conv = prev[idx];
        const newMessages = builderRef.current.apply(conv.messages, update);

        let sessionId = conv.sessionId;
        if (update.kind === "session") sessionId = update.sessionId;
        else if (update.kind === "done" && update.sessionId) sessionId = update.sessionId;

        if (newMessages === conv.messages && sessionId === conv.sessionId) return prev;

        const result = [...prev];
        result[idx] = { ...conv, messages: newMessages, sessionId };
        return result;
      });
    }).then((fn) => { if (disposed) fn(); else cleanups.push(fn); });

    listen<{ runId: string; data: string }>("agent-stderr", (event) => {
      if (event.payload.runId !== runIdRef.current) return;
      stderrRef.current.push(event.payload.data);
    }).then((fn) => { if (disposed) fn(); else cleanups.push(fn); });

    listen<{ runId: string; exitCode: number | null }>("agent-done", (event) => {
      if (event.payload.runId !== runIdRef.current) return;
      const exitCode = event.payload.exitCode;
      const stderr = stderrRef.current.join("\n").trim();
      runIdRef.current = null;
      stderrRef.current = [];
      setRunning(false);
      setConversations((prev) => {
        const convId = activeConvIdRef.current;
        const idx = prev.findIndex((c) => c.id === convId);
        if (idx < 0) return prev;
        const conv = prev[idx];
        let messages = builderRef.current.apply(conv.messages, { kind: "finalize" });
        const hasAssistantContent = messages.some(
          (m) => m.role === "assistant" && (m.content || m.toolCalls?.length),
        );
        if (exitCode !== 0 && !hasAssistantContent && stderr) {
          messages = [
            ...messages,
            {
              id: `err-${Date.now()}`,
              role: "system" as const,
              content: stderr,
              timestamp: Date.now(),
            },
          ];
        }
        if (messages === conv.messages) return prev;
        const result = [...prev];
        result[idx] = { ...conv, messages };
        return result;
      });
    }).then((fn) => { if (disposed) fn(); else cleanups.push(fn); });

    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
    };
  }, []);

  const createConversation = useCallback((): AgentConversation => {
    const conv: AgentConversation = {
      id: `conv-${Date.now()}`,
      sessionId: null,
      messages: [],
      provider: settings.provider === "terminal" ? "claude-code" : settings.provider,
      model: settings.model,
      createdAt: Date.now(),
    };
    setConversations((prev) => [conv, ...prev]);
    setActiveConvId(conv.id);
    return conv;
  }, [settings.provider, settings.model]);

  const deleteConversation = useCallback((id: string) => {
    setConversations((prev) => {
      const filtered = prev.filter((c) => c.id !== id);
      if (id === activeConvId) {
        setActiveConvId(filtered.length > 0 ? filtered[0].id : null);
      }
      return filtered;
    });
  }, [activeConvId]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || running) return;

    const userMsg: AgentMessage = {
      id: nextMsgId(),
      role: "user",
      content: text,
      timestamp: Date.now(),
    };

    let conv = activeConv;
    if (!conv) {
      conv = createConversation();
    }

    builderRef.current = new StreamingMessageBuilder();
    resetCodexTracking();
    stderrRef.current = [];

    setConversations((prev) => {
      const idx = prev.findIndex((c) => c.id === conv!.id);
      if (idx < 0) return prev;
      const updated = { ...prev[idx], messages: [...prev[idx].messages, userMsg], model: settings.model };
      const result = [...prev];
      result[idx] = updated;
      return result;
    });
    setInput("");
    setRunning(true);

    // Reset textarea height
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }

    try {
      const launchSettings: AgentLaunchSettings = {
        provider: conv.provider === "codex" ? "codex" : "claude-code",
        model: settings.model,
        effort: settings.effort,
        allowedTools: settings.allowedTools,
      };

      const runId: string = await invoke("start_agent_prompt", {
        prompt: text,
        sessionId: conv.sessionId,
        settings: launchSettings,
      });
      runIdRef.current = runId;
    } catch (err) {
      const errMsg = typeof err === "string" ? err : String(err);
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.id === conv!.id);
        if (idx < 0) return prev;
        const sysMsg: AgentMessage = {
          id: nextMsgId(),
          role: "system",
          content: errMsg,
          timestamp: Date.now(),
        };
        const updated = { ...prev[idx], messages: [...prev[idx].messages, sysMsg] };
        const result = [...prev];
        result[idx] = updated;
        return result;
      });
      setRunning(false);
    }
  }, [input, running, activeConv, settings, createConversation]);

  const stopAgent = useCallback(async () => {
    if (runIdRef.current) {
      await invoke("stop_agent", { runId: runIdRef.current }).catch(() => {});
      runIdRef.current = null;
      setRunning(false);
    }
  }, []);

  const switchProvider = useCallback((newProvider: AgentProvider) => {
    if (settings.provider === newProvider) return;
    // If current conversation has messages, create a new one for the new provider
    const needsNewConv = activeConv && activeConv.messages.length > 0;
    setSettings((s) => ({ ...s, provider: newProvider, model: undefined }));
    if (needsNewConv) {
      const providerLabel = newProvider === "codex" ? "Codex" : "Claude Code";
      setProviderSwitchNotice(`Switched to ${providerLabel}. Previous chat moved to history.`);
      // Create a new conversation with the new provider
      const conv: AgentConversation = {
        id: `conv-${Date.now()}`,
        sessionId: null,
        messages: [],
        provider: newProvider,
        model: undefined, // reset model when switching provider
        createdAt: Date.now(),
      };
      setConversations((prev) => [conv, ...prev]);
      setActiveConvId(conv.id);
    } else if (activeConv) {
      // Empty conversation — just update its provider
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.id === activeConv.id);
        if (idx < 0) return prev;
        const result = [...prev];
        result[idx] = { ...prev[idx], provider: newProvider };
        return result;
      });
    }
  }, [settings.provider, activeConv]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void sendMessage();
      }
    },
    [sendMessage],
  );

  const switchToTerminal = useCallback(async () => {
    try {
      const command: string = await invoke("get_agent_terminal_command", {
        provider: settings.provider === "codex" ? "codex" : "claude-code",
      });
      onCreateTerminalSession?.(command);
    } catch (err) {
      console.error("Failed to get agent terminal command:", err);
    }
  }, [settings.provider, onCreateTerminalSession]);

  // Settings panel
  if (showSettings) {
    return (
      <aside className="agentPanel">
        <div className="agentHeader">
          <span className="agentHeaderTitle">Agent Settings</span>
          <button
            type="button"
            className="btnSmall btnIcon"
            onClick={() => setShowSettings(false)}
            title="Back"
          >
            <Icon name="chevron-left" />
          </button>
        </div>
        <div className="agentSettingsBody">
          <label className="agentSettingsLabel">
            Provider
            <select
              className="agentSettingsSelect"
              value={settings.provider}
              onChange={(e) =>
                setSettings((s) => ({ ...s, provider: e.target.value as AgentProvider }))
              }
            >
              <option value="claude-code">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          </label>

          <label className="agentSettingsLabel">
            Mode
            <select
              className="agentSettingsSelect"
              value={settings.mode}
              onChange={(e) =>
                setSettings((s) => ({ ...s, mode: e.target.value as AgentMode }))
              }
            >
              <option value="chat">Chat (Headless)</option>
              <option value="terminal">Terminal (Interactive)</option>
            </select>
          </label>

          {settings.provider === "claude-code" && (
            <label className="agentSettingsLabel">
              Model
              <select
                className="agentSettingsSelect"
                value={
                  settings.model === undefined || settings.model === "" ? ""
                  : ["opus", "sonnet", "haiku"].includes(settings.model) ? settings.model
                  : "custom"
                }
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "custom") {
                    setSettings((s) => ({ ...s, model: s.model && !["opus", "sonnet", "haiku"].includes(s.model) ? s.model : "" }));
                  } else {
                    setSettings((s) => ({ ...s, model: v || undefined }));
                  }
                }}
              >
                <option value="">Default</option>
                <option value="opus">Opus 4.6</option>
                <option value="sonnet">Sonnet 4.6</option>
                <option value="haiku">Haiku 4.5</option>
                <option value="custom">Custom...</option>
              </select>
            </label>
          )}
          {settings.provider === "claude-code" &&
            settings.model !== undefined &&
            settings.model !== "" &&
            !["opus", "sonnet", "haiku"].includes(settings.model) && (
            <label className="agentSettingsLabel">
              Custom Model ID
              <input
                className="agentSettingsInput"
                type="text"
                placeholder="e.g. claude-sonnet-4-5-20250929"
                value={settings.model}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, model: e.target.value || undefined }))
                }
              />
            </label>
          )}

          {settings.provider === "codex" && (
            <label className="agentSettingsLabel">
              Model
              <select
                className="agentSettingsSelect"
                value={
                  settings.model === undefined || settings.model === "" ? ""
                  : CODEX_MODELS.some((o) => o.value === settings.model) ? settings.model
                  : "custom"
                }
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "custom") {
                    setSettings((s) => ({ ...s, model: s.model && !CODEX_MODELS.some((o) => o.value === s.model) ? s.model : "" }));
                  } else {
                    setSettings((s) => ({ ...s, model: v || undefined }));
                  }
                }}
              >
                <option value="">Default</option>
                <option value="gpt-5.3-codex">GPT-5.3 Codex</option>
                <option value="gpt-5.3-codex-spark">GPT-5.3 Spark</option>
                <option value="gpt-5.2-codex">GPT-5.2 Codex</option>
                <option value="custom">Custom...</option>
              </select>
            </label>
          )}
          {settings.provider === "codex" &&
            settings.model !== undefined &&
            settings.model !== "" &&
            !CODEX_MODELS.some((o) => o.value === settings.model) && (
            <label className="agentSettingsLabel">
              Custom Model ID
              <input
                className="agentSettingsInput"
                type="text"
                placeholder="e.g. gpt-5.1-codex-max"
                value={settings.model}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, model: e.target.value || undefined }))
                }
              />
            </label>
          )}

          <div className="agentSettingsDivider" />

          <h4 className="agentSettingsSectionTitle">External Control Servers</h4>

          <label className="agentSettingsToggle">
            <span className="toggleSwitch">
              <input
                type="checkbox"
                checked={settings.apiEnabled}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  setSettings((s) => ({ ...s, apiEnabled: enabled }));
                  void invoke("set_api_enabled", { enabled }).catch(console.error);
                }}
              />
              <span className="toggleTrack" />
            </span>
            <span>JSON-RPC API (Unix socket)</span>
          </label>

          <label className="agentSettingsToggle">
            <span className="toggleSwitch">
              <input
                type="checkbox"
                checked={settings.mcpEnabled}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  setSettings((s) => ({ ...s, mcpEnabled: enabled }));
                  void invoke("set_mcp_enabled", { enabled }).catch(console.error);
                }}
              />
              <span className="toggleTrack" />
            </span>
            <span>MCP Server (HTTP)</span>
          </label>

          <div className="agentSettingsDivider" />

          <h4 className="agentSettingsSectionTitle">MCP Registration</h4>
          <p className="agentSettingsHint">
            Register the MCP server with agent CLIs so it's available in all sessions.
          </p>

          {mcpRegResult && (
            <div className="agentMcpRegStatus">
              <div className="agentMcpRegRow">
                <span className={mcpRegResult.claudeCode.success ? "agentMcpRegOk" : "agentMcpRegErr"}>
                  {mcpRegResult.claudeCode.success ? "\u2713" : "\u2717"}
                </span>
                <span>Claude Code</span>
                {mcpRegResult.claudeCode.error && (
                  <span className="agentMcpRegErrMsg">{mcpRegResult.claudeCode.error}</span>
                )}
              </div>
              <div className="agentMcpRegRow">
                <span className={mcpRegResult.codex.success ? "agentMcpRegOk" : "agentMcpRegErr"}>
                  {mcpRegResult.codex.success ? "\u2713" : "\u2717"}
                </span>
                <span>Codex</span>
                {mcpRegResult.codex.error && (
                  <span className="agentMcpRegErrMsg">{mcpRegResult.codex.error}</span>
                )}
              </div>
            </div>
          )}

          <button
            type="button"
            className="btnSmall"
            onClick={() => void doMcpRegistration()}
            disabled={mcpRegLoading}
            style={{ marginTop: 6 }}
          >
            {mcpRegLoading ? "Registering\u2026" : mcpRegResult ? "Re-register" : "Register MCP"}
          </button>
        </div>
      </aside>
    );
  }

  // Terminal mode
  if (settings.mode === "terminal") {
    return (
      <aside className="agentPanel">
        <div className="agentHeader">
          <span className="agentHeaderTitle">Agent</span>
          <div className="agentHeaderActions">
            <button
              type="button"
              className="btnSmall btnIcon"
              onClick={() => setShowSettings(true)}
              title="Settings"
            >
              <Icon name="settings" />
            </button>
            <button type="button" className="btnSmall btnIcon" onClick={onClose} title="Close">
              <Icon name="close" />
            </button>
          </div>
        </div>
        <div className="agentTerminalPlaceholder">
          <p>Terminal mode runs the agent in an interactive PTY session.</p>
          <button
            type="button"
            className="btnSmall"
            onClick={() => void switchToTerminal()}
          >
            Launch {settings.provider === "codex" ? "Codex" : "Claude Code"} Terminal
          </button>
        </div>
      </aside>
    );
  }

  // Chat mode
  const messages = activeConv?.messages ?? [];
  const lastMsg = messages[messages.length - 1];
  const showTyping = running && (!lastMsg || lastMsg.role !== "assistant");
  const providerName = settings.provider === "codex" ? "Codex" : "Claude Code";

  return (
    <aside className="agentPanel">
      <div className="agentHeader">
        <div className="agentHeaderLeft">
          {running && <span className="agentSpinner" />}
          <span className="agentHeaderTitle">{running ? "Agent working\u2026" : "Agent"}</span>
        </div>
        <div className="agentHeaderActions">
          <button
            type="button"
            className="btnSmall btnIcon"
            onClick={() => setShowConvList((p) => !p)}
            title="Conversations"
          >
            <Icon name="history" />
          </button>
          <button
            type="button"
            className="btnSmall btnIcon"
            onClick={() => {
              createConversation();
            }}
            title="New conversation"
          >
            <Icon name="plus" />
          </button>
          <button
            type="button"
            className="btnSmall btnIcon"
            onClick={() => setShowSettings(true)}
            title="Settings"
          >
            <Icon name="settings" />
          </button>
          <button type="button" className="btnSmall btnIcon" onClick={onClose} title="Close">
            <Icon name="close" />
          </button>
        </div>
      </div>
      {running && <div className="agentProgressBar" />}

      {showConvList && (
        <ConversationList
          conversations={conversations}
          activeConvId={activeConvId}
          onSelect={(id) => setActiveConvId(id)}
          onDelete={deleteConversation}
          onClose={() => setShowConvList(false)}
        />
      )}

      <div className="agentMessages">
        {providerSwitchNotice && (
          <div className="agentSwitchNotice">
            <Icon name="history" size={13} />
            <span>{providerSwitchNotice}</span>
            <button type="button" className="agentSwitchNoticeClose" onClick={() => setProviderSwitchNotice(null)}>&times;</button>
          </div>
        )}
        {messages.length === 0 && !running && (
          <div className="agentEmpty">
            <div className="agentEmptyIcon">
              <Icon name="brain" size={28} />
            </div>
            <div className="agentEmptyTitle">{providerName}</div>
            <div className="agentEmptyHint">
              Send a message to start a conversation.
              <br />
              The agent can control this app via MCP tools.
            </div>
          </div>
        )}
        {messages.map((msg) => (
          <AgentMessageView key={msg.id} message={msg} />
        ))}
        {showTyping && <AgentTypingIndicator />}
        <div ref={messagesEndRef} />
      </div>

      <div className="agentInputArea">
        <div className="agentInputControls">
          <div className="agentProviderToggle">
            <button
              type="button"
              className={`agentProviderBtn ${settings.provider !== "codex" ? "agentProviderBtnActive" : ""}`}
              onClick={() => switchProvider("claude-code")}
              disabled={running}
            >
              Claude Code
            </button>
            <button
              type="button"
              className={`agentProviderBtn ${settings.provider === "codex" ? "agentProviderBtnActive" : ""}`}
              onClick={() => switchProvider("codex")}
              disabled={running}
            >
              Codex
            </button>
          </div>

          <div className="agentModelChipWrap" ref={modelDropdownRef}>
            <button
              type="button"
              className="agentModelChip"
              onClick={() => setShowModelDropdown((p) => !p)}
              disabled={running}
            >
              {modelDisplayLabel(settings.model, settings.provider)}
              <Icon name="chevron-down" size={12} />
            </button>
            {showModelDropdown && (
              <div className="agentModelDropdown">
                {modelsForProvider(settings.provider).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`agentModelDropdownItem ${(settings.model ?? "") === opt.value ? "agentModelDropdownItemActive" : ""}`}
                    onClick={() => {
                      setSettings((s) => ({ ...s, model: opt.value || undefined }));
                      setShowModelDropdown(false);
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {settings.provider !== "codex" && (
            <div className="agentModelChipWrap" ref={effortDropdownRef}>
              <button
                type="button"
                className="agentModelChip"
                onClick={() => setShowEffortDropdown((p) => !p)}
                disabled={running}
                title="Reasoning effort"
              >
                {effortDisplayLabel(settings.effort)}
                <Icon name="chevron-down" size={12} />
              </button>
              {showEffortDropdown && (
                <div className="agentModelDropdown">
                  {EFFORT_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`agentModelDropdownItem ${(settings.effort ?? "") === opt.value ? "agentModelDropdownItemActive" : ""}`}
                      onClick={() => {
                        setSettings((s) => ({ ...s, effort: (opt.value || undefined) as ReasoningEffort | undefined }));
                        setShowEffortDropdown(false);
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="agentInputRow">
          <textarea
            ref={inputRef}
            className="agentInput"
            value={input}
            onChange={(e) => { setInput(e.target.value); autoResize(); }}
            onKeyDown={handleKeyDown}
            placeholder="Message the agent..."
            disabled={running}
          />
          <div className="agentInputActions">
            {running ? (
              <button
                type="button"
                className="btnSmall agentStopBtn"
                onClick={() => void stopAgent()}
              >
                <Icon name="stop" size={14} />
                Stop
              </button>
            ) : (
              <button
                type="button"
                className="btnSmall agentSendBtn"
                onClick={() => void sendMessage()}
                disabled={!input.trim()}
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
