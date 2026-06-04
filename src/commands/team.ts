import * as fs from "node:fs/promises";
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

  // Parse tasks from plan YAML
  // Simple YAML parser looking for task names or bullet points
  const tasks: string[] = [];
  const lines = planContent.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      let val = trimmed.slice(2).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      val = val.trim();
      if (!val) {
        continue;
      }
      if (val === "steps:" || val.startsWith("goal:")) {
        continue;
      }
      tasks.push(val);
    }
  }

  if (tasks.length === 0) {
    // Fallback: parse by sections or treat entire content as a main task
    tasks.push("Execute the steps outlined in the plan: " + planContent.slice(0, 150) + "...");
  }

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
