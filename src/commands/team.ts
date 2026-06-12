import * as fs from "node:fs/promises";
import chalk from "chalk";
import { PlanSchema, normalizePlanShape, parseYaml } from "../agent/plan";
import {
  readWorkflowState,
  readWorkflowStateStrict,
  writeWorkflowState,
  acquireWorkflowRunLock,
  type WorkflowState,
} from "../agent/state";
import { runAgentLoop } from "../agent/engine";
import { maybeCompact } from "../agent/compaction";
import { catalogMetadata } from "../ai";
import { readGlobalConfig } from "../agent/state";
import {
  defaultSubagentRole,
  getSubagentRole,
  resolveSubagentModel,
  resolveSubagentMaxSteps,
  subagentSystemPrompt,
  subagentToolset,
  subagentRoleIds,
  validateSubagentDoneReason,
} from "../agent/subagents";
import type { Message } from "../agent/loop";
import { loadProjectContext, withProjectContext } from "../agent/context-files";
import { categoryBadge } from "../tui/components/category-index";

export type RalphStreamKind = "step" | "complete" | "error";

export interface RalphRenderOptions {
  color?: boolean;
  indexed?: boolean;
}

export function formatRalphTodoGuide(
  tasks: string[],
  activeIndex = 0,
  completed: readonly string[] = [],
  opts: RalphRenderOptions = {},
): string[] {
  const done = new Set(completed);
  const color = opts.color === true;
  const badge = opts.indexed || color ? `${categoryBadge("subagent", { color })} ` : "";
  const green = color ? chalk.green.bold : (s: string) => s;
  const yellow = color ? chalk.yellow.bold : (s: string) => s;
  const gray = color ? chalk.gray : (s: string) => s;
  const lines = [
    `${badge || "[RALPH] " }Subagent guidance: follow todos in order; stream every step, complete, and error event.`,
  ];
  tasks.forEach((task, index) => {
    const mark = done.has(task) ? green("x") : index === activeIndex ? yellow(">") : gray(" ");
    lines.push(`[TODO] ${index + 1}/${tasks.length} [${mark}] ${task}`);
  });
  return lines;
}

export function formatRalphStreamEvent(kind: RalphStreamKind, message: string, opts: RalphRenderOptions = {}): string {
  const label = kind === "complete" ? "complete" : kind === "error" ? "error" : "step";
  if (!opts.color && !opts.indexed) return `  └─ stream:${label} ${message}`;
  const color = opts.color === true;
  const badge = `${categoryBadge("subagent", { color })} `;
  const tint = color
    ? kind === "complete"
      ? chalk.green.bold
      : kind === "error"
        ? chalk.red.bold
        : chalk.cyan.bold
    : (s: string) => s;
  return `  ${badge}${tint(`stream:${label}`)} ${message}`;
}

export interface RalphSubagentPromptContext {
  task: string;
  tasks: string[];
  activeIndex: number;
  completed?: readonly string[];
}

export function buildRalphSubagentPrompt(ctx: RalphSubagentPromptContext): string {
  const guide = formatRalphTodoGuide(ctx.tasks, ctx.activeIndex, ctx.completed ?? []).join("\n");
  return [
    "You are an ooo ralph subagent executing one todo from an immutable plan.",
    "",
    guide,
    "",
    `Current todo: ${ctx.activeIndex + 1}/${ctx.tasks.length} "${ctx.task}"`,
    "",
    "Rules:",
    "- Execute ONLY the current [>] todo; do not skip ahead or rewrite the todo list.",
    "- Treat completed [x] todos as context only; do not redo them unless required to verify this todo.",
    "- Use tools in small steps and verify the current todo before calling done.",
    "- The caller streams your lifecycle as stream:step, stream:complete, and stream:error; keep done.reason concise.",
  ].join("\n");
}

