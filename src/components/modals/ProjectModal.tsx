import React, { useState, useRef, useEffect, useImperativeHandle, forwardRef } from "react";

function normalizeSmartQuotes(input: string): string {
  return input.replace(/[""„‟«»]/g, '"').replace(/[''‚‛‹›]/g, "'");
}

type EnvironmentConfig = {
  id: string;
  name: string;
};

export type ProjectSubmitData = {
  title: string;
  basePath: string;
  environmentId: string;
  assetsEnabled: boolean;
};

export type ProjectModalHandle = {
  setBasePath: (basePath: string) => void;
};

type ProjectModalProps = {
  mode: "new" | "rename";
  initialTitle: string;
  initialBasePath: string;
  basePathPlaceholder: string;
  initialEnvironmentId: string;
  initialAssetsEnabled: boolean;
  canUseCurrentTab: boolean;
  currentTabCwd: string | null;
  canUseHome: boolean;
  homeDir: string | null;
  environments: EnvironmentConfig[];
  onOpenEnvironments: () => void;
  onBrowseBasePath: (currentBasePath: string) => void;
  onClose: () => void;
  onSubmit: (data: ProjectSubmitData) => void;
};

export const ProjectModal = forwardRef<ProjectModalHandle, ProjectModalProps>(
  function ProjectModal(props, ref) {
    const {
      mode, initialTitle, initialBasePath, basePathPlaceholder,
      initialEnvironmentId, initialAssetsEnabled,
      canUseCurrentTab, currentTabCwd, canUseHome, homeDir,
      environments, onOpenEnvironments, onBrowseBasePath, onClose, onSubmit,
    } = props;

    const [title, setTitle] = useState(initialTitle);
    const [basePath, setBasePath] = useState(initialBasePath);
    const [environmentId, setEnvironmentId] = useState(initialEnvironmentId);
    const [assetsEnabled, setAssetsEnabled] = useState(initialAssetsEnabled);
    const titleRef = useRef<HTMLInputElement>(null);

    useImperativeHandle(ref, () => ({ setBasePath }));

    useEffect(() => {
      const t = window.setTimeout(() => titleRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }, []);

    const handleSubmit = (e: React.FormEvent) => {
      e.preventDefault();
      onSubmit({ title, basePath, environmentId, assetsEnabled });
    };

    return (
      <div className="modalBackdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h3 className="modalTitle">{mode === "new" ? "New project" : "Project settings"}</h3>
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
        </div>
      </div>
    );
  }
);
