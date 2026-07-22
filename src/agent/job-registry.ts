/**
 * In-process registry for BACKGROUND shell processes (gjc `job`/async-bash parity,
 * scoped down to one runtime). Unlike the synchronous `bash` tool, `start()` spawns
 * a real parallel OS process via `Bun.spawn` and returns immediately — the parent
 * can keep working and later list / tail / await / cancel it via the `job` control
 * tool while stdout/stderr drain into a bounded buffer in the background.
 *
 * Lifecycle is bounded to the turn that created the registry — `cancelAll()` on
 * turn teardown guarantees no background process leaks into the next turn.
 */

export type JobStatus = "running" | "exited" | "killed" | "failed";
export type MonitorCategory = "log" | "poll" | "watch" | "other";

export interface JobRecord {
  /** Stable id, e.g. "job-1". */
  id: string;
  command: string;
  cwd: string;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  /** Monitor classification; ordinary background jobs use "other". */
  category: MonitorCategory;
  /** Human-readable monitor purpose; ordinary jobs use their command. */
  description: string;
  /** Whether this monitor remains active after its first stdout line. */
  persistent: boolean;
}

export interface MonitorStartOptions {
  category: MonitorCategory;
  description: string;
  persistent?: boolean;
  /** Public monitor timeout in seconds. */
  timeout?: number;
}

export type MonitorJobEvent =
  | { type: "start"; record: JobRecord }
  | { type: "line"; record: JobRecord; line: string }
  | { type: "done"; record: JobRecord };

interface MonitorState {
  lineBuffer: string;
  deliveredLine: boolean;
}

interface Entry {
  record: JobRecord;
  proc?: Bun.Subprocess<"ignore", "pipe", "pipe">;
  promise: Promise<void>;
  monitor?: MonitorState;
  timeout?: ReturnType<typeof setTimeout>;
}

const OUTPUT_CAP = 20000;
const TRUNCATION_MARKER = "[…output truncated…]\n";
const MONITOR_LINE_CAP = 4_000;

