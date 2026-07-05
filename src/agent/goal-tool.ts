/**
 * `goal` tool — lets the agent explicitly set/read/clear the session's natural-
 * language stop condition, mirroring gjc's own `goal` tool. Wraps the existing
 * file-persisted GoalState (src/agent/goal-verifier.ts) that the human-typed
 * `/goal <condition>` slash command already writes to and that the engine's
 * per-`done` verifier (src/commands/launch.ts, verifyGoal) already reads from —
 * this tool just gives the MODEL the same lever, not a new state store.
 */
import type { ToolHandler } from "./engine";
import type { ToolResult } from "./tools";
import { readGoalState, writeGoalState, clearGoalState, type GoalState } from "./goal-verifier";

/** One-line protocol description appended to the launch system prompt. */
export const GOAL_TOOL_PROTOCOL_LINE =
  `goal {action:"set", condition} sets a natural-language stop condition for this session — ` +
  `it is auto-verified against the conversation every time you call done, and a NOT_MET/IMPOSSIBLE ` +
  `verdict blocks your reply and tells you what's missing. goal {action:"get"} shows the current ` +
  `condition and its latest verdict. goal {action:"clear"} removes it.`;

function formatState(state: GoalState | null): string {
  if (!state) return `No goal set for this session. Set one with goal {action:"set", condition}.`;
  const last = state.verdicts[state.verdicts.length - 1];
  const verdictLine = last
    ? `Last verdict: ${last.verdict}${last.gap ? ` — ${last.gap}` : ""}`
    : "No verdicts yet (verified on your next done call).";
  return `Goal: "${state.condition}" (set ${new Date(state.setAt).toLocaleTimeString()})\n${verdictLine}`;
}

export function createGoalTool(): ToolHandler {
  return async (args: Record<string, any>, cwd: string): Promise<ToolResult> => {
    const action = String(args.action ?? "get").trim().toLowerCase();

    if (action === "set") {
      const condition = typeof args.condition === "string" ? args.condition.trim() : "";
      if (!condition) {
        return { success: false, output: "", error: `goal {action:"set"} requires a non-empty 'condition'.` };
      }
      await writeGoalState({ condition, setAt: Date.now(), verdicts: [] }, cwd);
      return {
        success: true,
        output: `Goal set: "${condition}". It will be auto-verified against the conversation each time you call done.`,
      };
    }

    if (action === "clear") {
      await clearGoalState(cwd);
      return { success: true, output: "Goal cleared." };
    }

    if (action === "get") {
      const state = await readGoalState(cwd);
      return { success: true, output: formatState(state) };
    }

    return { success: false, output: "", error: `Unknown goal action '${action}'. Use set | get | clear.` };
  };
}
