/**
 * The managed Telegram daemon (gjc `notifications/telegram-daemon.ts` parity).
 * Runs as ONE long-lived background process (singleton, enforced by
 * `daemon-control.ts`'s lock file — Telegram allows only one `getUpdates`
 * long-poll owner per bot token). It:
 *
 *   - scans `<jeoHome>/notifications/sessions/*.json` for live session
 *     discovery files and connects a loopback WebSocket to each
 *     (`SessionNotifyEndpoint` on the other end);
 *   - sends a Telegram message on each subagent state EDGE (started → a
 *     terminal state), not on every poll tick, attaching an inline "Cancel"
 *     keyboard button for the running subagent;
 *   - long-polls Telegram `getUpdates` and dispatches `/subagents`,
 *     `/steer <sessionId> <subagentId> <message>`, `/cancel <sessionId>
 *     <subagentId>`, `/help` — plus inline-keyboard button taps
 *     (`callback_query`) — back into the matching session's WebSocket.
 *
 * gjc-parity surface added on top of the plain-text core: forum topics (all
 * pushes carry the configured `message_thread_id`, inbound is topic-filtered),
 * inline keyboards (cancel buttons + `callback_query` handling), image
 * attachments (a session may push a `{type:"photo"}` frame relayed via
 * `sendPhoto`), a shared `RateLimitPool` (burst/steady-rate protection across
 * every session sharing this one bot token), and — when
 * `notifications.telegram.perSessionTopics` is enabled — a dynamic,
 * PER-SESSION forum topic (via `TopicRegistry`) that mirrors that session's
 * OWN activity (`identity_header`/`context_update`/`turn_stream` frames) and
 * accepts free-text replies (routed back as `user_message`) and
 * `/verbose`/`/lean`/`/redact` config commands, ALL scoped to that one
 * session's topic. The flat/global `topicId` behavior below is UNCHANGED when
 * `perSessionTopics` is off (or unset) — zero regression risk for existing
 * setups.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readGlobalConfig } from "../state";
import { notifySessionsDir, notifyTopicsPath } from "./paths";
import { acquireDaemonLock, isPidAlive } from "./daemon-control";
import { TelegramApi, type TelegramUpdate, type TelegramCallbackQuery, type InlineKeyboardMarkup, type InlineKeyboardButton } from "./telegram-api";
import { TopicRegistry, type TopicRegistryState } from "./topic-registry";
import { RateLimitPool } from "./rate-limit-pool";
import { parseInThreadConfigCommand } from "./config-commands";
import { markdownToTelegramHtml, splitTelegramHtml } from "./telegram-html";
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
  "/cancel <sessionId> <subagentId> — cancel a running subagent\n" +
  "/help — show this message\n" +
  "(running subagents also carry an inline ⏹ Cancel button — tap it instead of typing /cancel)\n\n" +
  "Inside a session's OWN topic (when per-session topics are enabled): reply with any " +
  "text to steer that session directly, or use /verbose, /lean, /verbosity lean|verbose, " +
  "/redact on|off to adjust how that session mirrors its activity here.";

// ── Inline keyboards / callback data (gjc parity) ───────────────────────────────

/** Encode an inline-button cancel target. Kept short to stay under Telegram's
 *  64-byte `callback_data` cap. */
export function cancelCallbackData(shortId: string, subagentId: string): string {
  return `cancel:${shortId}:${subagentId}`;
}

/** Parse a `callback_data` payload produced by `cancelCallbackData`. */
export function parseCallbackData(
  data: string,
): { action: "cancel"; shortId: string; subagentId: string } | undefined {
  const m = /^cancel:([^:]+):([\s\S]+)$/.exec(data);
  if (!m) return undefined;
  return { action: "cancel", shortId: m[1]!, subagentId: m[2]! };
}

