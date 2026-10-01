import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SlackApi, SlackApiError, isSlackChannelId, isSlackUserId, isSlackTimestamp, slackSocketUrl, type SlackIdentity, type SlackMessage } from "./slack-api";
import { notifySessionsDir } from "./paths";
import { isPidAlive } from "./daemon-control";
import { parseSessionEndpoint } from "./session-discovery";

export interface SlackDaemonConfig {
  botToken: string;
  appToken: string;
  channelId: string;
  allowedUserIds: string[];
}
export interface SlackDaemonDependencies {
  api?: Pick<SlackApi, "getMe" | "getChannel" | "openConnection" | "sendMessage" | "stop">;
  WebSocketImpl?: typeof WebSocket;
  SocketWebSocketImpl?: typeof WebSocket;
  readdir?: (dir: string) => Promise<string[]>;
  readFile?: (file: string) => Promise<string>;
  isPidAlive?: (pid: number) => boolean;
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => Timer;
  clearTimeout?: (timer: Timer) => void;
  scanIntervalMs?: number;
  ackTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  maxReconnects?: number;
  onError?: (message: string) => void;
  onFatal?: (message: string) => void;
}
interface AgentState { id: string; status: string; role: string; task: string; result?: string }
interface SlackSession { sessionId: string; cwd: string; pid: number; ws: WebSocket; verified: boolean; records: AgentState[] }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
const HELP = "Slack controls: send @bot /command; registered Slack slash commands and delivered plain /commands also work.\n/sessions\n/subagents\n/send <unique-session> <text>\n/steer <unique-session> <subagent-id> <text>\n/cancel <unique-session> <subagent-id>\nReply in a session notification thread to send that session ordinary text. Other slash commands are not executed.";

/** Socket acknowledgements confirm receipt only; all local controls separately require a matching session ACK. */
export class SlackDaemon {
  readonly sessions = new Map<string, SlackSession>();
  private readonly api: NonNullable<SlackDaemonDependencies["api"]>;
  private readonly timers = new Set<Timer>();
  private readonly pending = new Map<string, { session: SlackSession; finish: (ok: boolean) => void }>();
  private readonly replies = new Map<string, { sessionId: string; at: number }>();
  private readonly seen = new Set<string>();
  private readonly allowed: Set<string>;
  private stopped = true;
  private started = false;
  private scanning = false;
  private ready = false;
  private socket: WebSocket | undefined;
  private identity: SlackIdentity | undefined;
  private handshakeTimer: Timer | undefined;
  private reconnectTimer: Timer | undefined;
  private stabilityTimer: Timer | undefined;
  private reconnects = 0;
  private outgoing = Promise.resolve();
  private queued = 0;

  constructor(private readonly config: SlackDaemonConfig, private readonly deps: SlackDaemonDependencies = {}) {
    if (typeof config.botToken !== "string" || !config.botToken.trim() || typeof config.appToken !== "string" || !config.appToken.trim() ||
        !isSlackChannelId(config.channelId) || !Array.isArray(config.allowedUserIds) || !config.allowedUserIds.length ||
        config.allowedUserIds.some(id => !isSlackUserId(id))) throw new Error("Slack requires bot/app tokens, a channel ID and explicit allowed human user IDs");
    this.allowed = new Set(config.allowedUserIds);
    this.api = deps.api ?? new SlackApi(config.botToken, config.appToken);
  }

  private later(callback: () => void, ms: number): Timer {
    const timer = (this.deps.setTimeout ?? setTimeout)(() => { this.timers.delete(timer); if (!this.stopped) callback(); }, ms);
    this.timers.add(timer);
    return timer;
  }
  private clear(timer: Timer | undefined): void {
    if (timer === undefined) return;
    (this.deps.clearTimeout ?? clearTimeout)(timer);
    this.timers.delete(timer);
  }

  async start(): Promise<void> {
    if (this.started) { if (this.stopped) throw new Error("Slack daemon instance has stopped"); return; }
    this.started = true;
    this.stopped = false;
    try {
      this.identity = await this.api.getMe();
      if (this.stopped) return;
      const channel = await this.api.getChannel(this.config.channelId);
      if (this.stopped) return;
      if (channel.id !== this.config.channelId || channel.is_archived === true || (channel.is_im !== true && channel.is_member !== true) ||
          (channel.context_team_id !== undefined && channel.context_team_id !== this.identity.team_id)) throw new Error("Slack channel identity mismatch");
      await this.connectSocket();
      if (!this.stopped) this.scheduleScan();
    } catch (error) {
      this.stop();
      if (error instanceof SlackApiError) throw error;
      throw new Error("Slack startup failed: verify bot, app, channel and permissions");
    }
  }