export function activeStepIndex(totalTasks: number, pendingTasks: readonly string[] | undefined): number {
  if (totalTasks <= 0) return 0;
  const pending = pendingTasks?.length ?? totalTasks;
  return Math.max(0, Math.min(totalTasks - pending, totalTasks - 1));
}

const ARCHITECT_STATUS_VALUES = new Set(["CLEAR", "WATCH", "BLOCK"]);
const ARCHITECT_REVIEW_VALUES = new Set(["APPROVE", "COMMENT", "REQUEST CHANGES"]);

function extractLineValue(reason: string, label: string): string | undefined {
  // Strip leading/trailing markdown emphasis/quoting/heading chars so the gate
  // accepts e.g. `**Architectural Status:** CLEAR` or `> Architectural Status: CLEAR`.
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const rawLine of reason.split(/\r?\n/)) {
    const stripped = rawLine.replace(/[*_`>#]+/g, "").trim();
    const m = stripped.match(new RegExp(`^${escaped}\\s*:\\s*(.+)$`, "i"));
    if (m) return m[1]!.trim();
  }
  return undefined;
}

function normalizeArchitectVerdict(raw: string): string {
  // Drop trailing `(caveats)` or `- comments`; collapse whitespace; uppercase.
  return raw.split(/\s*[(\-—–]/, 1)[0]!.replace(/\s+/g, " ").trim().toUpperCase();
}

export function parseRoleGateVerdict(roleId: string, reason: string): { ok: boolean; message?: string } {
  const trimmed = reason.trim();
  if (roleId === "architect") {
    const statusRaw = extractLineValue(trimmed, "Architectural Status");
    const reviewRaw = extractLineValue(trimmed, "Code Review Recommendation");
    if (!statusRaw || !reviewRaw) {
      return { ok: false, message: "architect report missing Architectural Status or Code Review Recommendation" };
    }
    const status = normalizeArchitectVerdict(statusRaw);
    const review = normalizeArchitectVerdict(reviewRaw);
    if (!ARCHITECT_STATUS_VALUES.has(status)) {
      return { ok: false, message: `architect Architectural Status invalid (expected CLEAR|WATCH|BLOCK, got ${JSON.stringify(statusRaw)})` };
    }
    if (!ARCHITECT_REVIEW_VALUES.has(review)) {
      return { ok: false, message: `architect Code Review Recommendation invalid (expected APPROVE|COMMENT|REQUEST CHANGES, got ${JSON.stringify(reviewRaw)})` };
    }
    if (status === "BLOCK" || review === "REQUEST CHANGES") {
      return { ok: false, message: `architect gated execution (${status} / ${review})` };
    }
    return { ok: true };
  }
  if (roleId === "critic") {
    // Fail-closed: only an explicit [OKAY] first line approves. Anything else
    // (malformed, missing verdict, wrong case) gates so a buggy/spoofed reason
    // cannot silently pass review.
    const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "";
    if (firstLine === "[OKAY]") return { ok: true };
    if (firstLine === "[REJECT]" || firstLine === "[ITERATE]") {
      return { ok: false, message: `critic gated execution (${firstLine})` };
    }
    return { ok: false, message: `critic verdict missing or malformed (expected [OKAY]|[ITERATE]|[REJECT], got ${JSON.stringify(firstLine.slice(0, 40))})` };
  }
  return { ok: true };
}


export interface TeamEngineOptions {
  cwd?: string;
  signal?: AbortSignal;
  onProgress?: (e: { skill: string; phase: string; detail?: string }) => void;
  io?: {
    output?: (line: string) => void;
  };
}

export async function runTeamEngine(opts: TeamEngineOptions = {}): Promise<{ ok: boolean; reason?: string }> {
  const cwd = opts.cwd ?? process.cwd();

  const log = (msg?: any) => {
    const str = msg !== undefined ? String(msg) : "";
    if (opts.io?.output) {
      const lines = str.split("\n");
      for (const line of lines) {
        opts.io.output(line);
      }
    } else {
      console.log(str);
    }
  };

  if (opts.onProgress) {
    opts.onProgress({ skill: "team", phase: "start" });
  }

  if (opts.signal?.aborted) {
    return { ok: false, reason: "aborted" };
  }

  // Read ralplan state
  const planState = await readWorkflowState("ralplan", cwd);
  if (!planState || planState.current_phase !== "complete" || !planState.plan_path) {
    log(
      `[ERROR] No completed plan found. Please run 'jeo ralplan' to generate a plan first.`
    );
    return { ok: false, reason: "No completed plan found" };
  }

  if (!planState.approved) {
    log(
      `[ERROR] Plan is not approved. Please approve the plan before executing.`
    );
    return { ok: false, reason: "Plan is not approved" };
  }

  const planPath = planState.plan_path;
  log(`\n=== Starting Team Execution Stage ===`);
  log(`Reading plan from: ${planPath}`);

  let planContent = "";
  try {
    planContent = await fs.readFile(planPath, "utf-8");
  } catch (err: any) {
    log(`[ERROR] Failed to read plan file: ${err.message}`);
    return { ok: false, reason: err.message };
  }

  let rawPlan: any;
  try {
    rawPlan = parseYaml(planContent);
  } catch (err: any) {
    log(`[ERROR] Failed to parse plan YAML: ${err.message}`);
    return { ok: false, reason: err.message };
  }

  const parsed = PlanSchema.safeParse(normalizePlanShape(rawPlan));
  if (!parsed.success) {
    const shape = Array.isArray(rawPlan) ? "a top-level list" : typeof rawPlan;
    log(
      `[ERROR] The plan is not in the expected shape — it needs a top-level object with a 'steps:' list ` +
      `(each step: { name, role?, ... }), but the plan file is ${shape}.\n` +
      `  The planning model likely produced malformed YAML. Review ${planPath} or re-run 'jeo ralplan' (with a more capable model).`
    );
    return { ok: false, reason: "Plan is not in the expected shape" };
  }

  const teamCfg = await readGlobalConfig();
  const unknownRoles = parsed.data.steps
    .map(step => step.role?.trim())
    .filter((role): role is string => !!role && !getSubagentRole(role, teamCfg));
  if (unknownRoles.length > 0) {
    const unique = [...new Set(unknownRoles)];
    log(
      `[ERROR] Plan references unknown subagent role(s): ${unique.join(", ")}. ` +
      `Known roles: ${subagentRoleIds(teamCfg).join(", ")}. Fix ${planPath} or re-run 'jeo ralplan'.`
    );
    return { ok: false, reason: "Plan references unknown subagent role(s)" };
  }

  const tasks = parsed.data.steps.map(step => step.name);
  const roleByIndex = parsed.data.steps.map(step => getSubagentRole(step.role, teamCfg)?.id);

  log(`Loaded ${tasks.length} tasks for execution.`);

  // Round-8 (architect ref 7-Round7Workflow): cross-process run lock — two
  // concurrent `jeo team` runs would each pop pending_tasks[0] and last-writer-
  // wins the state file (tasks executed twice, completions lost).
  let releaseLock: () => Promise<void>;
  try {
    releaseLock = await acquireWorkflowRunLock("team", cwd);
  } catch (err: any) {
    log(`[ERROR] ${err.message}`);
    return { ok: false, reason: "another team run holds the lock" };
  }
  try {
    let teamState: WorkflowState;
    try {
      teamState = (await readWorkflowStateStrict("team", cwd)) ?? {
        active: true,
        current_phase: "executing",
        skill: "team" as const,
        slug: planState.slug,
        plan_path: planPath,
        completed_tasks: [],
        pending_tasks: [...tasks],
      };
    } catch {
      log(
        `[ERROR] .jeo/state/team-state.json is corrupt. Fix or delete it before re-running 'jeo team' ` +
        `(refusing to silently restart and re-run already-completed tasks).`,
      );
      return { ok: false, reason: "team-state.json is corrupt" };
    }

    // Round-7 #1 (architect ref 7-Round7Workflow): a team-state left over from a
    // PREVIOUS plan must never be reused — pending=[] from plan A would make plan B
    // no-op into a false "all executed" success, and a mid-flight leftover would run
    // plan-A task text under plan-B roles. A different plan reinitializes execution.
    if (teamState.plan_path !== planPath || teamState.slug !== planState.slug) {
      log(`${categoryBadge("progress")} New plan detected (${planPath}) — restarting execution from its task list.`);
      teamState = {
        active: true,
        current_phase: "executing",
        skill: "team" as const,
        slug: planState.slug,
        plan_path: planPath,
        completed_tasks: [],
        pending_tasks: [...tasks],
      };
    }

    // Round-8: a previous run halted on a task — its partial edits may still be
    // on disk. Warn loudly before re-running on top of them, then clear the marker.
    if (teamState.current_phase === "failed" && teamState.failed_task) {
      log(
        `[WARN] The previous run FAILED on "${teamState.failed_task}" and may have left partial edits on disk. ` +
        `Review the working tree before trusting this re-run — executing the task again on top of partial work can duplicate changes.`,
      );
      teamState.current_phase = "executing";
      delete teamState.failed_task;
    }

    await writeWorkflowState("team", teamState, cwd);
    const renderOpts: RalphRenderOptions = { color: !!process.stdout.isTTY, indexed: true };
    for (const line of formatRalphTodoGuide(tasks, activeStepIndex(tasks.length, teamState.pending_tasks), teamState.completed_tasks ?? [], renderOpts)) log(line);

    while (teamState.pending_tasks && teamState.pending_tasks.length > 0) {
      if (opts.signal?.aborted) {
        return { ok: false, reason: "aborted" };
      }

      const currentTask = teamState.pending_tasks[0];
      log(`\n${categoryBadge("progress")} Current task: "${currentTask}"`);
      const activeIndex = activeStepIndex(tasks.length, teamState.pending_tasks);
      for (const line of formatRalphTodoGuide(tasks, activeIndex, teamState.completed_tasks ?? [], renderOpts)) log(line);

      if (opts.onProgress) {
        opts.onProgress({ skill: "team", phase: "executing", detail: `Current task: ${currentTask}` });
      }

      const success = await executeTaskWithAgent({
        task: currentTask,
        tasks,
        activeIndex,
        completed: teamState.completed_tasks ?? [],
        cwd,
        roleId: roleByIndex[activeIndex],
      });

      if (opts.signal?.aborted) {
        return { ok: false, reason: "aborted" };
      }

      if (success) {
        teamState.completed_tasks = [...(teamState.completed_tasks ?? []), currentTask];
        teamState.pending_tasks = teamState.pending_tasks.slice(1);
        await writeWorkflowState("team", teamState, cwd);
        log(`${categoryBadge("done")} Completed: "${currentTask}"`);
      } else {
        // Round-8: persist a failed marker so the NEXT run can warn about the
        // partial edits this halted task may have left behind.
        teamState.current_phase = "failed";
        teamState.failed_task = currentTask;
        await writeWorkflowState("team", teamState, cwd);
        log(`${categoryBadge("error")} Failed on task: "${currentTask}". Halting execution.`);
        return { ok: false, reason: `Failed on task: "${currentTask}"` };
      }
    }

    if (teamState.pending_tasks && teamState.pending_tasks.length === 0) {
      teamState.current_phase = "complete";
      teamState.active = false; // execution finished — the flag must not read as "in progress"
      await writeWorkflowState("team", teamState, cwd);
      log(`\n${categoryBadge("done")} All tasks in the plan executed successfully!`);
      log("Run 'jeo ultragoal' to run verify tests and evaluate metrics.");
      if (opts.onProgress) {
        opts.onProgress({ skill: "team", phase: "complete" });
      }
    }
    return { ok: true };
  } finally {
    await releaseLock();
  }
}

export async function runTeamCommand(): Promise<void> {
  const res = await runTeamEngine();
  if (!res.ok) {
    process.exitCode = 1;
  }
}

async function executeTaskWithAgent(ctx: RalphSubagentPromptContext & { cwd: string; roleId?: string }): Promise<boolean> {
  const config = await readGlobalConfig();
  const role = getSubagentRole(ctx.roleId, config) ?? defaultSubagentRole();
  const renderOpts: RalphRenderOptions = { color: !!process.stdout.isTTY, indexed: true };
  const model = resolveSubagentModel(role.id, config);
  const maxSteps = resolveSubagentMaxSteps(role.id, config);
  console.log(`  └─ Subagent: ${role.title} · model ${model} · ≤${maxSteps} steps`);

  const contextTokens = catalogMetadata(model)?.contextTokens;

  const projectContext = await loadProjectContext(ctx.cwd);
  const history: Message[] = [
    { role: "system", content: withProjectContext(subagentSystemPrompt(role), projectContext) },
    { role: "user", content: buildRalphSubagentPrompt(ctx) },
  ];

  try {
    await maybeCompact(history, { model, contextTokens });
  } catch (err) {
    // LLM summary failure does not halt team
  }

  let mutationsOk = 0; // round-8 parent audit: successful write/edit/bash count
  const result = await runAgentLoop(history, {
    cwd: ctx.cwd,
    model,
    maxSteps,
    // Bounded delegation: ralph/team subagents keep an exact step contract; the
    // orchestrator owns retries, so the gjc step-extension flow is disabled here.
    budget: { maxExtensions: 0 },
    tools: subagentToolset(role),
    events: {
      onAssistant: (_raw, invocation) => {
        if (!invocation) {
          console.log(formatRalphStreamEvent("error", "invalid tool-call json; retrying", renderOpts));
        } else if (invocation.tool !== "done") {
          console.log(formatRalphStreamEvent("step", `tool ${invocation.tool} requested`, renderOpts));
        }
      },
      onStep: async step => {
        console.log(formatRalphStreamEvent("step", `${role.title} thinking ${step}/${maxSteps}`, renderOpts));
        try {
          await maybeCompact(history, { model, contextTokens });
        } catch (err) {
          // LLM summary failure does not halt team
        }
      },
      onToolResult: (tool, ok) => {
        if (ok && (tool === "write" || tool === "edit" || tool === "bash")) mutationsOk++;
        console.log(formatRalphStreamEvent(ok ? "complete" : "error", `tool ${tool}`, renderOpts));
      },
      onNotice: msg => console.log(formatRalphStreamEvent("step", msg, renderOpts)),
    },
  });

  const reason = result.doneReason?.trim() || `${role.title} did not converge within ${result.steps} steps`;
  if (!result.done) {
    console.log(formatRalphStreamEvent("error", reason, renderOpts));
    return false;
  }

  const contract = validateSubagentDoneReason(role, reason);
  if (!contract.ok) {
    console.log(formatRalphStreamEvent("error", `${role.title} report incomplete: missing ${contract.missing?.join(", ")}`, renderOpts));
    return false;
  }

  const gate = parseRoleGateVerdict(role.id, reason);
  if (!gate.ok) {
    console.log(formatRalphStreamEvent("error", gate.message ?? `${role.title} blocked execution`, renderOpts));
    return false;
  }

  if (!role.readOnly && mutationsOk === 0) {
    // Round-8: a mutating role finished without ONE successful mutation — the
    // task may be legitimately read-only, but its "Changed Files:" claim is
    // unverified; warn instead of silently trusting the report.
    console.log(formatRalphStreamEvent("error", `${role.title} completed WITHOUT any successful write/edit/bash — treat its changed-files claim as unverified.`, renderOpts));
  }
  console.log(formatRalphStreamEvent("complete", `${role.title} finished task`, renderOpts));
  return true;
}
