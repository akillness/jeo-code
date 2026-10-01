/** Configure and inspect Telegram, Discord, and Slack notification channels. */
import { createInterface } from "node:readline/promises";
import { readGlobalConfig, saveConfigPatch } from "../agent/state";
import { TelegramApi } from "../agent/notify/telegram-api";
import { DiscordApi, DiscordApiError } from "../agent/notify/discord-api";
import { SlackApi, SlackApiError } from "../agent/notify/slack-api";
import { acquireDaemonLock, daemonStatus } from "../agent/notify/daemon-control";

type Provider = "telegram" | "discord" | "slack";
interface NotifyOptions {
  fetchImpl?: typeof fetch;
  prompt?: (question: string) => Promise<string>;
  pairingChallenge?: () => string;
  now?: () => number;
}
interface Flags {
  provider: Provider;
  token?: string;
  tokenEnv?: string;
  appTokenEnv?: string;
  chatId?: string;
  channelId?: string;
  allowedUserIds?: string[];
}

function parseFlags(args: string[]): Flags {
  const out: Flags = { provider: "telegram" };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error("Missing value for notify option (use --token-env NAME for credentials)");
    if (flag === "--provider" || flag === "--platform") {
      if (value !== "telegram" && value !== "discord" && value !== "slack") throw new Error("Provider must be telegram, discord or slack");
      out.provider = value;
    } else if (flag === "--token") out.token = value;
    else if (flag === "--token-env") out.tokenEnv = value;
    else if (flag === "--app-token-env") out.appTokenEnv = value;
    else if (flag === "--chat-id") out.chatId = value;
    else if (flag === "--channel-id") out.channelId = value;
    else if (flag === "--allowed-user-ids") {
      out.allowedUserIds = [...new Set(value.split(",").map(id => id.trim()))];
    } else throw new Error("Unknown notify option; use --provider, --token-env, --app-token-env, --chat-id, --channel-id or --allowed-user-ids");
  }
  if (out.chatId && !/^-?[1-9]\d*$/.test(out.chatId)) throw new Error("Telegram chat ID must be a nonzero decimal ID");
  if (out.provider === "slack") {
    if (out.channelId && !/^[CGD][A-Z0-9]+$/.test(out.channelId)) throw new Error("Slack channel ID must start with C, G or D and contain uppercase letters and digits");
    if (out.allowedUserIds && !out.allowedUserIds.every(id => /^[UW][A-Z0-9]+$/.test(id))) throw new Error("Slack allowed user IDs must start with U or W and contain uppercase letters and digits");
  } else {
    if (out.channelId && !/^[1-9]\d{0,19}$/.test(out.channelId)) throw new Error("Discord channel ID must be a positive decimal ID of at most 20 digits");
    if (out.allowedUserIds && !out.allowedUserIds.every(id => /^[1-9]\d{0,19}$/.test(id))) throw new Error("Allowed user IDs must be positive decimal IDs (up to 20 digits) separated by commas");
  }
  return out;
}

async function question(text: string, opts: NotifyOptions): Promise<string> {
  if (opts.prompt) return (await opts.prompt(text)).trim();
  if (!process.stdin.isTTY) throw new Error("Missing setup arguments; use --token-env and explicit destination/user IDs without a TTY");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(text)).trim(); } finally { rl.close(); }
}

// Telegram puts credentials in request URLs. Never print underlying fetch errors.
function boundedFetch(opts: NotifyOptions): typeof fetch {
  return ((input, init) => (opts.fetchImpl ?? fetch)(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) })) as typeof fetch;
}

async function verifySlack(api: SlackApi, channelId: string): Promise<void> {
  const me = await api.getMe();
  const channel = await api.getChannel(channelId);
  if (channel.id !== channelId || (channel.context_team_id && channel.context_team_id !== me.team_id)) throw new Error("Slack bot and destination workspace validation failed");
  await api.openConnection();
}

