import { version } from "../../../package.json";

/** Native Discord bot REST surface. Tokens are headers only; errors never include response bodies. */
export interface DiscordApiOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  requestTimeoutMs?: number;
  maxRetries?: number;
}

export class DiscordApiError extends Error {
  constructor(message: string, readonly status?: number, readonly retryAfterMs?: number, readonly sentMessages: { id: string }[] = []) {
    super(message);
    this.name = "DiscordApiError";
  }
}

export interface DiscordGatewayInfo {
  url: string;
  session_start_limit: { remaining: number; reset_after: number; total: number; max_concurrency: number };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const abort = () => { clearTimeout(timer); reject(new DiscordApiError("Discord request stopped")); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return promise;
}

const DISCORD_WHITESPACE = /^[\s\u0085\u001c-\u001f]$/u;
const DISCORD_BOUNDARY_GUARD = "\u200b";

function splitDiscordText(text: string): { chunks: string[]; needsAttachment: boolean } {
  const chunks: string[] = [];
  let needsAttachment = false;
  for (let start = 0; start < text.length;) {
    const leading = DISCORD_WHITESPACE.test(text[start]!) ? DISCORD_BOUNDARY_GUARD : "";
    let fallback = 0;
    let end = Math.min(start + 2000 - leading.length, text.length);
    for (; end > start; end--) {
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) continue;
      const trailing = DISCORD_WHITESPACE.test(text[end - 1]!);
      if (end - start + leading.length + Number(trailing) > 2000) continue;
      if (!fallback) fallback = end;
      if (end === text.length || (!trailing && !DISCORD_WHITESPACE.test(text[end]!))) break;
    }
    if (end === start) end = fallback;
    const chunk = text.slice(start, end);
    const trailing = DISCORD_WHITESPACE.test(chunk[chunk.length - 1]!) ? DISCORD_BOUNDARY_GUARD : "";
    if (leading || trailing) needsAttachment = true;
    chunks.push(`${leading}${chunk}${trailing}`);
    start = end;
  }
  return { chunks, needsAttachment };
}

export class DiscordApi {
  private readonly controller = new AbortController();
  private cooldownUntil = 0;
  private reactionCooldownUntil = 0;
  private globalCooldownUntil = 0;
  private fatalStatus: number | undefined;
  private queue = Promise.resolve();
  private queued = 0;
  private reactionQueue = Promise.resolve();
  private reactionsQueued = 0;
  private sendQueue = Promise.resolve();

  constructor(private readonly token: string, private readonly options: DiscordApiOptions = {}) {}

  stop(): void { this.controller.abort(); }

  private request<T>(route: string, body?: unknown, method = body === undefined ? "GET" : "POST", eligible?: () => boolean): Promise<T> {
    if (this.queued >= 128) return Promise.reject(new DiscordApiError("Discord request queue full"));
    this.queued++;
    const result = this.queue.then(() => this.perform<T>(route, body, method, eligible));
    this.queue = result.then(() => {}, () => {}).finally(() => { this.queued--; });
    return result;
  }

