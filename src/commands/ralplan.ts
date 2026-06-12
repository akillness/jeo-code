import * as fs from "node:fs/promises";
import * as path from "node:path";
import { callLlm } from "../agent/loop";
import {
  readWorkflowState,
  writeWorkflowState,
  getLocalJocDir,
  type WorkflowState,
} from "../agent/state";
import { PlanSchema, normalizePlanShape, parseYaml } from "../agent/plan";
import { getSubagentRole } from "../agent/subagents";

export interface RalplanEngineOptions {
  cwd?: string;
  signal?: AbortSignal;
  onProgress?: (e: { skill: string; phase: string; detail?: string }) => void;
  io?: {
    output?: (line: string) => void;
  };
}

export async function runRalplanEngine(opts: RalplanEngineOptions = {}): Promise<{ ok: boolean; reason?: string }> {
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
    opts.onProgress({ skill: "ralplan", phase: "start" });
  }

  if (opts.signal?.aborted) {
    return { ok: false, reason: "aborted" };
  }

  // Read deep-interview state
  const interviewState = await readWorkflowState("deep-interview", cwd);
  if (!interviewState || interviewState.current_phase !== "complete" || !interviewState.seed_path) {
    log(
      `[ERROR] No crystallized requirements found. Please run 'jeo deep-interview' to crystallize requirements first.`
    );
    return { ok: false, reason: "No crystallized requirements found" };
  }

  const seedPath = interviewState.seed_path;
  log(`\n=== Starting Ralplan Planning Stage ===`);
  log(`Reading requirements seed from: ${seedPath}`);

  let seedContent = "";
  try {
    seedContent = await fs.readFile(seedPath, "utf-8");
  } catch (err: any) {
    log(`[ERROR] Failed to read seed file: ${err.message}`);
    return { ok: false, reason: err.message };
  }

  if (opts.signal?.aborted) {
    return { ok: false, reason: "aborted" };
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

  log("Running Planner → Architect → Critic prompt passes (single-model drafting — schema/role validation happens at write time)…");

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
        const parsed = PlanSchema.safeParse(normalizePlanShape(parseYaml(yaml)));
        if (!parsed.success) return false;
        // Round-10 #2 (architect ref 8-Round10Planning): write-time parity with
        // team's execution gate — an unknown role (e.g. "developer") used to pass
        // here and abort only at `jeo team`, after the planning model was gone.
        return parsed.data.steps.every(s => !s.role?.trim() || !!getSubagentRole(s.role));
      } catch {
        return false;
      }
    };

    if (opts.signal?.aborted) {
      return { ok: false, reason: "aborted" };
    }

    // Three chained role passes, each consuming the prior output (gjc consensus).
    log("  [1/3] Planner drafting the task sequence…");
    if (opts.onProgress) {
      opts.onProgress({ skill: "ralplan", phase: "planning", detail: "Planner drafting" });
    }
    const draft = await callRole(PLANNER, `Crystallized spec (seed.yaml):\n\n${seedContent}`);

    if (opts.signal?.aborted) {
      return { ok: false, reason: "aborted" };
    }

    log("  [2/3] Architect reviewing feasibility & structure…");
    if (opts.onProgress) {
      opts.onProgress({ skill: "ralplan", phase: "planning", detail: "Architect reviewing" });
    }
    const reviewed = await callRole(ARCHITECT, `Crystallized spec (seed.yaml):\n\n${seedContent}\n\nPlanner's draft plan:\n\n${draft}\n\nReturn the improved plan.`);

    if (opts.signal?.aborted) {
      return { ok: false, reason: "aborted" };
    }

    log("  [3/3] Critic finalizing (tightening + verifiability)…");
    if (opts.onProgress) {
      opts.onProgress({ skill: "ralplan", phase: "planning", detail: "Critic finalizing" });
    }
    let cleanPlan = await callRole(CRITIC, `Crystallized spec (seed.yaml):\n\n${seedContent}\n\nArchitect's plan:\n\n${reviewed}\n\nReturn the final, critiqued plan.`);

    if (opts.signal?.aborted) {
      return { ok: false, reason: "aborted" };
    }

    // Self-validate the Critic's output against team's schema (incl. role names);
    // repair once, else fall back to the best valid earlier pass. When NO pass is
    // valid, the plan is saved for inspection but the workflow is NOT marked
    // complete (round-10 #2) — failing here, while the model is still in the loop,
    // beats failing later at `jeo team` with the same plan.
    let planValid = true;
    if (!isValidPlan(cleanPlan)) {
      log("[ralplan] Final plan did not match the required shape; requesting a corrected plan…");
      cleanPlan = await callRole(CRITIC, `Your previous output was not valid for the required schema. Fix it (roles MUST be one of executor|planner|architect|critic).\n\n${SCHEMA_SPEC}\n\nPlan to fix:\n\n${cleanPlan}`);
      if (!isValidPlan(cleanPlan)) {
        const fallback = [reviewed, draft].find(isValidPlan);
        if (fallback) {
          cleanPlan = fallback;
          log("[ralplan] Using an earlier valid pass output (Critic output was unparseable).");
        } else {
          planValid = false;
        }
      }
    }

    const planDir = path.join(getLocalJocDir(cwd), "plans");
    await fs.mkdir(planDir, { recursive: true });
    const planPath = path.join(planDir, `plan-${interviewState.slug}.yaml`);

    await fs.writeFile(planPath, cleanPlan, "utf-8");

    if (!planValid) {
      ralplanState.plan_path = planPath; // saved for inspection — but NOT complete
      ralplanState.approved = false;
      await writeWorkflowState("ralplan", ralplanState, cwd);
      log(
        `[ERROR] No pass produced a schema/role-valid plan. The last output was saved to ${planPath} for review, ` +
        `but the workflow was NOT marked complete — edit the plan to match the schema (roles: executor|planner|architect|critic) ` +
        `and re-run 'jeo ralplan', or retry with a stronger model.`,
      );
      return { ok: false, reason: "no schema-valid plan produced" };
    }

    log(`\n[SUCCESS] Plan successfully created and saved to: ${planPath}`);

    ralplanState.current_phase = "complete";
    ralplanState.plan_path = planPath;
    ralplanState.approved = false;
    await writeWorkflowState("ralplan", ralplanState, cwd);

    log("\nPlan preview:");
    log("-----------------------------------------");
    log(cleanPlan);
    log("-----------------------------------------");
    log(`\n[Handoff Ready] The blueprint is prepared but NOT yet approved.`);
    log(`  1) Review it, then approve:  jeo approve "${planPath}"`);
    log(`  2) Execute the plan:         jeo team`);

    if (opts.onProgress) {
      opts.onProgress({ skill: "ralplan", phase: "complete" });
    }
    return { ok: true };

  } catch (error: any) {
    log(`[ERROR calling LLM during Planning]: ${error.message}`);
    return { ok: false, reason: error.message };
  }
}

export async function runRalplanCommand(): Promise<void> {
  await runRalplanEngine();
}
