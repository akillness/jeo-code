import { test, expect } from "bun:test";
import { DiscordDaemon, type DiscordDaemonDependencies } from "../src/agent/notify/discord-daemon";
import { DiscordApi } from "../src/agent/notify/discord-api";
import { SessionNotifyEndpoint, type RemoteUserMessage } from "../src/agent/notify/session-endpoint";
import { resolveDiscordArtifactStage } from "../src/agent/notify/discord-artifacts";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const CHANNEL = "111111111111111111";
const USER = "222222222222222222";
const BOT = "333333333333333333";
const CONFIG = { botToken: "offline-test-token", channelId: CHANNEL, allowedUserIds: [USER, BOT] };

type Frame = { op?: number; d?: unknown; type?: string; text?: string; message?: string; reqId?: string; id?: string; ids?: string[]; sessionId?: string; generation?: number };

class Clock {
  now = 0;
  private nextId = 0;
  private jobs = new Map<number, { at: number; callback: () => void }>();
  // Production accepts Bun Timer handles; this injected scheduler owns numeric handles instead.
  set = (callback: () => void, ms: number): Timer => {
    const id = ++this.nextId;
    this.jobs.set(id, { at: this.now + ms, callback });
    return id as unknown as Timer;
  };
  clear = (timer: Timer): void => { this.jobs.delete(Number(timer)); };
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const next = [...this.jobs].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.now = next[1].at;
      this.jobs.delete(next[0]);
      next[1].callback();
    }
    this.now = target;
  }
}

