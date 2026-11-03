import { expect, test } from "bun:test";
import { createMessengerSessionPool } from "../src/messenger/session-pool";

test("concurrent policy changes never dispatch to a worker with the wrong policy", async () => {
  const firstExit = Promise.withResolvers<number>();
  const launched: string[] = [];
  const spawn = ((argv: string[]) => {
    const policy = argv[0]!;
    launched.push(policy);
    const exit = policy === "A" ? firstExit : Promise.withResolvers<number>();
    let out!: ReadableStreamDefaultController<Uint8Array>;
    return {
      stdout: new ReadableStream<Uint8Array>({ start(c) { out = c; } }),
      stderr: new ReadableStream<Uint8Array>(), exited: exit.promise,
      kill() { if (policy !== "A") exit.resolve(0); },
      stdin: { write(value: string) { out.enqueue(new TextEncoder().encode(`JEO_MESSENGER_RESULT ${JSON.stringify(`${policy}:${JSON.parse(value)}`)}\n`)); }, flush() {}, end() {} },
    };
  }) as unknown as typeof Bun.spawn;
  const pool = createMessengerSessionPool(spawn);
  const signal = new AbortController().signal;
  try {
    expect(await pool.turn("conversation", ["A"], "/tmp", {}, "one", signal, undefined, "A")).toBe("A:one");
    const b = pool.turn("conversation", ["B"], "/tmp", {}, "two", signal, undefined, "B").catch(e => (e as Error).message);
    const c = pool.turn("conversation", ["C"], "/tmp", {}, "three", signal, undefined, "C").catch(e => (e as Error).message);
    expect(launched).toEqual(["A"]);
    firstExit.resolve(0);
    const [br, cr] = await Promise.all([b, c]);
    expect([br, cr]).toContain("B:two");
    expect(cr === "C:three" || cr.includes("already active")).toBe(true);
    expect(br).not.toBe("C:two");
    expect(cr).not.toBe("B:three");
  } finally { firstExit.resolve(0); await pool.close(); }
});

test("replacement escalates a stuck worker and refuses to launch when it never exits", async () => {
  const exit = Promise.withResolvers<number>();
  const signals: Array<number | NodeJS.Signals | undefined> = [];
  let launches = 0;
  const spawn = (() => {
    launches++;
    let out!: ReadableStreamDefaultController<Uint8Array>;
    return {
      stdout: new ReadableStream<Uint8Array>({ start(c) { out = c; } }), stderr: new ReadableStream<Uint8Array>(), exited: exit.promise,
      kill(signal?: number | NodeJS.Signals) { signals.push(signal); },
      stdin: { write() { out.enqueue(new TextEncoder().encode('JEO_MESSENGER_RESULT "ok"\n')); }, flush() {}, end() {} },
    };
  }) as unknown as typeof Bun.spawn;
  // This specifically exercises the real termination escalation deadline.
  const pool = createMessengerSessionPool(spawn, 16, 300000, 20);
  const signal = new AbortController().signal;
  try {
    expect(await pool.turn("conversation", ["A"], "/tmp", {}, "one", signal, undefined, "A")).toBe("ok");
    await expect(pool.turn("conversation", ["B"], "/tmp", {}, "two", signal, undefined, "B")).rejects.toThrow("did not exit");
    expect(signals).toEqual([undefined, "SIGKILL"]);
    expect(launches).toBe(1);
  } finally { exit.resolve(0); await pool.close(); }
});

test("unconfirmed worker exit blocks subsequent replacement attempts", async () => {
  const exit = Promise.withResolvers<number>();
  let launches = 0;
  const spawn = (() => {
    launches++;
    let out!: ReadableStreamDefaultController<Uint8Array>;
    return {
      stdout: new ReadableStream<Uint8Array>({ start(c) { out = c; } }), stderr: new ReadableStream<Uint8Array>(), exited: exit.promise,
      kill() {}, stdin: { write() { out.enqueue(new TextEncoder().encode('JEO_MESSENGER_RESULT "ok"\n')); }, flush() {}, end() {} },
    };
  }) as unknown as typeof Bun.spawn;
  const pool = createMessengerSessionPool(spawn);
  const signal = new AbortController().signal;
  try {
    expect(await pool.turn("conversation", ["A"], "/tmp", {}, "one", signal, undefined, "A")).toBe("ok");
    const replacement = pool.turn("conversation", ["B"], "/tmp", {}, "two", signal, undefined, "B");
    exit.reject(new Error("cannot inspect process"));
    await expect(replacement).rejects.toThrow("exit could not be confirmed");
    await expect(pool.turn("conversation", ["C"], "/tmp", {}, "three", signal, undefined, "C")).rejects.toThrow("exit could not be confirmed");
    expect(launches).toBe(1);
  } finally { await pool.close(); }
});
