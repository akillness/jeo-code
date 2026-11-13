/**
 * `approve` tool — lets the agent itself flip a `jeo ralplan` plan's `approved`
 * flag so `jeo team`/`jeo ultragoal` can execute it, wrapping the same
 * content gate the `jeo approve` CLI command enforces (src/commands/approve.ts's
 * `approvePlan`): schema shape, known subagent roles, a persisted [OKAY]
 * consensus verdict, and a hash match against what the consensus critic
 * reviewed. As of 2026-07, approval no longer requires a human running
 * `jeo approve <path>` in their own terminal: the agent can approve its own
 * plans. The plan-quality gate remains unchanged and refuses a
 * schema-invalid, unreviewed, or post-review-edited plan no matter who calls it.
 */
import type { ToolHandler } from "./engine";
import type { ToolResult } from "./tools";
import { readWorkflowState } from "./state";
import { approvePlan } from "../commands/approve";

/** One-line protocol description appended to the launch system prompt. */
export const APPROVE_TOOL_PROTOCOL_LINE =
  `approve {planPath?} approves the active 'jeo ralplan' plan (planPath defaults to the active plan ` +
  `from ralplan state when omitted) so 'jeo team'/'jeo ultragoal' can execute it next. Refuses a plan ` +
  `that is schema-invalid, references an unknown role, lacks a persisted [OKAY] consensus verdict, or ` +
  `was edited after the consensus critic reviewed it — same content gate as the 'jeo approve' CLI command.`;

export function createApproveTool(): ToolHandler {
  return async (args: Record<string, any>, cwd: string): Promise<ToolResult> => {
    let planPath = typeof args.planPath === "string" ? args.planPath.trim() : "";
    if (!planPath) {
      const ralplanState = await readWorkflowState("ralplan", cwd);
      planPath = ralplanState?.plan_path ?? "";
    }
    if (!planPath) {
      return {
        success: false,
        output: "",
        error: `approve requires a 'planPath' (no active ralplan plan found to default to). Run 'jeo ralplan' first, or pass the plan path explicitly.`,
      };
    }
    const { ok, message } = await approvePlan(planPath, cwd);
    return ok ? { success: true, output: message } : { success: false, output: "", error: message };
  };
}
