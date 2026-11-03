import { expect, test } from "bun:test";
import { DiscordDaemon, type DiscordDaemonDependencies } from "../src/agent/notify/discord-daemon";
import { SessionNotifyEndpoint } from "../src/agent/notify/session-endpoint";

const CHANNEL = "111111111111111111";
const THREAD_A = "444444444444444444";
const THREAD_B = "555555555555555555";
const USER = "222222222222222222";
const BOT = "333333333333333333";
type Frame = Record<string, unknown>;
interface Turn { session: string; text: string; finish: (text?: string) => void; signal: AbortSignal }

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

async function fixture(options: { metadataFailure?: Error; blockThreadCreation?: boolean } = {}) {
  const gateways: GatewaySocket[] = [];
  class GatewaySocket {
    readyState = 1;
    onmessage: ((event: { data: string }) => void | Promise<void>) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(_url: string) { gateways.push(this); }
    send(_raw: string) {}
    close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
    async receive(frame: Frame) { await this.onmessage?.({ data: JSON.stringify(frame) }); }
  }
  const endpoints = [new SessionNotifyEndpoint("/offline-metadata-a"), new SessionNotifyEndpoint("/offline-metadata-b")];
  const turns = observations<Turn>();
  const controls = observations<{ session: string; text: string; actor: unknown }>();
  const connected = observations<string>();
  const delivered = observations<{ channel: string; text: string }>();
  const reacted = observations<string>();
  const reactionDetails = observations<{ id: string; emoji: string }>();
  const errors: string[] = [];
  const metadataEntered = Promise.withResolvers<void>();
  const metadataRelease = Promise.withResolvers<void>();
  const threadCreated = Promise.withResolvers<string>();
  const threadRelease = Promise.withResolvers<void>();
  let blockMetadata = true;
  let metadataCalls = 0;
  for (const endpoint of endpoints) {
    endpoint.setDiscordControlEnabled(true);
    endpoint.onRemoteRequest = (text, finish, signal) => {
      turns.add({ session: endpoint.sessionId, text, finish, signal });
      if (text !== "BUSY") queueMicrotask(() => finish(`answer: ${text}`));
      return true;
    };
    endpoint.onSandboxControl = async (text, actor) => {
      controls.add({ session: endpoint.sessionId, text, actor });
      return { handled: true, output: "sandbox control accepted" };
    };
  }
  class ObservedSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener("message", event => {
        const frame = JSON.parse(String(event.data)) as Frame;
        if (frame.type === "discord_control" && frame.enabled === true) connected.add(String(frame.sessionId));
      });
    }
  }
  const api: NonNullable<DiscordDaemonDependencies["api"]> = {
    async getMe() { return { id: BOT, username: "offline-bot", bot: true }; },
    async getChannel(id) {
      if (id === CHANNEL) return { id, type: 0 };
      if (id === THREAD_A && ++metadataCalls === 1 && blockMetadata) {
        metadataEntered.resolve();
        await metadataRelease.promise;
        if (options.metadataFailure) throw options.metadataFailure;
      }
      return { id, type: 11, parent_id: CHANNEL, owner_id: USER };
    },
    async getGatewayBot() { return { url: "wss://gateway.discord.gg", session_start_limit: { remaining: 10, reset_after: 60000, total: 10, max_concurrency: 1 } }; },
    async createThread(_channel, message) {
      const id = options.blockThreadCreation ? message : `9${message}`;
      threadCreated.resolve(id);
      if (options.blockThreadCreation) await threadRelease.promise;
      return { id };
    },
    async addReaction(_channel, message, emoji) { reacted.add(message); reactionDetails.add({ id: message, emoji }); },
    async removeReaction() {},
    async sendMessage(channel, text) { delivered.add({ channel, text }); return [{ id: String(1000 + delivered.values.length) }]; },
    async sendFile() { throw new Error("No artifacts are requested in metadata-ordering tests"); },
    stop() {},
  };
  const daemon = new DiscordDaemon({ botToken: "offline-metadata-token", channelId: CHANNEL, allowedUserIds: [USER] }, {
    api, GatewayWebSocketImpl: GatewaySocket as unknown as typeof WebSocket, WebSocketImpl: ObservedSocket,
    readdir: async () => endpoints.map(endpoint => `${endpoint.sessionId}.json`),
    readFile: file => Bun.file(file).text(), isPidAlive: pid => pid === process.pid,
    random: () => 0.5, scanIntervalMs: 1000000, onError: message => errors.push(message),
  });
  let sequence = 0;
  let messageId = 0;
  const pending: Promise<void>[] = [];
  const dispatchMessage = (channel: string, content: string, replayId?: string) => {
    const id = replayId ?? String(++messageId);
    const done = gateways[0]!.receive({ op: 0, t: "MESSAGE_CREATE", s: ++sequence, d: {
      id, channel_id: channel, type: 0, author: { id: USER, bot: false }, content,
    } });
    pending.push(done);
    return { id, done };
  };
  const dispatch = (channel: string, session: string, text: string, replayId?: string) => dispatchMessage(channel, `/send ${session} ${text}`, replayId);
  const start = async () => {
    for (const endpoint of endpoints) await endpoint.start();
    await daemon.start();
    await gateways[0]!.receive({ op: 10, d: { heartbeat_interval: 300000 } });
    await gateways[0]!.receive({ op: 0, t: "READY", s: ++sequence, d: { session_id: "offline-metadata-gateway", resume_gateway_url: "wss://gateway.discord.gg" } });
    await Promise.all(endpoints.map(endpoint => connected.wait(id => id === endpoint.sessionId)));
  };
  const close = async () => {
    metadataRelease.resolve();
    threadRelease.resolve();
    daemon.stop();
    for (const turn of turns.values) turn.finish();
    await Promise.all(endpoints.map(endpoint => endpoint.stop()));
    await Promise.allSettled(pending);
  };
  return { daemon, endpoints, turns, controls, delivered, reacted, reactionDetails, errors, metadataEntered, metadataRelease, threadCreated, threadRelease, dispatch, dispatchMessage, start, close,
    allowMetadata() { blockMetadata = false; metadataRelease.resolve(); },
  };
}

