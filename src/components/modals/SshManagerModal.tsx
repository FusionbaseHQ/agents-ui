import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { Icon } from "../Icon";

export type SshHostEntry = {
  alias: string;
  hostName?: string | null;
  user?: string | null;
  port?: number | null;
};

export type SshForwardType = "local" | "remote" | "dynamic";

export type SshForward = {
  id: string;
  type: SshForwardType;
  bindAddress: string;
  listenPort: string;
  destinationHost: string;
  destinationPort: string;
};

export type SshConnectData = {
  host: string;
  persistent: boolean;
  forwardOnly: boolean;
  exitOnForwardFailure: boolean;
  forwards: SshForward[];
  command: string;
};

export type SshHistoryEntry = {
  host: string;
  command: string;
  persistent: boolean;
  connectedAt: number;
};

function formatHostDetails(entry: SshHostEntry): string | null {
  const hostName = entry.hostName?.trim() || null;
  const user = entry.user?.trim() || null;
  const port = entry.port ?? null;
  const parts: string[] = [];
  if (user && hostName) parts.push(`${user}@${hostName}`);
  else if (hostName) parts.push(hostName);
  if (port) parts.push(`:${port}`);
  return parts.length ? parts.join("") : null;
}

function sshForwardFlag(type: SshForwardType): "-L" | "-R" | "-D" {
  if (type === "remote") return "-R";
  if (type === "dynamic") return "-D";
  return "-L";
}

function sshForwardSpec(f: SshForward): string | null {
  const listenPort = f.listenPort.trim();
  if (!listenPort) return null;
  const bind = f.bindAddress.trim();
  if (f.type === "dynamic") {
    return bind ? `${bind}:${listenPort}` : listenPort;
  }
  const destHost = f.destinationHost.trim() || "localhost";
  const destPort = f.destinationPort.trim();
  if (!destPort) return null;
  const prefix = bind ? `${bind}:${listenPort}` : listenPort;
  return `${prefix}:${destHost}:${destPort}`;
}

function buildSshCommand(input: {
  host: string;
  forwards: SshForward[];
  exitOnForwardFailure: boolean;
  forwardOnly: boolean;
}): string | null {
  const host = input.host.trim();
  if (!host) return null;

  const args: string[] = ["ssh"];
  args.push("-o", "ServerAliveInterval=15");
  args.push("-o", "ServerAliveCountMax=3");
  args.push("-o", "TCPKeepAlive=yes");
  if (input.exitOnForwardFailure && input.forwards.length > 0) {
    args.push("-o", "ExitOnForwardFailure=yes");
  }
  if (input.forwardOnly) {
    args.push("-N");
  }
  for (const f of input.forwards) {
    const spec = sshForwardSpec(f);
    if (!spec) return null;
    args.push(sshForwardFlag(f.type), spec);
  }
  args.push(host);

  return args.join(" ");
}

function parsePort(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const num = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(num) || num < 1 || num > 65535) return null;
  return num;
}

let nextForwardId = 1;
function makeForwardId(): string {
  return `fwd-${nextForwardId++}-${Date.now()}`;
}

