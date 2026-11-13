/**
 * `subagent` control tool (#9) — the parent's handle on DETACHED subagents launched
 * via `task {detached:true}`. Uses an in-process registry to
 * list, inspect, await (optionally bounded), cancel, and
 * steer (live peer messaging into a single running subagent).
 *
 * Pause is a cooperative wrap-up request, not a suspended execution checkpoint.
 * Resume redirects a still-live run; settled runs require a new task. Live peer
 * messaging to/among ALL running subagents is the `irc` tool, on registry.steer().
 */
import type { ToolHandler } from "./engine";
import type { ToolResult } from "./tools";
import type { SubagentRegistry, SubagentRecord } from "./subagent-registry";

function mutationEvidence(recs: readonly SubagentRecord[]): boolean | undefined {
  return recs.some(rec => rec.mutationMayHaveOccurred === true) ? true : undefined;
}

export type SubagentVerbosity = "receipt" | "preview" | "full";

const DEFAULT_VERBOSITY: SubagentVerbosity = "preview";
const DEFAULT_LIST_LIMIT = 10;
const MAX_LIST_LIMIT = 50;
const PREVIEW_CHARS = 2_000;
const FULL_CHARS = 12_000;


/** One-line protocol description appended to the launch system prompt. */
export const SUBAGENT_TOOL_PROTOCOL_LINE =
  `subagent {action:"list"|"inspect"|"await"|"cancel"|"steer"|"pause"|"resume", ids?, id?, message?, verbosity?:"receipt"|"preview"|"full", limit?:number, timeoutMs?} — control DETACHED ` +
  `subagents started with task{detached:true}. 'await' blocks and returns reports; 'inspect' shows status + result; 'cancel' aborts; 'steer' injects live instructions into running subagents; ` +
  `'pause' asks running subagents to wrap up safely; 'resume' redirects a still-live paused/running subagent (settled runs require a new task). ` +
  `'verbosity' controls result length ('receipt' status-only, 'preview' <=2000 chars, 'full' <=12000 chars); 'limit' caps listings.`;

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

function isValidId(id: string): boolean {
  return SAFE_ID_RE.test(id);
}

function elapsed(rec: SubagentRecord): string {
  const end = rec.finishedAt ?? Date.now();
  return `${Math.max(0, Math.round((end - rec.startedAt) / 1000))}s`;
}

function rowLine(rec: SubagentRecord): string {
  const parts = [`- ${rec.id} [${rec.status.toUpperCase()}] ${elapsed(rec)} · ${rec.task}`];
  if (rec.activity) parts.push(`(${rec.activity})`);
  return parts.join(" ");
}

function detailBlock(rec: SubagentRecord, verbosity?: SubagentVerbosity): string {
  const head = rowLine(rec);
  if (rec.status === "running" && !rec.result) return head;
  if (verbosity === "receipt") return head;
  const rawResult = rec.result ?? "";
  if (verbosity === "preview" && rawResult.length > PREVIEW_CHARS) {
    const text = `${rawResult.slice(0, PREVIEW_CHARS - 1)}… [truncated, use verbosity:"full"]`;
    return `${head}\n${text}`;
  }
  return rawResult ? `${head}\n${rawResult}` : head;
}


function idsOf(args: Record<string, any>): string[] {
  if (Array.isArray(args.ids)) return args.ids.map((x: unknown) => String(x)).filter(isValidId);
  if (args.id !== undefined) {
    const s = String(args.id);
    return isValidId(s) ? [s] : [];
  }
  return [];
}

function clampLimit(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(value)));
}