/** One ⏹ Cancel button (its own row) targeting a single running subagent. */
function cancelButton(shortId: string, rec: SubagentRecord): InlineKeyboardButton {
  return { text: `⏹ Cancel ${rec.role} '${rec.id}'`, callback_data: cancelCallbackData(shortId, rec.id) };
}

/** Inline keyboard with one ⏹ Cancel button per RUNNING subagent across every
 *  connected session; returns undefined when nothing is running (no keyboard to
 *  attach). */
export function buildSubagentsKeyboard(
  sessions: Array<{ sessionId: string; records: SubagentRecord[] }>,
): InlineKeyboardMarkup | undefined {
  const rows: InlineKeyboardButton[][] = [];
  for (const s of sessions) {
    for (const r of s.records) {
      if (r.status === "running") rows.push([cancelButton(shortSessionId(s.sessionId), r)]);
    }
  }
  return rows.length ? { inline_keyboard: rows } : undefined;
}


// ── Stateful daemon (network/ws — DI'd for tests) ───────────────────────────────

interface SessionConnection {
  sessionId: string;
  cwd: string;
  pid: number;
  ws: WebSocket;
  lastRecords: SubagentRecord[];
  /** Latest identity, once an `identity_header` frame arrives — used to name/
   *  rename the session's forum topic. `undefined` until then (topic still
   *  gets created eagerly with a provisional short-id name, gjc parity). */
  identity?: { repo: string; branch?: string; cwd: string };
  /** True once this session's per-session topic creation has been attempted
   *  and failed (e.g. Threaded Mode off) — stops a retry storm; falls back to
   *  no per-session mirroring for the rest of this connection's lifetime. */
  topicFailed?: boolean;
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
  /** Forum-topic thread id (message_thread_id). When set, every push is sent
   *  into this topic and inbound messages/taps from other topics are ignored.
   *  Ignored for a session with its OWN per-session topic when
   *  `perSessionTopics` is true. */
  topicId?: number;
  /** Auto-create/manage one forum topic PER SESSION instead of the single flat
   *  `topicId` above (see the file header doc). Off by default. */
  perSessionTopics?: boolean;
  /** Injectable persistence for the per-session topic map — defaults to
   *  reading/writing `notifyTopicsPath()` via `fs`. */
  loadTopicState?: () => Promise<TopicRegistryState>;
  saveTopicState?: (state: TopicRegistryState) => Promise<void>;
  /** Injectable clock for `RateLimitPool` determinism in tests. */
  now?: () => number;
  /** Injectable temp-file writer for downloaded inbound attachments — defaults
   *  to a real `os.tmpdir()` write. Returns the written file's absolute path. */
  writeTempFile?: (bytes: Uint8Array, suggestedName: string) => Promise<string>;
  /** Injectable cap (bytes) on an inbound photo/document download, passed
   *  through to `TelegramApi.downloadFile` — defaults to that method's own
   *  conservative fixed default (`MAX_TELEGRAM_DOWNLOAD_BYTES`) when unset. */
  maxAttachmentBytes?: number;
}

/** Outbound payload the shared `RateLimitPool` schedules; `flushPool` maps each
 *  variant onto the matching Bot API call. */
type OutboundPayload =
  | { kind: "text"; chatId: string; text: string; topicId?: number; replyMarkup?: InlineKeyboardMarkup; html?: boolean }
  | { kind: "photo"; chatId: string; photo: string; topicId?: number; caption?: string; replyMarkup?: InlineKeyboardMarkup };

export class TelegramDaemon {
  private readonly WS: typeof WebSocket;
  readonly sessions = new Map<string, SessionConnection>();
  private readonly pendingAcks = new Map<string, (ok: boolean) => void>();
  private updateOffset: number | undefined;
  private stopped = false;
  private scanTimer: ReturnType<typeof setInterval> | undefined;
  private poolTimer: ReturnType<typeof setInterval> | undefined;
  /** `undefined` when `perSessionTopics` is off — the flat/global `topicId`
   *  path never touches this. */
  private readonly topics: TopicRegistry | undefined;
  private readonly pool: RateLimitPool<OutboundPayload>;