async function runSetup(flags: Flags, opts: NotifyOptions): Promise<void> {
  const envName = flags.tokenEnv ?? `JEO_${flags.provider.toUpperCase()}_BOT_TOKEN`;
  let token = flags.token ?? process.env[envName]?.trim();
  if (!token) {
    const name = await question(`Set the bot token in an environment variable, then enter its NAME (default ${envName}): `, opts);
    token = process.env[name || envName]?.trim();
  }
  if (!token) throw new Error(`Bot token environment variable is empty; use --token-env NAME (preferred over --token)`);
  const existing = (await readGlobalConfig()).notifications;
  let allowedUserIds = flags.allowedUserIds;
  if (flags.provider === "slack") {
    const appEnvName = flags.appTokenEnv ?? "SLACK_APP_TOKEN";
    let appToken = process.env[appEnvName]?.trim();
    if (!appToken) {
      const name = await question(`Set the Slack app token in an environment variable, then enter its NAME (default ${appEnvName}): `, opts);
      appToken = process.env[name || appEnvName]?.trim();
    }
    if (!appToken) throw new Error("Slack app token environment variable is empty; use --app-token-env NAME");
    const channelId = flags.channelId ?? existing?.slack?.channelId ?? await question("Slack channel ID: ", opts);
    if (!/^[CGD][A-Z0-9]+$/.test(channelId)) throw new Error("Slack requires a valid channel ID");
    const sameDestination = existing?.slack?.botToken === token && existing.slack.appToken === appToken && existing.slack.channelId === channelId;
    if (!allowedUserIds?.length && (!sameDestination || !existing?.slack?.allowedUserIds.length)) allowedUserIds = (await question("Allowed Slack human user IDs (comma separated; required after token/destination changes): ", opts)).split(",").map(id => id.trim());
    const api = new SlackApi(token, appToken, { fetchImpl: boundedFetch(opts) });
    try {
      await verifySlack(api, channelId);
      await saveConfigPatch(raw => {
        const previous = raw.notifications?.slack;
        const unchanged = previous?.botToken === token && previous.appToken === appToken && previous.channelId === channelId;
        const owners = allowedUserIds ?? (unchanged ? previous.allowedUserIds : undefined);
        if (!owners?.length || !owners.every(id => /^[UW][A-Z0-9]+$/.test(id))) throw new Error("Slack requires explicit allowed human user IDs; repeat --allowed-user-ids after token or destination changes");
        return { notifications: { ...raw.notifications, enabled: true, slack: { botToken: token, appToken, channelId, allowedUserIds: owners } } };
      });
    } finally { api.stop(); }
    console.log(`Slack bot and channel verified; channelId=${channelId}. Notifications enabled. Setup did not send a message.`);
    console.log("Socket Mode URL verified; app-token ownership and socket connectivity are checked by the daemon handshake. Token rotation requires an explicit user allowlist.");
  } else if (flags.provider === "discord") {
    const channelId = flags.channelId ?? existing?.discord?.channelId ?? await question("Discord channel ID: ", opts);
    const sameDestination = existing?.discord?.botToken === token && existing.discord.channelId === channelId;
    if (!allowedUserIds?.length && (!sameDestination || !existing?.discord?.allowedUserIds?.length)) allowedUserIds = (await question("Allowed Discord user IDs (comma separated; required after token/destination changes): ", opts)).split(",").map(id => id.trim());
    if (!/^[1-9]\d{0,19}$/.test(channelId)) throw new Error("Discord requires a positive channel ID (up to 20 digits)");
    const api = new DiscordApi(token, { fetchImpl: boundedFetch(opts) });
    const me = await api.getMe();
    if (!me.bot) throw new Error("Discord identity is not a bot");
    const channel = await api.getChannel(channelId);
    if (channel.id !== channelId || ![0, 1, 5, 10, 11, 12].includes(channel.type)) throw new Error("Discord destination must be a text channel, thread, or bot DM");
    await saveConfigPatch(raw => {
      const previous = raw.notifications?.discord;
      const unchanged = previous?.botToken === token && previous.channelId === channelId;
      const owners = allowedUserIds ?? (unchanged ? previous.allowedUserIds : undefined);
      if (!owners?.length || !owners.every(id => /^[1-9]\d{0,19}$/.test(id))) throw new Error("Discord requires explicit allowed user IDs; repeat --allowed-user-ids after token or destination changes");
      return { notifications: { ...raw.notifications, enabled: true, discord: { ...(unchanged ? previous : {}), botToken: token, channelId, allowedUserIds: owners } } };
    });
    console.log(`Discord bot verified; channelId=${channelId}. Notifications enabled.`);
    console.log("Guild channels require MESSAGE CONTENT intent and View Channel/Send Messages permissions. Setup did not send a message.");
    console.log("Token rotation or destination changes require an explicit user allowlist.");
  } else {
    const api = new TelegramApi(token, boundedFetch(opts));
    const me = await api.getMe();
    if (!me.ok || !me.result?.is_bot) throw new Error("Telegram getMe failed: invalid bot credentials or API unavailable");
    const botId = String(me.result.id);
    let chatId = flags.chatId;
    let pairedUserId: string | undefined;
    if (!chatId) {
      if (!opts.prompt && !process.stdin.isTTY) throw new Error("Telegram auto-pairing requires a TTY; use explicit --chat-id otherwise");
      const lock = await acquireDaemonLock("pairing");
      if (!lock) throw new Error("A daemon or pairing process owns getUpdates; stop the daemon before auto-pairing, or use explicit --chat-id");
      try {
        const challenge = `/start jeo_${opts.pairingChallenge?.() ?? crypto.randomUUID()}`;
        console.log(`Send exactly '${challenge}' to @${me.result.username} in a private chat within 120 seconds.`);
        let offset: number | undefined;
        const now = opts.now ?? Date.now;
        const startedAt = now();
        const deadline = startedAt + 120_000;
        while (now() < deadline && !chatId) {
          const updates = await api.getUpdates(offset, 5);
          if (!updates.ok || !Array.isArray(updates.result)) throw new Error("Telegram pairing getUpdates failed (check bot polling ownership or credentials)");
          for (const update of updates.result) {
            if (!Number.isSafeInteger(update.update_id) || (offset !== undefined && update.update_id < offset)) continue;
            offset = update.update_id + 1;
            const msg = update.message;
            if (msg?.chat.type === "private" && msg.date >= Math.floor(startedAt / 1000) && msg.text === challenge && msg.from && !msg.from.is_bot && String(msg.from.id) === String(msg.chat.id)) {
              chatId = String(msg.chat.id);
              pairedUserId = String(msg.from.id);
              break;
            }
          }
        }
        if (!chatId) throw new Error("Telegram pairing timed out; no matching private challenge received");
      } finally { await lock.release(); }
    }
    const chat = await api.getChat(chatId);
    if (!chat.ok || !chat.result?.type) throw new Error("Telegram chat lookup failed; check chat ID and bot access");
    await saveConfigPatch(raw => {
      const previous = raw.notifications?.telegram;
      const sameDestination = previous?.chatId === chatId && (
        previous.botToken === token || previous.botToken?.match(/^([1-9]\d*):/)?.[1] === botId
      );
      const owners = allowedUserIds ?? (sameDestination ? previous.allowedUserIds : undefined) ?? (pairedUserId ? [pairedUserId] : undefined);
      if (chat.result!.type !== "private" && !owners?.length) throw new Error("Telegram groups require explicit --allowed-user-ids");
      return { notifications: { ...raw.notifications, enabled: true, telegram: { ...(sameDestination ? previous : {}), botToken: token, chatId, ...(owners ? { allowedUserIds: owners } : {}) } } };
    });
    console.log(`Telegram bot verified; chatId=${chatId}. Notifications enabled. Setup did not send a message.`);
  }
  console.log("Run 'jeo daemon start' (or reload if already running) to apply. Use 'jeo notify health --provider " + flags.provider + "' for read-only API checks; 'jeo notify test --provider " + flags.provider + "' explicitly sends a test message.");
}

