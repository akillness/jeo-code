import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createMessengerCliReply } from "../src/commands/messenger";
import type { MessengerConfig, MessengerMessage } from "../src/messenger/types";

test("Discord retains session identity but replaces workers when selected model changes and disables unavailable fallback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-discord-model-worker-"));
  let selected = "gpt-6-terra";
  const selectModel = async (explicit: string | undefined) => {
    if (explicit === "unavailable") throw new Error("not available");
    return explicit ?? selected;
  };
  const workers: Array<{ argv: string[]; env: Record<string, string>; killed: boolean; historyAtStart: string; frames: unknown[]; signals: unknown[]; ipc: unknown; serialization: unknown }> = [];
  const spawn = ((argv: string[], opts: { env: Record<string, string>; ipc?: unknown; serialization?: unknown }) => {
    if (workers.length) expect(workers.at(-1)!.killed).toBe(true);
    const session = path.join(root, "sessions", `${argv[argv.indexOf("--resume") + 1]}.jsonl`);
    const frames: unknown[] = [];
    const signals: unknown[] = [];
    const worker = { argv, env: opts.env, killed: false, frames, signals, ipc: opts.ipc, serialization: opts.serialization, historyAtStart: syncFs.readFileSync(session, "utf8") };
    workers.push(worker);
    const exit = Promise.withResolvers<number>();
    let out!: ReadableStreamDefaultController<Uint8Array>;
    let err!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({ start(controller) { out = controller; } });
    const stderr = new ReadableStream<Uint8Array>({ start(controller) { err = controller; } });
    const nonce = opts.env.JEO_MESSENGER_SHUTDOWN_NONCE;
    const encoder = new TextEncoder();
    // Graceful cleanup is requested only by the exact private IPC frame carrying the parent-generated nonce:
    // the worker acknowledges that nonce on stderr, then exits 143 as modeled.
    const send = (frame: unknown) => {
      frames.push(frame);
      const f = frame as { type?: unknown; nonce?: unknown } | null;
      if (!f || Object.keys(f).sort().join() !== "nonce,type" || f.type !== "jeo_messenger_shutdown" || f.nonce !== nonce) return true;
      if (worker.killed) return true;
      worker.killed = true;
      err.enqueue(encoder.encode(`JEO_MESSENGER_SHUTDOWN_ACK ${JSON.stringify({ nonce, gone: true })}\n`));
      out.close(); err.close(); exit.resolve(143);
      return true;
    };
    // A signal models an actual crash: no acknowledgement and a signal exit status.
    const kill = (signal?: number | NodeJS.Signals) => {
      signals.push(signal);
      if (worker.killed) return;
      worker.killed = true;
      out.close(); err.close(); exit.resolve(signal === "SIGKILL" || signal === 9 ? 137 : 143);
    };
    return { stdout, stderr, exited: exit.promise, kill, send, stdin: { write(chunk: string) { if (worker.killed) throw new Error("worker stopped"); const prompt = JSON.parse(chunk); syncFs.appendFileSync(session, `${JSON.stringify({ prompt })}\n`); out.enqueue(encoder.encode('JEO_MESSENGER_RESULT "ok"\n')); }, flush() {}, end() {} } };
  }) as typeof Bun.spawn;
  const sandbox = { image: "oven/bun:1.3.14", limits: { memoryBytes: 256 * 1024 * 1024, pids: 64, cpus: 1 } };
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const config: MessengerConfig = { cwd: workspace, sessionDir: path.join(root, "sessions"), sandbox, toolNames: [], platforms: { discord: { tokenEnv: "TOKEN", allowedUserIds: ["owner"], usageFallbackModel: "unavailable" } } };
  const reply = createMessengerCliReply(config, spawn, selectModel);
  const message: MessengerMessage = { platform: "discord", accountId: "bot", channelId: "channel", senderId: "owner", messageId: "1", text: "hello", direct: true, mentioned: false };
  try {
    const signal = new AbortController().signal;
    expect(await reply(message, signal)).toBe("ok");
    selected = "gpt-7-terra";
    expect(await reply({ ...message, text: "B conversation" }, signal)).toBe("ok");
    selected = "gpt-6-terra";
    expect(await reply({ ...message, text: "third turn" }, signal)).toBe("ok");
    expect(workers).toHaveLength(3);
    expect(workers.map(worker => worker.argv[worker.argv.indexOf("--model") + 1])).toEqual(["gpt-6-terra", "gpt-7-terra", "gpt-6-terra"]);
    expect(workers[0]!.argv[workers[0]!.argv.indexOf("--resume") + 1]).toBe(workers[1]!.argv[workers[1]!.argv.indexOf("--resume") + 1]);
    expect(workers[1]!.argv[workers[1]!.argv.indexOf("--resume") + 1]).toBe(workers[2]!.argv[workers[2]!.argv.indexOf("--resume") + 1]);
    expect(workers[2]!.historyAtStart).toContain('"prompt":"B conversation"');
    expect(workers.every(worker => worker.env.JEO_MESSENGER_USAGE_FALLBACK_MODEL === undefined)).toBe(true);
    // Graceful replacement uses the private IPC frame, never a signal; workers 0 and 1 were retired by replacement.
    expect(workers.every(worker => typeof worker.ipc === "function" && worker.serialization === "json")).toBe(true);
    for (const retired of workers.slice(0, 2)) expect(retired.frames).toEqual([{ type: "jeo_messenger_shutdown", nonce: retired.env.JEO_MESSENGER_SHUTDOWN_NONCE }]);
    expect(workers.every(worker => worker.signals.length === 0)).toBe(true);
    expect(workers.every(worker => JSON.parse(worker.env.JEO_MESSENGER_SANDBOX!).image === "oven/bun:1.3.14")).toBe(true);
  } finally { await reply.close(); await fs.rm(root, { recursive: true, force: true }); }
});
