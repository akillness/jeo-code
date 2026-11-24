import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DiscordApi, DiscordApiError, type DiscordGatewayInfo } from "./discord-api";
import { notifySessionsDir } from "./paths";
import { isPidAlive } from "./daemon-control";
import { parseSessionEndpoint } from "./session-discovery";
import { createDiscordArtifactStage, type DiscordArtifactStage } from "./discord-artifacts";
import { stageDiscordAttachments, type DiscordAttachmentStage } from "./discord-attachments";
import {
  DISCORD_SILENT_MESSAGE_FLAGS,
  DISCORD_THINKING_DEBOUNCE_MS,
  formatDiscordCompletionReport,
  formatDiscordThinkingMessage,
  type ThinkingPhase,
  type UnifiedCompletionStatus,
  type UnifiedTaskReportItem,
  type UnifiedTaskReportSource,
} from "./discord-thinking";

export interface DiscordDaemonConfig {
  botToken: string;
  channelId: string;
  allowedUserIds: string[];
}

export interface DiscordDaemonDependencies {
  api?: Pick<DiscordApi, "getMe" | "getChannel" | "getGatewayBot" | "sendMessage" | "sendFile" | "createThread" | "addReaction" | "removeReaction" | "stop"> & Partial<Pick<DiscordApi, "editMessage">>;
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
  maxReconnects?: number;
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
  thinkingMessageId?: string;
  thinkingChannelId?: string;
  thinkingTurnId?: string;
  thinkingStartedAt?: number;
  lastThinkingEditAt?: number;
  lastThinkingContent?: string;
  pendingThinkingTimer?: Timer;
  pendingThinkingContent?: string;
  thinkingInFlight?: boolean;
  thinkingGeneration?: number;
}
interface RemoteResult { ok: boolean; text?: string; artifactsAllowed?: boolean; controlGeneration?: number }

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const VALID_THINKING_PHASES: Record<ThinkingPhase, true> = {
  thinking: true,
  planning: true,
  executing: true,
  verifying: true,
  reporting: true,
  working: true,
};
const VALID_COMPLETION_STATUSES: Record<UnifiedCompletionStatus, true> = {
  completed: true,
  partial: true,
  failed: true,
  escalated: true,
  cancelled: true,
};
const VALID_REPORT_SOURCES: Record<UnifiedTaskReportSource, true> = {
  todo: true,
  subagent: true,
  gate: true,
  queue: true,
  approval: true,
  job: true,
};

function formatElapsedLabel(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function parseReportItems(raw: unknown): UnifiedTaskReportItem[] {
  if (!Array.isArray(raw)) return [];
  const items: UnifiedTaskReportItem[] = [];
  for (const entry of raw) {
    if (!object(entry) || typeof entry.label !== "string" || typeof entry.source !== "string") continue;
    if (!Object.hasOwn(VALID_REPORT_SOURCES, entry.source)) continue;
    if (entry.detail !== undefined && typeof entry.detail !== "string") continue;
    items.push({
      label: entry.label,
      source: entry.source as UnifiedTaskReportSource,
      ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    });
  }
  return items;
}

/** Only Discord's official gateway hosts may receive the bot token. */
function gatewayUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "wss:" || !(url.hostname === "gateway.discord.gg" || /^gateway-[a-z0-9-]+\.discord\.gg$/.test(url.hostname)) ||
      url.username || url.password || url.port || url.pathname !== "/" || url.hash) throw new Error("Invalid Discord gateway URL");
  url.search = "?v=10&encoding=json";
  return url.href;
}

const HELP = "Discord controls:\n/sessions\n/subagents\n/send <unique-session> <text>\n/steer <unique-session> <subagent-id> <text>\n/cancel <unique-session> <subagent-id>\n/send <unique-session> /sandbox status\n/send <unique-session> /sandbox approve <requestId>\n/send <unique-session> /sandbox deny <requestId>\n/send <unique-session> /sandbox revoke\nReply to a session notification to send that session text or a sandbox access control. Other slash commands are not executed.";

