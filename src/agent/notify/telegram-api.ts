/**
 * Minimal Telegram Bot HTTP API client (gjc `telegram-reference.ts`/`telegram-cli.ts`
 * parity). Scoped to the calls the jeo daemon needs — identity verification,
 * outbound push, inbound long-poll — plus gjc's richer surface: forum topics
 * (`message_thread_id`), inline keyboards (`reply_markup` + `answerCallbackQuery`),
 * and image attachments (`sendPhoto`, photo given as a URL or `file_id`).
 */

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

/** Inline keyboard primitives (gjc parity). `callback_data` is capped by Telegram
 *  at 64 bytes; the daemon keeps its payloads short (`cancel:<shortId>:<id>`). */
export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

/** Button-press callback delivered via `getUpdates` when a user taps an inline
 *  keyboard button. `message` carries the originating chat/topic. */
export interface TelegramCallbackQuery {
  id: string;
  from: { id: number; username?: string; is_bot: boolean };
  message?: {
    message_id: number;
    chat: TelegramChat;
    message_thread_id?: number;
  };
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat: TelegramChat;
    text?: string;
    from?: { id: number; username?: string; is_bot: boolean };
    /** Forum-topic thread this message belongs to (supergroups with topics on). */
    message_thread_id?: number;
    is_topic_message?: boolean;
    /** One entry per generated size (largest last); the daemon downloads the
     *  largest for inbound relay. Absent unless the message attached a photo. */
    photo?: { file_id: string; width: number; height: number }[];
    /** A non-photo file attachment (image sent "as file", or any document). */
    document?: { file_id: string; file_name?: string; mime_type?: string };
    /** Caption text on a photo/document message (Telegram never sets `text`
     *  alongside media — the caption is the media message's own text field). */
    caption?: string;
  };
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramGetMeResult {
  ok: boolean;
  result?: { id: number; is_bot: boolean; username: string };
  description?: string;
}

export interface TelegramSendResult {
  ok: boolean;
  description?: string;
}

export interface TelegramGetUpdatesResult {
  ok: boolean;
  result: TelegramUpdate[];
  description?: string;
}

/** Shared outbound options: target a forum topic and/or attach an inline keyboard. */
export interface SendMessageOptions {
  messageThreadId?: number;
  replyMarkup?: InlineKeyboardMarkup;
  disableWebPagePreview?: boolean;
  /** `"HTML"` to enable Telegram's bounded HTML tag subset (see `telegram-html.ts`). */
  parseMode?: "HTML";
}

export interface SendPhotoOptions {
  caption?: string;
  messageThreadId?: number;
  replyMarkup?: InlineKeyboardMarkup;
}

export interface AnswerCallbackQueryOptions {
  text?: string;
  showAlert?: boolean;
}

export type FetchLike = typeof fetch;

/** Conservative fixed default cap on a downloaded Telegram file (photo or
 *  document), enforced before/while buffering the response body so a
 *  malicious or oversized remote attachment can't allocate unbounded memory
 *  on the daemon. Same order of magnitude as jeo's local image-attachment
 *  bound (`MAX_ATTACH_IMAGE_BYTES` in `src/util/file-attachment.ts`) — kept
 *  as an independent constant rather than importing that one, since this
 *  guards a different codepath (network download vs. local `stat`+`readFile`).
 *  Injectable per call via {@link TelegramApi.downloadFile}'s `maxBytes`
 *  argument for callers/tests that need a different policy. */
export const MAX_TELEGRAM_DOWNLOAD_BYTES = 25 * 1024 * 1024;

/** Lower/upper clamp bounds (seconds) for a bot-wide cooldown armed by a Bot API
 *  HTTP 429's `parameters.retry_after` (gjc v0.11.10 PR #3048 cooldown parity,
 *  adapted to jeo's injectable-fetch client). A malicious/buggy server can't
 *  lock the client out indefinitely (upper bound) or arm a near-0s cooldown
 *  that fails to protect against the retry storm the 429 was warning about
 *  (lower bound). */
export const TELEGRAM_COOLDOWN_MIN_SECONDS = 1;
export const TELEGRAM_COOLDOWN_MAX_SECONDS = 3600;

/** Cooldown length (seconds) used when a 429's `parameters.retry_after` is
 *  missing, non-finite, or non-positive — a conservative fixed fallback
 *  rather than either a 0s cooldown (no protection at all) or refusing to
 *  arm one (the same retry-storm risk the 429 was signalling). */
export const TELEGRAM_COOLDOWN_FALLBACK_SECONDS = 30;

/** `description` on the suppressed, non-throwing result a non-polling call
 *  returns when it short-circuits during an active cooldown instead of
 *  reaching the network. `getUpdates` is exempt (see its own doc) so
 *  long-poll recovery keeps working while every other call backs off. */
export const TELEGRAM_COOLDOWN_SUPPRESSED_DESCRIPTION = "telegram_api_cooldown_active";

