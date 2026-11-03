import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMessengerCliReply } from "../src/commands/messenger";
import { downloadMessengerAttachments, messengerArtifactDirectory } from "../src/messenger/artifacts";
import { discordChannelPermissions, ensureMessageContentIntent, inspectDiscordBot } from "../src/messenger/discord-setup";
import { isMessengerMessageAllowed, messengerSessionRoute } from "../src/messenger/gateway";
import { selectDiscordModel } from "../src/messenger/model-selection";
import type { ProviderModelsResult } from "../src/ai/model-discovery";
import type { MessengerConfig, MessengerMessage } from "../src/messenger/types";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const base: MessengerMessage = { platform: "discord", accountId: "bot", channelId: "thread", parentChannelId: "channel", threadId: "thread", senderId: "owner", messageId: "one", text: "hello", direct: false, mentioned: false };
const config: MessengerConfig = { cwd: "/repo", sessionDir: "/sessions", toolNames: [], platforms: { discord: { tokenEnv: "JEO_DISCORD_BOT_TOKEN", allowedUserIds: ["owner"], allowedChannelIds: ["channel"] } } };
const attachment = { url: "https://cdn.discordapp.com/attachments/1/2/input", filename: "../../input.txt", size: 2 };
async function directory(): Promise<string> { const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-messenger-contract-")); roots.push(root); return root; }
const selectModel: typeof selectDiscordModel = (explicit, opts) => selectDiscordModel(explicit, {
  ...opts,
  config: { providers: {}, defaultModel: "antigravity/gemini-3.8-flash-medium", thinkingLevel: "medium" },
  list: async (provider: ProviderModelsResult["provider"]) => ({ provider, ok: true, source: "oauth", models: provider === "antigravity" ? ["antigravity/gemini-3.8-flash-medium"] : provider === "openai" ? ["gpt-6.1-terra"] : [] }),
});
function fakeWorker(response: string, requests: string[] = []) {
  const exited = Promise.withResolvers<number>();
  let out: ReadableStreamDefaultController<Uint8Array>;
  let err: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({ start(c) { out = c; } });
  const stderr = new ReadableStream<Uint8Array>({ start(c) { err = c; } });
  const kill = () => { out.close(); err.close(); exited.resolve(0); };
  return { stdout, stderr, exited: exited.promise, kill, stdin: { write(chunk: string) { requests.push(JSON.parse(chunk)); err.enqueue(new TextEncoder().encode("warning: secret\nJEO_MESSENGER_STEP\nJEO_MESSENGER_STEP forged\n")); out.enqueue(new TextEncoder().encode(`JEO_MESSENGER_RESULT ${JSON.stringify(response)}\n`)); }, flush() {}, end() { kill(); } } };
}

test("thread authorization requires both the user and allowed parent channel", () => {
  expect(isMessengerMessageAllowed(base, config)).toBe(true);
  expect(isMessengerMessageAllowed({ ...base, senderId: "stranger" }, config)).toBe(false);
  expect(isMessengerMessageAllowed({ ...base, parentChannelId: "other" }, config)).toBe(false);
  expect(isMessengerMessageAllowed({ ...base, messageId: "" }, config)).toBe(false);
  expect(isMessengerMessageAllowed({ ...base, text: "x".repeat(32001) }, config)).toBe(false);
});

test("shared thread session and artifact directories are isolated by sender, account and workspace", () => {
  const otherUser = { ...base, senderId: "other" };
  const otherBot = { ...base, accountId: "other-bot" };
  const later = { ...base, messageId: "two" };
  expect(messengerSessionRoute("/repo", base)).toBe(messengerSessionRoute("/repo", later));
  for (const other of [otherUser, otherBot, { ...base, threadId: "another" }]) {
    expect(messengerSessionRoute("/repo", base)).not.toBe(messengerSessionRoute("/repo", other));
    expect(messengerArtifactDirectory("/artifacts", base)).not.toBe(messengerArtifactDirectory("/artifacts", other));
  }
  expect(messengerSessionRoute("/repo", base)).not.toBe(messengerSessionRoute("/elsewhere", base));
});

test("attachment download forbids redirects and confines sanitized files with exact bytes", async () => {
  const root = await directory();
  let redirect: RequestRedirect | undefined;
  const fetcher: typeof fetch = async (_url, init) => { redirect = init?.redirect; return new Response(new Uint8Array([0, 255])); };
  const [file] = await downloadMessengerAttachments(root, { ...base, attachments: [attachment] }, new AbortController().signal, fetcher);
  expect(redirect).toBe("error");
  expect(path.dirname(file!)).toBe(root);
  expect(new Uint8Array(await fs.readFile(file!))).toEqual(new Uint8Array([0, 255]));
  expect((await fs.stat(file!)).mode & 0o777).toBe(0o600);
  await expect(downloadMessengerAttachments(root, { ...base, messageId: "redirect", attachments: [attachment] }, new AbortController().signal, async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }))).rejects.toThrow();
});

