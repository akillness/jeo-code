/**
 * Lightweight Discord REST v10 client for the Thread Orchestrator.
 * Reuses the existing bot token (`JEO_DISCORD_BOT_TOKEN` or `~/.jeo/discord/discord-token`).
 */

import * as fs from "node:fs/promises";
import { compareSnowflakes } from "./matcher";
import { expandTilde } from "./store";
import type { DiscordChannel, DiscordMessage, DiscordThread } from "./types";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const MAX_DISCORD_MESSAGE_LEN = 1900;
const DISCORD_USER_AGENT = "DiscordBot (https://github.com/akillness/jeo-code, 1.0)";
/** Discord message flags: SUPPRESS_EMBEDS (1<<2) | SUPPRESS_NOTIFICATIONS (1<<12) for quiet live status cards. */
export const DISCORD_SILENT_FLAGS = (1 << 2) | (1 << 12);

export interface RestDiscordClientOptions {
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DiscordClient {
  getSelfUser(): Promise<{ id: string; username: string }>;
  listGuilds(): Promise<Array<{ id: string; name: string }>>;
  listGuildChannels(guildId: string): Promise<DiscordChannel[]>;
  listActiveThreads(guildId: string): Promise<DiscordThread[]>;
  listThreadMessages(threadId: string, opts?: { after?: string; limit?: number }): Promise<DiscordMessage[]>;
  postMessage(channelId: string, content: string, opts?: { flags?: number }): Promise<string[]>;
  editMessage?(channelId: string, messageId: string, content: string): Promise<void>;
  addReaction?(channelId: string, messageId: string, emoji: string): Promise<void>;
  removeReaction?(channelId: string, messageId: string, emoji: string): Promise<void>;
  triggerTyping?(channelId: string): Promise<void>;
  ensureDmChannel(userId: string): Promise<string>;
}

export async function resolveDiscordToken(tokenFile: string, tokenEnv = "JEO_DISCORD_BOT_TOKEN"): Promise<string> {
  const fromEnv = process.env[tokenEnv]?.trim();
  if (fromEnv) return fromEnv;
  const resolvedFile = expandTilde(tokenFile);
  try {
    const raw = (await fs.readFile(resolvedFile, "utf8")).trim();
    if (raw) return raw;
  } catch {
    // Fall through to descriptive error.
  }
  throw new Error(`Discord bot token not found in $${tokenEnv} or ${resolvedFile}.`);
}

export function chunkDiscordContent(content: string, maxLen = MAX_DISCORD_MESSAGE_LEN): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxLen) return [trimmed];

  const chunks: string[] = [];
  const lines = trimmed.split("\n");
  let buf = "";

  for (const line of lines) {
    if (buf.length + line.length + 1 <= maxLen) {
      buf = buf ? `${buf}\n${line}` : line;
      continue;
    }
    if (buf) {
      chunks.push(buf);
      buf = "";
    }
    if (line.length <= maxLen) {
      buf = line;
    } else {
      for (let i = 0; i < line.length; i += maxLen) {
        chunks.push(line.slice(i, i + maxLen));
      }
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

function combineSignals(signals: (AbortSignal | undefined)[]): { signal: AbortSignal; cleanup: () => void } {
  const active = signals.filter((s): s is AbortSignal => Boolean(s));
  if (active.length === 0) {
    return { signal: new AbortController().signal, cleanup: () => {} };
  }
  if (active.length === 1) {
    return { signal: active[0]!, cleanup: () => {} };
  }
  if (typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any(active), cleanup: () => {} };
  }
  const controller = new AbortController();
  const onAbort = (ev: Event) => {
    controller.abort((ev.target as AbortSignal).reason);
  };
  for (const s of active) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const s of active) {
        s.removeEventListener("abort", onAbort);
      }
    },
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error("Aborted"));
  }
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function calculateRetryAfterMs(seconds?: number): number {
  if (seconds === undefined || Number.isNaN(seconds) || seconds <= 0) {
    return 250;
  }
  const ms = Math.round(seconds * 1000);
  return Math.min(60_000, Math.max(250, ms));
}

export class RestDiscordClient implements DiscordClient {
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly signal?: AbortSignal;
  private readonly timeoutMs: number;
  private readonly dmChannelCache = new Map<string, string>();
  private readonly dmChannelInFlight = new Map<string, Promise<string>>();

  constructor(
    token: string,
    fetchFnOrOptions?: typeof fetch | RestDiscordClientOptions,
    options?: RestDiscordClientOptions,
  ) {
    this.token = token;
    if (typeof fetchFnOrOptions === "function") {
      this.fetchFn = fetchFnOrOptions;
      this.signal = options?.signal;
      this.timeoutMs = options?.timeoutMs ?? 20_000;
    } else if (fetchFnOrOptions && typeof fetchFnOrOptions === "object") {
      this.fetchFn = fetchFnOrOptions.fetchFn ?? fetch;
      this.signal = fetchFnOrOptions.signal;
      this.timeoutMs = fetchFnOrOptions.timeoutMs ?? 20_000;
    } else {
      this.fetchFn = fetch;
      this.signal = options?.signal;
      this.timeoutMs = options?.timeoutMs ?? 20_000;
    }
  }