function sockets(autoRemote = false) {
  const instances: Socket[] = [];
  class Socket {
    readyState = 1;
    sent: Frame[] = [];
    autoRemote = autoRemote;
    private sendWaiters: { predicate: (frame: Frame) => boolean; resolve: (frame: Frame) => void }[] = [];
    closed: number[] = [];
    deferClose = false;
    onmessage: ((event: { data: string }) => void | Promise<void>) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) { instances.push(this); }
    send(raw: string): void {
      const frame = JSON.parse(raw) as Frame;
      this.sent.push(frame);
      if (this.autoRemote && frame.type === "remote_request") queueMicrotask(async () => {
        await this.receive({ type: "ack", reqId: frame.reqId, ok: true });
        await this.receive({ type: "remote_final", sessionId: frame.sessionId, reqId: frame.reqId, ok: true, controlGeneration: 1, text: `answer: ${frame.text}` });
      });
      for (const waiter of [...this.sendWaiters]) if (waiter.predicate(frame)) {
        this.sendWaiters.splice(this.sendWaiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
    waitForSend(predicate: (frame: Frame) => boolean): Promise<Frame> {
      const frame = this.sent.find(predicate);
      if (frame) return Promise.resolve(frame);
      const { promise, resolve } = Promise.withResolvers<Frame>();
      this.sendWaiters.push({ predicate, resolve });
      return promise;
    }
    close(code = 1000): void { this.readyState = 3; this.closed.push(code); if (!this.deferClose) this.onclose?.({ code }); }
    async receive(payload: unknown): Promise<void> { await this.onmessage?.({ data: JSON.stringify(payload) }); }
    async raw(data: string): Promise<void> { await this.onmessage?.({ data }); }
  }
  // Only the WebSocket surface consumed by the daemon is modeled at this external boundary.
  const Impl = Socket as unknown as typeof WebSocket;
  return { instances, Impl };
}

class DiscordService {
  sent: { id: string; channel: string; text: string }[] = [];
  stopped = false;
  channelType = 1;
  remaining = 10;
  private waiters: { predicate: (message: { id: string; channel: string; text: string }) => boolean; resolve: (message: { id: string; channel: string; text: string }) => void }[] = [];
  async getMe() { return { id: BOT, username: "test-bot", bot: true }; }
  async getChannel(id: string) { return { id, type: this.channelType }; }
  async getGatewayBot() { return { url: "wss://gateway.discord.gg", session_start_limit: { remaining: this.remaining, reset_after: 60000, total: 10, max_concurrency: 1 } }; }
  async createThread(_channel: string, message: string, _name: string) { return { id: `9${message}` }; }
  async addReaction(_channel: string, _message: string, _emoji: string) {}
  async removeReaction(_channel: string, _message: string, _emoji: string) {}
  async sendMessage(channel: string, text: string) {
    const message = { id: String(1000 + this.sent.length), channel, text };
    this.sent.push(message);
    for (const waiter of [...this.waiters]) if (waiter.predicate(message)) {
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
    return [{ id: message.id }];
  }
  waitFor(predicate: (message: { id: string; channel: string; text: string }) => boolean) {
    const existing = this.sent.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<{ id: string; channel: string; text: string }>(resolve => this.waiters.push({ predicate, resolve }));
  }
  stop() { this.stopped = true; }
}

function fixture(ids: string[] = [], overrides: DiscordDaemonDependencies = {}, config = CONFIG) {
  const api = new DiscordService();
  const gateway = sockets();
  const local = sockets(true);
  const clock = new Clock();
  const errors: string[] = [];
  const daemon = new DiscordDaemon(config, {
    api, GatewayWebSocketImpl: gateway.Impl, WebSocketImpl: local.Impl,
    readdir: async () => ids.map(id => `${id}.json`),
    readFile: async () => JSON.stringify({ url: "ws://127.0.0.1:9001", token: "local-test-token", cwd: "/test", pid: 123 }),
    isPidAlive: () => true, now: () => clock.now, random: () => 0.5,
    setTimeout: clock.set, clearTimeout: clock.clear, scanIntervalMs: 1000000, ackTimeoutMs: 250,
    onError: message => errors.push(message), ...overrides,
  });
  let sequence = 0;
  let messageId = 0;
  const message = (content: string, extra: Record<string, unknown> = {}) => ({
    id: String(++messageId), channel_id: CHANNEL, type: 0, author: { id: USER, bot: false }, content, ...extra,
  });
  const dispatch = (payload: unknown) => gateway.instances.at(-1)!.receive({ op: 0, t: "MESSAGE_CREATE", s: ++sequence, d: payload });
  const ready = async (heartbeatInterval = 1000) => {
    await daemon.start();
    await gateway.instances[0]!.receive({ op: 10, d: { heartbeat_interval: heartbeatInterval } });
    await gateway.instances[0]!.receive({ op: 0, t: "READY", s: ++sequence, d: { session_id: "gateway-session", resume_gateway_url: "wss://gateway.discord.gg" } });
    for (const [index, id] of ids.entries()) {
      await local.instances[index]!.receive({ type: "snapshot", sessionId: id, pid: 123, subagents: [] });
      await local.instances[index]!.receive({ type: "discord_control", sessionId: id, enabled: true, generation: 1 });
    }
  };
  return { daemon, api, gateway, local, clock, errors, ready, dispatch, message };
}

test("only an allowlisted human in the configured channel can dispatch; malformed events are inert", async () => {
  const f = fixture(["alpha"]);
  try {
    await f.ready();
    const socket = f.gateway.instances[0]!;
    for (const raw of ["{", "null", "[]", '"string"']) await socket.raw(raw);
    for (const payload of [null, {}, [],
      f.message("/send alpha denied", { channel_id: "999" }),
      f.message("/send alpha denied", { author: { id: "999", bot: false } }),
      f.message("/send alpha denied", { author: { id: USER, bot: true } }),
      f.message("/send alpha denied", { author: { id: BOT, bot: false } }),
      f.message("/send alpha denied", { author: null }),
      f.message("/send alpha denied", { webhook_id: "888" }),
      f.message("/send alpha denied", { type: 7 }),
      f.message("/send alpha denied", { content: 5 }),
    ]) await f.dispatch(payload);
    expect(f.api.sent).toEqual([]);
    expect(f.local.instances[0]!.sent).toEqual([]);
    await f.dispatch(f.message("/send alpha authorized prompt"));
    expect(f.local.instances[0]!.sent.map(frame => [frame.type, frame.text])).toEqual([["remote_request", "authorized prompt"]]);
  } finally { f.daemon.stop(); }
});

test("ambiguous prefixes never choose a session, while exact IDs win over longer matches", async () => {
  const f = fixture(["alpha", "alpha-long"]);
  try {
    await f.ready();
    await f.dispatch(f.message("/send al wrong target"));
    expect(f.local.instances.map(socket => socket.sent)).toEqual([[], []]);
    expect(f.api.sent.at(-1)!.text).toMatch(/ambiguous/i);
    await f.dispatch(f.message("/send alpha exact target"));
    await f.dispatch(f.message("/send alpha-l unique target"));
    expect(f.local.instances.map(socket => socket.sent.map(frame => [frame.type, frame.text]))).toEqual([
      [["remote_request", "exact target"]], [["remote_request", "unique target"]],
    ]);
  } finally { f.daemon.stop(); }
});

test("steer acknowledgements must match both request and originating session", async () => {
  const f = fixture(["alpha", "beta"]);
  try {
    await f.ready();
    const command = f.dispatch(f.message("/steer alpha worker-1 focus on correctness"));
    const frame = await f.local.instances[0]!.waitForSend(frame => frame.type === "discord_steer");
    expect({ type: frame.type, id: frame.id, message: frame.message }).toEqual({ type: "discord_steer", id: "worker-1", message: "focus on correctness" });
    await f.local.instances[1]!.receive({ type: "ack", reqId: frame.reqId, ok: true });
    await f.local.instances[0]!.receive({ type: "ack", reqId: "unrelated", ok: true });
    expect(f.api.sent).toEqual([]);
    await f.local.instances[0]!.receive({ type: "ack", reqId: frame.reqId, ok: false });
    await command;
    expect(f.api.sent.at(-1)!.text).toMatch(/not acknowledged/i);
    const cancelled = f.dispatch(f.message("/cancel beta worker-2"));
    const cancelFrame = await f.local.instances[1]!.waitForSend(frame => frame.type === "discord_cancel");
    expect(cancelFrame.ids).toEqual(["worker-2"]);
    await f.local.instances[1]!.receive({ type: "ack", reqId: cancelFrame.reqId, ok: true });
    await cancelled;
    expect(f.api.sent.at(-1)!.text).toMatch(/^Session acknowledged/);
  } finally { f.daemon.stop(); }
});

test("missing local ACK reports failure and shutdown resolves pending commands without delivery", async () => {
  const f = fixture(["alpha"]);
  try {
    await f.ready();
    const timedOut = f.dispatch(f.message("/cancel alpha worker-1"));
    await f.local.instances[0]!.waitForSend(frame => frame.type === "discord_cancel" && frame.ids?.[0] === "worker-1");
    f.clock.advance(250);
    await timedOut;
    expect(f.api.sent.at(-1)!.text).toMatch(/not acknowledged/i);
    const pending = f.dispatch(f.message("/cancel alpha worker-2"));
    await f.local.instances[0]!.waitForSend(frame => frame.type === "discord_cancel" && frame.ids?.[0] === "worker-2");
    const count = f.api.sent.length;
    f.daemon.stop();
    await pending;
    expect(f.api.sent.length).toBe(count);
    expect(f.local.instances[0]!.closed).toEqual([1000]);
  } finally { f.daemon.stop(); }
});

for (const [channelType, intents] of [[0, 33280], [1, 4096]] as const) {
  test(`Gateway identifies with channel-appropriate intents for type ${channelType}`, async () => {
    const f = fixture();
    f.api.channelType = channelType;
    try {
      await f.ready();
      const identify = f.gateway.instances[0]!.sent.find(frame => frame.op === 2);
      expect(identify?.d).toMatchObject({ token: CONFIG.botToken, intents });
    } finally { f.daemon.stop(); }
  });
}

test("heartbeat uses the latest dispatch sequence, respects ACK and reconnects when ACK is missing", async () => {
  const f = fixture();
  try {
    await f.ready();
    const first = f.gateway.instances[0]!;
    await first.receive({ op: 0, t: "PRESENCE_UPDATE", s: 42, d: {} });
    f.clock.advance(499);
    expect(first.sent.filter(frame => frame.op === 1)).toEqual([]);
    f.clock.advance(1);
    expect(first.sent.at(-1)).toEqual({ op: 1, d: 42 });
    await first.receive({ op: 11 });
    f.clock.advance(1000);
    expect(first.closed).toEqual([]);
    f.clock.advance(1000);
    expect(first.closed).toEqual([4000]);
    f.clock.advance(1000);
    const resumed = f.gateway.instances[1]!;
    await resumed.receive({ op: 10, d: { heartbeat_interval: 1000 } });
    expect(resumed.sent).toContainEqual({ op: 6, d: { token: CONFIG.botToken, session_id: "gateway-session", seq: 42 } });
  } finally { f.daemon.stop(); }
});

test("server heartbeat request is answered immediately and reconnect requests resume", async () => {
  const f = fixture();
  try {
    await f.ready();
    const first = f.gateway.instances[0]!;
    await first.receive({ op: 1 });
    expect(first.sent.at(-1)).toEqual({ op: 1, d: 1 });
    await first.receive({ op: 7 });
    f.clock.advance(1000);
    await f.gateway.instances[1]!.receive({ op: 10, d: { heartbeat_interval: 1000 } });
    expect(f.gateway.instances[1]!.sent.at(-1)?.op).toBe(6);
  } finally { f.daemon.stop(); }
});

for (const code of [4004, 4010, 4011, 4012, 4013, 4014]) {
  test(`fatal Gateway close ${code} stops rather than reconnecting`, async () => {
    const fatal: string[] = [];
    const f = fixture([], { onFatal: message => fatal.push(message) });
    try {
      await f.ready();
      f.gateway.instances[0]!.close(code);
      f.clock.advance(120000);
      expect(f.gateway.instances.length).toBe(1);
      expect(f.api.stopped).toBe(true);
      expect(fatal).toHaveLength(1);
      expect(fatal[0]).toContain(String(code));
      expect(f.errors.join("\n")).toContain(String(code));
      expect(f.errors.join("\n")).not.toContain(CONFIG.botToken);
    } finally { f.daemon.stop(); }
  });
}

test("stop cancels reconnect and prevents stale socket events from reopening or dispatching", async () => {
  const f = fixture(["alpha"]);
  try {
    await f.ready();
    const first = f.gateway.instances[0]!;
    await first.receive({ op: 7 });
    f.daemon.stop();
    await f.dispatch(f.message("/send alpha must not dispatch"));
    f.clock.advance(120000);
    expect(f.gateway.instances.length).toBe(1);
    expect(f.local.instances[0]!.sent).toEqual([]);
    expect(f.api.sent).toEqual([]);
  } finally { f.daemon.stop(); }
});

test("real local endpoint routes Discord prompts and does not echo remote turn streams", async () => {
  const endpoint = new SessionNotifyEndpoint("/offline-discord-integration");
  endpoint.setDiscordControlEnabled(true);
  const messages: RemoteUserMessage[] = [];
  let received = Promise.withResolvers<RemoteUserMessage>();
  endpoint.onRemoteRequest = (text, finish) => { const message = { text }; messages.push(message); received.resolve(message); queueMicrotask(() => finish(`answer: ${text}`)); return true; };
  const snapshot = Promise.withResolvers<void>();
  const control = Promise.withResolvers<void>();
  const streamObserved = Promise.withResolvers<void>();
  class ObservedSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener("message", event => {
        if (JSON.parse(String(event.data)).type === "snapshot") queueMicrotask(() => snapshot.resolve());
        if (JSON.parse(String(event.data)).type === "discord_control") queueMicrotask(() => control.resolve());
        if (JSON.parse(String(event.data)).type === "turn_stream") queueMicrotask(() => streamObserved.resolve());
      });
    }
  }
  const f = fixture([], {
    WebSocketImpl: ObservedSocket,
    readdir: async () => [`${endpoint.sessionId}.json`],
    readFile: file => Bun.file(file).text(),
    isPidAlive: pid => pid === process.pid,
  });
  try {
    await endpoint.start();
    await f.ready();
    await snapshot.promise;
    await control.promise;
    await f.dispatch(f.message(`/send ${endpoint.sessionId} inspect this project`));
    expect((await received.promise).text).toBe("inspect this project");
    const notification = f.api.sent.at(-1)!;
    expect(notification.text).toBe("answer: inspect this project");
    endpoint.sendTurnStream("The actual final answer");
    await streamObserved.promise;
    await f.dispatch(f.message("/help"));
    expect(f.api.sent.some(message => message.text.includes("The actual final answer"))).toBe(false);
    received = Promise.withResolvers<RemoteUserMessage>();
    await f.dispatch(f.message("continue with that result", { type: 19, message_reference: { message_id: notification.id, channel_id: CHANNEL } }));
    expect((await received.promise).text).toBe("continue with that result");
    await f.dispatch(f.message("forged quoted target", { type: 19, message_reference: { message_id: "999999" } }));
    expect(f.api.sent.at(-1)!.text).toMatch(/unknown|expired/i);
    expect(messages.map(message => message.text)).toEqual(["inspect this project", "continue with that result"]);
  } finally { f.daemon.stop(); await endpoint.stop(); }
});

test("reply IDs route to their original session, never quoted text or the most recent session", async () => {
  const f = fixture(["alpha", "beta"]);
  try {
    await f.ready();
    await f.dispatch(f.message("/send alpha first prompt"));
    const alphaReplyId = f.api.sent.at(-1)!.id;
    await f.dispatch(f.message("/send beta second prompt"));
    const betaReplyId = f.api.sent.at(-1)!.id;
    await f.dispatch(f.message("[beta] this quoted label is not routing authority", { type: 19, message_reference: { message_id: alphaReplyId } }));
    await f.dispatch(f.message("answer beta", { type: 19, message_reference: { message_id: betaReplyId } }));
    expect(f.local.instances.map(socket => socket.sent.map(frame => frame.text))).toEqual([
      ["first prompt", "[beta] this quoted label is not routing authority"], ["second prompt", "answer beta"],
    ]);
    await f.dispatch(f.message("wrong channel reference", { type: 19, message_reference: { message_id: alphaReplyId, channel_id: "999" } }));
    expect(f.api.sent.at(-1)!.text).toMatch(/unknown|expired/i);
    f.clock.now = 86400000;
    await f.dispatch(f.message("expired reference", { type: 19, message_reference: { message_id: betaReplyId } }));
    expect(f.api.sent.at(-1)!.text).toMatch(/unknown|expired/i);
    expect(f.local.instances.map(socket => socket.sent.length)).toEqual([2, 2]);
  } finally { f.daemon.stop(); }
});

test("replayed message IDs and dispatch sequence numbers cannot execute a command twice", async () => {
  const f = fixture(["alpha"]);
  try {
    await f.ready();
    const message = f.message("/send alpha once only");
    await f.dispatch(message);
    await f.dispatch(message);
    await f.gateway.instances[0]!.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: f.message("/send alpha stale dispatch") });
    expect(f.local.instances[0]!.sent.map(frame => [frame.type, frame.text])).toEqual([["remote_request", "once only"]]);
  } finally { f.daemon.stop(); }
});

