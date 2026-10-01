import { test, expect } from "bun:test";
import { SlackDaemon, type SlackDaemonDependencies } from "../src/agent/notify/slack-daemon";
import { SessionNotifyEndpoint } from "../src/agent/notify/session-endpoint";
import { SubagentRegistry } from "../src/agent/subagent-registry";

const CHANNEL = "C111";
const USER = "U111";
const BOT = "U999";
const TEAM = "T111";
const APP = "A111";
const CONFIG = { botToken: "xoxb-offline", appToken: "xapp-offline", channelId: CHANNEL, allowedUserIds: [USER, BOT] };
type Frame = { type?: string; reqId?: string; text?: string; id?: string; ids?: string[]; message?: string; envelope_id?: string; sessionId?: string; [key: string]: unknown };
type SentMessage = { ts: string; channel: string; text: string; threadTs?: string };

class Clock {
  now = 0;
  private sequence = 0;
  readonly jobs = new Map<number, { at: number; callback: () => void }>();
  set = (callback: () => void, ms: number): Timer => {
    const id = ++this.sequence;
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

function socketMode() {
  const instances: Socket[] = [];
  const created: (() => void)[] = [];
  class Socket {
    readyState = 1;
    sent: Frame[] = [];
    onmessage: ((event: { data: string }) => void | Promise<void>) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) { instances.push(this); created.splice(0).forEach(resolve => resolve()); }
    send(raw: string): void { this.sent.push(JSON.parse(raw)); }
    close(code = 1000): void { this.readyState = 3; this.onclose?.({ code }); }
    async receive(value: unknown): Promise<void> { await this.raw(JSON.stringify(value)); }
    async raw(data: string): Promise<void> { await this.onmessage?.({ data }); }
  }
  return {
    instances, Impl: Socket as unknown as typeof WebSocket,
    next: () => { const { promise, resolve } = Promise.withResolvers<void>(); created.push(resolve); return promise; },
  };
}

class SlackService {
  sent: SentMessage[] = [];
  stopped = false;
  private waiters: { predicate: (message: SentMessage) => boolean; resolve: (message: SentMessage) => void }[] = [];
  async getMe() { return { team_id: TEAM, user_id: BOT, bot_id: "B999", app_id: APP }; }
  async getChannel() { return { id: CHANNEL, is_member: true, context_team_id: TEAM }; }
  async openConnection() { return { url: "wss://wss-primary.slack.com/link/?ticket=offline" }; }
  async sendMessage(channel: string, text: string, threadTs?: string) {
    const message = { ts: `2000.${String(this.sent.length + 1).padStart(6, "0")}`, channel, text, threadTs };
    this.sent.push(message);
    for (const waiter of [...this.waiters]) if (waiter.predicate(message)) {
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
    return [{ ts: message.ts }];
  }
  waitFor(predicate: (message: SentMessage) => boolean) {
    const existing = this.sent.find(predicate);
    if (existing) return Promise.resolve(existing);
    const { promise, resolve } = Promise.withResolvers<SentMessage>();
    this.waiters.push({ predicate, resolve });
    return promise;
  }
  stop(): void { this.stopped = true; }
}

function fixture(endpoints: SessionNotifyEndpoint[] = [], overrides: SlackDaemonDependencies = {}) {
  const api = new SlackService();
  const socket = socketMode();
  const clock = new Clock();
  const errors: string[] = [];
  const fatal: string[] = [];
  const snapshots = new Map(endpoints.map(endpoint => [endpoint.sessionId, Promise.withResolvers<void>()]));
  const received: string[] = [];
  class ObservedSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener("message", event => {
        const frame = JSON.parse(String(event.data));
        if (frame.type === "snapshot") queueMicrotask(() => snapshots.get(frame.sessionId)?.resolve());
      });
    }
  }
  const daemon = new SlackDaemon(CONFIG, {
    api, SocketWebSocketImpl: socket.Impl, WebSocketImpl: ObservedSocket,
    readdir: async () => endpoints.map(endpoint => `${endpoint.sessionId}.json`),
    readFile: file => Bun.file(file).text(), isPidAlive: pid => pid === process.pid,
    now: () => clock.now, setTimeout: clock.set, clearTimeout: clock.clear,
    scanIntervalMs: 1_000_000, ackTimeoutMs: 250, handshakeTimeoutMs: 100, maxReconnects: 2,
    onError: message => errors.push(message), onFatal: message => fatal.push(message), ...overrides,
  });
  let nextId = 0;
  const envelope = (text: string, event: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) => {
    const id = ++nextId;
    return { type: "events_api", envelope_id: `envelope-${id}`, payload: { type: "event_callback", team_id: TEAM, api_app_id: APP, event_id: `Ev${id}`,
      event: { type: "message", user: USER, channel: CHANNEL, text, ts: `1000.${String(id).padStart(6, "0")}`, ...event }, ...payload } };
  };
  const dispatch = (value: unknown) => socket.instances.at(-1)!.receive(value);
  const ready = async () => {
    for (const endpoint of endpoints) { endpoint.onUserMessage = message => { received.push(message.text); }; await endpoint.start(); }
    await daemon.start();
    await dispatch({ type: "hello", connection_info: { app_id: APP } });
    await Promise.all([...snapshots.values()].map(item => item.promise));
  };
  const stop = async () => { daemon.stop(); await Promise.all(endpoints.map(endpoint => endpoint.stop())); };
  return { daemon, api, socket, clock, errors, fatal, received, ready, dispatch, envelope, stop };
}

