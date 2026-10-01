export interface SlackApiOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  requestTimeoutMs?: number;
  maxRetries?: number;
  setTimeout?: (callback: () => void, ms: number) => Timer;
  clearTimeout?: (timer: Timer) => void;
}

export interface SlackIdentity { team_id: string; user_id: string; bot_id: string; app_id: string }
export interface SlackChannel {
  id: string;
  is_im?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
  context_team_id?: string;
}
export interface SlackMessage { ts: string }

export class SlackApiError extends Error {
  constructor(message: string, readonly status?: number, readonly retryAfterMs?: number, readonly sentMessages: SlackMessage[] = []) {
    super(message);
    this.name = "SlackApiError";
  }
}

export function isSlackChannelId(id: unknown): id is string { return typeof id === "string" && /^[CGD][A-Z0-9]+$/.test(id); }
export function isSlackUserId(id: unknown): id is string { return typeof id === "string" && /^[UW][A-Z0-9]+$/.test(id); }
export function isSlackTimestamp(value: unknown): value is string { return typeof value === "string" && /^\d{1,20}\.\d{6}$/.test(value); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

/** Ticket-bearing URLs are restricted before any WebSocket constructor sees them. */
export function slackSocketUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new SlackApiError("Invalid Slack Socket Mode URL"); }
  if (url.protocol !== "wss:" || !/^wss(?:-[a-z0-9-]+)?\.slack\.com$/.test(url.hostname) ||
      url.username || url.password || url.port || url.hash || url.pathname !== "/link/" || !url.searchParams.get("ticket")) {
    throw new SlackApiError("Invalid Slack Socket Mode URL");
  }
  return url.href;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const abort = () => { clearTimeout(timer); reject(new SlackApiError("Slack request stopped")); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return promise;
}

/** Tokens are headers only. Neither upstream response bodies nor thrown network errors are logged. */
export class SlackApi {
  private readonly controller = new AbortController();
  private queue = Promise.resolve();
  private queued = 0;
  private cooldownUntil = 0;
  private nextMessageAt = 0;
  private fatalStatus: number | undefined;

  constructor(private readonly botToken: string, private readonly appToken: string, private readonly options: SlackApiOptions = {}) {
    if (typeof botToken !== "string" || !/^(?:xoxe\.)?xoxb-\S+$/.test(botToken) ||
        typeof appToken !== "string" || !/^(?:xoxe\.)?xapp-\S+$/.test(appToken)) throw new SlackApiError("Slack requires bot and app-level access tokens");
  }

  stop(): void { this.controller.abort(); }

