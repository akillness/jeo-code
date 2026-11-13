import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDiscordAdapter, type DiscordClock } from "../src/messenger/discord";
import { createMessengerGateway, messengerConversationKey } from "../src/messenger/gateway";
import { prepareMessengerArtifactDirectory } from "../src/messenger/artifacts";
import type { DiscordThreadLifecycle, MessengerAdapter, MessengerConfig, MessengerMessage } from "../src/messenger/types";

const config: MessengerConfig = { cwd: "/repo", sessionDir: "/sessions", toolNames: [], platforms: { discord: { tokenEnv: "TOKEN", workerMode: "host", allowedUserIds: ["owner", "teammate"], allowedChannelIds: ["parent"] } } };
const thread = (id: string, messageId: string): MessengerMessage => ({ platform: "discord", accountId: "bot", guildId: "guild", channelId: id, threadId: id, parentChannelId: "parent", senderId: "owner", messageId, text: messageId, direct: false, mentioned: false });
const lifecycle = (kind: DiscordThreadLifecycle["kind"], threadId = "A"): DiscordThreadLifecycle => ({ kind, accountId: "bot", guildId: "guild", parentChannelId: "parent", threadId });
const clock: DiscordClock = { random: () => 0.5, schedule: () => () => {} };

function gatewayTransport(send: MessengerAdapter["send"] = async () => {}) {
  const started = Promise.withResolvers<NonNullable<Parameters<MessengerAdapter["start"]>[2]>>();
  const adapter: MessengerAdapter = {
    platform: "discord", send,
    async start(_message, signal, onLifecycle) {
      started.resolve(onLifecycle!);
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  };
  return { adapter, started: started.promise };
}

for (const stage of ["reply", "delivery"] as const) test(`archive cancels only A's active ${stage} and queued request; B and a fresh unarchived message continue`, async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  const calls: string[] = [];
  const delivered: string[] = [];
  const settled: Array<[string, string]> = [];
  const transport = gatewayTransport(async (message, _text, signal) => {
    if (message.messageId === "A-active" && stage === "delivery") {
      entered.resolve(signal!);
      await release.promise;
    }
    if (!signal?.aborted) delivered.push(message.messageId);
  });
  const gateway = createMessengerGateway(config, [transport.adapter], async (message, signal) => {
    calls.push(message.messageId);
    if (message.messageId === "A-active" && stage === "reply") {
      entered.resolve(signal);
      await release.promise;
    }
    return `answer ${message.messageId}`;
  }, { concurrency: 2, onRequestSettled: async (message, outcome) => { settled.push([message.messageId, outcome]); } });
  const stop = new AbortController();
  const running = gateway.run(stop.signal);
  const active = gateway.handle(thread("A", "A-active"));
  try {
    const event = await transport.started;
    const activeSignal = await entered.promise;
    const queued = gateway.handle(thread("A", "A-queued"));
    await event(lifecycle("archive"));
    expect(activeSignal.aborted).toBe(true);
    release.resolve();
    await Promise.all([active, queued, gateway.handle(thread("B", "B-live"))]);
    expect(calls).toEqual(["A-active", "B-live"]);
    expect(delivered).toEqual(["B-live"]);
    expect(settled).toContainEqual(["A-active", "cancelled"]);
    expect(settled).toContainEqual(["A-queued", "cancelled"]);
    await gateway.handle(thread("A", "A-archived"));
    expect(calls).toEqual(["A-active", "B-live"]);
    await event(lifecycle("unarchive"));
    expect(calls).toEqual(["A-active", "B-live"]);
    await gateway.handle(thread("A", "A-fresh"));
    expect(calls).toEqual(["A-active", "B-live", "A-fresh"]);
    expect(delivered).toEqual(["B-live", "A-fresh"]);
  } finally { release.resolve(); stop.abort(); await Promise.allSettled([active, running]); }
});