/** One provider adapter inside the existing daemon; local commands use SessionNotifyEndpoint only. */
export class DiscordDaemon {
  readonly sessions = new Map<string, DiscordSession>();
  private readonly api: NonNullable<DiscordDaemonDependencies["api"]>;
  private readonly timers = new Set<Timer>();
  private readonly pending = new Map<string, { sessionId: string; finish: (ok: boolean, output?: string) => void }>();
  private readonly remote = new Map<string, { sessionId: string; acknowledged: boolean; finish: (result: RemoteResult) => void }>();
  private readonly staging = new Map<AbortController, string>();
  private readonly promptTails = new Map<string, Promise<void>>();
  private queuedPrompts = 0;
  private readonly preparationTails = new Map<string, Promise<void>>();
  private readonly preparations = new Set<() => void>();
  private readonly replies = new Map<string, { sessionId: string; at: number }>();
  private readonly seen = new Set<string>();
  private readonly threads = new Set<string>();
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
        this.threads.add(channel.id);
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
    for (const release of this.preparations) release();
    this.preparationTails.clear();
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
                try { info = await this.api.getGatewayBot(); } catch (error) {
                  if (!this.stopped && this.gateway === ws) {
                    if (error instanceof DiscordApiError && error.status === 401) this.fail("Discord authentication denied");
                    else {
                      this.deps.onError?.("Discord gateway budget refresh failed");
                      this.reconnect();
                    }
                  }
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
    if (++this.reconnects > (this.deps.maxReconnects ?? Infinity)) { this.fail("Discord gateway reconnect limit reached"); return; }
    const wait = Math.min(1_000 * 2 ** Math.min(this.reconnects - 1, 5), 30_000);
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
    this.clear(session.pendingThinkingTimer);
    session.pendingThinkingTimer = undefined;
    session.pendingThinkingContent = undefined;
    session.thinkingGeneration = (session.thinkingGeneration ?? 0) + 1;
    for (const [controller, id] of this.staging) if (id === session.sessionId) controller.abort();
    this.relayDestinations.delete(session.sessionId);
    for (const request of this.pending.values()) if (request.sessionId === session.sessionId) request.finish(false);
    for (const request of this.remote.values()) if (request.sessionId === session.sessionId) request.finish({ ok: false });
  }

  private onSessionFrame(session: DiscordSession, frame: Record<string, unknown>): void {
    if (frame.type === "ack" && typeof frame.reqId === "string" && typeof frame.ok === "boolean") {
      const request = this.pending.get(frame.reqId);
      if (request?.sessionId === session.sessionId) request.finish(frame.ok, typeof frame.output === "string" ? frame.output : undefined);
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
    } else if (frame.type === "thinking_update" && typeof frame.phase === "string" && Object.hasOwn(VALID_THINKING_PHASES, frame.phase)) {
      this.handleThinkingUpdate(session, frame);
    } else if (frame.type === "completion_report" && typeof frame.status === "string" && Object.hasOwn(VALID_COMPLETION_STATUSES, frame.status)) {
      this.handleCompletionReport(session, frame);
    }
  }

