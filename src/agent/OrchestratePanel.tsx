import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Icon } from "../components/Icon";
import { PlanBoard } from "./PlanBoard";
import { loadPlans, savePlans } from "./agentStorage";
import {
  parseStreamLine,
  StreamingMessageBuilder,
  resetCodexTracking,
} from "./agentStreamParser";
import {
  PLAN_GENERATION_PROMPT,
  parsePlanFromOutput,
  recomputeTaskStatuses,
  dispatchTask,
  getDispatchableTasks,
  computePlanStatus,
  planResultDir,
  ensureResultDir,
  readTaskResultFile,
} from "./orchestrateEngine";
import type {
  AgentMessage,
  AgentSettings,
  AgentLaunchSettings,
  Plan,
  PlanTask,
  ReasoningEffort,
} from "./agentTypes";

type Props = {
  settings: AgentSettings;
  projectBasePath: string;
  onCreateTaskSession: (command: string, name: string) => Promise<string>;
  onActivateSession: (sessionId: string) => void;
};

const COORDINATOR_MODELS = [
  { value: "", label: "Default" },
  { value: "opus", label: "Opus 4.6" },
  { value: "sonnet", label: "Sonnet 4.6" },
  { value: "haiku", label: "Haiku 4.5" },
];

const EFFORT_OPTIONS = [
  { value: "", label: "Default", short: "Auto" },
  { value: "high", label: "High", short: "High" },
  { value: "medium", label: "Medium", short: "Med" },
  { value: "low", label: "Low", short: "Low" },
];