  constructor(private readonly opts: TelegramDaemonOptions) {
    this.WS = opts.WebSocketImpl ?? WebSocket;
    this.topics = opts.perSessionTopics ? new TopicRegistry() : undefined;
    this.pool = new RateLimitPool<OutboundPayload>({ now: opts.now });
  }

  private async notify(
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
    opts?: { topicId?: number; sessionId?: string; html?: boolean },
  ): Promise<void> {
    this.pool.submit({
      sessionId: opts?.sessionId ?? "__global__",
      lane: "finalized",
      payload: { kind: "text", chatId: this.opts.chatId, text, topicId: opts?.topicId ?? this.opts.topicId, replyMarkup, html: opts?.html },
    });
    await this.flushPool();
  }

  private async notifyPhoto(
    photo: string,
    caption?: string,
    replyMarkup?: InlineKeyboardMarkup,
    opts?: { topicId?: number; sessionId?: string },
  ): Promise<void> {
    this.pool.submit({
      sessionId: opts?.sessionId ?? "__global__",
      lane: "finalized",
      payload: { kind: "photo", chatId: this.opts.chatId, photo, topicId: opts?.topicId ?? this.opts.topicId, caption, replyMarkup },
    });
    await this.flushPool();
  }

  private async answerCallback(id: string, text?: string): Promise<void> {
    try {
      await this.opts.telegram.answerCallbackQuery(id, text !== undefined ? { text } : {});
    } catch {
      // best-effort — acknowledging the tap is nice-to-have, not load-bearing.
    }
  }

