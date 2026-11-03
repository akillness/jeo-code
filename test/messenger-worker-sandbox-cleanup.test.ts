import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { createMessengerSessionPool } from "../src/messenger/session-pool";

const ACK = "JEO_MESSENGER_SHUTDOWN_ACK ";
const shutdownTimeoutMs = 50;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => { jest.useFakeTimers(); });
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  } finally { jest.useRealTimers(); }
});

type IpcMode = "ok" | "missing" | "throwing";

function fakeWorker(nonce: string, policy: string, reply: boolean, ipc: IpcMode = "ok") {
  const exited = Promise.withResolvers<number>();
  const frames: unknown[] = [];
  const stopping = Promise.withResolvers<void>();
  const signals: Array<number | NodeJS.Signals | undefined> = [];
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let err!: ReadableStreamDefaultController<Uint8Array>;
  let alive = true;
  const encoder = new TextEncoder();
  const stdout = new ReadableStream<Uint8Array>({ start(controller) { out = controller; } });
  const stderr = new ReadableStream<Uint8Array>({ start(controller) { err = controller; } });
  const emit = (channel: "stdout" | "stderr", text: string) => {
    (channel === "stdout" ? out : err).enqueue(encoder.encode(text));
  };
  const acknowledge = () => { emit("stderr", `${ACK}${JSON.stringify({ nonce, gone: true })}\n`); };
  const exit = (code = 0) => {
    if (!alive) return;
    alive = false;
    // A real exited child closes both pipes; leaving them open hides drain-order bugs.
    out.close();
    err.close();
    exited.resolve(code);
  };
  // Faithful private IPC: only the exact frame carrying the parent's nonce requests shutdown.
  // The fake records it and resolves `stopping`; the test then controls ACK and exit (the cleanup barrier).
  const send = (frame: unknown) => {
    if (ipc === "throwing") throw new Error("ipc channel closed");
    frames.push(frame);
    const f = frame as { type?: unknown; nonce?: unknown } | null;
    if (f && Object.keys(f).sort().join() === "nonce,type" && f.type === "jeo_messenger_shutdown" && f.nonce === nonce) stopping.resolve();
    return true;
  };
  return {
    nonce, signals, frames, stopping: stopping.promise, emit, acknowledge, exit,
    get alive() { return alive; },
    child: {
      stdout, stderr, exited: exited.promise,
      ...(ipc === "missing" ? {} : { send }),
      // A signal is an actual crash: no acknowledgement, signal exit status, never a graceful stop.
      kill(signal?: number | NodeJS.Signals) { signals.push(signal); exit(signal === "SIGKILL" || signal === 9 ? 137 : 143); },
      stdin: {
        write(value: string) {
          if (reply) emit("stdout", `JEO_MESSENGER_RESULT ${JSON.stringify(`${policy}:${JSON.parse(value)}`)}\n`);
        },
        flush() {}, end() {},
      },
    },
  };
}

function sandboxPool({ idleTimeoutMs = 60_000, reply = true, limit = 2, ipc = "ok" as IpcMode } = {}) {
  const spawnOptions: Array<{ ipc?: unknown; serialization?: unknown; env: Record<string, string> }> = [];
  const workers: Array<{
    nonce: string;
    frames: unknown[];
    signals: Array<number | NodeJS.Signals | undefined>;
    stopping: Promise<void>;
    alive: boolean;
    emit(channel: "stdout" | "stderr", text: string): void;
    acknowledge(): void;
    exit(code?: number): void;
  }> = [];
  const spawn = ((command: string[], options: { ipc?: unknown; serialization?: unknown; env: Record<string, string> }) => {
    spawnOptions.push(options);
    const worker = fakeWorker(options.env.JEO_MESSENGER_SHUTDOWN_NONCE ?? "", command[0]!, reply || workers.length > 0, ipc);
    workers.push(worker);
    return worker.child;
  }) as unknown as typeof Bun.spawn;
  const pool = createMessengerSessionPool(spawn, limit, idleTimeoutMs, shutdownTimeoutMs, { requireSandboxCleanup: true });
  cleanups.push(async () => {
    for (const worker of workers) {
      if (worker.alive) { worker.acknowledge(); worker.exit(); }
    }
    // Tests deliberately leave unverified exits quarantined; cleanup must not hide their assertions.
    await pool.close().catch(() => {});
  });
  const turn = (text: string, policy = "A", signal = new AbortController().signal) =>
    pool.turn("conversation", [policy], "/tmp", {}, text, signal, undefined, policy);
  return { pool, workers, turn, spawnOptions };
}