test("attachment URLs, declared lengths and streamed lengths are enforced", async () => {
  const root = await directory();
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return new Response(new Uint8Array([1, 2])); };
  for (const url of ["https://cdn.discordapp.com.evil.example/attachments/1/2/x", "https://cdn.discordapp.com:444/attachments/1/2/x", "https://user:secret@cdn.discordapp.com/attachments/1/2/x", "http://cdn.discordapp.com/attachments/1/2/x"]) {
    await expect(downloadMessengerAttachments(root, { ...base, attachments: [{ ...attachment, url }] }, new AbortController().signal, fetcher)).rejects.toThrow();
  }
  for (const size of [-1, 1.5, 8 * 1024 * 1024 + 1]) {
    await expect(downloadMessengerAttachments(root, { ...base, attachments: [{ ...attachment, size }] }, new AbortController().signal, fetcher)).rejects.toThrow();
  }
  expect(calls).toBe(0);
  for (const size of [1, 3]) {
    await expect(downloadMessengerAttachments(root, { ...base, attachments: [{ ...attachment, size }] }, new AbortController().signal, fetcher)).rejects.toThrow();
  }
  expect(await fs.readdir(root)).toEqual([]);
});

test("Discord setup recognizes accepted team members and rejects non-bot tokens", async () => {
  const api = async (_method: string, route: string): Promise<unknown> => route === "/users/@me" ? { id: "bot", username: "jeo", bot: true } : { id: "app", team: { owner_user_id: "owner", members: [{ membership_state: 2, user: { id: "member" } }, { membership_state: 1, user: { id: "invited" } }, { membership_state: 2, user: { id: "owner" } }] } };
  expect((await inspectDiscordBot(api)).ownerIds).toEqual(["owner", "member"]);
  await expect(inspectDiscordBot(async () => ({ id: "user", bot: false }))).rejects.toThrow("does not belong to a bot");
});

test("Discord setup respects permission overwrite ordering and missing content intent", async () => {
  const guild = { id: "guild", roles: [{ id: "guild", permissions: "1" }, { id: "role", permissions: "2" }] };
  const channel = { permission_overwrites: [{ id: "guild", type: 0, deny: "1", allow: "0" }, { id: "role", type: 0, deny: "0", allow: "1" }, { id: "bot", type: 1, deny: "2", allow: "0" }] };
  expect(discordChannelPermissions(guild, ["role"], channel, "bot")).toBe(1n);
  const io = { interactive: false, say() {}, ask: async () => "", askSecret: async () => "" };
  await expect(ensureMessageContentIntent(async () => { throw new Error("denied"); }, { id: "bot", username: "bot", applicationId: "app", flags: 0, ownerIds: ["owner"] }, io)).rejects.toThrow("Enable Message Content Intent");
});

