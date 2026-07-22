/**
 * In-process detached-subagent registry (gjc `subagent`/`job` parity, scoped down
 * to one runtime). The synchronous `task` tool blocks the parent until a subagent
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
 * Lifecycle is bounded to the originating turn: `cancelAll()` requests cooperative
 * abort on teardown. A filesystem operation already committing cannot be rolled back.
 */
import type { ToolResult } from "./tools";

export type SubagentStatus = "running" | "completed" | "failed" | "cancelled";

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
}

interface Entry {
  record: SubagentRecord;
  promise: Promise<void>;
  abort: AbortController;
}

/** A detached run: receives its own AbortSignal and its own registry id, and
 *  resolves to the subagent's final ToolResult. The `id` param lets a runner
 *  wire up its own steer drain (e.g. `registry.steerDrainFor(id)`); runners that
 *  don't need it can ignore the 2nd param. The runner is responsible for
 *  streaming live events itself. */
export type DetachedRunner = (signal: AbortSignal, id: string) => Promise<ToolResult>;

export class SubagentRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly seq = new Map<string, number>();
  private readonly steerInboxes = new Map<string, string[]>();

  /** Register and START a detached run; returns the (running) record immediately. */
  launch(role: string, task: string, runner: DetachedRunner): SubagentRecord {
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
    const promise = (async () => {
      try {
        const res = await runner(abort.signal, id);
        // A cancel that already fired wins — don't overwrite the terminal state.
        if (record.status === "cancelled") return;
        record.status = res.success ? "completed" : "failed";
        record.success = res.success;
        record.result = res.output || res.error || "";
      } catch (err) {
        if (record.status === "cancelled") return;
        record.status = "failed";
        record.result = err instanceof Error ? err.message : String(err);
      } finally {
        if (record.finishedAt === undefined) record.finishedAt = Date.now();
        this.steerInboxes.delete(id);
      }
    })();
    this.entries.set(id, { record, promise, abort });
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

  /** Cancel the given ids (or all running, when empty): aborts the run and marks the
   *  record cancelled. Already-terminal records are returned unchanged. */
  cancel(ids: string[]): SubagentRecord[] {
    const out: SubagentRecord[] = [];
    for (const id of ids) {
      const e = this.entries.get(id);
      if (!e) continue;
      if (e.record.status === "running") {
        e.record.status = "cancelled";
        e.record.finishedAt = Date.now();
        e.abort.abort();
      }
      out.push(e.record);
    }
    return out;
  }

  /** Abort every still-running subagent (turn teardown / Ctrl-C). */
  cancelAll(): SubagentRecord[] {
    return this.cancel(this.running().map(r => r.id));
  }
}
