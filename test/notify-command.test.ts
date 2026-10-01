import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runNotifyCommand } from "../src/commands/notify";
import { readGlobalConfig, saveConfigPatch } from "../src/agent/state";
import { acquireDaemonLock, readDaemonLock, isNotifyConfigured } from "../src/agent/notify/daemon-control";

let dir: string;
let savedCfgDir: string | undefined;
let savedExitCode: typeof process.exitCode;
let logs: string[];
let errors: string[];
let restoreConsole: () => void;

beforeEach(async () => {
  savedCfgDir = process.env.JEO_CONFIG_DIR;
  savedExitCode = process.exitCode;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-notify-cmd-"));
  process.env.JEO_CONFIG_DIR = dir;
  process.exitCode = 0;
  logs = [];
  errors = [];
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => logs.push(args.map(String).join(" ")));
  const error = spyOn(console, "error").mockImplementation((...args: unknown[]) => errors.push(args.map(String).join(" ")));
  restoreConsole = () => { log.mockRestore(); error.mockRestore(); };
});

afterEach(async () => {
  restoreConsole();
  process.exitCode = savedExitCode;
  if (savedCfgDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = savedCfgDir;
  await fs.rm(dir, { recursive: true, force: true });
});

interface RequestRecord { url: URL; method: string; body: unknown }
function apiFake(respond: (request: RequestRecord) => unknown) {
  const requests: RequestRecord[] = [];
  const implementation = async (input: string | URL | Request, init?: RequestInit) => {
    const request = { url: new URL(input instanceof Request ? input.url : String(input)), method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    requests.push(request);
    return Response.json(await respond(request));
  };
  // The injected HTTP boundary does not use Bun's fetch.preconnect extension.
  const fetchImpl = implementation as typeof fetch;
  return { requests, fetchImpl };
}

function telegramReply(request: RequestRecord, chatType = "private") {
  if (request.url.pathname.endsWith("/getMe")) return { ok: true, result: { id: 1, is_bot: true, username: "jeo_bot" } };
  if (request.url.pathname.endsWith("/getChat")) return { ok: true, result: { id: 999, type: chatType } };
  throw new Error(`Unexpected fake API method ${request.url.pathname}`);
}

test("Telegram re-setup preserves topic, authorization, and other notification settings without sending", async () => {
  await saveConfigPatch(() => ({ notifications: { enabled: false, verbosity: "verbose", redact: true,
    telegram: { botToken: "1:OLD-TOKEN", chatId: "999", topicId: 55, perSessionTopics: true, allowedUserIds: ["999"] },
    discord: { botToken: "discord-secret", channelId: "123456789012345678", allowedUserIds: ["234567890123456789"] },
  } }));
  const previous = (await readGlobalConfig()).notifications!;
  const fake = apiFake(telegramReply);
  await runNotifyCommand(["setup", "--token", "1:NEW-TOKEN", "--chat-id", "999"], fake);
  expect(errors).toEqual([]);
  expect((await readGlobalConfig()).notifications).toEqual({ ...previous, enabled: true,
    telegram: { ...previous.telegram, botToken: "1:NEW-TOKEN", chatId: "999" },
  });
  expect(fake.requests.map(request => request.url.pathname.split("/").at(-1))).toEqual(["getMe", "getChat"]);
  expect(logs.join("\n")).not.toContain("1:NEW-TOKEN");
});

test.each([
  { name: "chat changes", previousChat: "888", previousToken: "1:OLD-TOKEN" },
  { name: "bot changes", previousChat: "999", previousToken: "2:OLD-TOKEN" },
])("Telegram re-setup clears inherited authority and topic routing when $name", async ({ previousChat, previousToken }) => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, telegram: {
    botToken: previousToken, chatId: previousChat, allowedUserIds: ["777"], topicId: 55, perSessionTopics: true,
  } } }));
  const fake = apiFake(request => request.url.pathname.endsWith("/sendMessage") ? { ok: true } : telegramReply(request));
  await runNotifyCommand(["setup", "--token", "1:NEW-TOKEN", "--chat-id", "999"], fake);
  expect(errors).toEqual([]);
  const config = (await readGlobalConfig()).notifications!.telegram!;
  expect(config.allowedUserIds).toBeUndefined();
  expect(config.topicId).toBeUndefined();
  expect(config.perSessionTopics).toBeUndefined();
  await runNotifyCommand(["test", "--provider", "telegram"], fake);
  const sent = fake.requests.filter(request => request.url.pathname.endsWith("/sendMessage"));
  expect(sent.map(request => request.body)).toEqual([
    expect.objectContaining({ chat_id: "999", text: "jeo notification test" }),
  ]);
  expect(sent[0]!.body).not.toHaveProperty("message_thread_id");
});

