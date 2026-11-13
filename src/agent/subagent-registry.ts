/**
 * In-process detached-subagent registry, scoped to one runtime.
 * The synchronous `task` tool blocks the parent until a subagent
 * finishes; a DETACHED launch registers the run here and returns immediately, so
 * the parent can keep working and later list / inspect / await / cancel it via the
 * `subagent` control tool. Concurrency is real (JS event loop): a detached run's
 * awaits interleave with the parent's between steps.
 *
 * Detached runs also support live steering (peer messaging) via `steer()` /
 * `steerDrainFor()` — a running parent (or another subagent, via the `irc` tool)
 * can push a message into a running detached subagent's inbox; the subagent's own
 * agent loop drains it between steps, same mechanism as ordinary task steering.
 *
 * Lifecycle is owned by the session registry — detached subagents survive turn
 * boundaries and remain controllable across prompts in the launch session;
 * `cancelAll()` on session teardown guarantees no background promise leaks.
 */
import type { ToolResult } from "./tools";

/** Maximum un-truncated detached result size in bytes (100 KiB). Outputs exceeding
 *  this are head/tail truncated with an explicit marker and truthful original size. */
export const MAX_DETACHED_RESULT_BYTES = 100 * 1024;

/** Bounded cap for detached subagent output string: byte/char-safe head/tail split
 *  with an explicit truncation marker indicating exact original size. Small outputs
 *  (≤ MAX_DETACHED_RESULT_BYTES) are returned verbatim. */
export function truncateDetachedResult(s: string, maxBytes = MAX_DETACHED_RESULT_BYTES): string {
  if (!s) return "";
  const originalBytes = Buffer.byteLength(s, "utf-8");
  if (originalBytes <= maxBytes) return s;

  const headTargetBytes = Math.floor(maxBytes * 0.6);
  const tailTargetBytes = maxBytes - headTargetBytes;

  let headChars = Math.min(s.length, headTargetBytes);
  let tailChars = Math.min(s.length - headChars, tailTargetBytes);

  while (headChars > 0 && Buffer.byteLength(s.slice(0, headChars), "utf-8") > headTargetBytes) {
    headChars--;
  }
  let headSlice = s.slice(0, headChars);
  if (headSlice.length > 0 && /[\uD800-\uDBFF]$/.test(headSlice)) {
    headSlice = headSlice.slice(0, -1);
  }

  while (tailChars > 0 && Buffer.byteLength(s.slice(s.length - tailChars), "utf-8") > tailTargetBytes) {
    tailChars--;
  }
  let tailSlice = s.slice(s.length - tailChars);
  if (tailSlice.length > 0 && /^[\uDC00-\uDFFF]/.test(tailSlice)) {
    tailSlice = tailSlice.slice(1);
  }

  const omittedBytes = originalBytes - (Buffer.byteLength(headSlice, "utf-8") + Buffer.byteLength(tailSlice, "utf-8"));
  const marker = `\n\n[…output truncated (${omittedBytes} bytes omitted; original size: ${originalBytes} bytes)…]\n\n`;

  return headSlice + marker + tailSlice;
}

export type SubagentStatus = "running" | "paused" | "completed" | "failed" | "cancelled";

export interface SubagentRecord {
  /** Stable id, e.g. "executor-1". */
  id: string;
  role: string;
  /** The assignment text (trimmed for display). */
  task: string;
  status: SubagentStatus;
  startedAt: number;
  finishedAt?: number;
  /** Whether the finished run reported success (contract satisfied). */
  success?: boolean;
  /** Final subagent report/output, set once the run settles. */
  result?: string;
  /** True when delegated execution may have changed workspace state. */
  mutationMayHaveOccurred?: boolean;
  /** Live or last known activity description (e.g. current tool being run). */
  activity?: string;
  /** True when the subagent can be resumed with follow-up instructions. */
  resumable?: boolean;

}


interface Entry {
  record: SubagentRecord;
  promise: Promise<void>;
  abort: AbortController;
  readOnly: boolean;
  settled: boolean;
}

/** A detached run: receives its own AbortSignal and its own registry id, and
 *  resolves to the subagent's final ToolResult. The `id` param lets a runner
 *  wire up its own steer drain (e.g. `registry.steerDrainFor(id)`); runners that
 *  don't need it can ignore the 2nd param. The runner is responsible for
 *  streaming live events itself. */
export type DetachedRunner = (signal: AbortSignal, id: string) => Promise<ToolResult>;

export const DEFAULT_PAUSE_DIRECTIVE =
  "Stop at the next safe boundary and yield. You can be resumed later with more instructions.";
export const DEFAULT_RESUME_MESSAGE = "Continue from where you left off.";