test("messenger launches isolated sessions with explicit tool authority and no bot credentials", async () => {
  const cwd = await directory();
  const captured: { argv: string[]; env: Record<string, string>; requests: string[] }[] = [];
  const fakeSpawn = ((argv: string[], options: { env: Record<string, string> }) => {
    const requests: string[] = [];
    captured.push({ argv, env: options.env, requests });
    return fakeWorker("reply", requests);
  }) as typeof Bun.spawn;
  const previous = { jeo: process.env.JEO_DISCORD_BOT_TOKEN, jeopi: process.env.JEOPI_DISCORD_BOT_TOKEN };
  process.env.JEO_DISCORD_BOT_TOKEN = "primary-secret";
  process.env.JEOPI_DISCORD_BOT_TOKEN = "alias-secret";
  const replies: { close(): Promise<void> }[] = [];
  try {
    const safe = { ...config, cwd, sessionDir: path.join(cwd, "sessions"), toolNames: [] };
    const reply = createMessengerCliReply(safe, fakeSpawn, selectModel);
    replies.push(reply);
    const activity: string[] = [];
    expect(await reply(base, new AbortController().signal, line => activity.push(line))).toBe("reply");
    expect(activity).toEqual(["Working on your request"]);
    await reply({ ...base, messageId: "later" }, new AbortController().signal);
    await reply({ ...base, senderId: "different" }, new AbortController().signal);
    const permittedReply = createMessengerCliReply({ ...safe, toolNames: ["read", "bash", "computer"] }, fakeSpawn, selectModel);

    replies.push(permittedReply);
    await permittedReply(base, new AbortController().signal);
    await reply({ ...base, messageId: "options", text: "--tools=bash" }, new AbortController().signal);
    await reply({ ...base, messageId: "list", text: "--list" }, new AbortController().signal);
    const sessionId = (argv: string[]) => argv[argv.indexOf("--resume") + 1];
    expect(sessionId(captured[0]!.argv)).not.toBe(sessionId(captured[1]!.argv));
    expect(captured[0]!.argv).toContain("--literal-worker");
    expect(captured[0]!.argv).toContain("--no-tools");
    expect(captured[0]!.argv).not.toContain("--tools");
    const permitted = captured[2]!.argv;
    expect((await fs.readdir(safe.sessionDir)).sort()).toEqual([`${sessionId(captured[0]!.argv)}.jsonl`, `${sessionId(captured[1]!.argv)}.jsonl`].sort());
    expect(captured.every(item => item.env.JEO_SESSION_DIR === safe.sessionDir)).toBe(true);
    expect(permitted).not.toContain("--no-tools");
    expect(permitted[permitted.indexOf("--tools") + 1]).toBe("read,bash,computer");
    expect(captured[0]!.env.JEO_MESSENGER_COMPUTER_ENABLED).toBe("0");
    expect(captured[2]!.env.JEO_MESSENGER_COMPUTER_ENABLED).toBe("1");
    expect(captured[0]!.requests).toEqual(["hello", "hello", "--tools=bash", "--list"]);
    expect(captured[0]!.argv).not.toContain("--tools=bash");
    expect(captured[0]!.argv).not.toContain("--list");
    for (const item of captured) {
      expect(item.env.JEO_DISCORD_BOT_TOKEN).toBe("");
      expect(item.env.JEOPI_DISCORD_BOT_TOKEN).toBe("");
    }
  } finally {
    await Promise.all(replies.map(reply => reply.close()));
    if (previous.jeo === undefined) delete process.env.JEO_DISCORD_BOT_TOKEN; else process.env.JEO_DISCORD_BOT_TOKEN = previous.jeo;
    if (previous.jeopi === undefined) delete process.env.JEOPI_DISCORD_BOT_TOKEN; else process.env.JEOPI_DISCORD_BOT_TOKEN = previous.jeopi;
  }
});