  stop(): void {
    this.stopped = true;
    this.ready = false;
    for (const timer of this.timers) (this.deps.clearTimeout ?? clearTimeout)(timer);
    this.timers.clear();
    const socket = this.socket;
    this.socket = undefined;
    try { socket?.close(1000); } catch {}
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
    try { this.deps.onError?.(message); } finally { this.deps.onFatal?.(message); }
  }

  private async connectSocket(): Promise<void> {
    if (this.stopped) return;
    this.reconnectTimer = undefined;
    try {
      const connection = await this.api.openConnection();
      if (this.stopped) return;
      let url: string;
      try { url = slackSocketUrl(connection.url); } catch { this.fail("Invalid Slack Socket Mode URL"); return; }
      const WS = this.deps.SocketWebSocketImpl ?? this.deps.WebSocketImpl ?? WebSocket;
      const ws = new WS(url);
      this.socket = ws;
      this.handshakeTimer = this.later(() => this.reconnect(), this.deps.handshakeTimeoutMs ?? 30_000);
      ws.onmessage = async event => {
        if (this.stopped || this.socket !== ws || typeof event.data !== "string" || event.data.length > 1_048_576) return;
        let frame: unknown;
        try { frame = JSON.parse(event.data); } catch { return; }
        if (!object(frame)) return;
        if (typeof frame.envelope_id === "string" && frame.envelope_id.length > 0 && frame.envelope_id.length <= 256) {
          try { ws.send(JSON.stringify({ envelope_id: frame.envelope_id })); } catch { this.reconnect(); return; }
        }
        if (frame.type === "hello") {
          if (this.ready) return;
          if (!object(frame.connection_info) || frame.connection_info.app_id !== this.identity?.app_id) { this.fail("Slack app token does not match bot identity"); return; }
          this.ready = true;
          this.clear(this.handshakeTimer);
          // Reset only after a stable connection, not a rapid hello/close reconnect loop.
          this.stabilityTimer = this.later(() => { this.reconnects = 0; }, 60_000);
          await this.scanSessions();
        } else if (frame.type === "disconnect") {
          if (frame.reason === "link_disabled") this.fail("Slack Socket Mode disabled");
          else this.reconnect();
        } else if (this.ready && typeof frame.envelope_id === "string" && frame.envelope_id.length > 0 && frame.envelope_id.length <= 256) {
          await this.handleEnvelope(frame).catch(() => { if (!this.stopped) this.deps.onError?.("Slack command relay failed"); });
          await this.outgoing;
        }
      };
      ws.onclose = () => { if (!this.stopped && this.socket === ws) this.reconnect(); };
      ws.onerror = () => { if (!this.stopped && this.socket === ws) this.reconnect(); };
    } catch (error) {
      if (this.stopped) return;
      if (error instanceof SlackApiError && (error.status === 401 || error.status === 403)) this.fail("Slack authentication or permission denied");
      else this.reconnect();
    }
  }
  private reconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) return;
    this.ready = false;
    this.clear(this.handshakeTimer);
    this.clear(this.stabilityTimer);
    const ws = this.socket;
    this.socket = undefined;
    try { ws?.close(1000); } catch {}
    const max = Math.max(0, Math.min(this.deps.maxReconnects ?? 8, 8));
    if (++this.reconnects > max) { this.fail("Slack Socket Mode reconnect limit reached"); return; }
    this.reconnectTimer = this.later(() => { void this.connectSocket(); }, Math.min(1000 * 2 ** (this.reconnects - 1), 30_000));
  }

  private scheduleScan(): void {
    this.later(() => { void this.scanSessions().finally(() => { if (!this.stopped) this.scheduleScan(); }); }, this.deps.scanIntervalMs ?? 3000);
  }
  async scanSessions(): Promise<void> {
    if (this.stopped || !this.ready || this.scanning) return;
    this.scanning = true;
    try {
      const dir = notifySessionsDir();
      const files = await (this.deps.readdir ?? (p => fs.readdir(p)))(dir).catch(() => []);
      for (const file of files) {
        if (this.stopped || !this.ready) return;
        if (!/^[a-zA-Z0-9_-]+\.json$/.test(file)) continue;
        const id = file.slice(0, -5);
        if (this.sessions.has(id)) continue;
        const raw = await (this.deps.readFile ?? (p => fs.readFile(p, "utf8")))(path.join(dir, file)).catch(() => "");
        if (this.stopped || !this.ready) return;
        const info = parseSessionEndpoint(raw);
        if (!info || !(this.deps.isPidAlive ?? isPidAlive)(info.pid)) continue;
        const url = new URL(info.url);
        url.searchParams.set("token", info.token);
        try {
          const WS = this.deps.WebSocketImpl ?? WebSocket;
          const ws = new WS(url.href);
          const session: SlackSession = { sessionId: id, cwd: info.cwd, pid: info.pid, ws, verified: false, records: [] };
          this.sessions.set(id, session);
          const timeout = this.later(() => { if (!session.verified) { this.disconnectSession(session); try { ws.close(); } catch {} } }, 10_000);
          ws.onmessage = event => {
            if (this.stopped || this.sessions.get(id) !== session || typeof event.data !== "string" || event.data.length > 1_048_576) return;
            let frame: unknown;
            try { frame = JSON.parse(event.data); } catch { return; }
            if (!object(frame)) return;
            if (!session.verified) {
              if (frame.type !== "snapshot" || frame.sessionId !== id || frame.pid !== info.pid || !Array.isArray(frame.subagents)) {
                this.clear(timeout); this.disconnectSession(session); try { ws.close(); } catch {} return;
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
  private disconnectSession(session: SlackSession): void {
    if (this.sessions.get(session.sessionId) !== session) return;
    this.sessions.delete(session.sessionId);
    for (const request of this.pending.values()) if (request.session === session) request.finish(false);
  }
  private onSessionFrame(session: SlackSession, frame: Record<string, unknown>): void {
    if (frame.type === "ack" && typeof frame.reqId === "string" && typeof frame.ok === "boolean") {
      const request = this.pending.get(frame.reqId);
      if (request?.session === session) request.finish(frame.ok);
      return;
    }
    if (frame.sessionId !== session.sessionId) return;
    const header = `[${session.sessionId}]`;
    if (frame.type === "snapshot" && frame.pid === session.pid && Array.isArray(frame.subagents)) {
      const records = frame.subagents.filter((r): r is AgentState => object(r) && typeof r.id === "string" && typeof r.role === "string" &&
        typeof r.task === "string" && typeof r.status === "string" && ["running", "completed", "failed", "cancelled"].includes(r.status) &&
        (r.result === undefined || typeof r.result === "string"));
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
  private emit(text: string, sessionId?: string, threadTs?: string): void {
    if (this.stopped) return;
    if (this.queued >= 128) { this.deps.onError?.("Slack outbound queue full"); return; }
    this.queued++;
    this.outgoing = this.outgoing.then(async () => {
      if (this.stopped) return;
      const messages = await this.api.sendMessage(this.config.channelId, text, threadTs);
      this.rememberReplies(messages, sessionId, threadTs);
    }).catch(error => {
      if (this.stopped) return;
      if (error instanceof SlackApiError) this.rememberReplies(error.sentMessages, sessionId, threadTs);
      if (error instanceof SlackApiError && (error.status === 401 || error.status === 403)) this.fail("Slack authentication or permission denied");
      else this.deps.onError?.("Slack notification delivery failed");
    }).finally(() => { this.queued--; });
  }
  private rememberReplies(messages: SlackMessage[], sessionId?: string, threadTs?: string): void {
    if (this.stopped || !sessionId) return;
    for (const message of messages) {
      this.replies.set(threadTs ?? message.ts, { sessionId, at: (this.deps.now ?? Date.now)() });
      if (this.replies.size > 1024) this.replies.delete(this.replies.keys().next().value!);
    }
  }
  private findSession(prefix: string): SlackSession | undefined {
    const live = [...this.sessions.values()].filter(s => s.verified && s.ws.readyState === 1);
    const exact = live.find(s => s.sessionId === prefix);
    if (exact) return exact;
    const matches = live.filter(s => s.sessionId.startsWith(prefix) || s.sessionId.replace(/-/g, "").startsWith(prefix));
    return matches.length === 1 ? matches[0] : undefined;
  }
  private request(session: SlackSession, frame: Record<string, unknown>): Promise<boolean> {
    if (this.stopped || !session.verified || session.ws.readyState !== 1 || this.pending.size >= 128) return Promise.resolve(false);
    const reqId = crypto.randomUUID();
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const timer = this.later(() => finish(false), this.deps.ackTimeoutMs ?? 5000);
    const finish = (ok: boolean) => { this.clear(timer); this.pending.delete(reqId); resolve(ok); };
    this.pending.set(reqId, { session, finish });
    try { session.ws.send(JSON.stringify({ ...frame, reqId })); } catch { finish(false); }
    return promise;
  }

  private async handleEnvelope(frame: Record<string, unknown>): Promise<void> {
    const payload = frame.payload;
    if (!object(payload) || payload.team_id !== this.identity?.team_id) return;
    const keys = [`envelope:${frame.envelope_id}`];
    let text: string;
    let threadTs: string | undefined;
    if (frame.type === "events_api") {
      const event = payload.event;
      if (payload.type !== "event_callback" || payload.api_app_id !== this.identity?.app_id || typeof payload.event_id !== "string" ||
          !payload.event_id || payload.event_id.length > 256 || !object(event) || !["message", "app_mention"].includes(String(event.type)) ||
          event.channel !== this.config.channelId || !isSlackUserId(event.user) || !this.allowed.has(event.user) || event.user === this.identity?.user_id ||
          "bot_id" in event || "bot_profile" in event || "subtype" in event || "app_id" in event ||
          (event.team !== undefined && event.team !== this.identity?.team_id) || !isSlackTimestamp(event.ts) ||
          typeof event.text !== "string" || event.text.length > 4000 || !event.text.trim() ||
          (event.thread_ts !== undefined && !isSlackTimestamp(event.thread_ts))) return;
      text = event.text;
      threadTs = event.thread_ts as string | undefined;
      keys.push(`event:${payload.event_id}`, `message:${event.channel}:${event.ts}`);
    } else if (frame.type === "slash_commands") {
      if (payload.channel_id !== this.config.channelId || !isSlackUserId(payload.user_id) || !this.allowed.has(payload.user_id) ||
          payload.user_id === this.identity?.user_id || (payload.api_app_id !== undefined && payload.api_app_id !== this.identity?.app_id) ||
          typeof payload.command !== "string" || !/^\/(sessions|subagents|send|steer|cancel|help)$/.test(payload.command) ||
          typeof payload.text !== "string" || payload.text.length > 4000 || typeof payload.trigger_id !== "string" || !payload.trigger_id || payload.trigger_id.length > 256) return;
      text = `${payload.command} ${payload.text}`;
      keys.push(`trigger:${payload.trigger_id}`);
    } else return;
    if (keys.some(key => this.seen.has(key))) return;
    for (const key of keys) { this.seen.add(key); if (this.seen.size > 6144) this.seen.delete(this.seen.values().next().value!); }
    text = text.trim();
    const mention = `<@${this.identity!.user_id}>`;
    const addressed = text.startsWith(mention);
    if (text.startsWith(mention)) text = text.slice(mention.length).trim();
    text = text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    if (!text) return;
    if (text === "/sessions" || text === "/subagents") {
      const sessions = [...this.sessions.values()].filter(s => s.verified && s.ws.readyState === 1);
      this.emit(sessions.length ? sessions.map(s => `[${s.sessionId}] ${s.cwd}${text === "/subagents" ? s.records.map(r => `\n  ${r.id}: ${r.status} ${r.role} — ${r.task}`).join("") : ""}`).join("\n") : "No connected sessions.", undefined, threadTs);
      return;
    }
    if (text === "/help") { this.emit(HELP, undefined, threadTs); return; }
    const command = /^\/(send|steer|cancel)\s+(\S+)\s+([\s\S]+)$/.exec(text);
    if (command) {
      const session = this.findSession(command[2]!);
      if (!session) { this.emit("Session not found or prefix ambiguous. Use /sessions and a unique ID.", undefined, threadTs); return; }
      const body = command[3]!.trim();
      let local: Record<string, unknown>;
      if (command[1] === "send") {
        if (body.startsWith("/")) { this.emit("Remote slash commands are disabled; send ordinary prompt text.", undefined, threadTs); return; }
        local = { type: "user_message", text: body };
      } else {
        const args = command[1] === "steer" ? /^(\S+)\s+([\s\S]+)$/.exec(body) : /^(\S+)$/.exec(body);
        if (!args) { this.emit(HELP, undefined, threadTs); return; }
        local = command[1] === "steer" ? { type: "steer", id: args[1], message: args[2] } : { type: "cancel", ids: [args[1]] };
      }
      const ok = await this.request(session, local);
      this.emit(ok ? "Session acknowledged command (accepted, not completed)." : "Command not acknowledged (unavailable, rejected or timed out).", session.sessionId, threadTs);
      return;
    }
    if (text.startsWith("/")) { this.emit(HELP, undefined, threadTs); return; }
    const reply = threadTs ? this.replies.get(threadTs) : undefined;
    if (!addressed && !reply) return;
    const session = reply && (this.deps.now ?? Date.now)() - reply.at < 86_400_000 ? this.findSession(reply.sessionId) : undefined;
    if (!session) { this.emit("Reply target is unknown or expired. Use /send <unique-session> <text> after /sessions.", undefined, threadTs); return; }
    const ok = await this.request(session, { type: "user_message", text });
    this.emit(ok ? "Session acknowledged command (accepted, not completed)." : "Command not acknowledged (unavailable, rejected or timed out).", session.sessionId, threadTs);
  }
}
