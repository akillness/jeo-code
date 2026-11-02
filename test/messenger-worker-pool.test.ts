import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMessengerSessionPool } from "../src/messenger/session-pool";
import { createMessengerCliReply } from "../src/commands/messenger";
import type { MessengerConfig, MessengerMessage } from "../src/messenger/types";

const message: MessengerMessage = { platform: "discord", accountId: "bot", channelId: "channel", senderId: "owner", messageId: "1", text: "hello", direct: true, mentioned: false };

test("conversation workers are reused, isolated, evicted and closed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-worker-pool-"));
  const config: MessengerConfig = { cwd: root, sessionDir: path.join(root, "sessions"), toolNames: [], platforms: { discord: { tokenEnv: "JEO_DISCORD_BOT_TOKEN", allowedUserIds: ["owner"] } } };
  const workers: { id: number; killed: boolean; requests: string[] }[] = [];
  const spawn = ((_argv: string[], _options: unknown) => {
    const worker = { id: workers.length, killed: false, requests: [] as string[] };
    workers.push(worker);
    const exit = Promise.withResolvers<number>();
    let out: ReadableStreamDefaultController<Uint8Array>;
    let err: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({ start(controller) { out = controller; } });
    const stderr = new ReadableStream<Uint8Array>({ start(controller) { err = controller; } });
    const kill = () => { if (!worker.killed) { worker.killed = true; out.close(); err.close(); exit.resolve(0); } };
    return {
      stdout, stderr, exited: exit.promise, kill,
      stdin: { write(chunk: string | Uint8Array) { const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk); for (const line of text.trim().split("\n")) { const prompt = JSON.parse(line); worker.requests.push(prompt); out.enqueue(new TextEncoder().encode(`JEO_MESSENGER_RESULT ${JSON.stringify(`worker ${worker.id}: ${prompt}`)}\n`)); } return text.length; }, flush() {}, end() { kill(); } },
    };
  }) as typeof Bun.spawn;
  const reply = createMessengerCliReply(config, spawn);
  try {
    const signal = new AbortController().signal;
    expect(await reply(message, signal)).toBe("worker 0: hello");
    expect(await reply({ ...message, messageId: "2", text: "again" }, signal)).toBe("worker 0: again");
    expect(workers).toHaveLength(1);
    expect(await reply({ ...message, senderId: "second" }, signal)).toBe("worker 1: hello");
    expect(workers[0]!.requests).toEqual(["hello", "again"]);
    for (let i = 2; i < 17; i++) await reply({ ...message, senderId: `user-${i}` }, signal);
    expect(workers).toHaveLength(17);
    expect(workers[0]!.killed).toBe(true);
    expect(await reply(message, signal)).toBe("worker 17: hello");
  } finally { await reply.close(); await fs.rm(root, { recursive: true, force: true }); }
  expect(workers.every(worker => worker.killed)).toBe(true);
});