  private request(method: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.queued >= 128) return Promise.reject(new SlackApiError("Slack request queue full"));
    this.queued++;
    const result = this.queue.then(() => this.perform(method, body));
    this.queue = result.then(() => {}, () => {}).finally(() => { this.queued--; });
    return result;
  }

  private async perform(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = this.options.now ?? Date.now;
    const retries = Number.isFinite(this.options.maxRetries) ? Math.max(0, Math.min(Math.floor(this.options.maxRetries!), 3)) : 2;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (this.controller.signal.aborted) throw new SlackApiError("Slack request stopped");
      if (this.fatalStatus) throw new SlackApiError("Slack authentication or permission denied", this.fatalStatus);
      const wait = Math.max(this.cooldownUntil, method === "chat.postMessage" ? this.nextMessageAt : 0) - now();
      if (wait > 30_000) throw new SlackApiError("Slack rate limit cooldown active", 429, wait);
      if (wait > 0) await (this.options.sleep ?? delay)(wait, this.controller.signal);
      if (this.controller.signal.aborted) throw new SlackApiError("Slack request stopped");
      const timeout = new AbortController();
      const timer = (this.options.setTimeout ?? setTimeout)(() => timeout.abort(), Math.max(1, Math.min(this.options.requestTimeoutMs ?? 10_000, 30_000)));
      let response: Response;
      let data: unknown;
      try {
        const read = method === "conversations.info" || method === "bots.info";
        const query = new URLSearchParams(Object.entries(body).map(([key, value]): [string, string] => [key, String(value)]));
        response = await (this.options.fetchImpl ?? fetch)(`https://slack.com/api/${method}${read ? `?${query}` : ""}`, {
          method: read ? "GET" : "POST",
          headers: { Authorization: `Bearer ${method === "apps.connections.open" ? this.appToken : this.botToken}`, "Content-Type": "application/json; charset=utf-8" },
          body: read ? undefined : JSON.stringify(body),
          signal: AbortSignal.any([this.controller.signal, timeout.signal]),
          redirect: "error",
        });
        if (response.status === 401 || response.status === 403) this.fatalStatus = response.status;
        data = await response.json().catch(error => { if (response.ok) throw error; return null; });
      } catch {
        // An uncertain POST is never retried: Slack may have accepted the message already.
        throw new SlackApiError(this.fatalStatus ? "Slack authentication or permission denied" : "Slack request failed or timed out", this.fatalStatus);
      } finally { (this.options.clearTimeout ?? clearTimeout)(timer); }
      if (response.status === 429) {
        const seconds = Number(response.headers.get("Retry-After"));
        const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000;
        this.cooldownUntil = Math.max(this.cooldownUntil, now() + ms);
        if (attempt < retries) continue;
        throw new SlackApiError("Slack rate limited", 429, ms);
      }
      if (!response.ok) throw new SlackApiError(`Slack HTTP ${response.status}`, response.status);
      if (!object(data)) throw new SlackApiError("Invalid Slack response");
      if (data.ok !== true) {
        if (["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"].includes(String(data.error))) this.fatalStatus = 401;
        if (["missing_scope", "no_permission", "access_denied", "not_allowed_token_type"].includes(String(data.error))) this.fatalStatus = 403;
        throw new SlackApiError(this.fatalStatus ? "Slack authentication or permission denied" : "Slack API request rejected", this.fatalStatus);
      }
      if (method === "chat.postMessage") this.nextMessageAt = now() + 1000;
      return data;
    }
    throw new SlackApiError("Slack retry limit reached");
  }

  async getMe(): Promise<SlackIdentity> {
    const me = await this.request("auth.test");
    if (typeof me.team_id !== "string" || !/^T[A-Z0-9]+$/.test(me.team_id) || !isSlackUserId(me.user_id) ||
        typeof me.bot_id !== "string" || !/^B[A-Z0-9]+$/.test(me.bot_id)) throw new SlackApiError("Slack bot identity required");
    const result = await this.request("bots.info", { bot: me.bot_id });
    const bot = result.bot;
    if (!object(bot) || bot.id !== me.bot_id || bot.user_id !== me.user_id || bot.deleted === true ||
        typeof bot.app_id !== "string" || !/^A[A-Z0-9]+$/.test(bot.app_id)) throw new SlackApiError("Slack bot app identity required");
    return { team_id: me.team_id, user_id: me.user_id, bot_id: me.bot_id, app_id: bot.app_id };
  }

  async getChannel(channelId: string): Promise<SlackChannel> {
    if (!isSlackChannelId(channelId)) throw new SlackApiError("Invalid Slack channel ID");
    const result = await this.request("conversations.info", { channel: channelId });
    const channel = result.channel;
    if (!object(channel) || channel.id !== channelId || channel.is_archived === true ||
        (channel.is_im !== true && channel.is_member !== true)) throw new SlackApiError("Slack channel is unavailable or bot is not a member");
    if (channel.context_team_id !== undefined && (typeof channel.context_team_id !== "string" || !/^T[A-Z0-9]+$/.test(channel.context_team_id))) throw new SlackApiError("Invalid Slack channel workspace");
    return channel as unknown as SlackChannel;
  }

  async openConnection(): Promise<{ url: string }> {
    const result = await this.request("apps.connections.open");
    if (typeof result.url !== "string") throw new SlackApiError("Invalid Slack Socket Mode response");
    return { url: slackSocketUrl(result.url) };
  }

  async sendMessage(channelId: string, text: string, threadTs?: string): Promise<SlackMessage[]> {
    if (!isSlackChannelId(channelId) || (threadTs !== undefined && !isSlackTimestamp(threadTs))) throw new SlackApiError("Invalid Slack message destination");
    if (!text.trim()) return [];
    if (text.length > 256_000) throw new SlackApiError("Slack message exceeds relay limit");
    const sent: SlackMessage[] = [];
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(offset + 4000, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
      // Escape explicit mention syntax as well as disabling automatic link/name parsing.
      const chunk = text.slice(offset, end).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      try {
        const result = await this.request("chat.postMessage", { channel: channelId, text: chunk, thread_ts: threadTs,
          mrkdwn: false, parse: "none", link_names: false, unfurl_links: false, unfurl_media: false });
        if (!isSlackTimestamp(result.ts) || result.channel !== channelId) throw new SlackApiError("Invalid Slack message response");
        sent.push({ ts: result.ts });
      } catch (error) {
        throw new SlackApiError(error instanceof SlackApiError ? error.message : "Slack delivery failed",
          error instanceof SlackApiError ? error.status : undefined, error instanceof SlackApiError ? error.retryAfterMs : undefined, sent);
      }
      offset = end;
    }
    return sent;
  }
}
