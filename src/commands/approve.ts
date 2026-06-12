import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  readGlobalConfig,
  readWorkflowState,
  writeWorkflowState,
} from "../agent/state";
import { PlanSchema, normalizePlanShape, parseYaml } from "../agent/plan";
import { getSubagentRole, subagentRoleIds } from "../agent/subagents";

export async function runApproveCommand(args: string[] = []): Promise<void> {
  const cwd = process.cwd();
  const planPathInput = args[0];

  if (!planPathInput) {
    console.log("[ERROR] Plan path argument is required.");
    process.exitCode = 1;
    return;
  }

  const resolvedInputPath = path.resolve(cwd, planPathInput);

  // Rejection if the plan file doesn't exist on disk
  try {
    await fs.access(resolvedInputPath);
  } catch {
    console.log(`[ERROR] Plan file not found: ${resolvedInputPath}`);
    process.exitCode = 1;
    return;
  }

  // Read ralplan state
  const ralplanState = await readWorkflowState("ralplan", cwd);
  if (!ralplanState) {
    console.log(`[ERROR] No ralplan workflow state found. Please run 'jeo ralplan' first.`);
    process.exitCode = 1;
    return;
  }

  if (!ralplanState.plan_path) {
    console.log(`[ERROR] No plan path associated with the current ralplan state.`);
    process.exitCode = 1;
    return;
  }

  // Compare canonical (symlink-resolved) paths so a relative arg, an absolute arg,
  // or a /var↔/private/var (macOS) form all match the stored plan path.
  const canonical = async (p: string): Promise<string> => {
    try {
      return await fs.realpath(p);
    } catch {
      return p;
    }
  };
  const resolvedStatePath = path.resolve(cwd, ralplanState.plan_path);
  const [canonInput, canonState] = await Promise.all([canonical(resolvedInputPath), canonical(resolvedStatePath)]);
  if (canonInput !== canonState) {
    console.log(
      `[ERROR] Provided plan path does not match the active plan in the ralplan state.\n` +
      `  provided: ${resolvedInputPath}\n` +
      `  active:   ${resolvedStatePath}\n` +
      `  Run 'jeo approve "${resolvedStatePath}"' to approve the active plan.`
    );
    process.exitCode = 1;
    return;
  }

  // Idempotency: check if already approved
  if (ralplanState.approved) {
    console.log(`[SUCCESS] Plan is already approved.`);
    return;
  }

  // Round-10 #4 (architect ref 8-Round10Planning): approval is a GATE, not a
  // rubber stamp — validate the plan against the exact contract `jeo team`
  // enforces, so a schema-invalid/unknown-role plan is refused HERE instead of
  // aborting later at execution time.
  try {
    const parsed = PlanSchema.safeParse(normalizePlanShape(parseYaml(await fs.readFile(resolvedInputPath, "utf-8"))));
    if (!parsed.success) {
      console.log(
        `[ERROR] Refusing to approve: the plan is not in the shape 'jeo team' executes (top-level 'steps:' list of { name, role? }).\n` +
        `  ${parsed.error.issues[0]?.message ?? "schema mismatch"}\n` +
        `  Fix ${resolvedInputPath} or re-run 'jeo ralplan'.`,
      );
      process.exitCode = 1;
      return;
    }
    const cfg = await readGlobalConfig();
    const unknown = [...new Set(parsed.data.steps.map(s => s.role?.trim()).filter((r): r is string => !!r && !getSubagentRole(r, cfg)))];
    if (unknown.length > 0) {
      console.log(
        `[ERROR] Refusing to approve: plan references unknown subagent role(s): ${unknown.join(", ")}.\n` +
        `  Known roles: ${subagentRoleIds(cfg).join(", ")}. Fix ${resolvedInputPath} or re-run 'jeo ralplan'.`,
      );
      process.exitCode = 1;
      return;
    }
  } catch (err: any) {
    console.log(`[ERROR] Refusing to approve: the plan file is not parseable YAML (${err.message}). Fix ${resolvedInputPath} or re-run 'jeo ralplan'.`);
    process.exitCode = 1;
    return;
  }

  // Round-11: approval also requires the PERSISTED consensus verdict — a plan
  // that never passed (or failed) the critic gate cannot be approved. States
  // from older ralplan runs lack the field; re-running ralplan heals them.
  if (ralplanState.consensus !== "okay") {
    console.log(
      `[ERROR] Refusing to approve: the plan lacks an [OKAY] consensus verdict (recorded: ${ralplanState.consensus ?? "none"}).\n` +
      `  Re-run 'jeo ralplan' so the consensus critic can review the plan, then approve again.`,
    );
    process.exitCode = 1;
    return;
  }

  // Update ralplan-state.json to approved: true
  ralplanState.approved = true;
  await writeWorkflowState("ralplan", ralplanState, cwd);

  console.log(`[SUCCESS] Plan approved successfully.`);
}