for (const reason of ["invalid session", "invalid sequence", "expired session"]) {
  test(`${reason} starts a new identify rather than resuming invalid state`, async () => {
    const f = fixture();
    try {
      await f.ready();
      if (reason === "invalid session") await f.gateway.instances[0]!.receive({ op: 9, d: false });
      else f.gateway.instances[0]!.close(reason === "invalid sequence" ? 4007 : 4009);
      f.clock.advance(1000);
      // Move to the explicitly configured identify window before the new server Hello arrives.
      f.clock.now = 5000;
      await f.gateway.instances[1]!.receive({ op: 10, d: { heartbeat_interval: 1000 } });
      expect(f.gateway.instances[1]!.sent.map(frame => frame.op)).toEqual([2]);
    } finally { f.daemon.stop(); }
  });
}

test("session-start exhaustion fails before opening Gateway or local sockets", async () => {
  const f = fixture(["alpha"]);
  f.api.remaining = 0;
  try {
    await expect(f.daemon.start()).rejects.toThrow();
    expect(f.gateway.instances).toEqual([]);
    expect(f.local.instances).toEqual([]);
    expect(f.api.stopped).toBe(true);
  } finally { f.daemon.stop(); }
});

test("malformed and cross-session local frames cannot publish another session's output", async () => {
  const f = fixture(["alpha", "beta"]);
  try {
    await f.ready();
    const local = f.local.instances[0]!;
    for (const raw of ["{", "null", "[]", '"text"']) await local.raw(raw);
    await local.receive({ type: "turn_stream", sessionId: "beta", phase: "finalized", text: "forged beta answer" });
    await local.receive({ type: "turn_stream", sessionId: "alpha", phase: "partial", text: "not final" });
    await local.receive({ type: "turn_stream", sessionId: "alpha", phase: "finalized", text: 123 });
    expect(f.api.sent).toEqual([]);
    await local.receive({ type: "context_update", sessionId: "alpha", phase: "turn_start", summary: "private prompt preview" });
    await local.receive({ type: "snapshot", sessionId: "alpha", pid: 123, subagents: [{ id: "worker", role: "reviewer", task: "private task", status: "running" }] });
    await f.dispatch(f.message("/help"));
    expect(f.api.sent.map(message => message.text).join("\n")).not.toContain("private prompt preview");
    expect(f.api.sent.map(message => message.text).join("\n")).not.toContain("private task");
  } finally { f.daemon.stop(); }
});