test("gateway arrival order survives delayed metadata while a different thread and session delivers", async () => {
  const f = await fixture();
  try {
    await f.start();
    const a = f.endpoints[0]!.sessionId;
    const b = f.endpoints[1]!.sessionId;
    const first = f.dispatch(THREAD_A, a, "FIRST");
    await f.metadataEntered.promise;
    const second = f.dispatch(THREAD_A, a, "SECOND");
    // A completed independent request is a positive progress barrier, not a sleep.
    await f.dispatch(THREAD_B, b, "INDEPENDENT").done;
    expect(f.delivered.values).toContainEqual({ channel: THREAD_B, text: "answer: INDEPENDENT" });
    expect(f.turns.values.filter(turn => turn.session === a).map(turn => turn.text)).toEqual([]);
    f.metadataRelease.resolve();
    await Promise.all([first.done, second.done]);
    expect(f.turns.values.filter(turn => turn.session === a).map(turn => turn.text)).toEqual(["FIRST", "SECOND"]);
    expect(f.delivered.values.filter(message => message.channel === THREAD_A).map(message => message.text)).toEqual(["answer: FIRST", "answer: SECOND"]);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 10000);

test("authenticated sandbox control bypasses a busy turn and an earlier queued normal message in the same thread", async () => {
  const f = await fixture();
  try {
    f.allowMetadata();
    await f.start();
    const session = f.endpoints[0]!.sessionId;
    const busy = f.dispatch(THREAD_A, session, "BUSY");
    const turn = await f.turns.wait(turn => turn.text === "BUSY");
    const queued = f.dispatch(THREAD_A, session, "QUEUED");
    await f.reacted.wait(id => id === queued.id);
    const control = f.dispatch(THREAD_A, session, "/sandbox revoke");
    expect(await f.controls.wait(control => control.text === "/sandbox revoke")).toEqual({
      session, text: "/sandbox revoke", actor: { origin: "discord", sessionKey: session, userId: USER },
    });
    await control.done;
    expect(f.delivered.values).toEqual([{ channel: THREAD_A, text: "sandbox control accepted" }]);
    expect(f.turns.values.map(turn => turn.text)).toEqual(["BUSY"]);
    turn.finish("answer: BUSY");
    await Promise.all([busy.done, queued.done]);
    expect(f.turns.values.map(turn => turn.text)).toEqual(["BUSY", "QUEUED"]);
    expect(f.delivered.values.map(message => message.text)).toEqual(["sandbox control accepted", "answer: BUSY", "answer: QUEUED"]);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 10000);

test("transient metadata failure is reported once and replay can execute the message exactly once after recovery", async () => {
  const f = await fixture({ metadataFailure: new Error("temporary Discord metadata outage") });
  try {
    await f.start();
    const session = f.endpoints[0]!.sessionId;
    const first = f.dispatch(THREAD_A, session, "RETRY");
    await f.metadataEntered.promise;
    f.metadataRelease.resolve();
    await first.done;
    expect(f.turns.values.map(turn => turn.text)).toEqual([]);
    expect(f.delivered.values).toEqual([]);
    expect(f.errors).toEqual([expect.stringMatching(/metadata|channel.*lookup/i)]);
    expect(f.reactionDetails.values).toEqual([{ id: first.id, emoji: "❌" }]);
    await f.dispatch(THREAD_A, session, "RETRY", first.id).done;
    await f.dispatch(THREAD_A, session, "RETRY", first.id).done;
    expect(f.turns.values.map(turn => turn.text)).toEqual(["RETRY"]);
    expect(f.delivered.values).toEqual([{ channel: THREAD_A, text: "answer: RETRY" }]);
    expect(f.errors).toEqual([expect.stringMatching(/metadata|channel.*lookup/i)]);
    expect(f.reactionDetails.values.filter(reaction => reaction.emoji === "❌")).toEqual([{ id: first.id, emoji: "❌" }]);
  } finally { await f.close(); }
}, 10000);

for (const outcome of ["succeeds", "fails"] as const) {
  test(`stopping during metadata lookup discards pending arrivals without late reactions or errors when lookup ${outcome}`, async () => {
    const f = await fixture(outcome === "fails" ? { metadataFailure: new Error("late Discord metadata outage") } : {});
    try {
      await f.start();
      const session = f.endpoints[0]!.sessionId;
      const first = f.dispatch(THREAD_A, session, "FIRST");
      await f.metadataEntered.promise;
      const second = f.dispatch(THREAD_A, session, "SECOND");
      f.daemon.stop();
      f.metadataRelease.resolve();
      await Promise.all([first.done, second.done]);
      expect(f.turns.values.map(turn => turn.text)).toEqual([]);
      expect(f.delivered.values).toEqual([]);
      expect(f.reactionDetails.values).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  }, 10000);
}

test("stopping aborts the active endpoint turn and drops the queued normal message and late answer", async () => {
  const f = await fixture();
  try {
    f.allowMetadata();
    await f.start();
    const session = f.endpoints[0]!.sessionId;
    const busy = f.dispatch(THREAD_A, session, "BUSY");
    const turn = await f.turns.wait(turn => turn.text === "BUSY");
    const aborted = Promise.withResolvers<void>();
    turn.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    const queued = f.dispatch(THREAD_A, session, "QUEUED");
    await f.reacted.wait(id => id === queued.id);
    f.daemon.stop();
    await aborted.promise;
    turn.finish("late answer must not escape");
    await Promise.all([busy.done, queued.done]);
    expect(f.turns.values.map(turn => turn.text)).toEqual(["BUSY"]);
    expect(f.delivered.values).toEqual([]);
  } finally { await f.close(); }
}, 10000);

test("originating root precedes a child followup before createThread responds while an independent thread progresses", async () => {
  const f = await fixture({ blockThreadCreation: true });
  try {
    f.allowMetadata();
    await f.start();
    const a = f.endpoints[0]!.sessionId;
    const b = f.endpoints[1]!.sessionId;
    const root = f.dispatchMessage(CHANNEL, `<@${BOT}> /send ${a} ORIGINAL ROOT`);
    // Discord creates a message-started thread with the originating message ID.
    // Its gateway traffic can arrive before the createThread REST response.
    const child = await f.threadCreated.promise;
    const followup = f.dispatch(child, a, "CHILD FOLLOWUP");
    await f.dispatch(THREAD_B, b, "INDEPENDENT").done;
    expect(f.delivered.values).toContainEqual({ channel: THREAD_B, text: "answer: INDEPENDENT" });
    expect(f.turns.values.filter(turn => turn.session === a).map(turn => turn.text)).toEqual([]);
    f.threadRelease.resolve();
    await Promise.all([root.done, followup.done]);
    expect(f.turns.values.filter(turn => turn.session === a).map(turn => turn.text)).toEqual(["ORIGINAL ROOT", "CHILD FOLLOWUP"]);
    expect(f.delivered.values.filter(message => message.channel === child)).toEqual([
      { channel: child, text: "answer: ORIGINAL ROOT" },
      { channel: child, text: "answer: CHILD FOLLOWUP" },
    ]);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 10000);

test("preparation admission overflow reports a bounded visible failure and accepts replay once capacity frees", async () => {
  const f = await fixture();
  try {
    await f.start();
    const session = f.endpoints[0]!.sessionId;
    const first = f.dispatchMessage(THREAD_A, "/help");
    await f.metadataEntered.promise;
    // Hold all 128 preparation slots without filling the separate prompt queue.
    const queued = Array.from({ length: 127 }, () => f.dispatchMessage(THREAD_A, "/help"));
    const overflow = f.dispatch(THREAD_A, session, "RETRY AFTER CAPACITY");
    await overflow.done;
    const failure = { errors: [...f.errors], reactions: [...f.reactionDetails.values], messages: [...f.delivered.values], turns: f.turns.values.map(turn => turn.text) };
    f.metadataRelease.resolve();
    await Promise.all([first.done, ...queued.map(message => message.done)]);
    const replayStart = f.delivered.values.length;
    await f.dispatch(THREAD_A, session, "RETRY AFTER CAPACITY", overflow.id).done;
    await f.dispatch(THREAD_A, session, "RETRY AFTER CAPACITY", overflow.id).done;
    expect({ failure, replayTurns: f.turns.values.map(turn => turn.text), replayMessages: f.delivered.values.slice(replayStart) }).toEqual({
      failure: {
        errors: [expect.stringMatching(/preparation queue full/i)],
        reactions: [{ id: overflow.id, emoji: "❌" }],
        messages: [],
        turns: [],
      },
      replayTurns: ["RETRY AFTER CAPACITY"],
      replayMessages: [{ channel: THREAD_A, text: "answer: RETRY AFTER CAPACITY" }],
    });
    expect(f.errors).toEqual(failure.errors);
  } finally { await f.close(); }
}, 10000);
