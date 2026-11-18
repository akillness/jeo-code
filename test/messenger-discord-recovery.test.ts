import { expect, test } from "bun:test";
import { createDiscordAdapter } from "../src/messenger/discord";
import { isMessengerMessageAllowed } from "../src/messenger/gateway";
import type { MessengerConfig, MessengerMessage } from "../src/messenger/types";

const settings: MessengerConfig = { cwd: "/repo", sessionDir: "/sessions", toolNames: [], platforms: { discord: { tokenEnv: "JEO_DISCORD_BOT_TOKEN", allowedUserIds: ["owner", "teammate"], allowedChannelIds: ["parent"] } } };

for (const scenario of [
  { name: "verified original sender", sender: "owner", parent: "parent", originalAuthor: "owner", accepted: true },
  { name: "different allowlisted original sender", sender: "owner", parent: "parent", originalAuthor: "teammate", accepted: true },
  { name: "different allowlisted follow-up sender", sender: "teammate", parent: "parent", originalAuthor: "owner", accepted: true },
  { name: "unlisted sender", sender: "other", parent: "parent", originalAuthor: "other", accepted: false },
  { name: "unlisted original author", sender: "owner", parent: "parent", originalAuthor: "other", accepted: false },
  { name: "unlisted parent", sender: "owner", parent: "untrusted", originalAuthor: "owner", accepted: false },
  { name: "malformed parent", sender: "owner", parent: undefined, originalAuthor: "owner", accepted: false },
] as Array<{ name: string; sender: string; parent: string | undefined; originalAuthor: string; accepted: boolean }>) test(`Discord restart restores only authenticated threads: ${scenario.name}`, async () => {
  const socketReady = Promise.withResolvers<void>();
  const requestRead = Promise.withResolvers<void>();
  const delivered: MessengerMessage[] = [];
  const calls: string[] = [];
  let socket: FakeSocket;
  class FakeSocket extends EventTarget {
    constructor(_url: string) { super(); socket = this; socketReady.resolve(); }
    send(_value: string) {}
    close() {}
    receive(packet: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(packet) })); }
  }
  const fetchImpl: typeof fetch = async input => {
    const url = new URL(String(input)); calls.push(url.pathname);
    if (url.pathname.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
    if (url.pathname.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
    if (url.pathname.endsWith("/channels/thread")) { requestRead.resolve(); return Response.json({ id: "thread", type: 11, parent_id: scenario.parent, owner_id: "bot", name: "Request 123" }); }
    if (url.pathname.endsWith(`/channels/${scenario.parent}/messages/123`)) return Response.json({ id: "123", channel_id: scenario.parent, author: { id: scenario.originalAuthor, bot: false } });
    return new Response(null, { status: 404 });
  };
  const adapter = createDiscordAdapter(settings.platforms.discord!, { JEO_DISCORD_BOT_TOKEN: "fake" }, { fetch: fetchImpl, WebSocket: FakeSocket as unknown as typeof WebSocket });
  const controller = new AbortController();
  const running = adapter.start(async message => { if (isMessengerMessageAllowed(message, settings)) delivered.push(message); }, controller.signal);
  try {
    await socketReady.promise;
    socket!.receive({ op: 10, d: { heartbeat_interval: 300000 } });
    socket!.receive({ op: 0, t: "READY", s: 1, d: { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg" } });
    socket!.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { id: "456", channel_id: "thread", guild_id: "guild", author: { id: scenario.sender }, content: "follow up" } });
    if (scenario.sender !== "other") await requestRead.promise;
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(delivered.length).toBe(scenario.accepted ? 1 : 0);
    if (scenario.accepted) {
      expect(delivered[0]).toMatchObject({ senderId: scenario.sender, parentChannelId: "parent", threadId: "thread", text: "follow up" });
      expect(calls).toContain("/api/v10/channels/parent/messages/123");
    }
  } finally { controller.abort(); await running; }
});
for (const failure of ["503", "429", "network"] as const) test(`Discord reports an authorized inbound message lost to channel lookup ${failure}`, async () => {
  const socketReady = Promise.withResolvers<void>();
  const lookupStarted = Promise.withResolvers<void>();
  const lookup = Promise.withResolvers<Response>();
  const delivered: string[] = [];
  let socket: FakeSocket;
  class FakeSocket extends EventTarget {
    constructor(_url: string) { super(); socket = this; socketReady.resolve(); }
    send(_value: string) {}
    close() {}
    receive(packet: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(packet) })); }
  }
  const fetchImpl: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
    if (path.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
    if (path.endsWith("/channels/parent")) { lookupStarted.resolve(); return lookup.promise; }
    throw new Error(`Unexpected fake request: ${path}`);
  };
  const adapter = createDiscordAdapter(settings.platforms.discord!, { JEO_DISCORD_BOT_TOKEN: "fake" }, { fetch: fetchImpl, WebSocket: FakeSocket as unknown as typeof WebSocket });
  const controller = new AbortController();
  let outcome: { error: unknown } | { stopped: true } | undefined;
  const running = adapter.start(async message => { delivered.push(message.text); }, controller.signal).then(
    () => { outcome = { stopped: true }; },
    error => { outcome = { error }; },
  );
  try {
    await socketReady.promise;
    socket!.receive({ op: 10, d: { heartbeat_interval: 300000 } });
    socket!.receive({ op: 0, t: "READY", s: 1, d: { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg" } });
    socket!.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { id: "101", channel_id: "parent", guild_id: "guild", author: { id: "owner" }, mentions: [{ id: "bot" }], content: "first" } });
    await lookupStarted.promise;
    socket!.receive({ op: 0, t: "MESSAGE_CREATE", s: 3, d: { id: "102", channel_id: "parent", guild_id: "guild", author: { id: "owner" }, mentions: [{ id: "bot" }], content: "second" } });
    if (failure === "network") lookup.reject(new Error("private network detail"));
    else lookup.resolve(new Response(null, { status: Number(failure) }));
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(outcome).toHaveProperty("error");
    if (outcome && "error" in outcome) {
      expect(String(outcome.error)).toMatch(/Discord.*(delivery|message|inbound)/i);
      expect(String(outcome.error)).not.toContain("private network detail");
    }
    expect(delivered).toEqual([]);
  } finally { controller.abort(); await running; }
});

