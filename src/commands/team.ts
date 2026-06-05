import * as fs from "node:fs/promises";
import { z } from "zod";
import {
  readWorkflowState,
  writeWorkflowState,
} from "../agent/state";
import { runAgentLoop, executorSystemPrompt } from "../agent/engine";
import type { Message } from "../agent/loop";

export async function runTeamCommand(): Promise<void> {
  const cwd = process.cwd();

  // Read ralplan state
  const planState = await readWorkflowState("ralplan", cwd);
  if (!planState || planState.current_phase !== "complete" || !planState.plan_path) {
    console.log(
      `[ERROR] No completed plan found. Please run 'joc ralplan' to generate a plan first.`
    );
    return;
  }

  if (!planState.approved) {
    console.log(
      `[ERROR] Plan is not approved. Please approve the plan before executing.`
    );
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
    return;
  }

  let rawPlan: any;
  try {
    rawPlan = parseYaml(planContent);
  } catch (err: any) {
    console.log(`[ERROR] Failed to parse plan YAML: ${err.message}`);
    return;
  }

  const parsed = PlanSchema.safeParse(rawPlan);
  if (!parsed.success) {
    console.log(`[ERROR] Plan validation failed: ${parsed.error.message}`);
    return;
  }

  const tasks = parsed.data.steps.map(step => step.name);

  console.log(`Loaded ${tasks.length} tasks for execution.`);

  // Initialize team state
  let teamState = await readWorkflowState("team", cwd) || {
    active: true,
    current_phase: "executing",
    skill: "team" as const,
    slug: planState.slug,
    plan_path: planPath,
    completed_tasks: [],
    pending_tasks: [...tasks],
  };

  await writeWorkflowState("team", teamState, cwd);

  while (teamState.pending_tasks && teamState.pending_tasks.length > 0) {
    const currentTask = teamState.pending_tasks[0];
    console.log(`\n[TASK] Current: "${currentTask}"`);

    // Run the Executor loop
    const success = await executeTaskWithAgent(currentTask, cwd);
    
    if (success) {
      teamState.completed_tasks = [...(teamState.completed_tasks ?? []), currentTask];
      teamState.pending_tasks = teamState.pending_tasks.slice(1);
      await writeWorkflowState("team", teamState, cwd);
      console.log(`[TASK SUCCESS] Completed: "${currentTask}"`);
    } else {
      console.log(`[TASK FAILED] Failed on task: "${currentTask}". Halting execution.`);
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

async function executeTaskWithAgent(task: string, cwd: string): Promise<boolean> {
  const history: Message[] = [
    { role: "system", content: executorSystemPrompt() },
    { role: "user", content: `Your task is: "${task}"` },
  ];

  const result = await runAgentLoop(history, {
    cwd,
    maxSteps: 15,
    events: {
      onStep: step => console.log(`  └─ Step ${step}: Thinking...`),
      onToolResult: (tool, ok) => console.log(`  └─ Tool [${tool}] → ${ok ? "Success" : "Failed"}`),
      onError: msg => console.log(`  └─ Error in execution step: ${msg}`),
    },
  });

  if (result.done) {
    console.log("  └─ Executor completed the task successfully.");
    return true;
  }
  console.log(`  └─ Did not converge within ${result.steps} steps.`);
  return false;
}
export const StepSchema = z.object({
  name: z.string(),
}).passthrough();

export const PlanSchema = z.object({
  name: z.string(),
  steps: z.array(StepSchema),
}).passthrough();

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
