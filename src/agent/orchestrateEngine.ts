import type { AgentMessage, Plan, PlanTask, AgentSettings, AgentLaunchSettings } from "./agentTypes";
import { invoke } from "@tauri-apps/api/core";

// ── Plan generation prompt ──

export const PLAN_GENERATION_PROMPT = `You are a task planner. Given a user's goal, break it down into concrete tasks that coding agents can execute independently in terminal sessions.

Output ONLY valid JSON (no markdown fences, no explanation) in this format:
{
  "tasks": [
    {
      "id": "1",
      "title": "Short task title",
      "description": "Detailed instructions for the agent. Be specific about what files to create/modify and what the expected outcome is.",
      "dependencies": [],
      "assignee": "claude-code",
      "model": "sonnet"
    }
  ]
}

Rules:
- Each task should be independently executable by a coding agent in a terminal
- Use "dependencies" to specify task IDs that must complete first (e.g. ["1", "2"])
- "assignee" must be "claude-code" or "codex"
- "model" is optional. For claude-code: "fable", "opus", "sonnet", "haiku". For codex: "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.3-codex", "gpt-5.3-codex-spark"
- Keep tasks focused — each should take a single agent session
- Minimize dependencies to maximize parallelism
- 2-8 tasks is typical for most goals
`;

// ── Result file helpers ──

/** Build the result file path for a task within a plan's result directory. */
export function resultFilePath(resultDir: string, taskId: string): string {
  return `${resultDir}/task-${taskId}.result.json`;
}

/** Build the result directory for a plan inside a project. */
export function planResultDir(projectBasePath: string, planId: string): string {
  return `${projectBasePath}/.agents-ui/orchestrate/${planId}`;
}

// ── Parse plan from coordinator output ──

type RawTask = {
  id: string;
  title: string;
  description: string;
  dependencies?: string[];
  assignee?: string;
  model?: string;
};

/** Extract JSON from text that may contain markdown fences or surrounding prose. */
function extractJson(text: string): string | null {
  // Try 1: entire text is valid JSON
  try { JSON.parse(text); return text; } catch { /* continue */ }

  // Try 2: extract from ```json ... ``` fences
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try { JSON.parse(fenceMatch[1]); return fenceMatch[1]; } catch { /* continue */ }
  }

  // Try 3: find the first { ... } block that looks like our plan
  const start = text.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try { JSON.parse(candidate); return candidate; } catch { /* continue */ }
      }
    }
  }

  return null;
}

export function parsePlanFromOutput(messages: AgentMessage[]): PlanTask[] | null {
  const assistantTexts = messages
    .filter((m) => m.role === "assistant" && m.content)
    .map((m) => m.content);
  if (assistantTexts.length === 0) return null;

  const candidates = [
    assistantTexts[assistantTexts.length - 1],
    assistantTexts.join("\n"),
  ];

  for (const text of candidates) {
    const json = extractJson(text.trim());
    if (!json) continue;

    try {
      const parsed = JSON.parse(json);
      const rawTasks: RawTask[] = parsed.tasks;
      if (!Array.isArray(rawTasks) || rawTasks.length === 0) continue;

      return rawTasks.map((t) => ({
        id: String(t.id),
        title: t.title || "Untitled task",
        description: t.description || "",
        dependencies: Array.isArray(t.dependencies) ? t.dependencies.map(String) : [],
        status: "pending" as const,
        assignee: t.assignee === "codex" ? ("codex" as const) : ("claude-code" as const),
        model: t.model || undefined,
        terminalSessionId: null,
        resultFilePath: null,
        output: null,
        error: null,
        startedAt: null,
        completedAt: null,
        exitCode: null,
      }));
    } catch {
      continue;
    }
  }

  return null;
}

// ── Status recomputation ──

export function recomputeTaskStatuses(tasks: PlanTask[]): PlanTask[] {
  return tasks.map((task) => {
    if (task.status !== "pending" && task.status !== "blocked") return task;
    const allDepsDone = task.dependencies.every(
      (id) => tasks.find((t) => t.id === id)?.status === "done",
    );
    const anyDepFailed = task.dependencies.some(
      (id) => tasks.find((t) => t.id === id)?.status === "failed",
    );
    if (anyDepFailed) return { ...task, status: "failed" as const, error: "Dependency failed" };
    return { ...task, status: allDepsDone ? ("ready" as const) : ("blocked" as const) };
  });
}

// ── Context building for downstream tasks ──