test("lifecycle identity cannot cancel another account, guild, parent or thread; normal user/channel authorization stays intact", async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  const calls: string[] = [];
  const transport = gatewayTransport();
  const gateway = createMessengerGateway(config, [transport.adapter], async (message, signal) => {
    calls.push(message.messageId);
    entered.resolve(signal);
    await release.promise;
    return "done";
  }, { concurrency: 2 });
  const stop = new AbortController();
  const running = gateway.run(stop.signal);
  const active = gateway.handle(thread("A", "active"));
  try {
    const event = await transport.started;
    const signal = await entered.promise;
    for (const changed of [{ accountId: "other" }, { guildId: "other" }, { parentChannelId: "other" }, { threadId: "other" }]) {
      await event({ ...lifecycle("archive"), ...changed });
      expect(signal.aborted).toBe(false);
    }
    await gateway.handle({ ...thread("A", "intruder"), senderId: "stranger" });
    await gateway.handle({ ...thread("C", "wrong-channel"), parentChannelId: "unlisted" });
    expect(calls).toEqual(["active"]);
    await event(lifecycle("delete"));
    expect(signal.aborted).toBe(true);
    release.resolve();
    await active;
    await gateway.handle(thread("A", "deleted"));
    expect(calls).toEqual(["active"]);
  } finally { release.resolve(); stop.abort(); await Promise.allSettled([active, running]); }
});

// Payload evidence: docs.discord.com/developers/events/gateway-events.md#thread-update
// uses a channel object; #thread-delete uses only id, guild_id, parent_id and type.
test("trusted Discord lifecycle dispatch preserves full identity, ignores forged routes, and tombstones deleted thread cache", async () => {
  const ready = Promise.withResolvers<void>();
  const messages: MessengerMessage[] = [];
  const events: DiscordThreadLifecycle[] = [];
  const deleted = Promise.withResolvers<void>();
  const archived = Promise.withResolvers<void>();
  const activityRequests: Array<{ method: string; pathname: string }> = [];
  let received = Promise.withResolvers<void>();
  let socket!: Socket;
  let channelReads = 0;
  class Socket extends EventTarget {
    constructor(_url: string) { super(); socket = this; ready.resolve(); }
    send(_text: string) {}
    close() {}
    receive(t: string, d: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ op: 0, s: 2, t, d }) })); }
  }
  const fetchImpl: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
    if (url.pathname.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
    if (url.pathname.endsWith("/channels/A")) { channelReads++; return Response.json({ id: "A", guild_id: "guild", type: 11, parent_id: "parent", owner_id: "bot", name: "Request 123" }); }
    if (url.pathname.endsWith("/channels/parent/messages/123")) return Response.json({ id: "123", channel_id: "parent", author: { id: "owner", bot: false } });
    if (url.pathname.startsWith("/api/v10/channels/A/messages")) {
      activityRequests.push({ method: init?.method ?? "GET", pathname: url.pathname });
      return Response.json({ id: "progress-message" });
    }
    throw new Error(`Unexpected Discord request ${url.pathname}`);
  }, { preconnect() {} });
  const adapter = createDiscordAdapter(config.platforms.discord!, { TOKEN: "fixture-token" }, { fetch: fetchImpl, WebSocket: Socket as unknown as typeof WebSocket, clock });
  const stop = new AbortController();
  const running = adapter.start(async message => { messages.push(message); received.resolve(); }, stop.signal, async event => {
    events.push(event);
    if (event.kind === "archive") archived.resolve();
    if (event.kind === "delete") deleted.resolve();
  });
  const followup = (id: string) => ({ id, guild_id: "guild", channel_id: "A", author: { id: "teammate" }, content: "follow up" });
  const channel = { id: "A", guild_id: "guild", parent_id: "parent", type: 11 };
  try {
    await ready.promise;
    socket.receive("READY", { session_id: "fixture-session", resume_gateway_url: "wss://gateway.discord.gg", user: { id: "bot" } });
    socket.receive("MESSAGE_CREATE", followup("1"));
    await received.promise;
    expect(messages[0]).toMatchObject({ threadId: "A", parentChannelId: "parent", senderId: "teammate", guildId: "guild" });
    expect(channelReads).toBe(1);
    await adapter.activity!(messages[0]!, "Working");
    expect(activityRequests).toEqual([{ method: "POST", pathname: "/api/v10/channels/A/messages" }]);
    socket.receive("THREAD_UPDATE", { ...channel, guild_id: "forged", thread_metadata: { archived: true } });
    socket.receive("THREAD_UPDATE", { ...channel, parent_id: "forged", thread_metadata: { archived: true } });
    socket.receive("THREAD_UPDATE", { ...channel, id: "unknown", thread_metadata: { archived: true } });
    socket.receive("THREAD_UPDATE", { ...channel, thread_metadata: { archived: "true" } });
    socket.receive("THREAD_UPDATE", { ...channel, thread_metadata: { archived: true } });
    await archived.promise;
    await adapter.activity!(messages[0]!, undefined, undefined, "cancelled");
    await adapter.activity!(messages[0]!, "Late progress");
    expect(activityRequests).toEqual([{ method: "POST", pathname: "/api/v10/channels/A/messages" }]);
    socket.receive("THREAD_UPDATE", { ...channel, thread_metadata: { archived: false } });
    received = Promise.withResolvers<void>();
    socket.receive("MESSAGE_CREATE", followup("2"));
    await received.promise;
    expect(events).toEqual([lifecycle("archive"), lifecycle("unarchive")]);
    expect(channelReads).toBe(2);
    expect(messengerConversationKey(messages[1]!)).toBe(messengerConversationKey(messages[0]!));
    await adapter.activity!(messages[1]!, "Working again");
    expect(activityRequests).toEqual([
      { method: "POST", pathname: "/api/v10/channels/A/messages" },
      { method: "POST", pathname: "/api/v10/channels/A/messages" },
    ]);
    socket.receive("THREAD_DELETE", channel);
    await deleted.promise;
    await adapter.activity!(messages[1]!, undefined, undefined, "cancelled");
    await adapter.activity!(messages[1]!, "Deleted-thread progress");
    expect(activityRequests).toEqual([
      { method: "POST", pathname: "/api/v10/channels/A/messages" },
      { method: "POST", pathname: "/api/v10/channels/A/messages" },
    ]);
    received = Promise.withResolvers<void>();
    socket.receive("MESSAGE_CREATE", followup("late-deleted-message"));
    socket.receive("MESSAGE_CREATE", { id: "barrier", channel_id: "dm", author: { id: "owner" }, content: "barrier" });
    await received.promise;
    expect(events).toEqual([lifecycle("archive"), lifecycle("unarchive"), lifecycle("delete")]);
    expect(channelReads).toBe(2);
    expect(messages.map(message => message.messageId)).toEqual(["1", "2", "barrier"]);
  } finally { stop.abort(); await running; }
});