  private async perform<T>(route: string, body: unknown, method: string, eligible?: () => boolean, reaction = false): Promise<T> {
    const now = this.options.now ?? Date.now;
    const retries = Math.max(0, Math.min(this.options.maxRetries ?? 2, 3));
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (this.controller.signal.aborted) throw new DiscordApiError("Discord request stopped");
      if (this.fatalStatus) throw new DiscordApiError("Discord authentication or permission denied", this.fatalStatus);
      for (;;) {
        const wait = Math.max(this.globalCooldownUntil, reaction ? this.reactionCooldownUntil : this.cooldownUntil) - now();
        if (wait > 30_000) throw new DiscordApiError("Discord rate limit cooldown active", 429, wait);
        if (wait <= 0) break;
        await (this.options.sleep ?? delay)(wait, this.controller.signal);
        if (this.controller.signal.aborted) throw new DiscordApiError("Discord request stopped");
      }
      if (this.controller.signal.aborted) throw new DiscordApiError("Discord request stopped");
      if (this.fatalStatus) throw new DiscordApiError("Discord authentication or permission denied", this.fatalStatus);
      if (eligible && !eligible()) throw new DiscordApiError("Discord delivery no longer eligible");
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(this.options.requestTimeoutMs ?? (reaction ? 2000 : 10_000), reaction ? 2000 : 30_000)));
      let response: Response;
      let data: unknown;
      try {
        response = await (this.options.fetchImpl ?? fetch)(`https://discord.com/api/v10${route}`, {
          method,
          headers: { Authorization: `Bot ${this.token}`, ...(body === undefined || body instanceof FormData ? {} : { "Content-Type": "application/json" }), "User-Agent": `DiscordBot (https://github.com/akillness/jeo-code, ${version})` },
          body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
          signal: AbortSignal.any([this.controller.signal, timeout]),
          redirect: "error",
        });
        if (response.status === 401) this.fatalStatus = response.status;
        data = response.status === 204 ? null : await response.json().catch(error => {
          if (response.ok) throw error;
          return null; // HTTP denial/cooldown headers remain authoritative without a JSON body.
        });
      } catch {
        // Never retry an uncertain POST: Discord may already have accepted it.
        if (this.fatalStatus) throw new DiscordApiError("Discord authentication or permission denied", this.fatalStatus);
        throw new DiscordApiError("Discord request failed or timed out");
      }
      const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
      if (response.status === 429 || response.headers.get("X-RateLimit-Remaining") === "0") {
        const raw = Number(response.status === 429
          ? record.retry_after ?? response.headers.get("Retry-After")
          : response.headers.get("X-RateLimit-Reset-After"));
        const ms = Number.isFinite(raw) && raw > 0 ? raw * 1000 : 30_000;
        const until = now() + ms;
        if (response.status === 429 && (record.global === true || response.headers.get("X-RateLimit-Global") === "true" || response.headers.get("X-RateLimit-Scope") === "global")) {
          this.globalCooldownUntil = Math.max(this.globalCooldownUntil, until);
        } else if (reaction) {
          this.reactionCooldownUntil = Math.max(this.reactionCooldownUntil, until);
        } else {
          this.cooldownUntil = Math.max(this.cooldownUntil, until);
        }
      }
      if (response.status === 429 && attempt < retries) continue;
      if (!response.ok) throw new DiscordApiError(`Discord HTTP ${response.status}`, response.status, Math.max(0, Math.max(this.globalCooldownUntil, reaction ? this.reactionCooldownUntil : this.cooldownUntil) - now()));
      if (response.status === 204) return undefined as T;
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new DiscordApiError("Invalid Discord response");
      return data as T;
    }
    throw new DiscordApiError("Discord retry limit reached");
  }

  async getMe(): Promise<{ id: string; username: string; bot: boolean }> {
    const me = await this.request<{ id: string; username: string; bot: boolean }>("/users/@me");
    if (!/^\d+$/.test(me.id) || typeof me.id !== "string" || typeof me.username !== "string" || me.bot !== true) {
      throw new DiscordApiError("Discord bot identity required");
    }
    return me;
  }

  async getChannel(channelId: string): Promise<{ id: string; type: number; parent_id?: string | null; owner_id?: string | null }> {
    this.checkId(channelId);
    const channel = await this.request<{ id: string; type: number; parent_id?: string | null; owner_id?: string | null }>(`/channels/${channelId}`);
    if (channel.id !== channelId || !Number.isInteger(channel.type)) throw new DiscordApiError("Invalid Discord channel");
    return channel;
  }

  async getGatewayBot(): Promise<DiscordGatewayInfo> {
    const gateway = await this.request<DiscordGatewayInfo>("/gateway/bot");
    const limit = gateway.session_start_limit;
    if (typeof gateway.url !== "string" || !limit || !Number.isSafeInteger(limit.remaining) || limit.remaining < 0 ||
        !Number.isFinite(limit.reset_after) || limit.reset_after < 0 || !Number.isSafeInteger(limit.total) || limit.total < 1 ||
        !Number.isSafeInteger(limit.max_concurrency) || limit.max_concurrency < 1) throw new DiscordApiError("Invalid Discord gateway response");
    return gateway;
  }

  sendMessage(channelId: string, content: string, eligible?: () => boolean): Promise<{ id: string }[]> {
    this.checkId(channelId);
    const result = this.sendQueue.then(() => this.sendMessageOrdered(channelId, content, eligible));
    this.sendQueue = result.then(() => {}, () => {});
    return result;
  }

  sendFile(channelId: string, name: string, data: Uint8Array, eligible?: () => boolean): Promise<{ id: string }[]> {
    this.checkId(channelId);
    if (!name || name.startsWith(".") || /[\/\\\x00-\x1f\x7f]/.test(name) || data.byteLength > 8 * 1024 * 1024) throw new DiscordApiError("Invalid Discord attachment");
    const result = this.sendQueue.then(async () => {
      const form = new FormData();
      form.append("payload_json", JSON.stringify({ allowed_mentions: { parse: [], replied_user: false } }));
      form.append("files[0]", new Blob([new Uint8Array(data)], { type: "application/octet-stream" }), name);
      const message = await this.request<{ id: string }>(`/channels/${channelId}/messages`, form, "POST", eligible);
      if (!message || typeof message.id !== "string" || !/^\d{1,20}$/.test(message.id)) throw new DiscordApiError("Invalid Discord message ID");
      return [message];
    });
    this.sendQueue = result.then(() => {}, () => {});
    return result;
  }

  private async sendMessageOrdered(channelId: string, content: string, eligible?: () => boolean): Promise<{ id: string }[]> {
    const { chunks, needsAttachment } = splitDiscordText(content);
    const messages: { id: string }[] = [];
    for (let index = 0; index < chunks.length + Number(needsAttachment); index++) {
      let body: unknown = { content: chunks[index], allowed_mentions: { parse: [], replied_user: false } };
      if (index === chunks.length) {
        const form = new FormData();
        form.append("payload_json", JSON.stringify({ allowed_mentions: { parse: [], replied_user: false } }));
        form.append("files[0]", new Blob([content], { type: "text/plain; charset=utf-8" }), "response.txt");
        body = form;
      }
      const message = await this.request<{ id: string }>(`/channels/${channelId}/messages`, body, "POST", eligible).catch(error => {
        if (error instanceof DiscordApiError) throw new DiscordApiError(error.message, error.status, error.retryAfterMs, messages);
        throw new DiscordApiError("Discord delivery failed", undefined, undefined, messages);
      });
      if (!message || typeof message.id !== "string" || !/^\d{1,20}$/.test(message.id)) throw new DiscordApiError("Invalid Discord message ID", undefined, undefined, messages);
      messages.push(message);
    }
    return messages;
  }

  async createThread(channelId: string, messageId: string, name: string): Promise<{ id: string }> {
    this.checkId(channelId);
    this.checkId(messageId);
    if (typeof name !== "string" || name.length < 1 || name.length > 100) throw new DiscordApiError("Invalid Discord thread name");
    const thread = await this.request<{ id: string }>(`/channels/${channelId}/messages/${messageId}/threads`, { name });
    if (!thread) throw new DiscordApiError("Invalid Discord thread response");
    this.checkId(thread.id);
    return thread;
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.reaction(channelId, messageId, emoji, "PUT");
  }

  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.reaction(channelId, messageId, emoji, "DELETE");
  }

  private async reaction(channelId: string, messageId: string, emoji: string, method: "PUT" | "DELETE"): Promise<void> {
    this.checkId(channelId);
    this.checkId(messageId);
    if (typeof emoji !== "string" || !emoji || emoji.length > 128 || !emoji.isWellFormed()) throw new DiscordApiError("Invalid Discord emoji");
    if (this.reactionsQueued >= 128) throw new DiscordApiError("Discord reaction queue full");
    this.reactionsQueued++;
    const result = this.reactionQueue.then(() => this.perform<void>(`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, undefined, method, undefined, true));
    this.reactionQueue = result.then(() => {}, () => {}).finally(() => { this.reactionsQueued--; });
    await result;
  }

  private checkId(id: string): void {
    if (typeof id !== "string" || !/^\d{1,20}$/.test(id)) throw new DiscordApiError("Invalid Discord ID");
  }
}