type SshManagerModalProps = {
  hosts: SshHostEntry[];
  hostsLoading: boolean;
  hostsError: string | null;
  history: SshHistoryEntry[];
  onRefreshHosts: () => void;
  onCopyToClipboard: (text: string) => void;
  onClose: () => void;
  onConnect: (data: SshConnectData) => Promise<void>;
  onHistoryConnect: (entry: SshHistoryEntry) => void;
  onHistoryRemove: (index: number) => void;
};

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function SshManagerModal({
  hosts,
  hostsLoading,
  hostsError,
  history,
  onRefreshHosts,
  onCopyToClipboard,
  onClose,
  onConnect,
  onHistoryConnect,
  onHistoryRemove,
}: SshManagerModalProps) {
  const [host, setHost] = useState("");
  const [persistent, setPersistent] = useState(false);
  const [forwardOnly, setForwardOnly] = useState(false);
  const [exitOnForwardFailure, setExitOnForwardFailure] = useState(true);
  const [forwards, setForwards] = useState<SshForward[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const hostInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => hostInputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  const commandPreview = useMemo(() => {
    return buildSshCommand({ host, forwards, exitOnForwardFailure, forwardOnly });
  }, [host, forwards, exitOnForwardFailure, forwardOnly]);

  const addForward = useCallback(() => {
    setForwards((prev) => [
      ...prev,
      {
        id: makeForwardId(),
        type: "local",
        bindAddress: "",
        listenPort: "",
        destinationHost: "localhost",
        destinationPort: "",
      },
    ]);
  }, []);

  const removeForward = useCallback((id: string) => {
    setForwards((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const updateForward = useCallback((id: string, patch: Partial<SshForward>) => {
    setForwards((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }, []);

  const handleConnect = async () => {
    setError(null);

    const target = host.trim();
    if (!target) {
      setError("Pick an SSH host.");
      return;
    }

    for (const [idx, f] of forwards.entries()) {
      const listenPort = parsePort(f.listenPort);
      if (!listenPort) {
        setError(`Forward #${idx + 1}: invalid listen port.`);
        return;
      }
      if (f.type !== "dynamic") {
        if (!f.destinationHost.trim()) {
          setError(`Forward #${idx + 1}: destination host is required.`);
          return;
        }
        const destPort = parsePort(f.destinationPort);
        if (!destPort) {
          setError(`Forward #${idx + 1}: invalid destination port.`);
          return;
        }
      }
    }

    const command = commandPreview;
    if (!command) {
      setError("Invalid SSH configuration.");
      return;
    }

    setConnecting(true);
    try {
      await onConnect({ host: target, persistent, forwardOnly, exitOnForwardFailure, forwards, command });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  };

  const selectedHost = useMemo(() => {
    const needle = host.trim();
    if (!needle) return null;
    return hosts.find((h) => h.alias === needle) ?? null;
  }, [host, hosts]);

  const selectedHostDetails = useMemo(() => {
    if (!selectedHost) return null;
    return formatHostDetails(selectedHost);
  }, [selectedHost]);

  const hostCandidates = useMemo(() => {
    const q = host.trim().toLowerCase();
    if (!q) return [];

    const scored = hosts
      .map((h) => {
        const alias = h.alias.toLowerCase();
        const hostName = (h.hostName ?? "").toLowerCase();
        let score = 0;
        if (alias === q) score = 100;
        else if (alias.startsWith(q)) score = 90;
        else if (alias.includes(q)) score = 70;
        else if (hostName.includes(q)) score = 50;
        else return null;
        return { h, score };
      })
      .filter((x): x is { h: SshHostEntry; score: number } => Boolean(x))
      .sort((a, b) => b.score - a.score || a.h.alias.localeCompare(b.h.alias))
      .slice(0, 8)
      .map((x) => x.h);

    return scored;
  }, [hosts, host]);

  const hostQuery = host.trim();

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className={`modal sshModal ${history.length > 0 ? "sshModalWithHistory" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="sshModalBody">
        <div className="sshModalMain">
        <div className="sshHeader">
          <div className="sshHeaderIcon" aria-hidden="true">
            <Icon name="ssh" size={20} />
          </div>
          <div className="sshHeaderText">
            <h3 className="modalTitle">SSH</h3>
            <div className="hint" style={{ marginTop: 0 }}>
              Hosts from <code>~/.ssh/config</code> • forwards via <code>-L</code>/<code>-R</code>/
              <code>-D</code>
            </div>
          </div>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleConnect();
          }}
        >
          <div className="formRow">
            <div className="label">Host</div>
            <div className="sshHostRow">
              <input
                ref={hostInputRef}
                className="input"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="Start typing an SSH host…"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="btnSmall"
                onClick={onRefreshHosts}
                disabled={hostsLoading}
                title="Refresh from ~/.ssh/config"
              >
                Refresh
              </button>
            </div>
            {!hostsLoading && !hostsError && (
              <div className="sshHostList" aria-label="SSH config hosts">
                <div className="sshHostListHeader">
                  <div className="sshHostListHeaderTitle">From ~/.ssh/config</div>
                  <div className="sshHostListHeaderMeta">{hosts.length} host{hosts.length === 1 ? "" : "s"}</div>
                </div>

                {hosts.length === 0 ? (
                  <div className="sshHostListEmpty">No hosts found.</div>
                ) : !hostQuery ? (
                  <div className="sshHostListEmpty">Type to search hosts (alias or HostName).</div>
                ) : hostCandidates.length === 0 ? (
                  <div className="sshHostListEmpty">
                    No matches for <code>{hostQuery}</code>. You can still connect to a raw hostname.
                  </div>
                ) : (
                  <div className="sshHostListItems" role="listbox" aria-label="Matches">
                    {hostCandidates.map((h) => {
                      const isSelected = h.alias === hostQuery;
                      const meta = formatHostDetails(h);
                      return (
                        <button
                          key={h.alias}
                          type="button"
                          className={`sshHostItem ${isSelected ? "sshHostItemActive" : ""}`}
                          onClick={() => setHost(h.alias)}
                          title={meta ? `${h.alias}\n${meta}` : h.alias}
                        >
                          <div className="sshHostItemMain">
                            <div className="sshHostAlias">{h.alias}</div>
                            {meta && <div className="sshHostMeta">{meta}</div>}
                          </div>
                          <div className="sshHostPick" aria-hidden="true">
                            {isSelected ? "✓" : ""}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {hostsLoading ? (
              <div className="hint">Loading hosts…</div>
            ) : hostsError ? (
              <div className="pathPickerError" role="alert">
                {hostsError}
              </div>
            ) : selectedHostDetails ? (
              <div className="hint">Resolves to: {selectedHostDetails}</div>
            ) : (
              <div className="hint">Tip: you can also type a hostname directly.</div>
            )}
          </div>

          <div className="formRow">
            <div className="label">Options</div>
            <div className="sshOptionGrid">
              <label className="checkRow">
                <input
                  type="checkbox"
                  checked={persistent}
                  onChange={(e) => setPersistent(e.target.checked)}
                />
                Persistent terminal (zellij)
              </label>
              <label className="checkRow">
                <input
                  type="checkbox"
                  checked={exitOnForwardFailure}
                  onChange={(e) => setExitOnForwardFailure(e.target.checked)}
                />
                Exit on forward failure (<code>ExitOnForwardFailure</code>)
              </label>
              <label className="checkRow">
                <input
                  type="checkbox"
                  checked={forwardOnly}
                  onChange={(e) => setForwardOnly(e.target.checked)}
                />
                Port forwarding only (no shell, <code>-N</code>)
              </label>
            </div>
          </div>

          <div className="agentShortcutEditorSection">
            <div className="agentShortcutEditorTitle">Port forwards</div>
            {forwards.length === 0 ? (
              <div className="hint" style={{ marginTop: 0 }}>
                Optional. Add <code>-L</code> / <code>-R</code> / <code>-D</code> forwards here.
              </div>
            ) : null}

            {forwards.length > 0 && (
              <div className="sshForwardList">
                {forwards.map((f) => (
                  <div key={f.id} className="sshForwardRow">
                    <select
                      className="input sshForwardType"
                      value={f.type}
                      onChange={(e) =>
                        updateForward(f.id, { type: e.target.value as SshForwardType })
                      }
                      aria-label="Forward type"
                    >
                      <option value="local">Local (-L)</option>
                      <option value="remote">Remote (-R)</option>
                      <option value="dynamic">SOCKS (-D)</option>
                    </select>

                    <input
                      className="input sshForwardBind"
                      value={f.bindAddress}
                      onChange={(e) => updateForward(f.id, { bindAddress: e.target.value })}
                      placeholder="Bind (opt)"
                      aria-label="Bind address (optional)"
                    />

                    <input
                      className="input sshForwardPort"
                      value={f.listenPort}
                      onChange={(e) => updateForward(f.id, { listenPort: e.target.value })}
                      placeholder="Port"
                      inputMode="numeric"
                      aria-label="Listen port"
                    />

                    {f.type === "dynamic" ? (
                      <div className="sshForwardSpacer" aria-hidden="true" />
                    ) : (
                      <>
                        <input
                          className="input sshForwardDestHost"
                          value={f.destinationHost}
                          onChange={(e) => updateForward(f.id, { destinationHost: e.target.value })}
                          placeholder="Dest host"
                          aria-label="Destination host"
                        />
                        <input
                          className="input sshForwardPort"
                          value={f.destinationPort}
                          onChange={(e) => updateForward(f.id, { destinationPort: e.target.value })}
                          placeholder="Dest port"
                          inputMode="numeric"
                          aria-label="Destination port"
                        />
                      </>
                    )}

                    <button
                      type="button"
                      className="btnSmall btnDanger sshForwardRemove"
                      onClick={() => removeForward(f.id)}
                      title="Remove forward"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="sshForwardActions">
              <button type="button" className="btnSmall" onClick={addForward}>
                + Add forward
              </button>
            </div>
          </div>

          <div className="agentShortcutEditorSection">
            <div className="agentShortcutEditorTitle">Command preview</div>
            <div className="sshCommandPreview">
              <pre className="sshCommandPreviewText">
                {commandPreview ?? "Complete host + forward ports to preview."}
              </pre>
              <div className="sshCommandPreviewActions">
                <button
                  type="button"
                  className="btnSmall"
                  disabled={!commandPreview}
                  onClick={() => commandPreview && onCopyToClipboard(commandPreview)}
                  title={commandPreview ? "Copy command to clipboard" : "Nothing to copy yet"}
                >
                  Copy
                </button>
              </div>
            </div>
          </div>

          {error && (
            <div className="pathPickerError" role="alert">
              {error}
            </div>
          )}

          <div className="modalActions">
            <button type="button" className="btn" onClick={onClose} disabled={connecting}>
              Cancel
            </button>
            <button type="submit" className="btn btnPrimary" disabled={connecting}>
              Connect
            </button>
          </div>
        </form>
        </div>

        {history.length > 0 && (
          <div className="sshHistoryPanel">
            <div className="sshHistoryHeader">
              <div className="sshHostListHeaderTitle">Recent</div>
              <div className="sshHostListHeaderMeta">{history.length}</div>
            </div>
            <div className="sshHistoryList">
              {history.map((entry, i) => (
                <button
                  key={`${entry.host}-${entry.connectedAt}`}
                  type="button"
                  className="sshHistoryItem"
                  onClick={() => onHistoryConnect(entry)}
                  title={entry.command}
                >
                  <div className="sshHistoryItemMain">
                    <div className="sshHostAlias">{entry.host}</div>
                    <div className="sshHostMeta">
                      {entry.persistent ? "persistent • " : ""}{formatTimeAgo(entry.connectedAt)}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="sshHistoryRemove"
                    onClick={(e) => { e.stopPropagation(); onHistoryRemove(i); }}
                    title="Remove from history"
                    aria-label="Remove from history"
                  >
                    ×
                  </button>
                </button>
              ))}
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
