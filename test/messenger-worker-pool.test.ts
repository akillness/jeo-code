import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMessengerSessionPool } from "../src/messenger/session-pool";
import { createMessengerCliReply } from "../src/commands/messenger";
import { selectDiscordModel } from "../src/messenger/model-selection";
import type { ProviderModelsResult } from "../src/ai/model-discovery";
import type { MessengerConfig, MessengerMessage } from "../src/messenger/types";

test("default idle timeout retires a reused worker after ten minutes", async () => {
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  const realSetTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
    scheduled.push({ callback, delay });
    return realSetTimeout(callback, delay);
  }) as typeof setTimeout);
  const workers: { killed: boolean }[] = [];
  const spawn = (() => {
    const worker = { killed: false };
    workers.push(worker);
    const exit = Promise.withResolvers<number>();
    let out!: ReadableStreamDefaultController<Uint8Array>;
    let err!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({ start(c) { out = c; } });
    const stderr = new ReadableStream<Uint8Array>({ start(c) { err = c; } });
    return {
      stdout, stderr, exited: exit.promise,
      kill() { worker.killed = true; out.close(); err.close(); exit.resolve(0); },
      stdin: { write() { out.enqueue(new TextEncoder().encode('JEO_MESSENGER_RESULT "ok"\n')); }, flush() {}, end() {} },
    };
  }) as unknown as typeof Bun.spawn;
  const pool = createMessengerSessionPool(spawn);
  const signal = new AbortController().signal;
  try {
    expect(await pool.turn("one", ["worker"], "/tmp", {}, "first", signal)).toBe("ok");
    expect(await pool.turn("one", ["worker"], "/tmp", {}, "again", signal)).toBe("ok");
    expect(workers).toHaveLength(1);
    const idleTimers = scheduled.filter(entry => entry.delay === 600_000);
    expect(idleTimers).toHaveLength(2);
    idleTimers[1]!.callback();
    expect(workers[0]!.killed).toBe(true);
    expect(await pool.turn("one", ["worker"], "/tmp", {}, "after idle", signal)).toBe("ok");
    expect(workers).toHaveLength(2);
  } finally {
    await pool.close();
    timer.mockRestore();
  }
});