test("a delivered chunk remains reply-routable when a later chunk fails", async () => {
  const delivered: { id: string; text: string }[] = [];
  let sends = 0;
  const failed = Promise.withResolvers<void>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const route = new URL(String(input)).pathname;
    let data: unknown;
    if (route.endsWith("/users/@me")) data = { id: BOT, username: "offline-bot", bot: true };
    else if (route.endsWith("/gateway/bot")) data = { url: "wss://gateway.discord.gg", session_start_limit: { remaining: 10, reset_after: 60000, total: 10, max_concurrency: 1 } };
    else if (route.endsWith(`/channels/${CHANNEL}`)) data = { id: CHANNEL, type: 1 };
    else if (route.includes("/reactions/")) return new Response(null, { status: 204 });
    else if (route.endsWith(`/channels/${CHANNEL}/messages`)) {
      sends++;
      if (sends === 2) return new Response(JSON.stringify({ message: "server failure" }), { status: 500 });
      const body = JSON.parse(String(init?.body));
      const message = { id: String(7000 + sends), text: String(body.content) };
      delivered.push(message);
      data = { id: message.id };
    } else throw new Error(`Unexpected fake Discord route: ${route}`);
    return new Response(JSON.stringify(data));
  }) as typeof fetch;
  const api = new DiscordApi(CONFIG.botToken, { fetchImpl });
  const f = fixture(["alpha"], { api, onError: () => failed.resolve() });
  try {
    await f.ready();
    const local = f.local.instances[0]!;
    const enabled = local.waitForSend(frame => frame.type === "local_relay");
    await local.receive({ type: "local_relay_control", sessionId: "alpha", destination: CHANNEL, generation: 1 });
    const enableFrame = await enabled;
    expect(enableFrame.generation).toBe(1);
    await local.receive({ type: "ack", reqId: enableFrame.reqId, ok: true });
    await local.receive({ type: "local_final", sessionId: "alpha", text: "x".repeat(2100) });
    await failed.promise;
    expect(delivered.map(message => message.text)).toEqual(["[alpha]\n" + "x".repeat(1992)]);
    await f.dispatch(f.message("reply to visible partial answer", { type: 19, message_reference: { message_id: delivered[0]!.id } }));
    expect(f.local.instances[0]!.sent.filter(frame => frame.type === "remote_request").map(frame => frame.text)).toEqual(["reply to visible partial answer"]);
  } finally { f.daemon.stop(); }
});

