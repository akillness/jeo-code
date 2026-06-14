/**
 * `subagent` control tool (#9) — the parent's handle on DETACHED subagents launched
 * via `task {detached:true}`. Mirrors gjc's `subagent`/`job` control surface, scoped
 * to an in-process registry: list, inspect, await (optionally bounded), and cancel.
 *
 * Out of scope here (separate subsystems, not stubbed): live peer messaging (IRC)
 * and pause/resume — a step-budget loop has no safe mid-step checkpoint to resume
 * from, so those are intentionally absent rather than faked.
 */
import type { ToolHandler } from "./engine";
import type { ToolResult } from "./tools";
import type { SubagentRegistry, SubagentRecord } from "./subagent-registry";

/** One-line protocol description appended to the launch system prompt. */
export const SUBAGENT_TOOL_PROTOCOL_LINE =
  `subagent {action:"list"|"inspect"|"await"|"cancel", ids?, timeoutMs?} — control DETACHED ` +
  `subagents started with task{detached:true}. 'await' blocks (optionally up to timeoutMs ms) and ` +
  `returns their reports; 'inspect' shows status + result; 'cancel' aborts them. Omit ids to target all running.`;

function elapsed(rec: SubagentRecord): string {
  const end = rec.finishedAt ?? Date.now();
  return `${Math.max(0, Math.round((end - rec.startedAt) / 1000))}s`;
}

function rowLine(rec: SubagentRecord): string {
  return `- ${rec.id} [${rec.status.toUpperCase()}] ${elapsed(rec)} · ${rec.task}`;
}

function detailBlock(rec: SubagentRecord): string {
  const head = rowLine(rec);
  if (rec.status === "running" || !rec.result) return head;
  return `${head}\n${rec.result}`;
}

function idsOf(args: Record<string, any>): string[] {
  if (Array.isArray(args.ids)) return args.ids.map((x: unknown) => String(x));
  if (args.id !== undefined) return [String(args.id)];
  return [];
}

export function createSubagentTool(registry: SubagentRegistry): ToolHandler {
  return async (args: Record<string, any>, _cwd: string): Promise<ToolResult> => {
    const action = String(args.action ?? "list").trim().toLowerCase();
    const ids = idsOf(args);

    if (action === "list") {
      const rows = registry.list();
      if (rows.length === 0) {
        return { success: true, output: "No detached subagents this turn. Launch one with task {detached:true}." };
      }
      const running = rows.filter(r => r.status === "running").length;
      return { success: true, output: `${rows.length} subagent(s), ${running} running:\n${rows.map(rowLine).join("\n")}` };
    }

    if (action === "inspect") {
      const targets = (ids.length ? ids.map(id => registry.get(id)) : registry.list())
        .filter((r): r is SubagentRecord => r !== undefined);
      if (targets.length === 0) {
        return { success: false, output: "", error: ids.length ? `No subagent matches ${ids.join(", ")}.` : "No detached subagents this turn." };
      }
      return { success: true, output: targets.map(detailBlock).join("\n\n") };
    }

    if (action === "await") {
      const targets = ids.length ? ids : registry.running().map(r => r.id);
      if (targets.length === 0) {
        return { success: true, output: "No running subagents to await." };
      }
      const timeoutMs = typeof args.timeoutMs === "number" && args.timeoutMs > 0 ? args.timeoutMs : undefined;
      const recs = await registry.awaitIds(targets, timeoutMs);
      const stillRunning = recs.filter(r => r.status === "running").length;
      const head = stillRunning > 0
        ? `Awaited ${recs.length} subagent(s); ${stillRunning} still running after the ${timeoutMs}ms timeout — await again or cancel.`
        : `Awaited ${recs.length} subagent(s); all settled.`;
      return { success: stillRunning === 0, output: `${head}\n\n${recs.map(detailBlock).join("\n\n")}` };
    }

    if (action === "cancel") {
      const targets = ids.length ? ids : registry.running().map(r => r.id);
      if (targets.length === 0) {
        return { success: true, output: "No running subagents to cancel." };
      }
      const recs = registry.cancel(targets);
      return { success: true, output: `Cancelled ${recs.length} subagent(s):\n${recs.map(rowLine).join("\n")}` };
    }

    return { success: false, output: "", error: `Unknown subagent action '${action}'. Use list | inspect | await | cancel.` };
  };
}
