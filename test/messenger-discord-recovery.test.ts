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
