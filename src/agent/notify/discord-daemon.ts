import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DiscordApi, DiscordApiError, type DiscordGatewayInfo } from "./discord-api";
import { notifySessionsDir } from "./paths";
import { isPidAlive } from "./daemon-control";
import { parseSessionEndpoint } from "./session-discovery";
import { createDiscordArtifactStage, type DiscordArtifactStage } from "./discord-artifacts";
import { stageDiscordAttachments, type DiscordAttachmentStage } from "./discord-attachments";

export interface DiscordDaemonConfig {
  botToken: string;
  channelId: string;
  allowedUserIds: string[];
}

export interface DiscordDaemonDependencies {
  api?: Pick<DiscordApi, "getMe" | "getChannel" | "getGatewayBot" | "sendMessage" | "sendFile" | "createThread" | "addReaction" | "removeReaction" | "stop">;
  WebSocketImpl?: typeof WebSocket;
  GatewayWebSocketImpl?: typeof WebSocket;
  readdir?: (dir: string) => Promise<string[]>;
  readFile?: (file: string) => Promise<string>;
  stageAttachments?: typeof stageDiscordAttachments;
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
  controlEnabled: boolean;
  controlGeneration: number;
}
interface RemoteResult { ok: boolean; text?: string; artifactsAllowed?: boolean; controlGeneration?: number }

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
  private readonly remote = new Map<string, { sessionId: string; acknowledged: boolean; finish: (result: RemoteResult) => void }>();
  private readonly staging = new Map<AbortController, string>();
  private readonly replies = new Map<string, { sessionId: string; at: number }>();
  private readonly seen = new Set<string>();
  private readonly threads = new Map<string, string>();
  private readonly relayDestinations = new Map<string, string>();
  private readonly relayVersions = new Map<string, number>();
  private channelType = -1;
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
      this.channelType = channel.type;
      if ([10, 11, 12].includes(channel.type)) {
        if (typeof channel.owner_id !== "string" || !this.allowed.has(channel.owner_id)) throw new Error("Configured thread must have an allowed human owner");
        this.threads.set(channel.id, channel.owner_id);
      }
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
    for (const controller of this.staging.keys()) controller.abort();
    for (const timer of this.timers) (this.deps.clearTimeout ?? clearTimeout)(timer);
    this.timers.clear();
    const gateway = this.gateway;
    this.gateway = undefined;
    try { gateway?.close(1000); } catch {}
    for (const session of this.sessions.values()) { try { session.ws.close(); } catch {} }
    this.sessions.clear();
    for (const request of this.pending.values()) request.finish(false);
    this.pending.clear();
    for (const request of this.remote.values()) request.finish({ ok: false });
    this.remote.clear();
    this.replies.clear();
    this.seen.clear();
    this.threads.clear();
    this.relayDestinations.clear();
    this.relayVersions.clear();
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
          const session: DiscordSession = { sessionId: id, cwd: info.cwd, pid: info.pid, ws, verified: false, records: [], controlEnabled: false, controlGeneration: -1 };
          this.sessions.set(id, session);
          const timeout = this.later(() => { if (!session.verified) { this.disconnectSession(session); try { ws.close(); } catch {} } }, 10_000);
          ws.onmessage = event => {
            if (this.stopped || this.sessions.get(id) !== session || typeof event.data !== "string" || (!session.verified && event.data.length > 1_048_576)) return;
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
    for (const [controller, id] of this.staging) if (id === session.sessionId) controller.abort();
    this.relayDestinations.delete(session.sessionId);
    for (const request of this.pending.values()) if (request.sessionId === session.sessionId) request.finish(false);
    for (const request of this.remote.values()) if (request.sessionId === session.sessionId) request.finish({ ok: false });
  }

  private onSessionFrame(session: DiscordSession, frame: Record<string, unknown>): void {
    if (frame.type === "ack" && typeof frame.reqId === "string" && typeof frame.ok === "boolean") {
      const request = this.pending.get(frame.reqId);
      if (request?.sessionId === session.sessionId) request.finish(frame.ok);
      return;
    }
    if (frame.sessionId !== session.sessionId) return;
    if (frame.type === "discord_control" && typeof frame.enabled === "boolean" && Number.isSafeInteger(frame.generation) && (frame.generation as number) >= session.controlGeneration) {
      if (session.controlGeneration !== frame.generation || !frame.enabled) {
        for (const [controller, id] of this.staging) if (id === session.sessionId) controller.abort();
      }
      session.controlEnabled = frame.enabled;
      session.controlGeneration = frame.generation as number;
      return;
    }
    if (frame.type === "remote_final" && typeof frame.reqId === "string" && typeof frame.ok === "boolean") {
      const request = this.remote.get(frame.reqId);
      if (request?.sessionId === session.sessionId && request.acknowledged) request.finish({ ok: frame.ok && typeof frame.text === "string", text: typeof frame.text === "string" ? frame.text : undefined, artifactsAllowed: frame.artifactsAllowed === true, controlGeneration: typeof frame.controlGeneration === "number" && Number.isSafeInteger(frame.controlGeneration) ? frame.controlGeneration : undefined });
      return;
    }
    const header = `[${session.sessionId}]`;
    if (frame.type === "snapshot" && frame.pid === session.pid && Array.isArray(frame.subagents)) {
      const records = frame.subagents.filter((r): r is AgentState => object(r) && typeof r.id === "string" &&
        typeof r.role === "string" && typeof r.task === "string" && typeof r.status === "string" &&
        ["running", "completed", "failed", "cancelled"].includes(r.status) && (r.result === undefined || typeof r.result === "string"));
      const previous = new Map(session.records.map(r => [r.id, r.status]));
      for (const record of records) {
        const before = previous.get(record.id);
        if ((!before && record.status === "running") || (before === "running" && record.status !== "running")) {
          this.emit(`${header} ${record.role} '${record.id}' ${record.status}`, session.sessionId);
        }
      }
      session.records = records;
    } else if (frame.type === "identity_header" && typeof frame.repo === "string") {
      this.emit(`${header} ${frame.repo}${typeof frame.branch === "string" ? ` (${frame.branch})` : ""}`, session.sessionId);
    } else if (frame.type === "local_relay_control" && typeof frame.destination === "string" && Number.isSafeInteger(frame.generation) && (frame.generation as number) >= 0) {
      const destination = frame.destination;
      this.relayDestinations.delete(session.sessionId);
      const version = (this.relayVersions.get(session.sessionId) ?? 0) + 1;
      this.relayVersions.set(session.sessionId, version);
      const enabled = destination === this.config.channelId;
      if (destination !== "off" && !enabled) this.deps.onError?.("Discord relay destination is not the configured channel");
      void this.request(session, { type: "local_relay", sessionId: session.sessionId, enabled, generation: frame.generation }).then(ok => {
        if (ok && enabled && this.relayVersions.get(session.sessionId) === version && this.sessions.get(session.sessionId) === session) this.relayDestinations.set(session.sessionId, destination);
      });
    } else if (frame.type === "local_final" && typeof frame.text === "string" && frame.text.trim()) {
      const destination = this.relayDestinations.get(session.sessionId);
      if (destination) this.emit(`${header}\n${frame.text}`, session.sessionId, destination, this.relayVersions.get(session.sessionId));
    }
  }

  private emit(text: string, sessionId?: string, destination = this.config.channelId, relayVersion?: number, guard?: () => boolean): Promise<boolean> {
    if (this.stopped || this.queued >= 128) { this.deps.onError?.("Discord outbound queue full or stopped"); return Promise.resolve(false); }
    this.queued++;
    const eligible = () => !this.stopped && (!guard || guard()) && (relayVersion === undefined || (!!sessionId && this.relayVersions.get(sessionId) === relayVersion && this.relayDestinations.get(sessionId) === destination));
    const result = this.outgoing.then(async () => {
      if (!eligible()) return false;
      const messages = await this.api.sendMessage(destination, text, eligible);
      this.rememberReplies(messages, sessionId);
      return true;
    }).catch(error => {
      if (!this.stopped) {
        if (error instanceof DiscordApiError) this.rememberReplies(error.sentMessages, sessionId);
        if (error instanceof DiscordApiError && error.status === 401) this.fail("Discord authentication denied");
        else this.deps.onError?.("Discord notification delivery failed");
      }
      return false;
    }).finally(() => { this.queued--; });
    this.outgoing = result.then(() => {});
    return result;
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

  private remoteRequest(session: DiscordSession, text: string, reqId: string, controlGeneration: number): Promise<RemoteResult> {
    if (this.remote.size >= 128 || this.pending.size >= 128) return Promise.resolve({ ok: false });
    const { promise, resolve } = Promise.withResolvers<RemoteResult>();
    const cancel = () => {
      if (!this.send(session, { type: "remote_cancel", sessionId: session.sessionId, reqId })) {
        try { session.ws.close(); } catch {}
        this.disconnectSession(session);
      }
      finish({ ok: false });
    };
    const timer = this.later(cancel, 15 * 60_000);
    const ackTimer = this.later(cancel, this.deps.ackTimeoutMs ?? 5_000);
    const finish = (result: RemoteResult) => {
      this.clear(timer); this.clear(ackTimer); this.pending.delete(reqId); this.remote.delete(reqId); resolve(result);
    };
    const remote = { sessionId: session.sessionId, acknowledged: false, finish };
    this.remote.set(reqId, remote);
    this.pending.set(reqId, { sessionId: session.sessionId, finish: ok => { this.clear(ackTimer); this.pending.delete(reqId); if (ok) remote.acknowledged = true; else finish({ ok: false }); } });
    if (!this.send(session, { type: "remote_request", sessionId: session.sessionId, reqId, text, staged: true, controlGeneration })) finish({ ok: false });
    return promise;
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (this.stopped || !object(message) || typeof message.channel_id !== "string" || !/^\d{1,20}$/.test(message.channel_id) ||
        typeof message.id !== "string" || !/^\d{1,20}$/.test(message.id) || !object(message.author) ||
        typeof message.author.id !== "string" || !this.allowed.has(message.author.id) || message.author.id === this.botId ||
        message.author.bot === true || (message.author.bot !== undefined && message.author.bot !== false) ||
        "webhook_id" in message || ![0, 19].includes(message.type as number) ||
        typeof message.content !== "string" || (!message.content.trim() && !(Array.isArray(message.attachments) && message.attachments.length)) || message.content.length > 4_000 || this.seen.has(message.id)) return;
    this.seen.add(message.id);
    if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!);
    const channelId = message.channel_id;
    if (channelId !== this.config.channelId && !this.threads.has(channelId)) {
      const channel = await this.api.getChannel(channelId).catch(() => undefined);
      if (!channel || ![10, 11, 12].includes(channel.type) || channel.parent_id !== this.config.channelId || channel.owner_id !== message.author.id) return;
      this.threads.set(channelId, message.author.id);
    }
    if ((channelId !== this.config.channelId || [10, 11, 12].includes(this.channelType)) && this.threads.get(channelId) !== message.author.id) return;
    const text = message.content.trim();
    let destination = channelId;
    try {
      if (channelId === this.config.channelId && [0, 5].includes(this.channelType)) {
        destination = (await this.api.createThread(channelId, message.id, "jeo reply")).id;
        this.threads.set(destination, message.author.id);
      }
    } catch (error) {
      if (error instanceof DiscordApiError && error.status === 401) this.fail("Discord authentication denied");
      else { this.deps.onError?.("Discord thread creation failed"); void this.emit("Unable to create a reply thread; check bot permissions.", undefined, channelId); }
      return;
    }
    const reaction = async (emoji: string, remove = false) => {
      try { await (remove ? this.api.removeReaction(channelId, message.id, emoji) : this.api.addReaction(channelId, message.id, emoji)); }
      catch (error) {
        if (error instanceof DiscordApiError && error.status === 401) this.fail("Discord authentication denied");
        else this.deps.onError?.("Discord reaction failed");
      }
    };
    const progress = reaction("⏳");
    try {
      const ok = await this.handleCommand(message, text, destination);
      void progress.then(() => reaction("⏳", true)).then(() => reaction(ok ? "✅" : "❌"));
    } catch {
      void progress.then(() => reaction("⏳", true)).then(() => reaction("❌"));
      this.deps.onError?.("Discord command relay failed");
    }
  }

  private async handleCommand(message: Record<string, unknown>, text: string, destination: string): Promise<boolean> {
    const emit = (content: string, sessionId?: string) => this.emit(content, sessionId, destination);
    const sendPrompt = async (session: DiscordSession, body: string): Promise<boolean> => {
      if (/^[\/!$]/.test(body) || body.includes("\u0003")) {
        await emit("Remote commands are disabled; send ordinary prompt text.");
        return false;
      }
      if (!session.controlEnabled) {
        await emit("Discord remote control is disabled in this session.", session.sessionId);
        return false;
      }
      const controlGeneration = session.controlGeneration;
      if (this.stopped || this.staging.size >= 8) {
        await emit("Too many requests are being prepared; try again later.", session.sessionId);
        return false;
      }
      const controller = new AbortController();
      this.staging.set(controller, session.sessionId);
      let output: DiscordArtifactStage | undefined;
      let input: DiscordAttachmentStage | undefined;
      try {
        const reqId = crypto.randomUUID();
        output = await createDiscordArtifactStage(session.sessionId, reqId);
        if (Array.isArray(message.attachments) && message.attachments.length) input = await (this.deps.stageAttachments ?? stageDiscordAttachments)(message.attachments, { directory: path.join(output.requestDirectory, "input"), signal: controller.signal });
        if (controller.signal.aborted || this.sessions.get(session.sessionId) !== session || !session.controlEnabled || session.controlGeneration !== controlGeneration) return false;
        const result = await this.remoteRequest(session, body || "Please inspect the attached files.", reqId, controlGeneration);
        if (!result.ok || result.text === undefined) {
          await emit("Session request failed, was rejected, interrupted, or timed out.", session.sessionId);
          return false;
        }
        const eligible = () => !this.stopped && this.sessions.get(session.sessionId) === session && session.controlEnabled && result.controlGeneration !== undefined && session.controlGeneration === result.controlGeneration;
        if (!eligible()) return false;
        const reply = result.text.split(output.requestDirectory).join("[Discord attachment directory]");
        if (!await this.emit(reply, session.sessionId, destination, undefined, eligible)) return false;
        if (result.artifactsAllowed !== true) {
          if (eligible() && (await fs.readdir(output.directory)).length) await this.emit("File delivery was not authorized for this session response.", session.sessionId, destination, undefined, eligible);
          return true;
        }
        const files = await output.collect();
        for (const file of files) {
          if (!eligible()) return false;
          const sent = await this.api.sendFile(destination, file.name, file.data, eligible);
          this.rememberReplies(sent, session.sessionId);
        }
        return true;
      } catch (error) {
        if (error instanceof DiscordApiError && error.status === 401) this.fail("Discord authentication denied");
        this.deps.onError?.("Discord attachment processing or delivery failed");
        await emit("Attachment processing or delivery failed; check file size, type, and bot permissions.", session.sessionId);
        return false;
      } finally {
        await input?.cleanup().catch(() => this.deps.onError?.("Discord input cleanup failed"));
        await output?.cleanup().catch(() => this.deps.onError?.("Discord output cleanup failed"));
        this.staging.delete(controller);
      }
    };
    if (text === "/sessions" || text === "/subagents") {
      const sessions = [...this.sessions.values()].filter(s => s.verified && s.ws.readyState === 1);
      return emit(sessions.length ? sessions.map(s => `[${s.sessionId}] ${s.cwd}${text === "/subagents" ? s.records.map(r => `\n  ${r.id}: ${r.status} ${r.role} — ${r.task}`).join("") : ""}`).join("\n") : "No connected sessions.");
    }
    if (text === "/help") return emit(HELP);
    const command = /^\/(send|steer|cancel)\s+(\S+)\s+([\s\S]+)$/.exec(text);
    if (command) {
      const session = this.findSession(command[2]!);
      if (!session) { await emit("Session not found or prefix ambiguous. Use /sessions and a unique ID."); return false; }
      const body = command[3]!.trim();
      if (command[1] === "send") return sendPrompt(session, body);
      const args = command[1] === "steer" ? /^(\S+)\s+([\s\S]+)$/.exec(body) : /^(\S+)$/.exec(body);
      if (!args) { await emit(HELP); return false; }
      if (!session.controlEnabled) { await emit("Discord remote control is disabled in this session.", session.sessionId); return false; }
      const control = { sessionId: session.sessionId, controlGeneration: session.controlGeneration };
      const ok = await this.request(session, command[1] === "steer" ? { ...control, type: "discord_steer", id: args[1], message: args[2] } : { ...control, type: "discord_cancel", ids: [args[1]] });
      const delivered = await emit(ok ? "Session acknowledged command." : "Command not acknowledged (unavailable, rejected or timed out).", session.sessionId);
      return ok && delivered;
    }
    if (text.startsWith("/")) { await emit(HELP); return false; }
    const reference = object(message.message_reference) ? message.message_reference : undefined;
    const reply = reference && typeof reference.message_id === "string" && (reference.channel_id === undefined || reference.channel_id === message.channel_id)
      ? this.replies.get(reference.message_id) : undefined;
    const session = reply && (this.deps.now ?? Date.now)() - reply.at < 86_400_000 ? this.findSession(reply.sessionId) : undefined;
    if (!session) { await emit("Reply target is unknown or expired. Use /send <unique-session> <text> after /sessions."); return false; }
    return sendPrompt(session, text);
  }
}
