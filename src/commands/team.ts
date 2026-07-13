import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import chalk from "chalk";
import { PlanSchema, normalizePlanShape, parseYaml } from "../agent/plan";
import {
  readWorkflowState,
  readWorkflowStateStrict,
  writeWorkflowState,
  acquireWorkflowRunLock,
  type WorkflowState,
  type Config,
} from "../agent/state";
import { runSubagentOnce, type SubagentRunResult } from "../agent/task-tool";
import { SubagentRegistry } from "../agent/subagent-registry";
import { gitDirtyCount, resolveWorktree } from "./launch/tmux";
import { readGlobalConfig } from "../agent/state";
import {
  defaultSubagentRole,
  getSubagentRole,
  resolveSubagentModel,
  resolveSubagentMaxSteps,
  subagentRoleIds,
  type SubagentRole,
} from "../agent/subagents";
import { loadProjectContext } from "../agent/context-files";
import { categoryBadge } from "../tui/components/category-index";

export type RalphStreamKind = "step" | "complete" | "error" | "warn";

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

const STREAM_TINTS = {
  complete: chalk.green.bold,
  error: chalk.red.bold,
  warn: chalk.yellow.bold,
  step: chalk.cyan.bold,
} satisfies Record<RalphStreamKind, (s: string) => string>;