test("ignored and malformed envelopes are ACKed without disclosing sessions or dispatching commands", async () => {
  const endpoint = new SessionNotifyEndpoint("/offline-slack");
  const f = fixture([endpoint]);
  try {
    await f.ready();
    for (const raw of ["{", "null", "[]", '"string"']) await f.socket.instances[0]!.raw(raw);
    const denied = [
      f.envelope(`/send ${endpoint.sessionId} denied`, { channel: "C222" }),
      f.envelope(`/send ${endpoint.sessionId} denied`, { user: "U222" }),
      f.envelope(`/send ${endpoint.sessionId} denied`, { user: BOT }),
      f.envelope(`/send ${endpoint.sessionId} denied`, { bot_id: "B222" }),
      f.envelope(`/send ${endpoint.sessionId} denied`, { subtype: "message_changed" }),
      f.envelope(`/send ${endpoint.sessionId} denied`, {}, { team_id: "T222" }),
      f.envelope(`/send ${endpoint.sessionId} denied`, {}, { api_app_id: "A222" }),
      f.envelope(`/send ${endpoint.sessionId} denied`, { text: 123 }),
      { type: "interactive", envelope_id: "ignored-interaction", payload: {} },
      { type: "events_api", envelope_id: "malformed-event", payload: null },
    ];
    for (const event of denied) await f.dispatch(event);
    expect(f.socket.instances[0]!.sent.map(frame => frame.envelope_id)).toEqual(denied.map(event => event.envelope_id));
    expect(f.received).toEqual([]);
    expect(f.api.sent).toEqual([]);
    await f.dispatch(f.envelope(`/send ${endpoint.sessionId} authorized after malformed input`));
    expect(f.received).toEqual(["authorized after malformed input"]);
    expect(f.api.sent.at(-1)?.text).toMatch(/acknowledged/i);
  } finally { await f.stop(); }
});

test("Slack retries and overlapping message/app_mention subscriptions dispatch once but ACK every envelope", async () => {
  const endpoint = new SessionNotifyEndpoint("/offline-slack-dedupe");
  const f = fixture([endpoint]);
  try {
    await f.ready();
    const first = f.envelope(`/send ${endpoint.sessionId} exactly once`);
    await f.dispatch(first);
    await f.dispatch(first);
    await f.dispatch({ ...first, envelope_id: "replayed-event" });
    await f.dispatch({ ...first, envelope_id: "overlap", payload: { ...first.payload, event_id: "EvOverlap", event: { ...first.payload.event, type: "app_mention" } } });
    expect(f.received).toEqual(["exactly once"]);
    expect(f.socket.instances[0]!.sent.map(frame => frame.envelope_id)).toEqual([first.envelope_id, first.envelope_id, "replayed-event", "overlap"]);
  } finally { await f.stop(); }
});