test.each([
  { name: "chat changes", previousChat: "-888", previousToken: "1:OLD-TOKEN" },
  { name: "bot changes", previousChat: "-999", previousToken: "2:OLD-TOKEN" },
])("Telegram group re-setup cannot borrow a prior allowlist when $name", async ({ previousChat, previousToken }) => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, telegram: {
    botToken: previousToken, chatId: previousChat, allowedUserIds: ["777"], topicId: 55, perSessionTopics: true,
  } } }));
  const before = (await readGlobalConfig()).notifications;
  const fake = apiFake(request => telegramReply(request, "supergroup"));
  await runNotifyCommand(["setup", "--token", "1:NEW-TOKEN", "--chat-id", "-999"], fake);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("require explicit");
  expect((await readGlobalConfig()).notifications).toEqual(before);
});

test("Telegram changed destination keeps explicitly authorized new owners but not the old topic", async () => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, telegram: {
    botToken: "2:OLD-TOKEN", chatId: "-888", allowedUserIds: ["777"], topicId: 55, perSessionTopics: true,
  } } }));
  const fake = apiFake(request => telegramReply(request, "supergroup"));
  await runNotifyCommand(["setup", "--token", "1:NEW-TOKEN", "--chat-id", "-999", "--allowed-user-ids", "123,456"], fake);
  expect(errors).toEqual([]);
  expect((await readGlobalConfig()).notifications?.telegram).toEqual({
    botToken: "1:NEW-TOKEN", chatId: "-999", allowedUserIds: ["123", "456"],
  });
});

test("rejected credentials preserve the previously working configuration and fail the command", async () => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, telegram: { botToken: "valid-token", chatId: "999" } } }));
  const before = (await readGlobalConfig()).notifications;
  const fake = apiFake(() => ({ ok: false, description: "Unauthorized" }));
  await runNotifyCommand(["setup", "--token", "bad-token", "--chat-id", "999"], fake);
  expect(process.exitCode).toBe(1);
  expect((await readGlobalConfig()).notifications).toEqual(before);
  expect(errors.join("\n")).toContain("getMe failed");
});

test("status hides both stored tokens while reporting the selected provider", async () => {
  await saveConfigPatch(() => ({ notifications: { enabled: true,
    telegram: { botToken: "999999:TELEGRAM-SECRET", chatId: "999" },
    discord: { botToken: "DISCORD-SECRET", channelId: "123456789012345678", allowedUserIds: ["234567890123456789"] },
  } }));
  await runNotifyCommand(["status", "--provider", "discord"]);
  const text = logs.join("\n");
  expect(text).toContain("provider=discord");
  expect(text).toContain("channelId=123456789012345678");
  expect(text).not.toContain("DISCORD-SECRET");
  expect(text).not.toContain("999999:TELEGRAM-SECRET");
});

test("Discord-only setup creates usable configuration without sending or editing the Telegram settings", async () => {
  const fake = apiFake(request => {
    if (request.url.pathname.endsWith("/users/@me")) return { id: "345678901234567890", bot: true, username: "jeo" };
    if (request.url.pathname.endsWith("/channels/123456789012345678")) return { id: "123456789012345678", type: 0 };
    throw new Error("Unexpected Discord API operation");
  });
  await runNotifyCommand(["setup", "--provider", "discord", "--token", "DISCORD-SECRET", "--channel-id", "123456789012345678", "--allowed-user-ids", "234567890123456789"], fake);
  expect(errors).toEqual([]);
  expect(await isNotifyConfigured()).toBe(true);
  expect((await readGlobalConfig()).notifications?.telegram).toBeUndefined();
  expect(fake.requests.map(request => [request.method, request.url.pathname])).toEqual([
    ["GET", "/api/v10/users/@me"], ["GET", "/api/v10/channels/123456789012345678"],
  ]);
  expect(logs.join("\n")).not.toContain("DISCORD-SECRET");
});