async function runStatus(provider: Provider): Promise<void> {
  const config = await readGlobalConfig();
  const n = config.notifications;
  const channel = n?.[provider];
  const status = await daemonStatus();
  console.log(`provider=${provider} enabled=${Boolean(n?.enabled)}`);
  console.log(`botToken=${channel?.botToken ? "(set)" : "(not set)"}`);
  if (provider === "slack") console.log(`appToken=${n?.slack?.appToken ? "(set)" : "(not set)"}`);
  console.log(provider === "telegram" ? `chatId=${n?.telegram?.chatId ?? "(not set)"}` : `channelId=${n?.[provider]?.channelId ?? "(not set)"}`);
  console.log(`allowedUserIds=${channel?.allowedUserIds?.join(",") ?? (provider === "telegram" ? "private chat owner only" : "(not set; inbound disabled)")}`);
  console.log(`daemon=${status.pairing ? "pairing owns polling (daemon not running)" : status.running ? `process ${status.ready ? "initialized" : "initializing"} (pid ${status.pid}; transport connectivity not checked)` : status.stale ? "stale" : "stopped"}`);
  console.log("Channel health not checked; use 'jeo notify health --provider " + provider + "'.");
}

async function runHealth(provider: Provider, send: boolean, opts: NotifyOptions): Promise<void> {
  const n = (await readGlobalConfig()).notifications;
  if (provider === "slack") {
    const cfg = n?.slack;
    if (!cfg?.botToken || !cfg.appToken || !cfg.channelId || !cfg.allowedUserIds?.length) throw new Error("Slack is incomplete: bot token, app token, channel ID and allowed user IDs are required");
    const api = new SlackApi(cfg.botToken, cfg.appToken, { fetchImpl: boundedFetch(opts) });
    try {
      await verifySlack(api, cfg.channelId);
      if (send) await api.sendMessage(cfg.channelId, "jeo notification test");
    } finally { api.stop(); }
    if (!send) console.log("Slack Socket Mode URL verified; app-token ownership, socket connectivity and send permissions are not tested until daemon handshake/test.");
  } else if (provider === "discord") {
    const cfg = n?.discord;
    if (!cfg?.botToken || !cfg.channelId || !cfg.allowedUserIds?.length) throw new Error("Discord is incomplete: bot token, channel ID and allowed user IDs are required");
    const api = new DiscordApi(cfg.botToken, { fetchImpl: boundedFetch(opts) });
    const me = await api.getMe();
    const channel = await api.getChannel(cfg.channelId);
    if (!me.bot || channel.id !== cfg.channelId || ![0, 1, 5, 10, 11, 12].includes(channel.type)) throw new Error("Discord identity/channel validation failed");
    if (send) await api.sendMessage(cfg.channelId, "jeo notification test");
  } else {
    const cfg = n?.telegram;
    if (!cfg?.botToken || !cfg.chatId) throw new Error("Telegram is incomplete: bot token and chat ID are required");
    const api = new TelegramApi(cfg.botToken, boundedFetch(opts));
    const me = await api.getMe();
    const chat = await api.getChat(cfg.chatId);
    if (!me.ok || !me.result?.is_bot || !chat.ok || !chat.result?.type) throw new Error("Telegram bot/chat validation failed (check credentials and access)");
    if (chat.result.type !== "private" && !cfg.allowedUserIds?.length) throw new Error("Telegram groups require an explicit user allowlist");
    if (send && !(await api.sendMessage(cfg.chatId, "jeo notification test", { messageThreadId: cfg.topicId })).ok) throw new Error("Telegram test send failed (check permissions/rate limit)");
  }
  console.log(`${provider}: ${send ? "test message sent" : "bot identity and destination accessible (read-only; Gateway/poll connectivity and send permissions not tested)"}. enabled=${Boolean(n?.enabled)}`);
}

export async function runNotifyCommand(args: string[], opts: NotifyOptions = {}): Promise<void> {
  const sub = args[0] ?? "status";
  try {
    const flags = parseFlags(args.slice(1));
    if (sub === "setup") return await runSetup(flags, opts);
    if (sub === "status") return await runStatus(flags.provider);
    if (sub === "health" || sub === "test") return await runHealth(flags.provider, sub === "test", opts);
    throw new Error("Usage: jeo notify [setup|status|health|test] [--provider telegram|discord|slack]");
  } catch (error) {
    // Only emit our known configuration/API errors, never fetch URLs or token-bearing bodies.
    const message = error instanceof Error ? error.message : "request failed";
    const safe = /^(Missing |Unknown notify|Provider |Allowed user|Telegram |Discord |Slack |Bot token|Missing setup|A daemon|Notification lock recovery|Usage:)/.test(message) && !message.includes("https:") && !message.includes("http:");
    console.error(`Notification ${sub} failed: ${safe ? message : "API or storage request failed; check credentials, connectivity and permissions"}${(error instanceof DiscordApiError || error instanceof SlackApiError) && error.status ? ` (HTTP ${error.status})` : ""}`);
    process.exitCode = 1;
  }
}