export function createSubagentTool(registry: SubagentRegistry): ToolHandler {
  return async (args: Record<string, any>, _cwd: string): Promise<ToolResult> => {
    const action = String(args.action ?? "list").trim().toLowerCase();
    const invalidId = args.id !== undefined && (typeof args.id !== "string" || !isValidId(args.id));
    const invalidIds = args.ids !== undefined && (!Array.isArray(args.ids) || args.ids.some((id: unknown) => typeof id !== "string" || !isValidId(id)));
    if (invalidId || invalidIds) {
      return { success: false, output: "", error: invalidId ? "Invalid subagent id: expected a valid identifier (letters, digits, '_' or '-')." : "Invalid subagent ids: expected an array of valid identifiers (letters, digits, '_' or '-')." };
    }
    const ids = idsOf(args);
    const verbosity: SubagentVerbosity | undefined = ["receipt", "preview", "full"].includes(args.verbosity) ? args.verbosity : undefined;

    if (verbosity === "full" && action === "list") {
      return {
        success: false,
        output: "",
        error: "verbosity='full' is not permitted with action='list' to protect context budget. Use action='inspect' with explicit id(s).",
      };
    }


    if (action === "list") {
      const rows = registry.list();
      if (rows.length === 0) {
        return { success: true, output: "No detached subagents in this session. Launch one with task {detached:true}." };
      }
      const limit = clampLimit(args.limit);
      const sorted = [...rows].reverse(); // newest first
      const visible = sorted.slice(0, limit);
      const running = rows.filter(r => r.status === "running").length;
      const paused = rows.filter(r => r.status === "paused").length;
      const truncatedMsg = rows.length > limit ? `\n(… ${rows.length - limit} older subagent(s) omitted; specify limit or explicit ids)` : "";
      return {
        success: true,
        output: `${rows.length} subagent(s) (${running} running, ${paused} paused):\n${visible.map(rowLine).join("\n")}${truncatedMsg}`,
        mutationMayHaveOccurred: mutationEvidence(rows),
      };

    }

    if (action === "inspect") {
      const targets = (ids.length ? ids.map(id => registry.get(id)) : registry.list())
        .filter((r): r is SubagentRecord => r !== undefined);
      if (targets.length === 0) {
        return {
          success: false,
          output: "",
          error: ids.length ? `No subagent matches ${ids.join(", ")}.` : "No detached subagents in this session.",
        };
      }
      const limit = ids.length ? targets.length : clampLimit(args.limit);
      const visible = targets.slice(0, limit);

      return {
        success: true,
        output: visible.map(r => detailBlock(r, verbosity)).join("\n\n"),
        mutationMayHaveOccurred: mutationEvidence(targets),
      };
    }


    if (action === "await") {
      const targets = ids.length ? ids : registry.pending().map(r => r.id);
      if (targets.length === 0) {
        return { success: true, output: "No pending subagents to await." };
      }
      const timeoutMs = typeof args.timeoutMs === "number" && args.timeoutMs > 0 ? args.timeoutMs : undefined;
      const recs = await registry.awaitIds(targets, timeoutMs);
      const pendingIds = new Set(registry.pending().map(r => r.id));
      const stillPending = recs.filter(r => pendingIds.has(r.id)).length;
      const head = stillPending > 0
        ? `Awaited ${recs.length} subagent(s); ${stillPending} still pending after the ${timeoutMs}ms timeout — await again, resume, or cancel.`
        : `Awaited ${recs.length} subagent(s); all settled.`;
      return {
        success: stillPending === 0,
        output: `${head}\n\n${recs.map(r => detailBlock(r, verbosity)).join("\n\n")}`,
        mutationMayHaveOccurred: mutationEvidence(recs),
      };
    }


    if (action === "pause") {
      const targets = ids.length ? ids : registry.running().map(r => r.id);
      if (targets.length === 0) {
        return { success: true, output: "No running subagents to pause." };
      }
      const message = typeof args.message === "string" && args.message.trim() ? args.message.trim() : undefined;
      const paused = registry.pause(targets, message);
      return { success: true, output: `Paused ${paused.length} subagent(s):\n${paused.map(rowLine).join("\n")}` };
    }

    if (action === "resume") {
      if (ids.length !== 1) {
        return {
          success: false,
          output: "",
          error: `subagent 'resume' requires exactly one target id (e.g. {action:"resume", id:"executor-1"}). Got: ${JSON.stringify(args.id || args.ids)}.`,
        };
      }
      const id = ids[0]!;
      const message = typeof args.message === "string" && args.message.trim() ? args.message.trim() : undefined;
      const res = registry.resume(id, message);
      if (!res.success) {
        return { success: false, output: "", error: res.error || `Failed to resume subagent '${id}'.` };
      }
      return { success: true, output: `Resumed subagent '${id}' (${res.record?.status}): ${message ?? "resumed with default message"}` };
    }

    if (action === "cancel") {
      const recs = registry.cancel(ids);
      if (recs.length === 0) {
        return { success: true, output: "No running or paused subagents to cancel." };
      }
      return {
        success: true,
        output: `Cancelled ${recs.length} subagent(s):\n${recs.map(rowLine).join("\n")}`,
        mutationMayHaveOccurred: mutationEvidence(recs),
      };
    }

    if (action === "steer") {
      const targetIds = Array.isArray(args.id) ? [] : args.id !== undefined ? [String(args.id)] : [];
      const message = typeof args.message === "string" ? args.message : typeof args.text === "string" ? args.text : "";
      if (targetIds.length !== 1) {
        return {
          success: false,
          output: "",
          error: `subagent 'steer' requires exactly one target 'id' (a single string, not 'ids'). Got: ${JSON.stringify(args.id)}.`,
        };
      }
      const id = targetIds[0]!;
      if (!isValidId(id)) {
        return { success: false, output: "", error: `Invalid subagent id '${id}'.` };
      }
      if (!message.trim()) {
        return { success: false, output: "", error: "subagent 'steer' requires a non-empty 'message' (or 'text')." };
      }
      const ok = registry.steer(id, message);
      if (!ok) {
        return { success: false, output: "", error: `Cannot steer '${id}': no running subagent with that id.` };
      }
      return { success: true, output: `Steered ${id}: ${message.trim()}` };
    }

    return {
      success: false,
      output: "",
      error: `Unknown subagent action '${action}'. Use list | inspect | await | cancel | steer | pause | resume.`,
    };
  };
}