export class SubagentRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly seq = new Map<string, number>();
  private readonly steerInboxes = new Map<string, string[]>();

  /** Register and START a detached run; returns the (running) record immediately. */
  launch(role: string, task: string, runner: DetachedRunner, options: { readOnly?: boolean } = {}): SubagentRecord {
    const n = (this.seq.get(role) ?? 0) + 1;
    this.seq.set(role, n);
    const id = `${role}-${n}`;
    const abort = new AbortController();
    const record: SubagentRecord = {
      id,
      role,
      task: task.length > 200 ? task.slice(0, 197) + "…" : task,
      status: "running",
      startedAt: Date.now(),
    };
    this.steerInboxes.set(id, []);
    const entry: Entry = { record, promise: Promise.resolve(), abort, readOnly: options.readOnly ?? false, settled: false };
    this.entries.set(id, entry);
    entry.promise = (async () => {
      try {
        const res = await runner(abort.signal, id);
        // Preserve structured mutation evidence even when cancellation already fired;
        // the runner may have completed work before its promise settled.
        record.mutationMayHaveOccurred = res.mutationMayHaveOccurred;
        // A cancel that already fired wins — don't overwrite the terminal state.
        if (record.status === "cancelled") return;
        record.status = res.success ? "completed" : "failed";
        record.success = res.success;
        record.resumable = false;
        record.result = truncateDetachedResult(res.output || res.error || "");
      } catch (err) {
        // A mutating runner may throw after a partial workspace change; retain
        // conservative evidence before cancellation can hide the late failure.
        if (!entry.readOnly) record.mutationMayHaveOccurred = true;
        if (record.status === "cancelled") return;
        record.status = "failed";
        record.resumable = false;
        record.result = truncateDetachedResult(err instanceof Error ? err.message : String(err));
      } finally {
        entry.settled = true;
        if (record.finishedAt === undefined) record.finishedAt = Date.now();
        this.steerInboxes.delete(id);
      }

    })();
    return record;
  }

  list(): SubagentRecord[] {
    return [...this.entries.values()].map(e => e.record);
  }

  get(id: string): SubagentRecord | undefined {
    return this.entries.get(id)?.record;
  }

  running(): SubagentRecord[] {
    return this.list().filter(r => r.status === "running");
  }

  /** Runners that have not settled, including pending pause/cancel requests. */
  pending(): SubagentRecord[] {
    return [...this.entries.values()].filter(entry => !entry.settled).map(entry => entry.record);
  }

  /** Return mutating runs whose runner has not settled, including cancelled runs. */
  inFlightMutators(): SubagentRecord[] {
    return [...this.entries.values()].filter(entry => !entry.settled && !entry.readOnly).map(entry => entry.record);
  }

  /** Wait for the given ids (or all running, when empty). With `timeoutMs` the wait
   *  is bounded — unfinished runs simply stay "running" in the returned snapshot. */
  async awaitIds(ids: string[], timeoutMs?: number): Promise<SubagentRecord[]> {
    const targets = ids
      .map(id => this.entries.get(id))
      .filter((e): e is Entry => e !== undefined);
    const all = Promise.all(targets.map(e => e.promise)).then(() => {});
    if (timeoutMs !== undefined && timeoutMs > 0) {
      let handle: ReturnType<typeof setTimeout> | undefined;
      const timer = new Promise<void>(resolve => {
        handle = setTimeout(resolve, timeoutMs);
      });
      await Promise.race([all, timer]);
      if (handle !== undefined) clearTimeout(handle);
    } else {
      await all;
    }
    return targets.map(e => e.record);
  }

  /** Push a live message into a running id's steer inbox (parent → detached subagent,
   *  or subagent → subagent via the `irc` tool). Returns false if the id is unknown,
   *  not running, or the (trimmed) message is empty — true once queued. */
  steer(id: string, message: string): boolean {
    const rec = this.get(id);
    if (!rec || rec.status !== "running") return false;
    const trimmed = message.trim();
    if (!trimmed) return false;
    const inbox = this.steerInboxes.get(id);
    if (!inbox) return false;
    inbox.push(trimmed);
    return true;
  }

  /** A drain closure bound to one id — splices its inbox to empty on each call.
   *  Wire this into a detached runner's own agent-loop `steer` option so pending
   *  messages are picked up between the subagent's own steps. */
  steerDrainFor(id: string): () => string[] {
    return () => {
      const inbox = this.steerInboxes.get(id);
      if (!inbox || inbox.length === 0) return [];
      return inbox.splice(0, inbox.length);
    };
  }


  /** Record an active step or tool description for a subagent id. */
  setActivity(id: string, activity: string | undefined): void {
    const rec = this.get(id);
    if (rec) {
      rec.activity = activity;
    }
  }

  /** Request that one or more running subagents pause at their next safe boundary. */
  pause(ids: string[], directive = DEFAULT_PAUSE_DIRECTIVE): SubagentRecord[] {
    const out: SubagentRecord[] = [];
    const targets = ids.length ? ids : this.running().map(r => r.id);
    for (const id of targets) {
      const rec = this.get(id);
      if (!rec) continue;
      if (rec.status === "running") {
        this.steer(id, directive);
        rec.status = "paused";
        rec.resumable = true;
      }
      out.push(rec);

    }
    return out;
  }

  /** Redirect a still-live run; settled runners cannot be restarted. */
  resume(id: string, message = DEFAULT_RESUME_MESSAGE): { success: boolean; record?: SubagentRecord; error?: string } {
    const rec = this.get(id);
    if (!rec) return { success: false, error: `No subagent matches ${id}.` };
    if (rec.status === "paused") {
      rec.status = "running";
      this.steer(id, message);
      return { success: true, record: rec };
    }
    if (rec.status === "running") {
      this.steer(id, message);
      return { success: true, record: rec };
    }
    return { success: false, record: rec, error: `Cannot resume '${id}': the ${rec.status} run cannot accept instructions. Launch a new task instead.` };
  }

  /** Cancel the given ids (or all running/paused, when empty). Already-terminal
   *  records are returned unchanged; runner settlement remains separately tracked. */
  cancel(ids: string[]): SubagentRecord[] {
    const out: SubagentRecord[] = [];
    const targets = ids.length ? ids : this.pending().filter(rec => rec.status === "running" || rec.status === "paused").map(rec => rec.id);
    for (const id of targets) {
      const e = this.entries.get(id);
      if (!e) continue;
      if (e.record.status === "running" || e.record.status === "paused") {
        e.record.status = "cancelled";
        e.record.finishedAt = Date.now();
        e.record.resumable = false;
        e.abort.abort();
      }
      out.push(e.record);
    }
    return out;
  }

  /** Abort every running or pause-requested subagent during session teardown. */
  cancelAll(): SubagentRecord[] {
    return this.cancel([]);
  }
}
