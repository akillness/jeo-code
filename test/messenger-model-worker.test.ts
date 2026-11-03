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
  const workers: Array<{ argv: string[]; env: Record<string, string>; killed: boolean; historyAtStart: string }> = [];
  const spawn = ((argv: string[], opts: { env: Record<string, string> }) => {
    if (workers.length) expect(workers.at(-1)!.killed).toBe(true);
    const session = path.join(root, "sessions", `${argv[argv.indexOf("--resume") + 1]}.jsonl`);
    const worker = { argv, env: opts.env, killed: false, historyAtStart: syncFs.readFileSync(session, "utf8") };
    workers.push(worker);
    const exit = Promise.withResolvers<number>();
    let out!: ReadableStreamDefaultController<Uint8Array>;
    let err!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({ start(controller) { out = controller; } });
    const stderr = new ReadableStream<Uint8Array>({ start(controller) { err = controller; } });
    const kill = () => { if (!worker.killed) { worker.killed = true; out.close(); err.close(); exit.resolve(0); } };
    return { stdout, stderr, exited: exit.promise, kill, stdin: { write(chunk: string) { const prompt = JSON.parse(chunk); syncFs.appendFileSync(session, `${JSON.stringify({ prompt })}\n`); out.enqueue(new TextEncoder().encode('JEO_MESSENGER_RESULT "ok"\n')); }, flush() {}, end() { kill(); } } };
  }) as typeof Bun.spawn;
  const config: MessengerConfig = { cwd: root, sessionDir: path.join(root, "sessions"), toolNames: [], platforms: { discord: { tokenEnv: "TOKEN", allowedUserIds: ["owner"], usageFallbackModel: "unavailable" } } };
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
  } finally { await reply.close(); await fs.rm(root, { recursive: true, force: true }); }
});
