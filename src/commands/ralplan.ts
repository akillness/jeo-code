import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { callLlm, type Message } from "../agent/loop";
import {
  readWorkflowState,
  writeWorkflowState,
  readGlobalConfig,
  getLocalJeoDir,
  type WorkflowState,
} from "../agent/state";
import { PlanSchema, normalizePlanShape, parseYaml } from "../agent/plan";
import {
  getSubagentRole,
  subagentSystemPrompt,
  subagentToolset,
  validateSubagentDoneReason,
  resolveSubagentModel,
  resolveSubagentMaxSteps,
} from "../agent/subagents";
import { runAgentLoop } from "../agent/engine";

/** Round-11 (architect ref 8-Round10Planning #1): the REAL consensus gate. A
 *  read-only critic SUBAGENT (repo access via read/search/find) reviews the
 *  candidate plan and must return an explicit verdict — unlike the drafting
 *  passes, this one can actually BLOCK. Fail-closed: anything but a clean
 *  [OKAY] contract is non-approval. */
export async function runConsensusCriticGate(args: {
  cwd: string;
  seedContent: string;
  plan: string;
  signal?: AbortSignal;
}): Promise<{ verdict: "okay" | "iterate" | "reject" | "unverified"; detail: string }> {
  const role = getSubagentRole("critic")!;
  const config = await readGlobalConfig();
  const model = resolveSubagentModel(role.id, config);
  const maxSteps = resolveSubagentMaxSteps(role.id, config);
  const history: Message[] = [
    { role: "system", content: subagentSystemPrompt(role) },
    {
      role: "user",
      content:
        `Review this implementation plan BEFORE it can be approved for execution.\n\n` +
        `Crystallized spec (seed.yaml):\n${args.seedContent}\n\n` +
        `Proposed plan (YAML — 'jeo team' executes the steps strictly top-to-bottom):\n${args.plan}\n\n` +
        `Verify against the ACTUAL repository (use read/search/find/ls): file targets exist or are sensibly placed, ` +
        `steps are ordered and independently verifiable, and the acceptance criteria are covered. ` +
        `Then call done — your reason MUST start with [OKAY], [ITERATE], or [REJECT] and include a 'Justification:' section.`,
    },
  ];
  const result = await runAgentLoop(history, {
    cwd: args.cwd,
    model,
    maxSteps,
    budget: { maxExtensions: 0 },
    signal: args.signal,
    tools: subagentToolset(role),
  });
  const reason = result.doneReason?.trim() ?? "";
  if (!result.done) return { verdict: "unverified", detail: reason || `critic did not converge within ${result.steps} steps` };
  const contract = validateSubagentDoneReason(role, reason);
  if (!contract.ok) return { verdict: "unverified", detail: `critic report incomplete (missing ${contract.missing?.join(", ")}): ${reason.slice(0, 300)}` };
  const firstLine = reason.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const verdict = firstLine === "[OKAY]" ? "okay" : firstLine === "[ITERATE]" ? "iterate" : firstLine === "[REJECT]" ? "reject" : "unverified";
  return { verdict, detail: reason };
}

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

  log("Running Planner → Architect drafting passes + a repo-grounded Critic consensus gate…");

  // Shared output contract (the exact shape `team` consumes) included in every pass.
  const SCHEMA_SPEC =
    `Output the plan as YAML with EXACTLY this shape (no prose, no markdown, no code fences):\n` +
    `name: "<short plan name>"\n` +
    `steps:\n` +
    `  - name: "<imperative task, e.g. Implement reverse() in src/reverse.ts>"\n` +
    `    role: executor   # one of: executor | planner | architect | critic\n` +
    `    target: "<primary file path>"\n` +
    `    parallel_group: "<optional short id, e.g. g1>"\n` +
    `Provide 3-8 concrete, ordered steps. Output ONLY the YAML.\n\n` +
    `parallel_group is OPTIONAL and OFF by default — omit it unless you are certain. ` +
    `'jeo team' executes steps strictly in array order, EXCEPT a contiguous (adjacent, ` +
    `no other step in between) run of steps sharing the SAME non-empty parallel_group value, ` +
    `which it runs CONCURRENTLY in isolated git worktrees and merges back. Only mark steps ` +
    `parallel_group when they are TRULY independent: each touches DISJOINT files with no step ` +
    `reading or building on another's output. Never mark two steps parallel if one depends on, ` +
    `reads, or extends a file another writes. When unsure, leave parallel_group out — a plain ` +
    `serial step is always correct; a wrongly-parallel step risks a merge conflict that halts ` +
    `execution.`;

  const PLANNER = `You are the PLANNER. From the crystallized spec, sequence the work into a logical, outcome-based progression of concrete, ordered tasks.\n` + SCHEMA_SPEC;
  const ARCHITECT = `You are the ARCHITECT. Review the Planner's draft for technical feasibility, correct file targets, directory structure, and any missing setup/wiring/test steps. Return an improved plan (same shape).\n` + SCHEMA_SPEC;
  const CRITIC = `You are the CRITIC. Finalize the plan: remove vague or redundant steps, make each step actionable and independently verifiable, and ensure the acceptance criteria are covered. Return the final plan (same shape).\n` + SCHEMA_SPEC;

  // Drafting passes honor the SAME per-role model config the rest of jeo uses
  // (resolveSubagentModel → config.subagents[role].model, else defaultModel).
  // Previously every pass ran on the default/primary model, ignoring a user's
  // configured planner/architect tiers; routing each pass to its role's model
  // lets a cheaper/faster draft tier cut planning latency with NO default change
  // (unset roles still resolve to defaultModel). The repo-grounded consensus gate
  // (runConsensusCriticGate) resolves critic's model independently and is untouched.
  const config = await readGlobalConfig();
  const PLANNER_MODEL = resolveSubagentModel("planner", config);
  const ARCHITECT_MODEL = resolveSubagentModel("architect", config);
  const CRITIC_MODEL = resolveSubagentModel("critic", config);

  try {
    const callRole = async (systemPrompt: string, userContent: string, model?: string): Promise<string> => {
      const raw = await callLlm([{ role: "user" as const, content: userContent }], { systemPrompt, model });
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
    const draft = await callRole(PLANNER, `Crystallized spec (seed.yaml):\n\n${seedContent}`, PLANNER_MODEL);

    if (opts.signal?.aborted) {
      return { ok: false, reason: "aborted" };
    }

    log("  [2/3] Architect reviewing feasibility & structure…");
    if (opts.onProgress) {
      opts.onProgress({ skill: "ralplan", phase: "planning", detail: "Architect reviewing" });
    }
    const reviewed = await callRole(ARCHITECT, `Crystallized spec (seed.yaml):\n\n${seedContent}\n\nPlanner's draft plan:\n\n${draft}\n\nReturn the improved plan.`, ARCHITECT_MODEL);

    if (opts.signal?.aborted) {
      return { ok: false, reason: "aborted" };
    }

    log("  [3/3] Critic finalizing (tightening + verifiability)…");
    if (opts.onProgress) {
      opts.onProgress({ skill: "ralplan", phase: "planning", detail: "Critic finalizing" });
    }
    let cleanPlan = await callRole(CRITIC, `Crystallized spec (seed.yaml):\n\n${seedContent}\n\nArchitect's plan:\n\n${reviewed}\n\nReturn the final, critiqued plan.`, CRITIC_MODEL);

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
      cleanPlan = await callRole(CRITIC, `Your previous output was not valid for the required schema. Fix it (roles MUST be one of executor|planner|architect|critic).\n\n${SCHEMA_SPEC}\n\nPlan to fix:\n\n${cleanPlan}`, CRITIC_MODEL);
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

    const planDir = path.join(getLocalJeoDir(cwd), "plans");
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

    // Round-11: REAL consensus gate — a read-only critic subagent with repo
    // access must return [OKAY] before this plan can be marked complete. One
    // [ITERATE] revision round is honored; anything else fails closed.
    log("  [gate] Consensus critic (read-only subagent) reviewing the plan against the repo…");
    if (opts.onProgress) {
      opts.onProgress({ skill: "ralplan", phase: "planning", detail: "Critic gate reviewing" });
    }
    let gate = await runConsensusCriticGate({ cwd, seedContent, plan: cleanPlan, signal: opts.signal });
    if (gate.verdict === "iterate") {
      log(`[ralplan] Critic returned [ITERATE] — revising the plan once to address the justification…`);
      const revised = await callRole(
        CRITIC,
        `The consensus critic returned [ITERATE] on the plan with this justification:\n\n${gate.detail}\n\n` +
        `Revise the plan to address every point.\n\n${SCHEMA_SPEC}\n\nCurrent plan:\n\n${cleanPlan}`,
        CRITIC_MODEL,
      );
      if (isValidPlan(revised)) {
        cleanPlan = revised;
        await fs.writeFile(planPath, cleanPlan, "utf-8");
        gate = await runConsensusCriticGate({ cwd, seedContent, plan: cleanPlan, signal: opts.signal });
      } else {
        // The revision did not parse as a schema/role-valid plan, so it cannot be
        // re-gated — the original [ITERATE] verdict stands. Report this explicitly
        // instead of silently discarding the revision attempt (which otherwise
        // surfaces only as the unchanged "verdict: ITERATE" failure below).
        log(`[ralplan] The revised plan was not schema/role-valid — discarding the revision; the [ITERATE] verdict stands.`);
      }
    }
    ralplanState.plan_path = planPath;
    ralplanState.consensus = gate.verdict;
    ralplanState.consensus_detail = gate.detail.slice(0, 600);
    if (gate.verdict === "okay") {
      ralplanState.consensus_hash = createHash("sha256").update(cleanPlan).digest("hex");
    }
    if (gate.verdict !== "okay") {
      ralplanState.approved = false;
      await writeWorkflowState("ralplan", ralplanState, cwd);
      log(
        `[ERROR] Consensus critic did NOT approve the plan (verdict: ${gate.verdict.toUpperCase()}).\n` +
        `  Justification:\n${gate.detail.slice(0, 800)}\n` +
        `  The plan was saved to ${planPath} but the workflow was NOT marked complete — address the justification and re-run 'jeo ralplan'.`,
      );
      return { ok: false, reason: `critic verdict: ${gate.verdict}` };
    }
    log(`  [gate] Critic verdict: [OKAY] — consensus recorded.`);

    log(`\n[SUCCESS] Plan successfully created and saved to: ${planPath}`);

    ralplanState.current_phase = "complete";
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
