import React from "react";
import type { Plan } from "./agentTypes";
import { PlanTaskCard } from "./PlanTaskCard";

type Props = {
  plan: Plan;
  onRunAll: () => void;
  onPause: () => void;
  onNewPlan: () => void;
  onViewTerminal: (sessionId: string) => void;
  onRetryTask: (taskId: string) => void;
  onCancelTask: (taskId: string) => void;
};

function planStatusLabel(plan: Plan): string {
  const done = plan.tasks.filter((t) => t.status === "done").length;
  const total = plan.tasks.length;
  switch (plan.status) {
    case "draft":
      return "Draft";
    case "running":
      return `Running \u00B7 ${done}/${total} done`;
    case "paused":
      return `Paused \u00B7 ${done}/${total} done`;
    case "completed":
      return `Completed \u00B7 ${total}/${total} done`;
    case "failed":
      return `Failed \u00B7 ${done}/${total} done`;
    default:
      return plan.status;
  }
}

export function PlanBoard({
  plan,
  onRunAll,
  onPause,
  onNewPlan,
  onViewTerminal,
  onRetryTask,
  onCancelTask,
}: Props) {
  const isRunning = plan.status === "running";
  const isDraft = plan.status === "draft";
  const isTerminal = plan.status === "completed" || plan.status === "failed";

  return (
    <div className="planBoard">
      <div className="planBoardHeader">
        <div className="planBoardGoal">&ldquo;{plan.goal}&rdquo;</div>
        <div className="planBoardStatus">{planStatusLabel(plan)}</div>
        <div className="planBoardActions">
          {(isDraft || isTerminal) && (
            <button type="button" className="btnSmall planBoardBtn" onClick={onRunAll}>
              Run All
            </button>
          )}
          {isRunning && (
            <button type="button" className="btnSmall planBoardBtn" onClick={onPause}>
              Pause
            </button>
          )}
          <button type="button" className="btnSmall planBoardBtn planBoardBtnSecondary" onClick={onNewPlan}>
            New Plan
          </button>
        </div>
      </div>

      <div className="planBoardTasks">
        {plan.tasks.map((task) => (
          <PlanTaskCard
            key={task.id}
            task={task}
            onViewTerminal={onViewTerminal}
            onRetry={onRetryTask}
            onCancel={onCancelTask}
          />
        ))}
      </div>
    </div>
  );
}
