import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMessengerCliReply } from "../src/commands/messenger";
import { downloadMessengerAttachments, messengerArtifactDirectory } from "../src/messenger/artifacts";
import { loadMessengerConfig } from "../src/messenger/config";
import { discordChannelPermissions, ensureMessageContentIntent, inspectDiscordBot, setupDiscordMessenger } from "../src/messenger/discord-setup";
import { isMessengerMessageAllowed, messengerSessionRoute } from "../src/messenger/gateway";
import { selectDiscordModel } from "../src/messenger/model-selection";
import type { ProviderModelsResult } from "../src/ai/model-discovery";
import type { MessengerConfig, MessengerMessage } from "../src/messenger/types";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const base: MessengerMessage = { platform: "discord", accountId: "bot", channelId: "thread", parentChannelId: "channel", threadId: "thread", senderId: "owner", messageId: "one", text: "hello", direct: false, mentioned: false };
const config: MessengerConfig = { cwd: "/repo", sessionDir: "/sessions", sandbox: { image: "local-test-image", limits: { memoryBytes: 268435456, pids: 32, cpus: 1 } }, toolNames: [], platforms: { discord: { tokenEnv: "JEO_DISCORD_BOT_TOKEN", allowedUserIds: ["owner"], allowedChannelIds: ["channel"] } } };
const attachment = { url: "https://cdn.discordapp.com/attachments/1/2/input", filename: "../../input.txt", size: 2 };
async function directory(): Promise<string> { const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-messenger-contract-")); roots.push(root); return root; }
const selectModel: typeof selectDiscordModel = (explicit, opts) => selectDiscordModel(explicit, {
  ...opts,
  config: { providers: {}, defaultModel: "antigravity/gemini-3.8-flash-medium", thinkingLevel: "medium" },
  list: async (provider: ProviderModelsResult["provider"]) => ({ provider, ok: true, source: "oauth", models: provider === "antigravity" ? ["antigravity/gemini-3.8-flash-medium"] : provider === "openai" ? ["gpt-6.1-terra"] : [] }),
});
type SpawnOptions = { env: Record<string, string> };
function fakeWorker(response: string | ((history: readonly string[]) => string), requests: string[] = [], options?: SpawnOptions) {
  const exited = Promise.withResolvers<number>();
  let out: ReadableStreamDefaultController<Uint8Array>;
  let err: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({ start(c) { out = c; } });
  const stderr = new ReadableStream<Uint8Array>({ start(c) { err = c; } });
  const nonce = options?.env.JEO_MESSENGER_SHUTDOWN_NONCE;
  if (!nonce) throw new Error("parent did not supply a shutdown nonce");
  let stopped = false;
  // Graceful shutdown only via the exact private IPC frame with the parent's nonce: ACK on stderr, then exit 143.
  const send = (frame: unknown) => {
    const f = frame as { type?: unknown; nonce?: unknown } | null;
    if (!f || Object.keys(f).sort().join() !== "nonce,type" || f.type !== "jeo_messenger_shutdown" || f.nonce !== nonce) return true;
    if (stopped) return true;
    stopped = true;
    err.enqueue(new TextEncoder().encode(`JEO_MESSENGER_SHUTDOWN_ACK ${JSON.stringify({ nonce, gone: true })}\n`));
    out.close(); err.close(); exited.resolve(143);
    return true;
  };
  // A signal is an actual crash: no acknowledgement.
  const kill = () => {
    if (stopped) return;
    stopped = true;
    out.close(); err.close(); exited.resolve(143);
  };
  return { stdout, stderr, exited: exited.promise, kill, send, stdin: { write(chunk: string) { requests.push(JSON.parse(chunk)); err.enqueue(new TextEncoder().encode("warning: secret\nJEO_MESSENGER_STEP\nJEO_MESSENGER_STEP forged\n")); out.enqueue(new TextEncoder().encode(`JEO_MESSENGER_RESULT ${JSON.stringify(typeof response === "string" ? response : response(requests))}\n`)); }, flush() {}, end() {} } };
}


for (const independentSessions of [true, false]) test(`Discord setup migrates obsolete independentSessions=${independentSessions} while preserving operator settings`, async () => {
  const root = await directory();
  const configPath = path.join(root, "profile", "messenger.json");
  await fs.mkdir(path.dirname(configPath));
  const expected = {
    cwd: "../shared-workspace", sessionDir: "./private-history", toolNames: ["read", "write"],
    sandbox: config.sandbox,
    platforms: {
      discord: { tokenEnv: "JEO_DISCORD_BOT_TOKEN", allowedUserIds: ["owner", "collaborator"], allowedChannelIds: ["channel"], model: "openai/gpt-6.1-terra", artifactDir: "./artifacts" },
      telegram: { tokenEnv: "MY_TELEGRAM_TOKEN", allowedUserIds: ["telegram-owner"], allowedChannelIds: ["telegram-room"] },
    },
  };
  await fs.writeFile(configPath, JSON.stringify({ ...expected, independentSessions }));
  const responses: Record<string, unknown> = {
    "/users/@me": { id: "bot", username: "test-bot", bot: true },
    "/applications/@me": { id: "application", owner: { id: "owner" }, flags: 1 << 18 },
    "/users/@me/guilds": [{ id: "guild" }],
    "/gateway/bot": { url: "wss://gateway.discord.gg" },
  };
  const fetchImpl = (async (input: string | URL | Request) => {
    const route = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname.replace("/api/v10", "");
    if (!Object.hasOwn(responses, route)) throw new Error(`Unexpected setup request: ${route}`);
    return Response.json(responses[route]);
  }) as typeof fetch;
  class ReadySocket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ op: 0, t: "READY" }) })));
    }
    close() {}
  }
  await setupDiscordMessenger({ configPath, dmTest: false }, {
    interactive: false, say() {}, ask: async () => { throw new Error("Unexpected prompt"); }, askSecret: async () => { throw new Error("Unexpected credential prompt"); },
  }, { env: { JEO_DISCORD_BOT_TOKEN: "test-token" }, fetch: fetchImpl, WebSocket: ReadySocket as unknown as typeof WebSocket, jeoCommand: ["/opt/jeo"], profilesPath: path.join(root, "messenger-profiles.json") });
  const written = await Bun.file(configPath).json();
  expect(written).toEqual(expected);
  const migrated = await loadMessengerConfig(configPath);
  expect(migrated.cwd).toBe(path.join(root, "shared-workspace"));
  expect(migrated.sessionDir).toBe(path.join(root, "profile", "private-history"));
  expect(migrated.platforms.discord?.allowedUserIds).toEqual(["owner", "collaborator"]);
  expect(migrated.platforms.telegram?.allowedChannelIds).toEqual(["telegram-room"]);
});

