import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  readWorkflowState,
  writeWorkflowState,
} from "../agent/state";

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

  // Update ralplan-state.json to approved: true
  ralplanState.approved = true;
  await writeWorkflowState("ralplan", ralplanState, cwd);

  console.log(`[SUCCESS] Plan approved successfully.`);
}
