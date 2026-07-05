/**
 * `jeo notify setup|status` — configure and inspect the remote subagent
 * notification/control channel (gjc `gjc notify setup`/`gjc notify status`
 * parity, scoped to jeo's Telegram + subagent surface; see `src/agent/notify/`).
 */
import { createInterface } from "node:readline/promises";
import { readGlobalConfig, saveConfigPatch } from "../agent/state";
import { TelegramApi, maskToken } from "../agent/notify/telegram-api";
import { daemonStatus } from "../agent/notify/daemon-control";

function parseFlags(args: string[]): { token?: string; chatId?: string } {
  const out: { token?: string; chatId?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--token" && args[i + 1]) out.token = args[++i];
    else if (args[i] === "--chat-id" && args[i + 1]) out.chatId = args[++i];
  }
  return out;
}

async function runSetup(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  let token = flags.token;
  let chatId = flags.chatId;

  if (!token || !chatId) {
    if (!process.stdin.isTTY) {
      console.log(
        "jeo notify setup needs an interactive terminal (TTY) unless both --token and --chat-id are given.\n" +
          "Non-interactive: jeo notify setup --token <botToken> --chat-id <chatId>",
      );
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log("\n=== jeo notify setup (Telegram) ===");
      console.log("Create a bot with @BotFather (https://core.telegram.org/bots/features#botfather), then paste its token below.\n");
      if (!token) token = (await rl.question("Telegram BotFather token: ")).trim();
      if (!token) {
        console.log("No token given — aborting.");
        return;
      }
      const api = new TelegramApi(token);
      const me = await api.getMe();
      if (!me.ok || !me.result) {
        console.log(`Telegram getMe failed: ${me.description ?? "invalid token"}. Re-copy the token from BotFather and retry.`);
        return;
      }
      console.log(`Bot verified: @${me.result.username}`);

      if (!chatId) {
        console.log(`\nMessage @${me.result.username} from your Telegram account now (any text). Waiting...`);
        let offset: number | undefined;
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline && !chatId) {
          const updates = await api.getUpdates(offset, 5);
          if (updates.ok) {
            for (const u of updates.result) {
              offset = u.update_id + 1;
              const chat = u.message?.chat;
              if (chat && chat.type === "private") {
                chatId = String(chat.id);
                break;
              }
            }
          }
        }
        if (!chatId) {
          console.log("Timed out waiting for a private message. Re-run 'jeo notify setup' and message the bot promptly.");
          return;
        }
        console.log(`Paired private chat id ${chatId}.`);
      }
    } finally {
      rl.close();
    }
  } else {
    const api = new TelegramApi(token);
    const me = await api.getMe();
    if (!me.ok) {
      console.log(`Telegram getMe failed: ${me.description ?? "invalid token"}.`);
      return;
    }
  }

  await saveConfigPatch(raw => ({
    notifications: { ...raw.notifications, enabled: true, telegram: { botToken: token, chatId } },
  }));
  console.log(`\nNotifications enabled. botToken=${maskToken(token!)} chatId=${chatId}`);
  console.log("Start the daemon with 'jeo daemon start', then run a detached subagent (task {detached:true}) to see it appear in Telegram.");
}

async function runStatus(): Promise<void> {
  const config = await readGlobalConfig();
  const enabled = Boolean(config.notifications?.enabled);
  const botToken = config.notifications?.telegram?.botToken;
  const chatId = config.notifications?.telegram?.chatId;
  const status = await daemonStatus();
  console.log(`enabled=${enabled}`);
  console.log(`botToken=${botToken ? maskToken(botToken) : "(not set)"}`);
  console.log(`chatId=${chatId ?? "(not set)"}`);
  console.log(`daemon=${status.running ? `running (pid ${status.pid})` : status.stale ? "stale (crashed without cleanup)" : "stopped"}`);
}

export async function runNotifyCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? "status";
  if (sub === "setup") return runSetup(args.slice(1));
  if (sub === "status") return runStatus();
  console.log(`Unknown 'jeo notify' subcommand '${sub}'. Usage: jeo notify [setup|status]`);
}