test("fresh Identify refreshes exhausted session allowance after Discord's reset window", async () => {
  const f = fixture();
  f.api.remaining = 1;
  try {
    await f.ready();
    await f.gateway.instances[0]!.receive({ op: 9, d: false });
    f.clock.advance(1000);
    // The new Hello arrives after the explicit reset_after returned by the service.
    f.clock.now = 60000;
    await f.gateway.instances[1]!.receive({ op: 10, d: { heartbeat_interval: 1000 } });
    expect(f.gateway.instances[1]!.sent.map(frame => frame.op)).toEqual([2]);
    expect(f.api.stopped).toBe(false);
  } finally { f.daemon.stop(); }
});

test("shutdown during session-allowance refresh cannot identify or reconnect afterwards", async () => {
  const refreshing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  class DelayedService extends DiscordService {
    private queried = false;
    override async getGatewayBot() {
      if (this.queried) { refreshing.resolve(); await release.promise; }
      this.queried = true;
      return super.getGatewayBot();
    }
  }
  const api = new DelayedService();
  api.remaining = 1;
  const f = fixture([], { api });
  try {
    await f.ready();
    await f.gateway.instances[0]!.receive({ op: 9, d: false });
    f.clock.advance(1000);
    f.clock.now = 60000;
    const hello = f.gateway.instances[1]!.receive({ op: 10, d: { heartbeat_interval: 1000 } });
    await refreshing.promise;
    f.daemon.stop();
    release.resolve();
    await hello;
    f.clock.advance(120000);
    expect(f.gateway.instances[1]!.sent).toEqual([]);
    expect(f.gateway.instances.length).toBe(2);
    expect(api.stopped).toBe(true);
  } finally { release.resolve(); f.daemon.stop(); }
});

test("a delayed old-socket close cannot reject a replacement session's pending command", async () => {
  const f = fixture(["alpha"]);
  try {
    await f.ready();
    const old = f.local.instances[0]!;
    old.deferClose = true;
    old.onerror?.();
    await f.daemon.scanSessions();
    const replacement = f.local.instances[1]!;
    await replacement.receive({ type: "snapshot", sessionId: "alpha", pid: 123, subagents: [] });
    await replacement.receive({ type: "discord_control", sessionId: "alpha", enabled: true, generation: 1 });
    const pending = f.dispatch(f.message("/cancel alpha worker-1"));
    const request = await replacement.waitForSend(frame => frame.type === "discord_cancel");
    expect(request.ids).toEqual(["worker-1"]);
    old.onclose?.({ code: 1006 });
    await replacement.receive({ type: "ack", reqId: request.reqId, ok: true });
    await pending;
    expect(f.api.sent.at(-1)!.text).toMatch(/^Session acknowledged/);
    await f.dispatch(f.message("/send alpha replacement remains usable"));
    expect([replacement.sent.at(-1)?.type, replacement.sent.at(-1)?.text]).toEqual(["remote_request", "replacement remains usable"]);
  } finally { f.daemon.stop(); }
});

test("bounded reconnect exhaustion signals terminal failure once and stale events cannot repeat it", async () => {
  const fatal: string[] = [];
  const f = fixture([], { onFatal: message => fatal.push(message) });
  try {
    await f.ready();
    for (let attempt = 0; attempt < 8; attempt++) {
      f.gateway.instances.at(-1)!.onerror?.();
      expect(fatal).toEqual([]);
      expect(f.api.stopped).toBe(false);
      f.clock.advance(Math.min(1000 * 2 ** attempt, 30000));
    }
    const last = f.gateway.instances.at(-1)!;
    last.onerror?.();
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toMatch(/reconnect/i);
    expect(f.api.stopped).toBe(true);
    const connections = f.gateway.instances.length;
    last.onerror?.();
    last.onclose?.({ code: 4004 });
    f.clock.advance(300000);
    expect(fatal).toHaveLength(1);
    expect(f.gateway.instances.length).toBe(connections);
  } finally { f.daemon.stop(); }
});

