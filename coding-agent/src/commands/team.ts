import * as fs from "node:fs/promises";
import * as path from "node:path";
import { callLlm, type Message } from "../agent/loop";
import {
  readWorkflowState,
  writeWorkflowState,
} from "../agent/state";
import {
  readTool,
  writeTool,
  editTool,
  bashTool,
  findTool,
  searchTool,
} from "../agent/tools";

interface ToolInvocation {
  tool: "read" | "write" | "edit" | "bash" | "find" | "search" | "done";
  arguments: Record<string, any>;
}

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
    if (trimmed.startsWith("-") || trimmed.startsWith("task:")) {
      const taskText = trimmed.replace(/^-\s*/, "").replace(/^task:\s*/, "").trim();
      if (taskText) tasks.push(taskText);
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
  const systemPrompt =
    `You are the Executor Agent, a senior software developer.\n` +
    `Your goal is to successfully execute the given programming task by calling tools.\n` +
    `You have the following tools available:\n` +
    `1. read (filePath, lineRange) - Read a file's contents\n` +
    `2. write (filePath, content) - Write a new file or overwrite entirely\n` +
    `3. edit (filePath, editBlock) - Edit an existing file using replacement blocks\n` +
    `4. bash (command) - Run a terminal command (e.g. tests, lint)\n` +
    `5. find (globPattern) - Find files matching a glob\n` +
    `6. search (pattern, globPattern) - Grep for a pattern in files\n\n` +
    `Provide your output strictly in JSON format. Choose exactly ONE tool call in each step.\n` +
    `Format:\n` +
    `{\n` +
    `  "tool": "read" | "write" | "edit" | "bash" | "find" | "search" | "done",\n` +
    `  "arguments": { ... }\n` +
    `}\n` +
    `When the task is fully and successfully implemented and verified, call the "done" tool.`;

  const history: Message[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Your task is: "${task}"` }
  ];

  let step = 1;
  const maxSteps = 15;

  while (step <= maxSteps) {
    console.log(`  └─ Step ${step}: Thinking...`);
    try {
      const responseText = await callLlm(history, { jsonMode: true });
      let invocation: ToolInvocation;
      
      try {
        invocation = JSON.parse(responseText.trim()) as ToolInvocation;
      } catch {
        const cleanJson = responseText.replace(/```json|```/g, "").trim();
        invocation = JSON.parse(cleanJson) as ToolInvocation;
      }

      const toolName = invocation.tool;
      const args = invocation.arguments;

      if (toolName === "done") {
        console.log("  └─ Executor completed the task successfully.");
        return true;
      }

      console.log(`  └─ Calling tool [${toolName}] with args:`, JSON.stringify(args));

      let resultOutput = "";
      let success = false;

      if (toolName === "read") {
        const res = await readTool(args.filePath, args.lineRange, cwd);
        resultOutput = res.success ? res.output : `Error: ${res.error}`;
        success = res.success;
      } else if (toolName === "write") {
        const res = await writeTool(args.filePath, args.content, cwd);
        resultOutput = res.success ? res.output : `Error: ${res.error}`;
        success = res.success;
      } else if (toolName === "edit") {
        const res = await editTool(args.filePath, args.editBlock, cwd);
        resultOutput = res.success ? res.output : `Error: ${res.error}`;
        success = res.success;
      } else if (toolName === "bash") {
        const res = await bashTool(args.command, cwd);
        resultOutput = res.success ? res.output : `Error: ${res.error}`;
        success = res.success;
      } else if (toolName === "find") {
        const res = await findTool(args.globPattern, cwd);
        resultOutput = res.success ? res.output : `Error: ${res.error}`;
        success = res.success;
      } else if (toolName === "search") {
        const res = await searchTool(args.pattern, args.globPattern, cwd);
        resultOutput = res.success ? res.output : `Error: ${res.error}`;
        success = res.success;
      } else {
        resultOutput = `Unknown tool: ${toolName}`;
      }

      console.log(`  └─ Tool Result: ${success ? "Success" : "Failed"}`);

      history.push({ role: "assistant", content: responseText });
      history.push({
        role: "user",
        content: `Tool [${toolName}] result: ${resultOutput}`
      });

      step++;
    } catch (err: any) {
      console.log(`  └─ Error in execution step: ${err.message}`);
      return false;
    }
  }

  console.log(`  └─ Reached max steps (${maxSteps}) for task.`);
  return false;
}