test("Telegram group setup refuses remote control unless authorized actors are explicit", async () => {
  const fake = apiFake(request => telegramReply(request, "supergroup"));
  await runNotifyCommand(["setup", "--token", "group-token", "--chat-id", "-999"], fake);
  expect(process.exitCode).toBe(1);
  expect((await readGlobalConfig()).notifications?.telegram).toBeUndefined();
  expect(errors.join("\n")).toContain("require explicit");
});

test("pairing ignores stale matching challenges and unrelated or spoofed messages before a fresh private owner", async () => {
  let polls = 0;
  const now = 1_800_000_000_000;
  const message = (id: number, text: string, date: number, fromId = id, type = "private") => ({
    message_id: id, chat: { id, type }, from: { id: fromId, is_bot: false }, date, text,
  });
  const fake = apiFake(request => {
    if (!request.url.pathname.endsWith("/getUpdates")) return telegramReply(request);
    polls++;
    expect(polls).toBe(1);
    return { ok: true, result: [
      { update_id: 10, message: message(101, "/start jeo_test-challenge", now / 1000 - 60) },
      { update_id: 11, message: message(102, "/start jeo_old-challenge", now / 1000) },
      { update_id: 12, message: message(103, "/start jeo_test-challenge", now / 1000, 999) },
      { update_id: 13, message: message(104, "/start jeo_test-challenge", now / 1000, 104, "supergroup") },
      { update_id: 14, message: message(999, "/start jeo_test-challenge", now / 1000) },
    ] };
  });
  await runNotifyCommand(["setup", "--token", "pair-token"], { ...fake, prompt: async () => "", pairingChallenge: () => "test-challenge", now: () => now });
  expect(errors).toEqual([]);
  const config = await readGlobalConfig();
  expect(config.notifications?.telegram?.chatId).toBe("999");
  expect(config.notifications?.telegram?.allowedUserIds).toEqual(["999"]);
  expect(await readDaemonLock()).toBeUndefined();
});

test.each([
  { name: "same destination preserves all owners", previousChat: "999", explicitOwners: undefined, expectedOwners: ["999", "777"] },
  { name: "same destination honors explicit replacement owners", previousChat: "999", explicitOwners: "123,456", expectedOwners: ["123", "456"] },
  { name: "changed destination trusts only the fresh pairing owner", previousChat: "888", explicitOwners: undefined, expectedOwners: ["999"] },
  { name: "changed destination honors explicit new owners", previousChat: "888", explicitOwners: "123,456", expectedOwners: ["123", "456"] },
])("interactive Telegram re-pairing: $name", async ({ previousChat, explicitOwners, expectedOwners }) => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, telegram: {
    botToken: "1:OLD-TOKEN", chatId: previousChat, allowedUserIds: ["999", "777"], topicId: 55, perSessionTopics: true,
  } } }));
  const now = 1_800_000_000_000;
  const fake = apiFake(request => {
    if (!request.url.pathname.endsWith("/getUpdates")) return telegramReply(request);
    return { ok: true, result: [{ update_id: 1, message: {
      message_id: 1, chat: { id: 999, type: "private" }, from: { id: 999, is_bot: false },
      date: now / 1000, text: "/start jeo_repair-challenge",
    } }] };
  });
  await runNotifyCommand([
    "setup", "--token", "1:NEW-TOKEN",
    ...(explicitOwners ? ["--allowed-user-ids", explicitOwners] : []),
  ], { ...fake, prompt: async () => "", pairingChallenge: () => "repair-challenge", now: () => now });
  expect(errors).toEqual([]);
  expect((await readGlobalConfig()).notifications?.telegram).toEqual({
    botToken: "1:NEW-TOKEN", chatId: "999", allowedUserIds: expectedOwners,
    ...(previousChat === "999" ? { topicId: 55, perSessionTopics: true } : {}),
  });
  expect(await readDaemonLock()).toBeUndefined();
});