test("a transient outbound failure reports an error without declaring the provider fatal", async () => {
  class FlakyService extends DiscordService {
    private failNext = true;
    override async sendMessage(channel: string, text: string) {
      if (this.failNext) { this.failNext = false; throw new Error("temporary offline service failure"); }
      return super.sendMessage(channel, text);
    }
  }
  const api = new FlakyService();
  const fatal: string[] = [];
  const f = fixture([], { api, onFatal: message => fatal.push(message) });
  try {
    await f.ready();
    await f.dispatch(f.message("/help"));
    expect(f.errors).toHaveLength(1);
    expect(fatal).toEqual([]);
    expect(api.stopped).toBe(false);
    await f.dispatch(f.message("/sessions"));
    expect(api.sent.at(-1)?.text).toMatch(/No connected sessions/i);
    expect(fatal).toEqual([]);
  } finally { f.daemon.stop(); }
});

test("guild requests reply in their own thread and authorized thread follow-ups reuse it", async () => {
  const f = fixture(["alpha"]);
  f.api.channelType = 0;
  try {
    await f.ready();
    await f.dispatch(f.message("/sessions"));
    expect(f.api.sent.map(m => [m.channel, m.text])).toEqual([["91", "[alpha] /test"]]);
    await f.dispatch(f.message("/sessions", { channel_id: "91" }));
    expect(f.api.sent.map(m => m.channel)).toEqual(["91", "91"]);
    await f.dispatch(f.message("/sessions", { channel_id: "91", author: { id: "999", bot: false } }));
    expect(f.api.sent.map(m => m.channel)).toEqual(["91", "91"]);
  } finally { f.daemon.stop(); }
});

test("denied thread creation never dispatches a prompt or posts it publicly", async () => {
  class DeniedThreads extends DiscordService {
    override async createThread(_channel: string, _message: string, _name: string): Promise<{ id: string }> { throw new Error("forbidden"); }
  }
  const api = new DeniedThreads();
  api.channelType = 0;
  const f = fixture(["alpha"], { api });
  try {
    await f.ready();
    await f.dispatch(f.message("/send alpha confidential"));
    expect(f.local.instances[0]!.sent).toEqual([]);
    expect(api.sent.map(message => [message.channel, message.text])).toEqual([[CHANNEL, "Unable to create a reply thread; check bot permissions."]]);
    expect(f.errors).toContain("Discord thread creation failed");
  } finally { f.daemon.stop(); }
});

test("disabling local relay drops a queued answer while an earlier send is blocked", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  class BlockingService extends DiscordService {
    override async sendMessage(channel: string, text: string) {
      if (text.includes("first local answer")) { entered.resolve(); await release.promise; }
      return super.sendMessage(channel, text);
    }
  }
  const api = new BlockingService();
  const f = fixture(["alpha"], { api });
  try {
    await f.ready();
    const socket = f.local.instances[0]!;
    const enabled = socket.waitForSend(frame => frame.type === "local_relay");
    await socket.receive({ type: "local_relay_control", sessionId: "alpha", destination: CHANNEL, generation: 1 });
    const enableFrame = await enabled;
    expect(enableFrame.generation).toBe(1);
    await socket.receive({ type: "ack", reqId: enableFrame.reqId, ok: true });
    await socket.receive({ type: "local_final", sessionId: "alpha", text: "first local answer" });
    await entered.promise;
    await socket.receive({ type: "local_final", sessionId: "alpha", text: "revoked queued answer" });
    await socket.receive({ type: "local_relay_control", sessionId: "alpha", destination: "off", generation: 2 });
    release.resolve();
    await f.dispatch(f.message("/help"));
    expect(api.sent.some(message => message.text.includes("first local answer"))).toBe(true);
    expect(api.sent.some(message => message.text.includes("revoked queued answer"))).toBe(false);
  } finally { release.resolve(); f.daemon.stop(); }
});

test("concurrent remote replies return only to their originating request threads", async () => {
  const f = fixture(["alpha", "beta"]);
  f.api.channelType = 0;
  try {
    await f.ready();
    f.local.instances[0]!.autoRemote = false;
    f.local.instances[1]!.autoRemote = false;
    const first = f.dispatch(f.message("/send alpha question one"));
    const second = f.dispatch(f.message("/send beta question two"));
    const alpha = f.local.instances[0]!;
    const beta = f.local.instances[1]!;
    const a = await alpha.waitForSend(frame => frame.type === "remote_request");
    const b = await beta.waitForSend(frame => frame.type === "remote_request");
    expect([a.text, b.text]).toEqual(["question one", "question two"]);
    await alpha.receive({ type: "ack", reqId: a.reqId, ok: true });
    await beta.receive({ type: "ack", reqId: b.reqId, ok: true });
    await beta.receive({ type: "remote_final", sessionId: "beta", reqId: a.reqId, ok: true, text: "forged" });
    expect(f.api.sent).toEqual([]);
    await beta.receive({ type: "remote_final", sessionId: "beta", reqId: b.reqId, ok: true, controlGeneration: 1, text: "beta answer" });
    await alpha.receive({ type: "remote_final", sessionId: "alpha", reqId: a.reqId, ok: true, controlGeneration: 1, text: "alpha answer" });
    await Promise.all([first, second]);
    expect(f.api.sent.map(message => [message.channel, message.text]).sort()).toEqual([
      ["91", "alpha answer"], ["92", "beta answer"],
    ]);
  } finally { f.daemon.stop(); }
});

