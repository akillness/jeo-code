/**
 * The managed Telegram daemon (gjc `notifications/telegram-daemon.ts` parity,
 * scoped down to jeo's subagent-remote-control surface — no forum topics, no
 * inline keyboards, no image attachments; see CHANGELOG 0.7.34 for what jeo
 * intentionally does not replicate from gjc's full notification stack).
 *
 * Runs as ONE long-lived background process (singleton, enforced by
 * `daemon-control.ts`'s lock file — Telegram allows only one `getUpdates`
 * long-poll owner per bot token). It:
 *
 *   - scans `<jeoHome>/notifications/sessions/*.json` for live session
 *     discovery files and connects a loopback WebSocket to each
 *     (`SessionNotifyEndpoint` on the other end);
 *   - sends a Telegram message on each subagent state EDGE (started → a
 *     terminal state), not on every poll tick;
 *   - long-polls Telegram `getUpdates` and dispatches `/subagents`,
 *     `/steer <sessionId> <subagentId> <message>`, `/cancel <sessionId>
 *     <subagentId>`, `/help` back into the matching session's WebSocket.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readGlobalConfig } from "../state";
import { notifySessionsDir } from "./paths";
import { acquireDaemonLock, isPidAlive } from "./daemon-control";
import { TelegramApi, type TelegramUpdate } from "./telegram-api";
import type { SubagentRecord } from "../subagent-registry";

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

// ── Pure helpers (unit-testable without network/ws) ────────────────────────────

export type NotifyEventKind = "started" | "completed" | "failed" | "cancelled";

export interface NotifyEvent {
  kind: NotifyEventKind;
  record: SubagentRecord;
}

/** Edge-triggered diff: only reports a transition INTO running (started) or OUT
 *  of running into a terminal state — never re-reports a steady "still running"
 *  or "still completed" on every poll tick. */
export function diffSubagentTransitions(prev: SubagentRecord[], next: SubagentRecord[]): NotifyEvent[] {
  const prevById = new Map(prev.map(r => [r.id, r]));
  const events: NotifyEvent[] = [];
  for (const rec of next) {
    const before = prevById.get(rec.id);
    if (!before) {
      if (rec.status === "running") events.push({ kind: "started", record: rec });
      continue;
    }
    if (before.status === "running" && rec.status !== "running") {
      events.push({ kind: rec.status as NotifyEventKind, record: rec });
    }
  }
  return events;
}

/** One icon per subagent status; a "started" event renders as the running icon. */
const STATUS_ICON: Record<SubagentRecord["status"], string> = { running: "▶", completed: "✅", failed: "❌", cancelled: "⏹" };

function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}

/** Short, human-typeable session id for Telegram commands: first 8 hex chars
 *  (dashes stripped) of the session's uuid. Matched by prefix at dispatch time. */
export function shortSessionId(sessionId: string): string {
  return sessionId.replace(/-/g, "").slice(0, 8);
}

export function formatNotifyEvent(shortId: string, cwd: string, ev: NotifyEvent): string {
  const header = `${STATUS_ICON[ev.kind === "started" ? "running" : ev.kind]} [${shortId}] ${projectName(cwd)} · ${ev.record.role} '${ev.record.id}' ${ev.kind}`;
  if (ev.kind === "started") return `${header}\n${ev.record.task}`;
  const resultPreview = (ev.record.result ?? "").slice(0, 500);
  return resultPreview ? `${header}\n${resultPreview}` : header;
}

export function formatSubagentsList(sessions: Array<{ sessionId: string; cwd: string; records: SubagentRecord[] }>): string {
  const withRecords = sessions.filter(s => s.records.length > 0);
  if (withRecords.length === 0) return "No subagents running.";
  const lines: string[] = [];
  for (const s of withRecords) {
    lines.push(`— ${shortSessionId(s.sessionId)} (${projectName(s.cwd)})`);
    for (const r of s.records) {
      lines.push(`  ${STATUS_ICON[r.status]} ${r.role} '${r.id}': ${r.task}`);
    }
  }
  return lines.join("\n");
}

