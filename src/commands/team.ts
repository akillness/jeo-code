import * as fs from "node:fs/promises";
import chalk from "chalk";
import { z } from "zod";
import {
  readWorkflowState,
  readWorkflowStateStrict,
  writeWorkflowState,
  type WorkflowState,
} from "../agent/state";
import { runAgentLoop } from "../agent/engine";
import { readGlobalConfig } from "../agent/state";
import {
  defaultSubagentRole,
  getSubagentRole,
  resolveSubagentModel,
  resolveSubagentMaxSteps,
  subagentSystemPrompt,
  subagentToolset,
  subagentRoleIds,
} from "../agent/subagents";
import type { Message } from "../agent/loop";
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


export async function runTeamCommand(): Promise<void> {
  const cwd = process.cwd();

  // Read ralplan state
  const planState = await readWorkflowState("ralplan", cwd);
  if (!planState || planState.current_phase !== "complete" || !planState.plan_path) {
    console.log(
      `[ERROR] No completed plan found. Please run 'joc ralplan' to generate a plan first.`
    );
    process.exitCode = 1;
    return;
  }

  if (!planState.approved) {
    console.log(
      `[ERROR] Plan is not approved. Please approve the plan before executing.`
    );
    process.exitCode = 1;
    return;
  }

  const planPath = planState.plan_path;
  console.log(`\n=== Starting Team Execution Stage ===`);
  console.log(`Reading plan from: ${planPath}`);

  let planContent = "";
  try {
    planContent = await fs.readFile(planPath, "utf-8");
  } catch (err: any) {
    console.log(`[ERROR] Failed to read plan file: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  let rawPlan: any;
  try {
    rawPlan = parseYaml(planContent);
  } catch (err: any) {
    console.log(`[ERROR] Failed to parse plan YAML: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const parsed = PlanSchema.safeParse(normalizePlanShape(rawPlan));
  if (!parsed.success) {
    const shape = Array.isArray(rawPlan) ? "a top-level list" : typeof rawPlan;
    console.log(
      `[ERROR] The plan is not in the expected shape — it needs a top-level object with a 'steps:' list ` +
      `(each step: { name, role?, ... }), but the plan file is ${shape}.\n` +
      `  The planning model likely produced malformed YAML. Review ${planPath} or re-run 'joc ralplan' (with a more capable model).`
    );
    process.exitCode = 1;
    return;
  }

  const unknownRoles = parsed.data.steps
    .map(step => step.role?.trim())
    .filter((role): role is string => !!role && !getSubagentRole(role));
  if (unknownRoles.length > 0) {
    const unique = [...new Set(unknownRoles)];
    console.log(
      `[ERROR] Plan references unknown subagent role(s): ${unique.join(", ")}. ` +
      `Known roles: ${subagentRoleIds().join(", ")}. Fix ${planPath} or re-run 'joc ralplan'.`
    );
    process.exitCode = 1;
    return;
  }

  const tasks = parsed.data.steps.map(step => step.name);
  // Keep roles by STEP INDEX, not task name: generated plans may contain duplicate
  // names, and those duplicates must still route to their own role.
  const roleByIndex = parsed.data.steps.map(step => getSubagentRole(step.role)?.id);

  console.log(`Loaded ${tasks.length} tasks for execution.`);


  // Initialize team state. Use the STRICT reader so a corrupt team-state.json is a
  // distinct error rather than being treated as "no state" — which would silently
  // re-run already-completed tasks from scratch and lose progress.
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
    console.log(
      `[ERROR] .joc/state/team-state.json is corrupt. Fix or delete it before re-running 'joc team' ` +
      `(refusing to silently restart and re-run already-completed tasks).`,
    );
    process.exitCode = 1;
    return;
  }

  await writeWorkflowState("team", teamState, cwd);
  const renderOpts: RalphRenderOptions = { color: !!process.stdout.isTTY, indexed: true };
  for (const line of formatRalphTodoGuide(tasks, activeStepIndex(tasks.length, teamState.pending_tasks), teamState.completed_tasks ?? [], renderOpts)) console.log(line);

  while (teamState.pending_tasks && teamState.pending_tasks.length > 0) {
    const currentTask = teamState.pending_tasks[0];
    console.log(`\n[TASK] Current: "${currentTask}"`);
    const activeIndex = activeStepIndex(tasks.length, teamState.pending_tasks);
    for (const line of formatRalphTodoGuide(tasks, activeIndex, teamState.completed_tasks ?? [], renderOpts)) console.log(line);

    // Run the Executor loop
    const success = await executeTaskWithAgent({
      task: currentTask,
      tasks,
      activeIndex,
      completed: teamState.completed_tasks ?? [],
      cwd,
      roleId: roleByIndex[activeIndex],
    });
    
    if (success) {
      teamState.completed_tasks = [...(teamState.completed_tasks ?? []), currentTask];
      teamState.pending_tasks = teamState.pending_tasks.slice(1);
      await writeWorkflowState("team", teamState, cwd);
      console.log(`[TASK SUCCESS] Completed: "${currentTask}"`);
    } else {
      console.log(`[TASK FAILED] Failed on task: "${currentTask}". Halting execution.`);
      process.exitCode = 1;
      break;
    }
  }

  if (teamState.pending_tasks && teamState.pending_tasks.length === 0) {
    teamState.current_phase = "complete";
    await writeWorkflowState("team", teamState, cwd);
    console.log("\n[SUCCESS] All tasks in the plan executed successfully!");
    console.log("Run 'joc ultragoal' to run verify tests and evaluate metrics.");
  }
}

async function executeTaskWithAgent(ctx: RalphSubagentPromptContext & { cwd: string; roleId?: string }): Promise<boolean> {
  const config = await readGlobalConfig();
  const role = getSubagentRole(ctx.roleId) ?? defaultSubagentRole();
  const renderOpts: RalphRenderOptions = { color: !!process.stdout.isTTY, indexed: true };
  const model = resolveSubagentModel(role.id, config);
  const maxSteps = resolveSubagentMaxSteps(role.id, config);
  console.log(`  └─ Subagent: ${role.title} · model ${model} · ≤${maxSteps} steps`);

  const history: Message[] = [
    { role: "system", content: subagentSystemPrompt(role) },
    { role: "user", content: buildRalphSubagentPrompt(ctx) },
  ];

  const result = await runAgentLoop(history, {
    cwd: ctx.cwd,
    model,
    maxSteps,
    tools: subagentToolset(role),
    events: {
      onAssistant: (_raw, invocation) => {
        if (!invocation) {
          console.log(formatRalphStreamEvent("error", "invalid tool-call json; retrying", renderOpts));
        } else if (invocation.tool !== "done") {
          console.log(formatRalphStreamEvent("step", `tool ${invocation.tool} requested`, renderOpts));
        }
      },
      onStep: step => console.log(formatRalphStreamEvent("step", `${role.title} thinking ${step}/${maxSteps}`, renderOpts)),
      onToolResult: (tool, ok) => console.log(formatRalphStreamEvent(ok ? "complete" : "error", `tool ${tool}`, renderOpts)),
      onError: msg => console.log(formatRalphStreamEvent("error", msg, renderOpts)),
    },
  });

  if (result.done) {
    console.log(formatRalphStreamEvent("complete", `${role.title} finished task`, renderOpts));
    return true;
  }
  console.log(formatRalphStreamEvent("error", result.doneReason ?? `${role.title} did not converge within ${result.steps} steps`, renderOpts));
  return false;
}
export const StepSchema = z.object({
  name: z.string(),
  /** Optional subagent role for this step (executor/planner/architect/critic). */
  role: z.string().optional(),
}).passthrough();

export const PlanSchema = z.object({
  name: z.string().optional(),
  steps: z.array(StepSchema).min(1),
}).passthrough();

/**
 * Tolerate common planning-model deviations so a valid-enough plan still executes:
 * a top-level list of tasks, a `tasks:` alias for `steps:`, bare-string tasks, and
 * step name under `task`/`title`/`description`/`step`.
 */
export function normalizePlanShape(raw: any): any {
  let plan = raw;
  if (Array.isArray(plan)) plan = { steps: plan };
  if (plan && typeof plan === "object" && !Array.isArray(plan)) {
    if (!Array.isArray(plan.steps) && Array.isArray(plan.tasks)) plan = { ...plan, steps: plan.tasks };
    if (Array.isArray(plan.steps)) {
      plan = {
        ...plan,
        steps: plan.steps.map((s: any) =>
          typeof s === "string"
            ? { name: s }
            : s && typeof s === "object" && !s.name
              ? { ...s, name: s.task ?? s.title ?? s.description ?? s.step ?? "" }
              : s,
        ).filter((s: any) => s && typeof s.name === "string" && s.name.trim() !== ""),
      };
    }
  }
  return plan;
}

function parseValue(v: string): any {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (v === "") return "";
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

export function parseYaml(yamlStr: string): any {
  const lines = yamlStr.split(/\r?\n/).map(line => {
    const commentIdx = line.indexOf('#');
    const cleanLine = commentIdx !== -1 ? line.slice(0, commentIdx) : line;
    return {
      raw: cleanLine,
      trimmed: cleanLine.trim(),
      indent: cleanLine.length - cleanLine.trimStart().length
    };
  }).filter(l => l.trimmed !== '');

  let idx = 0;

  function parseBlock(baseIndent: number): any {
    let result: any = null;
    let isArray = false;

    if (idx < lines.length) {
      if (lines[idx].trimmed.startsWith('-')) {
        isArray = true;
        result = [];
      } else {
        result = {};
      }
    }

    while (idx < lines.length) {
      const line = lines[idx];
      if (line.indent < baseIndent) {
        break;
      }

      if (isArray) {
        if (!line.trimmed.startsWith('-')) {
          if (result.length > 0 && typeof result[result.length - 1] === 'object') {
            const colonIdx = line.trimmed.indexOf(':');
            if (colonIdx !== -1) {
              const k = line.trimmed.slice(0, colonIdx).trim();
              const rawVal = line.trimmed.slice(colonIdx + 1).trim();
              if (rawVal === '') {
                idx++;
                result[result.length - 1][k] = parseBlock(line.indent + 1);
                continue;
              } else {
                result[result.length - 1][k] = parseValue(rawVal);
              }
            } else {
              throw new Error(`Invalid line inside array block: "${line.trimmed}"`);
            }
          } else {
            throw new Error(`Invalid line in array: "${line.trimmed}"`);
          }
          idx++;
          continue;
        }

        const rest = line.trimmed.slice(1).trim();
        if (rest === '') {
          idx++;
          const nested = parseBlock(line.indent + 1);
          result.push(nested);
        } else if (rest.includes(':')) {
          const colonIdx = rest.indexOf(':');
          const k = rest.slice(0, colonIdx).trim();
          const rawVal = rest.slice(colonIdx + 1).trim();
          if (rawVal === '') {
            idx++;
            const nestedObj = { [k]: parseBlock(line.indent + 2) };
            result.push(nestedObj);
          } else {
            const item: any = { [k]: parseValue(rawVal) };
            result.push(item);
            idx++;
            while (idx < lines.length && !lines[idx].trimmed.startsWith('-') && lines[idx].indent >= line.indent + 2) {
              const subLine = lines[idx];
              const subColonIdx = subLine.trimmed.indexOf(':');
              if (subColonIdx !== -1) {
                const subK = subLine.trimmed.slice(0, subColonIdx).trim();
                const rawSubVal = subLine.trimmed.slice(subColonIdx + 1).trim();
                if (rawSubVal === '') {
                  idx++;
                  item[subK] = parseBlock(subLine.indent + 1);
                } else {
                  item[subK] = parseValue(rawSubVal);
                  idx++;
                }
              } else {
                throw new Error(`Invalid sub-line in block mapping: "${subLine.trimmed}"`);
              }
            }
          }
        } else {
          result.push(parseValue(rest));
          idx++;
        }
      } else {
        const colonIdx = line.trimmed.indexOf(':');
        if (colonIdx === -1) {
          throw new Error(`Invalid line: "${line.trimmed}"`);
        }

        const k = line.trimmed.slice(0, colonIdx).trim();
        const rawVal = line.trimmed.slice(colonIdx + 1).trim();

        if (rawVal === '') {
          idx++;
          result[k] = parseBlock(line.indent + 1);
        } else {
          result[k] = parseValue(rawVal);
          idx++;
        }
      }
    }

    return result;
  }

  return parseBlock(0);
}