test("real worker serves multiple turns and isolates conversations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-real-worker-"));
  const configDir = path.join(root, "config");
  await fs.mkdir(configDir);
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({ providers: {}, defaultModel: "openai/gpt-4o-mini" }));
  const requests: unknown[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] });
    requests.push(await request.json());
    return Response.json({ choices: [{ message: { role: "assistant", content: `**answer ${requests.length}**` }, finish_reason: "stop" }] });
  } });
  const config: MessengerConfig = { cwd: root, sessionDir: path.join(root, "sessions"), toolNames: [], platforms: { discord: { tokenEnv: "JEO_DISCORD_BOT_TOKEN", allowedUserIds: ["owner"] } } };
  let launches = 0;
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const spawn = ((argv: string[], options: { cwd: string; env: Record<string, string>; stdin: "pipe"; stdout: "pipe"; stderr: "pipe" }) => {
    launches++;
    const launch = argv.indexOf("launch");
    const child = Bun.spawn([process.execPath, "--no-env-file", path.resolve(import.meta.dir, "../src/cli.ts"), ...argv.slice(launch)], { ...options, env: { ...options.env, HOME: root, JEO_CONFIG_DIR: configDir, OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1` } });
    children.push(child);
    return child;
  }) as typeof Bun.spawn;
  const reply = createMessengerCliReply(config, spawn);
  try {
    const signal = new AbortController().signal;
    expect(await reply(message, signal)).toBe("**answer 1**");
    expect(await reply({ ...message, messageId: "2", text: "/theme matrix" }, signal)).toBe("**answer 2**");
    expect(launches).toBe(1);
    expect(await reply({ ...message, senderId: "other" }, signal)).toBe("**answer 3**");
    expect(launches).toBe(2);
    expect(JSON.stringify(requests[1])).toContain("/theme matrix");
    expect(JSON.stringify(requests[2])).not.toContain("/theme matrix");
    children[0]!.kill();
    await children[0]!.exited;
    expect(await reply({ ...message, messageId: "3", text: "after restart" }, signal)).toBe("**answer 4**");
    expect(launches).toBe(3);
    expect(JSON.stringify(requests[3])).toContain("/theme matrix");
    expect(JSON.stringify(requests[3])).toContain("answer 2");
    expect(JSON.parse(await fs.readFile(path.join(configDir, "config.json"), "utf8")).theme).toBeUndefined();
  } finally { await reply.close(); server.stop(true); await fs.rm(root, { recursive: true, force: true }); }
}, 30000);

test("compiled CLI preserves two turns in one worker", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-compiled-worker-"));
  const configDir = path.join(root, "config");
  const executable = path.join(root, "jeo");
  await fs.mkdir(configDir);
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({ providers: {}, defaultModel: "openai/gpt-4o-mini" }));
  const build = Bun.spawn([process.execPath, "build", path.resolve(import.meta.dir, "../src/cli.ts"), "--compile", "--keep-names", "--external", "chromium-bidi", "--no-compile-autoload-dotenv", "--outfile", executable], { stdout: "pipe", stderr: "pipe" });
  await fs.writeFile(path.join(root, ".env"), "JEO_DISCORD_BOT_TOKEN=dotenv-secret\nJEOPI_DISCORD_BOT_TOKEN=dotenv-alias\n");
  const [buildOut, buildErr, buildCode] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
  expect({ code: buildCode, error: buildErr }).toEqual({ code: 0, error: "" });
  expect(buildOut).toContain("jeo");
  let calls = 0;
  const modelRequests: unknown[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] });
    modelRequests.push(await request.json());
    return Response.json({ choices: [{ message: { role: "assistant", content: `compiled answer ${++calls}` }, finish_reason: "stop" }] });
  } });
  const config: MessengerConfig = { cwd: root, sessionDir: path.join(root, "sessions"), toolNames: [], platforms: { discord: { tokenEnv: "JEO_DISCORD_BOT_TOKEN", allowedUserIds: ["owner"] } } };
  let launches = 0;
  const spawn = ((argv: string[], options: { cwd: string; env: Record<string, string>; stdin: "pipe"; stdout: "pipe"; stderr: "pipe" }) => {
    launches++;
    return Bun.spawn([executable, ...argv.slice(argv.indexOf("launch"))], { ...options, env: { ...options.env, HOME: root, JEO_CONFIG_DIR: configDir, OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1` } });
  }) as typeof Bun.spawn;
  const reply = createMessengerCliReply(config, spawn);
  try {
    const signal = new AbortController().signal;
    expect(await reply(message, signal)).toBe("compiled answer 1");
    expect(await reply({ ...message, messageId: "2", text: "/theme matrix" }, signal)).toBe("compiled answer 2");
    expect(launches).toBe(1);
    expect(calls).toBe(2);
    expect(JSON.stringify(modelRequests[1])).toContain("/theme matrix");
    expect(JSON.stringify(modelRequests)).not.toContain("dotenv-secret");
    expect(JSON.stringify(modelRequests)).not.toContain("dotenv-alias");
    expect(JSON.parse(await fs.readFile(path.join(configDir, "config.json"), "utf8")).theme).toBeUndefined();
  } finally { await reply.close(); server.stop(true); await fs.rm(root, { recursive: true, force: true }); }
}, 120000);

for (const failing of ["write", "flush"] as const) test(`asynchronous stdin ${failing} rejection retires the worker and permits retry`, async () => {
  let launches = 0;
  const killed: number[] = [];
  const spawn = (() => {
    const id = launches++;
    const exited = Promise.withResolvers<number>();
    let output: ReadableStreamDefaultController<Uint8Array>;
    let errors: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({ start(c) { output = c; } });
    const stderr = new ReadableStream<Uint8Array>({ start(c) { errors = c; } });
    return {
      stdout, stderr, exited: exited.promise,
      kill() { killed.push(id); output.close(); errors.close(); exited.resolve(0); },
      stdin: {
        async write(_text: string) { if (id === 0 && failing === "write") throw new Error("private write failure"); },
        async flush() {
          if (id === 0 && failing === "flush") throw new Error("private flush failure");
          if (id !== 0) output.enqueue(new TextEncoder().encode('JEO_MESSENGER_RESULT "recovered"\n'));
        },
        end() {},
      },
    };
  }) as typeof Bun.spawn;
  const pool = createMessengerSessionPool(spawn);
  const signal = new AbortController().signal;
  try {
    await expect(pool.turn("same", ["worker"], "/tmp", {}, "first", signal)).rejects.toThrow("Messenger worker stopped");
    expect(killed).toEqual([0]);
    expect(await pool.turn("same", ["worker"], "/tmp", {}, "retry", signal)).toBe("recovered");
    expect(launches).toBe(2);
  } finally { await pool.close(); }
  expect(killed).toEqual([0, 1]);
});