const message: MessengerMessage = { platform: "discord", accountId: "bot", channelId: "channel", senderId: "owner", messageId: "1", text: "hello", direct: true, mentioned: false };
// Discord now always requires the sandbox section; limits mirror the required contract.
const sandbox = { image: "local-test-image", limits: { memoryBytes: 268435456, pids: 32, cpus: 1 } };
// Real workers start the actual local runtime, so they use the already-qualified local image (no pull, no skip).
const realSandbox = { image: "oven/bun:1.3.14", limits: { ...sandbox.limits, pids: 64 } };
// Bounded, redacted copy of a real worker's stderr (tee: the pool still consumes the original stream).
function redact(text: string): string {
  let out = text.replaceAll("test-key", "[redacted]");
  for (const value of [process.env.HOME, process.env.JEO_DISCORD_BOT_TOKEN, "dotenv-secret", "dotenv-alias"]) if (value && value.length > 3) out = out.replaceAll(value, "[redacted]");
  return out.replace(/(bearer\s+)\S+/gi, "$1[redacted]").replace(/([A-Za-z0-9_]*(?:token|key|secret|password|authorization)[A-Za-z0-9_]*\s*[=:]\s*)\S+/gi, "$1[redacted]");
}
function captureStderr<T extends ReturnType<typeof Bun.spawn>>(child: T, sink: (read: () => Promise<string>) => void): T {
  const [forPool, forDiagnostics] = (child.stderr as ReadableStream<Uint8Array>).tee();
  let text = "";
  const done = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of forDiagnostics) if (text.length < 4000) text += decoder.decode(chunk, { stream: true });
  })().catch(() => {});
  sink(async () => { await Promise.race([done, Bun.sleep(200)]); return redact(text).slice(0, 4000); });
  return new Proxy(child, { get(target, key) {
    if (key === "stderr") return forPool;
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
async function withDiagnostics(readers: (() => Promise<string>)[], run: () => Promise<void>): Promise<void> {
  try { await run(); } catch (error) {
    const stderr = (await Promise.all(readers.map(read => read()))).join("\n---\n");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nworker stderr (redacted, bounded):\n${stderr || "<empty>"}`, { cause: error });
  }
}
// Workspace and private session storage are disjoint siblings; config stays outside both.
async function layout(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  return { root, workspace, sessionDir: path.join(root, "sessions") };
}
const selectModel: typeof selectDiscordModel = (explicit, opts) => selectDiscordModel(explicit, {
  ...opts,
  config: { providers: {}, defaultModel: "gpt-6.1-terra", thinkingLevel: "medium" },
  list: async (provider: ProviderModelsResult["provider"]) => ({ provider, ok: true, source: "oauth", models: provider === "openai" ? ["gpt-6.1-terra"] : [] }),
});

test("conversation workers are reused, isolated, evicted and closed", async () => {
  const { root, workspace, sessionDir } = await layout("jeo-worker-pool-");
  const config: MessengerConfig = { cwd: workspace, sessionDir, sandbox, toolNames: [], platforms: { discord: { tokenEnv: "JEO_DISCORD_BOT_TOKEN", allowedUserIds: ["owner"] } } };
  const workers: { id: number; killed: boolean; requests: string[]; kills: number; frames: unknown[] }[] = [];
  const spawnOptions: { ipc?: unknown; serialization?: unknown }[] = [];
  const commands: string[][] = [];
  const spawn = ((argv: string[], options: { env: Record<string, string>; ipc?: unknown; serialization?: unknown }) => {
    commands.push(argv);
    const nonce = options.env.JEO_MESSENGER_SHUTDOWN_NONCE;
    if (!nonce) throw new Error("parent did not supply a shutdown nonce");
    spawnOptions.push(options);
    const worker = { id: workers.length, killed: false, requests: [] as string[], kills: 0, frames: [] as unknown[] };
    workers.push(worker);
    const exit = Promise.withResolvers<number>();
    let out: ReadableStreamDefaultController<Uint8Array>;
    let err: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({ start(controller) { out = controller; } });
    const stderr = new ReadableStream<Uint8Array>({ start(controller) { err = controller; } });
    // Graceful stop happens only via the exact private IPC frame carrying the parent's nonce:
    // the cleanup is acknowledged on stderr, then the process exits 143.
    const send = (frame: unknown) => {
      worker.frames.push(frame);
      const f = frame as { type?: unknown; nonce?: unknown } | null;
      if (!f || Object.keys(f).sort().join() !== "nonce,type" || f.type !== "jeo_messenger_shutdown" || f.nonce !== nonce) return true;
      if (worker.killed) return true;
      worker.killed = true;
      err.enqueue(new TextEncoder().encode(`JEO_MESSENGER_SHUTDOWN_ACK ${JSON.stringify({ nonce, gone: true })}\n`));
      out.close(); err.close(); exit.resolve(143);
      return true;
    };
    // A signal is an actual crash: no acknowledgement.
    const kill = () => {
      worker.kills++;
      if (worker.killed) return;
      worker.killed = true;
      out.close(); err.close(); exit.resolve(143);
    };
    return {
      stdout, stderr, exited: exit.promise, kill, send,
      stdin: { write(chunk: string | Uint8Array) { const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk); for (const line of text.trim().split("\n")) { const prompt = JSON.parse(line); worker.requests.push(prompt); out.enqueue(new TextEncoder().encode(`JEO_MESSENGER_RESULT ${JSON.stringify(`worker ${worker.id}: ${prompt}`)}\n`)); } return text.length; }, flush() {}, end() {} },
    };
  }) as typeof Bun.spawn;
  const reply = createMessengerCliReply(config, spawn, selectModel);
  try {
    const signal = new AbortController().signal;
    expect(await reply(message, signal)).toBe("worker 0: hello");
    expect(await reply({ ...message, messageId: "2", text: "again" }, signal)).toBe("worker 0: again");
    expect(workers).toHaveLength(1);
    expect(await reply({ ...message, senderId: "second" }, signal)).toBe("worker 1: hello");
    expect(workers[0]!.requests).toEqual(["hello", "again"]);
    for (let i = 2; i < 8; i++) await reply({ ...message, senderId: `user-${i}` }, signal);
    expect(workers).toHaveLength(8);
    expect(await reply(message, signal)).toBe("worker 0: hello"); // Refresh the oldest session.
    expect(await reply({ ...message, senderId: "user-8" }, signal)).toBe("worker 8: hello");
    expect(workers[0]!.killed).toBe(false);
    expect(workers[1]!.killed).toBe(true);
    expect(await reply({ ...message, senderId: "second" }, signal)).toBe("worker 9: hello");
    const resumedId = (command: string[]) => command[command.indexOf("--resume") + 1];
    expect(commands[1]).toContain("--resume");
    expect(resumedId(commands[9]!)).toBe(resumedId(commands[1]!));
  } finally { await reply.close(); await fs.rm(root, { recursive: true, force: true }); }
  expect(workers.every(worker => worker.killed)).toBe(true);
  // Protected graceful retirement/close never signals; each worker got exactly one exact private frame.
  expect(workers.every(worker => worker.kills === 0)).toBe(true);
  expect(workers.every(worker => worker.frames.length === 1 && (worker.frames[0] as { type: string }).type === "jeo_messenger_shutdown")).toBe(true);
  expect(spawnOptions).toHaveLength(workers.length);
  for (const options of spawnOptions) {
    expect(typeof options.ipc).toBe("function");
    expect(options.serialization).toBe("json");
  }
});

test("messenger worker keeps its profile private from grant authority", async () => {
  const { root, workspace, sessionDir } = await layout("jeo-worker-profile-");
  const profile = path.join(root, "profile");
  const resource = path.join(root, "resource");
  const configDir = path.join(root, "config");
  await Promise.all([profile, resource, configDir].map(dir => fs.mkdir(dir)));
  const credential = path.join(profile, "credentials.json");
  await fs.writeFile(credential, "sentinel credential");
  await fs.writeFile(path.join(workspace, "work.txt"), "workspace data");
  const report = path.join(root, "report.json");
  const preload = path.join(root, "preload.ts");
  const authorityModule = path.resolve(import.meta.dir, "../src/agent/sandbox/authority.ts");
  // The child-only preload observes the real authority at its construction boundary and aborts
  // before provider or Docker access. Dynamic loading is necessary to install the isolated module override.
  await fs.writeFile(preload, `
import { mock } from "bun:test";
import * as fs from "node:fs/promises";
const name = ${JSON.stringify(authorityModule)};
const real = await import(name);
const createRealAuthority = real.createGrantAuthority;
mock.module(name, () => ({ ...real, createGrantAuthority: async options => {
  const authority = await createRealAuthority(options);
  const attempt = async target => {
    try { await authority.requestAccess(target, "ro"); return "allowed"; }
    catch (error) { return String(error); }
  };
  const privateResult = await attempt(${JSON.stringify(credential)});
  const safeResult = await attempt(${JSON.stringify(resource)});
  await fs.writeFile(${JSON.stringify(report)}, JSON.stringify({ privateResult, safeResult }));
  throw new Error("profile test complete");
} }));
`);
  const config: MessengerConfig = { cwd: workspace, sessionDir, profileDir: profile, sandbox, toolNames: [], platforms: { discord: { tokenEnv: "JEO_DISCORD_BOT_TOKEN", allowedUserIds: ["owner"] } } };
  const readers: (() => Promise<string>)[] = [];
  const spawn = ((argv: string[], options: Parameters<typeof Bun.spawn>[1]) => {
    const env = Object.fromEntries(Object.entries(options?.env ?? {}).filter(([name]) => name.startsWith("JEO_MESSENGER_") || name === "JEO_SESSION_DIR"));
    const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", preload, path.resolve(import.meta.dir, "../src/cli.ts"), ...argv.slice(argv.indexOf("launch"))], {
      ...options, env: { ...env, PATH: process.env.PATH ?? "", HOME: root, JEO_CONFIG_DIR: configDir }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    return captureStderr(child, read => readers.push(read));
  }) as typeof Bun.spawn;
  const reply = createMessengerCliReply(config, spawn, selectModel);
  try {
    await withDiagnostics(readers, async () => {
      await expect(reply(message, new AbortController().signal)).rejects.toThrow();
      const result = JSON.parse(await fs.readFile(report, "utf8"));
      expect(result.privateResult).toContain("SANDBOX_POLICY");
      expect(result.safeResult).toBe("allowed");
      expect(await fs.readFile(credential, "utf8")).toBe("sentinel credential");
      expect(await fs.readFile(path.join(workspace, "work.txt"), "utf8")).toBe("workspace data");
    });
  } finally { await reply.close(); await fs.rm(root, { recursive: true, force: true }); }
}, 30000);

test("messenger configuration overrides an inherited profile in the worker", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-inherited-profile-"));
  try {
    const inheritedProfile = path.join(root, "other-profile");
    await fs.mkdir(inheritedProfile);
    // Isolate the inherited environment in a separate runner rather than mutating this test process.
    const child = Bun.spawn([process.execPath, "test", path.resolve(import.meta.path), "-t", "messenger worker keeps its profile private from grant authority"], {
      env: { PATH: process.env.PATH ?? "", HOME: root, JEO_MESSENGER_PROFILE_DIR: inheritedProfile },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ exit, stderr }).toMatchObject({ exit: 0 });
    expect(stderr).toContain("1 pass");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 30000);

test("launch rejects relative and workspace-overlapping messenger profiles", async () => {
  const { root, workspace, sessionDir } = await layout("jeo-launch-profile-");
  const configDir = path.join(root, "config");
  await fs.mkdir(configDir);
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({ providers: {}, defaultModel: "openai/gpt-4o-mini" }));
  try {
    for (const [profile, expected] of [["relative-profile", "invalid messenger profile directory"], [workspace, "sandbox workspace must be disjoint"]]) {
      const child = Bun.spawn([process.execPath, "--no-env-file", path.resolve(import.meta.dir, "../src/cli.ts"), "launch", "--print", "--no-tui", "--no-skills", "--literal-worker", "--no-tools", "--", "worker"], {
        cwd: workspace, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { PATH: process.env.PATH ?? "", HOME: root, JEO_CONFIG_DIR: configDir, JEO_SESSION_DIR: sessionDir, JEO_MESSENGER_SESSION_KEY: "profile-test", JEO_MESSENGER_SANDBOX: JSON.stringify(sandbox), JEO_MESSENGER_PROFILE_DIR: profile! },
      });
      const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(exit).not.toBe(0);
      expect(stderr).toContain("SANDBOX_PRIVATE_STATE");
      expect(stderr).toContain(expected!);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 30000);

test("real worker serves multiple turns and isolates conversations", async () => {
  const { root, workspace, sessionDir } = await layout("jeo-real-worker-");
  const configDir = path.join(root, "config");
  await fs.mkdir(configDir);
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({ providers: {}, defaultModel: "openai/gpt-4o-mini" }));
  const requests: unknown[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] });
    requests.push(await request.json());
    return Response.json({ choices: [{ message: { role: "assistant", content: `**answer ${requests.length}**` }, finish_reason: "stop" }] });
  } });
  const config: MessengerConfig = { cwd: workspace, sessionDir, sandbox: realSandbox, toolNames: [], platforms: { discord: { tokenEnv: "JEO_DISCORD_BOT_TOKEN", allowedUserIds: ["owner"] } } };
  let launches = 0;
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const spawn = ((argv: string[], options: { cwd: string; env: Record<string, string>; stdin: "pipe"; stdout: "pipe"; stderr: "pipe" }) => {
    launches++;
    const launch = argv.indexOf("launch");
    const child = Bun.spawn([process.execPath, "--no-env-file", path.resolve(import.meta.dir, "../src/cli.ts"), ...argv.slice(launch)], { ...options, env: { ...options.env, JEO_CONFIG_DIR: configDir, OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1` } });
    children.push(child);
    return captureStderr(child, read => readers.push(read));
  }) as typeof Bun.spawn;
  const readers: (() => Promise<string>)[] = [];
  const reply = createMessengerCliReply(config, spawn, selectModel);
  try {
    await withDiagnostics(readers, async () => {
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
    });
  } finally { await reply.close(); server.stop(true); await fs.rm(root, { recursive: true, force: true }); }
}, 30000);

