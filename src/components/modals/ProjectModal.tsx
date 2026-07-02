import React, { useState, useRef, useEffect, useMemo, useImperativeHandle, forwardRef } from "react";
import { Modal } from "../../ui";
import type { ShellChoice, ShellInfo } from "../../shells";

function normalizeSmartQuotes(input: string): string {
  return input.replace(/[""„‟«»]/g, '"').replace(/[''‚‛‹›]/g, "'");
}

// The <select> uses string keys: the bundled kind ("bundled-agsh"/"bundled-nu")
// for a bundled shell, else the shell path.
function choiceToKey(choice: ShellChoice | null | undefined): string {
  if (!choice || choice.kind === "bundled-agsh") return "bundled-agsh";
  if (choice.kind === "bundled-nu") return "bundled-nu";
  return choice.path;
}

function keyToChoice(
  key: string,
  shells: ShellInfo[],
  fallback: ShellChoice | null,
): ShellChoice | null {
  if (key === "bundled-agsh") return null; // null ⇒ bundled default (agsh)
  if (key === "bundled-nu") return { kind: "bundled-nu" };
  const match = shells.find((s) => s.kind === "system" && s.path === key);
  if (match) return { kind: "system", path: match.path, family: match.family };
  // Preserve a previously-selected shell even if detection hasn't (re)found it.
  if (fallback && fallback.kind === "system" && fallback.path === key) return fallback;
  return null;
}

type EnvironmentConfig = {
  id: string;
  name: string;
};

export type SshHostEntry = {
  alias: string;
  hostName?: string | null;
  user?: string | null;
  port?: number | null;
};

export type ProjectSubmitData = {
  title: string;
  basePath: string;
  environmentId: string;
  assetsEnabled: boolean;
  sshTarget: string;
  sshRemotePath: string;
  defaultShell: ShellChoice | null;
};

export type ProjectModalHandle = {
  setBasePath: (basePath: string) => void;
  setSshRemotePath: (remotePath: string) => void;
};

type ProjectModalProps = {
  mode: "new" | "rename";
  initialTitle: string;
  initialBasePath: string;
  basePathPlaceholder: string;
  initialEnvironmentId: string;
  initialAssetsEnabled: boolean;
  initialSshTarget: string;
  initialSshRemotePath: string;
  initialDefaultShell: ShellChoice | null;
  shells: ShellInfo[];
  shellsLoading: boolean;
  onLoadShells: () => void;
  sshHosts: SshHostEntry[];
  sshHostsLoading: boolean;
  canUseCurrentTab: boolean;
  currentTabCwd: string | null;
  canUseHome: boolean;
  homeDir: string | null;
  environments: EnvironmentConfig[];
  onOpenEnvironments: () => void;
  onBrowseBasePath: (currentBasePath: string) => void;
  onBrowseRemotePath: (sshTarget: string, currentPath: string) => void;
  onClose: () => void;
  onSubmit: (data: ProjectSubmitData) => void;
};

function formatHostDetails(entry: SshHostEntry): string | null {
  const hostName = entry.hostName?.trim() || null;
  const user = entry.user?.trim() || null;
  const port = entry.port ?? null;
  const parts: string[] = [];
  if (user && hostName) parts.push(`${user}@${hostName}`);
  else if (hostName) parts.push(hostName);
  else if (user) parts.push(`${user}@`);
  if (port && port !== 22) parts.push(`:${port}`);
  return parts.length ? parts.join("") : null;
}

