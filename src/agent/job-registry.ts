/**
 * In-process registry for BACKGROUND shell processes (gjc `job`/async-bash parity,
 * scoped down to one runtime). Unlike the synchronous `bash` tool, `start()` spawns
 * a real parallel OS process via `Bun.spawn` and returns immediately — the parent
 * can keep working and later list / tail / await / cancel it via the `job` control
 * tool while stdout/stderr drain into a bounded buffer in the background.
 *
 * Lifecycle is owned by the launch session — jobs survive turn boundaries and remain
 * controllable across prompts; `cancelAll()` on session teardown prevents leaks.
 *
 * `cancelAll()` is also safe for explicit Ctrl-C cleanup.
 *
 */

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
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  promise: Promise<void>;
  cancel?: () => void;
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

    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn(["bash", "-c", command], {
        cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        ...(process.platform !== "win32" ? { detached: true } : {}),
      });
    } catch (err) {
      record.status = "failed";
      record.finishedAt = Date.now();
      this.append(id, err instanceof Error ? err.message : String(err));
      this.pendingMutations.add(id);
      // No process handle to store — nothing further to drain or cancel.
      this.entries.set(id, { record, proc: undefined as any, promise: Promise.resolve() });
      return record;
    }
    this.active.add(id);

    const stdoutReader = proc.stdout.getReader();
    const stderrReader = proc.stderr.getReader();
    const cancelReaders = () => {
      void stdoutReader.cancel().catch(() => {});
      void stderrReader.cancel().catch(() => {});
    };
    const cancel = () => {
      if (process.platform !== "win32") {
        try { process.kill(-proc.pid, "SIGKILL"); return; } catch { /* fall back to the shell */ }
      }
      try { proc.kill(9); } catch { /* already exited */ }
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
    const drains = Promise.all([drain(stdoutReader), drain(stderrReader)]);
    void drains.catch(() => {});

    const promise = (async () => {
      try {
        const exitCode = await proc.exited;
        let lingerTimer: NodeJS.Timeout | undefined;
        const drained = await Promise.race([
          drains.then(() => true),
          new Promise<false>(resolve => { lingerTimer = setTimeout(() => resolve(false), PIPE_LINGER_MS); }),
        ]);
        clearTimeout(lingerTimer);
        if (!drained) {
          cancelReaders();
          await drains;
          if (record.status !== "killed") {
            record.status = "failed";
            record.exitCode = exitCode;
            this.append(id, "\n[job output incomplete: a descendant kept stdout or stderr open after the shell exited]\n");
            return;
          }
        }
        if (record.status === "killed") return;
        record.status = "exited";
        record.exitCode = exitCode;
      } catch (err) {
        if (record.status === "killed") return;
        record.status = "failed";
        this.append(id, err instanceof Error ? err.message : String(err));
      } finally {
        await proc.exited;
        this.active.delete(id);
        this.pendingMutations.add(id);
        if (record.finishedAt === undefined) record.finishedAt = Date.now();
      }
    })();

    this.entries.set(id, { record, proc, promise, cancel });
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
      if (e.record.status === "running") {
        e.record.status = "killed";
        e.record.finishedAt = Date.now();
        e.cancel?.();
      }
      out.push(e.record);
    }
    return out;
  }

  /** Kill every still-running job (session teardown / Ctrl-C). */
  cancelAll(): JobRecord[] {
    return this.cancel(this.running().map(r => r.id));
  }
}