const shutdownFrame = (nonce: string) => ({ type: "jeo_messenger_shutdown", nonce });

test("close aborts a capacity eviction waiter before it can spawn another sandbox worker", async () => {
  const { pool, workers, turn } = sandboxPool({ limit: 1 });
  expect(await turn("first")).toBe("A:first");
  const first = workers[0]!;
  const replacement = pool.turn("other-conversation", ["B"], "/tmp", {}, "second", new AbortController().signal, undefined, "B");
  const outcome = replacement.catch(error => error);
  await first.stopping;
  const closing = pool.close();
  first.acknowledge();
  first.exit();
  expect(await outcome).toMatchObject({ message: expect.stringContaining("Messenger request aborted") });
  expect(await closing).toBeUndefined();
  expect(workers).toHaveLength(1);
  expect(first.signals).toEqual([]);
  expect(first.frames).toEqual([shutdownFrame(first.nonce)]);
});

test("close immediately after a turn starts settles the turn and close instead of hanging", async () => {
  const { pool, workers, turn } = sandboxPool();
  const outcome = turn("first").then(value => ({ value }), error => ({ error }));
  expect(workers).toHaveLength(1);
  const worker = workers[0]!;
  const closing = pool.close().then(() => "closed", error => error);
  await worker.stopping;
  worker.acknowledge();
  worker.exit();
  expect(await outcome).toMatchObject({ error: { message: expect.stringContaining("Messenger worker stopped") } });
  expect(await closing).toBe("closed");
  expect(worker.signals).not.toContain("SIGKILL");
});

for (const mode of ["cancellation", "timeout"] as const) {
  test(`capacity eviction wait honors ${mode} while the old owner stays quarantined and does not leak its failure`, async () => {
    const { pool, workers, turn } = sandboxPool({ limit: 1 });
    expect(await turn("first")).toBe("A:first");
    const old = workers[0]!;
    const controller = new AbortController();
    const evicting = pool.turn("other-conversation", ["B"], "/tmp", {}, "second", controller.signal, undefined, "B").catch(error => error);
    await old.stopping;
    if (mode === "cancellation") controller.abort();
    else jest.advanceTimersByTime(shutdownTimeoutMs * 4);
    const failure = await evicting as Error;
    if (mode === "cancellation") expect(failure.message).toContain("Messenger request aborted");
    else {
      expect(failure.message).toContain("capacity unavailable");
      expect(failure.message).not.toContain("REVOKE_INCOMPLETE");
    }
    // The unverified owner was neither force-killed nor replaced by a second sandbox worker.
    expect(workers).toHaveLength(1);
    expect(old.alive).toBe(true);
    expect(old.signals).not.toContain("SIGKILL");
    // Its own conversation remains quarantined until cleanup is acknowledged and the process exits.
    const blocked = turn("again").catch(error => error);
    jest.advanceTimersByTime(shutdownTimeoutMs * 4);
    expect(await blocked).toMatchObject({ message: expect.stringContaining("REVOKE_INCOMPLETE") });
    expect(workers).toHaveLength(1);
    old.acknowledge();
    old.exit();
    expect(await turn("third", "B")).toBe("B:third");
    expect(workers).toHaveLength(2);
  });
}

for (const acknowledged of [false, true]) {
test(`sandbox close timeout ${acknowledged ? "after acknowledgement" : "without acknowledgement"} preserves the cleanup owner and a late verified exit completes repeated close`, async () => {
  const { pool, workers, turn } = sandboxPool();
  expect(await turn("first")).toBe("A:first");
  const worker = workers[0]!;
  if (acknowledged) worker.acknowledge();
  const closing = pool.close();
  const rejected = closing.catch(error => error);
  await worker.stopping;
  jest.advanceTimersByTime(shutdownTimeoutMs * 4);
  expect(await rejected).toMatchObject({ message: expect.stringContaining("REVOKE_INCOMPLETE") });
  expect(worker.signals).not.toContain("SIGKILL");
  expect(worker.alive).toBe(true);
  worker.acknowledge();
  worker.exit();
  expect(await pool.close()).toBeUndefined();
});
}

test("sandbox close accepts a fragmented matching stderr acknowledgement only with worker exit", async () => {
  const { pool, workers, turn } = sandboxPool();
  expect(await turn("first")).toBe("A:first");
  const worker = workers[0]!;
  const closing = pool.close();
  await worker.stopping;
  const line = `${ACK}${JSON.stringify({ nonce: worker.nonce, gone: true })}\n`;
  worker.emit("stderr", line.slice(0, 13));
  worker.emit("stderr", line.slice(13));
  worker.exit();
  expect(await closing).toBeUndefined();
  expect(worker.signals).not.toContain("SIGKILL");
});