for (const outcome of ["allow", "deny", "abort"] as const) test(`host artifact ${outcome} gates upload of the exact bytes loaded before approval`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-discord-lifecycle-artifact-"));
  const artifactDir = await fs.realpath(root);
  const message = thread("A", "artifact");
  const directory = await prepareMessengerArtifactDirectory(artifactDir, message);
  const source = path.join(directory, "report.txt");
  await fs.writeFile(source, "approved bytes");
  const requested = Promise.withResolvers<readonly { name: string; data: Uint8Array }[]>();
  const decision = Promise.withResolvers<void>();
  const uploaded: Array<{ name: string; bytes: string }> = [];
  const adapter = createDiscordAdapter({ ...config.platforms.discord!, artifactDir }, { TOKEN: "fixture" }, {
    async authorizeArtifacts(_message, files, signal) {
      requested.resolve(files);
      await decision.promise;
      signal.throwIfAborted();
    },
    fetch: Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (init?.body instanceof FormData) {
        const file = init.body.get("files[0]") as File;
        uploaded.push({ name: file.name, bytes: await file.text() });
      }
      return Response.json({ id: "sent" });
    }, { preconnect() {} }),
  });
  const stop = new AbortController();
  const sending = adapter.send(message, "[artifact:report.txt]", stop.signal);
  const result = sending.then(() => "sent", () => "rejected");
  try {
    const files = await requested.promise;
    expect(files.map(file => ({ name: file.name, bytes: new TextDecoder().decode(file.data) }))).toEqual([{ name: "report.txt", bytes: "approved bytes" }]);
    expect(uploaded).toEqual([]);
    await fs.writeFile(source, "changed after approval request");
    if (outcome === "deny") decision.reject(new Error("operator denied"));
    else { if (outcome === "abort") stop.abort(); decision.resolve(); }
    expect(await result).toBe(outcome === "allow" ? "sent" : "rejected");
    expect(uploaded).toEqual(outcome === "allow" ? [{ name: "report.txt", bytes: "approved bytes" }] : []);
  } finally { stop.abort(); decision.resolve(); await result; await fs.rm(root, { recursive: true, force: true }); }
});