test("idle workers exit and restart, while active turns are not expired", async () => {
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const spawn = ((argv: string[], options: Parameters<typeof Bun.spawn>[1]) => {
    const child = Bun.spawn(argv, options);
    children.push(child);
    return child;
  }) as typeof Bun.spawn;
  const pool = createMessengerSessionPool(spawn, 2, 100);
  const command = [process.execPath, "-e", `
    for await (const line of console) {
      const text = JSON.parse(line);
      if (text === "slow") await Bun.sleep(250);
      console.log("JEO_MESSENGER_RESULT " + JSON.stringify(text));
    }
  `];
  const signal = new AbortController().signal;
  try {
    expect(await pool.turn("one", command, process.cwd(), {}, "first", signal)).toBe("first");
    expect(await pool.turn("one", command, process.cwd(), {}, "slow", signal)).toBe("slow");
    expect(children).toHaveLength(1);
    await Promise.race([children[0]!.exited, Bun.sleep(3000).then(() => { throw new Error("idle worker did not exit"); })]);
    expect(await pool.turn("one", command, process.cwd(), {}, "again", signal)).toBe("again");
    expect(children).toHaveLength(2);
  } finally { await pool.close(); }
});
test("close waits for a previously retired worker to exit", async () => {
  const exited = Promise.withResolvers<number>();
  let killed = false;
  const spawn = (() => ({
    stdout: new ReadableStream<Uint8Array>(),
    stderr: new ReadableStream<Uint8Array>(),
    exited: exited.promise,
    kill() { killed = true; },
    stdin: { write() {}, flush() {}, end() {} },
  })) as unknown as typeof Bun.spawn;
  const pool = createMessengerSessionPool(spawn);
  const controller = new AbortController();
  const turn = pool.turn("one", ["worker"], "/tmp", {}, "hello", controller.signal);
  controller.abort();
  await expect(turn).rejects.toThrow("Messenger worker stopped");
  expect(killed).toBe(true);
  let closed = false;
  const closing = pool.close().then(() => { closed = true; });
  await Bun.sleep(10);
  expect(closed).toBe(false);
  exited.resolve(0);
  await closing;
  expect(closed).toBe(true);
});

test("drains a buffered result before handling process exit", async () => {
  const exited = Promise.withResolvers<number>();
  let out!: ReadableStreamDefaultController<Uint8Array>;
  const spawn = (() => ({
    stdout: new ReadableStream<Uint8Array>({ start(c) { out = c; } }),
    stderr: new ReadableStream<Uint8Array>(), exited: exited.promise,
    kill() {}, stdin: { write() {}, flush() {}, end() {} },
  })) as unknown as typeof Bun.spawn;
  const pool = createMessengerSessionPool(spawn);
  const turn = pool.turn("one", ["worker"], "/tmp", {}, "hello", new AbortController().signal);
  exited.resolve(0);
  await Bun.sleep(0);
  out.enqueue(new TextEncoder().encode('JEO_MESSENGER_RESULT "answer"\n'));
  out.close();
  expect(await turn).toBe("answer");
  await pool.close();
});

test("replacement waits for the previous same-conversation process to exit", async () => {
  const firstExit = Promise.withResolvers<number>();
  let launches = 0;
  const spawn = (() => {
    const id = launches++;
    const exit = id === 0 ? firstExit : Promise.withResolvers<number>();
    let out!: ReadableStreamDefaultController<Uint8Array>;
    return {
      stdout: new ReadableStream<Uint8Array>({ start(c) { out = c; } }),
      stderr: new ReadableStream<Uint8Array>(), exited: exit.promise,
      kill() { if (id !== 0) exit.resolve(0); },
      stdin: { write() { if (id !== 0) out.enqueue(new TextEncoder().encode('JEO_MESSENGER_RESULT "new"\n')); }, flush() {}, end() {} },
    };
  }) as unknown as typeof Bun.spawn;
  const pool = createMessengerSessionPool(spawn);
  const controller = new AbortController();
  const first = pool.turn("one", ["worker"], "/tmp", {}, "first", controller.signal);
  controller.abort();
  await expect(first).rejects.toThrow("Messenger worker stopped");
  const second = pool.turn("one", ["worker"], "/tmp", {}, "second", new AbortController().signal);
  await Bun.sleep(10);
  expect(launches).toBe(1);
  firstExit.resolve(0);
  expect(await second).toBe("new");
  await pool.close();
});