export class TelegramApi {
  /** Epoch ms (per the injected `now`) until which the bot-wide 429 cooldown
   *  armed by {@link armCooldown} is active. 0 (default) or any past value
   *  means "not cooling down". */
  private cooldownUntilMs = 0;

  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  /** True while the bot-wide 429 cooldown is active per the injected clock.
   *  `getUpdates` ignores this so long-poll recovery keeps working; every
   *  other call short-circuits via {@link suppressed} while this is true. */
  isCoolingDown(): boolean {
    return this.now() < this.cooldownUntilMs;
  }

  /** Milliseconds remaining in the active cooldown (0 when not cooling down). */
  cooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntilMs - this.now());
  }

  /** Arm (or extend) the cooldown from a 429 response's `parameters.retry_after`
   *  (seconds), clamped to [{@link TELEGRAM_COOLDOWN_MIN_SECONDS},
   *  {@link TELEGRAM_COOLDOWN_MAX_SECONDS}]; falls back to
   *  {@link TELEGRAM_COOLDOWN_FALLBACK_SECONDS} when missing/non-finite/non-positive. */
  private armCooldown(retryAfterSeconds: unknown): void {
    const raw = Number(retryAfterSeconds);
    const seconds = Number.isFinite(raw) && raw > 0
      ? Math.min(Math.max(raw, TELEGRAM_COOLDOWN_MIN_SECONDS), TELEGRAM_COOLDOWN_MAX_SECONDS)
      : TELEGRAM_COOLDOWN_FALLBACK_SECONDS;
    this.cooldownUntilMs = this.now() + seconds * 1000;
  }

  /** Arm the cooldown when `status` is 429, reading `parameters.retry_after`
   *  off the parsed Bot API response body. No-op for any other status —
   *  non-429 responses are never affected. */
  private armFromResponseIf429(status: number, body: unknown): void {
    if (status !== 429) return;
    const retryAfter = (body as { parameters?: { retry_after?: unknown } } | null | undefined)?.parameters?.retry_after;
    this.armCooldown(retryAfter);
  }

  /** Suppressed, non-throwing stand-in returned by a non-polling call that
   *  short-circuits during an active cooldown instead of reaching the
   *  network — the same `{ ok: false, description }` shape every real
   *  failure already returns, so no caller needs new branching to handle it. */
  private suppressed<T>(): T {
    return { ok: false, description: TELEGRAM_COOLDOWN_SUPPRESSED_DESCRIPTION } as unknown as T;
  }

  private async postJson<T>(method: string, body: Record<string, unknown>): Promise<T> {
    if (this.isCoolingDown()) return this.suppressed<T>();
    const res = await this.fetchImpl(this.url(method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = (await res.json()) as T;
    this.armFromResponseIf429(res.status, parsed);
    return parsed;
  }

  async getMe(): Promise<TelegramGetMeResult> {
    if (this.isCoolingDown()) return this.suppressed<TelegramGetMeResult>();
    const res = await this.fetchImpl(this.url("getMe"));
    const parsed = (await res.json()) as TelegramGetMeResult;
    this.armFromResponseIf429(res.status, parsed);
    return parsed;
  }

  async sendMessage(
    chatId: string | number,
    text: string,
    options: SendMessageOptions = {},
  ): Promise<TelegramSendResult> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      disable_web_page_preview: options.disableWebPagePreview ?? true,
    };
    if (options.messageThreadId !== undefined) body.message_thread_id = options.messageThreadId;
    if (options.replyMarkup) body.reply_markup = options.replyMarkup;
    if (options.parseMode) body.parse_mode = options.parseMode;
    return this.postJson<TelegramSendResult>("sendMessage", body);
  }

  /** Send a photo. `photo` is a public URL or a Telegram `file_id` (no local
   *  multipart upload — jeo pushes URLs/ids, matching gjc's URL-attachment path). */
  async sendPhoto(
    chatId: string | number,
    photo: string,
    options: SendPhotoOptions = {},
  ): Promise<TelegramSendResult> {
    const body: Record<string, unknown> = { chat_id: chatId, photo };
    if (options.caption !== undefined) body.caption = options.caption;
    if (options.messageThreadId !== undefined) body.message_thread_id = options.messageThreadId;
    if (options.replyMarkup) body.reply_markup = options.replyMarkup;
    return this.postJson<TelegramSendResult>("sendPhoto", body);
  }

  /** Acknowledge an inline-button tap (clears the client's loading spinner and
   *  optionally shows a toast/alert). Telegram requires this within ~15s. */
  async answerCallbackQuery(
    callbackQueryId: string,
    options: AnswerCallbackQueryOptions = {},
  ): Promise<TelegramSendResult> {
    const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
    if (options.text !== undefined) body.text = options.text;
    if (options.showAlert !== undefined) body.show_alert = options.showAlert;
    return this.postJson<TelegramSendResult>("answerCallbackQuery", body);
  }

  /** Long-poll for new updates. `offset` should be `last_update_id + 1`.
   *  EXEMPT from the cooldown short-circuit — always reaches `fetchImpl`,
   *  even during an active cooldown armed by another call's (or its own)
   *  429 — because the long-poll is the only path that can observe recovery. */
  async getUpdates(offset?: number, timeoutSec = 25): Promise<TelegramGetUpdatesResult> {
    const params = new URLSearchParams({ timeout: String(timeoutSec) });
    if (offset !== undefined) params.set("offset", String(offset));
    const res = await this.fetchImpl(`${this.url("getUpdates")}?${params.toString()}`);
    const parsed = (await res.json()) as TelegramGetUpdatesResult;
    this.armFromResponseIf429(res.status, parsed);
    return parsed;
  }

  /** Create a forum topic in a chat with Threaded Mode enabled (gjc per-session topic parity). */
  async createForumTopic(chatId: string | number, name: string): Promise<{ ok: boolean; result?: { message_thread_id: number } }> {
    return this.postJson<{ ok: boolean; result?: { message_thread_id: number } }>("createForumTopic", {
      chat_id: chatId,
      name,
    });
  }

  /** Rename an existing forum topic, e.g. once a session's real title is known (gjc identity-rename parity). */
  async editForumTopic(chatId: string | number, messageThreadId: number, name: string): Promise<TelegramSendResult> {
    return this.postJson<TelegramSendResult>("editForumTopic", {
      chat_id: chatId,
      message_thread_id: messageThreadId,
      name,
    });
  }

  /** Resolve a `file_id` to a short-lived `file_path` for use with {@link downloadFile}. */
  async getFile(fileId: string): Promise<{ ok: boolean; result?: { file_path?: string } }> {
    return this.postJson<{ ok: boolean; result?: { file_path?: string } }>("getFile", { file_id: fileId });
  }

  /**
   * Download a file resolved via {@link getFile}. `filePath` is untrusted
   * remote metadata from a Bot API response, not something jeo controls —
   * reject any `..`, leading `/`, or `\` segment before building the URL
   * (guards against path-traversal/SSRF via a malicious `file_path`) and
   * percent-encode each path segment. Best-effort: returns `undefined` on
   * rejection, fetch failure, or a non-ok response instead of throwing,
   * since this is new network I/O every caller must treat as fallible
   * (gjc `downloadTelegramFile` parity, minus the retry logic gjc layers on
   * top at the daemon level).
   *
   * Bounded by `maxBytes` (default {@link MAX_TELEGRAM_DOWNLOAD_BYTES}):
   * a `content-length` over the cap short-circuits before any read, and
   * the body is otherwise streamed and counted chunk-by-chunk so a
   * remote server that lies about (or omits) `content-length` still can't
   * buffer past the cap — the read is aborted and `undefined` returned the
   * moment the running total exceeds it, never after buffering the whole
   * oversized body first. ALSO short-circuits (returns `undefined` without
   * calling `fetchImpl`) during an active bot-wide cooldown — the same
   * non-polling exemption every other call gets.
   */
  async downloadFile(filePath: string, maxBytes: number = MAX_TELEGRAM_DOWNLOAD_BYTES): Promise<Uint8Array | undefined> {
    if (this.isCoolingDown()) return undefined;
    if (filePath.includes("..") || filePath.startsWith("/") || filePath.includes("\\")) return undefined;
    const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
    const url = `https://api.telegram.org/file/bot${this.token}/${encodedPath}`;
    try {
      const res = await this.fetchImpl(url);
      if (!res.ok) return undefined;
      const declaredLength = Number(res.headers?.get?.("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return undefined;
      if (!res.body) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        return bytes.byteLength > maxBytes ? undefined : bytes;
      }
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          return undefined;
        }
        chunks.push(value);
      }
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    } catch {
      return undefined;
    }
  }

  /** Look up a chat's type; callers gate per-session topic creation on `result.type === "private"` (gjc `pairedChatIsPrivate` fail-closed parity). */
  async getChat(chatId: string | number): Promise<{ ok: boolean; result?: { type?: string } }> {
    return this.postJson<{ ok: boolean; result?: { type?: string } }>("getChat", { chat_id: chatId });
  }

  /** Attach an emoji reaction to a message (gjc queued/consumed delivery double-check parity). */
  async setMessageReaction(chatId: string | number, messageId: number, emoji: string): Promise<TelegramSendResult> {
    return this.postJson<TelegramSendResult>("setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji }],
    });
  }
}

/** Mask a secret token for safe display: first 4 chars + length, never the rest
 *  (gjc `gjc notify status` masking parity — safe to paste into a support thread). */
export function maskToken(token: string): string {
  if (!token) return "";
  return `${token.slice(0, 4)}…(len ${token.length})`;
}
