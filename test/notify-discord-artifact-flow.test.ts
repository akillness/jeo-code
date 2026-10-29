import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DiscordDaemon } from "../src/agent/notify/discord-daemon";
import { resolveDiscordArtifactStage } from "../src/agent/notify/discord-artifacts";

const CHANNEL = "111111111111111111";
const USER = "222222222222222222";
const BOT = "333333333333333333";
const THREAD = "444444444444444444";

test("only an authorized session result delivers its real staged bytes to the originating reply thread", async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-artifact-flow-"));
  const previous = process.env.JEO_CONFIG_DIR;
  process.env.JEO_CONFIG_DIR = configDir;
  const uploads: { channel: string; name: string; data: Uint8Array }[] = [];
  const messages: string[] = [];
  let allowArtifacts = true;
  let gateway: Socket;
  let local: Socket;
  let sequence = 0;
  class Socket {
    readyState = 1;
    onmessage: ((event: { data: string }) => void | Promise<void>) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(url: string) { if (url.startsWith("wss:")) gateway = this; else local = this; }
    send(raw: string) {
      const frame = JSON.parse(raw);
      if (frame.type === "remote_request") queueMicrotask(async () => {
        const stage = await resolveDiscordArtifactStage(frame.sessionId, frame.reqId);
        await fs.writeFile(path.join(stage.output, "result.txt"), `output for ${frame.text}`);
        await this.receive({ type: "ack", reqId: frame.reqId, ok: true });
        await this.receive({ type: "remote_final", sessionId: frame.sessionId, reqId: frame.reqId, ok: true, text: `saved ${stage.output}/result.txt`, artifactsAllowed: allowArtifacts, controlGeneration: frame.controlGeneration });
      });
    }
    close() { this.readyState = 3; this.onclose?.(); }
    async receive(frame: unknown) { await this.onmessage?.({ data: JSON.stringify(frame) }); }
  }
  const api = {
    async getMe() { return { id: BOT, username: "bot", bot: true }; },
    async getChannel(id: string) { return { id, type: 0 }; },
    async getGatewayBot() { return { url: "wss://gateway.discord.gg", session_start_limit: { remaining: 10, reset_after: 60000, total: 10, max_concurrency: 1 } }; },
    async createThread() { return { id: THREAD }; },
    async addReaction() {}, async removeReaction() {}, stop() {},
    async sendMessage(_channel: string, text: string) { messages.push(text); return [{ id: String(900 + messages.length) }]; },
    async sendFile(channel: string, name: string, data: Uint8Array, eligible?: () => boolean) {
      if (eligible && !eligible()) throw new Error("delivery revoked");
      uploads.push({ channel, name, data }); return [{ id: "1000" }];
    },
  };
  const daemon = new DiscordDaemon({ botToken: "offline", channelId: CHANNEL, allowedUserIds: [USER] }, {
    api, GatewayWebSocketImpl: Socket as unknown as typeof WebSocket, WebSocketImpl: Socket as unknown as typeof WebSocket,
    readdir: async () => ["alpha.json"], readFile: async () => JSON.stringify({ url: "ws://127.0.0.1:9001", token: "local", cwd: configDir, pid: 123 }),
    isPidAlive: () => true, scanIntervalMs: 1000000,
  });
  const dispatch = (id: string, author: string, content: string) => gateway.receive({ op: 0, t: "MESSAGE_CREATE", s: ++sequence, d: { id, channel_id: CHANNEL, type: 0, author: { id: author, bot: false }, content } });
  try {
    await daemon.start();
    await gateway!.receive({ op: 10, d: { heartbeat_interval: 1000 } });
    await gateway!.receive({ op: 0, t: "READY", s: ++sequence, d: { session_id: "gateway", resume_gateway_url: "wss://gateway.discord.gg" } });
    await local!.receive({ type: "snapshot", sessionId: "alpha", pid: 123, subagents: [] });
    await local!.receive({ type: "discord_control", sessionId: "alpha", enabled: true, generation: 1 });
    await dispatch("1", "999999999999999999", "/send alpha unauthorized");
    expect(uploads).toEqual([]);
    await dispatch("2", USER, "/send alpha create report");
    expect(uploads).toEqual([{ channel: THREAD, name: "result.txt", data: new TextEncoder().encode("output for create report") }]);
    expect(messages.some(text => text.includes("[Discord attachment directory]/output/result.txt"))).toBe(true);
    expect(messages.every(text => !text.includes(configDir))).toBe(true);
    allowArtifacts = false;
    await dispatch("3", USER, "/send alpha do not share");
    expect(uploads).toHaveLength(1);
    expect(messages.some(text => text.includes("not authorized"))).toBe(true);
  } finally {
    daemon.stop();
    if (previous === undefined) delete process.env.JEO_CONFIG_DIR; else process.env.JEO_CONFIG_DIR = previous;
    await fs.rm(configDir, { recursive: true, force: true });
  }
});