test.each([
  { name: "without explicit owners", explicitOwners: undefined },
  { name: "with explicit owners", explicitOwners: "123,456" },
])("Telegram setup rechecks destination at locked save after a concurrent replacement $name", async ({ explicitOwners }) => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, verbosity: "lean", telegram: {
    botToken: "1:OLD-TOKEN", chatId: "999", allowedUserIds: ["999", "777"], topicId: 55, perSessionTopics: true,
  } } }));
  const fake = apiFake(async request => {
    if (request.url.pathname.endsWith("/getChat")) {
      // The competing setup commits after this command's preflight read but
      // before destination validation returns and its own locked save begins.
      await saveConfigPatch(raw => ({ notifications: { ...raw.notifications, verbosity: "verbose", telegram: {
        botToken: "2:OTHER-TOKEN", chatId: "888", allowedUserIds: ["888"], topicId: 66, perSessionTopics: true,
      } } }));
    }
    return telegramReply(request);
  });
  await runNotifyCommand([
    "setup", "--token", "1:NEW-TOKEN", "--chat-id", "999",
    ...(explicitOwners ? ["--allowed-user-ids", explicitOwners] : []),
  ], fake);
  expect(errors).toEqual([]);
  const config = (await readGlobalConfig()).notifications!;
  expect(config.verbosity).toBe("verbose");
  expect(config.telegram).toEqual({
    botToken: "1:NEW-TOKEN", chatId: "999",
    ...(explicitOwners ? { allowedUserIds: ["123", "456"] } : {}),
  });
});

test("pairing advances past unrelated updates and releases its lock on API failure", async () => {
  let polls = 0;
  const fake = apiFake(request => {
    if (!request.url.pathname.endsWith("/getUpdates")) return telegramReply(request);
    polls++;
    if (polls === 1) return { ok: true, result: [{ update_id: 71, message: { message_id: 1, date: 1, text: "not a challenge", from: { id: 999, is_bot: false }, chat: { id: 999, type: "private" } } }] };
    expect(request.url.searchParams.get("offset")).toBe("72");
    return { ok: false };
  });
  await runNotifyCommand(["setup", "--token", "pair-token"], { ...fake, prompt: async () => "", now: () => 1_800_000_000_000, pairingChallenge: () => "nonce" });
  expect(polls).toBe(2);
  expect(process.exitCode).toBe(1);
  expect((await readGlobalConfig()).notifications?.telegram).toBeUndefined();
  const nextOwner = await acquireDaemonLock();
  expect(nextOwner).toBeDefined();
  await nextOwner?.release();
});

test("pairing never polls while another process owns the notification lock", async () => {
  const owner = await acquireDaemonLock();
  expect(owner).toBeDefined();
  const fake = apiFake(telegramReply);
  try {
    await runNotifyCommand(["setup", "--token", "pair-token"], { ...fake, prompt: async () => "", pairingChallenge: () => "nonce" });
    expect(process.exitCode).toBe(1);
    expect(fake.requests.map(request => request.url.pathname.split("/").at(-1))).toEqual(["getMe"]);
    expect(await acquireDaemonLock()).toBeUndefined();
  } finally { await owner?.release(); }
});

test("unsafe fetch diagnostics never expose Telegram credentials", async () => {
  const fake = apiFake(() => { throw new Error("https://api.telegram.org/bot999:SENSITIVE-TOKEN/getMe failed"); });
  await runNotifyCommand(["setup", "--token", "999:SENSITIVE-TOKEN", "--chat-id", "999"], fake);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).not.toContain("SENSITIVE-TOKEN");
  expect((await readGlobalConfig()).notifications?.telegram).toBeUndefined();
});