for (const invalid of ["wrong nonce", "stdout acknowledgement", "stdout result text", "missing acknowledgement", "gone false"] as const) {
  test(`sandbox close rejects ${invalid} even when the worker exits successfully`, async () => {
    const { pool, workers, turn } = sandboxPool({ reply: invalid !== "stdout result text" });
    const initial = turn("first");
    const worker = workers[0]!;
    if (invalid === "stdout result text") {
      const result = `${ACK}${JSON.stringify({ nonce: worker.nonce, gone: true })}`;
      worker.emit("stdout", `JEO_MESSENGER_RESULT ${JSON.stringify(result)}\n`);
      expect(await initial).toBe(result);
    } else {
      expect(await initial).toBe("A:first");
    }
    const closing = pool.close();
    const rejected = closing.catch(error => error);
    await worker.stopping;
    if (invalid === "wrong nonce") worker.emit("stderr", `${ACK}${JSON.stringify({ nonce: `${worker.nonce}-forged`, gone: true })}\n`);
    if (invalid === "stdout acknowledgement") worker.emit("stdout", `${ACK}${JSON.stringify({ nonce: worker.nonce, gone: true })}\n`);
    if (invalid === "gone false") worker.emit("stderr", `${ACK}${JSON.stringify({ nonce: worker.nonce, gone: false })}\n`);
    worker.exit();
    expect(await rejected).toMatchObject({ message: expect.stringContaining("REVOKE_INCOMPLETE") });
    await expect(pool.close()).rejects.toThrow("REVOKE_INCOMPLETE");
    expect(worker.signals).not.toContain("SIGKILL");
  });
}

test("an unexpected sandbox worker exit fails the active turn and quarantines its conversation", async () => {
  const { pool, workers, turn } = sandboxPool({ reply: false });
  const pending = turn("first");
  const rejected = pending.catch(error => error);
  workers[0]!.exit(17);
  expect(await rejected).toMatchObject({ message: expect.stringMatching(/Messenger worker stopped|REVOKE_INCOMPLETE/) });
  await expect(turn("second")).rejects.toThrow("REVOKE_INCOMPLETE");
  expect(workers).toHaveLength(1);
  await expect(pool.close()).rejects.toThrow("REVOKE_INCOMPLETE");
});

for (const reason of ["policy replacement", "idle retirement", "cancellation"] as const) {
  test(`${reason} cannot replace a sandbox cleanup owner after timeout and recovers only after acknowledgement plus exit`, async () => {
    const { workers, turn } = sandboxPool({ idleTimeoutMs: 25, reply: reason !== "cancellation" });
    const controller = new AbortController();
    if (reason === "cancellation") {
      const pending = turn("first", "A", controller.signal);
      const rejected = pending.catch(error => error);
      controller.abort();
      expect(await rejected).toMatchObject({ message: expect.stringMatching(/Messenger worker stopped|REVOKE_INCOMPLETE/) });
    } else {
      expect(await turn("first")).toBe("A:first");
      if (reason === "idle retirement") jest.advanceTimersByTime(25);
    }
    const worker = workers[0]!;
    const replacement = turn("second", "B");
    const rejected = replacement.catch(error => error);
    await worker.stopping;
    jest.advanceTimersByTime(shutdownTimeoutMs * 4);
    expect(await rejected).toMatchObject({ message: expect.stringContaining("REVOKE_INCOMPLETE") });
    expect(workers).toHaveLength(1);
    expect(worker.alive).toBe(true);
    expect(worker.signals).not.toContain("SIGKILL");
    worker.acknowledge();
    worker.exit();
    const retry = turn("third", "B");
    expect(await retry).toBe("B:third");
    expect(workers).toHaveLength(2);
  });
}

for (const reason of ["policy replacement", "idle retirement", "cancellation"] as const) {
  test(`${reason} never releases the conversation after an exit without cleanup proof`, async () => {
    const { pool, workers, turn } = sandboxPool({ idleTimeoutMs: 25, reply: reason !== "cancellation" });
    const controller = new AbortController();
    if (reason === "cancellation") {
      const pending = turn("first", "A", controller.signal);
      const rejected = pending.catch(error => error);
      controller.abort();
      expect(await rejected).toMatchObject({ message: expect.stringMatching(/Messenger worker stopped|REVOKE_INCOMPLETE/) });
    } else {
      expect(await turn("first")).toBe("A:first");
      if (reason === "idle retirement") jest.advanceTimersByTime(25);
    }
    const worker = workers[0]!;
    const replacement = turn("second", "B");
    const rejected = replacement.catch(error => error);
    await worker.stopping;
    worker.exit();
    expect(await rejected).toMatchObject({ message: expect.stringContaining("REVOKE_INCOMPLETE") });
    await expect(turn("third", "C")).rejects.toThrow("REVOKE_INCOMPLETE");
    expect(workers).toHaveLength(1);
    await expect(pool.close()).rejects.toThrow("REVOKE_INCOMPLETE");
  });
}