test("a pre-ACK final cannot bypass a rejected request or produce a success reaction", async () => {
  class ReactionService extends DiscordService {
    reactions: string[] = [];
    override async addReaction(_channel: string, _message: string, emoji: string) { this.reactions.push(emoji); }
  }
  const api = new ReactionService();
  api.channelType = 0;
  const f = fixture(["alpha"], { api });
  try {
    await f.ready();
    const socket = f.local.instances[0]!;
    socket.autoRemote = false;
    const request = f.dispatch(f.message("/send alpha private question"));
    const frame = await socket.waitForSend(item => item.type === "remote_request");
    await socket.receive({ type: "remote_final", sessionId: "alpha", reqId: frame.reqId, ok: true, text: "premature answer" });
    await socket.receive({ type: "ack", reqId: frame.reqId, ok: false });
    await request;
    expect(api.sent.map(message => [message.channel, message.text])).toEqual([["91", "Session request failed, was rejected, interrupted, or timed out."]]);
    expect(api.reactions).toEqual(["⏳", "❌"]);
  } finally { f.daemon.stop(); }
});

test("a stuck reaction cannot block authenticated remote answers or spawn unbounded reaction requests", async () => {
  const endpoint = new SessionNotifyEndpoint("/offline-discord-stuck-reaction");
  endpoint.setDiscordControlEnabled(true);
  endpoint.onRemoteRequest = (text, finish) => { queueMicrotask(() => finish(`answer: ${text}`)); return true; };
  const snapshot = Promise.withResolvers<void>();
  const control = Promise.withResolvers<void>();
  const reactionStarted = Promise.withResolvers<void>();
  const releaseReaction = Promise.withResolvers<void>();
  const delivered: string[] = [];
  let reactionRequests = 0;
  class ObservedSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener("message", event => {
        if (JSON.parse(String(event.data)).type === "snapshot") queueMicrotask(() => snapshot.resolve());
        if (JSON.parse(String(event.data)).type === "discord_control") queueMicrotask(() => control.resolve());
      });
    }
  }
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const route = new URL(String(input)).pathname;
    if (route.endsWith("/users/@me")) return new Response(JSON.stringify({ id: BOT, username: "offline-bot", bot: true }));
    if (route.endsWith("/gateway/bot")) return new Response(JSON.stringify({ url: "wss://gateway.discord.gg", session_start_limit: { remaining: 10, reset_after: 60000, total: 10, max_concurrency: 1 } }));
    if (route.endsWith(`/channels/${CHANNEL}`)) return new Response(JSON.stringify({ id: CHANNEL, type: 1 }));
    if (route.includes("/reactions/")) { reactionRequests++; reactionStarted.resolve(); await releaseReaction.promise; return new Response(null, { status: 204 }); }
    if (route.endsWith(`/channels/${CHANNEL}/messages`)) {
      delivered.push(JSON.parse(String(init?.body)).content);
      return new Response(JSON.stringify({ id: String(7000 + delivered.length) }));
    }
    throw new Error(`Unexpected fake Discord route: ${route}`);
  }) as typeof fetch;
  const api = new DiscordApi(CONFIG.botToken, { fetchImpl });
  const f = fixture([], { api, WebSocketImpl: ObservedSocket, readdir: async () => [`${endpoint.sessionId}.json`], readFile: file => Bun.file(file).text(), isPidAlive: pid => pid === process.pid });
  try {
    await endpoint.start();
    await f.ready();
    await snapshot.promise;
    await control.promise;
    const first = f.dispatch(f.message(`/send ${endpoint.sessionId} first`));
    await reactionStarted.promise;
    await first;
    await f.dispatch(f.message(`/send ${endpoint.sessionId} second`));
    await f.dispatch(f.message(`/send ${endpoint.sessionId} third`));
    expect(delivered).toEqual(["answer: first", "answer: second", "answer: third"]);
    expect(reactionRequests).toBe(1);
  } finally { releaseReaction.resolve(); f.daemon.stop(); await endpoint.stop(); }
});

test("remote answer timeout cancels only its owning session while another request completes", async () => {
  const f = fixture(["alpha", "beta"]);
  try {
    await f.ready(300000);
    const alpha = f.local.instances[0]!;
    const beta = f.local.instances[1]!;
    alpha.autoRemote = false;
    beta.autoRemote = false;
    const first = f.dispatch(f.message("/send alpha slow request"));
    const a = await alpha.waitForSend(frame => frame.type === "remote_request");
    await alpha.receive({ type: "ack", reqId: a.reqId, ok: true });
    for (const elapsed of [150000, 300000, 300000]) {
      f.clock.advance(elapsed);
      await f.gateway.instances[0]!.receive({ op: 11 });
    }
    f.clock.advance(149999);
    const second = f.dispatch(f.message("/send beta independent request"));
    const b = await beta.waitForSend(frame => frame.type === "remote_request");
    await beta.receive({ type: "ack", reqId: b.reqId, ok: true });
    f.clock.advance(1);
    await first;
    expect(alpha.sent.filter(frame => frame.type === "remote_cancel").map(frame => [frame.sessionId, frame.reqId])).toEqual([["alpha", a.reqId]]);
    expect(beta.sent.filter(frame => frame.type === "remote_cancel")).toEqual([]);
    await beta.receive({ type: "remote_final", sessionId: "beta", reqId: b.reqId, ok: true, controlGeneration: 1, text: "independent answer" });
    await second;
    expect(f.api.sent.map(message => message.text)).toEqual(["Session request failed, was rejected, interrupted, or timed out.", "independent answer"]);
  } finally { f.daemon.stop(); }
});

