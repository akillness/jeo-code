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

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  private async postJson<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(this.url(method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as T;
  }

  async getMe(): Promise<TelegramGetMeResult> {
    const res = await this.fetchImpl(this.url("getMe"));
    return (await res.json()) as TelegramGetMeResult;
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

  /** Long-poll for new updates. `offset` should be `last_update_id + 1`. */
  async getUpdates(offset?: number, timeoutSec = 25): Promise<TelegramGetUpdatesResult> {
    const params = new URLSearchParams({ timeout: String(timeoutSec) });
    if (offset !== undefined) params.set("offset", String(offset));
    const res = await this.fetchImpl(`${this.url("getUpdates")}?${params.toString()}`);
    return (await res.json()) as TelegramGetUpdatesResult;
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
   */
  async downloadFile(filePath: string): Promise<Uint8Array | undefined> {
    if (filePath.includes("..") || filePath.startsWith("/") || filePath.includes("\\")) return undefined;
    const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
    const url = `https://api.telegram.org/file/bot${this.token}/${encodedPath}`;
    try {
      const res = await this.fetchImpl(url);
      if (!res.ok) return undefined;
      return new Uint8Array(await res.arrayBuffer());
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
