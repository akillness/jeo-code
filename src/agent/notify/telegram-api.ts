/**
 * Minimal Telegram Bot HTTP API client (gjc `telegram-reference.ts`/`telegram-cli.ts`
 * parity, scoped to the three calls the jeo daemon actually needs: identity
 * verification, outbound push, and inbound long-poll). Deliberately thin — no forum
 * topics, no inline keyboards, no rate-limit pool; jeo's daemon sends plain text.
 */

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat: TelegramChat;
    text?: string;
    from?: { id: number; username?: string; is_bot: boolean };
  };
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

export type FetchLike = typeof fetch;

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  async getMe(): Promise<TelegramGetMeResult> {
    const res = await this.fetchImpl(this.url("getMe"));
    return (await res.json()) as TelegramGetMeResult;
  }

  async sendMessage(chatId: string | number, text: string): Promise<TelegramSendResult> {
    const res = await this.fetchImpl(this.url("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    return (await res.json()) as TelegramSendResult;
  }

  /** Long-poll for new updates. `offset` should be `last_update_id + 1`. */
  async getUpdates(offset?: number, timeoutSec = 25): Promise<TelegramGetUpdatesResult> {
    const params = new URLSearchParams({ timeout: String(timeoutSec) });
    if (offset !== undefined) params.set("offset", String(offset));
    const res = await this.fetchImpl(`${this.url("getUpdates")}?${params.toString()}`);
    return (await res.json()) as TelegramGetUpdatesResult;
  }
}

/** Mask a secret token for safe display: first 4 chars + length, never the rest
 *  (gjc `gjc notify status` masking parity — safe to paste into a support thread). */
export function maskToken(token: string): string {
  if (!token) return "";
  return `${token.slice(0, 4)}…(len ${token.length})`;
}