test("Discord delivers authorized parent messages in order while channel lookup is pending", async () => {
  const socketReady = Promise.withResolvers<void>();
  const lookupStarted = Promise.withResolvers<void>();
  const lookup = Promise.withResolvers<Response>();
  const receivedBoth = Promise.withResolvers<void>();
  const delivered: string[] = [];
  let socket: FakeSocket;
  class FakeSocket extends EventTarget {
    constructor(_url: string) { super(); socket = this; socketReady.resolve(); }
    send(_value: string) {}
    close() {}
    receive(packet: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(packet) })); }
  }
  let lookups = 0;
  const fetchImpl: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
    if (path.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
    if (path.endsWith("/channels/parent")) {
      if (++lookups === 1) { lookupStarted.resolve(); return lookup.promise; }
      return Response.json({ id: "parent", type: 0 });
    }
    throw new Error(`Unexpected fake request: ${path}`);
  };
  const adapter = createDiscordAdapter(settings.platforms.discord!, { JEO_DISCORD_BOT_TOKEN: "fake" }, { fetch: fetchImpl, WebSocket: FakeSocket as unknown as typeof WebSocket });
  const controller = new AbortController();
  const running = adapter.start(async message => {
    if (isMessengerMessageAllowed(message, settings)) delivered.push(message.text);
    if (delivered.length === 2) receivedBoth.resolve();
  }, controller.signal);
  try {
    await socketReady.promise;
    socket!.receive({ op: 10, d: { heartbeat_interval: 300000 } });
    socket!.receive({ op: 0, t: "READY", s: 1, d: { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg" } });
    socket!.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { id: "101", channel_id: "parent", guild_id: "guild", author: { id: "owner" }, mentions: [{ id: "bot" }], content: "first" } });
    await lookupStarted.promise;
    socket!.receive({ op: 0, t: "MESSAGE_CREATE", s: 3, d: { id: "102", channel_id: "parent", guild_id: "guild", author: { id: "owner" }, mentions: [{ id: "bot" }], content: "second" } });
    lookup.resolve(Response.json({ id: "parent", type: 0 }));
    await receivedBoth.promise;
    expect(delivered).toEqual(["first", "second"]);
  } finally { controller.abort(); await running; }
});

test("Discord reports handler failure without replaying an uncertain side effect", async () => {
  const socketReady = Promise.withResolvers<void>();
  const handlerEntered = Promise.withResolvers<void>();
  const handler = Promise.withResolvers<void>();
  const delivered: string[] = [];
  let socket: FakeSocket;
  class FakeSocket extends EventTarget {
    constructor(_url: string) { super(); socket = this; socketReady.resolve(); }
    send(_value: string) {}
    close() {}
    receive(packet: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(packet) })); }
  }
  const fetchImpl: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
    if (path.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
    if (path.endsWith("/channels/parent")) return Response.json({ id: "parent", type: 0 });
    throw new Error(`Unexpected fake request: ${path}`);
  };
  const adapter = createDiscordAdapter(settings.platforms.discord!, { JEO_DISCORD_BOT_TOKEN: "fake" }, { fetch: fetchImpl, WebSocket: FakeSocket as unknown as typeof WebSocket });
  const controller = new AbortController();
  let outcome: { error: unknown } | { stopped: true } | undefined;
  const running = adapter.start(async message => {
    delivered.push(message.text);
    handlerEntered.resolve();
    await handler.promise;
  }, controller.signal).then(() => { outcome = { stopped: true }; }, error => { outcome = { error }; });
  try {
    await socketReady.promise;
    socket!.receive({ op: 10, d: { heartbeat_interval: 300000 } });
    socket!.receive({ op: 0, t: "READY", s: 1, d: { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg" } });
    socket!.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { id: "101", channel_id: "parent", guild_id: "guild", author: { id: "owner" }, mentions: [{ id: "bot" }], content: "first" } });
    await handlerEntered.promise;
    handler.reject(new Error("private handler detail"));
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(outcome).toHaveProperty("error");
    if (outcome && "error" in outcome) {
      expect(String(outcome.error)).toMatch(/Discord.*(delivery|message|inbound)/i);
      expect(String(outcome.error)).not.toContain("private handler detail");
    }
    expect(delivered).toEqual(["first"]);
  } finally { controller.abort(); await running; }
});

for (const scenario of ["socket closes", "caller aborts"] as const) test(`Discord handles a late lookup failure after ${scenario}`, async () => {
  const socketReady = Promise.withResolvers<void>();
  const lookupStarted = Promise.withResolvers<void>();
  const reconnectScheduled = Promise.withResolvers<void>();
  const lookup = Promise.withResolvers<Response>();
  const delivered: string[] = [];
  let socket: FakeSocket;
  class FakeSocket extends EventTarget {
    constructor(_url: string) { super(); socket = this; socketReady.resolve(); }
    send(_value: string) {}
    close() {}
    receive(packet: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(packet) })); }
    disconnect() { this.dispatchEvent(Object.assign(new Event("close"), { code: 1006 })); }
  }
  const fetchImpl: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
    if (path.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
    if (path.endsWith("/channels/parent")) { lookupStarted.resolve(); return lookup.promise; }
    throw new Error(`Unexpected fake request: ${path}`);
  };
  const clock = { random: () => 0, schedule(_callback: () => void, delay: number) {
    if (delay === 5000) reconnectScheduled.resolve();
    return () => {};
  } };
  const adapter = createDiscordAdapter(settings.platforms.discord!, { JEO_DISCORD_BOT_TOKEN: "fake" }, { fetch: fetchImpl, WebSocket: FakeSocket as unknown as typeof WebSocket, clock });
  const controller = new AbortController();
  let outcome: { error: unknown } | { stopped: true } | undefined;
  const running = adapter.start(async message => { delivered.push(message.text); }, controller.signal).then(
    () => { outcome = { stopped: true }; }, error => { outcome = { error }; },
  );
  try {
    await socketReady.promise;
    socket!.receive({ op: 10, d: { heartbeat_interval: 300000 } });
    socket!.receive({ op: 0, t: "READY", s: 1, d: { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg" } });
    socket!.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { id: "101", channel_id: "parent", guild_id: "guild", author: { id: "owner" }, mentions: [{ id: "bot" }], content: "first" } });
    await lookupStarted.promise;
    if (scenario === "socket closes") { socket!.disconnect(); await reconnectScheduled.promise; }
    else { controller.abort(); await running; }
    lookup.reject(new Error("private network detail"));
    for (let i = 0; i < 100; i++) await Promise.resolve();
    if (scenario === "socket closes") {
      expect(outcome).toHaveProperty("error");
      if (outcome && "error" in outcome) expect(String(outcome.error)).toMatch(/Discord.*(delivery|message|inbound)/i);
    } else expect(outcome).toEqual({ stopped: true });
    expect(delivered).toEqual([]);
  } finally { controller.abort(); await running; }
});