  private handleThinkingUpdate(session: DiscordSession, frame: Record<string, unknown>): void {
    const now = (this.deps.now ?? Date.now)();
    const turnId = typeof frame.turnId === "string" ? frame.turnId : undefined;
    if (turnId !== undefined && session.thinkingTurnId !== undefined && turnId !== session.thinkingTurnId) {
      this.clear(session.pendingThinkingTimer);
      session.pendingThinkingTimer = undefined;
      session.pendingThinkingContent = undefined;
      session.thinkingMessageId = undefined;
      session.thinkingChannelId = undefined;
      session.lastThinkingEditAt = undefined;
      session.lastThinkingContent = undefined;
      session.thinkingStartedAt = now;
      session.thinkingGeneration = (session.thinkingGeneration ?? 0) + 1;
    }
    if (turnId !== undefined) session.thinkingTurnId = turnId;
    if (session.thinkingStartedAt === undefined) session.thinkingStartedAt = now;

    const elapsedMs = typeof frame.elapsedMs === "number" && Number.isFinite(frame.elapsedMs) && frame.elapsedMs >= 0
      ? frame.elapsedMs
      : Math.max(0, now - session.thinkingStartedAt);
    const rawContent = formatDiscordThinkingMessage({
      title: `[${session.sessionId}]`,
      phase: frame.phase as ThinkingPhase,
      elapsedLabel: formatElapsedLabel(elapsedMs),
      reasoning: typeof frame.reasoning === "string" ? frame.reasoning : undefined,
      currentTool: typeof frame.currentTool === "string" ? frame.currentTool : undefined,
      activeSubagents: typeof frame.activeSubagents === "number" && Number.isFinite(frame.activeSubagents) ? frame.activeSubagents : undefined,
    });
    const content = this.config.botToken ? rawContent.split(this.config.botToken).join("[REDACTED_TOKEN]") : rawContent;

    if (content === session.lastThinkingContent && session.pendingThinkingContent === undefined) return;
    session.pendingThinkingContent = content;

    const targetChannelId = session.thinkingChannelId ?? this.relayDestinations.get(session.sessionId) ?? this.config.channelId;
    if (!session.thinkingMessageId) {
      if (session.thinkingInFlight) return;
      session.pendingThinkingContent = undefined;
      session.lastThinkingContent = content;
      session.lastThinkingEditAt = now;
      this.postThinkingMessage(session, targetChannelId, content);
      return;
    }

    if (!this.api.editMessage) return;
    const elapsedSinceLast = now - (session.lastThinkingEditAt ?? 0);
    if (!session.thinkingInFlight && elapsedSinceLast >= DISCORD_THINKING_DEBOUNCE_MS) {
      this.clear(session.pendingThinkingTimer);
      session.pendingThinkingTimer = undefined;
      this.flushThinkingEdit(session);
    } else if (session.pendingThinkingTimer === undefined) {
      const waitMs = session.thinkingInFlight ? DISCORD_THINKING_DEBOUNCE_MS : Math.max(0, DISCORD_THINKING_DEBOUNCE_MS - elapsedSinceLast);
      session.pendingThinkingTimer = this.later(() => {
        session.pendingThinkingTimer = undefined;
        this.flushThinkingEdit(session);
      }, waitMs);
    }
  }

  private postThinkingMessage(session: DiscordSession, channelId: string, content: string): void {
    const gen = session.thinkingGeneration ?? 0;
    session.thinkingInFlight = true;
    const eligible = () => !this.stopped && this.sessions.get(session.sessionId) === session && (session.thinkingGeneration ?? 0) === gen;
    void this.api.sendMessage(channelId, content, eligible, DISCORD_SILENT_MESSAGE_FLAGS).then(messages => {
      session.thinkingInFlight = false;
      if (!eligible()) return;
      if (messages[0]?.id) {
        session.thinkingMessageId = messages[0].id;
        session.thinkingChannelId = channelId;
        this.rememberReplies(messages, session.sessionId);
      }
      if (session.pendingThinkingContent !== undefined && session.pendingThinkingContent !== session.lastThinkingContent && session.pendingThinkingTimer === undefined) {
        const now = (this.deps.now ?? Date.now)();
        const waitMs = Math.max(0, DISCORD_THINKING_DEBOUNCE_MS - (now - (session.lastThinkingEditAt ?? 0)));
        session.pendingThinkingTimer = this.later(() => {
          session.pendingThinkingTimer = undefined;
          this.flushThinkingEdit(session);
        }, waitMs);
      }
    }).catch(error => {
      session.thinkingInFlight = false;
      if (this.stopped) return;
      if (error instanceof DiscordApiError && error.status === 401) this.fail("Discord authentication denied");
      else this.deps.onError?.("Discord thinking status delivery failed");
    });
  }