export function buildTaskPrompt(task: PlanTask, plan: Plan): string {
  const parts: string[] = [];
  parts.push(`## Overall Goal\n${plan.goal}\n`);

  const deps = task.dependencies
    .map((id) => plan.tasks.find((t) => t.id === id))
    .filter((t): t is PlanTask => t?.status === "done" && !!t.output);

  if (deps.length > 0) {
    parts.push("## Context from Completed Tasks\n");
    for (const dep of deps) {
      const output = dep.output!.length > 4000
        ? dep.output!.slice(0, 4000) + "\n...[truncated]"
        : dep.output!;
      parts.push(`### ${dep.title}\n${output}\n`);
    }
  }

  parts.push(`## Your Task\n**${task.title}**\n\n${task.description}`);

  // Result file instruction
  const rfp = task.resultFilePath;
  if (rfp) {
    parts.push(`\n## Completion\nWhen you have fully completed this task, you MUST create the file \`${rfp}\` with the following JSON content:\n\`\`\`json\n{\n  "status": "done",\n  "summary": "<a concise summary of what you accomplished>"\n}\n\`\`\`\nThis file signals that your task is complete. Do NOT create this file until you are fully done.`);
  }

  return parts.join("\n");
}

// ── Task dispatch (interactive terminal) ──

const INIT_DELAY_MS = 2500;

export async function dispatchTask(
  task: PlanTask,
  plan: Plan,
  createTaskSession: (command: string, name: string) => Promise<string>,
  settings: AgentSettings,
): Promise<{ sessionId: string; resultPath: string }> {
  const rfp = resultFilePath(plan.resultDir, task.id);
  // Temporarily set resultFilePath so buildTaskPrompt can include it
  const taskWithPath = { ...task, resultFilePath: rfp };
  const prompt = buildTaskPrompt(taskWithPath, plan);

  const launchSettings: AgentLaunchSettings = {
    provider: task.assignee === "codex" ? "codex" : "claude-code",
    model: task.model,
    effort: settings.effort,
  };

  // Get the interactive terminal command (no -p, no --output-format)
  const command: string = await invoke("get_agent_terminal_command", {
    provider: launchSettings.provider === "codex" ? "codex" : null,
    extraArgs: buildExtraArgs(launchSettings),
  });

  // Create visible terminal session
  const sessionId = await createTaskSession(command, `Task: ${task.title}`);

  // Wait for the CLI to initialize, then send the prompt
  await sleep(INIT_DELAY_MS);
  await invoke("write_to_session", {
    id: sessionId,
    data: prompt + "\n",
    source: "system",
  });

  return { sessionId, resultPath: rfp };
}

function buildExtraArgs(settings: AgentLaunchSettings): string[] {
  const args: string[] = [];
  const model = settings.provider === "codex" ? settings.model || "gpt-5.6-sol" : settings.model;
  if (model) {
    args.push("--model", model);
  }
  if (settings.effort) {
    args.push("--effort", settings.effort);
  }
  return args;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Result file polling ──

export type TaskResultFile = {
  status: "done" | "failed";
  summary: string;
};

/** Try to read a result file. Returns null if it doesn't exist or can't be parsed. */
export async function readTaskResultFile(path: string): Promise<TaskResultFile | null> {
  try {
    const content: string = await invoke("orchestrate_read_file", { path });
    const parsed = JSON.parse(content);
    if (parsed.status === "done" || parsed.status === "failed") {
      return { status: parsed.status, summary: String(parsed.summary ?? "") };
    }
    return null;
  } catch {
    return null;
  }
}

// ── Get ready tasks that can be dispatched ──

export function getDispatchableTasks(plan: Plan): PlanTask[] {
  const runningCount = plan.tasks.filter((t) => t.status === "running").length;
  const available = plan.maxConcurrency - runningCount;
  if (available <= 0) return [];

  return plan.tasks
    .filter((t) => t.status === "ready")
    .slice(0, available);
}

// ── Compute plan status from task statuses ──

export function computePlanStatus(tasks: PlanTask[]): "draft" | "running" | "completed" | "failed" {
  if (tasks.every((t) => t.status === "done")) return "completed";
  if (tasks.some((t) => t.status === "running")) return "running";
  if (tasks.every((t) => t.status === "failed" || t.status === "done")) return "failed";
  if (tasks.some((t) => t.status === "done" || t.status === "ready")) return "running";
  return "draft";
}

// ── Ensure result directory exists ──

export async function ensureResultDir(dir: string): Promise<void> {
  try {
    await invoke("orchestrate_ensure_dir", { path: dir });
  } catch {
    // may already exist
  }
}