  private async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const url = `${DISCORD_API_BASE}${route}`;
    const maxRetries = 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (this.signal?.aborted) {
        throw this.signal.reason ?? new Error("Discord request aborted");
      }

      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const timeoutController = new AbortController();
      if (this.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timeoutController.abort(new Error(`Discord request timed out after ${this.timeoutMs}ms`));
        }, this.timeoutMs);
      }
      const combined = combineSignals([this.signal, timeoutController.signal]);

      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method,
          headers: {
            Authorization: `Bot ${this.token}`,
            "User-Agent": DISCORD_USER_AGENT,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: combined.signal,
        });
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        combined.cleanup();
      }

      if (res.status === 429) {
        if (attempt >= maxRetries) {
          const text = await res.text().catch(() => "");
          throw new Error(
            `Discord API ${method} ${route} failed (429 rate limit exhausted after ${maxRetries} retries): ${text.slice(0, 240)}`,
          );
        }

        let retryAfterSec: number | undefined;
        try {
          const text = await res.text();
          const parsed = JSON.parse(text);
          if (typeof parsed?.retry_after === "number") {
            retryAfterSec = parsed.retry_after;
          }
        } catch {
          // not JSON or stream consumed
        }

        if (retryAfterSec === undefined) {
          const header = res.headers.get("Retry-After") ?? res.headers.get("X-RateLimit-Reset-After");
          if (header) {
            const parsed = parseFloat(header);
            if (!Number.isNaN(parsed)) {
              retryAfterSec = parsed;
            }
          }
        }

        const waitMs = calculateRetryAfterMs(retryAfterSec);
        await sleep(waitMs, this.signal);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Discord API ${method} ${route} failed (${res.status}): ${text.slice(0, 240)}`);
      }

      if (res.status === 204) {
        return undefined as T;
      }

      const raw = await res.text().catch(() => "");
      if (!raw) {
        return undefined as T;
      }
      try {
        return JSON.parse(raw) as T;
      } catch {
        return raw as unknown as T;
      }
    }

    throw new Error(`Discord API ${method} ${route} failed: maximum retries exceeded`);
  }

  async getSelfUser(): Promise<{ id: string; username: string }> {
    return this.request<{ id: string; username: string }>("GET", "/users/@me");
  }

  async listGuilds(): Promise<Array<{ id: string; name: string }>> {
    return this.request<Array<{ id: string; name: string }>>("GET", "/users/@me/guilds");
  }

  async listGuildChannels(guildId: string): Promise<DiscordChannel[]> {
    const all = await this.request<DiscordChannel[]>("GET", `/guilds/${encodeURIComponent(guildId)}/channels`);
    // Type 0 = GUILD_TEXT, Type 15 = GUILD_FORUM, Type 5 = GUILD_ANNOUNCEMENT
    return all.filter(c => c.type === 0 || c.type === 5 || c.type === 15);
  }

  async listActiveThreads(guildId: string): Promise<DiscordThread[]> {
    const data = await this.request<{ threads?: DiscordThread[] }>("GET", `/guilds/${encodeURIComponent(guildId)}/threads/active`);
    return Array.isArray(data.threads) ? data.threads : [];
  }

  async listThreadMessages(threadId: string, opts?: { after?: string; limit?: number }): Promise<DiscordMessage[]> {
    const qs = new URLSearchParams();
    qs.set("limit", String(opts?.limit ?? 50));
    if (opts?.after) qs.set("after", opts.after);
    const msgs = await this.request<DiscordMessage[]>("GET", `/channels/${encodeURIComponent(threadId)}/messages?${qs.toString()}`);
    // Explicitly sort messages by 64-bit snowflake ID (oldest first).
    return [...msgs].sort((a, b) => compareSnowflakes(a.id, b.id));
  }

  async postMessage(channelId: string, content: string, opts?: { flags?: number }): Promise<string[]> {
    const chunks = chunkDiscordContent(content);
    const ids: string[] = [];
    for (const chunk of chunks) {
      const sent = await this.request<{ id: string }>("POST", `/channels/${encodeURIComponent(channelId)}/messages`, {
        content: chunk,
        allowed_mentions: { parse: [] },
        ...(typeof opts?.flags === "number" ? { flags: opts.flags } : {}),
      });
      ids.push(sent.id);
    }
    return ids;
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) return;
    const clamped = trimmed.length <= MAX_DISCORD_MESSAGE_LEN ? trimmed : `${trimmed.slice(0, MAX_DISCORD_MESSAGE_LEN - 1)}…`;
    await this.request("PATCH", `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`, {
      content: clamped,
      allowed_mentions: { parse: [] },
    });
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.request(
      "PUT",
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}/@me`,
    );
  }

  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.request(
      "DELETE",
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}/@me`,
    );
  }

  async triggerTyping(channelId: string): Promise<void> {
    await this.request("POST", `/channels/${encodeURIComponent(channelId)}/typing`);
  }
  async ensureDmChannel(userId: string): Promise<string> {
    const cached = this.dmChannelCache.get(userId);
    if (cached) return cached;

    const inFlight = this.dmChannelInFlight.get(userId);
    if (inFlight) return inFlight;

    const promise = (async () => {
      try {
        const dm = await this.request<{ id: string }>("POST", "/users/@me/channels", {
          recipient_id: userId,
        });
        this.dmChannelCache.set(userId, dm.id);
        return dm.id;
      } finally {
        this.dmChannelInFlight.delete(userId);
      }
    })();

    this.dmChannelInFlight.set(userId, promise);
    return promise;
  }
}