  private flushThinkingEdit(session: DiscordSession): void {
    if (this.stopped || this.sessions.get(session.sessionId) !== session) return;
    const content = session.pendingThinkingContent;
    if (!content || content === session.lastThinkingContent) {
      session.pendingThinkingContent = undefined;
      return;
    }
    const channelId = session.thinkingChannelId ?? this.relayDestinations.get(session.sessionId) ?? this.config.channelId;
    if (!session.thinkingMessageId) {
      if (session.thinkingInFlight) {
        if (session.pendingThinkingTimer === undefined) {
          session.pendingThinkingTimer = this.later(() => {
            session.pendingThinkingTimer = undefined;
            this.flushThinkingEdit(session);
          }, DISCORD_THINKING_DEBOUNCE_MS);
        }
        return;
      }
      session.pendingThinkingContent = undefined;
      session.lastThinkingContent = content;
      session.lastThinkingEditAt = (this.deps.now ?? Date.now)();
      this.postThinkingMessage(session, channelId, content);
      return;
    }
    if (!this.api.editMessage) return;
    if (session.thinkingInFlight) {
      if (session.pendingThinkingTimer === undefined) {
        session.pendingThinkingTimer = this.later(() => {
          session.pendingThinkingTimer = undefined;
          this.flushThinkingEdit(session);
        }, DISCORD_THINKING_DEBOUNCE_MS);
      }
      return;
    }
    const msgId = session.thinkingMessageId;
    const gen = session.thinkingGeneration ?? 0;
    session.thinkingInFlight = true;
    session.pendingThinkingContent = undefined;
    session.lastThinkingContent = content;
    session.lastThinkingEditAt = (this.deps.now ?? Date.now)();
    const eligible = () => !this.stopped && this.sessions.get(session.sessionId) === session && session.thinkingMessageId === msgId && (session.thinkingGeneration ?? 0) === gen;
    void this.api.editMessage(channelId, msgId, content, eligible).then(() => {
      session.thinkingInFlight = false;
      if (!eligible()) return;
      if (session.pendingThinkingContent !== undefined && session.pendingThinkingContent !== session.lastThinkingContent && session.pendingThinkingTimer === undefined) {
        const now = (this.deps.now ?? Date.now)();
        const waitMs = Math.max(0, DISCORD_THINKING_DEBOUNCE_MS - (now - (session.lastThinkingEditAt ?? 0)));
        session.pendingThinkingTimer = this.later(() => {
          session.pendingThinkingTimer = undefined;
          this.flushThinkingEdit(session);
        }, waitMs);
      }
    }).catch(error => {
      session.thinkingInFlight = false;
      if (this.stopped) return;
      if (error instanceof DiscordApiError && error.status === 401) {
        this.fail("Discord authentication denied");
      } else if (error instanceof DiscordApiError && error.status === 404 && (session.thinkingGeneration ?? 0) === gen) {
        session.thinkingMessageId = undefined;
        session.thinkingChannelId = undefined;
        this.postThinkingMessage(session, channelId, content);
      } else {
        this.deps.onError?.("Discord thinking status update failed");
      }
    });
  }