for (const scenario of [
  { name: "known archive", known: true, kind: "archive" },
  { name: "first-after-restart archive", known: false, kind: "archive" },
  { name: "first-after-restart delete", known: false, kind: "delete" },
] as const) test(`${scenario.name} during original-message verification cannot be overwritten by stale REST recovery`, async () => {
  const socketReady = Promise.withResolvers<void>();
  const firstMessage = Promise.withResolvers<void>();
  const verifying = Promise.withResolvers<void>();
  const releaseVerification = Promise.withResolvers<void>();
  const barrier = Promise.withResolvers<void>();
  const messages: string[] = [];
  const events: DiscordThreadLifecycle[] = [];
  let originalReads = 0;
  let socket!: Socket;
  class Socket extends EventTarget {
    constructor(_url: string) { super(); socket = this; socketReady.resolve(); }
    send(_text: string) {}
    close() {}
    receive(t: string, d: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ op: 0, s: 2, t, d }) })); }
  }
  const adapter = createDiscordAdapter(config.platforms.discord!, { TOKEN: "fixture" }, {
    clock, WebSocket: Socket as unknown as typeof WebSocket,
    fetch: Object.assign(async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
      if (url.pathname.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
      if (url.pathname.endsWith("/channels/A")) return Response.json({ id: "A", guild_id: "guild", type: 11, parent_id: "parent", owner_id: "bot", name: "Request 123" });
      if (url.pathname.endsWith("/channels/parent/messages/123")) {
        originalReads++;
        if (originalReads === (scenario.known ? 2 : 1)) { verifying.resolve(); await releaseVerification.promise; }
        return Response.json({ id: "123", channel_id: "parent", author: { id: "owner", bot: false } });
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    }, { preconnect() {} }),
  });
  const stop = new AbortController();
  const running = adapter.start(async message => {
    messages.push(message.messageId);
    if (message.messageId === "first") firstMessage.resolve();
    if (message.messageId === "barrier") barrier.resolve();
  }, stop.signal, async event => { events.push(event); });
  const channel = { id: "A", guild_id: "guild", parent_id: "parent", type: 11 };
  const followup = (id: string, sender = "owner") => ({ id, guild_id: "guild", channel_id: "A", author: { id: sender }, content: "follow up" });
  try {
    await socketReady.promise;
    socket.receive("READY", { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg", user: { id: "bot" } });
    if (scenario.known) {
      socket.receive("MESSAGE_CREATE", followup("first")); await firstMessage.promise;
      socket.receive("THREAD_UPDATE", { ...channel, thread_metadata: { archived: true } });
      socket.receive("THREAD_UPDATE", { ...channel, thread_metadata: { archived: false } });
    }
    socket.receive("MESSAGE_CREATE", followup("stale-recovery")); await verifying.promise;
    if (scenario.kind === "archive") socket.receive("THREAD_UPDATE", { ...channel, thread_metadata: { archived: true } });
    else socket.receive("THREAD_DELETE", channel);
    releaseVerification.resolve();
    // Same-channel normalization makes this callback a completion barrier for the held REST verification.
    // This unlisted sender is deliberately left for the gateway's independent admission filter.
    socket.receive("MESSAGE_CREATE", followup("barrier", "unlisted")); await barrier.promise;
    expect(messages).toEqual(scenario.known ? ["first", "barrier"] : ["barrier"]);
    expect(events).toEqual(scenario.known ? [lifecycle("archive"), lifecycle("unarchive"), lifecycle("archive")] : []);
  } finally { releaseVerification.resolve(); stop.abort(); await running; }
});

for (const scenario of [
  { name: "unarchive alone", events: ["unarchive"], fatal: true },
  { name: "archive then unarchive", events: ["archive", "unarchive"], fatal: false },
  { name: "delete then unarchive", events: ["delete", "unarchive"], fatal: false },
] as const) test(`unknown thread ${scenario.name} during channel lookup preserves lifecycle safety`, async () => {
  const socketReady = Promise.withResolvers<void>();
  const lookingUp = Promise.withResolvers<void>();
  const releaseLookup = Promise.withResolvers<void>();
  const barrier = Promise.withResolvers<void>();
  const messages: string[] = [];
  const events: DiscordThreadLifecycle[] = [];
  let socket!: Socket;
  class Socket extends EventTarget {
    constructor(_url: string) { super(); socket = this; socketReady.resolve(); }
    send(_text: string) {}
    close() {}
    receive(t: string, d: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ op: 0, s: 2, t, d }) })); }
  }
  const adapter = createDiscordAdapter(config.platforms.discord!, { TOKEN: "fixture" }, {
    clock, WebSocket: Socket as unknown as typeof WebSocket,
    fetch: Object.assign(async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
      if (url.pathname.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
      if (url.pathname.endsWith("/channels/A")) {
        lookingUp.resolve(); await releaseLookup.promise;
        return Response.json({ id: "A", guild_id: "guild", type: 11, parent_id: "parent", owner_id: "bot", name: "Request 123" });
      }
      if (url.pathname.endsWith("/channels/parent/messages/123")) return Response.json({ id: "123", channel_id: "parent", author: { id: "owner", bot: false } });
      throw new Error(`Unexpected request ${url.pathname}`);
    }, { preconnect() {} }),
  });
  const stop = new AbortController();
  const running = adapter.start(async message => {
    messages.push(message.messageId);
    if (message.messageId === "barrier") barrier.resolve();
  }, stop.signal, async event => { events.push(event); });
  const result = running.then(() => "stopped", error => error instanceof Error ? error.message : String(error));
  const channel = { id: "A", guild_id: "guild", parent_id: "parent", type: 11 };
  const followup = (id: string, sender = "owner") => ({ id, guild_id: "guild", channel_id: "A", author: { id: sender }, content: "follow up" });
  try {
    await socketReady.promise;
    socket.receive("READY", { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg", user: { id: "bot" } });
    socket.receive("MESSAGE_CREATE", followup("stale")); await lookingUp.promise;
    for (const kind of scenario.events) {
      socket.receive(kind === "delete" ? "THREAD_DELETE" : "THREAD_UPDATE", kind === "delete" ? channel : { ...channel, thread_metadata: { archived: kind === "archive" } });
    }
    releaseLookup.resolve();
    socket.receive("MESSAGE_CREATE", followup("barrier", "unlisted"));
    if (scenario.fatal) expect(await result).toBe("Discord message delivery failed");
    else {
      expect(await Promise.race([barrier.promise.then(() => "barrier"), result])).toBe("barrier");
      expect(messages).toEqual(["barrier"]);
    }
    expect(events).toEqual([]);
  } finally { releaseLookup.resolve(); stop.abort(); await result; }
});

