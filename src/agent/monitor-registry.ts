/**
 * In-process registry for line-oriented background monitor commands.
 *
 * Monitors are real background OS processes, but unlike jobs they surface each
 * stdout/stderr line immediately through `onLine`. A non-persistent monitor is
 * intentionally one-shot: its process is killed after the first emitted line.
 * The launch session owns each registry; monitors survive turn boundaries until
 * `cancelAll()` is called during explicit session teardown.
 */

import { settlesWithin, spawnLeasedShell, type LeasedShell } from "./shell-lease";

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
  promise: Promise<void>;
  cancel?: () => boolean;
  /** SIGKILL reached the pinned process group. */
  killDelivered?: boolean;
  /** Termination of every process holding the monitor's group or pipes cannot be confirmed. */
  incomplete?: boolean;
}
interface NoticeQueue {
  tails: [Promise<void>, Promise<void>];
  count: number;
  chars: number;
  overflow: boolean;
  firstLineClaimed: boolean;
}


const OUTPUT_CAP = 20_000;
const TRUNCATION_MARKER = "[…output truncated…]\n";
const PIPE_LINGER_MS = 500;
const NOTICE_CHAR_LIMIT = 20_000;
const NOTICE_COUNT_LIMIT = 1000;

export class MonitorRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly buffers = new Map<string, string>();
  private readonly truncated = new Set<string>();
  private readonly active = new Set<string>();
  private readonly pendingMutations = new Set<string>();
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
    const killed = entry.cancel?.();
    entry.record.status = killed ? "killed" : "failed";
    entry.record.finishedAt = Date.now();
  }

  private async drain(entry: Entry, reader: { read: () => Promise<{ done?: boolean; value?: Uint8Array }> }, queue: NoticeQueue, index: 0 | 1): Promise<void> {
    const decoder = new TextDecoder();
    let pending = "";
    const overflow = () => {
      if (queue.overflow) return;
      queue.overflow = true;
      entry.cancel?.();
    };
    const queueLine = (line: string) => {
      if (entry.record.status !== "running" || queue.overflow || (!entry.record.persistent && queue.firstLineClaimed)) return;
      if (queue.count >= NOTICE_COUNT_LIMIT || queue.chars + line.length > NOTICE_CHAR_LIMIT) {
        overflow();
        return;
      }
      if (!entry.record.persistent) queue.firstLineClaimed = true;
      queue.count++;
      queue.chars += line.length;
      queue.tails[index] = queue.tails[index].then(async () => {
        try {
          if (queue.overflow) return;
          await this.emit(entry.record, line);
          if (!entry.record.persistent) this.stopAfterFirstLine(entry);
        } finally {
          queue.count--;
          queue.chars -= line.length;
        }
      });
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const text = decoder.decode(value, { stream: true });
        this.append(entry.record.id, text);
        pending += text;
        while (true) {
          const match = pending.match(/(?:\r\n|\n|\r)/);
          if (!match || match.index === undefined) break;
          const line = pending.slice(0, match.index);
          pending = pending.slice(match.index + match[0].length);
          if (entry.record.status !== "running") return;
          if (queue.count >= NOTICE_COUNT_LIMIT || queue.chars + line.length > NOTICE_CHAR_LIMIT) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
          }
          queueLine(line);
          if (queue.overflow || !entry.record.persistent) return;
        }
        if (pending.length > NOTICE_CHAR_LIMIT) { overflow(); return; }
      }
      const tail = decoder.decode();
      if (tail) {
        this.append(entry.record.id, tail);
        pending += tail;
      }
      if (pending.length > 0 && entry.record.status === "running") {
        queueLine(pending);
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

    let shell: LeasedShell;
    try {
      shell = spawnLeasedShell(command, cwd);
    } catch (err) {
      record.status = "failed";
      record.finishedAt = Date.now();
      this.append(id, err instanceof Error ? err.message : String(err));
      this.pendingMutations.add(id);
      const failed: Entry = { record, promise: Promise.resolve() };
      this.entries.set(id, failed);
      return record;
    }

    this.active.add(id);
    const entry: Entry = { record, promise: Promise.resolve() };
    entry.cancel = (): boolean => {
      const outcome = shell.killGroup();
      if (outcome === "delivered") { entry.killDelivered = true; return true; }
      entry.incomplete = true;
      this.append(id, outcome === "unpinned"
        ? "\n[monitor process group is no longer pinned; termination cannot be confirmed]\n"
        : outcome === "unsupported"
          ? "\n[monitor process tree termination cannot be confirmed on Windows]\n"
          : `\n[monitor process group termination attempt failed: ${String(outcome.error)}]\n`);
      shell.killDirect();
      return false;
    };
    const queue: NoticeQueue = { tails: [Promise.resolve(), Promise.resolve()], count: 0, chars: 0, overflow: false, firstLineClaimed: false };
    const drains = Promise.all([this.drain(entry, shell.stdout, queue, 0), this.drain(entry, shell.stderr, queue, 1)]);
    this.entries.set(id, entry);
    entry.promise = (async () => {
      try {
        const exitCode = await shell.exit;
        let lingered = false;
        if (!(await settlesWithin(drains, PIPE_LINGER_MS))) {
          lingered = true;
          // A descendant still holds stdout/stderr. Only the pinned group may be signalled; if EOF does
          // not follow the delivered SIGKILL, the holder left the group and stays unresolved.
          if ((entry.killDelivered || entry.cancel!()) && !(await settlesWithin(drains, PIPE_LINGER_MS))) {
            entry.incomplete = true;
            this.append(id, "\n[monitor pipe remains open outside the process group; termination cannot be confirmed]\n");
          }
          shell.dispose();
          await drains;
        }
        await Promise.all(queue.tails);
        if (queue.overflow) {
          record.status = "failed";
          record.exitCode = exitCode;
          this.append(id, "\n[monitor output incomplete: notice queue limit exceeded]\n");
          return;
        }
        if (exitCode === null && !entry.killDelivered && !entry.incomplete) {
          entry.incomplete = true;
          this.append(id, "\n[monitor process group lease ended without an exit report; termination cannot be confirmed]\n");
        }
        if (record.status === "killed" && !entry.incomplete) return;
        if (!lingered && !entry.incomplete) {
          record.status = "exited";
          record.exitCode = exitCode;
          return;
        }
        record.status = "failed";
        record.exitCode = exitCode;
        if (lingered) this.append(id, "\n[monitor output incomplete: a descendant kept stdout or stderr open after the shell exited]\n");
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

  /** Processes not yet settled or whose completion has not reached the engine. */
  unobserved(): MonitorRecord[] {
    return this.list().filter(record => this.active.has(record.id) || this.pendingMutations.has(record.id));
  }

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
      if (entry.incomplete) { out.push(entry.record); continue; }
      if (entry.record.status === "running") {
        const killed = entry.cancel?.();
        entry.record.status = killed ? "killed" : "failed";
        entry.record.finishedAt = Date.now();
      }
      out.push(entry.record);
    }
    return out;
  }

  /** Include unresolved process groups even if their shell has exited. */
  cancellable(): MonitorRecord[] {
    return this.list().filter(record => record.status === "running" || this.entries.get(record.id)?.incomplete);
  }

  /** Kill every monitor still running at session teardown / Ctrl-C. */
  cancelAll(): MonitorRecord[] {
    return this.cancel(this.cancellable().map(record => record.id));
  }
}
