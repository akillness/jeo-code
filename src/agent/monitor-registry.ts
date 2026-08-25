/**
 * In-process registry for line-oriented background monitor commands.
 *
 * Monitors are real background OS processes, but unlike jobs they surface each
 * stdout/stderr line immediately through `onLine`. A non-persistent monitor is
 * intentionally one-shot: its process is killed after the first emitted line.
 * The launch session owns each registry; monitors survive turn boundaries until
 * `cancelAll()` is called during explicit session teardown.
 */

export type MonitorStatus = "running" | "exited" | "killed" | "failed";

export interface MonitorRecord {
  /** Stable id, e.g. `monitor-1`. */
  id: string;
  command: string;
  cwd: string;
  status: MonitorStatus;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  /** Persistent monitors continue after the first output line. */
  persistent: boolean;
}

export type MonitorLineHandler = (record: MonitorRecord, line: string) => void | Promise<void>;

export interface MonitorRegistryOptions {
  /** Called once for every complete stdout/stderr line. */
  onLine?: MonitorLineHandler;
}

interface Entry {
  record: MonitorRecord;
  proc?: Bun.Subprocess<"ignore", "pipe", "pipe">;
  promise: Promise<void>;
}

const OUTPUT_CAP = 20_000;
const TRUNCATION_MARKER = "[…output truncated…]\n";

export class MonitorRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly buffers = new Map<string, string>();
  private readonly truncated = new Set<string>();
  private readonly onLine?: MonitorLineHandler;
  private seq = 0;
  constructor(options: MonitorRegistryOptions | MonitorLineHandler = {}) {
    this.onLine = typeof options === "function" ? options : options.onLine;
  }

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

  private async emit(record: MonitorRecord, line: string): Promise<void> {
    try {
      await this.onLine?.(record, line);
    } catch {
      // A UI/event sink must never turn a monitor's settled process into an
      // unhandled rejection. The monitor output remains available through tail.
    }
  }

  private stopAfterFirstLine(entry: Entry): void {
    if (entry.record.status !== "running") return;
    entry.record.status = "killed";
    entry.record.finishedAt = Date.now();
    try {
      entry.proc?.kill();
    } catch {
      // The process may have exited between the line event and kill().
    }
  }

  private async drain(entry: Entry, stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true });
        this.append(entry.record.id, text);
        pending += text;
        while (true) {
          const match = pending.match(/(?:\r\n|\n|\r)/);
          if (!match || match.index === undefined) break;
          const line = pending.slice(0, match.index);
          pending = pending.slice(match.index + match[0].length);
          if (entry.record.status !== "running") return;
          await this.emit(entry.record, line);
          if (!entry.record.persistent) {
            this.stopAfterFirstLine(entry);
            return;
          }
        }
      }
      const tail = decoder.decode();
      if (tail) {
        this.append(entry.record.id, tail);
        pending += tail;
      }
      if (pending.length > 0 && entry.record.status === "running") {
        await this.emit(entry.record, pending);
        if (!entry.record.persistent) this.stopAfterFirstLine(entry);
      }
    } catch {
      // SIGTERM commonly closes a Bun stream with an iteration error. Cancellation
      // is a normal terminal path, not a rejected monitor promise.
    }
  }

  /** Spawn and start a monitor; returns its running record immediately. */
  start(command: string, cwd: string, persistentOrOptions: boolean | { persistent?: boolean } = false): MonitorRecord {
    this.seq += 1;
    const id = `monitor-${this.seq}`;
    const persistent = typeof persistentOrOptions === "boolean"
      ? persistentOrOptions
      : persistentOrOptions.persistent === true;
    const record: MonitorRecord = {
      id,
      command,
      cwd,
      status: "running",
      startedAt: Date.now(),
      persistent,
    };
    this.buffers.set(id, "");

    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn(["bash", "-c", command], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (err) {
      record.status = "failed";
      record.finishedAt = Date.now();
      this.append(id, err instanceof Error ? err.message : String(err));
      const failed: Entry = { record, promise: Promise.resolve() };
      this.entries.set(id, failed);
      return record;
    }

    const entry = { record, proc, promise: Promise.resolve() } as Entry;
    this.entries.set(id, entry);
    entry.promise = (async () => {
      try {
        await Promise.all([this.drain(entry, proc.stdout), this.drain(entry, proc.stderr)]);
        const exitCode = await proc.exited;
        if (record.status === "killed") return;
        record.status = "exited";
        record.exitCode = exitCode;
      } catch (err) {
        if (record.status === "killed") return;
        record.status = "failed";
        this.append(id, err instanceof Error ? err.message : String(err));
      } finally {
        if (record.finishedAt === undefined) record.finishedAt = Date.now();
      }
    })();
    // Keep the promise observed even when callers only use list/tail; all paths
    // above handle process and stream errors so this never becomes unhandled.
    void entry.promise.catch(() => undefined);
    return record;
  }

  list(): MonitorRecord[] {
    return [...this.entries.values()].map(e => e.record);
  }

  get(id: string): MonitorRecord | undefined {
    return this.entries.get(id)?.record;
  }

  running(): MonitorRecord[] {
    return this.list().filter(r => r.status === "running");
  }

  /** Current buffered stdout/stderr for one monitor. */
  tail(id: string): string {
    return this.buffers.get(id) ?? "";
  }

  /** Wait for the given ids. A positive timeout leaves unfinished records running. */
  async awaitIds(ids: string[], timeoutMs?: number): Promise<MonitorRecord[]> {
    const targets = ids
      .map(id => this.entries.get(id))
      .filter((entry): entry is Entry => entry !== undefined);
    const all = Promise.all(targets.map(entry => entry.promise)).then(() => undefined);
    if (timeoutMs !== undefined && timeoutMs > 0) {
      let handle: ReturnType<typeof setTimeout> | undefined;
      const timer = new Promise<void>(resolve => {
        handle = setTimeout(resolve, timeoutMs);
      });
      await Promise.race([all, timer]);
      clearTimeout(handle);
    } else {
      await all;
    }
    return targets.map(entry => entry.record);
  }

  /** Kill the given monitors. Already-terminal records are returned unchanged. */
  cancel(ids: string[]): MonitorRecord[] {
    const out: MonitorRecord[] = [];
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      if (entry.record.status === "running") {
        entry.record.status = "killed";
        entry.record.finishedAt = Date.now();
        try {
          entry.proc?.kill();
        } catch {
          // Process exited concurrently; the terminal state is already correct.
        }
      }
      out.push(entry.record);
    }
    return out;
  }

  /** Kill every monitor still running at session teardown / Ctrl-C. */
  cancelAll(): MonitorRecord[] {
    return this.cancel(this.running().map(record => record.id));
  }
}