test("health is read-only and only the explicit test command sends a notification", async () => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, telegram: { botToken: "test-token", chatId: "999", topicId: 55 } } }));
  const fake = apiFake(request => request.url.pathname.endsWith("/sendMessage") ? { ok: true } : telegramReply(request));
  await runNotifyCommand(["health", "--provider", "telegram"], fake);
  expect(errors).toEqual([]);
  expect(fake.requests.some(request => request.url.pathname.endsWith("/sendMessage"))).toBe(false);
  await runNotifyCommand(["test", "--provider", "telegram"], fake);
  const sent = fake.requests.filter(request => request.url.pathname.endsWith("/sendMessage"));
  expect(sent.map(request => request.body)).toEqual([expect.objectContaining({ chat_id: "999", text: "jeo notification test", message_thread_id: 55 })]);
});

test("malformed inline token flags never echo credential bytes in diagnostics", async () => {
  const fake = apiFake(() => { throw new Error("Parsing must reject before API access"); });
  await runNotifyCommand(["setup", "--token=SECRET-IN-ARGUMENT", "--chat-id", "999"], fake);
  expect(process.exitCode).toBe(1);
  expect(fake.requests).toEqual([]);
  expect([...logs, ...errors].join("\n")).not.toContain("SECRET-IN-ARGUMENT");
  expect((await readGlobalConfig()).notifications?.telegram).toBeUndefined();
});

const slackConfig = { botToken: "xoxb-BOT-SECRET", appToken: "xapp-APP-SECRET", channelId: "CTARGET", allowedUserIds: ["UOWNER"] };

function slackReply(request: RequestRecord) {
  switch (request.url.pathname.split("/").at(-1)) {
    case "auth.test": return { ok: true, user_id: "UJEOBOT", bot_id: "BJEOBOT", team_id: "TWORK" };
    case "bots.info": return { ok: true, bot: { id: "BJEOBOT", user_id: "UJEOBOT", app_id: "AAPP" } };
    case "conversations.info": return { ok: true, channel: { id: "CTARGET", is_member: true, is_archived: false } };
    case "apps.connections.open": return { ok: true, url: "wss://wss-primary.slack.com/link/?ticket=fake" };
    case "chat.postMessage": return { ok: true, channel: "CTARGET", ts: "123.456789" };
    default: throw new Error(`Unexpected Slack API operation ${request.url.pathname}`);
  }
}

