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

export class DiscordApi {
  private readonly controller = new AbortController();
  private cooldownUntil = 0;
  private fatalStatus: number | undefined;
  private queue = Promise.resolve();
  private queued = 0;

  constructor(private readonly token: string, private readonly options: DiscordApiOptions = {}) {}

  stop(): void { this.controller.abort(); }

  private request<T>(route: string, body?: unknown): Promise<T> {
    if (this.queued >= 128) return Promise.reject(new DiscordApiError("Discord request queue full"));
    this.queued++;
    const result = this.queue.then(() => this.perform<T>(route, body));
    this.queue = result.then(() => {}, () => {}).finally(() => { this.queued--; });
    return result;
  }

  private async perform<T>(route: string, body?: unknown): Promise<T> {
    const now = this.options.now ?? Date.now;
    const retries = Math.max(0, Math.min(this.options.maxRetries ?? 2, 3));
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (this.controller.signal.aborted) throw new DiscordApiError("Discord request stopped");
      if (this.fatalStatus) throw new DiscordApiError("Discord authentication or permission denied", this.fatalStatus);
      const wait = this.cooldownUntil - now();
      if (wait > 30_000) throw new DiscordApiError("Discord rate limit cooldown active", 429, wait);
      if (wait > 0) await (this.options.sleep ?? delay)(wait, this.controller.signal);
      if (this.controller.signal.aborted) throw new DiscordApiError("Discord request stopped");
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(this.options.requestTimeoutMs ?? 10_000, 30_000)));
      let response: Response;
      let data: unknown;
      try {
        response = await (this.options.fetchImpl ?? fetch)(`https://discord.com/api/v10${route}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { Authorization: `Bot ${this.token}`, "Content-Type": "application/json", "User-Agent": `DiscordBot (https://github.com/akillness/jeo-code, ${version})` },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.any([this.controller.signal, timeout]),
          redirect: "error",
        });
        if (response.status === 401 || response.status === 403) this.fatalStatus = response.status;
        data = await response.json().catch(error => {
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
        // One serialized bot lane conservatively honors both route and global cooldowns.
        this.cooldownUntil = Math.max(this.cooldownUntil, now() + ms);
      }
      if (response.status === 429 && attempt < retries) continue;
      if (!response.ok) throw new DiscordApiError(`Discord HTTP ${response.status}`, response.status, Math.max(0, this.cooldownUntil - now()));
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

  async getChannel(channelId: string): Promise<{ id: string; type: number }> {
    this.checkId(channelId);
    const channel = await this.request<{ id: string; type: number }>(`/channels/${channelId}`);
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

  async sendMessage(channelId: string, content: string): Promise<{ id: string }[]> {
    this.checkId(channelId);
    if (!content.trim()) return [];
    if (content.length > 256_000) throw new DiscordApiError("Discord message exceeds relay limit");
    const messages: { id: string }[] = [];
    for (let offset = 0; offset < content.length;) {
      let end = Math.min(offset + 2000, content.length);
      if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]!)) end--;
      const message = await this.request<{ id: string }>(`/channels/${channelId}/messages`, {
        content: content.slice(offset, end), allowed_mentions: { parse: [], replied_user: false },
      }).catch(error => {
        if (error instanceof DiscordApiError) throw new DiscordApiError(error.message, error.status, error.retryAfterMs, messages);
        throw new DiscordApiError("Discord delivery failed", undefined, undefined, messages);
      });
      if (typeof message.id !== "string" || !/^\d+$/.test(message.id)) throw new DiscordApiError("Invalid Discord message ID", undefined, undefined, messages);
      messages.push(message);
      offset = end;
    }
    return messages;
  }

  private checkId(id: string): void {
    if (typeof id !== "string" || !/^\d{1,20}$/.test(id)) throw new DiscordApiError("Invalid Discord ID");
  }
}