  /** Grant queued pool items tokens and actually dispatch them via the Bot API.
   *  Called after every `submit()` (drains whatever tokens are free RIGHT NOW —
   *  the common case, near-synchronous like the pre-pool behavior) AND by a
   *  250ms timer (catches anything that queued because the burst capacity was
   *  briefly exhausted — e.g. a large fan-out's subagents all finishing near-
   *  simultaneously). `splitTelegramHtml` is applied to EVERY text send (not
   *  just HTML ones — it degrades to plain char-boundary splitting when no
   *  tags are present), so nothing this daemon sends can exceed Telegram's
   *  4096-char hard limit regardless of source. */
  private async flushPool(): Promise<void> {
    const granted = this.pool.drain();
    for (const item of granted) {
      const p = item.payload;
      try {
        if (p.kind === "text") {
          const chunks = splitTelegramHtml(p.text);
          for (let i = 0; i < chunks.length; i++) {
            await this.opts.telegram.sendMessage(p.chatId, chunks[i]!, {
              messageThreadId: p.topicId,
              // A reply keyboard belongs on the LAST fragment a split reply ends on.
              replyMarkup: i === chunks.length - 1 ? p.replyMarkup : undefined,
              parseMode: p.html ? "HTML" : undefined,
            });
          }
        } else {
          await this.opts.telegram.sendPhoto(p.chatId, p.photo, { messageThreadId: p.topicId, caption: p.caption, replyMarkup: p.replyMarkup });
        }
      } catch {
        // best-effort — a failed push must never crash the daemon loop.
      }
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

  /** Resolve the topic to push INTO for `conn`: its own per-session topic
   *  (created on first use, cached thereafter) when `perSessionTopics` is on
   *  and creation hasn't already failed for this connection; the flat/global
   *  `topicId` otherwise (unchanged pre-Tier-2 behavior). Never throws — a
   *  creation failure (e.g. Threaded Mode off in @BotFather) is remembered on
   *  `conn.topicFailed` so it is not retried every single frame. */
  private async resolveTopicId(conn: SessionConnection): Promise<number | undefined> {
    if (!this.opts.perSessionTopics || !this.topics || conn.topicFailed) return this.opts.topicId;
    // Fail-closed privacy gate (contract requirement): per-session topics carry
    // that session's OWN activity mirroring + accept free-text steering — both
    // are only safe in a confirmed 1:1 private DM. A group/channel `chatId`
    // (e.g. misconfigured `jeo notify setup`) must NEVER get per-session
    // topics/routing; it silently falls back to the flat/global `topicId`
    // instead (still fully functional for subagent-status pushes, just without
    // the per-session surface). Checked once per daemon lifetime and cached —
    // chat type cannot change without re-running `jeo notify setup` anyway.
    if (!(await this.pairedChatIsPrivate())) return this.opts.topicId;
    const provisional = conn.identity
      ? `${conn.identity.repo}${conn.identity.branch ? `@${conn.identity.branch}` : ""}`
      : `session ${shortSessionId(conn.sessionId)}`;
    try {
      const record = await this.topics.getOrCreateTopic(
        conn.sessionId,
        async () => {
          const res = await this.opts.telegram.createForumTopic(this.opts.chatId, provisional);
          const tid = res.result?.message_thread_id;
          if (tid === undefined) throw new Error("createForumTopic: no message_thread_id");
          return tid;
        },
        undefined,
        provisional,
      );
      void this.persistTopics();
      return record.topicId;
    } catch {
      conn.topicFailed = true;
      return this.opts.topicId;
    }
  }

  /** Cached (undefined = not yet checked) result of `getChat`'s `type ===
   *  "private"` — a `getChat` failure fails CLOSED (treated as not-private,
   *  never retried, matching `resolveTopicId`'s own no-retry-storm posture). */
  private pairedChatPrivate: boolean | undefined;
  private async pairedChatIsPrivate(): Promise<boolean> {
    if (this.pairedChatPrivate !== undefined) return this.pairedChatPrivate;
    try {
      const res = await this.opts.telegram.getChat(this.opts.chatId);
      this.pairedChatPrivate = res.result?.type === "private";
    } catch {
      this.pairedChatPrivate = false;
    }
    return this.pairedChatPrivate;
  }

  private async persistTopics(): Promise<void> {
    if (!this.topics) return;
    const save = this.opts.saveTopicState ?? defaultSaveTopicState;
    try {
      await save(this.topics.serialize());
    } catch {
      // best-effort — a failed persist just re-creates topics after a restart.
    }
  }

  /** Download a Telegram-hosted file into a local temp file for relay into a
   *  session's `[image #N]` attachment pipeline (`attachImagePaths`, see
   *  `src/util/file-attachment.ts`). Bounded by `opts.maxAttachmentBytes`
   *  (or `TelegramApi.downloadFile`'s own default when unset) — an oversized
   *  remote file is rejected there and this returns `undefined` exactly as
   *  it would for any other download failure. Returns `undefined` on any
   *  failure — the message still delivers as text-only rather than being
   *  dropped entirely. */
  private async downloadAttachment(fileId: string, suggestedName: string): Promise<string | undefined> {
    try {
      const got = await this.opts.telegram.getFile(fileId);
      const filePath = got.result?.file_path;
      if (!filePath) return undefined;
      const bytes = await this.opts.telegram.downloadFile(filePath, this.opts.maxAttachmentBytes);
      if (!bytes) return undefined;
      const write = this.opts.writeTempFile ?? defaultWriteTempFile;
      return await write(bytes, suggestedName);
    } catch {
      return undefined;
    }
  }

  private async reactToMessage(messageId: number, emoji: string): Promise<void> {
    try {
      await this.opts.telegram.setMessageReaction(this.opts.chatId, messageId, emoji);
    } catch {
      // best-effort — a visible delivery confirmation, not load-bearing.
    }
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
      const shortId = shortSessionId(conn.sessionId);
      if (events.length > 0) {
        const topicId = await this.resolveTopicId(conn);
        for (const ev of events) {
          const keyboard =
            ev.kind === "started" ? { inline_keyboard: [[cancelButton(shortId, ev.record)]] } : undefined;
          await this.notify(formatNotifyEvent(shortId, conn.cwd, ev), keyboard, { topicId, sessionId: conn.sessionId });
        }
      }
      return;
    }
    if (msg.type === "photo" && typeof msg.url === "string") {
      const replyMarkup =
        msg.replyMarkup &&
        typeof msg.replyMarkup === "object" &&
        "inline_keyboard" in (msg.replyMarkup as object)
          ? (msg.replyMarkup as InlineKeyboardMarkup)
          : undefined;
      const topicId = await this.resolveTopicId(conn);
      await this.notifyPhoto(
        msg.url,
        typeof msg.caption === "string" ? msg.caption : undefined,
        replyMarkup,
        { topicId, sessionId: conn.sessionId },
      );
      return;
    }
    if (msg.type === "ack" && typeof msg.reqId === "string") {
      const resolve = this.pendingAcks.get(msg.reqId);
      if (resolve) {
        resolve(Boolean(msg.ok));
        this.pendingAcks.delete(msg.reqId);
      }
      return;
    }
    // ── Tier 2: main-session mirroring frames (only meaningful/acted-on when
    //    `perSessionTopics` is enabled — `resolveTopicId` degrades to the
    //    flat/global topicId otherwise, so these still deliver, just without
    //    per-session grouping). ──────────────────────────────────────────────
    if (msg.type === "identity_header") {
      conn.identity = {
        repo: typeof msg.repo === "string" && msg.repo ? msg.repo : projectName(conn.cwd),
        branch: typeof msg.branch === "string" ? msg.branch : undefined,
        cwd: typeof msg.cwd === "string" ? msg.cwd : conn.cwd,
      };
      const topicId = await this.resolveTopicId(conn);
      if (topicId !== undefined && this.topics) {
        const name = `${conn.identity.repo}${conn.identity.branch ? `@${conn.identity.branch}` : ""}`;
        // `getOrCreateTopic` only names a topic on FIRST creation — a later,
        // more-informative identity (the provisional short-id name gets
        // superseded once the real repo/branch is known) needs an explicit
        // rename, attempted only when the name actually changed (dedup).
        // The LOCAL registry is committed (`applyName`) only AFTER
        // `editForumTopic` confirms success — committing it first would let a
        // transient remote failure leave the registry believing the rename
        // already applied, so the next identical `identity_header`
        // reassertion would silently skip retrying and the remote topic
        // would stay stuck at its provisional name forever.
        if (this.topics.wouldRename(conn.sessionId, name)) {
          try {
            await this.opts.telegram.editForumTopic(this.opts.chatId, topicId, name);
            this.topics.applyName(conn.sessionId, name);
            void this.persistTopics();
          } catch {
            // best-effort — a failed rename just leaves the provisional name,
            // and (unlike before) leaves the registry retry-eligible too.
          }
        }
      }
      return;
    }
    if (msg.type === "context_update" && typeof msg.phase === "string" && typeof msg.summary === "string") {
      const topicId = await this.resolveTopicId(conn);
      const icon = msg.phase === "turn_start" ? "▶" : "■";
      const label = msg.phase === "turn_start" ? "Turn started" : "Turn finished";
      const modelSuffix = typeof msg.model === "string" && msg.model ? ` (${msg.model})` : "";
      const usageLine = typeof msg.usage === "string" && msg.usage ? `\n${msg.usage}` : "";
      await this.notify(`${icon} ${label}${modelSuffix}\n${msg.summary}${usageLine}`, undefined, { topicId, sessionId: conn.sessionId });
      return;
    }
    if (msg.type === "turn_stream" && typeof msg.text === "string") {
      const topicId = await this.resolveTopicId(conn);
      await this.notify(markdownToTelegramHtml(msg.text), undefined, { topicId, sessionId: conn.sessionId, html: true });
      return;
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
      await this.notify(formatSubagentsList(sessions), buildSubagentsKeyboard(sessions));
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

  /** Inbound routed to a KNOWN session's OWN forum topic (per-session-topics
   *  mode only — `handleUpdate` is the only caller, and only once
   *  `this.topics.sessionForTopic(...)` has already confirmed ownership).
   *  A config command (`/verbose`, `/lean`, `/redact on|off`) is applied to
   *  THAT session only; anything else (including a media-only message with no
   *  caption) is forwarded as free-text steering, with any attached photo/
   *  image-document downloaded first. A 👀 reaction confirms the daemon
   *  actually routed the message (simplified single-stage delivery
   *  confirmation — gjc's own two-stage queued→consumed reaction protocol
   *  requires a round-trip ack frame this version does not add). */
  private async handleSessionTopicInbound(sessionId: string, msg: NonNullable<TelegramUpdate["message"]>): Promise<void> {
    const conn = this.sessions.get(sessionId);
    if (!conn) return; // the owning session has disconnected; the topic record just lingers
    const text = msg.text ?? msg.caption ?? "";
    const hasMedia = !!(msg.photo?.length || msg.document);
    const cfg = !hasMedia ? parseInThreadConfigCommand(text) : undefined;
    if (cfg) {
      conn.ws.send(JSON.stringify({ type: "config_command", sessionId, ...cfg }));
      return;
    }
    const imagePaths: string[] = [];
    if (msg.photo?.length) {
      const largest = msg.photo[msg.photo.length - 1]!;
      const p = await this.downloadAttachment(largest.file_id, `photo-${largest.file_id}.jpg`);
      if (p) imagePaths.push(p);
    } else if (msg.document && (msg.document.mime_type ?? "").startsWith("image/")) {
      const p = await this.downloadAttachment(msg.document.file_id, msg.document.file_name ?? `document-${msg.document.file_id}`);
      if (p) imagePaths.push(p);
    }
    if (!text && imagePaths.length === 0) return; // a non-image document with no caption — nothing usable to forward
    conn.ws.send(JSON.stringify({ type: "user_message", sessionId, text, imagePaths: imagePaths.length ? imagePaths : undefined }));
    await this.reactToMessage(msg.message_id, "👀");
  }

  /** Trust boundary: a bot's username is publicly discoverable, so ANY Telegram
   *  user can message it. Only the paired chat (the one that ran
   *  `jeo notify setup`) may steer/cancel subagents or steer a session;
   *  everything else is dropped without a reply (replying would leak that the
   *  bot is live). A message in a KNOWN session's own topic (per-session-
   *  topics mode) routes directly to that session — bypassing the flat
   *  `topicId` gate, which still governs everything else (global commands in
   *  the General topic or the configured flat topic; other topics ignored). */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }
    const msg = update.message;
    if (!msg) return;
    if (String(msg.chat.id) !== this.opts.chatId) return;

    const ownerSessionId = this.topics && msg.message_thread_id !== undefined
      ? this.topics.sessionForTopic(msg.message_thread_id)
      : undefined;
    if (ownerSessionId) {
      await this.handleSessionTopicInbound(ownerSessionId, msg);
      return;
    }

    if (!msg.text) return;
    if (
      this.opts.topicId !== undefined &&
      msg.message_thread_id !== undefined &&
      msg.message_thread_id !== this.opts.topicId
    ) {
      return;
    }
    await this.handleInboundText(msg.text);
  }

  /** Handle an inline-button tap. Same chat trust boundary as text; the topic
   *  gate additionally allows a tap from within any KNOWN session's own topic
   *  (its cancel buttons target that session's own subagents — legitimate
   *  regardless of the flat `topicId`), not just the configured flat topic.
   *  The tap is always acknowledged (Telegram shows a spinner until
   *  `answerCallbackQuery`). */
  async handleCallbackQuery(cb: TelegramCallbackQuery): Promise<void> {
    const chatId = cb.message?.chat.id;
    if (chatId !== undefined && String(chatId) !== this.opts.chatId) {
      await this.answerCallback(cb.id);
      return;
    }
    const threadId = cb.message?.message_thread_id;
    const inKnownSessionTopic = !!this.topics && threadId !== undefined && this.topics.sessionForTopic(threadId) !== undefined;
    if (
      this.opts.topicId !== undefined &&
      threadId !== undefined &&
      threadId !== this.opts.topicId &&
      !inKnownSessionTopic
    ) {
      await this.answerCallback(cb.id);
      return;
    }
    const parsed = cb.data ? parseCallbackData(cb.data) : undefined;
    if (!parsed) {
      await this.answerCallback(cb.id);
      return;
    }
    const conn = this.findSession(parsed.shortId);
    if (!conn) {
      await this.answerCallback(cb.id, `No connected session matches '${parsed.shortId}'.`);
      return;
    }
    const ok = await this.sendRequest(conn, { type: "cancel", ids: [parsed.subagentId] });
    await this.answerCallback(cb.id, ok ? `Cancelled '${parsed.subagentId}'.` : "Cancel failed.");
    await this.notify(
      ok
        ? `⏹ Cancelled '${parsed.subagentId}' via button.`
        : `Cancel failed — '${parsed.subagentId}' is unknown or already finished.`,
    );
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
    if (this.topics) {
      const load = this.opts.loadTopicState ?? defaultLoadTopicState;
      try {
        this.topics.load(await load());
      } catch {
        // best-effort — a missing/corrupt topic-state file just starts empty
        // (every session's first frame re-creates its topic from scratch).
      }
    }
    await this.scanSessions();
    this.scanTimer = setInterval(() => void this.scanSessions(), this.opts.scanIntervalMs ?? 3_000);
    // Catches anything left queued after a submit-time drain because the
    // burst capacity was briefly exhausted (rare at jeo's realistic message
    // volume, but a large simultaneous fan-out can hit it) — without this,
    // a queued-but-never-retried item would silently never send.
    this.poolTimer = setInterval(() => void this.flushPool(), 250);
    await this.pollTelegramLoop();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.scanTimer);
    clearInterval(this.poolTimer);
    for (const conn of this.sessions.values()) {
      try {
        conn.ws.close();
      } catch {}
    }
    this.sessions.clear();
  }
}