test("compiled CLI preserves two turns in one worker", async () => {
  const { root, workspace, sessionDir } = await layout("jeo-compiled-worker-");
  const configDir = path.join(root, "config");
  const executable = path.join(root, "jeo");
  await fs.mkdir(configDir);
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({ providers: {}, defaultModel: "openai/gpt-4o-mini" }));
  const build = Bun.spawn([process.execPath, "build", path.resolve(import.meta.dir, "../src/cli.ts"), "--compile", "--keep-names", "--external", "chromium-bidi", "--no-compile-autoload-dotenv", "--outfile", executable], { stdout: "pipe", stderr: "pipe" });
  await fs.writeFile(path.join(workspace, ".env"), "JEO_DISCORD_BOT_TOKEN=dotenv-secret\nJEOPI_DISCORD_BOT_TOKEN=dotenv-alias\n");
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
  const config: MessengerConfig = { cwd: workspace, sessionDir, sandbox: realSandbox, toolNames: [], platforms: { discord: { tokenEnv: "JEO_DISCORD_BOT_TOKEN", allowedUserIds: ["owner"] } } };
  let launches = 0;
  const spawn = ((argv: string[], options: { cwd: string; env: Record<string, string>; stdin: "pipe"; stdout: "pipe"; stderr: "pipe" }) => {
    launches++;
    const child = Bun.spawn([executable, ...argv.slice(argv.indexOf("launch"))], { ...options, env: { ...options.env, JEO_CONFIG_DIR: configDir, OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1` } });
    return captureStderr(child, read => readers.push(read));
  }) as typeof Bun.spawn;
  const readers: (() => Promise<string>)[] = [];
  const reply = createMessengerCliReply(config, spawn, selectModel);
  try {
    await withDiagnostics(readers, async () => {
    const signal = new AbortController().signal;
    expect(await reply(message, signal)).toBe("compiled answer 1");
    expect(await reply({ ...message, messageId: "2", text: "/theme matrix" }, signal)).toBe("compiled answer 2");
    expect(launches).toBe(1);
    expect(calls).toBe(2);
    expect(JSON.stringify(modelRequests[1])).toContain("/theme matrix");
    expect(JSON.stringify(modelRequests)).not.toContain("dotenv-secret");
    expect(JSON.stringify(modelRequests)).not.toContain("dotenv-alias");
    expect(JSON.parse(await fs.readFile(path.join(configDir, "config.json"), "utf8")).theme).toBeUndefined();
    });
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

// Bounded barrier: a fixed number of macrotask turns lets queued pool continuations run without wall-clock sleeps.
async function turns(count = 5): Promise<void> { for (let i = 0; i < count; i++) await Bun.sleep(0); }
// Per-spawn fake workers. Prompts listed in `held` get no reply until release(prompt); others reply "w<id>:<prompt>".
function fakeWorkers(held: string[] = []) {
  const workers: { id: number; requests: string[]; killed: boolean }[] = [];
  const pending = new Map<string, () => void>();
  const spawn = (() => {
    const worker = { id: workers.length, requests: [] as string[], killed: false };
    workers.push(worker);
    const exit = Promise.withResolvers<number>();
    let out!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({ start(c) { out = c; } });
    const reply = (prompt: string) => out.enqueue(new TextEncoder().encode(`JEO_MESSENGER_RESULT ${JSON.stringify(`w${worker.id}:${prompt}`)}\n`));
    return { stdout, stderr: new ReadableStream<Uint8Array>(), exited: exit.promise,
      kill() { if (worker.killed) return; worker.killed = true; try { out.close(); } catch {} exit.resolve(0); },
      stdin: { write(chunk: string | Uint8Array) {
        const prompt = JSON.parse(typeof chunk === "string" ? chunk.trim() : new TextDecoder().decode(chunk).trim()) as string;
        worker.requests.push(prompt);
        if (held.includes(prompt)) pending.set(prompt, () => reply(prompt)); else reply(prompt);
      }, flush() {}, end() {} } };
  }) as unknown as typeof Bun.spawn;
  return { workers, spawn, release(prompt: string) { const send = pending.get(prompt); if (!send) throw new Error(`no held prompt ${prompt}`); pending.delete(prompt); send(); } };
}
const settleOf = <T>(promise: Promise<T>) => promise.then(value => ({ value }), (error: unknown) => ({ error: (error as Error).message }));

test("natural exit queues a same-key turn FIFO behind the draining result instead of overlapping it", async () => {
  const events: string[] = [];
  const firstExit = Promise.withResolvers<number>();
  let firstOut!: ReadableStreamDefaultController<Uint8Array>;
  let firstResultSent = false;
  const requests: string[][] = [];
  let launches = 0;
  const spawn = (() => {
    const id = launches++;
    events.push(`spawn${id}`);
    if (id === 1) expect(firstResultSent).toBe(true); // no second worker before the first result was delivered
    const mine: string[] = [];
    requests.push(mine);
    const exit = id === 0 ? firstExit : Promise.withResolvers<number>();
    let out!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({ start(c) { out = c; if (id === 0) firstOut = c; } });
    return { stdout, stderr: new ReadableStream<Uint8Array>(), exited: exit.promise,
      kill() { if (id) { try { out.close(); } catch {} exit.resolve(0); } },
      stdin: { write(chunk: string | Uint8Array) {
        const prompt = JSON.parse(typeof chunk === "string" ? chunk.trim() : new TextDecoder().decode(chunk).trim()) as string;
        mine.push(prompt);
        if (id === 1) out.enqueue(new TextEncoder().encode(`JEO_MESSENGER_RESULT ${JSON.stringify(`second-own:${prompt}`)}\n`));
      }, flush() {}, end() {} } };
  }) as unknown as typeof Bun.spawn;
  const pool = createMessengerSessionPool(spawn);
  const signal = new AbortController().signal;
  const first = settleOf(pool.turn("one", ["worker"], "/tmp", {}, "first", signal));
  first.then(() => events.push("first-settled"));
  firstExit.resolve(0);
  await turns();
  const secondPromise = pool.turn("one", ["worker"], "/tmp", {}, "second", signal);
  const second = settleOf(secondPromise);
  second.then(() => events.push("second-settled"));
  await turns();
  // Still queued: neither settled, no second spawn, nothing written to the draining worker.
  expect(events).toEqual(["spawn0"]);
  expect(launches).toBe(1);
  expect(requests[0]).toEqual(["first"]);
  firstResultSent = true;
  firstOut.enqueue(new TextEncoder().encode('JEO_MESSENGER_RESULT "first"\n'));
  firstOut.close();
  expect(await first).toEqual({ value: "first" });
  expect(await second).toEqual({ value: "second-own:second" });
  expect([...events].sort()).toEqual(["first-settled", "second-settled", "spawn0", "spawn1"]);
  expect(events.indexOf("first-settled")).toBeLessThan(events.indexOf("second-settled"));
  expect(events.indexOf("spawn1")).toBeLessThan(events.indexOf("second-settled"));
  expect(launches).toBe(2);
  expect(requests).toEqual([["first"], ["second"]]);
  await pool.close();
});

test("a queued same-key request that is cancelled rejects promptly and does not let a later one jump the queue", async () => {
  const fake = fakeWorkers(["first"]);
  const pool = createMessengerSessionPool(fake.spawn);
  const signal = new AbortController().signal;
  const cancel = new AbortController();
  const first = settleOf(pool.turn("one", ["worker"], "/tmp", {}, "first", signal));
  await turns();
  const second = settleOf(pool.turn("one", ["worker"], "/tmp", {}, "second", cancel.signal));
  const third = settleOf(pool.turn("one", ["worker"], "/tmp", {}, "third", signal));
  let thirdSettled = false;
  third.then(() => { thirdSettled = true; });
  await turns();
  cancel.abort();
  // The cancelled waiter settles while the first turn is still running (not only after it finishes).
  expect(await Promise.race([second, turns(50).then(() => "not prompt")])).toEqual({ error: "Messenger request aborted" });
  await turns();
  expect(thirdSettled).toBe(false);
  expect(fake.workers.map(w => w.requests)).toEqual([["first"]]);
  fake.release("first");
  expect(await first).toEqual({ value: "w0:first" });
  expect(await third).toEqual({ value: "w0:third" });
  expect(fake.workers.flatMap(w => w.requests)).toEqual(["first", "third"]);
  await pool.close();
});

test("a queued same-key turn does not block other keys, even when worker slots are scarce", async () => {
  const fake = fakeWorkers(["a1"]);
  const pool = createMessengerSessionPool(fake.spawn, 2);
  const signal = new AbortController().signal;
  const a1 = settleOf(pool.turn("a", ["worker"], "/tmp", {}, "a1", signal));
  await turns();
  const a2 = settleOf(pool.turn("a", ["worker"], "/tmp", {}, "a2", signal));
  let a2Settled = false;
  a2.then(() => { a2Settled = true; });
  await turns();
  // Key "a" is held with a waiter queued; keys "b" and "c" (the latter needs to reclaim idle "b") must still progress.
  expect(await Promise.race([settleOf(pool.turn("b", ["worker"], "/tmp", {}, "b1", signal)), turns(200).then(() => "blocked")])).toEqual({ value: "w1:b1" });
  expect(await Promise.race([settleOf(pool.turn("c", ["worker"], "/tmp", {}, "c1", signal)), turns(200).then(() => "blocked")])).toEqual({ value: "w2:c1" });
  expect(a2Settled).toBe(false);
  expect(fake.workers[0]!.requests).toEqual(["a1"]);
  fake.release("a1");
  expect(await a1).toEqual({ value: "w0:a1" });
  expect(await a2).toEqual({ value: "w0:a2" });
  expect(fake.workers).toHaveLength(3);
  await pool.close();
});

test("close rejects queued same-key requests without launching anything for them", async () => {
  const fake = fakeWorkers(["first"]);
  const pool = createMessengerSessionPool(fake.spawn);
  const signal = new AbortController().signal;
  const first = settleOf(pool.turn("one", ["worker"], "/tmp", {}, "first", signal));
  await turns();
  const second = settleOf(pool.turn("one", ["worker"], "/tmp", {}, "second", signal));
  const third = settleOf(pool.turn("one", ["worker"], "/tmp", {}, "third", signal));
  await turns();
  await pool.close();
  expect(await first).toEqual({ error: "Messenger worker stopped" });
  expect(await second).toEqual({ error: "Messenger request aborted" });
  expect(await third).toEqual({ error: "Messenger request aborted" });
  expect(fake.workers).toHaveLength(1);
  expect(fake.workers[0]!.requests).toEqual(["first"]);
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