test("Discord reports a thread lifecycle failure after the gateway disconnects", async () => {
  const socketReady = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  const lifecycleEntered = Promise.withResolvers<void>();
  const lifecycle = Promise.withResolvers<void>();
  const reconnectScheduled = Promise.withResolvers<void>();
  let socket: FakeSocket;
  class FakeSocket extends EventTarget {
    constructor(_url: string) { super(); socket = this; socketReady.resolve(); }
    send(_value: string) {}
    close() {}
    receive(packet: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(packet) })); }
    disconnect() { this.dispatchEvent(Object.assign(new Event("close"), { code: 1006 })); }
  }
  const fetchImpl: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
    if (path.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
    if (path.endsWith("/channels/thread")) return Response.json({ id: "thread", type: 11, parent_id: "parent", guild_id: "guild" });
    throw new Error(`Unexpected fake request: ${path}`);
  };
  const clock = { random: () => 0, schedule(_callback: () => void, delay: number) {
    if (delay === 5000) reconnectScheduled.resolve();
    return () => {};
  } };
  const adapter = createDiscordAdapter(settings.platforms.discord!, { JEO_DISCORD_BOT_TOKEN: "fake" }, { fetch: fetchImpl, WebSocket: FakeSocket as unknown as typeof WebSocket, clock });
  const controller = new AbortController();
  let outcome: { error: unknown } | { stopped: true } | undefined;
  const running = adapter.start(async () => { delivered.resolve(); }, controller.signal, async () => {
    lifecycleEntered.resolve();
    await lifecycle.promise;
  }).then(() => { outcome = { stopped: true }; }, error => { outcome = { error }; });
  try {
    await socketReady.promise;
    socket!.receive({ op: 10, d: { heartbeat_interval: 300000 } });
    socket!.receive({ op: 0, t: "READY", s: 1, d: { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg" } });
    socket!.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { id: "101", channel_id: "thread", guild_id: "guild", author: { id: "owner" }, mentions: [{ id: "bot" }], content: "first" } });
    await delivered.promise;
    socket!.receive({ op: 0, t: "THREAD_DELETE", s: 3, d: { id: "thread", parent_id: "parent", guild_id: "guild", type: 11 } });
    await lifecycleEntered.promise;
    socket!.disconnect();
    await reconnectScheduled.promise;
    lifecycle.reject(new Error("private lifecycle detail"));
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(outcome).toHaveProperty("error");
    if (outcome && "error" in outcome) {
      expect(String(outcome.error)).toMatch(/Discord.*lifecycle/i);
      expect(String(outcome.error)).not.toContain("private lifecycle detail");
    }
  } finally { controller.abort(); await running; }
});

for (const scenario of ["thread deletion", "caller cancellation", "unchanged thread update", "archive then unarchive"] as const) test(`Discord handles a recovered thread message after ${scenario}`, async () => {
  const socketReady = Promise.withResolvers<void>();
  const unarchiveEntered = Promise.withResolvers<void>();
  const unarchive = Promise.withResolvers<void>();
  const deletionHandled = Promise.withResolvers<void>();
  const archiveHandled = Promise.withResolvers<void>();
  const delivered: string[] = [];
  let socket: FakeSocket;
  class FakeSocket extends EventTarget {
    constructor(_url: string) { super(); socket = this; socketReady.resolve(); }
    send(_value: string) {}
    close() {}
    receive(packet: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(packet) })); }
  }
  const fetchImpl: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
    if (path.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
    if (path.endsWith("/channels/thread")) return Response.json({ id: "thread", type: 11, parent_id: "parent", guild_id: "guild", thread_metadata: { archived: false } });
    throw new Error(`Unexpected fake request: ${path}`);
  };
  const adapter = createDiscordAdapter(settings.platforms.discord!, { JEO_DISCORD_BOT_TOKEN: "fake" }, { fetch: fetchImpl, WebSocket: FakeSocket as unknown as typeof WebSocket });
  const controller = new AbortController();
  const running = adapter.start(async message => { delivered.push(message.text); }, controller.signal, async event => {
    if (event.kind === "unarchive") { unarchiveEntered.resolve(); await unarchive.promise; }
    if (event.kind === "delete") deletionHandled.resolve();
    if (event.kind === "archive") archiveHandled.resolve();
  });
  try {
    await socketReady.promise;
    socket!.receive({ op: 10, d: { heartbeat_interval: 300000 } });
    socket!.receive({ op: 0, t: "READY", s: 1, d: { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg" } });
    socket!.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { id: "101", channel_id: "thread", guild_id: "guild", author: { id: "owner" }, mentions: [{ id: "bot" }], content: "/cancel" } });
    await unarchiveEntered.promise;
    if (scenario === "thread deletion") {
      socket!.receive({ op: 0, t: "THREAD_DELETE", s: 3, d: { id: "thread", parent_id: "parent", guild_id: "guild", type: 11 } });
      await deletionHandled.promise;
    } else if (scenario === "caller cancellation") { controller.abort(); await running; }
    else if (scenario === "archive then unarchive") {
      socket!.receive({ op: 0, t: "THREAD_UPDATE", s: 3, d: { id: "thread", parent_id: "parent", guild_id: "guild", type: 11, thread_metadata: { archived: true } } });
      await archiveHandled.promise;
      socket!.receive({ op: 0, t: "THREAD_UPDATE", s: 4, d: { id: "thread", parent_id: "parent", guild_id: "guild", type: 11, thread_metadata: { archived: false } } });
    } else socket!.receive({ op: 0, t: "THREAD_UPDATE", s: 3, d: { id: "thread", parent_id: "parent", guild_id: "guild", type: 11, thread_metadata: { archived: false } } });
    unarchive.resolve();
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(delivered).toEqual(scenario === "unchanged thread update" ? ["/cancel"] : []);
  } finally { controller.abort(); unarchive.resolve(); await running; }
});