/** Default inbound-attachment temp-file writer: a private (0700-parent,
 *  default-mode) file under the OS temp dir, named to survive filesystem
 *  weirdness (sanitized, length-capped) while staying traceable to its
 *  Telegram origin for debugging. */
async function defaultWriteTempFile(bytes: Uint8Array, suggestedName: string): Promise<string> {
  const safe = (suggestedName.replace(/[^\w.-]+/g, "_").slice(-128) || "file");
  const target = path.join(os.tmpdir(), `jeo-telegram-${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safe}`);
  await fs.writeFile(target, bytes);
  return target;
}

async function defaultLoadTopicState(): Promise<TopicRegistryState> {
  try {
    const raw = await fs.readFile(notifyTopicsPath(), "utf-8");
    return JSON.parse(raw) as TopicRegistryState;
  } catch {
    return { topics: {} };
  }
}

/** Atomic temp+rename write (same convention as `state.ts`'s config/workflow
 *  persistence) — a torn write must never corrupt the topic map. */
async function defaultSaveTopicState(state: TopicRegistryState): Promise<void> {
  const target = notifyTopicsPath();
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 });
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
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
    const topicId = config.notifications?.telegram?.topicId;
    const perSessionTopics = config.notifications?.telegram?.perSessionTopics;
    if (!config.notifications?.enabled || !botToken || !chatId) {
      process.stderr.write("[jeo notify-daemon] notifications not configured — run `jeo notify setup` first.\n");
      return;
    }
    const daemon = new TelegramDaemon({ chatId, topicId, perSessionTopics, telegram: new TelegramApi(botToken) });
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