  private handleCompletionReport(session: DiscordSession, frame: Record<string, unknown>): void {
    const now = (this.deps.now ?? Date.now)();
    this.clear(session.pendingThinkingTimer);
    session.pendingThinkingTimer = undefined;
    session.pendingThinkingContent = undefined;

    const status = frame.status as UnifiedCompletionStatus;
    const elapsedMs = typeof frame.elapsedMs === "number" && Number.isFinite(frame.elapsedMs) && frame.elapsedMs >= 0
      ? frame.elapsedMs
      : session.thinkingStartedAt !== undefined ? Math.max(0, now - session.thinkingStartedAt) : undefined;
    const elapsedLabel = elapsedMs !== undefined ? formatElapsedLabel(elapsedMs) : undefined;

    const msgId = session.thinkingMessageId;
    const thinkingChannelId = session.thinkingChannelId;
    session.thinkingMessageId = undefined;
    session.thinkingChannelId = undefined;
    session.thinkingTurnId = undefined;
    session.thinkingStartedAt = undefined;
    session.lastThinkingContent = undefined;
    session.lastThinkingEditAt = undefined;
    session.thinkingGeneration = (session.thinkingGeneration ?? 0) + 1;

    if (msgId && thinkingChannelId && this.api.editMessage) {
      const outcomeBadge = status === "completed"
        ? "✅ Thinking 완료"
        : status === "failed"
          ? "❌ Thinking 실패"
          : status === "cancelled"
            ? "⏹ Thinking 중단"
            : "⚠️ Thinking 종료";
      const finalizedRaw = formatDiscordThinkingMessage({
        title: `[${session.sessionId}]`,
        phase: "reporting",
        elapsedLabel: elapsedLabel ?? "0s",
        finalized: true,
        outcomeBadge,
      });
      const finalized = this.config.botToken ? finalizedRaw.split(this.config.botToken).join("[REDACTED_TOKEN]") : finalizedRaw;
      void this.api.editMessage(
        thinkingChannelId,
        msgId,
        finalized,
        () => !this.stopped && this.sessions.get(session.sessionId) === session,
      ).catch(error => {
        if (!this.stopped && error instanceof DiscordApiError && error.status === 401) {
          this.fail("Discord authentication denied");
        }
      });
    }

    const completed = parseReportItems(frame.completed);
    const remaining = parseReportItems(frame.remaining);
    const changedFiles = Array.isArray(frame.changedFiles)
      ? frame.changedFiles.filter((f): f is string => typeof f === "string")
      : undefined;
    const reportText = formatDiscordCompletionReport({
      title: `[${session.sessionId}]`,
      status,
      elapsedLabel,
      summary: typeof frame.summary === "string" ? frame.summary : undefined,
      completed,
      remaining,
      changedFiles,
    });
    const destination = thinkingChannelId ?? this.relayDestinations.get(session.sessionId) ?? this.config.channelId;
    void this.emit(reportText, session.sessionId, destination);
  }

