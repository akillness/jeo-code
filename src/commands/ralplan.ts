import * as fs from "node:fs/promises";
import * as path from "node:path";
import { callLlm } from "../agent/loop";
import {
  readWorkflowState,
  writeWorkflowState,
  getLocalJocDir,
  type WorkflowState,
} from "../agent/state";
import { PlanSchema, normalizePlanShape, parseYaml } from "./team";

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
  const ralplanState: WorkflowState = {
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
    `Output the plan as YAML with EXACTLY this shape (no prose, no markdown, no code fences):\n` +
    `name: "<short plan name>"\n` +
    `steps:\n` +
    `  - name: "<imperative task, e.g. Implement reverse() in src/reverse.ts>"\n` +
    `    role: executor   # one of: executor | planner | architect | critic\n` +
    `    target: "<primary file path>"\n` +
    `  - name: "<next task>"\n` +
    `    role: executor\n` +
    `    target: "<file>"\n` +
    `Provide 3-8 concrete, ordered steps. Output ONLY the YAML above.`;

  const messages = [
    { role: "user" as const, content: `Here is the crystallized spec (seed.yaml):\n\n${seedContent}` }
  ];

  try {
    // Generate, then self-validate against the schema `team` consumes; repair once so a
    // malformed plan never reaches approve/team (producer↔consumer contract).
    const generate = async (extra = ""): Promise<string> => {
      const raw = await callLlm(
        extra ? [...messages, { role: "user" as const, content: extra }] : messages,
        { systemPrompt },
      );
      return raw.replace(/```yaml|```/g, "").trim();
    };
    const isValidPlan = (yaml: string): boolean => {
      try {
        return PlanSchema.safeParse(normalizePlanShape(parseYaml(yaml))).success;
      } catch {
        return false;
      }
    };
    let cleanPlan = await generate();
    if (!isValidPlan(cleanPlan)) {
      console.log("[ralplan] First plan did not match the required shape; requesting a corrected plan…");
      cleanPlan = await generate(
        `Your previous output was not valid. Output ONLY YAML with a top-level 'name:' and a 'steps:' list where each item is '- name: <task>' with an optional 'role:'. No prose, no code fences.`,
      );
      if (!isValidPlan(cleanPlan)) {
        console.log("[ralplan] WARNING: the model's plan still doesn't match the schema. Saving it, but 'joc team' may reject it — review/edit the plan or re-run with a stronger model.");
      }
    }

    const planDir = path.join(getLocalJocDir(cwd), "plans");
    await fs.mkdir(planDir, { recursive: true });
    const planPath = path.join(planDir, `plan-${interviewState.slug}.yaml`);

    await fs.writeFile(planPath, cleanPlan, "utf-8");
    console.log(`\n[SUCCESS] Plan successfully created and saved to: ${planPath}`);

    ralplanState.current_phase = "complete";
    ralplanState.plan_path = planPath;
    ralplanState.approved = false;
    await writeWorkflowState("ralplan", ralplanState, cwd);

    console.log("\nPlan preview:");
    console.log("-----------------------------------------");
    console.log(cleanPlan);
    console.log("-----------------------------------------");
    console.log(`\n[Handoff Ready] The blueprint is prepared but NOT yet approved.`);
    console.log(`  1) Review it, then approve:  joc approve "${planPath}"`);
    console.log(`  2) Execute the plan:         joc team`);

  } catch (error: any) {
    console.log(`[ERROR calling LLM during Planning]: ${error.message}`);
  }
}
