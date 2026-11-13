/**
 * In-process registry for BACKGROUND shell processes, scoped to one runtime.
 * Unlike the synchronous `bash` tool, `start()` spawns
 * a real parallel OS process (see `shell-lease.ts`) and returns immediately — the parent
 * can keep working and later list / tail / await / cancel it via the `job` control
 * tool while stdout/stderr drain into a bounded buffer in the background.
 *
 * Lifecycle is owned by the launch session — jobs survive turn boundaries and remain
 * controllable across prompts; `cancelAll()` on session teardown prevents leaks.
 *
 * `cancelAll()` is also safe for explicit Ctrl-C cleanup.
 *
 */

import { settlesWithin, spawnLeasedShell, type LeasedShell } from "./shell-lease";

export type JobStatus = "running" | "exited" | "killed" | "failed";

export interface JobRecord {
  /** Stable id, e.g. "job-1". */
  id: string;
  command: string;
  cwd: string;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
}

interface Entry {
  record: JobRecord;
  promise: Promise<void>;
  cancel?: () => boolean;
  /** SIGKILL reached the pinned process group. */
  killDelivered?: boolean;
  /** Termination of every process holding the job's group or pipes cannot be confirmed. */
  incomplete?: boolean;
}

const OUTPUT_CAP = 20000;
const TRUNCATION_MARKER = "[…output truncated…]\n";
const PIPE_LINGER_MS = 500;