for (const scenario of [
  { name: "unknown thread archive", kind: "archive", known: false },
  { name: "unknown thread delete", kind: "delete", known: false },
  { name: "cached thread archive", kind: "archive", known: true },
] as const) test(`queued pre-close messages do not execute after ${scenario.name}`, async () => {
  const socketReady = Promise.withResolvers<void>();
  const lookingUp = Promise.withResolvers<void>();
  const releaseLookup = Promise.withResolvers<void>();
  const barrier = Promise.withResolvers<void>();
  const freshSettled = Promise.withResolvers<void>();
  const initialSettled = Promise.withResolvers<void>();
  const effects: string[] = [];
  const replies: string[] = [];
  const pending = new Set<Promise<void>>();
  let channelReads = 0;
  let socket!: Socket;
  class Socket extends EventTarget {
    constructor(_url: string) { super(); socket = this; socketReady.resolve(); }
    send(_text: string) {}
    close() {}
    receive(t: string, d: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ op: 0, s: 2, t, d }) })); }
  }
  const discord = createDiscordAdapter(config.platforms.discord!, { TOKEN: "fixture" }, {
    clock, WebSocket: Socket as unknown as typeof WebSocket,
    fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
      if (url.pathname.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
      if (url.pathname.endsWith("/channels/A")) {
        channelReads++;
        if (!scenario.known || channelReads > 1) { lookingUp.resolve(); await releaseLookup.promise; }
        return Response.json({ id: "A", guild_id: "guild", type: 11, parent_id: "parent", owner_id: "bot", name: "Request 123" });
      }
      if (url.pathname.endsWith("/channels/parent/messages/123")) return Response.json({ id: "123", channel_id: "parent", author: { id: "owner", bot: false } });
      if (url.pathname.startsWith("/api/v10/channels/A/messages")) {
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        if (typeof body === "object" && body !== null && "content" in body && typeof body.content === "string") replies.push(body.content);
        return Response.json({ id: "reply" });
      }
      if (url.pathname.includes("/reactions/")) return new Response(null, { status: 204 });
      throw new Error(`Unexpected request ${url.pathname}`);
    }, { preconnect() {} }),
  });
  const adapter: MessengerAdapter = {
    ...discord,
    start: (onMessage, signal, onLifecycle) => discord.start(async message => {
      if (message.messageId === "barrier") { await Promise.all(pending); barrier.resolve(); return; }
      const handling = onMessage(message);
      pending.add(handling);
      try { await handling; } finally { pending.delete(handling); }
    }, signal, onLifecycle),
  };
  const gateway = createMessengerGateway(config, [adapter], async message => {
    effects.push(message.messageId);
    return `answer:${message.messageId}`;
  }, { onRequestSettled: async message => {
    if (message.messageId === "fresh") freshSettled.resolve();
    if (message.messageId === "initial") initialSettled.resolve();
  } });
  const stop = new AbortController();
  const running = gateway.run(stop.signal);
  const channel = { id: "A", guild_id: "guild", parent_id: "parent", type: 11 };
  const followup = (id: string, sender = "owner") => ({ id, guild_id: "guild", channel_id: "A", author: { id: sender }, content: "follow up" });
  try {
    await socketReady.promise;
    socket.receive("READY", { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg", user: { id: "bot" } });
    if (scenario.known) {
      socket.receive("MESSAGE_CREATE", followup("initial")); await initialSettled.promise;
      expect(effects).toEqual(["initial"]);
      expect(replies.filter(reply => reply.startsWith("answer:"))).toEqual(["answer:initial"]);
      effects.length = 0; replies.length = 0;
      socket.receive("THREAD_UPDATE", { ...channel, thread_metadata: { archived: true } });
      socket.receive("THREAD_UPDATE", { ...channel, thread_metadata: { archived: false } });
    }
    socket.receive("MESSAGE_CREATE", followup("first")); await lookingUp.promise;
    socket.receive("MESSAGE_CREATE", followup("queued"));
    if (scenario.kind === "archive") {
      socket.receive("THREAD_UPDATE", { ...channel, thread_metadata: { archived: true } });
      socket.receive("THREAD_UPDATE", { ...channel, thread_metadata: { archived: false } });
    } else socket.receive("THREAD_DELETE", channel);
    releaseLookup.resolve();
    socket.receive("MESSAGE_CREATE", followup("barrier", "unlisted")); await barrier.promise;
    expect(effects).toEqual([]);
    expect(replies).toEqual([]);
    if (scenario.kind === "archive") {
      socket.receive("MESSAGE_CREATE", followup("fresh")); await freshSettled.promise;
      expect(effects).toEqual(["fresh"]);
      expect(replies.filter(reply => reply.startsWith("answer:"))).toEqual(["answer:fresh"]);
    }
  } finally { releaseLookup.resolve(); stop.abort(); await running; }
});