test("protected workers spawn with an inert IPC handler and JSON serialization, with a per-worker nonce", async () => {
  const { pool, workers, turn, spawnOptions } = sandboxPool();
  expect(await turn("first")).toBe("A:first");
  // A distinct conversation: reusing the key with another policy would wait on the first worker's cleanup.
  expect(await pool.turn("other-conversation", ["B"], "/tmp", {}, "other", new AbortController().signal, undefined, "B")).toBe("B:other");
  expect(spawnOptions).toHaveLength(2);
  for (const options of spawnOptions) {
    expect(typeof options.ipc).toBe("function");
    expect(() => (options.ipc as (...args: unknown[]) => unknown)("ignored message")).not.toThrow();
    expect(options.serialization).toBe("json");
    expect(options.env.JEO_MESSENGER_SHUTDOWN_NONCE).toBeTruthy();
  }
  expect(workers[0]!.nonce).not.toBe(workers[1]!.nonce);
});

test("protected graceful close sends exactly the private shutdown frame over IPC and never signals the worker", async () => {
  const { pool, workers, turn } = sandboxPool();
  expect(await turn("first")).toBe("A:first");
  const worker = workers[0]!;
  const closing = pool.close();
  await worker.stopping;
  expect(worker.frames).toEqual([shutdownFrame(worker.nonce)]);
  expect(worker.signals).toEqual([]);
  expect(worker.alive).toBe(true); // exit only happens after the controlled cleanup barrier
  worker.acknowledge();
  worker.exit(143);
  expect(await closing).toBeUndefined();
  expect(worker.signals).toEqual([]);
});

for (const mode of ["missing", "throwing"] as const) {
  test(`protected retire with ${mode} send() is REVOKE_INCOMPLETE, never falls back to kill, and quarantines key and capacity`, async () => {
    const { pool, workers, turn } = sandboxPool({ limit: 1, ipc: mode, idleTimeoutMs: 25 });
    expect(await turn("first")).toBe("A:first");
    const worker = workers[0]!;
    // Retire through idle expiration while the pool stays open; the IPC send fails.
    jest.advanceTimersByTime(25);
    jest.advanceTimersByTime(shutdownTimeoutMs * 4);
    expect(worker.frames).toEqual([]);
    expect(worker.signals).toEqual([]);
    expect(worker.alive).toBe(true);
    // Key quarantined.
    const sameKey = turn("again").catch(error => error);
    jest.advanceTimersByTime(shutdownTimeoutMs * 4);
    expect(await sameKey).toMatchObject({ message: expect.stringContaining("REVOKE_INCOMPLETE") });
    // Capacity quarantined: a different conversation cannot spawn a second worker.
    const otherKey = pool.turn("other-conversation", ["B"], "/tmp", {}, "second", new AbortController().signal, undefined, "B").catch(error => error);
    jest.advanceTimersByTime(shutdownTimeoutMs * 4);
    expect(await otherKey).toBeInstanceOf(Error);
    expect(workers).toHaveLength(1);
    expect(worker.signals).toEqual([]);
    // Only a verified acknowledgement plus exit releases it.
    worker.acknowledge();
    worker.exit();
    expect(await pool.close()).toBeUndefined();
  });
}

test("protected shutdown rejects a stale-nonce frame ACK and a kill-driven crash exit as cleanup proof", async () => {
  const { pool, workers, turn } = sandboxPool();
  expect(await turn("first")).toBe("A:first");
  const worker = workers[0]!;
  const rejected = pool.close().catch(error => error);
  await worker.stopping;
  worker.emit("stderr", `${ACK}${JSON.stringify({ nonce: `stale-${worker.nonce}`, gone: true })}\n`);
  worker.child.kill("SIGTERM"); // an actual crash: signal exit status and no ACK
  expect(await rejected).toMatchObject({ message: expect.stringContaining("REVOKE_INCOMPLETE") });
  await expect(pool.close()).rejects.toThrow("REVOKE_INCOMPLETE");
});
