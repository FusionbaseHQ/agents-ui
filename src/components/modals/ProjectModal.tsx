import React from "react";

type EnvironmentConfig = {
  id: string;
  name: string;
};

type ProjectModalProps = {
  isOpen: boolean;
  mode: "new" | "rename";
  title: string;
  titleInputRef: React.RefObject<HTMLInputElement>;
  onChangeTitle: (value: string) => void;
  basePath: string;
  onChangeBasePath: (value: string) => void;
  basePathPlaceholder: string;
  onBrowseBasePath: () => void;
  canUseCurrentTab: boolean;
  onUseCurrentTab: () => void;
  canUseHome: boolean;
  onUseHome: () => void;
  environments: EnvironmentConfig[];
  selectedEnvironmentId: string;
  onChangeEnvironmentId: (value: string) => void;
  onOpenEnvironments: () => void;
  assetsEnabled: boolean;
  onChangeAssetsEnabled: (value: boolean) => void;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
};

export function ProjectModal({
  isOpen,
  mode,
  title,
  titleInputRef,
  onChangeTitle,
  basePath,
  onChangeBasePath,
  basePathPlaceholder,
  onBrowseBasePath,
  canUseCurrentTab,
  onUseCurrentTab,
  canUseHome,
  onUseHome,
  environments,
  selectedEnvironmentId,
  onChangeEnvironmentId,
  onOpenEnvironments,
  assetsEnabled,
  onChangeAssetsEnabled,
  onClose,
  onSubmit,
}: ProjectModalProps) {
  if (!isOpen) return null;

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modalTitle">{mode === "new" ? "New project" : "Project settings"}</h3>
        <form onSubmit={onSubmit}>
          <div className="formRow">
            <div className="label">Title</div>
            <input
              className="input"
              ref={titleInputRef}
              value={title}
              onChange={(e) => onChangeTitle(e.target.value)}
              placeholder="e.g. my-repo"
            />
          </div>
          <div className="formRow">
            <div className="label">Base path</div>
            <div className="pathRow">
              <input
                className="input"
                value={basePath}
                onChange={(e) => onChangeBasePath(e.target.value)}
                placeholder={basePathPlaceholder}
              />
              <button type="button" className="btn" onClick={onBrowseBasePath}>
                Browse
              </button>
            </div>
            <div className="pathActions">
              <button
                type="button"
                className="btnSmall"
                onClick={onUseCurrentTab}
                disabled={!canUseCurrentTab}
              >
                Use current tab
              </button>
              <button type="button" className="btnSmall" onClick={onUseHome} disabled={!canUseHome}>
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
                value={selectedEnvironmentId}
                onChange={(e) => onChangeEnvironmentId(e.target.value)}
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
                onChange={(e) => onChangeAssetsEnabled(e.target.checked)}
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
