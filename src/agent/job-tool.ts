/**
 * `job` control tool — the parent's handle on BACKGROUND shell processes launched
 * via `job {action:"start"}`. Mirrors gjc's `job`/async-bash control surface, scoped
 * to an in-process registry: start, list, tail, await (optionally bounded), and cancel.
 */
import type { ToolHandler } from "./engine";
import type { ToolResult } from "./tools";
import type { JobRegistry, JobRecord } from "./job-registry";

/** One-line protocol description appended to the launch system prompt. */
export const JOB_TOOL_PROTOCOL_LINE =
  `job {action:"start", command, cwd?} runs a shell command in the BACKGROUND as a real ` +
  `parallel OS process and returns a job id immediately. job {action:"list"|"tail"|"await"|"cancel", ` +
  `ids?, timeoutMs?} — 'tail' shows buffered output so far; 'await' blocks (optionally up to timeoutMs ` +
  `ms) until it exits; 'cancel' kills it; omit ids to target all running.`;

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function elapsed(rec: JobRecord): string {
  const end = rec.finishedAt ?? Date.now();
  return `${Math.max(0, Math.round((end - rec.startedAt) / 1000))}s`;
}

function rowLine(rec: JobRecord): string {
  return `- ${rec.id} [${rec.status.toUpperCase()}] ${elapsed(rec)} · ${truncate(rec.command, 100)}`;
}

function idsOf(args: Record<string, any>): string[] {
  if (Array.isArray(args.ids)) return args.ids.map((x: unknown) => String(x));
  if (args.id !== undefined) return [String(args.id)];
  return [];
}

export function createJobTool(registry: JobRegistry): ToolHandler {
  return async (args: Record<string, any>, cwd: string): Promise<ToolResult> => {
    const action = String(args.action ?? "list").trim().toLowerCase();
    const ids = idsOf(args);

    if (action === "start") {
      const command = typeof args.command === "string" ? args.command.trim() : "";
      if (!command) {
        return { success: false, output: "", error: `job {action:"start"} requires a non-empty 'command'.` };
      }
      const resolvedCwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd : cwd;
      const rec = registry.start(command, resolvedCwd);
      return {
        success: true,
        output: `[background] started job '${rec.id}': ${truncate(command, 120)}. It runs in the background — ` +
          `keep working, then use the 'job' tool ({action:"tail"|"await"|"list"|"cancel", ids?}) to check on it.`,
      };
    }

    if (action === "list") {
      const rows = registry.list();
      if (rows.length === 0) {
        return { success: true, output: `No background jobs this turn. Launch one with job {action:"start", command}.` };
      }
      const running = rows.filter(r => r.status === "running").length;
      return { success: true, output: `${rows.length} job(s), ${running} running:\n${rows.map(rowLine).join("\n")}` };
    }

    if (action === "tail") {
      const targets = ids.length ? ids : registry.running().map(r => r.id);
      if (targets.length === 0) {
        return { success: true, output: "No running jobs to tail." };
      }
      const unknown = targets.filter(id => !registry.get(id));
      if (unknown.length > 0) {
        return { success: false, output: "", error: `No job matches ${unknown.join(", ")}.` };
      }
      const blocks = targets.map(id => {
        const rec = registry.get(id)!;
        const out = registry.tail(id);
        return `- ${rec.id} [${rec.status.toUpperCase()}]:\n${out || "(no output yet)"}`;
      });
      return { success: true, output: blocks.join("\n\n") };
    }

    if (action === "await") {
      const targets = ids.length ? ids : registry.running().map(r => r.id);
      if (targets.length === 0) {
        return { success: true, output: "No running jobs to await." };
      }
      const timeoutMs = typeof args.timeoutMs === "number" && args.timeoutMs > 0 ? args.timeoutMs : undefined;
      const recs = await registry.awaitIds(targets, timeoutMs);
      const stillRunning = recs.filter(r => r.status === "running").length;
      const head = stillRunning > 0
        ? `Awaited ${recs.length} job(s); ${stillRunning} still running after the ${timeoutMs}ms timeout — await again or cancel.`
        : `Awaited ${recs.length} job(s); all settled.`;
      return { success: stillRunning === 0, output: `${head}\n\n${recs.map(rowLine).join("\n")}` };
    }

    if (action === "cancel") {
      const targets = ids.length ? ids : registry.running().map(r => r.id);
      if (targets.length === 0) {
        return { success: true, output: "No running jobs to cancel." };
      }
      const recs = registry.cancel(targets);
      return { success: true, output: `Cancelled ${recs.length} job(s):\n${recs.map(rowLine).join("\n")}` };
    }

    return { success: false, output: "", error: `Unknown job action '${action}'. Use start | list | tail | await | cancel.` };
  };
}