test("authorized main-session prompts and thread replies round-trip through a real session endpoint", async () => {
  const alpha = new SessionNotifyEndpoint("/offline-slack-alpha");
  const beta = new SessionNotifyEndpoint("/offline-slack-beta");
  const f = fixture([alpha, beta]);
  const alphaMessages: string[] = [];
  const betaMessages: string[] = [];
  try {
    await f.ready();
    alpha.onUserMessage = message => { alphaMessages.push(message.text); };
    beta.onUserMessage = message => { betaMessages.push(message.text); };
    await f.dispatch(f.envelope(`/send ${alpha.sessionId} inspect alpha`));
    const final = f.api.waitFor(message => message.text.includes("Alpha final answer"));
    alpha.sendTurnStream("Alpha final answer");
    const notification = await final;
    await f.dispatch(f.envelope("/help"));
    await f.dispatch(f.envelope(`/send ${beta.sessionId} inspect beta`));
    await f.dispatch(f.envelope(`[${beta.sessionId}] quoted label cannot redirect`, { thread_ts: notification.ts }));
    await f.dispatch(f.envelope(`<@${BOT}> unbound thread must not guess`, { thread_ts: "9999.000001" }));
    expect(alphaMessages).toEqual(["inspect alpha", `[${beta.sessionId}] quoted label cannot redirect`]);
    expect(betaMessages).toEqual(["inspect beta"]);
    expect(f.api.sent.at(-1)?.text).toMatch(/unknown|expired|unbound/i);
    expect(notification.channel).toBe(CHANNEL);
  } finally { await f.stop(); }
});

test("steer changes the real running subagent inbox and cancel aborts it only after matching ACK", async () => {
  const registry = new SubagentRegistry();
  const release = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const record = registry.launch("executor", "wait for remote control", async signal => {
    signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
    await release.promise;
    return { success: true, output: "finished" };
  });
  const endpoint = new SessionNotifyEndpoint("/offline-slack-control");
  endpoint.attachRegistry(registry);
  const f = fixture([endpoint]);
  try {
    await f.ready();
    await f.dispatch(f.envelope(`/steer ${endpoint.sessionId} ${record.id} inspect the real invariant`));
    expect(registry.steerDrainFor(record.id)()).toEqual(["inspect the real invariant"]);
    expect(f.api.sent.at(-1)?.text).toMatch(/acknowledged/i);
    await f.dispatch(f.envelope(`/cancel ${endpoint.sessionId} ${record.id}`));
    await cancelled.promise;
    expect(registry.get(record.id)?.status).toBe("cancelled");
    expect(f.api.sent.at(-1)?.text).toMatch(/acknowledged/i);
    await f.dispatch(f.envelope(`/steer ${endpoint.sessionId} missing-agent never delivered`));
    expect(f.api.sent.at(-1)?.text).toMatch(/not acknowledged/i);
  } finally { release.resolve(); registry.cancelAll(); await registry.awaitIds([record.id]); await f.stop(); }
});

test("a main-session rejection cannot become success and a pending delivery is settled by stop", async () => {
  const endpoint = new SessionNotifyEndpoint("/offline-slack-stop");
  const f = fixture([endpoint]);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    await f.ready();
    endpoint.onUserMessage = () => false;
    await f.dispatch(f.envelope(`/send ${endpoint.sessionId} rejected prompt`));
    expect(f.api.sent.at(-1)?.text).toMatch(/not acknowledged/i);
    endpoint.onUserMessage = async () => { entered.resolve(); await release.promise; };
    const command = f.dispatch(f.envelope(`/send ${endpoint.sessionId} pending prompt`));
    await entered.promise;
    const count = f.api.sent.length;
    f.daemon.stop();
    await command;
    release.resolve();
    f.clock.advance(1_000_000);
    expect(f.api.sent.length).toBe(count);
    expect(f.api.stopped).toBe(true);
    expect(f.clock.jobs.size).toBe(0);
  } finally { release.resolve(); await f.stop(); }
});

