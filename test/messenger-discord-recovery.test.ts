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
