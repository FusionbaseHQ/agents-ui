import React from "react";
import { Icon } from "./Icon";

type Project = {
  id: string;
  title: string;
  basePath: string | null;
  environmentId: string | null;
};

type EnvironmentConfig = {
  id: string;
  name: string;
};

type ProjectsSectionProps = {
  projects: Project[];
  activeProjectId: string;
  activeProject: Project | null;
  environments: EnvironmentConfig[];
  sessionCountByProject: Map<string, number>;
  workingAgentCountByProject: Map<string, number>;
  onNewProject: () => void;
  onProjectSettings: () => void;
  onDeleteProject: () => void;
  onSelectProject: (projectId: string) => void;
  onOpenProjectSettings: (projectId: string) => void;
};

export function ProjectsSection({
  projects,
  activeProjectId,
  activeProject,
  environments,
  sessionCountByProject,
  workingAgentCountByProject,
  onNewProject,
  onProjectSettings,
  onDeleteProject,
  onSelectProject,
  onOpenProjectSettings,
}: ProjectsSectionProps) {
  return (
    <>
      <div className="sidebarHeader">
        <div className="title">Projects</div>
        <div className="sidebarHeaderActions">
          <button
            type="button"
            className="btnSmall btnIcon"
            onClick={onNewProject}
            title="New project"
            aria-label="New project"
          >
            <Icon name="plus" />
          </button>
          <button
            type="button"
            className="btnSmall btnIcon"
            onClick={onProjectSettings}
            disabled={!activeProject}
            title="Project settings"
            aria-label="Project settings"
          >
            <Icon name="settings" />
          </button>
          <button
            type="button"
            className="btnSmall btnIcon btnDanger"
            onClick={onDeleteProject}
            disabled={!activeProject}
            title="Delete project"
            aria-label="Delete project"
          >
            <Icon name="trash" />
          </button>
        </div>
      </div>

      <div className="projectList">
        {projects.map((p) => {
          const isActive = p.id === activeProjectId;
          const count = sessionCountByProject.get(p.id) ?? 0;
          const workingCount = workingAgentCountByProject.get(p.id) ?? 0;
          const envName =
            p.environmentId && environments.some((e) => e.id === p.environmentId)
              ? environments.find((e) => e.id === p.environmentId)?.name?.trim() ?? null
              : null;
          return (
            <button
              key={p.id}
              className={`projectItem ${isActive ? "projectItemActive" : ""}`}
              onClick={() => onSelectProject(p.id)}
              onDoubleClick={() => onOpenProjectSettings(p.id)}
              title={
                [
                  p.title,
                  workingCount ? `Agents working: ${workingCount}` : null,
                  p.basePath ? `Base: ${p.basePath}` : null,
                  envName ? `Env: ${envName}` : null,
                ]
                  .filter(Boolean)
                  .join("\n")
              }
            >
              <span className="projectTitle">{p.title}</span>
              <span className="projectBadges">
                {workingCount > 0 && (
                  <span
                    className="projectAgentsBadge"
                    title={`${workingCount} agent${workingCount === 1 ? "" : "s"} working`}
                  >
                    <span className="projectAgentsDot" aria-hidden="true" />
                    {workingCount}
                  </span>
                )}
                <span className="projectCount">{count}</span>
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}
