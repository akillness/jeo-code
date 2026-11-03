import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  readGlobalConfig,
  readWorkflowState,
  writeWorkflowState,
  readWorkflowFile,
} from "../agent/state";
import { PlanSchema, normalizePlanShape, parseYaml } from "../agent/plan";
import { getSubagentRole, subagentRoleIds } from "../agent/subagents";
import { currentSandboxExecution } from "../agent/hooks";

export interface ApprovePlanResult {
  ok: boolean;
  message: string;
}

export interface ApprovalPathInspection {
  exists: boolean;
  canonical: string;
}

/** Inspect only workspace paths in the guest; role configuration stays in the brain. */
export async function inspectApprovalPath(filePath: string, cwd: string): Promise<ApprovalPathInspection> {
  const resolved = path.resolve(cwd, filePath);
  const sandbox = currentSandboxExecution();
  if (sandbox) {
    const result = await sandbox.supervisor.call("__workflow", { operation: "approvalPath", path: resolved }, { cwd, signal: sandbox.signal });
    if (!result.success) throw new Error(result.error || "SANDBOX_WORKFLOW: approval path inspection failed");
    const value: unknown = JSON.parse(result.output);
    if (typeof value !== "object" || value === null || !("exists" in value) || typeof value.exists !== "boolean" || !("canonical" in value) || typeof value.canonical !== "string") {
      throw new Error("SANDBOX_WORKFLOW: invalid approval path inspection");
    }
    return { exists: value.exists, canonical: value.canonical };
  }
  try {
    await fs.access(resolved);
  } catch {
    return { exists: false, canonical: resolved };
  }
  try {
    return { exists: true, canonical: await fs.realpath(resolved) };
  } catch {
    return { exists: true, canonical: resolved };
  }
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
  const inputPath = await inspectApprovalPath(resolvedInputPath, cwd);
  if (!inputPath.exists) {
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
  const resolvedStatePath = path.resolve(cwd, ralplanState.plan_path);
  const statePath = await inspectApprovalPath(resolvedStatePath, cwd);
  if (inputPath.canonical !== statePath.canonical) {
    return {
      ok: false,
      message:
        `[ERROR] Provided plan path does not match the active plan in the ralplan state.\n` +
        `  provided: ${resolvedInputPath}\n` +
        `  active:   ${resolvedStatePath}\n` +
        `  Run 'jeo approve "${resolvedStatePath}"' to approve the active plan.`,
    };
  }

  // Round-10 #4 (architect ref 8-Round10Planning): approval is a GATE, not a
  // rubber stamp — validate the plan against the exact contract `jeo team`
  // enforces, so a schema-invalid/unknown-role plan is refused HERE instead of
  // aborting later at execution time.
  let planContent = "";
  try {
    planContent = await readWorkflowFile(resolvedInputPath, cwd);
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

  // Approval and idempotent re-approval both require the exact reviewed bytes.
  if (!ralplanState.consensus_hash) {
    return {
      ok: false,
      message:
        `[ERROR] Refusing to approve: the plan lacks a consensus review hash.\n` +
        `  Re-run 'jeo ralplan' so the consensus critic can review the plan, then approve again.`,
    };
  }
  const currentHash = createHash("sha256").update(planContent).digest("hex");
  if (currentHash !== ralplanState.consensus_hash) {
    return {
      ok: false,
      message:
        `[ERROR] Refusing to approve: the plan file has been modified since the consensus critic reviewed it.\n` +
        `  Re-run 'jeo ralplan' to let the critic review the updated plan, then approve again.`,
    };
  }

  if (ralplanState.approved) {
    return { ok: true, message: `[SUCCESS] Plan is already approved.` };
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
