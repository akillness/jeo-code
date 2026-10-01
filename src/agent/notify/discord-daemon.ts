import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DiscordApi, DiscordApiError, type DiscordGatewayInfo } from "./discord-api";
import { notifySessionsDir } from "./paths";
import { isPidAlive } from "./daemon-control";
import { parseSessionEndpoint } from "./session-discovery";

export interface DiscordDaemonConfig {
  botToken: string;
  channelId: string;
  allowedUserIds: string[];
}

export interface DiscordDaemonDependencies {
  api?: Pick<DiscordApi, "getMe" | "getChannel" | "getGatewayBot" | "sendMessage" | "stop">;
  WebSocketImpl?: typeof WebSocket;
  GatewayWebSocketImpl?: typeof WebSocket;
  readdir?: (dir: string) => Promise<string[]>;
  readFile?: (file: string) => Promise<string>;
  isPidAlive?: (pid: number) => boolean;
  now?: () => number;
  random?: () => number;
  setTimeout?: (callback: () => void, ms: number) => Timer;
  clearTimeout?: (timer: Timer) => void;
  scanIntervalMs?: number;
  ackTimeoutMs?: number;
  onError?: (message: string) => void;
  onFatal?: (message: string) => void;
}

interface AgentState { id: string; status: string; role: string; task: string; result?: string }
interface DiscordSession {
  sessionId: string;
  cwd: string;
  pid: number;
  ws: WebSocket;
  verified: boolean;
  records: AgentState[];
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Only Discord's official gateway hosts may receive the bot token. */
function gatewayUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "wss:" || !(url.hostname === "gateway.discord.gg" || /^gateway-[a-z0-9-]+\.discord\.gg$/.test(url.hostname)) ||
      url.username || url.password || url.port || url.pathname !== "/" || url.hash) throw new Error("Invalid Discord gateway URL");
  url.search = "?v=10&encoding=json";
  return url.href;
}

const HELP = "Discord controls:\n/sessions\n/subagents\n/send <unique-session> <text>\n/steer <unique-session> <subagent-id> <text>\n/cancel <unique-session> <subagent-id>\nReply to a session notification to send that session text. Other slash commands are not executed.";

/** One provider adapter inside the existing daemon; local commands use SessionNotifyEndpoint only. */
export class DiscordDaemon {
  readonly sessions = new Map<string, DiscordSession>();
  private readonly api: NonNullable<DiscordDaemonDependencies["api"]>;
  private readonly timers = new Set<Timer>();
  private readonly pending = new Map<string, { sessionId: string; finish: (ok: boolean) => void }>();
  private readonly replies = new Map<string, { sessionId: string; at: number }>();
  private readonly seen = new Set<string>();
  private readonly allowed: Set<string>;
  private stopped = true;
  private started = false;
  private scanning = false;
  private gateway: WebSocket | undefined;
  private gatewayInfo: DiscordGatewayInfo | undefined;
  private heartbeatTimer: Timer | undefined;
  private handshakeTimer: Timer | undefined;
  private reconnectTimer: Timer | undefined;
  private acked = true;
  private sequence: number | null = null;
  private gatewaySession: string | undefined;
  private resumeUrl: string | undefined;
  private reconnects = 0;
  private identifyAfter = 0;
  private gatewayLimitResetAt = 0;
  private botId = "";
  private intents = 0;
  private outgoing = Promise.resolve();
  private queued = 0;

  constructor(private readonly config: DiscordDaemonConfig, private readonly deps: DiscordDaemonDependencies = {}) {
    if (!config.botToken.trim() || !/^\d{1,20}$/.test(config.channelId) || !Array.isArray(config.allowedUserIds) ||
        !config.allowedUserIds.length || config.allowedUserIds.some(id => typeof id !== "string" || !/^\d{1,20}$/.test(id))) {
      throw new Error("Discord requires a bot token, channel ID and explicit allowed user IDs");
    }
    this.allowed = new Set(config.allowedUserIds);
    this.api = deps.api ?? new DiscordApi(config.botToken);
  }