test("invalid Discord setup tools leave the existing config unchanged", async () => {
  const root = await directory();
  const configPath = path.join(root, "messenger.json");
  const original = JSON.stringify({ cwd: "./workspace", sessionDir: "./sessions", sandbox: config.sandbox, toolNames: ["read"], platforms: { discord: { tokenEnv: "JEO_DISCORD_BOT_TOKEN", allowedUserIds: ["owner"], allowedChannelIds: ["channel"] } } }, null, 2);
  await fs.writeFile(configPath, original);
  const responses: Record<string, unknown> = {
    "/users/@me": { id: "bot", username: "test-bot", bot: true },
    "/applications/@me": { id: "application", owner: { id: "owner" }, flags: 1 << 18 },
    "/users/@me/guilds": [{ id: "guild" }],
  };
  const fetchImpl = (async (input: string | URL | Request) => {
    const route = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname.replace("/api/v10", "");
    if (!Object.hasOwn(responses, route)) throw new Error(`Unexpected setup request: ${route}`);
    return Response.json(responses[route]);
  }) as typeof fetch;
  await expect(setupDiscordMessenger({ configPath, dmTest: false, toolNames: ["bogus"] }, {
    interactive: false, say() {}, ask: async () => { throw new Error("Unexpected prompt"); }, askSecret: async () => { throw new Error("Unexpected credential prompt"); },
  }, { env: { JEO_DISCORD_BOT_TOKEN: "test-token" }, fetch: fetchImpl, jeoCommand: ["/opt/jeo"] })).rejects.toThrow("toolNames must be a unique list");
  expect(await fs.readFile(configPath, "utf8")).toBe(original);
  expect((await fs.readdir(root)).filter(name => name.endsWith(".tmp"))).toEqual([]);
});

