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

  console.log("Running Planner → Architect → Critic consensus on the spec…");

  // Shared output contract (the exact shape `team` consumes) included in every pass.
  const SCHEMA_SPEC =
    `Output the plan as YAML with EXACTLY this shape (no prose, no markdown, no code fences):\n` +
    `name: "<short plan name>"\n` +
    `steps:\n` +
    `  - name: "<imperative task, e.g. Implement reverse() in src/reverse.ts>"\n` +
    `    role: executor   # one of: executor | planner | architect | critic\n` +
    `    target: "<primary file path>"\n` +
    `Provide 3-8 concrete, ordered steps. Output ONLY the YAML.`;

  const PLANNER = `You are the PLANNER. From the crystallized spec, sequence the work into a logical, outcome-based progression of concrete, ordered tasks.\n` + SCHEMA_SPEC;
  const ARCHITECT = `You are the ARCHITECT. Review the Planner's draft for technical feasibility, correct file targets, directory structure, and any missing setup/wiring/test steps. Return an improved plan (same shape).\n` + SCHEMA_SPEC;
  const CRITIC = `You are the CRITIC. Finalize the plan: remove vague or redundant steps, make each step actionable and independently verifiable, and ensure the acceptance criteria are covered. Return the final plan (same shape).\n` + SCHEMA_SPEC;

  try {
    const callRole = async (systemPrompt: string, userContent: string): Promise<string> => {
      const raw = await callLlm([{ role: "user" as const, content: userContent }], { systemPrompt });
      return raw.replace(/```yaml|```/g, "").trim();
    };
    const isValidPlan = (yaml: string): boolean => {
      try {
        return PlanSchema.safeParse(normalizePlanShape(parseYaml(yaml))).success;
      } catch {
        return false;
      }
    };

    // Three chained role passes, each consuming the prior output (gjc consensus).
    console.log("  [1/3] Planner drafting the task sequence…");
    const draft = await callRole(PLANNER, `Crystallized spec (seed.yaml):\n\n${seedContent}`);
    console.log("  [2/3] Architect reviewing feasibility & structure…");
    const reviewed = await callRole(ARCHITECT, `Crystallized spec (seed.yaml):\n\n${seedContent}\n\nPlanner's draft plan:\n\n${draft}\n\nReturn the improved plan.`);
    console.log("  [3/3] Critic finalizing (tightening + verifiability)…");
    let cleanPlan = await callRole(CRITIC, `Crystallized spec (seed.yaml):\n\n${seedContent}\n\nArchitect's plan:\n\n${reviewed}\n\nReturn the final, critiqued plan.`);

    // Self-validate the Critic's output against team's schema; repair once, else fall
    // back to the best valid earlier pass so a malformed plan never reaches approve/team.
    if (!isValidPlan(cleanPlan)) {
      console.log("[ralplan] Final plan did not match the required shape; requesting a corrected plan…");
      cleanPlan = await callRole(CRITIC, `Your previous output was not valid for the required schema. Fix it.\n\n${SCHEMA_SPEC}\n\nPlan to fix:\n\n${cleanPlan}`);
      if (!isValidPlan(cleanPlan)) {
        const fallback = [reviewed, draft].find(isValidPlan);
        if (fallback) {
          cleanPlan = fallback;
          console.log("[ralplan] Using an earlier valid pass output (Critic output was unparseable).");
        } else {
          console.log("[ralplan] WARNING: no pass produced a schema-valid plan. Saving the Critic output, but 'joc team' may reject it — review/edit the plan or re-run with a stronger model.");
        }
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