test("a bot-created thread accepts only its initiating allowlisted user", async () => {
  const secondUser = "444444444444444444";
  const f = fixture(["alpha"], {}, { ...CONFIG, allowedUserIds: [USER, secondUser] });
  f.api.channelType = 0;
  try {
    await f.ready();
    await f.dispatch(f.message("/sessions"));
    await f.dispatch(f.message("/sessions", { channel_id: "91", author: { id: secondUser, bot: false } }));
    await f.dispatch(f.message("/sessions", { channel_id: "91" }));
    expect(f.api.sent.map(message => [message.channel, message.text])).toEqual([["91", "[alpha] /test"], ["91", "[alpha] /test"]]);
  } finally { f.daemon.stop(); }
});

test("an unknown existing thread is not authorized merely by an allowed parent", async () => {
  class ExistingThreadService extends DiscordService {
    override async getChannel(id: string) {
      return id === CHANNEL ? { id, type: 0 } : { id, type: 11, parent_id: CHANNEL };
    }
  }
  const api = new ExistingThreadService();
  const f = fixture(["alpha"], { api });
  try {
    await f.ready();
    await f.dispatch(f.message("/sessions", { channel_id: "9999" }));
    expect(api.sent).toEqual([]);
    expect(f.local.instances[0]!.sent).toEqual([]);
  } finally { f.daemon.stop(); }
});

test("an existing child thread accepts only its verified allowed human owner", async () => {
  const secondUser = "444444444444444444";
  class OwnedThreadService extends DiscordService {
    override async getChannel(id: string) {
      return id === CHANNEL ? { id, type: 0 } : { id, type: 11, parent_id: CHANNEL, owner_id: USER };
    }
  }
  const api = new OwnedThreadService();
  const f = fixture(["alpha"], { api }, { ...CONFIG, allowedUserIds: [USER, secondUser] });
  try {
    await f.ready();
    await f.dispatch(f.message("/sessions", { channel_id: "9999", author: { id: secondUser, bot: false } }));
    await f.dispatch(f.message("/sessions", { channel_id: "9999" }));
    await f.dispatch(f.message("/sessions", { channel_id: "9999", author: { id: secondUser, bot: false } }));
    expect(api.sent.map(message => [message.channel, message.text])).toEqual([["9999", "[alpha] /test"]]);
  } finally { f.daemon.stop(); }
});

test("replayed event cannot execute twice while child thread ownership lookup is pending", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  class SlowLookupService extends DiscordService {
    override async getChannel(id: string) {
      if (id === CHANNEL) return { id, type: 0 };
      entered.resolve();
      await release.promise;
      return { id, type: 11, parent_id: CHANNEL, owner_id: USER };
    }
  }
  const api = new SlowLookupService();
  const f = fixture(["alpha"], { api });
  try {
    await f.ready();
    const event = f.message("/sessions", { channel_id: "9999" });
    const first = f.dispatch(event);
    await entered.promise;
    const replay = f.dispatch(event);
    await replay;
    release.resolve();
    await first;
    expect(api.sent.map(message => [message.channel, message.text])).toEqual([["9999", "[alpha] /test"]]);
  } finally { release.resolve(); f.daemon.stop(); }
});

test("revoking control after remote final drops queued answer and artifact behind an earlier send", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  class BlockingService extends DiscordService {
    files: string[] = [];
    override async sendMessage(channel: string, text: string) {
      if (text.includes("first notification")) { entered.resolve(); await release.promise; }
      return super.sendMessage(channel, text);
    }
    async sendFile(_channel: string, name: string) { this.files.push(name); return [{ id: "777" }]; }
  }
  const api = new BlockingService();
  const f = fixture(["alpha"], { api });
  try {
    await f.ready();
    const socket = f.local.instances[0]!;
    socket.autoRemote = false;
    await socket.receive({ type: "identity_header", sessionId: "alpha", repo: "first notification" });
    await entered.promise;
    const request = f.dispatch(f.message("/send alpha create report"));
    const frame = await socket.waitForSend(item => item.type === "remote_request");
    const stage = await resolveDiscordArtifactStage("alpha", frame.reqId!);
    await fs.writeFile(path.join(stage.output, "report.txt"), "private report");
    await socket.receive({ type: "ack", reqId: frame.reqId, ok: true });
    await socket.receive({ type: "remote_final", sessionId: "alpha", reqId: frame.reqId, ok: true, controlGeneration: 1, artifactsAllowed: true, text: "private answer" });
    await socket.receive({ type: "discord_control", sessionId: "alpha", enabled: false, generation: 2 });
    release.resolve();
    await request;
    expect(api.sent.map(message => message.text)).toEqual(["[alpha] first notification"]);
    expect(api.files).toEqual([]);
  } finally { release.resolve(); f.daemon.stop(); }
});

test("control off then on during attachment staging cannot execute the earlier request", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let stagingSignal: AbortSignal | undefined;
  let cleaned = false;
  const f = fixture(["alpha"], { stageAttachments: async (_attachments, options) => {
    stagingSignal = options.signal;
    entered.resolve();
    await release.promise;
    return { files: [], cleanup: async () => { cleaned = true; } };
  } });
  try {
    await f.ready();
    const socket = f.local.instances[0]!;
    const request = f.dispatch(f.message("/send alpha inspect file", { attachments: [{ filename: "a.txt", url: "https://cdn.discordapp.com/attachments/1/2/a.txt", size: 1 }] }));
    await entered.promise;
    await socket.receive({ type: "discord_control", sessionId: "alpha", enabled: false, generation: 2 });
    await socket.receive({ type: "discord_control", sessionId: "alpha", enabled: true, generation: 3 });
    expect(stagingSignal?.aborted).toBe(true);
    release.resolve();
    await request;
    expect(socket.sent.filter(frame => frame.type === "remote_request")).toEqual([]);
    expect(cleaned).toBe(true);
  } finally { release.resolve(); f.daemon.stop(); }
});