export function parseSteerCommand(text: string): { shortId: string; subagentId: string; message: string } | undefined {
  const m = /^\/steer\s+(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(text.trim());
  if (!m) return undefined;
  return { shortId: m[1]!, subagentId: m[2]!, message: m[3]!.trim() };
}

export function parseCancelCommand(text: string): { shortId: string; subagentId: string } | undefined {
  const m = /^\/cancel\s+(\S+)\s+(\S+)\s*$/.exec(text.trim());
  if (!m) return undefined;
  return { shortId: m[1]!, subagentId: m[2]! };
}

export const HELP_TEXT =
  "jeo notify daemon commands:\n" +
  "/subagents — list running/recent subagents across every connected session\n" +
  "/steer <sessionId> <subagentId> <message> — send a live message into a running subagent\n" +
  "/cancel <sessionId> <subagentId> — cancel a running subagent\n" +
  "/help — show this message";

// ── Stateful daemon (network/ws — DI'd for tests) ───────────────────────────────

interface SessionConnection {
  sessionId: string;
  cwd: string;
  pid: number;
  ws: WebSocket;
  lastRecords: SubagentRecord[];
}

export interface TelegramDaemonOptions {
  chatId: string;
  telegram: TelegramApi;
  WebSocketImpl?: typeof WebSocket;
  readdir?: (dir: string) => Promise<string[]>;
  readFile?: (p: string) => Promise<string>;
  unlink?: (p: string) => Promise<void>;
  isPidAlive?: (pid: number) => boolean;
  scanIntervalMs?: number;
  ackTimeoutMs?: number;
}

export class TelegramDaemon {
  private readonly WS: typeof WebSocket;
  readonly sessions = new Map<string, SessionConnection>();
  private readonly pendingAcks = new Map<string, (ok: boolean) => void>();
  private updateOffset: number | undefined;
  private stopped = false;
  private scanTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: TelegramDaemonOptions) {
    this.WS = opts.WebSocketImpl ?? WebSocket;
  }

  private async notify(text: string): Promise<void> {
    try {
      await this.opts.telegram.sendMessage(this.opts.chatId, text);
    } catch {
      // best-effort — a failed push must never crash the daemon loop.
    }
  }

  async scanSessions(): Promise<void> {
    const readdir = this.opts.readdir ?? (d => fs.readdir(d));
    let files: string[];
    try {
      files = await readdir(notifySessionsDir());
    } catch {
      return;
    }
    const readFile = this.opts.readFile ?? (p => fs.readFile(p, "utf-8"));
    const unlink = this.opts.unlink ?? (p => fs.unlink(p));
    const pidAlive = this.opts.isPidAlive ?? isPidAlive;
    for (const file of files.filter(f => f.endsWith(".json"))) {
      const sessionId = path.basename(file, ".json");
      if (this.sessions.has(sessionId)) continue;
      const filePath = path.join(notifySessionsDir(), file);
      try {
        const raw = await readFile(filePath);
        const endpoint = JSON.parse(raw) as { url: string; token: string; pid: number; cwd: string };
        if (!pidAlive(endpoint.pid)) {
          await unlink(filePath).catch(() => {});
          continue;
        }
        this.connectSession(sessionId, endpoint);
      } catch {
        continue;
      }
    }
  }

  private connectSession(sessionId: string, endpoint: { url: string; token: string; pid: number; cwd: string }): void {
    const ws = new this.WS(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
    const conn: SessionConnection = { sessionId, cwd: endpoint.cwd, pid: endpoint.pid, ws, lastRecords: [] };
    this.sessions.set(sessionId, conn);
    ws.addEventListener("message", (ev: MessageEvent) => {
      void this.handleSessionMessage(conn, String(ev.data));
    });
    ws.addEventListener("close", () => {
      if (this.sessions.get(sessionId) === conn) this.sessions.delete(sessionId);
    });
  }

  async handleSessionMessage(conn: SessionConnection, raw: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "snapshot" && Array.isArray(msg.subagents)) {
      const next = msg.subagents as SubagentRecord[];
      const events = diffSubagentTransitions(conn.lastRecords, next);
      conn.lastRecords = next;
      for (const ev of events) {
        await this.notify(formatNotifyEvent(shortSessionId(conn.sessionId), conn.cwd, ev));
      }
      return;
    }
    if (msg.type === "ack" && typeof msg.reqId === "string") {
      const resolve = this.pendingAcks.get(msg.reqId);
      if (resolve) {
        resolve(Boolean(msg.ok));
        this.pendingAcks.delete(msg.reqId);
      }
    }
  }

  private findSession(shortId: string): SessionConnection | undefined {
    const needle = shortId.toLowerCase();
    for (const conn of this.sessions.values()) {
      if (shortSessionId(conn.sessionId) === needle || conn.sessionId.toLowerCase().startsWith(needle)) return conn;
    }
    return undefined;
  }

  private sendRequest(conn: SessionConnection, frame: Record<string, unknown>): Promise<boolean> {
    const reqId = crypto.randomUUID();
    const { promise, resolve } = Promise.withResolvers<boolean>();
    this.pendingAcks.set(reqId, resolve);
    setTimeout(() => {
      if (this.pendingAcks.has(reqId)) {
        this.pendingAcks.delete(reqId);
        resolve(false);
      }
    }, this.opts.ackTimeoutMs ?? 3_000);
    try {
      conn.ws.send(JSON.stringify({ ...frame, reqId }));
    } catch {
      this.pendingAcks.delete(reqId);
      resolve(false);
    }
    return promise;
  }

  async handleInboundText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "/subagents") {
      const sessions = [...this.sessions.values()].map(c => ({ sessionId: c.sessionId, cwd: c.cwd, records: c.lastRecords }));
      await this.notify(formatSubagentsList(sessions));
      return;
    }
    if (trimmed === "/help" || trimmed === "/start") {
      await this.notify(HELP_TEXT);
      return;
    }
    const steer = parseSteerCommand(trimmed);
    if (steer) {
      const conn = this.findSession(steer.shortId);
      if (!conn) {
        await this.notify(`No connected session matches '${steer.shortId}'. Send /subagents to see live sessions.`);
        return;
      }
      const ok = await this.sendRequest(conn, { type: "steer", id: steer.subagentId, message: steer.message });
      await this.notify(ok ? `Steered '${steer.subagentId}'.` : `Steer failed — '${steer.subagentId}' is unknown or not running.`);
      return;
    }
    const cancel = parseCancelCommand(trimmed);
    if (cancel) {
      const conn = this.findSession(cancel.shortId);
      if (!conn) {
        await this.notify(`No connected session matches '${cancel.shortId}'. Send /subagents to see live sessions.`);
        return;
      }
      const ok = await this.sendRequest(conn, { type: "cancel", ids: [cancel.subagentId] });
      await this.notify(ok ? `Cancelled '${cancel.subagentId}'.` : `Cancel failed — '${cancel.subagentId}' is unknown or already finished.`);
      return;
    }
    if (trimmed.startsWith("/")) await this.notify(`Unrecognized command. ${HELP_TEXT}`);
  }

  /** Trust boundary: a bot's username is publicly discoverable, so ANY Telegram
   *  user can message it. Only the paired chat (the one that ran
   *  `jeo notify setup`) may steer/cancel subagents; everything else is dropped
   *  without a reply (replying would leak that the bot is live). */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message;
    if (!msg?.text) return;
    if (String(msg.chat.id) !== this.opts.chatId) return;
    await this.handleInboundText(msg.text);
  }

  private async pollTelegramLoop(): Promise<void> {
    while (!this.stopped) {
      let res;
      try {
        res = await this.opts.telegram.getUpdates(this.updateOffset, 25);
      } catch {
        await sleep(2_000);
        continue;
      }
      if (!res.ok) {
        // e.g. 409 Conflict (another getUpdates owner) or 401 (revoked token) —
        // without a pause this would hot-loop against the API.
        await sleep(2_000);
        continue;
      }
      for (const update of res.result) {
        this.updateOffset = update.update_id + 1;
        await this.handleUpdate(update);
      }
    }
  }

  /** Blocks (long-poll loop) until `stop()` is called. */
  async start(): Promise<void> {
    await this.scanSessions();
    this.scanTimer = setInterval(() => void this.scanSessions(), this.opts.scanIntervalMs ?? 3_000);
    await this.pollTelegramLoop();
  }

  stop(): void {
    this.stopped = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    for (const conn of this.sessions.values()) {
      try {
        conn.ws.close();
      } catch {}
    }
    this.sessions.clear();
  }
}

// ── CLI entrypoint (`jeo notify-daemon-run`, internal) ──────────────────────────

export async function runNotifyDaemonForeground(): Promise<void> {
  const lock = await acquireDaemonLock();
  if (!lock) {
    process.stderr.write("[jeo notify-daemon] another daemon instance already holds the lock; exiting.\n");
    return;
  }
  try {
    const config = await readGlobalConfig();
    const botToken = config.notifications?.telegram?.botToken;
    const chatId = config.notifications?.telegram?.chatId;
    if (!config.notifications?.enabled || !botToken || !chatId) {
      process.stderr.write("[jeo notify-daemon] notifications not configured — run `jeo notify setup` first.\n");
      return;
    }
    const daemon = new TelegramDaemon({ chatId, telegram: new TelegramApi(botToken) });
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      daemon.stop();
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    await daemon.start();
  } finally {
    await lock.release();
  }
}