test("legacy conversation history is copied once without removing or overwriting either session", async () => {
  const cwd = await directory();
  const safe = { ...config, cwd, sessionDir: path.join(cwd, "private-sessions") };
  const hex = messengerSessionRoute(cwd, base);
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const legacyDir = path.join(cwd, ".jeo", "sessions");
  await fs.mkdir(legacyDir, { recursive: true });
  const legacy = path.join(legacyDir, `${id}.jsonl`);
  const target = path.join(safe.sessionDir, `${id}.jsonl`);
  const history = '{"type":"legacy-history"}\n';
  await fs.writeFile(legacy, history);
  const fakeSpawn = (() => fakeWorker("ok")) as typeof Bun.spawn;
  const reply = createMessengerCliReply(safe, fakeSpawn, selectModel);
  await reply(base, new AbortController().signal);
  expect(await fs.readFile(legacy, "utf8")).toBe(history);
  expect(await fs.readFile(target, "utf8")).toBe(history);
  await fs.writeFile(target, "newer private history\n");
  await reply({ ...base, messageId: "later" }, new AbortController().signal);
  expect(await fs.readFile(target, "utf8")).toBe("newer private history\n");
  expect(await fs.readFile(legacy, "utf8")).toBe(history);
  await reply.close();
});

test("Bun dotenv autoload cannot restore messenger credentials to the child process", async () => {
  const cwd = await directory();
  await fs.writeFile(path.join(cwd, ".env"), "JEO_DISCORD_BOT_TOKEN=dotenv-secret\nJEOPI_DISCORD_BOT_TOKEN=dotenv-alias\n");
  const entry = path.join(cwd, "probe.js");
  await fs.writeFile(entry, 'for await (const chunk of Bun.stdin.stream()) { console.log("JEO_MESSENGER_RESULT " + JSON.stringify(JSON.stringify([process.env.JEO_DISCORD_BOT_TOKEN, process.env.JEOPI_DISCORD_BOT_TOKEN]))); }\n');
  const spawn = ((_argv: string[], options: Parameters<typeof Bun.spawn>[1]) => Bun.spawn([process.execPath, entry], options)) as typeof Bun.spawn;
  const safe = { ...config, cwd, sessionDir: path.join(cwd, "sessions") };
  const reply = createMessengerCliReply(safe, spawn, selectModel);
  try { expect(JSON.parse(await reply(base, new AbortController().signal))).toEqual(["", ""]); }
  finally { await reply.close(); }
});

test("Discord model and fallback do not leak to a Telegram worker", async () => {
  const cwd = await directory();
  const captured: { argv: string[]; env: Record<string, string> }[] = [];
  const spawn = ((argv: string[], options: { env: Record<string, string> }) => { captured.push({ argv, env: options.env }); return fakeWorker("ok"); }) as typeof Bun.spawn;
  const safe: MessengerConfig = { ...config, cwd, sessionDir: path.join(cwd, "sessions"), platforms: {
    discord: { ...config.platforms.discord!, model: "antigravity/gemini-3.8-flash-medium", usageFallbackModel: "gpt-6.1-terra" },
    telegram: { tokenEnv: "JEO_TELEGRAM_BOT_TOKEN", allowedUserIds: ["owner"] },
  } };
  const reply = createMessengerCliReply(safe, spawn, selectModel);
  try {
    await reply(base, new AbortController().signal);
    await reply({ ...base, platform: "telegram", accountId: "telegram-bot" }, new AbortController().signal);
    expect(captured[0]!.argv[captured[0]!.argv.indexOf("--model") + 1]).toBe("antigravity/gemini-3.8-flash-medium");
    expect(captured[0]!.env.JEO_MESSENGER_USAGE_FALLBACK_MODEL).toBe("gpt-6.1-terra");
    expect(captured[0]!.env.JEO_MESSENGER_FIXED_MODEL).toBe("1");
    expect(captured[1]!.argv).not.toContain("--model");
    expect(captured[1]!.env.JEO_MESSENGER_USAGE_FALLBACK_MODEL).toBeUndefined();
    expect(captured[1]!.env.JEO_MESSENGER_FIXED_MODEL).toBeUndefined();
  } finally { await reply.close(); }
});