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
  const spawn = ((argv: string[], options: { cwd: string; env: Record<string, string>; stdin: "pipe"; stdout: "pipe"; stderr: "pipe" }) => {
    launches++;
    const launch = argv.indexOf("launch");
    return Bun.spawn([process.execPath, "--no-env-file", path.resolve(import.meta.dir, "../src/cli.ts"), ...argv.slice(launch)], { ...options, env: { ...options.env, HOME: root, JEO_CONFIG_DIR: configDir, OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1` } });
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