async function withSlackEnvironment(values: { bot?: string; app?: string }, run: () => Promise<void>) {
  const keys = ["JEO_TEST_SLACK_BOT", "JEO_TEST_SLACK_APP"] as const;
  const previous = keys.map(key => process.env[key]);
  try {
    for (const [index, value] of [values.bot, values.app].entries()) {
      if (value === undefined) delete process.env[keys[index]!];
      else process.env[keys[index]!] = value;
    }
    await run();
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
}

const slackSetup = ["setup", "--provider", "slack", "--token-env", "JEO_TEST_SLACK_BOT", "--app-token-env", "JEO_TEST_SLACK_APP", "--channel-id", "CTARGET", "--allowed-user-ids", "UOWNER"];

test("Slack environment-token onboarding preflights both credentials and preserves unrelated providers without sending", async () => {
  await saveConfigPatch(() => ({ notifications: { enabled: false, verbosity: "verbose", redact: true,
    telegram: { botToken: "telegram-secret", chatId: "999", topicId: 55 },
    discord: { botToken: "discord-secret", channelId: "123456789012345678", allowedUserIds: ["234567890123456789"] },
  } }));
  const previous = (await readGlobalConfig()).notifications!;
  const fake = apiFake(slackReply);
  await withSlackEnvironment({ bot: slackConfig.botToken, app: slackConfig.appToken }, () => runNotifyCommand(slackSetup, fake));
  expect(errors).toEqual([]);
  expect(process.exitCode).toBe(0);
  expect((await readGlobalConfig()).notifications).toEqual({ ...previous, enabled: true, slack: slackConfig });
  expect(await isNotifyConfigured()).toBe(true);
  expect(fake.requests.map(request => request.url.pathname.split("/").at(-1)).sort()).toEqual(["apps.connections.open", "auth.test", "bots.info", "conversations.info"]);
  expect([...logs, ...errors].join("\n")).not.toContain(slackConfig.botToken);
  expect([...logs, ...errors].join("\n")).not.toContain(slackConfig.appToken);
});

test.each([
  { name: "missing bot environment value", bot: undefined, app: "xapp-valid" },
  { name: "missing app environment value", bot: "xoxb-valid", app: undefined },
  { name: "user token instead of bot token", bot: "xoxp-user", app: "xapp-valid" },
  { name: "bot token instead of app token", bot: "xoxb-valid", app: "xoxb-not-an-app" },
])("Slack setup rejects $name before network or persistence", async ({ bot, app }) => {
  const fake = apiFake(slackReply);
  await withSlackEnvironment({ bot, app }, () => runNotifyCommand(slackSetup, { ...fake, prompt: async () => { throw new Error("Noninteractive setup must not prompt"); } }));
  expect(process.exitCode).toBe(1);
  expect(fake.requests).toEqual([]);
  expect((await readGlobalConfig()).notifications?.slack).toBeUndefined();
});

test.each([
  { name: "missing channel", routing: ["--allowed-user-ids", "UOWNER"] },
  { name: "invalid channel", routing: ["--channel-id", "#general", "--allowed-user-ids", "UOWNER"] },
  { name: "missing human allowlist", routing: ["--channel-id", "CTARGET"] },
  { name: "bot ID in human allowlist", routing: ["--channel-id", "CTARGET", "--allowed-user-ids", "BOTHERBOT"] },
  { name: "mixed invalid human allowlist", routing: ["--channel-id", "CTARGET", "--allowed-user-ids", "UOWNER,not-a-user"] },
])("Slack setup rejects $name without enabling remote access", async ({ routing }) => {
  const fake = apiFake(slackReply);
  await withSlackEnvironment({ bot: slackConfig.botToken, app: slackConfig.appToken }, () => runNotifyCommand([...slackSetup.slice(0, 7), ...routing], { ...fake, prompt: async () => { throw new Error("Noninteractive setup must not prompt"); } }));
  expect(process.exitCode).toBe(1);
  expect((await readGlobalConfig()).notifications?.slack).toBeUndefined();
  expect(fake.requests.some(request => request.url.pathname.endsWith("chat.postMessage"))).toBe(false);
});

test.each(["auth.test", "bots.info", "conversations.info", "apps.connections.open"])("Slack failed %s preflight preserves the working configuration and conceals both credentials", async method => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, slack: slackConfig, telegram: { botToken: "old-telegram", chatId: "999" } } }));
  const before = (await readGlobalConfig()).notifications;
  const fake = apiFake(request => request.url.pathname.endsWith(method)
    ? { ok: false, error: "invalid_auth", detail: "xoxb-REPLACEMENT xapp-REPLACEMENT" }
    : slackReply(request));
  await withSlackEnvironment({ bot: "xoxb-REPLACEMENT", app: "xapp-REPLACEMENT" }, () => runNotifyCommand(slackSetup, fake));
  expect(process.exitCode).toBe(1);
  expect(fake.requests.some(request => request.url.pathname.endsWith(method))).toBe(true);
  expect((await readGlobalConfig()).notifications).toEqual(before);
  expect([...logs, ...errors].join("\n")).not.toContain("REPLACEMENT");
});

test("Slack status masks both tokens and distinguishes initialized process from transport connectivity", async () => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, slack: slackConfig } }));
  const lock = await acquireDaemonLock();
  expect(lock).toBeDefined();
  try {
    await lock!.markReady();
    const fake = apiFake(slackReply);
    await runNotifyCommand(["status", "--provider", "slack"], fake);
    const text = logs.join("\n");
    expect(errors).toEqual([]);
    expect(text).toContain("provider=slack");
    expect(text).toContain("channelId=CTARGET");
    expect(text).toContain("botToken=(set)");
    expect(text).toContain("appToken=(set)");
    expect(text).toContain("initialized");
    expect(text).toContain("transport connectivity not checked");
    expect(text).not.toContain(slackConfig.botToken);
    expect(text).not.toContain(slackConfig.appToken);
    expect(fake.requests).toEqual([]);
  } finally { await lock?.release(); }
});