for (const scenario of [
  { name: "archive", kind: "archive", overrides: {}, blocked: true },
  { name: "delete", kind: "delete", overrides: {}, blocked: true },
  { name: "another guild", kind: "archive", overrides: { guild_id: "other-guild" }, blocked: false },
  { name: "another parent", kind: "archive", overrides: { parent_id: "other-parent" }, blocked: false },
  { name: "another thread", kind: "delete", overrides: { id: "other-thread" }, blocked: false },
] as const) test(`pending thread creation reconciles ${scenario.name} without stale admission or identity overreach`, async () => {
  const socketReady = Promise.withResolvers<void>();
  const creating = Promise.withResolvers<void>();
  const releaseCreation = Promise.withResolvers<void>();
  const effects: string[] = [];
  const deliveries: string[] = [];
  const events: DiscordThreadLifecycle[] = [];
  let socket!: Socket;
  class Socket extends EventTarget {
    constructor(_url: string) { super(); socket = this; socketReady.resolve(); }
    send(_text: string) {}
    close() {}
    receive(t: string, d: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ op: 0, s: 2, t, d }) })); }
  }
  const adapter = createDiscordAdapter(config.platforms.discord!, { TOKEN: "fixture" }, {
    clock, WebSocket: Socket as unknown as typeof WebSocket,
    fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
      if (url.pathname.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
      if (url.pathname.includes("/reactions/")) return new Response(null, { status: 204 });
      if (url.pathname.endsWith("/channels/parent")) return Response.json({ id: "parent", guild_id: "guild", type: 0 });
      if (url.pathname.endsWith("/channels/parent/messages/123/threads")) {
        expect(init?.method).toBe("POST");
        creating.resolve(); await releaseCreation.promise;
        return Response.json({ id: "A", guild_id: "guild", parent_id: "parent", type: 11 });
      }
      if (url.pathname.startsWith("/api/v10/channels/A/messages")) {
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        if (typeof body === "object" && body !== null && "content" in body && body.content === "completed") deliveries.push(url.pathname);
        return Response.json({ id: "reply" });
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    }, { preconnect() {} }),
  });
  const gateway = createMessengerGateway(config, [adapter], async message => { effects.push(message.threadId!); return "completed"; }, { onThreadLifecycle: async event => { events.push(event); } });
  const stop = new AbortController();
  const running = gateway.run(stop.signal);
  let request: Promise<void> | undefined;
  try {
    await socketReady.promise;
    socket.receive("READY", { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg", user: { id: "bot" } });
    request = gateway.handle({ platform: "discord", accountId: "bot", guildId: "guild", channelId: "parent", senderId: "owner", messageId: "123", text: "create request", direct: false, mentioned: true });
    await creating.promise;
    const eventChannel = { id: "A", guild_id: "guild", parent_id: "parent", type: 11, ...scenario.overrides };
    socket.receive(scenario.kind === "archive" ? "THREAD_UPDATE" : "THREAD_DELETE", scenario.kind === "archive" ? { ...eventChannel, thread_metadata: { archived: true } } : eventChannel);
    releaseCreation.resolve(); await request;
    expect(effects).toEqual(scenario.blocked ? [] : ["A"]);
    expect(deliveries.length).toBe(scenario.blocked ? 0 : 1);
    expect(events).toEqual([]);
  } finally { releaseCreation.resolve(); stop.abort(); await Promise.allSettled([running, ...(request ? [request] : [])]); }
});