  private emit(text: string, sessionId?: string, destination = this.config.channelId, relayVersion?: number, guard?: () => boolean): Promise<boolean> {
    if (this.stopped || this.queued >= 128) { this.deps.onError?.("Discord outbound queue full or stopped"); return Promise.resolve(false); }
    this.queued++;
    const safeText = this.config.botToken ? text.split(this.config.botToken).join("[REDACTED_TOKEN]") : text;
    const eligible = () => !this.stopped && (!guard || guard()) && (relayVersion === undefined || (!!sessionId && this.relayVersions.get(sessionId) === relayVersion && this.relayDestinations.get(sessionId) === destination));
    const result = this.outgoing.then(async () => {
      if (!eligible()) return false;
      const messages = await this.api.sendMessage(destination, safeText, eligible);
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

  private sandboxControl(session: DiscordSession, text: string, userId: string): Promise<{ ok: boolean; output: string }> {
    if (!session.controlEnabled || this.pending.size >= 128) return Promise.resolve({ ok: false, output: "Discord sandbox control is disabled or unavailable." });
    const reqId = crypto.randomUUID();
    const { promise, resolve } = Promise.withResolvers<{ ok: boolean; output: string }>();
    const timer = this.later(() => finish(false, "Sandbox control timed out; outcome is unconfirmed."), 30_000);
    const finish = (ok: boolean, output = "Sandbox control was not acknowledged.") => { this.clear(timer); this.pending.delete(reqId); resolve({ ok, output }); };
    this.pending.set(reqId, { sessionId: session.sessionId, finish });
    if (!this.send(session, { type: "sandbox_control", sessionId: session.sessionId, reqId, text, actor: { origin: "discord", sessionKey: session.sessionId, userId }, controlGeneration: session.controlGeneration })) finish(false);
    return promise;
  }

  private remoteRequest(session: DiscordSession, text: string, reqId: string, controlGeneration: number, userId: string): Promise<RemoteResult> {
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
    if (!this.send(session, { type: "remote_request", sessionId: session.sessionId, reqId, text, staged: true, controlGeneration, actor: { origin: "discord", sessionKey: session.sessionId, userId } })) finish({ ok: false });
    return promise;
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (this.stopped || !object(message) || typeof message.channel_id !== "string" || !/^\d{1,20}$/.test(message.channel_id) ||
        typeof message.id !== "string" || !/^\d{1,20}$/.test(message.id) || !object(message.author) ||
        typeof message.author.id !== "string" || !this.allowed.has(message.author.id) || message.author.id === this.botId ||
        message.author.bot === true || (message.author.bot !== undefined && message.author.bot !== false) ||
        "webhook_id" in message || ![0, 19].includes(message.type as number) ||
        (this.channelType === 1 && message.guild_id !== undefined) ||
        typeof message.content !== "string" || (!message.content.trim() && !(Array.isArray(message.attachments) && message.attachments.length)) || message.content.length > 4_000 || this.seen.has(message.id)) return;
    const channelId = message.channel_id;
    const messageId = message.id;
    const content = message.content;
    const reaction = async (emoji: string, remove = false) => {
      if (this.stopped) return;
      try { await (remove ? this.api.removeReaction(channelId, messageId, emoji) : this.api.addReaction(channelId, messageId, emoji)); }
      catch (error) {
        if (error instanceof DiscordApiError && error.status === 401) this.fail("Discord authentication denied");
        else this.deps.onError?.("Discord reaction failed");
      }
    };
    if (this.preparations.size >= 128) {
      this.deps.onError?.("Discord message preparation queue full");
      await reaction("❌");
      return;
    }
    this.seen.add(messageId);
    if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!);
    // Reserve arrival order before metadata/thread creation can yield. Senders sharing
    // a Discord channel share this admission lane, not the lifetime of a model turn.
    const key = JSON.stringify([this.botId, typeof message.guild_id === "string" ? message.guild_id : "", channelId]);
    const previous = this.preparationTails.get(key) ?? Promise.resolve();
    const ready = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const tail = previous.then(() => ready.promise);
    let createdThreadKey: string | undefined;
    const release = () => {
      if (!this.preparations.delete(release)) return;
      ready.resolve();
      cancelled.resolve();
      if (this.preparationTails.get(key) === tail) this.preparationTails.delete(key);
      if (createdThreadKey && this.preparationTails.get(createdThreadKey) === tail) this.preparationTails.delete(createdThreadKey);
    };
    this.preparationTails.set(key, tail);
    this.preparations.add(release);
    let command: Promise<boolean>;
    let progress: Promise<void>;
    try {
      await Promise.race([previous, cancelled.promise]);
      if (this.stopped) return;
      if (channelId !== this.config.channelId && !this.threads.has(channelId)) {
        const channel = await Promise.race([
          this.api.getChannel(channelId).catch((error: unknown) => {
            if (this.stopped) return undefined;
            this.seen.delete(messageId);
            if (error instanceof DiscordApiError && error.status === 401) this.fail("Discord authentication denied");
            else {
              this.deps.onError?.("Discord channel metadata lookup failed");
              void reaction("❌");
            }
            return undefined;
          }),
          cancelled.promise.then(() => undefined),
        ]);
        if (this.stopped || !channel || ![10, 11, 12].includes(channel.type) || channel.parent_id !== this.config.channelId) return;
        this.threads.add(channelId);
      }
      let text = content.trim();
      for (const mention of [`<@${this.botId}>`, `<@!${this.botId}>`]) {
        if (text === mention || text.startsWith(`${mention} `) || text.startsWith(`${mention}\n`)) {
          text = text.slice(mention.length).trimStart();
          break;
        }
      }
      if (!text && !(Array.isArray(message.attachments) && message.attachments.length)) return;
      let destination = channelId;
      try {
        if (channelId === this.config.channelId && [0, 5].includes(this.channelType)) {
          createdThreadKey = JSON.stringify([this.botId, typeof message.guild_id === "string" ? message.guild_id : "", messageId]);
          this.preparationTails.set(createdThreadKey, tail);
          const thread = await Promise.race([
            this.api.createThread(channelId, messageId, "jeo reply"),
            cancelled.promise.then(() => undefined),
          ]);
          if (this.stopped || !thread) return;
          destination = thread.id;
          this.threads.add(destination);
        }
      } catch (error) {
        if (this.stopped) return;
        if (error instanceof DiscordApiError && error.status === 401) this.fail("Discord authentication denied");
        else { this.deps.onError?.("Discord thread creation failed"); void this.emit("Unable to create a reply thread; check bot permissions.", undefined, channelId); }
        return;
      }
      progress = reaction("⏳");
      // handleCommand installs a normal prompt's canonical session tail before its
      // first await. Release admission now so sandbox controls can bypass that tail.
      command = this.handleCommand(message, text, destination);
    } finally {
      release();
    }
    try {
      const ok = await command;
      void progress.then(() => reaction("⏳", true)).then(() => reaction(ok ? "✅" : "❌"));
    } catch {
      void progress.then(() => reaction("⏳", true)).then(() => reaction("❌"));
      this.deps.onError?.("Discord command relay failed");
    }
  }

  private async handleCommand(message: Record<string, unknown>, text: string, destination: string): Promise<boolean> {
    const emit = (content: string, sessionId?: string) => this.emit(content, sessionId, destination);
    const sendPrompt = async (session: DiscordSession, body: string): Promise<boolean> => {
      if (/^\/sandbox(?:\s|$)/.test(body)) {
        const author = object(message.author) && typeof message.author.id === "string" ? message.author.id : "";
        if (!this.allowed.has(author)) return false;
        const result = await this.sandboxControl(session, body, author);
        await emit(result.output, session.sessionId);
        return result.ok;
      }
      if (this.queuedPrompts >= 128) { await emit("Session request queue is full.", session.sessionId); return false; }
      const generation = session.controlGeneration;
      const previous = this.promptTails.get(session.sessionId) ?? Promise.resolve();
      const ready = Promise.withResolvers<void>();
      const tail = previous.then(() => ready.promise);
      this.promptTails.set(session.sessionId, tail);
      this.queuedPrompts++;
      await previous;
      try {
      if (this.stopped || this.sessions.get(session.sessionId) !== session || session.controlGeneration !== generation) {
        await emit("Queued request cancelled because session control changed.", session.sessionId);
        return false;
      }
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
        const author = object(message.author) && typeof message.author.id === "string" ? message.author.id : "";
        const result = await this.remoteRequest(session, body || "Please inspect the attached files.", reqId, controlGeneration, author);
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
      } finally {
        this.queuedPrompts--;
        ready.resolve();
        if (this.promptTails.get(session.sessionId) === tail) this.promptTails.delete(session.sessionId);
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
    if ((text.startsWith("/") && !/^\/sandbox(?:\s|$)/.test(text)) || text.startsWith("!")) { await emit(HELP); return false; }

    const reference = object(message.message_reference) ? message.message_reference : undefined;
    const reply = reference && typeof reference.message_id === "string" && (reference.channel_id === undefined || reference.channel_id === message.channel_id)
      ? this.replies.get(reference.message_id) : undefined;
    const session = reply && (this.deps.now ?? Date.now)() - reply.at < 86_400_000 ? this.findSession(reply.sessionId) : undefined;
    if (!session) { await emit("Reply target is unknown or expired. Use /send <unique-session> <text> after /sessions."); return false; }
    return sendPrompt(session, text);
  }
}