test("a result is not delivered until its stdin write has completed", async () => {
  const write = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<number>();
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let killed = false;
  const spawn = (() => ({
    stdout: new ReadableStream<Uint8Array>({ start(c) { out = c; } }),
    stderr: new ReadableStream<Uint8Array>(), exited: exited.promise,
    kill() { killed = true; exited.resolve(0); },
    stdin: { write() { out.enqueue(new TextEncoder().encode('JEO_MESSENGER_RESULT "early"\n')); return write.promise; }, flush() {}, end() {} },
  })) as unknown as typeof Bun.spawn;
  const pool = createMessengerSessionPool(spawn);
  let settled = false;
  const turn = pool.turn("one", ["worker"], "/tmp", {}, "hello", new AbortController().signal);
  const outcome = turn.then(() => { settled = true; }, () => { settled = true; });
  await Bun.sleep(10);
  expect(settled).toBe(false);
  write.reject(new Error("write failed"));
  await expect(turn).rejects.toThrow("Messenger worker stopped");
  await outcome;
  expect(killed).toBe(true);
  await pool.close();
});

test("a naturally exited worker is not reused while its stdout drains", async () => {
  let launches = 0;
  const firstExit = Promise.withResolvers<number>();
  let firstOut!: ReadableStreamDefaultController<Uint8Array>;
  const spawn = (() => {
    const id = launches++;
    const exit = id === 0 ? firstExit : Promise.withResolvers<number>();
    let out!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({ start(c) { out = c; if (!id) firstOut = c; } });
    return { stdout, stderr: new ReadableStream<Uint8Array>(), exited: exit.promise,
      kill() { if (id) exit.resolve(0); },
      stdin: { write() { if (id) out.enqueue(new TextEncoder().encode('JEO_MESSENGER_RESULT "second"\n')); }, flush() {}, end() {} } };
  }) as unknown as typeof Bun.spawn;
  const pool = createMessengerSessionPool(spawn);
  const signal = new AbortController().signal;
  const first = pool.turn("one", ["worker"], "/tmp", {}, "first", signal);
  firstExit.resolve(0);
  await Bun.sleep(0);
  firstOut.enqueue(new TextEncoder().encode('JEO_MESSENGER_RESULT "first"\n'));
  expect(await first).toBe("first");
  expect(await pool.turn("one", ["worker"], "/tmp", {}, "second", signal)).toBe("second");
  expect(launches).toBe(2);
  firstOut.close();
  await pool.close();
});

test("a final buffered result survives exit while stdin write is still settling", async () => {
  const write = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<number>();
  let out!: ReadableStreamDefaultController<Uint8Array>;
  const spawn = (() => ({ stdout: new ReadableStream<Uint8Array>({ start(c) { out = c; } }),
    stderr: new ReadableStream<Uint8Array>(), exited: exited.promise, kill() {},
    stdin: { write() { return write.promise; }, flush() {}, end() {} } })) as unknown as typeof Bun.spawn;
  const pool = createMessengerSessionPool(spawn);
  const turn = pool.turn("one", ["worker"], "/tmp", {}, "first", new AbortController().signal);
  const outcome = turn.then(value => ({ value }), error => ({ error }));
  exited.resolve(0);
  out.enqueue(new TextEncoder().encode('JEO_MESSENGER_RESULT "answer"\n'));
  out.close();
  await Bun.sleep(10);
  write.resolve();
  expect(await outcome).toEqual({ value: "answer" });
  await pool.close();
});

test("natural exit does not permit a concurrent turn while the prior result drains", async () => {
  const exited = Promise.withResolvers<number>();
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let launches = 0;
  const spawn = (() => { launches++; return { stdout: new ReadableStream<Uint8Array>({ start(c) { out = c; } }),
    stderr: new ReadableStream<Uint8Array>(), exited: exited.promise, kill() {},
    stdin: { write() {}, flush() {}, end() {} } }; }) as unknown as typeof Bun.spawn;
  const pool = createMessengerSessionPool(spawn);
  const signal = new AbortController().signal;
  const first = pool.turn("one", ["worker"], "/tmp", {}, "first", signal);
  exited.resolve(0);
  await Bun.sleep(0);
  await expect(pool.turn("one", ["worker"], "/tmp", {}, "second", signal)).rejects.toThrow("Messenger conversation is already active");
  expect(launches).toBe(1);
  out.enqueue(new TextEncoder().encode('JEO_MESSENGER_RESULT "first"\n'));
  out.close();
  expect(await first).toBe("first");
  await pool.close();
});

