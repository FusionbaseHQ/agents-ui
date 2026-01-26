import React, { useMemo } from "react";
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

type SshManagerModalProps = {
  isOpen: boolean;
  hosts: SshHostEntry[];
  hostsLoading: boolean;
  hostsError: string | null;
  onRefreshHosts: () => void;

  host: string;
  hostInputRef: React.RefObject<HTMLInputElement>;
  onChangeHost: (value: string) => void;

  persistent: boolean;
  onChangePersistent: (value: boolean) => void;
  forwardOnly: boolean;
  onChangeForwardOnly: (value: boolean) => void;
  exitOnForwardFailure: boolean;
  onChangeExitOnForwardFailure: (value: boolean) => void;

  forwards: SshForward[];
  onAddForward: () => void;
  onRemoveForward: (id: string) => void;
  onUpdateForward: (id: string, patch: Partial<SshForward>) => void;

  commandPreview: string | null;
  onCopyCommand: () => void;

  error: string | null;
  onClose: () => void;
  onConnect: () => void;
};

export function SshManagerModal({
  isOpen,
  hosts,
  hostsLoading,
  hostsError,
  onRefreshHosts,
  host,
  hostInputRef,
  onChangeHost,
  persistent,
  onChangePersistent,
  forwardOnly,
  onChangeForwardOnly,
  exitOnForwardFailure,
  onChangeExitOnForwardFailure,
  forwards,
  onAddForward,
  onRemoveForward,
  onUpdateForward,
  commandPreview,
  onCopyCommand,
  error,
  onClose,
  onConnect,
}: SshManagerModalProps) {
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

  if (!isOpen) return null;

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="modal sshModal" onClick={(e) => e.stopPropagation()}>
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
            onConnect();
          }}
        >
          <div className="formRow">
            <div className="label">Host</div>
            <div className="sshHostRow">
              <input
                ref={hostInputRef}
                className="input"
                value={host}
                onChange={(e) => onChangeHost(e.target.value)}
                placeholder="Start typing an SSH host…"
                list="ssh-hosts"
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
            <datalist id="ssh-hosts">
              {hosts.map((h) => (
                <option key={h.alias} value={h.alias} />
              ))}
            </datalist>

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
                          onClick={() => onChangeHost(h.alias)}
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
                  onChange={(e) => onChangePersistent(e.target.checked)}
                />
                Persistent terminal (zellij)
              </label>
              <label className="checkRow">
                <input
                  type="checkbox"
                  checked={exitOnForwardFailure}
                  onChange={(e) => onChangeExitOnForwardFailure(e.target.checked)}
                />
                Exit on forward failure (<code>ExitOnForwardFailure</code>)
              </label>
              <label className="checkRow">
                <input
                  type="checkbox"
                  checked={forwardOnly}
                  onChange={(e) => onChangeForwardOnly(e.target.checked)}
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
                        onUpdateForward(f.id, { type: e.target.value as SshForwardType })
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
                      onChange={(e) => onUpdateForward(f.id, { bindAddress: e.target.value })}
                      placeholder="Bind (opt)"
                      aria-label="Bind address (optional)"
                    />

                    <input
                      className="input sshForwardPort"
                      value={f.listenPort}
                      onChange={(e) => onUpdateForward(f.id, { listenPort: e.target.value })}
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
                          onChange={(e) => onUpdateForward(f.id, { destinationHost: e.target.value })}
                          placeholder="Dest host"
                          aria-label="Destination host"
                        />
                        <input
                          className="input sshForwardPort"
                          value={f.destinationPort}
                          onChange={(e) => onUpdateForward(f.id, { destinationPort: e.target.value })}
                          placeholder="Dest port"
                          inputMode="numeric"
                          aria-label="Destination port"
                        />
                      </>
                    )}

                    <button
                      type="button"
                      className="btnSmall btnDanger sshForwardRemove"
                      onClick={() => onRemoveForward(f.id)}
                      title="Remove forward"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="sshForwardActions">
              <button type="button" className="btnSmall" onClick={onAddForward}>
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
                  onClick={onCopyCommand}
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
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btnPrimary">
              Connect
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