for (const scenario of ["unchanged", "archived", "deleted", "stale archived snapshot", "newer archived snapshot", "unmentioned follow-up", "missing freshness", "invalid freshness", "equal conflicting freshness", "same thread preparation"] as const) test(`Discord handles ${scenario} thread update during lookup`, async () => {
  const socketReady = Promise.withResolvers<void>();
  const firstDelivered = Promise.withResolvers<void>();
  const lookupStarted = Promise.withResolvers<void>();
  const lookup = Promise.withResolvers<Response>();
  const delivered: string[] = [];
  const lifecycle: string[] = [];
  let firstMessage: MessengerMessage | undefined;
  let socket: FakeSocket;
  class FakeSocket extends EventTarget {
    constructor(_url: string) { super(); socket = this; socketReady.resolve(); }
    send(_value: string) {}
    close() {}
    receive(packet: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(packet) })); }
  }
  let lookups = 0;
  const channel = { id: "thread", type: 11, parent_id: "parent", guild_id: "guild", owner_id: "bot", name: "Request 123" };
  const fetchImpl: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
    if (path.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
    if (path.endsWith("/channels/parent/messages/123")) return Response.json({ id: "123", channel_id: "parent", author: { id: "owner", bot: false } });
    if (path.endsWith("/channels/thread")) {
      if (++lookups === 2) { lookupStarted.resolve(); return lookup.promise; }
      return Response.json(channel);
    }
    throw new Error(`Unexpected fake request: ${path}`);
  };
  const adapter = createDiscordAdapter(settings.platforms.discord!, { JEO_DISCORD_BOT_TOKEN: "fake" }, { fetch: fetchImpl, WebSocket: FakeSocket as unknown as typeof WebSocket });
  const controller = new AbortController();
  let outcome: { error: unknown } | undefined;
  const running = adapter.start(async message => { firstMessage ??= message; delivered.push(message.text); firstDelivered.resolve(); }, controller.signal, async event => { lifecycle.push(event.kind); }).catch(error => { outcome = { error }; });
  const update = (sequence: number) => socket!.receive({ op: 0, t: "THREAD_UPDATE", s: sequence, d: { id: "thread", parent_id: "parent", guild_id: "guild", type: 11, thread_metadata: { archived: false, archive_timestamp: scenario === "stale archived snapshot" ? "2025-01-01T00:00:10.000Z" : "2025-01-01T00:00:00.000Z" } } });
  const message = (sequence: number, text: string) => socket!.receive({ op: 0, t: "MESSAGE_CREATE", s: sequence, d: { id: String(sequence), channel_id: "thread", guild_id: "guild", author: { id: "owner" }, mentions: sequence === 4 && scenario === "unmentioned follow-up" ? [] : [{ id: "bot" }], content: text } });
  try {
    await socketReady.promise;
    socket!.receive({ op: 10, d: { heartbeat_interval: 300000 } });
    socket!.receive({ op: 0, t: "READY", s: 1, d: { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg" } });
    message(2, "first");
    await firstDelivered.promise;
    update(3);
    message(4, "second");
    await lookupStarted.promise;
    if (scenario === "same thread preparation") await adapter.prepare!(firstMessage!);
    else if (!["archived", "deleted"].includes(scenario)) update(5);
    else socket!.receive({ op: 0, t: scenario === "deleted" ? "THREAD_DELETE" : "THREAD_UPDATE", s: 5, d: { id: "thread", parent_id: "parent", guild_id: "guild", type: 11, thread_metadata: { archived: true } } });
    const conflicting = ["stale archived snapshot", "newer archived snapshot", "missing freshness", "invalid freshness", "equal conflicting freshness"].includes(scenario);
    const archiveTimestamp = scenario === "missing freshness" ? undefined : scenario === "invalid freshness" ? "invalid" : scenario === "newer archived snapshot" ? "2025-01-01T00:00:10.000Z" : "2025-01-01T00:00:00.000Z";
    lookup.resolve(Response.json(conflicting ? { ...channel, thread_metadata: { archived: true, archive_timestamp: archiveTimestamp } } : channel));
    for (let i = 0; i < 100; i++) await Promise.resolve();
    if (scenario === "stale archived snapshot") expect(lifecycle).not.toContain("archive");
    else if (scenario === "newer archived snapshot") { expect(lifecycle).toContain("archive"); expect(delivered).toEqual(["first"]); }
    else if (["missing freshness", "invalid freshness", "equal conflicting freshness"].includes(scenario)) { expect(outcome).toHaveProperty("error"); expect(delivered).toEqual(["first"]); }
    else if (scenario === "unmentioned follow-up" && outcome) { expect(String(outcome.error)).toMatch(/Discord.*(delivery|message|inbound)/i); expect(delivered).toEqual(["first"]); }
    else expect(delivered).toEqual(["unchanged", "unmentioned follow-up", "same thread preparation"].includes(scenario) ? ["first", "second"] : ["first"]);
  } finally { controller.abort(); await running; }
});

for (const closeCode of [1006, 4009]) test(`Discord ${closeCode === 1006 ? "resumes" : "identifies"} after a failed resume handshake with close ${closeCode}`, async () => {
  const sockets: FakeSocket[] = [];
  const timers: Array<() => void> = [];
  class FakeSocket extends EventTarget {
    sent: Array<{ op: number; d: unknown }> = [];
    constructor(_url: string) { super(); sockets.push(this); }
    send(value: string) { this.sent.push(JSON.parse(value)); }
    close() {}
    receive(packet: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(packet) })); }
    disconnect(code: number) { this.dispatchEvent(Object.assign(new Event("close"), { code })); }
  }
  const fetchImpl: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
    if (path.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
    throw new Error(`Unexpected fake request: ${path}`);
  };
  const clock = { random: () => 0, schedule(callback: () => void, delay: number) {
    if (delay === 5000 || delay === 10000) timers.push(callback);
    return () => {};
  } };
  const adapter = createDiscordAdapter(settings.platforms.discord!, { JEO_DISCORD_BOT_TOKEN: "fake" }, { fetch: fetchImpl, WebSocket: FakeSocket as unknown as typeof WebSocket, clock });
  const controller = new AbortController();
  const running = adapter.start(async () => {}, controller.signal);
  const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  try {
    await flush();
    expect(sockets.length).toBe(1);
    sockets[0]!.receive({ op: 10, d: { heartbeat_interval: 300000 } });
    sockets[0]!.receive({ op: 0, t: "READY", s: 42, d: { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg" } });
    sockets[0]!.disconnect(1006);
    await flush();
    expect(timers.length).toBe(1);
    timers.shift()!();
    await flush();
    expect(sockets.length).toBe(2);
    sockets[1]!.receive({ op: 10, d: { heartbeat_interval: 300000 } });
    expect(sockets[1]!.sent).toContainEqual({ op: 6, d: { token: "fake", session_id: "session", seq: 42 } });
    sockets[1]!.disconnect(closeCode);
    await flush();
    expect(timers.length).toBe(1);
    timers.shift()!();
    await flush();
    expect(sockets.length).toBe(3);
    sockets[2]!.receive({ op: 10, d: { heartbeat_interval: 300000 } });
    if (closeCode === 1006) expect(sockets[2]!.sent).toContainEqual({ op: 6, d: { token: "fake", session_id: "session", seq: 42 } });
    else expect(sockets[2]!.sent.map(packet => packet.op)).toEqual([2]);
  } finally { controller.abort(); await running; }
});

for (const contract of ["message", "deletion"] as const) test(`Discord processes replayed ${contract} before RESUMED`, async () => {
  const sockets: FakeSocket[] = [];
  const timers: Array<() => void> = [];
  const delivered: string[] = [];
  const lifecycle: string[] = [];
  class FakeSocket extends EventTarget {
    sent: Array<{ op: number; d: unknown }> = [];
    constructor(_url: string) { super(); sockets.push(this); }
    send(value: string) { this.sent.push(JSON.parse(value)); }
    close() {}
    receive(packet: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(packet) })); }
    disconnect() { this.dispatchEvent(Object.assign(new Event("close"), { code: 1006 })); }
  }
  const fetchImpl: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
    if (path.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
    if (path.endsWith("/channels/thread")) return Response.json({ id: "thread", type: 11, parent_id: "parent", guild_id: "guild" });
    throw new Error(`Unexpected fake request: ${path}`);
  };
  const clock = { random: () => 0, schedule(callback: () => void, delay: number) {
    if (delay === 5000 || delay === 10000) timers.push(callback);
    return () => {};
  } };
  const adapter = createDiscordAdapter(settings.platforms.discord!, { JEO_DISCORD_BOT_TOKEN: "fake" }, { fetch: fetchImpl, WebSocket: FakeSocket as unknown as typeof WebSocket, clock });
  const controller = new AbortController();
  const running = adapter.start(async message => { delivered.push(message.text); }, controller.signal, async event => { lifecycle.push(event.kind); });
  const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  const message = (socket: FakeSocket, sequence: number, text: string) => socket.receive({ op: 0, t: "MESSAGE_CREATE", s: sequence, d: { id: String(sequence), channel_id: "thread", guild_id: "guild", author: { id: "owner" }, mentions: [{ id: "bot" }], content: text } });
  try {
    await flush();
    sockets[0]!.receive({ op: 10, d: { heartbeat_interval: 300000 } });
    sockets[0]!.receive({ op: 0, t: "READY", s: 1, d: { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg" } });
    message(sockets[0]!, 2, "first");
    await flush();
    expect(delivered).toEqual(["first"]);
    sockets[0]!.disconnect();
    await flush();
    timers.shift()!();
    await flush();
    sockets[1]!.receive({ op: 10, d: { heartbeat_interval: 300000 } });
    expect(sockets[1]!.sent).toContainEqual({ op: 6, d: { token: "fake", session_id: "session", seq: 2 } });
    message(sockets[1]!, 3, "replayed");
    await flush();
    sockets[1]!.receive({ op: 0, t: "THREAD_DELETE", s: 4, d: { id: "thread", parent_id: "parent", guild_id: "guild", type: 11 } });
    await flush();
    sockets[1]!.receive({ op: 0, t: "RESUMED", s: 5, d: {} });
    if (contract === "message") expect(delivered).toEqual(["first", "replayed"]);
    else expect(lifecycle).toEqual(["delete"]);
    sockets[1]!.disconnect();
    await flush();
    timers.shift()!();
    await flush();
    sockets[2]!.receive({ op: 10, d: { heartbeat_interval: 300000 } });
    expect(sockets[2]!.sent).toContainEqual({ op: 6, d: { token: "fake", session_id: "session", seq: 5 } });
  } finally { controller.abort(); await running; }
});

for (const scenario of ["known archived", "known archived without timestamp", "unknown active update"] as const) test(`Discord handles ${scenario} before channel lookup completes`, async () => {
  const socketReady = Promise.withResolvers<void>();
  const firstDelivered = Promise.withResolvers<void>();
  const lookupStarted = Promise.withResolvers<void>();
  const lookup = Promise.withResolvers<Response>();
  const delivered: string[] = [];
  const lifecycle: string[] = [];
  let outcome: { error: unknown } | undefined;
  let socket: FakeSocket;
  class FakeSocket extends EventTarget {
    constructor(_url: string) { super(); socket = this; socketReady.resolve(); }
    send(_value: string) {}
    close() {}
    receive(packet: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(packet) })); }
  }
  let lookups = 0;
  const channel = { id: "thread", type: 11, parent_id: "parent", guild_id: "guild", thread_metadata: { archived: false, archive_timestamp: "2025-01-01T00:00:00.000Z" } };
  const fetchImpl: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
    if (path.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
    if (path.endsWith("/channels/thread")) {
      if (scenario === "unknown active update" || ++lookups === 2) { lookupStarted.resolve(); return lookup.promise; }
      return Response.json(channel);
    }
    throw new Error(`Unexpected fake request: ${path}`);
  };
  const adapter = createDiscordAdapter(settings.platforms.discord!, { JEO_DISCORD_BOT_TOKEN: "fake" }, { fetch: fetchImpl, WebSocket: FakeSocket as unknown as typeof WebSocket });
  const controller = new AbortController();
  const running = adapter.start(async message => { delivered.push(message.text); firstDelivered.resolve(); }, controller.signal, async event => { lifecycle.push(event.kind); }).catch(error => { outcome = { error }; });
  const message = (sequence: number, text: string) => socket!.receive({ op: 0, t: "MESSAGE_CREATE", s: sequence, d: { id: String(sequence), channel_id: "thread", guild_id: "guild", author: { id: "owner" }, mentions: [{ id: "bot" }], content: text } });
  const update = (sequence: number, archived: boolean) => socket!.receive({ op: 0, t: "THREAD_UPDATE", s: sequence, d: { id: "thread", parent_id: "parent", guild_id: "guild", type: 11, thread_metadata: { archived, ...(scenario === "known archived without timestamp" ? {} : { archive_timestamp: "2025-01-01T00:00:10.000Z" }) } } });
  try {
    await socketReady.promise;
    socket!.receive({ op: 10, d: { heartbeat_interval: 300000 } });
    socket!.receive({ op: 0, t: "READY", s: 1, d: { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg" } });
    if (scenario !== "unknown active update") { message(2, "first"); await firstDelivered.promise; update(3, true); message(4, "second"); }
    else message(2, "second");
    await lookupStarted.promise;
    if (scenario === "unknown active update") update(3, false);
    lookup.resolve(Response.json(scenario === "known archived without timestamp" ? { ...channel, thread_metadata: { archived: false, archive_timestamp: "2025-01-01T00:00:05.000Z" } } : channel));
    for (let i = 0; i < 100; i++) await Promise.resolve();
    if (scenario !== "unknown active update") {
      expect(delivered).toEqual(["first"]);
      expect(lifecycle).toEqual(["unarchive", "archive"]);
    } else if (outcome) {
      expect(String(outcome.error)).toMatch(/Discord.*(delivery|message|inbound)/i);
      expect(delivered).toEqual([]);
    } else expect(delivered).toEqual(["second"]);
  } finally { controller.abort(); await running; }
});

for (const source of ["REST", "gateway"] as const) test(`Discord does not reopen a thread from older ${source} state after an accepted archive`, async () => {
  const socketReady = Promise.withResolvers<void>();
  const firstDelivered = Promise.withResolvers<void>();
  const archived = Promise.withResolvers<void>();
  const delivered: string[] = [];
  const lifecycle: string[] = [];
  let socket: FakeSocket;
  class FakeSocket extends EventTarget {
    constructor(_url: string) { super(); socket = this; socketReady.resolve(); }
    send(_value: string) {}
    close() {}
    receive(packet: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(packet) })); }
  }
  let lookups = 0;
  const fetchImpl: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
    if (path.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
    if (path.endsWith("/channels/thread")) {
      lookups++;
      return Response.json({ id: "thread", type: 11, parent_id: "parent", guild_id: "guild", thread_metadata: {
        archived: lookups === 2, archive_timestamp: lookups === 2 ? "2025-01-01T00:00:30.000Z" : lookups === 3 ? "2025-01-01T00:00:20.000Z" : "2025-01-01T00:00:10.000Z" } });
    }
    throw new Error(`Unexpected fake request: ${path}`);
  };
  const adapter = createDiscordAdapter(settings.platforms.discord!, { JEO_DISCORD_BOT_TOKEN: "fake" }, { fetch: fetchImpl, WebSocket: FakeSocket as unknown as typeof WebSocket });
  const controller = new AbortController();
  const running = adapter.start(async message => { delivered.push(message.text); firstDelivered.resolve(); }, controller.signal, async event => {
    lifecycle.push(event.kind);
    if (event.kind === "archive") archived.resolve();
  });
  const message = (sequence: number, text: string) => socket!.receive({ op: 0, t: "MESSAGE_CREATE", s: sequence, d: { id: String(sequence), channel_id: "thread", guild_id: "guild", author: { id: "owner" }, mentions: [{ id: "bot" }], content: text } });
  try {
    await socketReady.promise;
    socket!.receive({ op: 10, d: { heartbeat_interval: 300000 } });
    socket!.receive({ op: 0, t: "READY", s: 1, d: { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg" } });
    message(2, "first");
    await firstDelivered.promise;
    socket!.receive({ op: 0, t: "THREAD_UPDATE", s: 3, d: { id: "thread", parent_id: "parent", guild_id: "guild", type: 11, thread_metadata: { archived: false, archive_timestamp: "2025-01-01T00:00:10.000Z" } } });
    message(4, "second");
    await archived.promise;
    if (source === "gateway") socket!.receive({ op: 0, t: "THREAD_UPDATE", s: 5, d: { id: "thread", parent_id: "parent", guild_id: "guild", type: 11, thread_metadata: { archived: false, archive_timestamp: "2025-01-01T00:00:20.000Z" } } });
    message(6, "third");
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(delivered).toEqual(["first"]);
    expect(lifecycle).toEqual(["unarchive", "archive"]);
  } finally { controller.abort(); await running; }
});

test("Discord ignores stale archive events while preparing a known active thread", async () => {
  const socketReady = Promise.withResolvers<void>();
  const firstDelivered = Promise.withResolvers<MessengerMessage>();
  const lookupStarted = Promise.withResolvers<void>();
  const lookup = Promise.withResolvers<Response>();
  let socket: FakeSocket;
  class FakeSocket extends EventTarget {
    constructor(_url: string) { super(); socket = this; socketReady.resolve(); }
    send(_value: string) {}
    close() {}
    receive(packet: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(packet) })); }
  }
  let lookups = 0;
  const channel = { id: "thread", type: 11, parent_id: "parent", guild_id: "guild", thread_metadata: { archived: false, archive_timestamp: "2025-01-01T00:00:10.000Z" } };
  const fetchImpl: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
    if (path.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
    if (path.endsWith("/channels/thread")) {
      if (++lookups === 2) { lookupStarted.resolve(); return lookup.promise; }
      return Response.json(channel);
    }
    throw new Error(`Unexpected fake request: ${path}`);
  };
  const adapter = createDiscordAdapter(settings.platforms.discord!, { JEO_DISCORD_BOT_TOKEN: "fake" }, { fetch: fetchImpl, WebSocket: FakeSocket as unknown as typeof WebSocket });
  const controller = new AbortController();
  const running = adapter.start(async message => { firstDelivered.resolve(message); }, controller.signal);
  try {
    await socketReady.promise;
    socket!.receive({ op: 10, d: { heartbeat_interval: 300000 } });
    socket!.receive({ op: 0, t: "READY", s: 1, d: { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg" } });
    socket!.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { id: "101", channel_id: "thread", guild_id: "guild", author: { id: "owner" }, mentions: [{ id: "bot" }], content: "first" } });
    const first = await firstDelivered.promise;
    const { threadId: _threadId, parentChannelId: _parentChannelId, ...raw } = first;
    const prepared = adapter.prepare!(raw);
    await lookupStarted.promise;
    socket!.receive({ op: 0, t: "THREAD_UPDATE", s: 3, d: { id: "thread", parent_id: "parent", guild_id: "guild", type: 11, thread_metadata: { archived: true, archive_timestamp: "2025-01-01T00:00:00.000Z" } } });
    lookup.resolve(Response.json(channel));
    expect(await prepared).toMatchObject({ threadId: "thread", parentChannelId: "parent", text: "first" });
  } finally { controller.abort(); await running; }
});