export const ProjectModal = forwardRef<ProjectModalHandle, ProjectModalProps>(
  function ProjectModal(props, ref) {
    const {
      mode, initialTitle, initialBasePath, basePathPlaceholder,
      initialEnvironmentId, initialAssetsEnabled,
      initialSshTarget, initialSshRemotePath,
      initialDefaultShell, shells, shellsLoading, onLoadShells,
      sshHosts, sshHostsLoading,
      canUseCurrentTab, currentTabCwd, canUseHome, homeDir,
      environments, onOpenEnvironments, onBrowseBasePath, onBrowseRemotePath, onClose, onSubmit,
    } = props;

    const [title, setTitle] = useState(initialTitle);
    const [basePath, setBasePath] = useState(initialBasePath);
    const [environmentId, setEnvironmentId] = useState(initialEnvironmentId);
    const [assetsEnabled, setAssetsEnabled] = useState(initialAssetsEnabled);
    const [projectType, setProjectType] = useState<"local" | "ssh">(initialSshTarget ? "ssh" : "local");
    const [sshTarget, setSshTarget] = useState(initialSshTarget);
    const [sshRemotePath, setSshRemotePath] = useState(initialSshRemotePath);
    const [defaultShellKey, setDefaultShellKey] = useState(choiceToKey(initialDefaultShell));
    const titleRef = useRef<HTMLInputElement>(null);

    useImperativeHandle(ref, () => ({ setBasePath, setSshRemotePath }));

    useEffect(() => {
      const t = window.setTimeout(() => titleRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }, []);

    // Detect installed shells when the modal opens so the picker is populated.
    useEffect(() => {
      onLoadShells();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Shells offered in the dropdown: the bundled default, the detected system
    // shells, plus the currently-selected one if detection hasn't found it.
    const shellOptions = useMemo(() => {
      // Surface the login shell first; it's the most likely pick after the default.
      const systemShells = shells
        .filter((s) => s.kind === "system")
        .sort((a, b) => Number(b.isLoginDefault) - Number(a.isLoginDefault));
      const opts = systemShells.map((s) => ({
        key: s.path,
        label: s.isLoginDefault ? `${s.displayName} (login default)` : s.displayName,
        detail: s.path,
      }));
      if (
        initialDefaultShell?.kind === "system" &&
        !systemShells.some((s) => s.path === initialDefaultShell.path)
      ) {
        opts.unshift({
          key: initialDefaultShell.path,
          label: `${initialDefaultShell.family || "Custom"} (not found)`,
          detail: initialDefaultShell.path,
        });
      }
      return opts;
    }, [shells, initialDefaultShell]);

    const isSsh = projectType === "ssh";

    const hostCandidates = useMemo(() => {
      const q = sshTarget.trim().toLowerCase();
      if (!q) return [];
      const scored = sshHosts
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
        .slice(0, 6)
        .map((x) => x.h);
      return scored;
    }, [sshHosts, sshTarget]);

    const selectedHostDetails = useMemo(() => {
      const q = sshTarget.trim().toLowerCase();
      if (!q) return null;
      const match = sshHosts.find((h) => h.alias.toLowerCase() === q);
      return match ? formatHostDetails(match) : null;
    }, [sshHosts, sshTarget]);

    const handleSubmit = (e: React.FormEvent) => {
      e.preventDefault();
      onSubmit({
        title,
        basePath,
        environmentId,
        assetsEnabled,
        sshTarget: isSsh ? sshTarget : "",
        sshRemotePath: isSsh ? sshRemotePath : "",
        // Shell choice applies to local projects only.
        defaultShell: isSsh ? null : keyToChoice(defaultShellKey, shells, initialDefaultShell),
      });
    };

    return (
      <Modal title={mode === "new" ? "New project" : "Project settings"} onClose={onClose}>
        <form onSubmit={handleSubmit}>
          <div className="formRow">
            <div className="label">Title</div>
            <input
              className="input"
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(normalizeSmartQuotes(e.target.value))}
              placeholder="e.g. my-repo"
            />
          </div>
          <div className="formRow">
            <div className="label">Type</div>
            <div className="segmentedControl">
              <button
                type="button"
                className={`segmentedBtn segmentedBtnLocal ${!isSsh ? "segmentedBtnActive" : ""}`}
                onClick={() => setProjectType("local")}
              >
                Local
              </button>
              <button
                type="button"
                className={`segmentedBtn segmentedBtnSsh ${isSsh ? "segmentedBtnActive" : ""}`}
                onClick={() => setProjectType("ssh")}
              >
                SSH
              </button>
            </div>
          </div>

          {isSsh ? (
            <>
              <div className="formRow">
                <div className="label">SSH host</div>
                <input
                  className="input"
                  value={sshTarget}
                  onChange={(e) => setSshTarget(e.target.value)}
                  placeholder="Start typing an SSH host…"
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                {!sshHostsLoading && sshTarget.trim() && (
                  <div className="sshHostList" aria-label="SSH config hosts">
                    {hostCandidates.length === 0 ? (
                      <div className="sshHostListEmpty">
                        No matches. You can still type a hostname directly.
                      </div>
                    ) : (
                      <div className="sshHostListItems" role="listbox" aria-label="Matches">
                        {hostCandidates.map((h) => {
                          const isSelected = h.alias === sshTarget.trim();
                          const meta = formatHostDetails(h);
                          return (
                            <button
                              key={h.alias}
                              type="button"
                              className={`sshHostItem ${isSelected ? "sshHostItemActive" : ""}`}
                              onClick={() => setSshTarget(h.alias)}
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
                {sshHostsLoading ? (
                  <div className="hint">Loading hosts…</div>
                ) : selectedHostDetails ? (
                  <div className="hint">Resolves to: {selectedHostDetails}</div>
                ) : (
                  <div className="hint">Tip: type a hostname or choose from ~/.ssh/config.</div>
                )}
              </div>
              <div className="formRow">
                <div className="label">Remote path</div>
                <div className="pathRow">
                  <input
                    className="input"
                    value={sshRemotePath}
                    onChange={(e) => setSshRemotePath(normalizeSmartQuotes(e.target.value))}
                    placeholder="~ (remote home)"
                  />
                  <button
                    type="button"
                    className="btn"
                    disabled={!sshTarget.trim()}
                    onClick={() => onBrowseRemotePath(sshTarget.trim(), sshRemotePath.trim())}
                  >
                    Browse
                  </button>
                </div>
                <div className="hint">Remote working directory for new sessions.</div>
              </div>
            </>
          ) : (
            <div className="formRow">
              <div className="label">Base path</div>
              <div className="pathRow">
                <input
                  className="input"
                  value={basePath}
                  onChange={(e) => setBasePath(normalizeSmartQuotes(e.target.value))}
                  placeholder={basePathPlaceholder}
                />
                <button type="button" className="btn" onClick={() => onBrowseBasePath(basePath)}>
                  Browse
                </button>
              </div>
              <div className="pathActions">
                <button
                  type="button"
                  className="btnSmall"
                  onClick={() => setBasePath(currentTabCwd ?? "")}
                  disabled={!canUseCurrentTab}
                >
                  Use current tab
                </button>
                <button
                  type="button"
                  className="btnSmall"
                  onClick={() => setBasePath(homeDir ?? "")}
                  disabled={!canUseHome}
                >
                  Home
                </button>
              </div>
              <div className="hint">New sessions in this project start here.</div>
            </div>
          )}
          <div className="formRow">
            <div className="label">Environment (.env)</div>
            <div className="pathRow">
              <select
                className="input"
                value={environmentId}
                onChange={(e) => setEnvironmentId(e.target.value)}
              >
                <option value="">None</option>
                {environments
                  .slice()
                  .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
                  .map((env) => (
                    <option key={env.id} value={env.id}>
                      {env.name}
                    </option>
                  ))}
              </select>
              <button type="button" className="btn" onClick={onOpenEnvironments}>
                Manage
              </button>
            </div>
            <div className="hint">Applied to new sessions in this project.</div>
          </div>
          {!isSsh && (
            <div className="formRow">
              <div className="label">Default shell</div>
              <select
                className="input"
                value={defaultShellKey}
                onChange={(e) => setDefaultShellKey(e.target.value)}
              >
                <optgroup label="Bundled with the app">
                  <option value="bundled-agsh">agsh (default)</option>
                  <option value="bundled-nu">Nushell</option>
                </optgroup>
                {shellOptions.length > 0 && (
                  <optgroup label="Installed shells">
                    {shellOptions.map((o) => (
                      <option key={o.key} value={o.key}>
                        {o.label} — {o.detail}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              <div className="hint">
                {shellsLoading
                  ? "Detecting installed shells…"
                  : "New terminals in this project start with this shell. Use the “Terminal with shell…” menu to override per terminal."}
              </div>
            </div>
          )}
          <div className="formRow">
            <div className="label">Assets</div>
            <label className="checkRow">
              <input
                type="checkbox"
                checked={assetsEnabled}
                onChange={(e) => setAssetsEnabled(e.target.checked)}
              />
              Auto-create enabled assets on new sessions
            </label>
            <div className="hint">Manage templates in the Assets panel.</div>
          </div>
          <div className="modalActions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn">
              {mode === "new" ? "Create" : "Save"}
            </button>
          </div>
        </form>
      </Modal>
    );
  }
);