export class JobRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly buffers = new Map<string, string>();
  private readonly truncated = new Set<string>();
  private readonly monitorListeners = new Set<(event: MonitorJobEvent) => void>();
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

  private snapshot(record: JobRecord): JobRecord {
    return Object.freeze({ ...record });
  }

  private emit(event: MonitorJobEvent): void {
    for (const listener of this.monitorListeners) {
      try {
        listener(event);
      } catch {
        // Monitor observers are advisory and must not affect process lifecycle.
      }
    }
  }

  private emitMonitor(type: MonitorJobEvent["type"], record: JobRecord, line?: string): void {
    const snapshot = this.snapshot(record);
    if (type === "line") this.emit({ type, record: snapshot, line: line! });
    else this.emit({ type, record: snapshot });
  }

  /**
   * Subscribe to monitor lifecycle events. The returned function removes this
   * listener; exceptions thrown by listeners are ignored.
   */
  subscribeMonitor(listener: (event: MonitorJobEvent) => void): () => void {
    this.monitorListeners.add(listener);
    return () => this.monitorListeners.delete(listener);
  }

  private boundedMonitorLine(line: string): string {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    return normalized.length > MONITOR_LINE_CAP
      ? `${normalized.slice(0, MONITOR_LINE_CAP - 1)}…`
      : normalized;
  }

  private deliverStdout(id: string, chunk: string, flush = false): void {
    const entry = this.entries.get(id);
    if (!entry?.monitor || entry.record.status !== "running") return;

    entry.monitor.lineBuffer += chunk;
    let newline = entry.monitor.lineBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.boundedMonitorLine(entry.monitor.lineBuffer.slice(0, newline));
      entry.monitor.lineBuffer = entry.monitor.lineBuffer.slice(newline + 1);
      if (!entry.monitor.deliveredLine || entry.record.persistent) {
        entry.monitor.deliveredLine = true;
        this.emitMonitor("line", entry.record, line);
        if (!entry.record.persistent) {
          this.cancel([id]);
          return;
        }
      }
      newline = entry.monitor.lineBuffer.indexOf("\n");
    }

    if (flush && entry.monitor.lineBuffer) {
      const line = this.boundedMonitorLine(entry.monitor.lineBuffer);
      entry.monitor.lineBuffer = "";
      if (!entry.monitor.deliveredLine || entry.record.persistent) {
        entry.monitor.deliveredLine = true;
        this.emitMonitor("line", entry.record, line);
        if (!entry.record.persistent) this.cancel([id]);
      }
      return;
    }

    // A command that never terminates a line must not grow registry memory forever.
    if (entry.monitor.lineBuffer.length > OUTPUT_CAP) {
      entry.monitor.lineBuffer = entry.monitor.lineBuffer.slice(-OUTPUT_CAP);
    }
  }

  private spawn(record: JobRecord, monitor = false, timeoutSeconds?: number): JobRecord {
    this.buffers.set(record.id, "");

    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn(["bash", "-c", record.command], {
        cwd: record.cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      record.status = "failed";
      record.finishedAt = Date.now();
      this.append(record.id, err instanceof Error ? err.message : String(err));
      this.entries.set(record.id, { record, promise: Promise.resolve(), monitor: monitor ? { lineBuffer: "", deliveredLine: false } : undefined });
      if (monitor) {
        this.emitMonitor("start", record);
        this.emitMonitor("done", record);
      }
      return record;
    }

    const drain = async (stream: ReadableStream<Uint8Array>, stdout: boolean) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true });
        this.append(record.id, text);
        if (stdout) this.deliverStdout(record.id, text);
      }
      const final = decoder.decode();
      this.append(record.id, final);
      if (stdout) this.deliverStdout(record.id, final, true);
    };

    const entry: Entry = {
      record,
      proc,
      promise: Promise.resolve(),
      monitor: monitor ? { lineBuffer: "", deliveredLine: false } : undefined,
    };
    this.entries.set(record.id, entry);

    entry.promise = (async () => {
      try {
        await Promise.all([drain(proc.stdout, true), drain(proc.stderr, false)]);
        const exitCode = await proc.exited;
        if (record.status !== "killed") {
          record.status = "exited";
          record.exitCode = exitCode;
        }
      } catch (err) {
        if (record.status !== "killed") {
          record.status = "failed";
          this.append(record.id, err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (entry.timeout !== undefined) clearTimeout(entry.timeout);
        if (record.finishedAt === undefined) record.finishedAt = Date.now();
        if (monitor) this.emitMonitor("done", record);
      }
    })();

    if (monitor) {
      if (timeoutSeconds !== undefined) {
        const timeout = setTimeout(() => this.cancel([record.id]), timeoutSeconds * 1000);
        timeout.unref?.();
        entry.timeout = timeout;
      }
      this.emitMonitor("start", record);
    }
    return record;
  }

  /** Spawn and START a background OS process; returns the (running) record immediately. */
  start(command: string, cwd: string): JobRecord {
    this.seq += 1;
    return this.spawn({
      id: `job-${this.seq}`,
      command,
      cwd,
      status: "running",
      startedAt: Date.now(),
      category: "other",
      description: command,
      persistent: false,
    });
  }

  /** Start a monitor using the same bounded process and output lifecycle as `start()`. */
  startMonitor(command: string, cwd: string, options: MonitorStartOptions): JobRecord {
    this.seq += 1;
    return this.spawn({
      id: `job-${this.seq}`,
      command,
      cwd,
      status: "running",
      startedAt: Date.now(),
      category: options.category,
      description: options.description,
      persistent: options.persistent ?? false,
    }, true, options.timeout);
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

  /** Cancel the given ids: SIGTERM via `proc.kill()` and mark killed. Already-terminal
   *  records are returned unchanged. */
  cancel(ids: string[]): JobRecord[] {
    const out: JobRecord[] = [];
    for (const id of ids) {
      const e = this.entries.get(id);
      if (!e) continue;
      if (e.record.status === "running") {
        e.record.status = "killed";
        e.record.finishedAt = Date.now();
        if (e.timeout !== undefined) {
          clearTimeout(e.timeout);
          e.timeout = undefined;
        }
        e.proc?.kill();
      }
      out.push(e.record);
    }
    return out;
  }

  /** Kill every still-running job (turn teardown / Ctrl-C). */
  cancelAll(): JobRecord[] {
    return this.cancel(this.running().map(r => r.id));
  }
}