export class JobRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly buffers = new Map<string, string>();
  private readonly truncated = new Set<string>();
  private readonly reported = new Set<string>();
  private readonly pendingMutations = new Set<string>();
  private readonly active = new Set<string>();
  private seq = 0;

  private append(id: string, chunk: string): void {
    if (!chunk) return;
    let buf = (this.buffers.get(id) ?? "") + chunk;
    if (buf.length > OUTPUT_CAP) {
      buf = buf.slice(buf.length - OUTPUT_CAP);
      if (!this.truncated.has(id)) {
        this.truncated.add(id);
        buf = TRUNCATION_MARKER + buf;
      }
    }
    this.buffers.set(id, buf);
  }

  /** Spawn and START a background OS process; returns the (running) record immediately. */
  start(command: string, cwd: string): JobRecord {
    this.seq += 1;
    const id = `job-${this.seq}`;
    const record: JobRecord = {
      id,
      command,
      cwd,
      status: "running",
      startedAt: Date.now(),
    };
    this.buffers.set(id, "");

    let shell: LeasedShell;
    try {
      shell = spawnLeasedShell(command, cwd);
    } catch (err) {
      record.status = "failed";
      record.finishedAt = Date.now();
      this.append(id, err instanceof Error ? err.message : String(err));
      this.pendingMutations.add(id);
      // No process handle to store — nothing further to drain or cancel.
      this.entries.set(id, { record, promise: Promise.resolve() });
      return record;
    }
    this.active.add(id);

    const entry: Entry = { record, promise: Promise.resolve() };
    entry.cancel = (): boolean => {
      const outcome = shell.killGroup();
      if (outcome === "delivered") { entry.killDelivered = true; return true; }
      entry.incomplete = true;
      this.append(id, outcome === "unpinned"
        ? "\n[job process group is no longer pinned; termination cannot be confirmed]\n"
        : outcome === "unsupported"
          ? "\n[job process tree termination cannot be confirmed on Windows]\n"
          : `\n[job process group termination attempt failed: ${String(outcome.error)}]\n`);
      shell.killDirect();
      return false;
    };
    const drain = async (reader: { read: () => Promise<{ done?: boolean; value?: Uint8Array }> }) => {
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) this.append(id, decoder.decode(value, { stream: true }));
      }
      this.append(id, decoder.decode());
    };
    const drains = Promise.all([drain(shell.stdout), drain(shell.stderr)]);
    void drains.catch(() => {});

    const promise = (async () => {
      try {
        const exitCode = await shell.exit;
        let lingered = false;
        if (!(await settlesWithin(drains, PIPE_LINGER_MS))) {
          lingered = true;
          // A descendant still holds stdout/stderr. Only the pinned group may be signalled; if EOF does
          // not follow the delivered SIGKILL, the holder left the group and stays unresolved.
          if ((entry.killDelivered || entry.cancel!()) && !(await settlesWithin(drains, PIPE_LINGER_MS))) {
            entry.incomplete = true;
            this.append(id, "\n[job pipe remains open outside the process group; termination cannot be confirmed]\n");
          }
          shell.dispose();
          await drains;
        }
        if (exitCode === null && !entry.killDelivered && !entry.incomplete) {
          entry.incomplete = true;
          this.append(id, "\n[job process group lease ended without an exit report; termination cannot be confirmed]\n");
        }
        if (record.status === "killed" && !entry.incomplete) return;
        if (!lingered && !entry.incomplete) {
          record.status = "exited";
          record.exitCode = exitCode;
          return;
        }
        record.status = "failed";
        record.exitCode = exitCode;
        if (lingered) this.append(id, "\n[job output incomplete: a descendant kept stdout or stderr open after the shell exited]\n");
      } catch (err) {
        // Output can no longer be observed: stop the group now so the holder can be reaped.
        if (!entry.killDelivered) entry.cancel!();
        if (record.status === "killed") return;
        record.status = "failed";
        this.append(id, err instanceof Error ? err.message : String(err));
      } finally {
        shell.release();
        await shell.reaped;
        shell.dispose();
        if (!entry.incomplete) this.active.delete(id);
        this.pendingMutations.add(id);
        if (record.finishedAt === undefined) record.finishedAt = Date.now();
      }
    })();

    entry.promise = promise;
    this.entries.set(id, entry);
    return record;
  }

  list(): JobRecord[] {
    return [...this.entries.values()].map(e => e.record);
  }

  get(id: string): JobRecord | undefined {
    return this.entries.get(id)?.record;
  }

  running(): JobRecord[] {
    return this.list().filter(r => r.status === "running");
  }

  /** Include running jobs and terminal jobs not yet reported by await. */
  awaiting(): JobRecord[] {
    return this.list().filter(r => r.status === "running" || !this.reported.has(r.id));
  }

  markReported(records: JobRecord[]): void {
    for (const record of records) {
      if (record.status !== "running") this.reported.add(record.id);
    }
  }

  /** Report each process completion once to invalidate earlier verification. */
  consumeMutations(ids?: string[]): boolean {
    if (ids === undefined) {
      const pending = this.pendingMutations.size > 0;
      this.pendingMutations.clear();
      return pending;
    }
    let pending = false;
    for (const id of ids) pending = this.pendingMutations.delete(id) || pending;
    return pending;
  }

  /** Processes not yet settled or whose completion has not reached the engine. */
  unobserved(): JobRecord[] {
    return this.list().filter(record => this.active.has(record.id) || this.pendingMutations.has(record.id));
  }

  /** Current buffered output for one job (empty string if the id is unknown). */
  tail(id: string): string {
    return this.buffers.get(id) ?? "";
  }

  /** Wait for the given ids. With `timeoutMs` the wait is bounded — unfinished jobs
   *  simply stay "running" in the returned snapshot. */
  async awaitIds(ids: string[], timeoutMs?: number): Promise<JobRecord[]> {
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

  /** Cancel the process group on POSIX, or the direct process on Windows. */
  cancel(ids: string[]): JobRecord[] {
    const out: JobRecord[] = [];
    for (const id of ids) {
      const e = this.entries.get(id);
      if (!e) continue;
      if (e.incomplete) { out.push(e.record); continue; }
      if (e.record.status === "running") {
        const killed = e.cancel?.();
        e.record.status = killed ? "killed" : "failed";
        e.record.finishedAt = Date.now();
      }
      out.push(e.record);
    }
    return out;
  }

  /** Include unresolved process groups even if their shell has exited. */
  cancellable(): JobRecord[] {
    return this.list().filter(r => r.status === "running" || this.entries.get(r.id)?.incomplete);
  }

  /** Kill every still-running job (session teardown / Ctrl-C). */
  cancelAll(): JobRecord[] {
    return this.cancel(this.cancellable().map(r => r.id));
  }
}