test("Discord does not re-anchor an unversioned archive from an older same-state snapshot", async () => {
  const socketReady = Promise.withResolvers<void>();
  const firstDelivered = Promise.withResolvers<void>();
  const secondRead = Promise.withResolvers<void>();
  const delivered: string[] = [];
  const lifecycle: string[] = [];
  let socket: FakeSocket;
  class FakeSocket extends EventTarget {
    constructor(_url: string) { super(); socket = this; socketReady.resolve(); }
    send(_value: string) {}
    close() {}
    receive(packet: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(packet) })); }
  }
  let lookups = 0;
  const fetchImpl: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
    if (path.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
    if (path.endsWith("/channels/thread")) {
      lookups++;
      if (lookups === 2) secondRead.resolve();
      return Response.json({ id: "thread", type: 11, parent_id: "parent", guild_id: "guild", thread_metadata: {
        archived: lookups === 2, archive_timestamp: lookups === 3 ? "2025-01-01T00:00:05.000Z" : "2025-01-01T00:00:00.000Z" } });
    }
    throw new Error(`Unexpected fake request: ${path}`);
  };
  const adapter = createDiscordAdapter(settings.platforms.discord!, { JEO_DISCORD_BOT_TOKEN: "fake" }, { fetch: fetchImpl, WebSocket: FakeSocket as unknown as typeof WebSocket });
  const controller = new AbortController();
  const running = adapter.start(async message => { delivered.push(message.text); firstDelivered.resolve(); }, controller.signal, async event => { lifecycle.push(event.kind); }).catch(() => {});
  const message = (sequence: number, text: string) => socket!.receive({ op: 0, t: "MESSAGE_CREATE", s: sequence, d: { id: String(sequence), channel_id: "thread", guild_id: "guild", author: { id: "owner" }, mentions: [{ id: "bot" }], content: text } });
  try {
    await socketReady.promise;
    socket!.receive({ op: 10, d: { heartbeat_interval: 300000 } });
    socket!.receive({ op: 0, t: "READY", s: 1, d: { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg" } });
    message(2, "first");
    await firstDelivered.promise;
    socket!.receive({ op: 0, t: "THREAD_UPDATE", s: 3, d: { id: "thread", parent_id: "parent", guild_id: "guild", type: 11, thread_metadata: { archived: true } } });
    message(4, "second");
    await secondRead.promise;
    for (let i = 0; i < 100; i++) await Promise.resolve();
    message(5, "third");
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(delivered).toEqual(["first"]);
    expect(lifecycle.slice(1)).not.toContain("unarchive");
  } finally { controller.abort(); await running; }
});

test("Discord messenger resets reconnect backoff to 5s after an established READY session", async () => {
  const delays: number[] = [];
  let attempt = 0;
  let socket: FakeSocket | undefined;
  const thirdAttemptReady = Promise.withResolvers<void>();
  const fourthAttemptStarted = Promise.withResolvers<void>();
  class FakeSocket extends EventTarget {
    constructor(_url: string) {
      super();
      socket = this;
      attempt++;
      if (attempt === 1 || attempt === 2) {
        queueMicrotask(() => {
          const event = new Event("close");
          Object.defineProperty(event, "code", { value: 1006 });
          this.dispatchEvent(event);
        });
      } else if (attempt === 3) {
        thirdAttemptReady.resolve();
      } else if (attempt === 4) {
        fourthAttemptStarted.resolve();
      }
    }
    send(_value: string) {}
    close() {}
    receive(packet: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(packet) })); }
  }
  const clock = {
    schedule(cb: () => void, delayMs: number) {
      if (delayMs === 5_000 || delayMs === 10_000 || delayMs === 20_000 || delayMs === 30_000) {
        delays.push(delayMs);
        queueMicrotask(cb);
      }
      return () => {};
    },
    random: () => 0.5,
  };
  const fetchImpl: typeof fetch = async input => {
    const p = new URL(String(input)).pathname;
    if (p.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
    if (p.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
    return new Response(null, { status: 404 });
  };
  const adapter = createDiscordAdapter(settings.platforms.discord!, { JEO_DISCORD_BOT_TOKEN: "fake" }, { fetch: fetchImpl, WebSocket: FakeSocket as unknown as typeof WebSocket, clock });
  const controller = new AbortController();
  const running = adapter.start(async () => {}, controller.signal);
  try {
    await thirdAttemptReady.promise;
    socket!.receive({ op: 10, d: { heartbeat_interval: 300000 } });
    socket!.receive({ op: 0, t: "READY", s: 1, d: { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg" } });
    const ev = new Event("close");
    Object.defineProperty(ev, "code", { value: 1006 });
    socket!.dispatchEvent(ev);
    await fourthAttemptStarted.promise;
    expect(delays).toEqual([5_000, 10_000, 5_000]);
  } finally { controller.abort(); await running; }
});
test("Discord adapter skips REST lookups for non-allowlisted users and redacts bot token on send", async () => {
  const socketReady = Promise.withResolvers<void>();
  const delivered: MessengerMessage[] = [];
  const postedBodies: string[] = [];
  const restPaths: string[] = [];
  let socket: FakeSocket;
  class FakeSocket extends EventTarget {
    constructor(_url: string) { super(); socket = this; socketReady.resolve(); }
    send(_value: string) {}
    close() {}
    receive(packet: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(packet) })); }
  }
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    restPaths.push(url.pathname);
    if (url.pathname.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
    if (url.pathname.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
    if (url.pathname.endsWith("/channels/parent/messages") && init?.method === "POST") {
      postedBodies.push(String(init.body ?? ""));
      return Response.json({ id: "sent-1" });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  const adapter = createDiscordAdapter(
    { tokenEnv: "JEO_DISCORD_BOT_TOKEN", allowedUserIds: ["owner"], allowedChannelIds: ["parent"] },
    { JEO_DISCORD_BOT_TOKEN: "super-secret-bot-token" },
    { fetch: fetchImpl, WebSocket: FakeSocket as unknown as typeof WebSocket },
  );
  const controller = new AbortController();
  const running = adapter.start(async message => {
    if (isMessengerMessageAllowed(message, settings)) delivered.push(message);
  }, controller.signal);
  try {
    await socketReady.promise;
    socket!.receive({ op: 10, d: { heartbeat_interval: 300000 } });
    socket!.receive({ op: 0, t: "READY", s: 1, d: { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg" } });
    // Unauthorized user in DM or guild channel triggers no channel REST lookup and is rejected by gateway admission.
    socket!.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { id: "m1", channel_id: "dm", author: { id: "stranger" }, content: "hi" } });
    socket!.receive({ op: 0, t: "MESSAGE_CREATE", s: 3, d: { id: "m2", channel_id: "parent", guild_id: "guild", author: { id: "stranger" }, mentions: [{ id: "bot" }], content: "<@bot> hi" } });
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(delivered).toEqual([]);
    expect(restPaths.filter(p => p.includes("/channels/"))).toEqual([]);
    await adapter.send(
      { platform: "discord", accountId: "bot", channelId: "parent", senderId: "owner", messageId: "m3", text: "hi", direct: false, mentioned: true },
      "token is super-secret-bot-token!",
    );
    expect(postedBodies).toHaveLength(1);
    expect(postedBodies[0]).not.toContain("super-secret-bot-token");
    expect(postedBodies[0]).toContain("[REDACTED_TOKEN]");
  } finally { controller.abort(); await running; }
});

test("Discord deps.onError isolates transient deliver() and handler errors while keeping 401 fatal", async () => {
  const socketReady = Promise.withResolvers<void>();
  const secondDelivered = Promise.withResolvers<void>();
  const delivered: string[] = [];
  const errors: string[] = [];
  let socket: FakeSocket;
  class FakeSocket extends EventTarget {
    constructor(_url: string) { super(); socket = this; socketReady.resolve(); }
    send(_value: string) {}
    close() {}
    receive(packet: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(packet) })); }
  }
  let parentCalls = 0;
  const fetchImpl: typeof fetch = async input => {
    const p = new URL(String(input)).pathname;
    if (p.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
    if (p.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
    if (p.endsWith("/channels/parent")) {
      parentCalls++;
      if (parentCalls === 1) return new Response(null, { status: 503 });
      if (parentCalls === 2) return Response.json({ id: "parent", type: 0 });
      return Response.json({ id: "parent", type: 0 });
    }
    if (p.endsWith("/channels/fatal")) return new Response(null, { status: 401 });
    throw new Error(`Unexpected fake request: ${p}`);
  };
  let handlerCalls = 0;
  const adapter = createDiscordAdapter(
    settings.platforms.discord!,
    { JEO_DISCORD_BOT_TOKEN: "secret-discord-token" },
    { fetch: fetchImpl, WebSocket: FakeSocket as unknown as typeof WebSocket, onError: msg => errors.push(msg) },
  );
  const controller = new AbortController();
  let outcome: { error: unknown } | { stopped: true } | undefined;
  const running = adapter.start(async message => {
    handlerCalls++;
    if (handlerCalls === 1) throw new Error("handler failed with secret-discord-token");
    delivered.push(message.text);
    secondDelivered.resolve();
  }, controller.signal).then(() => { outcome = { stopped: true }; }, error => { outcome = { error }; });
  try {
    await socketReady.promise;
    socket!.receive({ op: 10, d: { heartbeat_interval: 300000 } });
    socket!.receive({ op: 0, t: "READY", s: 1, d: { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg" } });

    // Transient REST 503 during deliver() is isolated via deps.onError.
    socket!.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { id: "m1", channel_id: "parent", guild_id: "guild", author: { id: "owner" }, mentions: [{ id: "bot" }], content: "rest-503" } });
    for (let i = 0; i < 60; i++) await Promise.resolve();

    // Handler throw during deliver() is also isolated without leaking secrets or crashing gateway.
    socket!.receive({ op: 0, t: "MESSAGE_CREATE", s: 3, d: { id: "m2", channel_id: "parent", guild_id: "guild", author: { id: "owner" }, mentions: [{ id: "bot" }], content: "handler-throw" } });
    for (let i = 0; i < 60; i++) await Promise.resolve();

    // Subsequent valid message still delivers on the same gateway connection.
    socket!.receive({ op: 0, t: "MESSAGE_CREATE", s: 4, d: { id: "m3", channel_id: "parent", guild_id: "guild", author: { id: "owner" }, mentions: [{ id: "bot" }], content: "healthy" } });
    await secondDelivered.promise;
    expect(outcome).toBeUndefined();
    expect(delivered).toEqual(["healthy"]);
    expect(errors).toEqual([
      "Discord message delivery failed (HTTP 503)",
      "Discord message delivery failed",
    ]);

    // 401 in deliver() remains fatal even when deps.onError is provided.
    socket!.receive({ op: 0, t: "MESSAGE_CREATE", s: 5, d: { id: "m4", channel_id: "fatal", guild_id: "guild", author: { id: "owner" }, mentions: [{ id: "bot" }], content: "auth-fail" } });
    await running;
    expect(outcome).toHaveProperty("error");
    if (outcome && "error" in outcome) {
      expect(String(outcome.error)).toMatch(/Discord authentication failed \(HTTP 401\)/);
    }
  } finally { controller.abort(); await running; }
});

test("Discord deps.onError isolates connectGateway() / REST discovery errors while 401 and 403 remain fatal", async () => {
  // Transient 503 during connection setup is reported via deps.onError and retries.
  const delivered = Promise.withResolvers<string>();
  const errors: string[] = [];
  let gatewayAttempts = 0;
  class FakeSocket extends EventTarget {
    constructor(_url: string) {
      super();
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 300000 } }) }));
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ op: 0, t: "READY", s: 1, d: { session_id: "s1", resume_gateway_url: "wss://gateway.discord.gg" } }) }));
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { id: "m1", channel_id: "dm", author: { id: "owner" }, content: "recovered" } }) }));
      });
    }
    send(_value: string) {}
    close() {}
  }
  const clock = {
    random: () => 0,
    schedule(cb: () => void, _delay: number) {
      queueMicrotask(cb);
      return () => {};
    },
  };
  const adapter = createDiscordAdapter(
    settings.platforms.discord!,
    { JEO_DISCORD_BOT_TOKEN: "fake" },
    {
      clock,
      WebSocket: FakeSocket as unknown as typeof WebSocket,
      onError: msg => {
        errors.push(msg);
        throw new Error("operator log sink threw");
      },
      fetch: async input => {
        const p = new URL(String(input)).pathname;
        if (p.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
        if (p.endsWith("/gateway/bot")) {
          gatewayAttempts++;
          if (gatewayAttempts === 1) return new Response(null, { status: 503 });
          return Response.json({ url: "wss://gateway.discord.gg" });
        }
        throw new Error(`Unexpected fake request: ${p}`);
      },
    },
  );
  const controller = new AbortController();
  const running = adapter.start(async msg => { delivered.resolve(msg.text); }, controller.signal);
  try {
    expect(await delivered.promise).toBe("recovered");
    expect(errors).toEqual(["Discord connection failed (HTTP 503)"]);
  } finally { controller.abort(); await running; }

  // Fatal 401 and 403 on discovery reject immediately even with deps.onError.
  for (const status of [401, 403] as const) {
    const fatalErrors: string[] = [];
    let scheduled = 0;
    const fatalAdapter = createDiscordAdapter(
      settings.platforms.discord!,
      { JEO_DISCORD_BOT_TOKEN: "fake" },
      {
        clock: { random: () => 0, schedule: () => { scheduled++; return () => {}; } },
        WebSocket: FakeSocket as unknown as typeof WebSocket,
        onError: msg => fatalErrors.push(msg),
        fetch: async input => {
          const p = new URL(String(input)).pathname;
          if (p.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
          if (p.endsWith("/gateway/bot")) return new Response(null, { status });
          return new Response(null, { status: 404 });
        },
      },
    );
    await expect(fatalAdapter.start(async () => {}, new AbortController().signal)).rejects.toThrow(`HTTP ${status}`);
    expect(fatalErrors).toEqual([]);
    expect(scheduled).toBe(0);
  }
});

