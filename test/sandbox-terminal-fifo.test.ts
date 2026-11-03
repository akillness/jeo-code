import { expect, test } from "bun:test";
import { constants, watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DiscordDaemon, type DiscordDaemonDependencies } from "../src/agent/notify/discord-daemon";
import { SessionNotifyEndpoint } from "../src/agent/notify/session-endpoint";

const USER = "222222222222222222";
const CHANNEL = "111111111111111111";
const BOT = "333333333333333333";
const CLI = path.resolve(import.meta.dir, "../src/cli.ts");
const GUARDIAN = path.resolve(import.meta.dir, "fixtures/sandbox-terminal-guardian.ts");
type Frame = Record<string, unknown>;

function observations<T>() {
  const values: T[] = [];
  const waiters = new Set<() => void>();
  return {
    values,
    add(value: T) { values.push(value); for (const resolve of [...waiters]) resolve(); },
    async wait(predicate: (value: T) => boolean, from = 0): Promise<T> {
      for (;;) {
        const value = values.slice(from).find(predicate);
        if (value !== undefined) return value;
        const next = Promise.withResolvers<void>();
        waiters.add(next.resolve);
        try { await next.promise; } finally { waiters.delete(next.resolve); }
      }
    },
  };
}

async function bounded<T>(label: string, run: () => Promise<T>, diagnostics: () => unknown, ms = 25_000): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  // Watchdog only: progress is driven by socket, stream, and provider events, never a sleep.
  const timer = setTimeout(() => timeout.reject(new Error(`${label}: ${JSON.stringify(diagnostics())}`)), ms);
  try { return await Promise.race([run(), timeout.promise]); } finally { clearTimeout(timer); }
}

function sse(text: string) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