test("mismatched Slack app cannot discover sessions", async () => {
  let scans = 0;
  const f = fixture([], { readdir: async () => { scans++; return []; } });
  try {
    await f.daemon.start();
    await f.dispatch({ type: "hello", connection_info: { app_id: "A222" } });
    expect(scans).toBe(0);
    expect(f.fatal).toHaveLength(1);
    expect(f.api.stopped).toBe(true);
  } finally { await f.stop(); }
});

test("reconnect budget exhaustion signals onFatal once and stop cancels every scheduled retry", async () => {
  const f = fixture();
  try {
    await f.ready();
    for (let attempt = 0; attempt < 2; attempt++) {
      const connected = f.socket.next();
      f.socket.instances.at(-1)!.onerror?.();
      f.clock.advance(30_000);
      await connected;
    }
    const last = f.socket.instances.at(-1)!;
    last.onerror?.();
    expect(f.fatal).toHaveLength(1);
    expect(f.fatal[0]).toMatch(/reconnect/i);
    expect(f.api.stopped).toBe(true);
    const count = f.socket.instances.length;
    last.onerror?.();
    f.clock.advance(1_000_000);
    expect(f.socket.instances.length).toBe(count);
    expect(f.fatal).toHaveLength(1);
    expect(f.clock.jobs.size).toBe(0);
  } finally { await f.stop(); }
});

test("stop during pending connection acquisition refuses late socket creation", async () => {
  const acquisition = Promise.withResolvers<{ url: string }>();
  const entered = Promise.withResolvers<void>();
  const api = new SlackService();
  api.openConnection = () => { entered.resolve(); return acquisition.promise; };
  const f = fixture([], { api });
  try {
    const start = f.daemon.start();
    await entered.promise;
    f.daemon.stop();
    acquisition.resolve({ url: "wss://wss-primary.slack.com/link/?ticket=late" });
    await start;
    expect(f.socket.instances).toEqual([]);
    expect(f.clock.jobs.size).toBe(0);
    expect(api.stopped).toBe(true);
  } finally { await f.stop(); }
});

test("missing hello exhausts the handshake budget without discovering local sessions", async () => {
  let scans = 0;
  const f = fixture([], { readdir: async () => { scans++; return []; } });
  try {
    await f.daemon.start();
    for (let attempt = 0; attempt < 2; attempt++) {
      const next = f.socket.next();
      f.clock.advance(30_000);
      await next;
    }
    f.clock.advance(100);
    expect(scans).toBe(0);
    expect(f.fatal).toHaveLength(1);
    expect(f.fatal[0]).toMatch(/reconnect/i);
    expect(f.clock.jobs.size).toBe(0);
  } finally { await f.stop(); }
});

test("stop cancels a scheduled reconnect and stale envelopes cannot restart the provider", async () => {
  const f = fixture();
  try {
    await f.ready();
    const old = f.socket.instances[0]!;
    old.onerror?.();
    f.daemon.stop();
    f.clock.advance(1_000_000);
    await old.receive(f.envelope("/sessions"));
    expect(f.socket.instances).toHaveLength(1);
    expect(f.api.sent).toEqual([]);
    expect(f.fatal).toEqual([]);
    expect(f.clock.jobs.size).toBe(0);
  } finally { await f.stop(); }
});

test("Slack native slash commands preserve prompt text and reject forged actors before local dispatch", async () => {
  const endpoint = new SessionNotifyEndpoint("/offline-slack-slash");
  const f = fixture([endpoint]);
  try {
    await f.ready();
    const payload = { team_id: TEAM, api_app_id: APP, channel_id: CHANNEL, user_id: USER, command: "/send", text: `${endpoint.sessionId} preserve &lt;tag&gt; &amp; text`, trigger_id: "trigger-1" };
    await f.dispatch({ type: "slash_commands", envelope_id: "slash-1", payload });
    await f.dispatch({ type: "slash_commands", envelope_id: "slash-replay", payload });
    await f.dispatch({ type: "slash_commands", envelope_id: "slash-forged", payload: { ...payload, trigger_id: "trigger-2", user_id: "U222" } });
    expect(f.received).toEqual(["preserve <tag> & text"]);
    expect(f.socket.instances[0]!.sent.map(frame => frame.envelope_id)).toEqual(["slash-1", "slash-replay", "slash-forged"]);
  } finally { await f.stop(); }
});