for (const scenario of ["fresh", "migration", "private"] as const) test({ fresh: "fresh Discord setup creates a workspace accepted by sandbox policy", migration: "Discord setup reports missing-cwd migration to a sandbox-eligible workspace", private: "Discord setup refuses a private configured workspace without replacing the config" }[scenario], async () => {
  const root = await directory();
  const script = path.join(root, "setup-check.ts");
  const setupModule = path.resolve(import.meta.dir, "../src/messenger/discord-setup.ts");
  const configModule = path.resolve(import.meta.dir, "../src/messenger/config.ts");
  const policyModule = path.resolve(import.meta.dir, "../src/agent/sandbox/policy.ts");
  await fs.writeFile(script, `
    import { setupDiscordMessenger } from ${JSON.stringify(setupModule)};
    import { loadMessengerConfig } from ${JSON.stringify(configModule)};
    import { createSandboxPolicy } from ${JSON.stringify(policyModule)};
    import * as path from "node:path";
    import * as fs from "node:fs/promises";
    const configPath = path.join(process.env.JEO_CONFIG_DIR!, "notifications", "messenger.json");
    let original = "";
    if (${scenario !== "fresh"}) {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      original = JSON.stringify({ ...(${scenario === "private"} ? { cwd: path.join(process.env.JEO_CONFIG_DIR!, "private-workspace") } : {}), sandbox: { image: "local-test-image", limits: { memoryBytes: 268435456, pids: 32, cpus: 1 } }, platforms: { discord: { tokenEnv: "JEO_DISCORD_BOT_TOKEN", allowedUserIds: ["owner"], allowedChannelIds: ["channel"] } } });
      await fs.writeFile(configPath, original);
    }
    const notices: string[] = [];
    const answers = ["local-test-image", "268435456", "32", "1"];
    const responses: Record<string, unknown> = {
      "/users/@me": { id: "bot", username: "test-bot", bot: true },
      "/applications/@me": { id: "application", owner: { id: "owner" }, flags: 1 << 18 },
      "/users/@me/guilds": [{ id: "guild" }],
      "/guilds/guild": { id: "guild", roles: [{ id: "guild", permissions: "8" }] },
      "/guilds/guild/members/bot": { roles: [] },
      "/guilds/guild/channels": [{ id: "channel", name: "requests", type: 0 }],
      "/gateway/bot": { url: "wss://gateway.discord.gg" },
    };
    const fakeFetch = async (input: string | URL | Request) => {
      const route = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname.replace("/api/v10", "");
      if (!Object.hasOwn(responses, route)) throw new Error("Unexpected setup request: " + route);
      return Response.json(responses[route]);
    };
    class ReadySocket extends EventTarget {
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ op: 0, t: "READY" }) }))); }
      close() {}
    }
    const setup = () => setupDiscordMessenger({ configPath, dmTest: false }, {
      interactive: true, say(message: string) { notices.push(message); }, ask: async () => { const answer = answers.shift(); if (!answer) throw new Error("Unexpected prompt"); return answer; },
      askSecret: async () => { throw new Error("Unexpected credential prompt"); },
    }, { env: { JEO_DISCORD_BOT_TOKEN: "test-token" }, fetch: fakeFetch as typeof fetch, WebSocket: ReadySocket as unknown as typeof WebSocket, jeoCommand: ["/opt/jeo"] });
    if (${scenario === "private"}) {
      let error: unknown;
      try { await setup(); } catch (caught) { error = caught; }
      if (!(error instanceof Error) || !error.message.includes("would be refused at launch")) throw new Error("Private workspace was not refused at launch admission");
      if (await fs.readFile(configPath, "utf8") !== original) throw new Error("Existing configuration changed after admission failure");
      if ((await fs.readdir(path.dirname(configPath))).some(name => name.endsWith(".tmp"))) throw new Error("Staged file was not cleaned up");
    } else {
      await setup();
      const config = await loadMessengerConfig(configPath);
      await createSandboxPolicy({ sessionKey: "setup-test", revision: 1, cwd: config.cwd, config: config.sandbox! });
      if (${scenario === "migration"} && !notices.some(message => message.includes('had no "cwd"') && message.includes(config.cwd))) throw new Error("Missing workspace migration notice");
    }
  `);
  const drive = process.platform === "win32" ? path.parse(root).root.slice(0, 2) : "";
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "", HOME: root, USERPROFILE: root,
    HOMEDRIVE: drive, HOMEPATH: drive ? root.slice(drive.length) : root,
    TMPDIR: root, TEMP: root, TMP: root, JEO_CONFIG_DIR: path.join(root, ".jeo"),
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  const child = Bun.spawn([process.execPath, script], {
    env,
    stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
});

test("thread authorization requires both the user and allowed parent channel", () => {
  expect(isMessengerMessageAllowed(base, config)).toBe(true);
  expect(isMessengerMessageAllowed({ ...base, senderId: "stranger" }, config)).toBe(false);
  expect(isMessengerMessageAllowed({ ...base, parentChannelId: "other" }, config)).toBe(false);
  expect(isMessengerMessageAllowed({ ...base, messageId: "" }, config)).toBe(false);
  expect(isMessengerMessageAllowed({ ...base, text: "x".repeat(32001) }, config)).toBe(false);
});

test("thread participants share conversation artifacts while DMs and distinct sessions remain confined", async () => {
  const otherUser = { ...base, senderId: "other" };
  const otherBot = { ...base, accountId: "other-bot" };
  const later = { ...base, messageId: "two" };
  expect(messengerSessionRoute("/repo", base)).toBe(messengerSessionRoute("/repo", later));
  expect(messengerSessionRoute("/repo", base)).toBe(messengerSessionRoute("/repo", otherUser));
  const artifacts = await directory();
  const firstDirectory = messengerArtifactDirectory(artifacts, base);
  await fs.mkdir(firstDirectory, { recursive: true });
  await fs.writeFile(path.join(firstDirectory, "result.txt"), "shared thread result");
  expect(await fs.readFile(path.join(messengerArtifactDirectory(artifacts, otherUser), "result.txt"), "utf8")).toBe("shared thread result");
  const dm = { ...base, direct: true, threadId: undefined, parentChannelId: undefined };
  expect(messengerArtifactDirectory(artifacts, dm)).not.toBe(messengerArtifactDirectory(artifacts, { ...dm, senderId: "other" }));
  for (const other of [otherBot, { ...base, threadId: "another" }]) {
    expect(messengerSessionRoute("/repo", base)).not.toBe(messengerSessionRoute("/repo", other));
    expect(messengerArtifactDirectory("/artifacts", base)).not.toBe(messengerArtifactDirectory("/artifacts", other));
  }
  expect(messengerSessionRoute("/repo", base)).not.toBe(messengerSessionRoute("/elsewhere", base));
});

test("direct-message senders retain separate conversation history even in the same channel", async () => {
  const cwd = await directory();
  const spawn = ((_argv: string[], options: SpawnOptions) => fakeWorker(history => history.join(" -> "), [], options)) as typeof Bun.spawn;
  const reply = createMessengerCliReply({ ...config, cwd, sessionDir: await directory() }, spawn, selectModel);
  const dm: MessengerMessage = { ...base, threadId: undefined, parentChannelId: undefined, channelId: "dm-channel", direct: true, text: "owner first" };
  try {
    const signal = new AbortController().signal;
    expect(await reply(dm, signal)).toBe("owner first");
    expect(await reply({ ...dm, messageId: "two", senderId: "other", text: "other first" }, signal)).toBe("other first");
    expect(await reply({ ...dm, messageId: "three", text: "owner follow-up" }, signal)).toBe("owner first -> owner follow-up");
    expect(await reply({ ...dm, messageId: "four", senderId: "other", text: "other follow-up" }, signal)).toBe("other first -> other follow-up");
  } finally { await reply.close(); }
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
  const fakeSpawn = ((argv: string[], options: SpawnOptions) => {
    const requests: string[] = [];
    captured.push({ argv, env: options.env, requests });
    const ipc = options as unknown as { ipc?: unknown; serialization?: unknown };
    // Protected workers get an inert IPC handler and JSON serialization; no public model/tool/stdin control exists for shutdown.
    expect(typeof ipc.ipc).toBe("function");
    expect(ipc.serialization).toBe("json");
    return fakeWorker(history => history.join(" -> "), requests, options);
  }) as typeof Bun.spawn;
  const previous = { jeo: process.env.JEO_DISCORD_BOT_TOKEN, jeopi: process.env.JEOPI_DISCORD_BOT_TOKEN };
  process.env.JEO_DISCORD_BOT_TOKEN = "primary-secret";
  process.env.JEOPI_DISCORD_BOT_TOKEN = "alias-secret";
  const replies: { close(): Promise<void> }[] = [];
  try {
    const safe = { ...config, cwd, sessionDir: await directory(), toolNames: [] };
    const reply = createMessengerCliReply(safe, fakeSpawn, selectModel);
    replies.push(reply);
    const activity: string[] = [];
    expect(await reply(base, new AbortController().signal, line => activity.push(line))).toBe("hello");
    expect(activity).toEqual(["Working on your request"]);
    expect(await reply({ ...base, messageId: "later" }, new AbortController().signal)).toBe("hello -> hello");
    expect(await reply({ ...base, senderId: "different" }, new AbortController().signal)).toBe("hello -> hello -> hello");
    expect(await reply({ ...base, accountId: "other-bot" }, new AbortController().signal)).toBe("hello");
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
    expect((await fs.readdir(safe.sessionDir)).sort()).toEqual(captured.slice(0, 2).map(item => `${sessionId(item.argv)}.jsonl`).sort());
    expect(captured.every(item => item.env.JEO_SESSION_DIR === safe.sessionDir)).toBe(true);
    expect(permitted).not.toContain("--no-tools");
    expect(permitted[permitted.indexOf("--tools") + 1]).toBe("read,bash,computer");
    expect(captured[0]!.env.JEO_MESSENGER_COMPUTER_ENABLED).toBe("0");
    expect(captured[2]!.env.JEO_MESSENGER_COMPUTER_ENABLED).toBe("1");
    expect(captured[0]!.requests).toEqual(["hello", "hello", "hello", "--tools=bash", "--list"]);
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

for (const legacyName of ["sessions", "messenger-sessions"]) test(`workspace transcripts in .jeo/${legacyName} block launch without copying or changing private history`, async () => {
  const cwd = await directory();
  const safe = { ...config, cwd, sessionDir: await directory() };
  const legacyDir = path.join(cwd, ".jeo", legacyName);
  await fs.mkdir(legacyDir, { recursive: true });
  const legacy = path.join(legacyDir, "prior-session.jsonl");
  const history = '{"type":"legacy-history","content":"private transcript"}\n';
  await fs.writeFile(legacy, history);
  let spawned = false;
  const fakeSpawn = ((_argv: string[], options: SpawnOptions) => { spawned = true; return fakeWorker("must not run", [], options); }) as typeof Bun.spawn;
  const reply = createMessengerCliReply(safe, fakeSpawn, selectModel);
  try {
    await expect(reply(base, new AbortController().signal)).rejects.toThrow("Legacy session transcripts");
    expect(spawned).toBe(false);
    expect(await fs.readFile(legacy, "utf8")).toBe(history);
    expect(await fs.readdir(safe.sessionDir)).toEqual([]);
  } finally { await reply.close(); }
});

test("resuming a private transcript does not overwrite its history across follow-up messages", async () => {
  const cwd = await directory();
  const safe = { ...config, cwd, sessionDir: await directory() };
  const hex = messengerSessionRoute(cwd, base);
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const transcript = path.join(safe.sessionDir, `${id}.jsonl`);
  const history = '{"type":"private-history","content":"preserve me"}\n';
  await fs.writeFile(transcript, history);
  const reply = createMessengerCliReply(safe, ((_argv: string[], options: SpawnOptions) => fakeWorker("ok", [], options)) as typeof Bun.spawn, selectModel);
  try {
    expect(await reply(base, new AbortController().signal)).toBe("ok");
    expect(await fs.readFile(transcript, "utf8")).toBe(history);
    await fs.writeFile(transcript, "newer private history\n");
    expect(await reply({ ...base, messageId: "follow-up" }, new AbortController().signal)).toBe("ok");
    expect(await fs.readFile(transcript, "utf8")).toBe("newer private history\n");
  } finally { await reply.close(); }
});

test("Bun dotenv autoload cannot restore messenger credentials to the child process", async () => {
  const cwd = await directory();
  await fs.writeFile(path.join(cwd, ".env"), "JEO_DISCORD_BOT_TOKEN=dotenv-secret\nJEOPI_DISCORD_BOT_TOKEN=dotenv-alias\n");
  const entry = path.join(cwd, "probe.js");
  // The probe models only graceful shutdown: the exact private IPC frame carrying the parent's nonce
  // acknowledges that nonce on stderr, then exits 143. Signals are not a shutdown request.
  await fs.writeFile(entry, 'process.on("message", (m) => { if (m && Object.keys(m).sort().join() === "nonce,type" && m.type === "jeo_messenger_shutdown" && m.nonce === process.env.JEO_MESSENGER_SHUTDOWN_NONCE) process.stderr.write("JEO_MESSENGER_SHUTDOWN_ACK " + JSON.stringify({ nonce: m.nonce, gone: true }) + "\\n", () => process.exit(143)); });\nfor await (const chunk of Bun.stdin.stream()) { console.log("JEO_MESSENGER_RESULT " + JSON.stringify(JSON.stringify([process.env.JEO_DISCORD_BOT_TOKEN, process.env.JEOPI_DISCORD_BOT_TOKEN]))); }\n');
  const spawn = ((_argv: string[], options: Parameters<typeof Bun.spawn>[1]) => Bun.spawn([process.execPath, entry], options)) as typeof Bun.spawn;
  const safe = { ...config, cwd, sessionDir: await directory() };
  const reply = createMessengerCliReply(safe, spawn, selectModel);
  try { expect(JSON.parse(await reply(base, new AbortController().signal))).toEqual(["", ""]); }
  finally { await reply.close(); }
});

test("Discord model and fallback do not leak to a Telegram worker", async () => {
  const cwd = await directory();
  const captured: { argv: string[]; env: Record<string, string> }[] = [];
  const spawn = ((argv: string[], options: SpawnOptions) => { captured.push({ argv, env: options.env }); return fakeWorker("ok", [], options); }) as typeof Bun.spawn;
  const safe: MessengerConfig = { ...config, cwd, sessionDir: await directory(), platforms: {
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