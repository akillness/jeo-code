import * as fs from "node:fs/promises";
import * as path from "node:path";
import { callLlm } from "../agent/loop";
import {
  readWorkflowState,
  writeWorkflowState,
  getLocalJocDir,
} from "../agent/state";

export async function runRalplanCommand(): Promise<void> {
  const cwd = process.cwd();

  // Read deep-interview state
  const interviewState = await readWorkflowState("deep-interview", cwd);
  if (!interviewState || interviewState.current_phase !== "complete" || !interviewState.seed_path) {
    console.log(
      `[ERROR] No crystallized requirements found. Please run 'joc deep-interview' to crystallize requirements first.`
    );
    return;
  }

  const seedPath = interviewState.seed_path;
  console.log(`\n=== Starting Ralplan Planning Stage ===`);
  console.log(`Reading requirements seed from: ${seedPath}`);

  let seedContent = "";
  try {
    seedContent = await fs.readFile(seedPath, "utf-8");
  } catch (err: any) {
    console.log(`[ERROR] Failed to read seed file: ${err.message}`);
    return;
  }

  // Initialize ralplan state
  let ralplanState = {
    active: true,
    current_phase: "planning",
    skill: "ralplan" as const,
    slug: interviewState.slug,
    seed_path: seedPath,
  };
  await writeWorkflowState("ralplan", ralplanState, cwd);

  console.log("Generating resilient task sequence plan (Critiqued by Planner/Architect/Critic)...");

  // Standard multi-role system prompt
  const systemPrompt = 
    `You are the Ralplan Orchestrator, combining three expert roles:\n` +
    `1. Planner: Focuses on sequencing tasks into a highly logical, outcome-based progression.\n` +
    `2. Architect: Reviews technical feasibility, structural directories, and patterns.\n` +
    `3. Critic: Critiques the plan for vagueness, redundant copies, and missing steps.\n\n` +
    `Analyze the given crystallized spec (seed.yaml) and generate a step-by-step implementation plan.\n` +
    `Output the final plan in YAML format. Ensure it contains a clear sequence of tasks with descriptive names and target files.\n` +
    `Output ONLY the YAML. Do not include markdown wraps or code blocks.`;

  const messages = [
    { role: "system" as const, systemPrompt, content: "" },
    { role: "user" as const, content: `Here is the crystallized spec (seed.yaml):\n\n${seedContent}` }
  ];

  try {
    const rawPlan = await callLlm(messages, { systemPrompt });
    const cleanPlan = rawPlan.replace(/```yaml|```/g, "").trim();

    const planDir = path.join(getLocalJocDir(cwd), "plans");
    await fs.mkdir(planDir, { recursive: true });
    const planPath = path.join(planDir, `plan-${interviewState.slug}.yaml`);

    await fs.writeFile(planPath, cleanPlan, "utf-8");
    console.log(`\n[SUCCESS] Plan successfully created and saved to: ${planPath}`);

    ralplanState.current_phase = "complete";
    ralplanState.plan_path = planPath;
    await writeWorkflowState("ralplan", ralplanState, cwd);

    console.log("\nPlan preview:");
    console.log("-----------------------------------------");
    console.log(cleanPlan);
    console.log("-----------------------------------------");
    console.log("\n[Handoff Ready] The blueprint is prepared. Run 'joc team' to execute the plan.");

  } catch (error: any) {
    console.log(`[ERROR calling LLM during Planning]: ${error.message}`);
  }
}