test("Slack health sends nothing and only explicit test posts the notification to the authorized channel", async () => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, slack: slackConfig } }));
  const fake = apiFake(slackReply);
  await runNotifyCommand(["health", "--provider", "slack"], fake);
  expect(errors).toEqual([]);
  expect(fake.requests.map(request => request.url.pathname.split("/").at(-1)).sort()).toEqual(["apps.connections.open", "auth.test", "bots.info", "conversations.info"]);
  expect(logs.join("\n")).toContain("not tested");
  await runNotifyCommand(["test", "--provider", "slack"], fake);
  expect(errors).toEqual([]);
  expect(fake.requests.filter(request => request.url.pathname.endsWith("chat.postMessage")).map(request => request.body)).toEqual([
    expect.objectContaining({ channel: "CTARGET", text: "jeo notification test" }),
  ]);
});

const discordConfig = { botToken: "discord-secret", channelId: "123456789012345678", allowedUserIds: ["234567890123456789"] };

function discordReply(request: RequestRecord) {
  if (request.url.pathname.endsWith("/users/@me")) return { id: "345678901234567890", bot: true, username: "jeo" };
  if (request.url.pathname.endsWith("/messages")) return { id: "456789012345678901", channel_id: discordConfig.channelId };
  if (request.url.pathname.endsWith(`/channels/${discordConfig.channelId}`)) return { id: discordConfig.channelId, type: 0 };
  throw new Error(`Unexpected Discord API operation ${request.url.pathname}`);
}

test("Discord health is read-only and explicit test sends only to its configured channel", async () => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, discord: discordConfig } }));
  const fake = apiFake(discordReply);
  await runNotifyCommand(["health", "--provider", "discord"], fake);
  expect(errors).toEqual([]);
  expect(fake.requests.some(request => request.method !== "GET")).toBe(false);
  expect(logs.join("\n")).toContain("not tested");
  await runNotifyCommand(["test", "--provider", "discord"], fake);
  expect(errors).toEqual([]);
  const posts = fake.requests.filter(request => request.method === "POST");
  expect(posts.map(request => [request.url.pathname, request.body])).toEqual([
    [`/api/v10/channels/${discordConfig.channelId}/messages`, expect.objectContaining({ content: "jeo notification test" })],
  ]);
});

test.each([
  { provider: "discord", name: "same credentials and channel", changed: {} },
  { provider: "discord", name: "changed bot credentials", changed: { botToken: "old-discord-secret" } },
  { provider: "discord", name: "changed channel", changed: { channelId: "999999999999999999" } },
  { provider: "slack", name: "same credentials and channel", changed: {} },
  { provider: "slack", name: "changed bot credentials", changed: { botToken: "xoxb-old" } },
  { provider: "slack", name: "changed app credentials", changed: { appToken: "xapp-old" } },
  { provider: "slack", name: "changed channel", changed: { channelId: "COLD" } },
])("$provider re-setup only inherits owners for $name", async ({ provider, changed }) => {
  const config = provider === "slack" ? slackConfig : discordConfig;
  await saveConfigPatch(() => ({ notifications: { enabled: true, [provider]: { ...config, ...changed } } }));
  const before = (await readGlobalConfig()).notifications;
  const fake = apiFake(provider === "slack" ? slackReply : discordReply);
  const args = provider === "slack" ? slackSetup.slice(0, 9)
    : ["setup", "--provider", "discord", "--token", discordConfig.botToken, "--channel-id", discordConfig.channelId];
  await withSlackEnvironment({ bot: slackConfig.botToken, app: slackConfig.appToken }, () => runNotifyCommand(args, fake));
  expect((await readGlobalConfig()).notifications).toEqual(before);
  expect(process.exitCode).toBe(Object.keys(changed).length ? 1 : 0);
  if (!Object.keys(changed).length) expect(errors).toEqual([]);
});