export function formatRalphStreamEvent(kind: RalphStreamKind, message: string, opts: RalphRenderOptions = {}): string {
  // ponytail: the label is always the kind itself — no mapping table needed.
  if (!opts.color && !opts.indexed) return `  └─ stream:${kind} ${message}`;
  const color = opts.color === true;
  const badge = `${categoryBadge("subagent", { color })} `;
  const tint = color ? STREAM_TINTS[kind] : (s: string) => s;
  return `  ${badge}${tint(`stream:${kind}`)} ${message}`;
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
  /** When true, a mutating role that finishes WITHOUT any successful
   *  write/edit/bash fails the task instead of merely warning (round-11). */
  strictMutations?: boolean;
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

  // Round-13: verify the plan's hash matches the consensus hash to prevent silent edits after approval
  if (planState.consensus_hash) {
    const currentHash = createHash("sha256").update(planContent).digest("hex");
    if (currentHash !== planState.consensus_hash) {
      log(
        `[ERROR] Plan file has been modified since it was reviewed by the consensus critic.\n` +
        `  Re-run 'jeo ralplan' to let the critic review the updated plan, then approve and execute again.`
      );
      return { ok: false, reason: "Plan file modified since consensus review" };
    }
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
    // on disk. Round-12: instead of a speculative warning, probe the working tree
    // with `git status --porcelain` and report the CONCRETE uncommitted count so
    // the user knows whether real partial work is present before re-running on it.
    if (teamState.current_phase === "failed" && teamState.failed_task) {
      const dirty = gitDirtyCount(cwd);
      const treeNote = dirty === undefined
        ? `The working tree could not be inspected (not a git repo or git unavailable) — review it manually before trusting this re-run.`
        : dirty > 0
          ? `git reports ${dirty} uncommitted change(s) — these may include partial edits from the halted task; review (e.g. 'git status', 'git diff') before re-running, as executing the task again on top of partial work can duplicate changes.`
          : `git reports a clean working tree — no partial edits from the halted task remain on disk, so this re-run starts from a known state.`;
      log(`[WARN] The previous run FAILED on "${teamState.failed_task}". ${treeNote}`);
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

      const activeIndex = activeStepIndex(tasks.length, teamState.pending_tasks);
      // Guide printed once above; per-task lines convey progress. No per-iteration
      // reprint — it was O(N²) lines, climbing the embedded-terminal renderer's CPU.

      // Look ahead from the current position: if this step's `parallel_group`
      // extends into one or more of the NEXT pending steps (the group's full
      // contiguous run is, by construction, always still all-pending here —
      // `activeIndex` is derived from how many tasks remain), dispatch the WHOLE
      // group concurrently. A group of size 1 (no group, or a lone member) falls
      // straight through to the existing serial path, unchanged.
      const groupVal = parsed.data.steps[activeIndex]?.parallel_group?.trim() || undefined;
      const groupIndices = [activeIndex];
      if (groupVal) {
        let i = activeIndex + 1;
        while (i < tasks.length && (parsed.data.steps[i]?.parallel_group?.trim() || undefined) === groupVal) {
          groupIndices.push(i);
          i++;
        }
      }

      if (groupIndices.length > 1) {
        const groupSteps = groupIndices.map(i => ({ index: i, name: tasks[i]!, roleId: roleByIndex[i] }));
        log(`\n${categoryBadge("progress")} Current parallel group "${groupVal}": ${groupSteps.map(s => `"${s.name}"`).join(", ")}`);
        if (opts.onProgress) {
          opts.onProgress({ skill: "team", phase: "executing", detail: `Current parallel group: ${groupSteps.map(s => s.name).join(", ")}` });
        }

        const groupResult = await runParallelGroup(groupSteps, {
          cwd,
          teamCfg,
          tasks,
          completed: teamState.completed_tasks ?? [],
          strictMutations: opts.strictMutations ?? false,
          log,
          slug: planState.slug ?? teamState.slug ?? "team",
        });

        if (opts.signal?.aborted) {
          return { ok: false, reason: "aborted" };
        }

        if (groupResult.ok) {
          teamState.completed_tasks = [...(teamState.completed_tasks ?? []), ...groupSteps.map(s => s.name)];
          teamState.pending_tasks = teamState.pending_tasks.slice(groupSteps.length);
          await writeWorkflowState("team", teamState, cwd);
          log(`${categoryBadge("done")} Completed parallel group: ${groupSteps.map(s => `"${s.name}"`).join(", ")}`);
        } else {
          teamState.current_phase = "failed";
          teamState.failed_task = groupResult.failedTaskName;
          await writeWorkflowState("team", teamState, cwd);
          log(`${categoryBadge("error")} Failed on parallel group step: "${groupResult.failedTaskName}". Halting execution.`);
          return { ok: false, reason: `Failed on task: "${groupResult.failedTaskName}"` };
        }
        continue;
      }

      const currentTask = teamState.pending_tasks[0];
      log(`\n${categoryBadge("progress")} Current task: "${currentTask}"`);

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
        strictMutations: opts.strictMutations ?? false,
        log,
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

export async function runTeamCommand(args: string[] = []): Promise<void> {
  const strictMutations = args.includes("--strict-mutations") || args.includes("--strict");
  const res = await runTeamEngine({ strictMutations });
  if (!res.ok) {
    process.exitCode = 1;
  }
}

async function executeTaskWithAgent(ctx: RalphSubagentPromptContext & { cwd: string; roleId?: string; strictMutations?: boolean; log: (line: string) => void }): Promise<boolean> {
  const log = ctx.log;
  const config = await readGlobalConfig();
  const role = getSubagentRole(ctx.roleId, config) ?? defaultSubagentRole();
  const renderOpts: RalphRenderOptions = { color: !!process.stdout.isTTY, indexed: true };
  const model = resolveSubagentModel(role.id, config);
  const maxSteps = resolveSubagentMaxSteps(role.id, config);
  log(`  └─ Subagent: ${role.title} · model ${model} · ≤${maxSteps} steps`);

  const projectContext = await loadProjectContext(ctx.cwd);

  // `jeo team` now runs every step through the SAME execution core as the `task`/
  // `subagent` tools (`runSubagentOnce`) — one way a jeo-code subagent runs,
  // whether launched interactively, in a fan-out batch, detached, or as a team
  // plan step. This gets team plan steps the same fenced-report protection
  // (prompt-injection-safe) and done-reason contract validation the interactive
  // tools already had, instead of a second hand-rolled copy of that logic.
  const result = await runSubagentOnce(role, buildRalphSubagentPrompt(ctx), "", ctx.cwd, {
    config,
    projectContext,
    onEvent: ev => {
      if (ev.kind === "step") {
        log(formatRalphStreamEvent("step", ev.detail ?? `${role.title} thinking ${ev.step ?? "?"}/${ev.maxSteps ?? maxSteps}`, renderOpts));
      } else if (ev.kind === "tool") {
        const suffix = ev.summary ? ` — ${ev.summary}` : "";
        log(formatRalphStreamEvent(ev.success ? "complete" : "error", `tool ${ev.detail}${suffix}`, renderOpts));
      }
    },
  });

  return evaluateSubagentResult(result, role, ctx.strictMutations ?? false, log, renderOpts);
}

/**
 * Shared pass/fail verdict for ONE subagent's `SubagentRunResult`: contract
 * failure, role-gate rejection (architect BLOCK / critic REQUEST CHANGES), and
 * `--strict-mutations` hard-fail. Used by BOTH the serial path
 * (`executeTaskWithAgent`) and the parallel-group path (`runParallelGroup`) so
 * the two never diverge on what counts as a passing step.
 */
function evaluateSubagentResult(
  result: SubagentRunResult,
  role: SubagentRole,
  strictMutations: boolean,
  log: (line: string) => void,
  renderOpts: RalphRenderOptions,
): boolean {
  if (!result.success) {
    log(formatRalphStreamEvent("error", result.error || result.output, renderOpts));
    return false;
  }

  // Role gate verdict (architect BLOCK / critic REQUEST CHANGES) is parsed from the
  // subagent's RAW done reason, not the fenced/wrapped report text around it.
  const gate = parseRoleGateVerdict(role.id, result.doneReason);
  if (!gate.ok) {
    log(formatRalphStreamEvent("error", gate.message ?? `${role.title} blocked execution`, renderOpts));
    return false;
  }

  // Evidence gate (UNCONDITIONAL — same tier as parseRoleGateVerdict, never
  // softened by --strict-mutations): an architect/critic verdict is worthless
  // if the subagent never actually looked at anything. Mirrors goal-verifier.ts's
  // applyEvidenceGate philosophy applied to the OTHER independent-verifier gate
  // in this codebase — a formatted "Architectural Status: CLEAR" or "[OKAY]"
  // first line is text the model can emit with ZERO real inspection; only an
  // OBSERVED read/search/find/ast_grep/lsp call in this run counts as evidence
  // the verdict is grounded in the actual repository state, not the model's own
  // unverified assertion (2026 pattern: "avoid vibes verification — a claim is
  // only trustworthy when backed by a programmatic, observed signal").
  if ((role.id === "architect" || role.id === "critic") && result.readOnlyEvidenceCalls === 0) {
    log(formatRalphStreamEvent(
      "error",
      `${role.title} returned a verdict with ZERO observed read/search/find/ast_grep/lsp calls — an unevidenced verdict is not trustworthy regardless of what the text claims. Blocking.`,
      renderOpts,
    ));
    return false;
  }

  // Round-8: a mutating role finished without a successful file mutation — the
  // task may be legitimately read-only, but its "Changed Files:" claim is
  // unverified. bash is tracked apart: an only-bash run MIGHT have mutated.
  if (!role.readOnly && result.fileMutations === 0) {
    const msg = result.bashRuns === 0
      ? `${role.title} completed WITHOUT any successful write/edit/bash — treat its changed-files claim as unverified.`
      : `${role.title} completed with only bash (no write/edit) — verify its changed-files claim independently.`;
    // Round-11: under --strict-mutations, a mutating role that took NO action at
    // all (no write/edit/bash) is a hard failure — an empty run must not pass as
    // a completed task. bash-only stays advisory to avoid penalizing shell edits.
    const hardFail = strictMutations && result.bashRuns === 0;
    // Round-12: separate the tones so a passing advisory run doesn't masquerade
    // as a stream:error — only a real hard-fail is red; an advisory note is warn.
    log(formatRalphStreamEvent(hardFail ? "error" : "warn", msg, renderOpts));
    if (hardFail) {
      return false;
    }
  }

  // Surface the subagent's full report (header + step trace + fenced reason +
  // mutation audit) — not just a "finished" status.
  log(formatRalphStreamEvent("complete", `${role.title} finished task`, renderOpts));
  log(`\n${role.title} report:`);
  log(result.output); // log() already splits multi-line strings across the io.output sink

  return true;
}

/** One step of a dispatched parallel group, resolved to its plan position + role. */
interface ParallelGroupStep {
  index: number;
  name: string;
  roleId?: string;
}

/** Per-step worktree + branch resolved for a dispatched parallel group. */
interface ParallelWorktree {
  path: string;
  branch: string;
}

function runGitSync(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const res = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: res.exitCode === 0, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
}

/**
 * Execute a CONTIGUOUS run of `parallel_group`-marked plan steps concurrently,
 * each in its own git worktree via `resolveWorktree` + the SAME
 * `SubagentRegistry`/`runSubagentOnce` core the serial path and the `task`/
 * `subagent` tools use. On full success, each worker's committed branch is
 * merged back into `cwd`'s current branch IN ARRAY ORDER; any failure or merge
 * conflict stops processing immediately and leaves the remaining
 * worktrees/branches in place for manual inspection — nothing is ever silently
 * resolved or discarded.
 */
async function runParallelGroup(
  group: ParallelGroupStep[],
  ctx: {
    cwd: string;
    teamCfg: Config;
    tasks: string[];
    completed: readonly string[];
    strictMutations: boolean;
    log: (line: string) => void;
    slug: string;
  },
): Promise<{ ok: true } | { ok: false; failedTaskName: string }> {
  const { cwd, teamCfg, tasks, completed, strictMutations, log, slug } = ctx;
  const renderOpts: RalphRenderOptions = { color: !!process.stdout.isTTY, indexed: true };

  const registry = new SubagentRegistry();
  const resultsByIndex = new Map<number, SubagentRunResult>();
  const idByIndex = new Map<number, string>();
  const roleByStepIndex = new Map<number, SubagentRole>();
  const worktreeByIndex = new Map<number, ParallelWorktree>();

  log(`\n${categoryBadge("progress")} Dispatching parallel group of ${group.length} steps concurrently: ${group.map(s => `"${s.name}"`).join(", ")}`);

  for (const step of group) {
    const worktreePath = path.join(cwd, ".jeo", "team-worktrees", `${slug}-${step.index}`);
    const resolvedPath = resolveWorktree(cwd, worktreePath);
    const branchRes = runGitSync(resolvedPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = branchRes.stdout.trim();
    worktreeByIndex.set(step.index, { path: resolvedPath, branch });

    const role = getSubagentRole(step.roleId, teamCfg) ?? defaultSubagentRole();
    roleByStepIndex.set(step.index, role);
    const model = resolveSubagentModel(role.id, teamCfg);
    const maxSteps = resolveSubagentMaxSteps(role.id, teamCfg);
    log(`  └─ [${step.name}] Subagent: ${role.title} · model ${model} · ≤${maxSteps} steps · worktree ${resolvedPath} (branch ${branch})`);

    // Loaded PER WORKTREE (its own file tree) — never shared across concurrent workers.
    const projectContext = await loadProjectContext(resolvedPath);
    const promptCtx: RalphSubagentPromptContext = { task: step.name, tasks, activeIndex: step.index, completed };
    const taskText = buildRalphSubagentPrompt(promptCtx);

    const record = registry.launch(role.id, step.name, async (signal) => {
      const result = await runSubagentOnce(role, taskText, "", resolvedPath, {
        config: teamCfg,
        signal,
        projectContext,
        onEvent: ev => {
          if (ev.kind === "step") {
            log(formatRalphStreamEvent("step", `[${step.name}] ${ev.detail ?? `${role.title} thinking ${ev.step ?? "?"}/${ev.maxSteps ?? maxSteps}`}`, renderOpts));
          } else if (ev.kind === "tool") {
            const suffix = ev.summary ? ` — ${ev.summary}` : "";
            log(formatRalphStreamEvent(ev.success ? "complete" : "error", `[${step.name}] tool ${ev.detail}${suffix}`, renderOpts));
          }
        },
      });
      // Capture the FULL SubagentRunResult (doneReason/fileMutations/etc.) before
      // collapsing it to the plain ToolResult shape SubagentRegistry stores.
      resultsByIndex.set(step.index, result);
      return { success: result.success, output: result.output, error: result.error };
    });
    idByIndex.set(step.index, record.id);
  }

  // No timeout — team runs can take as long as needed.
  await registry.awaitIds([...idByIndex.values()]);

  // Evaluate + commit each successful worktree, IN ARRAY ORDER (not completion
  // order). Any failure stops the whole group immediately: no merges happen,
  // and every worktree/branch is left exactly as it is for inspection.
  for (const step of group) {
    const result = resultsByIndex.get(step.index);
    const role = roleByStepIndex.get(step.index)!;
    const wt = worktreeByIndex.get(step.index)!;
    if (!result) {
      log(formatRalphStreamEvent("error", `[${step.name}] subagent produced no result`, renderOpts));
      return { ok: false, failedTaskName: step.name };
    }
    const success = evaluateSubagentResult(result, role, strictMutations, log, renderOpts);
    if (!success) {
      log(`${categoryBadge("error")} Parallel group step "${step.name}" failed — its worktree (${wt.path}) and the OTHER group worktrees are left in place for inspection; nothing was merged.`);
      return { ok: false, failedTaskName: step.name };
    }
    // An empty diff (read-only role, or a no-op) needs no commit — skip it for
    // the merge step below without treating it as an error.
    if (gitDirtyCount(wt.path)) {
      const add = runGitSync(wt.path, ["add", "-A"]);
      if (!add.ok) {
        log(`${categoryBadge("error")} Failed to stage changes in worktree ${wt.path} for step "${step.name}": ${add.stderr.trim()}`);
        return { ok: false, failedTaskName: step.name };
      }
      const commit = runGitSync(wt.path, ["commit", "-m", step.name]);
      if (!commit.ok) {
        log(`${categoryBadge("error")} Failed to commit changes in worktree ${wt.path} for step "${step.name}": ${commit.stderr.trim()}`);
        return { ok: false, failedTaskName: step.name };
      }
    }
  }

  // All group steps succeeded — merge each worker branch back, IN ARRAY ORDER.
  // A conflict aborts the merge immediately (never auto-resolved) and stops the
  // rest of the group's merges.
  for (const step of group) {
    const wt = worktreeByIndex.get(step.index)!;
    const merge = runGitSync(cwd, ["merge", "--no-ff", wt.branch, "-m", `merge: ${step.name}`]);
    if (!merge.ok) {
      runGitSync(cwd, ["merge", "--abort"]);
      log(
        `${categoryBadge("error")} Merge conflict merging step "${step.name}"'s branch "${wt.branch}" into the current branch — ` +
        `the merge was aborted automatically (no changes were auto-resolved). Resolve manually: ` +
        `cd ${wt.path} to inspect the change, then run 'git merge ${wt.branch}' yourself from ${cwd}.\n${(merge.stderr + merge.stdout).trim()}`,
      );
      return { ok: false, failedTaskName: step.name };
    }
    log(`${categoryBadge("done")} Merged step "${step.name}" (branch ${wt.branch}) into the current branch.`);
  }

  // Fully successful group — clean up worktrees best-effort (a removal failure,
  // e.g. stray untracked files, is a warning, never a hard failure of the run).
  for (const step of group) {
    const wt = worktreeByIndex.get(step.index)!;
    const removal = runGitSync(cwd, ["worktree", "remove", wt.path]);
    if (!removal.ok) {
      log(`[WARN] Could not remove worktree ${wt.path} for step "${step.name}": ${removal.stderr.trim()}`);
    }
  }

  return { ok: true };
}