// This exercises the real interactive launch and its real authenticated endpoint, not a copied queue.
// Docker must already be running with the local image; this test never pulls or installs anything.
// Opt in with JEO_TEST_TERMINAL_FIFO=1 so ordinary unit runs do not require Docker Desktop.
test.skipIf(process.platform !== "darwin" || process.env.JEO_TEST_TERMINAL_FIFO !== "1")("terminal FIFO: an accepted remote turn waits for local completion and preserves the local draft/history", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-terminal-fifo-")));
  const configDir = path.join(root, "config");
  const cwd = path.join(root, "workspace");
  const discoveryDir = path.join(configDir, "notifications", "sessions");
  await fs.mkdir(discoveryDir, { recursive: true });
  await fs.mkdir(cwd);
  let binary: string | undefined;
  if (process.env.JEO_TEST_CLI_BINARY !== undefined) {
    if (!path.isAbsolute(process.env.JEO_TEST_CLI_BINARY)) throw new Error("JEO_TEST_CLI_BINARY must be an absolute executable path");
    await fs.access(process.env.JEO_TEST_CLI_BINARY, constants.X_OK);
    const binaryDir = path.join(root, "isolated-binary");
    await fs.mkdir(binaryDir);
    binary = path.join(binaryDir, "jeo");
    await fs.copyFile(process.env.JEO_TEST_CLI_BINARY, binary);
    await fs.chmod(binary, 0o700);
  }
  const requests = observations<{ messages: { role: string; content: unknown }[]; release: (text: string) => void }>();
  const outputWaiters = new Set<() => void>();
  let transcript = "";
  const decoder = new TextDecoder();
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [{ id: "fifo-model" }] });
    const body = await request.json() as { messages: { role: string; content: unknown }[]; stream?: boolean };
    const answer = Promise.withResolvers<string>();
    requests.add({ messages: body.messages, release: answer.resolve });
    const text = await answer.promise;
    return body.stream ? sse(text) : Response.json({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] });
  } });
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({
    providers: {}, defaultModel: "openai/fifo-model", openaiBaseUrl: `http://127.0.0.1:${provider.port}/v1`,
    sandbox: { image: "oven/bun:1.3.14", limits: { memoryBytes: 268435456, pids: 64, cpus: 1 } },
    notifications: { enabled: true, discord: { allowedUserIds: [USER] } },
    routing: { enabled: false }, computer: { enabled: false }, gitAutoCommit: false,
  }));
  const discovery = Promise.withResolvers<{ id: string; url: string; token: string }>();
  const scan = async () => {
    for (const name of await fs.readdir(discoveryDir)) if (name.endsWith(".json")) {
      try { discovery.resolve({ ...JSON.parse(await fs.readFile(path.join(discoveryDir, name), "utf8")), id: name.slice(0, -5) }); } catch {}
    }
  };
  const watcher = watch(discoveryDir, () => { void scan(); });
  const poll = setInterval(() => { void scan(); }, 100);
  const terminal = new Bun.Terminal({ cols: 120, rows: 36, data(_terminal, bytes) {
    transcript += decoder.decode(bytes, { stream: true });
    for (const resolve of [...outputWaiters]) resolve();
  } });
  const launchExited = Promise.withResolvers<never>();
  const proc = Bun.spawn([process.execPath, GUARDIAN, process.execPath, CLI, "launch", "--no-skills", "--no-tools", "--model", "openai/fifo-model"], {
    cwd, detached: true, terminal,
    // Do not inherit provider/bot credentials or modify HOME/global environment.
    env: { PATH: process.env.PATH ?? "", JEO_CONFIG_DIR: configDir, JEO_STATIC_MEMORY: "1", TERM: "xterm-256color", NO_COLOR: "1", ...(binary ? { JEO_TEST_CLI_BINARY: binary } : {}) },
    ipc(message) { if (message.type === "exit") launchExited.reject(new Error(`launch exited ${message.exitCode}: ${transcript.slice(-3000)}`)); },
  });
  let ws: WebSocket | undefined;
  const frames = observations<Frame>();
  const waitOutput = async (needle: string, from = 0) => {
    while (!transcript.slice(from).includes(needle)) {
      const next = Promise.withResolvers<void>();
      outputWaiters.add(next.resolve);
      try { await next.promise; } finally { outputWaiters.delete(next.resolve); }
    }
  };
  const type = async (text: string, enter = true) => {
    let prefix = "";
    for (const character of text) {
      const from = transcript.length;
      prefix += character;
      terminal.write(character);
      await waitOutput(prefix, from);
    }
    if (enter) terminal.write("\r");
  };
  try {
    await bounded("real terminal FIFO stalled", () => Promise.race([launchExited.promise, (async () => {
      await waitOutput("Type your message");
      await scan();
      const session = await discovery.promise;
      ws = new WebSocket(`${session.url}/?token=${encodeURIComponent(session.token)}`);
      ws.addEventListener("message", event => frames.add(JSON.parse(String(event.data))));
      await frames.wait(frame => frame.type === "snapshot");
      const consentFrom = transcript.length;
      await type("/discord control on --allow-full-control");
      const consent = await Promise.race([
        frames.wait(frame => frame.type === "discord_control" && frame.enabled === true).then(frame => ({ frame })),
        waitOutput("Confirm Discord control: press y", consentFrom).then(() => ({ frame: undefined })),
      ]);
      if (!consent.frame) terminal.write("y");
      const enabled = consent.frame ?? await frames.wait(frame => frame.type === "discord_control" && frame.enabled === true);
      await waitOutput("Type your message", consentFrom);
      await type("LOCAL_FIRST");
      const first = await requests.wait(item => JSON.stringify(item.messages).includes("LOCAL_FIRST"));
      // A local unfinished draft is a separate ownership boundary from the running local turn.
      await type("LOCAL_DRAFT", false);
      ws.send(JSON.stringify({ type: "remote_request", sessionId: session.id, reqId: "fifo-remote", text: "REMOTE_SECOND", controlGeneration: enabled.generation, actor: { origin: "discord", sessionKey: session.id, userId: USER } }));
      expect(await frames.wait(frame => frame.type === "ack" && frame.reqId === "fifo-remote")).toEqual({ type: "ack", reqId: "fifo-remote", ok: true });
      expect(requests.values.map(item => item.messages.filter(message => message.role === "user").at(-1)?.content)).toEqual(["LOCAL_FIRST"]);
      const localEnd = transcript.length;
      first.release("LOCAL_ANSWER");
      await waitOutput("│> LOCAL_DRAFT", localEnd);
      // Socket round-trip gives the endpoint a chance to admit pending work while the draft exists.
      const barrier = frames.values.length;
      ws.send(JSON.stringify({ type: "list" }));
      await frames.wait(frame => frame.type === "snapshot", barrier);
      expect(requests.values).toHaveLength(1);
      terminal.write("\r");
      const draft = await requests.wait(item => item.messages.some(message => message.role === "user" && message.content === "LOCAL_DRAFT"));
      expect(draft.messages.filter(message => message.role === "user").map(message => message.content)).toEqual(["LOCAL_FIRST", "LOCAL_DRAFT"]);
      expect(draft.messages.filter(message => message.role === "assistant").at(-1)?.content).toBe("LOCAL_ANSWER");
      expect(JSON.stringify(draft.messages)).not.toContain("REMOTE_SECOND");
      draft.release("DRAFT_ANSWER");
      const remote = await requests.wait(item => item.messages.some(message => message.role === "user" && message.content === "REMOTE_SECOND"));
      expect(remote.messages.filter(message => message.role === "user").map(message => message.content)).toEqual(["LOCAL_FIRST", "LOCAL_DRAFT", "REMOTE_SECOND"]);
      expect(remote.messages.filter(message => message.role === "assistant").at(-1)?.content).toBe("DRAFT_ANSWER");
      remote.release("REMOTE_ANSWER");
      expect(await frames.wait(frame => frame.type === "remote_final" && frame.reqId === "fifo-remote")).toMatchObject({ ok: true, text: "REMOTE_ANSWER" });
      expect(requests.values).toHaveLength(3);
    })()]), () => ({ requests: requests.values.map(item => item.messages), frames: frames.values, output: transcript.slice(-3000) }), 55_000);
  } finally {
    for (const request of requests.values) request.release("TEST_CLEANUP");
    ws?.close();
    watcher.close(); clearInterval(poll);
    if (proc.exitCode === null) proc.send("stop");
    try { await bounded("PTY guardian cleanup stalled", () => proc.exited, () => transcript.slice(-1000), 10_000); }
    finally {
      terminal.close();
      provider.stop(true);
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}, 75_000);