  private later(callback: () => void, ms: number): Timer {
    const timer = (this.deps.setTimeout ?? setTimeout)(() => {
      this.timers.delete(timer);
      if (!this.stopped) callback();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  private clear(timer: Timer | undefined): void {
    if (timer === undefined) return;
    (this.deps.clearTimeout ?? clearTimeout)(timer);
    this.timers.delete(timer);
  }

  async start(): Promise<void> {
    if (this.started) {
      if (this.stopped) throw new Error("Discord daemon instance has stopped");
      return;
    }
    this.started = true;
    this.stopped = false;
    try {
      const me = await this.api.getMe();
      if (this.stopped) return;
      if (!me.bot) throw new Error("Discord bot identity required");
      this.botId = me.id;
      const channel = await this.api.getChannel(this.config.channelId);
      if (this.stopped) return;
      if (![0, 1, 5, 10, 11, 12].includes(channel.type)) throw new Error("Unsupported Discord channel type");
      this.intents = channel.type === 1 ? 1 << 12 : (1 << 9) | (1 << 15);
      this.gatewayInfo = await this.api.getGatewayBot();
      if (this.stopped) return;
      gatewayUrl(this.gatewayInfo.url);
      this.gatewayLimitResetAt = (this.deps.now ?? Date.now)() + this.gatewayInfo.session_start_limit.reset_after;
      if (this.gatewayInfo.session_start_limit.remaining < 1) throw new Error("Discord session start limit exhausted; retry after reset");
      this.connectGateway();
      await this.scanSessions();
      if (!this.stopped) this.scheduleScan();
    } catch (error) {
      this.stop();
      if (error instanceof DiscordApiError) throw error;
      throw new Error("Discord startup failed: verify channel, bot permissions and gateway configuration");
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) (this.deps.clearTimeout ?? clearTimeout)(timer);
    this.timers.clear();
    const gateway = this.gateway;
    this.gateway = undefined;
    try { gateway?.close(1000); } catch {}
    for (const session of this.sessions.values()) { try { session.ws.close(); } catch {} }
    this.sessions.clear();
    for (const request of this.pending.values()) request.finish(false);
    this.pending.clear();
    this.replies.clear();
    this.seen.clear();
    this.api.stop();
  }

  private fail(message: string): void {
    if (this.stopped) return;
    this.stop();
    try { this.deps.onError?.(message); }
    finally { this.deps.onFatal?.(message); }
  }

  private connectGateway(): void {
    if (this.stopped || !this.gatewayInfo) return;
    this.reconnectTimer = undefined;
    try {
      const WS = this.deps.GatewayWebSocketImpl ?? this.deps.WebSocketImpl ?? WebSocket;
      const ws = new WS(gatewayUrl(this.resumeUrl ?? this.gatewayInfo.url));
      this.gateway = ws;
      this.acked = true;
      let hello = false;
      this.handshakeTimer = this.later(() => this.reconnect(), 30_000);
      ws.onmessage = async event => {
        if (this.stopped || this.gateway !== ws || typeof event.data !== "string" || event.data.length > 1_048_576) return;
        let payload: unknown;
        try { payload = JSON.parse(event.data); } catch { return; }
        if (!object(payload) || !Number.isInteger(payload.op)) return;
        if (payload.op === 10) {
          if (hello || !object(payload.d) || typeof payload.d.heartbeat_interval !== "number" ||
              !Number.isFinite(payload.d.heartbeat_interval) || payload.d.heartbeat_interval < 1_000 || payload.d.heartbeat_interval > 300_000) return;
          hello = true;
          const interval = payload.d.heartbeat_interval;
          const beat = () => {
            if (this.gateway !== ws) return;
            if (!this.acked) { this.reconnect(); return; }
            this.acked = false;
            this.gatewaySend({ op: 1, d: this.sequence });
            if (this.gateway === ws) this.heartbeatTimer = this.later(beat, interval);
          };
          this.heartbeatTimer = this.later(beat, interval * (this.deps.random ?? Math.random)());
          if (this.gatewaySession && this.sequence !== null) {
            this.gatewaySend({ op: 6, d: { token: this.config.botToken, session_id: this.gatewaySession, seq: this.sequence } });
          } else {
            const identify = async () => {
              if (this.gateway !== ws || !this.gatewayInfo) return;
              if ((this.deps.now ?? Date.now)() >= this.gatewayLimitResetAt) {
                let info: DiscordGatewayInfo;
                try { info = await this.api.getGatewayBot(); } catch {
                  if (!this.stopped && this.gateway === ws) this.fail("Discord gateway budget refresh failed");
                  return;
                }
                if (this.stopped || this.gateway !== ws) return;
                this.gatewayInfo = info;
                this.gatewayLimitResetAt = (this.deps.now ?? Date.now)() + info.session_start_limit.reset_after;
              }
              if (this.gatewayInfo.session_start_limit.remaining < 1) { this.fail("Discord session start limit exhausted"); return; }
              this.gatewayInfo.session_start_limit.remaining--;
              this.identifyAfter = (this.deps.now ?? Date.now)() + 5_000;
              this.gatewaySend({ op: 2, d: { token: this.config.botToken, intents: this.intents,
                properties: { os: process.platform, browser: "jeo", device: "jeo" } } });
            };
            const wait = this.identifyAfter - (this.deps.now ?? Date.now)();
            if (wait > 0) this.later(() => { void identify(); }, wait); else await identify();
          }
        } else if (payload.op === 11) {
          this.acked = true;
        } else if (payload.op === 1) {
          this.acked = false;
          this.gatewaySend({ op: 1, d: this.sequence });
        } else if (payload.op === 7) {
          this.reconnect();
        } else if (payload.op === 9 && typeof payload.d === "boolean") {
          if (!payload.d) { this.gatewaySession = undefined; this.resumeUrl = undefined; this.sequence = null; }
          this.reconnect();
        } else if (payload.op === 0 && hello && typeof payload.s === "number" && Number.isSafeInteger(payload.s) && payload.s >= 0 && typeof payload.t === "string") {
          if (this.sequence !== null && payload.s <= this.sequence) return;
          this.sequence = payload.s;
          if (payload.t === "READY") {
            if (!object(payload.d) || typeof payload.d.session_id !== "string" || !payload.d.session_id || typeof payload.d.resume_gateway_url !== "string") { this.reconnect(); return; }
            try { this.resumeUrl = gatewayUrl(payload.d.resume_gateway_url); } catch { this.fail("Invalid Discord resume gateway"); return; }
            this.gatewaySession = payload.d.session_id;
            this.reconnects = 0;
            this.clear(this.handshakeTimer);
          } else if (payload.t === "RESUMED") {
            this.reconnects = 0;
            this.clear(this.handshakeTimer);
          } else if (payload.t === "MESSAGE_CREATE" && this.gatewaySession) {
            await this.handleMessage(payload.d).catch(() => this.deps.onError?.("Discord command relay failed"));
            await this.outgoing;
          }
        }
      };
      ws.onclose = event => {
        if (this.stopped || this.gateway !== ws) return;
        if ([4004, 4010, 4011, 4012, 4013, 4014].includes(event.code)) { this.fail(`Discord gateway stopped (${event.code}); verify bot token and intents`); return; }
        if ([4007, 4009].includes(event.code)) { this.gatewaySession = undefined; this.resumeUrl = undefined; this.sequence = null; }
        this.reconnect();
      };
      ws.onerror = () => { if (this.gateway === ws) this.reconnect(); };
    } catch { this.reconnect(); }
  }

  private gatewaySend(payload: unknown): void {
    try {
      if (this.gateway?.readyState !== 1) { this.reconnect(); return; }
      this.gateway.send(JSON.stringify(payload));
    } catch { this.reconnect(); }
  }

  private reconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) return;
    this.clear(this.heartbeatTimer);
    this.clear(this.handshakeTimer);
    const ws = this.gateway;
    this.gateway = undefined;
    try { ws?.close(4000); } catch {}
    if (++this.reconnects > 8) { this.fail("Discord gateway reconnect limit reached"); return; }
    const wait = Math.min(1_000 * 2 ** (this.reconnects - 1), 30_000);
    this.reconnectTimer = this.later(() => this.connectGateway(), wait);
  }

  private scheduleScan(): void {
    this.later(() => { void this.scanSessions().finally(() => { if (!this.stopped) this.scheduleScan(); }); }, this.deps.scanIntervalMs ?? 3_000);
  }

  async scanSessions(): Promise<void> {
    if (this.stopped || this.scanning) return;
    this.scanning = true;
    try {
      const dir = notifySessionsDir();
      const files = await (this.deps.readdir ?? (p => fs.readdir(p)))(dir).catch(() => []);
      for (const file of files) {
        if (this.stopped) return;
        if (!/^[a-zA-Z0-9_-]+\.json$/.test(file)) continue;
        const id = file.slice(0, -5);
        if (this.sessions.has(id)) continue;
        const raw = await (this.deps.readFile ?? (p => fs.readFile(p, "utf8")))(path.join(dir, file)).catch(() => "");
        if (this.stopped) return;
        const info = parseSessionEndpoint(raw);
        if (!info || !(this.deps.isPidAlive ?? isPidAlive)(info.pid)) continue;
        const url = new URL(info.url);
        url.searchParams.set("token", info.token);
        try {
          const WS = this.deps.WebSocketImpl ?? WebSocket;
          const ws = new WS(url.href);
          const session: DiscordSession = { sessionId: id, cwd: info.cwd, pid: info.pid, ws, verified: false, records: [] };
          this.sessions.set(id, session);
          const timeout = this.later(() => { if (!session.verified) { this.disconnectSession(session); try { ws.close(); } catch {} } }, 10_000);
          ws.onmessage = event => {
            if (this.stopped || this.sessions.get(id) !== session || typeof event.data !== "string" || event.data.length > 1_048_576) return;
            let frame: unknown;
            try { frame = JSON.parse(event.data); } catch { return; }
            if (!object(frame)) return;
            if (!session.verified) {
              if (frame.type !== "snapshot" || frame.sessionId !== id || frame.pid !== info.pid) {
                this.disconnectSession(session); try { ws.close(); } catch {} return;
              }
              session.verified = true;
              this.clear(timeout);
            }
            this.onSessionFrame(session, frame);
          };
          ws.onclose = () => { this.clear(timeout); this.disconnectSession(session); };
          ws.onerror = () => { this.clear(timeout); this.disconnectSession(session); try { ws.close(); } catch {} };
        } catch { this.deps.onError?.("Local session connection failed"); }
      }
    } finally { this.scanning = false; }
  }

  private disconnectSession(session: DiscordSession): void {
    if (this.sessions.get(session.sessionId) !== session) return;
    this.sessions.delete(session.sessionId);
    for (const request of this.pending.values()) if (request.sessionId === session.sessionId) request.finish(false);
  }

  private onSessionFrame(session: DiscordSession, frame: Record<string, unknown>): void {
    if (frame.type === "ack" && typeof frame.reqId === "string" && typeof frame.ok === "boolean") {
      const request = this.pending.get(frame.reqId);
      if (request?.sessionId === session.sessionId) request.finish(frame.ok);
      return;
    }
    if (frame.sessionId !== session.sessionId) return;
    const header = `[${session.sessionId}]`;
    if (frame.type === "snapshot" && frame.pid === session.pid && Array.isArray(frame.subagents)) {
      const records = frame.subagents.filter((r): r is AgentState => object(r) && typeof r.id === "string" &&
        typeof r.role === "string" && typeof r.task === "string" && typeof r.status === "string" &&
        ["running", "completed", "failed", "cancelled"].includes(r.status) && (r.result === undefined || typeof r.result === "string"));
      const previous = new Map(session.records.map(r => [r.id, r.status]));
      for (const record of records) {
        const before = previous.get(record.id);
        if ((!before && record.status === "running") || (before === "running" && record.status !== "running")) {
          this.emit(`${header} ${record.role} '${record.id}' ${record.status}\n${record.status === "running" ? record.task : record.result ?? ""}`, session.sessionId);
        }
      }
      session.records = records;
    } else if (frame.type === "identity_header" && typeof frame.repo === "string") {
      this.emit(`${header} ${frame.repo}${typeof frame.branch === "string" ? ` (${frame.branch})` : ""}`, session.sessionId);
    } else if (frame.type === "context_update" && ["turn_start", "turn_end"].includes(String(frame.phase)) && typeof frame.summary === "string") {
      this.emit(`${header} ${frame.phase}\n${frame.summary}`, session.sessionId);
    } else if (frame.type === "turn_stream" && frame.phase === "finalized" && typeof frame.text === "string" && frame.text.trim()) {
      this.emit(`${header}\n${frame.text}`, session.sessionId);
    }
  }

  private emit(text: string, sessionId?: string): void {
    if (this.stopped) return;
    if (this.queued >= 128) { this.deps.onError?.("Discord outbound queue full"); return; }
    this.queued++;
    this.outgoing = this.outgoing.then(async () => {
      if (this.stopped) return;
      const messages = await this.api.sendMessage(this.config.channelId, text);
      this.rememberReplies(messages, sessionId);
    }).catch(error => {
      if (this.stopped) return;
      if (error instanceof DiscordApiError) this.rememberReplies(error.sentMessages, sessionId);
      if (error instanceof DiscordApiError && (error.status === 401 || error.status === 403)) this.fail("Discord authentication or permission denied");
      else this.deps.onError?.("Discord notification delivery failed");
    }).finally(() => { this.queued--; });
  }

  private rememberReplies(messages: { id: string }[], sessionId?: string): void {
    if (this.stopped || !sessionId) return;
    for (const message of messages) {
      this.replies.set(message.id, { sessionId, at: (this.deps.now ?? Date.now)() });
      if (this.replies.size > 1024) this.replies.delete(this.replies.keys().next().value!);
    }
  }

  private findSession(prefix: string): DiscordSession | undefined {
    const live = [...this.sessions.values()].filter(s => s.verified && s.ws.readyState === 1);
    const exact = live.find(s => s.sessionId === prefix);
    if (exact) return exact;
    const matches = live.filter(s => s.sessionId.startsWith(prefix) || s.sessionId.replace(/-/g, "").startsWith(prefix));
    return matches.length === 1 ? matches[0] : undefined;
  }

  private send(session: DiscordSession, frame: unknown): boolean {
    if (this.stopped || !session.verified || session.ws.readyState !== 1) return false;
    try { session.ws.send(JSON.stringify(frame)); return true; } catch { return false; }
  }

  private request(session: DiscordSession, frame: Record<string, unknown>): Promise<boolean> {
    if (this.pending.size >= 128) return Promise.resolve(false);
    const reqId = crypto.randomUUID();
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const timer = this.later(() => finish(false), this.deps.ackTimeoutMs ?? 5_000);
    const finish = (ok: boolean) => { this.clear(timer); this.pending.delete(reqId); resolve(ok); };
    this.pending.set(reqId, { sessionId: session.sessionId, finish });
    if (!this.send(session, { ...frame, reqId })) finish(false);
    return promise;
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (this.stopped || !object(message) || message.channel_id !== this.config.channelId ||
        typeof message.id !== "string" || !/^\d{1,20}$/.test(message.id) || !object(message.author) ||
        typeof message.author.id !== "string" || !this.allowed.has(message.author.id) || message.author.id === this.botId ||
        message.author.bot === true || (message.author.bot !== undefined && message.author.bot !== false) ||
        "webhook_id" in message || ![0, 19].includes(message.type as number) ||
        typeof message.content !== "string" || !message.content.trim() || message.content.length > 4_000 || this.seen.has(message.id)) return;
    this.seen.add(message.id);
    if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!);
    const text = message.content.trim();
    if (text === "/sessions" || text === "/subagents") {
      const sessions = [...this.sessions.values()].filter(s => s.verified && s.ws.readyState === 1);
      this.emit(sessions.length ? sessions.map(s => `[${s.sessionId}] ${s.cwd}${text === "/subagents" ? s.records.map(r => `\n  ${r.id}: ${r.status} ${r.role} — ${r.task}`).join("") : ""}`).join("\n") : "No connected sessions.");
      return;
    }
    if (text === "/help") { this.emit(HELP); return; }
    const command = /^\/(send|steer|cancel)\s+(\S+)\s+([\s\S]+)$/.exec(text);
    if (command) {
      const session = this.findSession(command[2]!);
      if (!session) { this.emit("Session not found or prefix ambiguous. Use /sessions and a unique ID."); return; }
      const body = command[3]!.trim();
      if (command[1] === "send") {
        if (body.startsWith("/")) { this.emit("Remote slash commands are disabled; send ordinary prompt text."); return; }
        this.emit(this.send(session, { type: "user_message", text: body }) ? "Forwarded to session (not an execution acknowledgement)." : "Session unavailable.", session.sessionId);
      } else {
        const args = command[1] === "steer" ? /^(\S+)\s+([\s\S]+)$/.exec(body) : /^(\S+)$/.exec(body);
        if (!args) { this.emit(HELP); return; }
        const ok = await this.request(session, command[1] === "steer" ? { type: "steer", id: args[1], message: args[2] } : { type: "cancel", ids: [args[1]] });
        this.emit(ok ? "Session acknowledged command." : "Command not acknowledged (unavailable, rejected or timed out).", session.sessionId);
      }
      return;
    }
    if (text.startsWith("/")) { this.emit(HELP); return; }
    const reference = object(message.message_reference) ? message.message_reference : undefined;
    const reply = reference && typeof reference.message_id === "string" && (reference.channel_id === undefined || reference.channel_id === this.config.channelId)
      ? this.replies.get(reference.message_id) : undefined;
    const session = reply && (this.deps.now ?? Date.now)() - reply.at < 86_400_000 ? this.findSession(reply.sessionId) : undefined;
    if (!session) { this.emit("Reply target is unknown or expired. Use /send <unique-session> <text> after /sessions."); return; }
    this.emit(this.send(session, { type: "user_message", text }) ? "Forwarded to session (not an execution acknowledgement)." : "Session unavailable.", session.sessionId);
  }
}