test("a local ACK must match both request and socket; malformed ACKs time out instead of reporting success", async () => {
  const observed = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  const observe = (key: string) => {
    const signal = Promise.withResolvers<void>();
    observed.set(key, signal);
    return signal.promise;
  };
  class LocalSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener("message", event => {
        const frame = JSON.parse(String(event.data));
        queueMicrotask(() => observed.get(frame.marker ?? frame.sessionId)?.resolve());
      });
    }
  }
  const makePeer = (id: string) => {
    const connected = Promise.withResolvers<{ send: (data: string) => number }>();
    let next = Promise.withResolvers<Frame>();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch: (request, server) => new URL(request.url).searchParams.get("token") === "offline-session-secret" && server.upgrade(request) ? undefined : new Response("unauthorized", { status: 401 }),
      websocket: {
        open: ws => { connected.resolve(ws); ws.send(JSON.stringify({ type: "snapshot", sessionId: id, pid: process.pid, subagents: [] })); },
        message: (_ws, raw) => { const frame = JSON.parse(String(raw)); const waiting = next; next = Promise.withResolvers<Frame>(); waiting.resolve(frame); },
      },
    });
    return { server,
      discovery: JSON.stringify({ url: `ws://127.0.0.1:${server.port}`, token: "offline-session-secret", pid: process.pid, cwd: "/offline-ack-protocol" }),
      request: () => next.promise,
      send: async (frame: Frame) => {
        const marker = crypto.randomUUID();
        const handled = observe(marker);
        (await connected.promise).send(JSON.stringify({ ...frame, marker }));
        await handled;
      },
    };
  };
  const alpha = makePeer("alpha");
  const beta = makePeer("beta");
  const initialized = Promise.all([observe("alpha"), observe("beta")]);
  const f = fixture([], { WebSocketImpl: LocalSocket,
    readdir: async () => ["alpha.json", "beta.json"],
    readFile: async file => file.endsWith("alpha.json") ? alpha.discovery : beta.discovery,
  });
  try {
    await f.ready();
    await initialized;
    const incoming = alpha.request();
    const command = f.dispatch(f.envelope("/steer alpha executor-1 important instruction"));
    const frame = await incoming;
    expect({ type: frame.type, id: frame.id, message: frame.message }).toEqual({ type: "steer", id: "executor-1", message: "important instruction" });
    await beta.send({ type: "ack", reqId: frame.reqId, ok: true });
    await alpha.send({ type: "ack", reqId: "different-request", ok: true });
    await alpha.send({ type: "ack", reqId: frame.reqId, ok: "true" });
    expect(f.api.sent).toEqual([]);
    f.clock.advance(250);
    await command;
    expect(f.api.sent.at(-1)?.text).toMatch(/not acknowledged/i);
    const next = alpha.request();
    const cancel = f.dispatch(f.envelope("/cancel alpha executor-1"));
    const cancellation = await next;
    await alpha.send({ type: "ack", reqId: frame.reqId, ok: true });
    expect(f.api.sent).toHaveLength(1);
    await alpha.send({ type: "ack", reqId: cancellation.reqId, ok: true });
    await cancel;
    expect(f.api.sent.at(-1)?.text).toMatch(/^Session acknowledged/);
  } finally { await f.stop(); await alpha.server.stop(true); await beta.server.stop(true); }
});

test("ordinary channel chatter and unrelated threads never solicit relay traffic", async () => {
  const endpoint = new SessionNotifyEndpoint("/offline-slack-chatter");
  const f = fixture([endpoint]);
  try {
    await f.ready();
    await f.dispatch(f.envelope("deployment finished"));
    await f.dispatch(f.envelope("a human thread reply", { thread_ts: "9999.000001" }));
    expect(f.received).toEqual([]);
    expect(f.api.sent).toEqual([]);
    await f.dispatch(f.envelope(`<@${BOT}> please help route this prompt`, { type: "app_mention" }));
    expect(f.api.sent.at(-1)?.text).toMatch(/unknown|expired|send/i);
  } finally { await f.stop(); }
});