test("close escalates termination for a worker that ignores the first signal", async () => {
  const exited = Promise.withResolvers<number>();
  const signals: (number | NodeJS.Signals | undefined)[] = [];
  const spawn = (() => ({ stdout: new ReadableStream<Uint8Array>(), stderr: new ReadableStream<Uint8Array>(), exited: exited.promise,
    kill(signal?: number | NodeJS.Signals) { signals.push(signal); if (signal === "SIGKILL") exited.resolve(0); },
    stdin: { write() {}, flush() {}, end() {} } })) as unknown as typeof Bun.spawn;
  const pool = createMessengerSessionPool(spawn, 16, 300000, 20);
  const turn = pool.turn("one", ["worker"], "/tmp", {}, "hello", new AbortController().signal);
  const outcome = turn.then(() => "unexpected success", error => (error as Error).message);
  await pool.close();
  expect(await outcome).toBe("Messenger worker stopped");
  expect(signals).toEqual([undefined, "SIGKILL"]);
});

test("close reports an error if forced termination cannot stop a worker", async () => {
  const exited = Promise.withResolvers<number>();
  const signals: (number | NodeJS.Signals | undefined)[] = [];
  const spawn = (() => ({ stdout: new ReadableStream<Uint8Array>(), stderr: new ReadableStream<Uint8Array>(), exited: exited.promise,
    kill(signal?: number | NodeJS.Signals) { signals.push(signal); },
    stdin: { write() {}, flush() {}, end() {} } })) as unknown as typeof Bun.spawn;
  const pool = createMessengerSessionPool(spawn, 16, 300000, 10);
  const outcome = pool.turn("one", ["worker"], "/tmp", {}, "hello", new AbortController().signal).catch(error => (error as Error).message);
  await expect(pool.close()).rejects.toThrow("Messenger workers did not exit after forced termination");
  expect(await outcome).toBe("Messenger worker stopped");
  expect(signals).toEqual([undefined, "SIGKILL"]);
  exited.resolve(0);
});

for (const buffered of [false, true]) test(`exited worker settles when ${buffered ? "stdin remains pending" : "stdout remains open"}`, async () => {
  const exited = Promise.withResolvers<number>();
  let out!: ReadableStreamDefaultController<Uint8Array>;
  const spawn = (() => ({ stdout: new ReadableStream<Uint8Array>({ start(c) { out = c; } }), stderr: new ReadableStream<Uint8Array>(), exited: exited.promise,
    kill() {}, stdin: { write() { return buffered ? new Promise(() => {}) : undefined; }, flush() {}, end() {} } })) as unknown as typeof Bun.spawn;
  const pool = createMessengerSessionPool(spawn, 16, 300000, 20);
  const turn = pool.turn("one", ["worker"], "/tmp", {}, "hello", new AbortController().signal);
  const outcome = turn.then(() => "unexpected success", error => (error as Error).message);
  exited.resolve(0);
  if (buffered) { out.enqueue(new TextEncoder().encode('JEO_MESSENGER_RESULT "answer"\n')); out.close(); }
  expect(await Promise.race([outcome, Bun.sleep(500).then(() => "timed out")])).toBe("Messenger worker stopped");
  await pool.close();
});

test("close aborts replacement waiters and escalates even if initial kill throws", async () => {
  const exited = Promise.withResolvers<number>();
  const signals: (number | NodeJS.Signals | undefined)[] = [];
  const spawn = (() => ({ stdout: new ReadableStream<Uint8Array>(), stderr: new ReadableStream<Uint8Array>(), exited: exited.promise,
    kill(signal?: number | NodeJS.Signals) { signals.push(signal); if (!signal) throw new Error("kill failed"); exited.resolve(0); },
    stdin: { write() {}, flush() {}, end() {} } })) as unknown as typeof Bun.spawn;
  const pool = createMessengerSessionPool(spawn, 16, 300000, 20);
  const controller = new AbortController();
  const first = pool.turn("one", ["worker"], "/tmp", {}, "first", controller.signal).catch(error => (error as Error).message);
  controller.abort();
  expect(await first).toBe("Messenger worker stopped");
  const second = pool.turn("one", ["worker"], "/tmp", {}, "second", new AbortController().signal).catch(error => (error as Error).message);
  await pool.close();
  expect(await second).toBe("Messenger request aborted");
  expect(signals).toEqual([undefined, "SIGKILL"]);
});