test.each([
  { provider: "discord", explicit: false },
  { provider: "discord", explicit: true },
  { provider: "slack", explicit: false },
  { provider: "slack", explicit: true },
])("$provider locked setup cannot inherit concurrent foreign owners (explicit=$explicit)", async ({ provider, explicit }) => {
  const config = provider === "slack" ? slackConfig : discordConfig;
  const foreignOwner = provider === "slack" ? "UFOREIGN" : "888888888888888888";
  const foreign = { ...config, channelId: provider === "slack" ? "CFOREIGN" : "999999999999999999", allowedUserIds: [foreignOwner] };
  await saveConfigPatch(() => ({ notifications: { enabled: true, [provider]: config } }));
  let replaced = false;
  const fake = apiFake(async request => {
    const response = (provider === "slack" ? slackReply : discordReply)(request);
    if (!replaced) {
      replaced = true;
      await saveConfigPatch(current => ({ ...current, notifications: { ...current.notifications, [provider]: foreign } }));
    }
    return response;
  });
  const args = provider === "slack" ? slackSetup.slice(0, 9)
    : ["setup", "--provider", "discord", "--token", discordConfig.botToken, "--channel-id", discordConfig.channelId];
  if (explicit) args.push("--allowed-user-ids", config.allowedUserIds.join(","));
  await withSlackEnvironment({ bot: slackConfig.botToken, app: slackConfig.appToken }, () => runNotifyCommand(args, fake));
  expect(replaced).toBe(true);
  expect(process.exitCode).toBe(explicit ? 0 : 1);
  const notifications = (await readGlobalConfig()).notifications;
  expect(provider === "slack" ? notifications?.slack : notifications?.discord).toEqual(explicit ? config : foreign);
});

test.each([
  { name: "a different channel", channel: { id: "COTHER", is_member: true } },
  { name: "a foreign workspace", channel: { id: "CTARGET", is_member: true, context_team_id: "TFOREIGN" } },
  { name: "a channel the bot has not joined", channel: { id: "CTARGET", is_member: false } },
  { name: "an archived channel", channel: { id: "CTARGET", is_member: true, is_archived: true } },
])("Slack setup rejects $name without replacing working authority", async ({ channel }) => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, slack: slackConfig } }));
  const before = (await readGlobalConfig()).notifications;
  const fake = apiFake(request => request.url.pathname.endsWith("conversations.info") ? { ok: true, channel } : slackReply(request));
  await withSlackEnvironment({ bot: "xoxb-replacement", app: "xapp-replacement" }, () => runNotifyCommand(slackSetup, fake));
  expect(process.exitCode).toBe(1);
  expect((await readGlobalConfig()).notifications).toEqual(before);
  expect(fake.requests.some(request => request.url.pathname.endsWith("conversations.info"))).toBe(true);
});

test.each(["slack", "discord"])("%s unchanged destination preserves the latest locked owner update", async provider => {
  const config = provider === "slack" ? slackConfig : discordConfig;
  const updated = { ...config, allowedUserIds: [provider === "slack" ? "UNEWOWNER" : "777777777777777777"] };
  await saveConfigPatch(() => ({ notifications: { enabled: true, [provider]: config } }));
  let replaced = false;
  const fake = apiFake(async request => {
    const response = (provider === "slack" ? slackReply : discordReply)(request);
    if (!replaced) {
      replaced = true;
      await saveConfigPatch(current => ({ ...current, notifications: { ...current.notifications, [provider]: updated } }));
    }
    return response;
  });
  const args = provider === "slack" ? slackSetup.slice(0, 9)
    : ["setup", "--provider", "discord", "--token", discordConfig.botToken, "--channel-id", discordConfig.channelId];
  await withSlackEnvironment({ bot: slackConfig.botToken, app: slackConfig.appToken }, () => runNotifyCommand(args, fake));
  expect(errors).toEqual([]);
  expect(process.exitCode).toBe(0);
  const notifications = (await readGlobalConfig()).notifications;
  expect(provider === "slack" ? notifications?.slack : notifications?.discord).toEqual(updated);
});
