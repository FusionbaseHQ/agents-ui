import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Icon } from "../components/Icon";
import { AgentMessageView, AgentTypingIndicator } from "./AgentMessage";
import { parseStreamLine, StreamingMessageBuilder } from "./agentStreamParser";
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
} from "./agentTypes";

type Props = {
  onClose: () => void;
  onCreateTerminalSession?: (command: string) => void;
};

let msgIdCounter = 0;
function nextMsgId() {
  return `umsg-${Date.now()}-${++msgIdCounter}`;
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
  const runIdRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const builderRef = useRef(new StreamingMessageBuilder());

  const activeConv = conversations.find((c) => c.id === activeConvId) ?? null;

  // Persist settings
  useEffect(() => {
    saveAgentSettings(settings);
  }, [settings]);

  // Persist conversations
  useEffect(() => {
    saveConversations(conversations);
  }, [conversations]);

  // Auto-scroll messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeConv?.messages]);

  // Listen for agent events
  useEffect(() => {
    const unlistenOutput = listen<{ runId: string; data: string }>("agent-output", (event) => {
      if (event.payload.runId !== runIdRef.current) return;
      const update = parseStreamLine(event.payload.data);
      if (!update) return;

      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.id === activeConvId);
        if (idx < 0) return prev;
        const conv = prev[idx];
        const newMessages = builderRef.current.apply(conv.messages, update);

        // Extract sessionId from session or done events
        let sessionId = conv.sessionId;
        if (update.kind === "session") sessionId = update.sessionId;
        else if (update.kind === "done" && update.sessionId) sessionId = update.sessionId;

        if (newMessages === conv.messages && sessionId === conv.sessionId) return prev;

        const result = [...prev];
        result[idx] = { ...conv, messages: newMessages, sessionId };
        return result;
      });
    });

    const unlistenDone = listen<{ runId: string; exitCode: number | null }>("agent-done", (event) => {
      if (event.payload.runId !== runIdRef.current) return;
      runIdRef.current = null;
      setRunning(false);
      // Finalize all tool calls on process exit
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.id === activeConvId);
        if (idx < 0) return prev;
        const conv = prev[idx];
        const finalized = builderRef.current.apply(conv.messages, { kind: "finalize" });
        if (finalized === conv.messages) return prev;
        const result = [...prev];
        result[idx] = { ...conv, messages: finalized };
        return result;
      });
    });

    return () => {
      unlistenOutput.then((fn) => fn());
      unlistenDone.then((fn) => fn());
    };
  }, [activeConvId]);

  const createConversation = useCallback((): AgentConversation => {
    const conv: AgentConversation = {
      id: `conv-${Date.now()}`,
      sessionId: null,
      messages: [],
      provider: settings.provider === "terminal" ? "claude-code" : settings.provider,
      createdAt: Date.now(),
    };
    setConversations((prev) => [conv, ...prev]);
    setActiveConvId(conv.id);
    return conv;
  }, [settings.provider]);

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

    // Reset builder for new agent run
    builderRef.current = new StreamingMessageBuilder();

    // Add user message
    setConversations((prev) => {
      const idx = prev.findIndex((c) => c.id === conv!.id);
      if (idx < 0) return prev;
      const updated = { ...prev[idx], messages: [...prev[idx].messages, userMsg] };
      const result = [...prev];
      result[idx] = updated;
      return result;
    });
    setInput("");
    setRunning(true);

    try {
      const launchSettings: AgentLaunchSettings = {
        provider: conv.provider === "codex" ? "codex" : "claude-code",
        model: settings.model,
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
                <option value="sonnet">Sonnet 4.5</option>
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
                  : "custom"
                }
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "custom") {
                    setSettings((s) => ({ ...s, model: s.model || "" }));
                  } else {
                    setSettings((s) => ({ ...s, model: undefined }));
                  }
                }}
              >
                <option value="">Default</option>
                <option value="custom">Custom...</option>
              </select>
            </label>
          )}
          {settings.provider === "codex" &&
            settings.model !== undefined &&
            settings.model !== "" && (
            <label className="agentSettingsLabel">
              Custom Model ID
              <input
                className="agentSettingsInput"
                type="text"
                placeholder="e.g. o3-pro"
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
            <input
              type="checkbox"
              checked={settings.apiEnabled}
              onChange={(e) => {
                const enabled = e.target.checked;
                setSettings((s) => ({ ...s, apiEnabled: enabled }));
                void invoke("set_api_enabled", { enabled }).catch(console.error);
              }}
            />
            <span>JSON-RPC API (Unix socket)</span>
          </label>

          <label className="agentSettingsToggle">
            <input
              type="checkbox"
              checked={settings.mcpEnabled}
              onChange={(e) => {
                const enabled = e.target.checked;
                setSettings((s) => ({ ...s, mcpEnabled: enabled }));
                void invoke("set_mcp_enabled", { enabled }).catch(console.error);
              }}
            />
            <span>MCP Server (HTTP)</span>
          </label>
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
  // Show typing indicator only when running and no assistant message has appeared yet
  const lastMsg = messages[messages.length - 1];
  const showTyping = running && (!lastMsg || lastMsg.role !== "assistant");

  return (
    <aside className="agentPanel">
      <div className="agentHeader">
        <div className="agentHeaderLeft">
          {running && <span className="agentSpinner" />}
          <span className="agentHeaderTitle">{running ? "Agent working…" : "Agent"}</span>
        </div>
        <div className="agentHeaderActions">
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

      <div className="agentMessages">
        {messages.length === 0 && !running && (
          <div className="agentEmpty">
            Send a message to start a conversation with{" "}
            {settings.provider === "codex" ? "Codex" : "Claude Code"}.
            <br />
            The agent can control this app via MCP tools.
          </div>
        )}
        {messages.map((msg) => (
          <AgentMessageView key={msg.id} message={msg} />
        ))}
        {showTyping && <AgentTypingIndicator />}
        <div ref={messagesEndRef} />
      </div>

      <div className="agentInputArea">
        <textarea
          ref={inputRef}
          className="agentInput"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message the agent…"
          rows={2}
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
    </aside>
  );
}
