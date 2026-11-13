import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMessengerCliReply } from "../../src/commands/messenger";
import { parseMessengerConfig } from "../../src/messenger/config";
import { createMessengerGateway } from "../../src/messenger/gateway";
import type { DiscordHostBootstrap, MessengerAdapter, MessengerMessage } from "../../src/messenger/types";

// This executable is also the real bash-tool payload: no module mocks or provider traffic leave loopback.
if (process.argv[2] === "payload") {
  const [url, label, outside, operation] = process.argv.slice(3);
  if (!url || !label || !outside) throw new Error("Payload arguments missing");
  const cwd = await fs.realpath(process.cwd());
  await fs.appendFile(path.join(path.dirname(outside), "payloads.jsonl"), `${JSON.stringify({ pid: process.pid, outside })}\n`);
  await fs.writeFile(path.join(cwd, "victim.txt"), "operator-owned fixture\n");
  const observation = { label, cwd, uid: process.getuid?.(), pid: process.pid, outside: await fs.readFile(outside, "utf8") };
  const response = await fetch(`${url}/effect`, { method: "POST", body: JSON.stringify(observation) });
  if (!response.ok) throw new Error("Effect barrier rejected");
  if (operation === "heartbeat") {
    // Each tick is explicitly requested by the parent; no timer or elapsed-time guess proves liveness.
    for (;;) {
      const tick = await fetch(`${url}/heartbeat/${label}`, { method: "POST", body: JSON.stringify({ pid: process.pid }) });
      if (!tick.ok) throw new Error("Heartbeat barrier closed");
    }
  }
  console.log(JSON.stringify(observation));
  process.exit(0);
}