test("Discord activityMessages entry is deleted in finally even when final PATCH fails", async () => {
  const requests: Array<{ method: string; path: string }> = [];
  let patchMode: "fail-500" | "fail-404" | "ok" = "fail-500";
  let createdSeq = 0;
  const adapter = createDiscordAdapter(
    settings.platforms.discord!,
    { JEO_DISCORD_BOT_TOKEN: "fake" },
    {
      fetch: async (input, init) => {
        const p = new URL(String(input)).pathname;
        const method = init?.method ?? "GET";
        requests.push({ method, path: p });
        if (method === "POST" && p.endsWith("/channels/parent/messages")) {
          return Response.json({ id: `act-${++createdSeq}` });
        }
        if (method === "PATCH") {
          if (patchMode === "fail-500") return new Response(null, { status: 500 });
          if (patchMode === "fail-404") return new Response(null, { status: 404 });
          return Response.json({ id: p.split("/").at(-1) });
        }
        return new Response(null, { status: 404 });
      },
    },
  );
  const msg: MessengerMessage = {
    platform: "discord", accountId: "bot", channelId: "parent", senderId: "owner", messageId: "m1", text: "hi", direct: false, mentioned: true,
  };

  await adapter.activity!(msg, "Working");
  await expect(adapter.activity!(msg, undefined, undefined, "failure")).rejects.toThrow();

  // Because finally deleted the key, a follow-up finalize is a no-op and a new activity creates via POST.
  requests.length = 0;
  await adapter.activity!(msg, undefined);
  expect(requests).toEqual([]);

  await adapter.activity!(msg, "Retrying");
  expect(requests).toEqual([{ method: "POST", path: "/api/v10/channels/parent/messages" }]);

  // 404 on finalize also resolves without throwing and deletes the stale key.
  patchMode = "fail-404";
  await adapter.activity!(msg, undefined);
  requests.length = 0;
  await adapter.activity!(msg, "After 404");
  expect(requests).toEqual([{ method: "POST", path: "/api/v10/channels/parent/messages" }]);
});