// Official start-thread-from-message contract: created thread ID equals the source message ID.
// https://docs.discord.com/developers/resources/channel.md#start-thread-from-message
test("authenticated cancel in a visible thread fences its pending creation without cancelling a sibling or future message", async () => {
  const socketReady = Promise.withResolvers<void>();
  const creating = Promise.withResolvers<void>();
  const releaseCreation = Promise.withResolvers<void>();
  const cancellationAcknowledged = Promise.withResolvers<void>();
  const freshDelivered = Promise.withResolvers<void>();
  const effects: string[] = [];
  const replies: string[] = [];
  const settled: Array<[string, string]> = [];
  let socket!: Socket;
  class Socket extends EventTarget {
    constructor(_url: string) { super(); socket = this; socketReady.resolve(); }
    send(_text: string) {}
    close() {}
    receive(t: string, d: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ op: 0, s: 2, t, d }) })); }
  }
  const adapter = createDiscordAdapter(config.platforms.discord!, { TOKEN: "fixture" }, {
    clock, WebSocket: Socket as unknown as typeof WebSocket,
    fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
      if (url.pathname.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
      if (url.pathname.includes("/reactions/")) return new Response(null, { status: 204 });
      if (url.pathname.endsWith("/channels/parent")) return Response.json({ id: "parent", guild_id: "guild", type: 0 });
      if (url.pathname.endsWith("/channels/100")) return Response.json({ id: "100", guild_id: "guild", parent_id: "parent", type: 11, owner_id: "bot", name: "Request 100" });
      if (url.pathname.endsWith("/channels/parent/messages/100")) return Response.json({ id: "100", channel_id: "parent", author: { id: "owner", bot: false } });
      if (url.pathname.endsWith("/channels/parent/messages/100/threads")) {
        creating.resolve(); await releaseCreation.promise;
        return Response.json({ id: "100", guild_id: "guild", parent_id: "parent", type: 11 });
      }
      if (url.pathname.endsWith("/channels/parent/messages/200/threads")) return Response.json({ id: "200", guild_id: "guild", parent_id: "parent", type: 11 });
      if (url.pathname.startsWith("/api/v10/channels/100/messages") || url.pathname.startsWith("/api/v10/channels/200/messages")) {
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        if (typeof body === "object" && body !== null && "content" in body && typeof body.content === "string") {
          if (body.content === "Cancellation accepted") cancellationAcknowledged.resolve();
          if (body.content.startsWith("answer:")) { replies.push(body.content); if (body.content === "answer:400") freshDelivered.resolve(); }
        }
        return Response.json({ id: "delivery" });
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    }, { preconnect() {} }),
  });
  const gateway = createMessengerGateway(config, [adapter], async message => { effects.push(message.messageId); return `answer:${message.messageId}`; }, {
    async sandboxControl(message) {
      if (message.text !== "/cancel") return { handled: false, output: "" };
      gateway.cancelConversation(messengerConversationKey(message));
      return { handled: true, output: "Cancellation accepted" };
    },
    onRequestSettled: async (message, outcome) => { settled.push([message.messageId, outcome]); },
  });
  const stop = new AbortController();
  const running = gateway.run(stop.signal);
  let original: Promise<void> | undefined;
  let sibling: Promise<void> | undefined;
  try {
    await socketReady.promise;
    socket.receive("READY", { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg", user: { id: "bot" } });
    const source: MessengerMessage = { platform: "discord", accountId: "bot", guildId: "guild", channelId: "parent", senderId: "owner", messageId: "100", text: "start first", direct: false, mentioned: true };
    original = gateway.handle(source); await creating.promise;
    sibling = gateway.handle({ ...source, messageId: "200", text: "independent sibling" });
    socket.receive("MESSAGE_CREATE", { id: "300", guild_id: "guild", channel_id: "100", author: { id: "owner" }, content: "/cancel" });
    await cancellationAcknowledged.promise;
    expect(effects).toEqual([]);
    releaseCreation.resolve(); await Promise.all([original, sibling]);
    expect(effects).toEqual(["200"]);
    expect(replies).toEqual(["answer:200"]);
    expect(settled).toContainEqual(["100", "cancelled"]);
    socket.receive("MESSAGE_CREATE", { id: "400", guild_id: "guild", channel_id: "100", author: { id: "owner" }, content: "fresh next request" });
    await freshDelivered.promise;
    expect(effects).toEqual(["200", "400"]);
    expect(replies).toEqual(["answer:200", "answer:400"]);
  } finally { releaseCreation.resolve(); stop.abort(); await Promise.allSettled([running, ...(original ? [original] : []), ...(sibling ? [sibling] : [])]); }
});
