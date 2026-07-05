import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  readGlobalConfig,
  readWorkflowState,
  writeWorkflowState,
} from "../agent/state";
import { PlanSchema, normalizePlanShape, parseYaml } from "../agent/plan";
import { getSubagentRole, subagentRoleIds } from "../agent/subagents";

export interface ApprovePlanResult {
  ok: boolean;
  message: string;
}

/** Core approval gate, shared by the `jeo approve` CLI command and the agent-facing
 *  `approve` tool (src/agent/approve-tool.ts). ALL of the plan-quality checks below
 *  (schema shape, known roles, persisted [OKAY] consensus verdict, hash-vs-consensus
 *  match) still apply no matter who calls this — approval is a content gate, not an
 *  identity gate. 2026-07: the identity gate (only a human running `jeo approve` in
 *  their own terminal could flip `approved: true`) was removed per explicit user
 *  direction — the agent can now call this itself via the `approve` tool. */
export async function approvePlan(planPathInput: string, cwd: string): Promise<ApprovePlanResult> {
  if (!planPathInput) {
    return { ok: false, message: "[ERROR] Plan path argument is required." };
  }

  const resolvedInputPath = path.resolve(cwd, planPathInput);

  // Rejection if the plan file doesn't exist on disk
  try {
    await fs.access(resolvedInputPath);
  } catch {
    return { ok: false, message: `[ERROR] Plan file not found: ${resolvedInputPath}` };
  }

  // Read ralplan state
  const ralplanState = await readWorkflowState("ralplan", cwd);
  if (!ralplanState) {
    return { ok: false, message: `[ERROR] No ralplan workflow state found. Please run 'jeo ralplan' first.` };
  }

  if (!ralplanState.plan_path) {
    return { ok: false, message: `[ERROR] No plan path associated with the current ralplan state.` };
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
    return {
      ok: false,
      message:
        `[ERROR] Provided plan path does not match the active plan in the ralplan state.\n` +
        `  provided: ${resolvedInputPath}\n` +
        `  active:   ${resolvedStatePath}\n` +
        `  Run 'jeo approve "${resolvedStatePath}"' to approve the active plan.`,
    };
  }

  // Idempotency: check if already approved
  if (ralplanState.approved) {
    return { ok: true, message: `[SUCCESS] Plan is already approved.` };
  }

  // Round-10 #4 (architect ref 8-Round10Planning): approval is a GATE, not a
  // rubber stamp — validate the plan against the exact contract `jeo team`
  // enforces, so a schema-invalid/unknown-role plan is refused HERE instead of
  // aborting later at execution time.
  let planContent = "";
  try {
    planContent = await fs.readFile(resolvedInputPath, "utf-8");
    const parsed = PlanSchema.safeParse(normalizePlanShape(parseYaml(planContent)));
    if (!parsed.success) {
      return {
        ok: false,
        message:
          `[ERROR] Refusing to approve: the plan is not in the shape 'jeo team' executes (top-level 'steps:' list of { name, role? }).\n` +
          `  ${parsed.error.issues[0]?.message ?? "schema mismatch"}\n` +
          `  Fix ${resolvedInputPath} or re-run 'jeo ralplan'.`,
      };
    }
    const cfg = await readGlobalConfig();
    const unknown = [...new Set(parsed.data.steps.map(s => s.role?.trim()).filter((r): r is string => !!r && !getSubagentRole(r, cfg)))];
    if (unknown.length > 0) {
      return {
        ok: false,
        message:
          `[ERROR] Refusing to approve: plan references unknown subagent role(s): ${unknown.join(", ")}.\n` +
          `  Known roles: ${subagentRoleIds(cfg).join(", ")}. Fix ${resolvedInputPath} or re-run 'jeo ralplan'.`,
      };
    }
  } catch (err: any) {
    return {
      ok: false,
      message: `[ERROR] Refusing to approve: the plan file is not parseable YAML (${err.message}). Fix ${resolvedInputPath} or re-run 'jeo ralplan'.`,
    };
  }

  // Round-11: approval also requires the PERSISTED consensus verdict — a plan
  // that never passed (or failed) the critic gate cannot be approved. States
  // from older ralplan runs lack the field; re-running ralplan heals them.
  if (ralplanState.consensus !== "okay") {
    return {
      ok: false,
      message:
        `[ERROR] Refusing to approve: the plan lacks an [OKAY] consensus verdict (recorded: ${ralplanState.consensus ?? "none"}).\n` +
        `  Re-run 'jeo ralplan' so the consensus critic can review the plan, then approve again.`,
    };
  }

  // Round-13: verify the plan's hash matches the consensus hash to prevent silent edits
  if (ralplanState.consensus_hash) {
    const currentHash = createHash("sha256").update(planContent).digest("hex");
    if (currentHash !== ralplanState.consensus_hash) {
      return {
        ok: false,
        message:
          `[ERROR] Refusing to approve: the plan file has been modified since the consensus critic reviewed it.\n` +
          `  Re-run 'jeo ralplan' to let the critic review the updated plan, then approve again.`,
      };
    }
  }

  // Update ralplan-state.json to approved: true
  ralplanState.approved = true;
  await writeWorkflowState("ralplan", ralplanState, cwd);

  return { ok: true, message: `[SUCCESS] Plan approved successfully.` };
}

export async function runApproveCommand(args: string[] = []): Promise<void> {
  const cwd = process.cwd();
  const planPathInput = args[0];
  const { ok, message } = await approvePlan(planPathInput, cwd);
  console.log(message);
  if (!ok) process.exitCode = 1;
}