class GatewaySocket {
  static instances: GatewaySocket[] = [];
  readyState = 1;
  onmessage: ((event: { data: string }) => void | Promise<void>) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) { GatewaySocket.instances.push(this); }
  send(_raw: string) {}
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
  receive(frame: Frame) { return this.onmessage?.({ data: JSON.stringify(frame) }); }
}

test("daemon FIFO: same-session prompts wait through delivery, other sessions progress, and authenticated revoke bypasses busy work", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-daemon-fifo-")));
  const previousConfig = process.env.JEO_CONFIG_DIR;
  process.env.JEO_CONFIG_DIR = root;
  GatewaySocket.instances = [];
  const endpoints = [new SessionNotifyEndpoint(root, "fifo-a"), new SessionNotifyEndpoint(root, "fifo-b")];
  const received = observations<{ session: string; text: string; finish: (text?: string) => void }>();
  const controls = observations<{ session: string; text: string; actor: unknown }>();
  const connections = observations<string>();
  const sent = observations<string>();
  const deliveryStarted = Promise.withResolvers<void>();
  const releaseDelivery = Promise.withResolvers<void>();
  const errors: string[] = [];
  for (const endpoint of endpoints) {
    endpoint.setDiscordControlEnabled(true);
    endpoint.onRemoteRequest = (text, finish) => { received.add({ session: endpoint.sessionId, text, finish }); return true; };
    endpoint.onSandboxControl = async (text, actor) => { controls.add({ session: endpoint.sessionId, text, actor }); return { handled: true, output: "REVOKED" }; };
  }
  class ObservedSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener("message", event => {
        const frame = JSON.parse(String(event.data));
        if (frame.type === "discord_control" && frame.enabled) connections.add(frame.sessionId);
      });
    }
  }
  const api: NonNullable<DiscordDaemonDependencies["api"]> = {
    async getMe() { return { id: BOT, username: "offline-bot", bot: true }; },
    async getChannel(id) { return { id, type: 1 }; },
    async getGatewayBot() { return { url: "wss://gateway.discord.gg", session_start_limit: { remaining: 10, reset_after: 60000, total: 10, max_concurrency: 1 } }; },
    async createThread(_channel, message) { return { id: `9${message}` }; },
    async addReaction() {}, async removeReaction() {},
    async sendMessage(_destination, text) {
      if (text === "ANSWER_A1") { deliveryStarted.resolve(); await releaseDelivery.promise; }
      sent.add(text);
      return [{ id: String(1000 + sent.values.length) }];
    },
    async sendFile() { throw new Error("No artifacts are authorized in this FIFO scenario"); },
    stop() {},
  };
  const daemon = new DiscordDaemon({ botToken: "offline-fixture-token", channelId: CHANNEL, allowedUserIds: [USER] }, {
    api, GatewayWebSocketImpl: GatewaySocket as unknown as typeof WebSocket, WebSocketImpl: ObservedSocket,
    readdir: async () => endpoints.map(endpoint => `${endpoint.sessionId}.json`),
    readFile: file => Bun.file(file).text(), isPidAlive: pid => pid === process.pid,
    random: () => 0.5, scanIntervalMs: 1000000, onError: message => errors.push(message),
  });
  let sequence = 0;
  let id = 0;
  const dispatch = (session: string, text: string) => GatewaySocket.instances[0]!.receive({ op: 0, t: "MESSAGE_CREATE", s: ++sequence, d: { id: String(++id), channel_id: CHANNEL, type: 0, author: { id: USER, bot: false }, content: `/send ${session} ${text}` } });
  const pending: Array<void | Promise<void>> = [];
  try {
    await bounded("daemon FIFO stalled", async () => {
      for (const endpoint of endpoints) await endpoint.start();
      await daemon.start();
      await GatewaySocket.instances[0]!.receive({ op: 10, d: { heartbeat_interval: 100000 } });
      await GatewaySocket.instances[0]!.receive({ op: 0, t: "READY", s: ++sequence, d: { session_id: "offline-gateway", resume_gateway_url: "wss://gateway.discord.gg" } });
      await Promise.all(endpoints.map(endpoint => connections.wait(id => id === endpoint.sessionId)));
      pending.push(dispatch("fifo-a", "FIRST"));
      const first = await received.wait(request => request.text === "FIRST");
      pending.push(dispatch("fifo-a", "SECOND"));
      // A third independent request is a positive scheduling barrier, not an arbitrary delay.
      pending.push(dispatch("fifo-b", "INDEPENDENT"));
      const independent = await received.wait(request => request.text === "INDEPENDENT");
      expect(received.values.map(request => [request.session, request.text])).toEqual([["fifo-a", "FIRST"], ["fifo-b", "INDEPENDENT"]]);
      pending.push(dispatch("fifo-a", "/sandbox revoke"));
      expect(await controls.wait(control => control.text === "/sandbox revoke")).toEqual({ session: "fifo-a", text: "/sandbox revoke", actor: { origin: "discord", sessionKey: "fifo-a", userId: USER } });
      first.finish("ANSWER_A1");
      await deliveryStarted.promise;
      independent.finish("ANSWER_B");
      // Revoke can traverse the real endpoint while A1's outbound final delivery is blocked.
      const controlFrom = controls.values.length;
      pending.push(dispatch("fifo-a", "/sandbox revoke"));
      await controls.wait(control => control.text === "/sandbox revoke", controlFrom);
      expect(received.values.map(request => request.text)).toEqual(["FIRST", "INDEPENDENT"]);
      releaseDelivery.resolve();
      const second = await received.wait(request => request.text === "SECOND");
      expect(sent.values).toContain("ANSWER_A1");
      second.finish("ANSWER_A2");
      await Promise.all(pending);
      expect(received.values.map(request => [request.session, request.text])).toEqual([["fifo-a", "FIRST"], ["fifo-b", "INDEPENDENT"], ["fifo-a", "SECOND"]]);
      expect(sent.values.filter(text => text.startsWith("ANSWER_"))).toEqual(["ANSWER_A1", "ANSWER_B", "ANSWER_A2"]);
      expect(errors).toEqual([]);
    }, () => ({ received: received.values.map(request => request.text), controls: controls.values, sent: sent.values, errors }));
  } finally {
    releaseDelivery.resolve();
    daemon.stop();
    await Promise.all(endpoints.map(endpoint => endpoint.stop()));
    await Promise.all(pending);
    if (previousConfig === undefined) delete process.env.JEO_CONFIG_DIR; else process.env.JEO_CONFIG_DIR = previousConfig;
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);