const [root, mode] = process.argv.slice(2);
if (!root || !mode) throw new Error("Root and scenario required");
const sourceCwd = path.join(root, "source");
const configDir = path.join(root, "config");
const outside = path.join(root, "allowed-outside.txt");
await Promise.all([fs.mkdir(sourceCwd), fs.mkdir(configDir), fs.writeFile(outside, "outside-worktree sentinel\n")]);
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`Fixture Git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.toString().trim();
}
git(sourceCwd, "init", "-q", "-b", "source");
git(sourceCwd, "config", "user.name", "Host Worker Test");
git(sourceCwd, "config", "user.email", "host-worker@example.invalid");
git(sourceCwd, "config", "commit.gpgsign", "false");
git(sourceCwd, "config", "core.hooksPath", "/dev/null");
await fs.writeFile(path.join(sourceCwd, "base.txt"), "committed base\n");
git(sourceCwd, "add", "base.txt");
git(sourceCwd, "commit", "-qm", "base");

interface Effect { label: string; cwd: string; uid: number; pid: number; outside: string }
interface Tick { count: number; release: () => void }
interface Worker {
  child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  bootstrap?: DiscordHostBootstrap;
  nonce: string;
  cwd: string;
  diagnostics: string;
  ipc: boolean;
  forcedKills: number;
  ackChecks: Array<Promise<{ gone: boolean; receipt: boolean; payloadAlive: boolean }>>;
}
const effects = new Map<string, Effect>();
const prepared = Promise.withResolvers<void>();
const effectWaiters = new Map<string, { promise: Promise<Effect>; resolve(value: Effect): void }>();
const ticks = new Map<string, Tick>();
const tickWaiters = new Map<string, { promise: Promise<Tick>; resolve(value: Tick): void }>();
const workers: Worker[] = [];
const providerPrompts: string[] = [];
let modelControl = "";
let historyRestored = false;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } };
const exists = (file: string) => fs.access(file).then(() => true, () => false);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function effect(label: string) {
  const previous = effects.get(label);
  if (previous) return Promise.resolve(previous);
  let waiter = effectWaiters.get(label);
  if (!waiter) { waiter = Promise.withResolvers<Effect>(); effectWaiters.set(label, waiter); }
  return barrier(waiter.promise);
}
function heartbeat(label: string, after = 0): Promise<Tick> {
  const previous = ticks.get(label);
  if (previous && previous.count > after) return Promise.resolve(previous);
  let waiter = tickWaiters.get(label);
  if (!waiter) { waiter = Promise.withResolvers<Tick>(); tickWaiters.set(label, waiter); }
  return barrier(waiter.promise);
}
function completion(content: string | null, tool?: { id: string; type: string; function: { name: string; arguments: string } }, stream = false) {
  const finish_reason = tool ? "tool_calls" : "stop";
  if (!stream) return Response.json({ choices: [{ message: { role: "assistant", content, ...(tool ? { tool_calls: [tool] } : {}) }, finish_reason }] });
  const delta = tool ? { tool_calls: [{ index: 0, ...tool }] } : { content };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/effect") {
    const value = await request.json() as Effect;
    effects.set(value.label, value);
    effectWaiters.get(value.label)?.resolve(value);
    return new Response("ok");
  }
  if (url.pathname.startsWith("/heartbeat/")) {
    const label = url.pathname.slice("/heartbeat/".length);
    const ready = Promise.withResolvers<void>();
    const tick = { count: (ticks.get(label)?.count ?? 0) + 1, release: () => ready.resolve() };
    ticks.set(label, tick);
    tickWaiters.get(label)?.resolve(tick);
    tickWaiters.delete(label);
    await ready.promise;
    return new Response("continue");
  }
  if (request.method !== "POST") return Response.json({ data: [{ id: "host-worker-fixture" }] });
  const body = await request.json() as { stream?: boolean; messages: Array<{ role: string; content: unknown }> };
  const messages = body.messages;
  const lastUserIndex = messages.findLastIndex(message => message.role === "user");
  const prompt = String(messages[lastUserIndex]?.content ?? "");
  providerPrompts.push(prompt);
  const marker = /HOST_CASE:([a-z-]+)/.exec(prompt)?.[1];
  if (marker === "model-control") return completion(modelControl, undefined, body.stream);
  if (marker === "restore") {
    historyRestored = messages.slice(0, lastUserIndex).some(message => message.role === "user" && String(message.content).includes("HOST_CASE:probe-a"));
    const observation = [...effects.values()].find(value => value.label === "a");
    return completion(`restored:${observation?.cwd}`, undefined, body.stream);
  }
  if (messages.slice(lastUserIndex + 1).some(message => message.role === "tool")) return completion(`completed:${marker}`, undefined, body.stream);
  let command: string;
  if (marker === "delete-a") command = "rm -- victim.txt";
  else if (marker === "probe-a" || marker === "probe-b" || marker === "heartbeat-a" || marker === "heartbeat-b") {
    command = `bun run test:${marker}`;
  } else return completion(`literal:${prompt}`, undefined, body.stream);
  return completion(null, { id: `call-${providerPrompts.length}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }, body.stream);
} });
// Ordinary project test scripts are CLI-trusted by contract, not an OS sandbox boundary.
const scripts: Record<string, string> = {};
for (const marker of ["probe-a", "probe-b", "heartbeat-a", "heartbeat-b"]) {
  scripts[`test:${marker}`] = [process.execPath, path.resolve(import.meta.path), "payload", `http://127.0.0.1:${server.port}`, marker.endsWith("-a") ? "a" : "b", outside, marker.startsWith("heartbeat") ? "heartbeat" : "probe"].map(quote).join(" ");
}
await fs.writeFile(path.join(sourceCwd, "package.json"), JSON.stringify({ private: true, scripts }));
git(sourceCwd, "add", "package.json");
git(sourceCwd, "commit", "-qm", "trusted fixture test scripts");
await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({
  providers: { openai: "sk-test-host-worker-only" }, defaultModel: "openai/host-worker-fixture",
  openaiBaseUrl: `http://127.0.0.1:${server.port}/v1`, routing: { enabled: false }, computer: { enabled: false }, gitAutoCommit: false,
}));
const config = parseMessengerConfig({
  cwd: sourceCwd, sessionDir: path.join(root, "sessions"), toolNames: ["bash", "read", "edit"],
  platforms: { discord: { workerMode: "host", allowedUserIds: ["operator"], allowedChannelIds: ["channel"], model: "openai/host-worker-fixture" } },
}, root);
function message(threadId: string, id: string, text: string, senderId = "operator"): MessengerMessage {
  return { platform: "discord", accountId: "offline-bot", guildId: "guild", channelId: threadId, parentChannelId: "channel", threadId, senderId, messageId: id, text, direct: false, mentioned: false };
}
const notifications: Array<{ message: MessengerMessage; text: string }> = [];
let noticeWaiter = Promise.withResolvers<{ message: MessengerMessage; text: string }>();
const delivered: Array<{ message: MessengerMessage; text: string }> = [];
const errors: string[] = [];
const failed = Promise.withResolvers<never>();
void failed.promise.catch(() => {});
function barrier<T>(promise: Promise<T>): Promise<T> { return Promise.race([promise, failed.promise]); }
const spawn = ((cmd: string[], options: Parameters<typeof Bun.spawn>[1]) => {
  const launch = cmd.indexOf("launch");
  if (launch < 0) throw new Error("Expected actual CLI launch command");
  const binary = process.env.JEO_TEST_CLI_BINARY;
  const argv = binary ? [binary, ...cmd.slice(launch)] : [process.execPath, "--no-env-file", path.resolve(import.meta.dir, "../../src/cli.ts"), ...cmd.slice(launch)];
  const rawBootstrap = options?.env?.JEO_MESSENGER_HOST_BOOTSTRAP;
  if (typeof rawBootstrap !== "string") throw new Error("Host worker bootstrap absent; refusing native/container execution");
  const bootstrap = JSON.parse(rawBootstrap) as DiscordHostBootstrap;
  const child = Bun.spawn(argv, { ...options, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const worker: Worker = { child, bootstrap, nonce: String(options?.env?.JEO_MESSENGER_SHUTDOWN_NONCE ?? ""), cwd: String(options?.cwd), diagnostics: "", ipc: typeof options?.ipc === "function" && options?.serialization === "json", forcedKills: 0, ackChecks: [] };
  workers.push(worker);
  let buffered = "";
  const stderr = child.stderr.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
    const text = new TextDecoder().decode(chunk);
    worker.diagnostics += text;
    buffered += text;
    const lines = buffered.split("\n"); buffered = lines.pop()!;
    for (const line of lines) if (line.startsWith("JEO_MESSENGER_SHUTDOWN_ACK ")) {
      const ack = JSON.parse(line.slice("JEO_MESSENGER_SHUTDOWN_ACK ".length));
      const payload = [...effects.values()].find(value => value.cwd === worker.cwd);
      const payloadAlive = payload ? alive(payload.pid) : false;
      let receipt = false;
      try {
        const persisted = JSON.parse(readFileSync(bootstrap.cleanupReceipt, "utf8"));
        receipt = persisted.gone === true && persisted.nonce === bootstrap.nonce && persisted.epoch === bootstrap.scope.epoch && persisted.pid === child.pid;
      } catch {}
      worker.ackChecks.push(Promise.resolve({ gone: ack.gone === true && ack.nonce === worker.nonce && ack.epoch === bootstrap.scope.epoch, receipt, payloadAlive }));
    }
    controller.enqueue(chunk);
  } }));
  return new Proxy(child, { get(target, key) {
    if (key === "stderr") return stderr;
    if (key === "kill") return (...args: Parameters<typeof child.kill>) => { worker.forcedKills++; return target.kill(...args); };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}) as typeof Bun.spawn;
function composition() {
  let cancelConversation: ((key: string) => void) | undefined;
  const reply = createMessengerCliReply(config, spawn, async model => model!, { cancelConversation: key => cancelConversation?.(key), notifyHostAction: async (destination, text) => {
    const notification = { message: destination, text };
    notifications.push(notification); noticeWaiter.resolve(notification);
    if (mode !== "approval") failed.reject(new Error(`Unexpected action approval during ${mode}: ${text}`));
  } });
  let lifecycle: ((event: Parameters<typeof reply.onThreadLifecycle>[0]) => Promise<void>) | undefined;
  const ready = Promise.withResolvers<void>();
  const adapter: MessengerAdapter = {
    platform: "discord",
    start: async (_onMessage, signal, onLifecycle) => {
      lifecycle = onLifecycle;
      ready.resolve();
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    prepare: async destination => {
      if (destination.messageId === "queued-c") prepared.resolve();
      return destination;
    },
    send: async (destination, text) => { delivered.push({ message: destination, text }); },
  };
  const gateway = createMessengerGateway(config, [adapter], reply, {
    concurrency: mode === "queue-cancel" ? 1 : 2, sandboxControl: reply.sandboxControl, onThreadLifecycle: reply.onThreadLifecycle,
    onRequestSettled: reply.onRequestSettled, onRequestError: (_message, error) => {
      errors.push(String(error));
      failed.reject(error);
    },
  });
  cancelConversation = gateway.cancelConversation;
  const controller = new AbortController();
  const running = gateway.run(controller.signal);
  return { reply, gateway, controller, running, ready: ready.promise, lifecycle: async (threadId: string) => {
    // Adapter start has registered the real trusted-lifecycle callback before any request is admitted.
    if (!lifecycle) throw new Error("Gateway lifecycle callback was not installed");
    await lifecycle({ kind: "archive", accountId: "offline-bot", guildId: "guild", parentChannelId: "channel", threadId });
  } };
}
let host = composition();
const turns: Promise<void>[] = [];
function start(thread: string, id: string, text: string) {
  const turn = host.ready.then(() => host.gateway.handle(message(thread, id, text)));
  turns.push(turn);
  return turn;
}
async function ack(worker: Worker) {
  await worker.child.exited;
  const checks = await Promise.all(worker.ackChecks);
  expect(checks.length).toBe(1);
  expect(checks[0]!.gone).toBe(true);
  return checks[0]!;
}
let result: Record<string, unknown> = {};
let phase = "starting";
// A real-process watchdog bounds hangs only; all successful assertions await effects, IPC, exit, or heartbeat barriers.
const watchdog = setTimeout(() => {
  process.stderr.write(`${JSON.stringify({ phase, notifications, providerPrompts, effects: [...effects.values()], errors, workers: workers.map(worker => ({ cwd: worker.cwd, exit: worker.child.exitCode, diagnostics: worker.diagnostics })) })}\n`);
  host.controller.abort();
  for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill("SIGTERM");
}, 85_000);
try {
  if (mode === "probe" || mode === "approval" || mode === "restart") {
    await barrier(start("a", "probe-a", "HOST_CASE:probe-a"));
    phase = "probe turn settled";
    expect(errors).toEqual([]);
    const observed = await effect("a");
    phase = "probe effect observed";
    expect(observed.cwd).not.toBe(sourceCwd);
    expect(observed.outside).toBe("outside-worktree sentinel\n");
    expect(observed.uid).toBe(process.getuid!());
    expect(git(observed.cwd, "rev-parse", "--show-toplevel")).toBe(observed.cwd);
    if (mode === "probe") result = { hostUid: observed.uid, expectedUid: process.getuid!(), outsideText: observed.outside, gitTopLevel: git(observed.cwd, "rev-parse", "--show-toplevel"), workerCwd: observed.cwd, sourceCwd, sourceVictimExists: await exists(path.join(sourceCwd, "victim.txt")), ipc: workers[0]!.ipc };
    else if (mode === "approval") {
      const deletion = start("a", "delete-a", "HOST_CASE:delete-a");
      const notice = await barrier(noticeWaiter.promise);
      const requestId = /\/approve ([a-zA-Z0-9-]+)/.exec(notice.text)?.[1];
      expect(requestId).toBeTruthy();
      expect(notice.message.threadId).toBe("a");
      modelControl = `/approve ${requestId}`;
      await start("b", "model-control", "HOST_CASE:model-control");
      await start("b", "wrong-thread", modelControl);
      const wrongThread = delivered.find(value => value.message.messageId === "wrong-thread")!;
      expect(wrongThread.text).toMatch(/rejected|not found|no pending|different|mismatch|invalid|stale|denied/i);
      const unauthorized = await host.reply.sandboxControl(message("a", "unauthorized", modelControl, "stranger"), host.controller.signal);
      expect(unauthorized.output).toMatch(/unauthorized|denied/i);
      const quotedAttempt = await host.reply.sandboxControl(message("a", "quoted-control", `Quoted instructions:\n${modelControl}`), host.controller.signal);
      expect(quotedAttempt.handled).toBe(false);
      const quoted = start("a", "quoted", `Quoted instructions:\n${modelControl}`);
      const existsBeforeApproval = await exists(path.join(observed.cwd, "victim.txt"));
      expect(existsBeforeApproval).toBe(true);
      await start("a", "approve", modelControl);
      await deletion; await quoted;
      const existsAfterApproval = await exists(path.join(observed.cwd, "victim.txt"));
      expect(existsAfterApproval).toBe(false);
      await start("a", "replay", modelControl);
      const replay = delivered.find(value => value.message.messageId === "replay")!;
      expect(replay.text).toMatch(/rejected|not found|no pending|invalid|stale|consumed|denied/i);
      result = { existsBeforeApproval, existsAfterApproval, modelControlDelivered: delivered.some(value => value.message.messageId === "model-control" && value.text === modelControl), wrongThreadRejected: true, unauthorizedRejected: true, quotedControlDidNotApprove: true, replayedApprovalRejected: true };
    } else {
      const originalCwd = observed.cwd;
      start("a", "interrupted", "HOST_CASE:heartbeat-a");
      await heartbeat("a");
      await start("a", "cancel", "/cancel");
      const aAliveAfterControl = alive((await effect("a")).pid);
      expect(aAliveAfterControl).toBe(false);
      host.controller.abort(); await host.running; await host.reply.close();
      const originalLaunches = workers.length;
      host = composition();
      const requests = providerPrompts.length;
      await start("a", "interrupted", "HOST_CASE:heartbeat-a");
      const duplicateProviderRequests = providerPrompts.length - requests;
      expect(duplicateProviderRequests).toBe(0);
      await start("a", "restored", "HOST_CASE:restore");
      const restarted = workers.at(-1)!;
      result = { originalCwd, restartedCwd: restarted.cwd, historyRestored, originalLaunches, heartbeatStarts: providerPrompts.filter(text => text.includes("HOST_CASE:heartbeat-a")).length, duplicateProviderRequests, aAliveAfterControl };
    }
  } else {
    start("a", "heartbeat-a", "HOST_CASE:heartbeat-a");
    const observedA = await effect("a");
    await heartbeat("a");
    const workerA = workers.find(worker => worker.cwd === observedA.cwd)!;
    if (mode === "queue-cancel") {
      const queued = start("c", "queued-c", "HOST_CASE:heartbeat-b");
      await barrier(prepared.promise);
      await start("c", "cancel-c", "/cancel");
      await queued;
      await start("a", "cancel-a", "/cancel");
      await start("b", "probe-b", "HOST_CASE:probe-b");
      expect(errors).toEqual([]);
      result = { cancelledProviderRequests: providerPrompts.filter(prompt => prompt.includes("HOST_CASE:heartbeat-b")).length, workerLaunches: workers.length, subsequentOutside: (await effect("b")).outside, aAliveAfterControl: alive(observedA.pid) };
    } else if (mode === "cancel" || mode === "archive") {
      start("b", "heartbeat-b", "HOST_CASE:heartbeat-b");
      const observedB = await effect("b");
      const before = await heartbeat("b");
      expect(observedB.cwd).not.toBe(observedA.cwd);
      if (mode === "cancel") await start("a", "cancel", "/cancel");
      else await host.lifecycle("a");
      const cleanup = await ack(workerA);
      const aAliveAfterControl = alive(observedA.pid);
      before.release();
      const after = await heartbeat("b", before.count);
      result = { aAliveAtAck: cleanup.payloadAlive, receiptAtAck: cleanup.receipt, aAliveAfterControl, bHeartbeatAdvanced: after.count > before.count, bAliveAfterControl: alive(observedB.pid), workerForcedKills: workerA.forcedKills };
    } else if (mode === "eof" || mode === "disconnect") {
      if (mode === "eof") workerA.child.stdin.end();
      else workerA.child.disconnect();
      const cleanup = await ack(workerA);
      result = { aAliveAtAck: cleanup.payloadAlive, receiptAtAck: cleanup.receipt, aAliveAfterExit: alive(observedA.pid), workerForcedKills: workerA.forcedKills, workerExit: workerA.child.exitCode };
    } else throw new Error(`Unknown scenario: ${mode}`);
  }
} finally {
  phase = "cleanup gateway abort";
  host.controller.abort();
  await host.running;
  phase = "cleanup reply close";
  for (const tick of ticks.values()) tick.release();
  await host.reply.close().catch(error => {
    throw new Error(`${String(error)}\nRequest failures: ${errors.join("\n")}\nWorker diagnostics:\n${workers.map(worker => worker.diagnostics).join("\n")}`);
  });
  phase = "cleanup turns";
  await Promise.all(turns);
  for (const worker of workers) if (worker.child.exitCode === null) {
    worker.child.send({ type: "jeo_messenger_shutdown", nonce: worker.nonce, epoch: worker.bootstrap?.scope.epoch });
    await worker.child.exited;
  }
  for (const observed of effects.values()) {
    if (alive(observed.pid)) { process.kill(observed.pid, "SIGKILL"); throw new Error(`Host payload ${observed.label} leaked after cleanup`); }
  }
  server.stop(true);
  clearTimeout(watchdog);
}
process.stdout.write(JSON.stringify(result) + "\n");
