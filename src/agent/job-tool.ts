/**
 * `job` control tool — the parent's handle on BACKGROUND shell processes launched
 * via `job {action:"start"}`. Mirrors gjc's `job`/async-bash control surface, scoped
 * to an in-process registry: start, list, tail, await (optionally bounded), and cancel.
 */
import type { ToolHandler } from "./engine";
import type { ToolResult } from "./tools";
import type { JobRegistry, JobRecord } from "./job-registry";
import { settlesWithin } from "./shell-lease";

/** Upper bound on pipe-linger, escape detection and notice-queue drain after a cancel. */
const CANCEL_SETTLE_MS = 3000;

/** One-line protocol description appended to the launch system prompt. */
export const JOB_TOOL_PROTOCOL_LINE =
  `job {action:"start", command, cwd?} runs a shell command in the BACKGROUND as a real ` +
  `parallel OS process and returns a job id immediately. job {action:"list"|"tail"|"await"|"cancel", ` +
  `ids?, timeoutMs?} — 'tail' shows buffered output so far; 'await' blocks (optionally up to timeoutMs ` +
  `ms) until it exits; 'cancel' kills it; omit ids to target all running, plus unreported completions for 'await'.`;

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function elapsed(rec: JobRecord): string {
  const end = rec.finishedAt ?? Date.now();
  return `${Math.max(0, Math.round((end - rec.startedAt) / 1000))}s`;
}

function rowLine(rec: JobRecord): string {
  const exit = rec.exitCode != null ? ` (exit code ${rec.exitCode})` : "";
  return `- ${rec.id} [${rec.status.toUpperCase()}]${exit} ${elapsed(rec)} · ${truncate(rec.command, 100)}`;
}

function idsOf(args: Record<string, any>): string[] {
  if (Array.isArray(args.ids)) return args.ids.map((x: unknown) => String(x));
  if (args.id !== undefined) return [String(args.id)];
  return [];
}

export function createJobTool(registry: JobRegistry, reportMutations = true): ToolHandler {
  const handle: ToolHandler = async (args: Record<string, any>, cwd: string): Promise<ToolResult> => {
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
        return { success: true, output: `No background jobs in this session. Launch one with job {action:"start", command}.` };
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
      const targets = ids.length ? ids : registry.awaiting().map(r => r.id);
      if (targets.length === 0) {
        return { success: true, output: "No jobs to await." };
      }
      const unknown = targets.filter(id => !registry.get(id));
      if (unknown.length > 0) {
        return { success: false, output: "", error: `No job matches ${unknown.join(", ")}.` };
      }
      const timeoutMs = typeof args.timeoutMs === "number" && args.timeoutMs > 0 ? args.timeoutMs : undefined;
      const recs = await registry.awaitIds(targets, timeoutMs);
      if (reportMutations) registry.markReported(recs);
      const stillRunning = recs.filter(r => r.status === "running").length;
      const head = stillRunning > 0
        ? `Awaited ${recs.length} job(s); ${stillRunning} still running after the ${timeoutMs}ms timeout — await again or cancel.`
        : `Awaited ${recs.length} job(s); all settled.`;
      const success = recs.every(r => r.status === "exited" && r.exitCode === 0);
      return { success, output: `${head}\n\n${recs.map(rowLine).join("\n")}\n\nUse job {action:"tail", ids:[...]} to inspect output.` };
    }

    if (action === "cancel") {
      const cancellable = new Set(registry.cancellable().map(r => r.id));
      const targets = ids.length ? [...new Set(ids)] : [...cancellable];
      if (targets.length === 0) {
        return { success: true, output: "No running jobs to cancel." };
      }
      const unknown = targets.filter(id => !registry.get(id));
      if (unknown.length > 0) {
        return { success: false, output: "", error: `No job matches ${unknown.join(", ")}.` };
      }
      const attempted = targets.filter(id => cancellable.has(id));
      const recs = registry.cancel(targets);
      // A delivered SIGKILL is only verified once the output pipes close; settlement can still
      // downgrade `killed` to `failed` (a holder that left the group), so wait before judging.
      const settled = attempted.length === 0 || await settlesWithin(registry.awaitIds(attempted), CANCEL_SETTLE_MS);
      const failed = recs.filter(r => cancellable.has(r.id) && (!settled || r.status !== "killed")).length;
      const head = attempted.length ? `Cancelled ${attempted.length - failed} job(s); ${failed} cancellation(s) failed; ${recs.length - attempted.length} already settled.` : "No running jobs to cancel; requested jobs are already settled.";
      return { success: failed === 0, output: `${head}\n${recs.map(rowLine).join("\n")}`, mutationMayHaveOccurred: attempted.length > 0 };
    }

    return { success: false, output: "", error: `Unknown job action '${action}'. Use start | list | tail | await | cancel.` };
  };
  return async (args, cwd) => {
    const action = String(args.action ?? "list").trim().toLowerCase();
    const ids = idsOf(args);
    const targets = action === "list" ? registry.list().map(r => r.id)
      : action === "await" ? (ids.length ? ids : registry.awaiting().map(r => r.id))
      : action === "tail" ? (ids.length ? ids : registry.running().map(r => r.id))
      : action === "cancel" ? (ids.length ? ids : registry.cancellable().map(r => r.id))
      : [];
    const result = await handle(args, cwd);
    if (reportMutations && !result.error && registry.consumeMutations(targets)) result.mutationMayHaveOccurred = true;
    return result;
  };
}