test("Discord activityMessages enforces bounded 10,000-entry LRU eviction", async () => {
  const requests: Array<{ method: string; path: string }> = [];
  let recording = false;
  let nextId = 0;
  const adapter = createDiscordAdapter(
    settings.platforms.discord!,
    { JEO_DISCORD_BOT_TOKEN: "fake" },
    {
      fetch: async (input, init) => {
        const p = new URL(String(input)).pathname;
        const method = init?.method ?? "GET";
        if (recording) requests.push({ method, path: p });
        if (method === "POST") return Response.json({ id: `act-${nextId++}` });
        return Response.json({ id: p.split("/").at(-1) });
      },
    },
  );
  const makeMsg = (i: number): MessengerMessage => ({
    platform: "discord", accountId: "bot", channelId: "parent", senderId: "owner", messageId: `m-${i}`, text: "hi", direct: false, mentioned: true,
  });

  for (let i = 0; i < 10_000; i++) {
    await adapter.activity!(makeMsg(i), "step 1");
  }
  // Touch m-0 via PATCH so it moves to MRU, leaving m-1 as the oldest entry.
  await adapter.activity!(makeMsg(0), "step 2");
  // Insert the 10,001st distinct key, evicting m-1.
  await adapter.activity!(makeMsg(10_000), "step 1");

  recording = true;
  await adapter.activity!(makeMsg(0), "step 3");
  await adapter.activity!(makeMsg(1), "step 2");
  expect(requests).toEqual([
    { method: "PATCH", path: "/api/v10/channels/parent/messages/act-0" },
    { method: "POST", path: "/api/v10/channels/parent/messages" },
  ]);
});