export function OrchestratePanel({ settings, projectBasePath, onCreateTaskSession, onActivateSession }: Props) {
  const [plans, setPlans] = useState<Plan[]>(() => loadPlans());
  const [activePlanId, setActivePlanId] = useState<string | null>(() => {
    const p = loadPlans();
    return p.length > 0 ? p[0].id : null;
  });
  const [goalInput, setGoalInput] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [coordinatorModel, setCoordinatorModel] = useState<string | undefined>(undefined);
  const [coordinatorEffort, setCoordinatorEffort] = useState<ReasoningEffort | undefined>(undefined);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showEffortDropdown, setShowEffortDropdown] = useState(false);
  const [inputAreaHeight, setInputAreaHeight] = useState<number | null>(null);
  const resizeDragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const inputAreaRef = useRef<HTMLDivElement | null>(null);
  const modelDropdownRef = useRef<HTMLDivElement | null>(null);
  const effortDropdownRef = useRef<HTMLDivElement | null>(null);
  const builderRef = useRef(new StreamingMessageBuilder());
  // Immediate refs — not state-derived, so they're available to event listeners right away
  const runIdRef = useRef<string | null>(null);
  const messagesRef = useRef<AgentMessage[]>([]);
  const plansRef = useRef(plans);
  plansRef.current = plans;
  const activePlanIdRef = useRef(activePlanId);
  activePlanIdRef.current = activePlanId;

  const activePlan = plans.find((p) => p.id === activePlanId) ?? null;

  // Close dropdowns on click outside
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

  // ── Input area resize drag ──
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const el = inputAreaRef.current;
    if (!el) return;
    resizeDragRef.current = { startY: e.clientY, startHeight: el.offsetHeight };

    const onMove = (ev: MouseEvent) => {
      const drag = resizeDragRef.current;
      if (!drag) return;
      const delta = drag.startY - ev.clientY; // dragging up = positive delta
      const newHeight = Math.max(80, Math.min(drag.startHeight + delta, 500));
      setInputAreaHeight(newHeight);
    };
    const onUp = () => {
      resizeDragRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  // Persist plans
  useEffect(() => {
    savePlans(plans);
  }, [plans]);

  // ── Listen for pty-exit to track task completion ──
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    listen<{ id: string; exit_code: number | null }>("pty-exit", async (event) => {
      if (disposed) return;
      const { id: sessionId, exit_code } = event.payload;

      // Find which plan/task owns this session
      const currentPlans = plansRef.current;
      let matchedPlanIdx = -1;
      let matchedTaskIdx = -1;

      for (let pi = 0; pi < currentPlans.length; pi++) {
        const ti = currentPlans[pi].tasks.findIndex(
          (t) => t.terminalSessionId === sessionId && t.status === "running",
        );
        if (ti >= 0) {
          matchedPlanIdx = pi;
          matchedTaskIdx = ti;
          break;
        }
      }

      if (matchedPlanIdx < 0) return;

      // Read output buffer
      let output = "";
      try {
        output = await invoke<string>("read_agent_session_output", { sessionId });
      } catch {
        // ignore
      }

      setPlans((prev) => {
        const plan = prev[matchedPlanIdx];
        if (!plan) return prev;
        const task = plan.tasks[matchedTaskIdx];
        if (!task || task.terminalSessionId !== sessionId) return prev;

        const success = exit_code === 0;
        const updatedTask: PlanTask = {
          ...task,
          status: success ? "done" : "failed",
          output: output || null,
          error: success ? null : `Exited with code ${exit_code ?? "unknown"}`,
          completedAt: Date.now(),
          exitCode: exit_code,
        };

        const newTasks = [...plan.tasks];
        newTasks[matchedTaskIdx] = updatedTask;

        // Recompute statuses for pending/blocked tasks
        const recomputed = recomputeTaskStatuses(newTasks);
        const newStatus = computePlanStatus(recomputed);

        const updatedPlan: Plan = {
          ...plan,
          tasks: recomputed,
          status: plan.status === "paused" ? "paused" : newStatus,
          updatedAt: Date.now(),
        };

        const result = [...prev];
        result[matchedPlanIdx] = updatedPlan;
        return result;
      });
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // ── Poll result files for running tasks ──
  useEffect(() => {
    if (!activePlan || activePlan.status !== "running") return;
    const runningTasks = activePlan.tasks.filter(
      (t) => t.status === "running" && t.resultFilePath,
    );
    if (runningTasks.length === 0) return;

    const interval = setInterval(async () => {
      for (const task of runningTasks) {
        if (!task.resultFilePath) continue;
        const result = await readTaskResultFile(task.resultFilePath);
        if (!result) continue;

        // Result file found — mark task as done/failed
        // Also read the MCP output buffer for context passing
        let output = result.summary;
        if (task.terminalSessionId) {
          try {
            const mpcOutput = await invoke<string>("read_agent_session_output", {
              sessionId: task.terminalSessionId,
            });
            if (mpcOutput) {
              output = output ? `${output}\n\n${mpcOutput}` : mpcOutput;
            }
          } catch {
            // ignore
          }
        }

        setPlans((prev) => {
          const planIdx = prev.findIndex((p) => p.id === activePlanIdRef.current);
          if (planIdx < 0) return prev;
          const plan = prev[planIdx];
          const taskIdx = plan.tasks.findIndex((t) => t.id === task.id);
          if (taskIdx < 0 || plan.tasks[taskIdx].status !== "running") return prev;

          const newTasks = [...plan.tasks];
          newTasks[taskIdx] = {
            ...newTasks[taskIdx],
            status: result.status === "done" ? "done" : "failed",
            output: output || null,
            error: result.status === "failed" ? (result.summary || "Task failed") : null,
            completedAt: Date.now(),
          };

          const recomputed = recomputeTaskStatuses(newTasks);
          const newStatus = computePlanStatus(recomputed);
          const updatedPlan: Plan = {
            ...plan,
            tasks: recomputed,
            status: plan.status === "paused" ? "paused" : newStatus,
            updatedAt: Date.now(),
          };
          const out = [...prev];
          out[planIdx] = updatedPlan;
          return out;
        });
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [activePlan?.tasks, activePlan?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-dispatch ready tasks when plan updates ──
  useEffect(() => {
    if (!activePlan || activePlan.status !== "running") return;

    const dispatchable = getDispatchableTasks(activePlan);
    if (dispatchable.length === 0) return;

    // Dispatch each ready task
    for (const task of dispatchable) {
      void (async () => {
        try {
          // Mark as running immediately
          setPlans((prev) => {
            const planIdx = prev.findIndex((p) => p.id === activePlan.id);
            if (planIdx < 0) return prev;
            const plan = prev[planIdx];
            const taskIdx = plan.tasks.findIndex((t) => t.id === task.id);
            if (taskIdx < 0 || plan.tasks[taskIdx].status !== "ready") return prev;

            const newTasks = [...plan.tasks];
            newTasks[taskIdx] = { ...newTasks[taskIdx], status: "running", startedAt: Date.now() };
            const result = [...prev];
            result[planIdx] = { ...plan, tasks: newTasks, updatedAt: Date.now() };
            return result;
          });

          const { sessionId, resultPath } = await dispatchTask(
            task,
            activePlan,
            onCreateTaskSession,
            settings,
          );

          // Store session ID and result file path on the task
          setPlans((prev) => {
            const planIdx = prev.findIndex((p) => p.id === activePlan.id);
            if (planIdx < 0) return prev;
            const plan = prev[planIdx];
            const taskIdx = plan.tasks.findIndex((t) => t.id === task.id);
            if (taskIdx < 0) return prev;

            const newTasks = [...plan.tasks];
            newTasks[taskIdx] = { ...newTasks[taskIdx], terminalSessionId: sessionId, resultFilePath: resultPath };
            const result = [...prev];
            result[planIdx] = { ...plan, tasks: newTasks, updatedAt: Date.now() };
            return result;
          });
        } catch (err) {
          // Mark task as failed
          setPlans((prev) => {
            const planIdx = prev.findIndex((p) => p.id === activePlan.id);
            if (planIdx < 0) return prev;
            const plan = prev[planIdx];
            const taskIdx = plan.tasks.findIndex((t) => t.id === task.id);
            if (taskIdx < 0) return prev;

            const newTasks = [...plan.tasks];
            newTasks[taskIdx] = {
              ...newTasks[taskIdx],
              status: "failed",
              error: String(err),
              completedAt: Date.now(),
            };
            const result = [...prev];
            result[planIdx] = { ...plan, tasks: newTasks, updatedAt: Date.now() };
            return result;
          });
        }
      })();
    }
  }, [activePlan?.tasks, activePlan?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const goalInputRef = useRef(goalInput);
  goalInputRef.current = goalInput;

  // ── Listen for plan generation events ──
  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];

    listen<{ runId: string; data: string }>("agent-output", (event) => {
      if (!runIdRef.current || event.payload.runId !== runIdRef.current) return;
      const update = parseStreamLine(event.payload.data);
      if (!update) return;

      // Update messages ref immediately (no React state delay)
      messagesRef.current = builderRef.current.apply(messagesRef.current, update);
    }).then((fn) => { if (disposed) fn(); else cleanups.push(fn); });

    listen<{ runId: string; data: string }>("agent-stderr", (event) => {
      if (!runIdRef.current || event.payload.runId !== runIdRef.current) return;
      // Log stderr for debugging
      console.warn("[orchestrate-stderr]", event.payload.data);
    }).then((fn) => { if (disposed) fn(); else cleanups.push(fn); });

    listen<{ runId: string; exitCode: number | null }>("agent-done", (event) => {
      if (!runIdRef.current || event.payload.runId !== runIdRef.current) return;
      runIdRef.current = null;

      // Finalize messages from the ref (always up-to-date)
      const finalMessages = builderRef.current.apply(messagesRef.current, { kind: "finalize" });
      messagesRef.current = finalMessages;

      console.log("[orchestrate] agent-done, messages:", finalMessages.length,
        "last content:", finalMessages[finalMessages.length - 1]?.content?.slice(0, 200));

      const tasks = parsePlanFromOutput(finalMessages);

      if (tasks && tasks.length > 0) {
        const planId = `plan-${Date.now()}`;
        const resultDir = planResultDir(projectBasePath, planId);
        const plan: Plan = {
          id: planId,
          goal: goalInputRef.current,
          status: "draft",
          tasks: recomputeTaskStatuses(tasks),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          maxConcurrency: 2,
          resultDir,
        };
        // Ensure the result directory exists
        void ensureResultDir(resultDir);
        setPlans((prev) => [plan, ...prev]);
        setActivePlanId(planId);
        setGenerateError(null);
      } else {
        // Show what we got so the user can debug
        const lastContent = finalMessages
          .filter((m) => m.role === "assistant" && m.content)
          .map((m) => m.content)
          .join("\n");
        setGenerateError(
          lastContent
            ? `Could not parse plan from response:\n${lastContent.slice(0, 500)}`
            : `No response received from coordinator (${finalMessages.length} messages).`,
        );
      }

      setGenerating(false);
    }).then((fn) => { if (disposed) fn(); else cleanups.push(fn); });

    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Generate plan ──
  const generatePlan = useCallback(async () => {
    const goal = goalInput.trim();
    if (!goal || generating) return;

    builderRef.current = new StreamingMessageBuilder();
    messagesRef.current = [];
    resetCodexTracking();
    setGenerateError(null);

    const fullPrompt = `${PLAN_GENERATION_PROMPT}\n\nUser's goal: ${goal}`;

    try {
      const launchSettings: AgentLaunchSettings = {
        provider: "claude-code",
        model: coordinatorModel,
        effort: coordinatorEffort,
      };

      const runId: string = await invoke("start_agent_prompt", {
        prompt: fullPrompt,
        sessionId: null,
        settings: launchSettings,
      });

      // Set ref immediately so event listeners can match right away
      runIdRef.current = runId;
      setGenerating(true);
    } catch (err) {
      console.error("Failed to start plan generation:", err);
      setGenerateError(String(err));
    }
  }, [goalInput, generating, coordinatorModel, coordinatorEffort]);

  const stopGenerating = useCallback(async () => {
    if (runIdRef.current) {
      const rid = runIdRef.current;
      runIdRef.current = null;
      await invoke("stop_agent", { runId: rid }).catch(() => {});
      setGenerating(false);
    }
  }, []);

  // ── Plan actions ──
  const runAll = useCallback(() => {
    if (!activePlan) return;
    setPlans((prev) => {
      const idx = prev.findIndex((p) => p.id === activePlan.id);
      if (idx < 0) return prev;
      const plan = prev[idx];
      const recomputed = recomputeTaskStatuses(
        plan.tasks.map((t) =>
          t.status === "failed" || t.status === "blocked" || t.status === "pending"
            ? { ...t, status: "pending" as const, error: null, output: null, terminalSessionId: null, resultFilePath: null, exitCode: null, startedAt: null, completedAt: null }
            : t,
        ),
      );
      const result = [...prev];
      result[idx] = { ...plan, tasks: recomputed, status: "running", updatedAt: Date.now() };
      return result;
    });
  }, [activePlan]);

  const pausePlan = useCallback(() => {
    if (!activePlan) return;
    setPlans((prev) => {
      const idx = prev.findIndex((p) => p.id === activePlan.id);
      if (idx < 0) return prev;
      const result = [...prev];
      result[idx] = { ...prev[idx], status: "paused", updatedAt: Date.now() };
      return result;
    });
  }, [activePlan]);

  const newPlan = useCallback(() => {
    setActivePlanId(null);
    setGoalInput("");
  }, []);

  const retryTask = useCallback(
    (taskId: string) => {
      if (!activePlan) return;
      setPlans((prev) => {
        const planIdx = prev.findIndex((p) => p.id === activePlan.id);
        if (planIdx < 0) return prev;
        const plan = prev[planIdx];
        const taskIdx = plan.tasks.findIndex((t) => t.id === taskId);
        if (taskIdx < 0) return prev;

        const newTasks = [...plan.tasks];
        newTasks[taskIdx] = {
          ...newTasks[taskIdx],
          status: "ready",
          error: null,
          output: null,
          terminalSessionId: null,
          resultFilePath: null,
          exitCode: null,
          startedAt: null,
          completedAt: null,
        };
        const result = [...prev];
        result[planIdx] = { ...plan, tasks: newTasks, status: "running", updatedAt: Date.now() };
        return result;
      });
    },
    [activePlan],
  );

  const cancelTask = useCallback(
    async (taskId: string) => {
      if (!activePlan) return;
      const task = activePlan.tasks.find((t) => t.id === taskId);
      if (!task?.terminalSessionId) return;

      try {
        await invoke("close_session", { id: task.terminalSessionId });
      } catch {
        // ignore
      }
    },
    [activePlan],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void generatePlan();
      }
    },
    [generatePlan],
  );

  // ── Generating state ──
  if (generating) {
    return (
      <div className="orchestratePanel">
        <div className="orchestrateGenerating">
          <span className="agentSpinner" />
          <span className="orchestrateGeneratingText">Generating plan...</span>
          <div className="agentProgressBar" />
          <p className="orchestrateGeneratingHint">
            The coordinator is analyzing your goal and creating tasks.
          </p>
          <button type="button" className="btnSmall" onClick={() => void stopGenerating()}>
            Stop
          </button>
        </div>
      </div>
    );
  }

  // ── Active plan ──
  if (activePlan) {
    return (
      <div className="orchestratePanel">
        <PlanBoard
          plan={activePlan}
          onRunAll={runAll}
          onPause={pausePlan}
          onNewPlan={newPlan}
          onViewTerminal={onActivateSession}
          onRetryTask={retryTask}
          onCancelTask={(id) => void cancelTask(id)}
        />
      </div>
    );
  }

  // ── Empty state ──
  return (
    <div className="orchestratePanel">
      <div className="orchestrateEmpty">
        <div className="orchestrateEmptyIcon">
          <Icon name="layers" size={28} />
        </div>
        <div className="orchestrateEmptyTitle">Orchestrate</div>
        <div className="orchestrateEmptyHint">
          Describe a goal and a team of agents will build it.
        </div>
      </div>

      {generateError && (
        <div className="orchestrateError">
          <pre className="orchestrateErrorText">{generateError}</pre>
          <button
            type="button"
            className="btnSmall"
            onClick={() => setGenerateError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      <div
        className="orchestrateInputArea"
        ref={inputAreaRef}
        style={inputAreaHeight ? { height: inputAreaHeight } : undefined}
      >
        <div className="orchestrateResizeHandle" onMouseDown={onResizeStart}>
          <div className="orchestrateResizeGrip" />
        </div>
        <div className="orchestrateInputControls">
          <span className="orchestrateControlLabel">Coordinator</span>
          <div className="agentModelChipWrap" ref={modelDropdownRef}>
            <button
              type="button"
              className="agentModelChip"
              onClick={() => setShowModelDropdown((p) => !p)}
              disabled={generating}
            >
              {COORDINATOR_MODELS.find((o) => o.value === (coordinatorModel ?? ""))?.label ?? "Default"}
              <Icon name="chevron-down" size={12} />
            </button>
            {showModelDropdown && (
              <div className="agentModelDropdown">
                {COORDINATOR_MODELS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`agentModelDropdownItem ${(coordinatorModel ?? "") === opt.value ? "agentModelDropdownItemActive" : ""}`}
                    onClick={() => {
                      setCoordinatorModel(opt.value || undefined);
                      setShowModelDropdown(false);
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="agentModelChipWrap" ref={effortDropdownRef}>
            <button
              type="button"
              className="agentModelChip"
              onClick={() => setShowEffortDropdown((p) => !p)}
              disabled={generating}
              title="Reasoning effort"
            >
              {EFFORT_OPTIONS.find((o) => o.value === (coordinatorEffort ?? ""))?.short ?? "Auto"}
              <Icon name="chevron-down" size={12} />
            </button>
            {showEffortDropdown && (
              <div className="agentModelDropdown">
                {EFFORT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`agentModelDropdownItem ${(coordinatorEffort ?? "") === opt.value ? "agentModelDropdownItemActive" : ""}`}
                    onClick={() => {
                      setCoordinatorEffort((opt.value || undefined) as ReasoningEffort | undefined);
                      setShowEffortDropdown(false);
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="orchestrateInputRow">
          <textarea
            className="agentInput"
            value={goalInput}
            onChange={(e) => setGoalInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe your goal..."
          />
          <button
            type="button"
            className="btnSmall agentSendBtn"
            onClick={() => void generatePlan()}
            disabled={!goalInput.trim()}
          >
            Plan
          </button>
        </div>

        {plans.length > 0 && (
          <div className="orchestrateHistorySection">
            <button
              type="button"
              className="orchestrateHistoryToggle"
              onClick={() => setShowHistory((p) => !p)}
            >
              Plan History {showHistory ? "\u25B4" : "\u25BE"}
            </button>
            {showHistory && (
              <div className="orchestrateHistoryList">
                {plans.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="orchestrateHistoryItem"
                    onClick={() => {
                      setActivePlanId(p.id);
                      setShowHistory(false);
                    }}
                  >
                    <span className="orchestrateHistoryGoal">
                      {p.goal.length > 60 ? p.goal.slice(0, 60) + "\u2026" : p.goal}
                    </span>
                    <span className="orchestrateHistoryMeta">
                      {p.tasks.length} tasks \u00B7 {p.status}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
