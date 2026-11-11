import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { downloadMessengerAttachments, readMessengerArtifacts } from "../src/messenger/artifacts";
import { loadMessengerConfig, parseMessengerConfig, resolveMessengerToken, validateMessengerEnvironment } from "../src/messenger/config";
import { createMessengerGateway, isMessengerMessageAllowed, messengerConversationKey, messengerSessionRoute } from "../src/messenger/gateway";
import type { MessengerAdapter, MessengerConfig, MessengerMessage } from "../src/messenger/types";
import { COMMANDS } from "../src/cli/runner";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

function message(overrides: Partial<MessengerMessage> = {}): MessengerMessage {
	return { platform: "discord", accountId: "bot", channelId: "channel", senderId: "owner", messageId: "message", text: "hello", direct: false, mentioned: true, ...overrides };
}

function config(): MessengerConfig {
	return { cwd: "/workspace", sessionDir: "/sessions", toolNames: [], platforms: { discord: { tokenEnv: "JEO_DISCORD_BOT_TOKEN", allowedUserIds: ["owner"], allowedChannelIds: ["channel"] } } };
}

describe("messenger security and configuration", () => {
	test("requires exact explicit allowlists and rejects unknown or unsafe configuration", () => {
		const sandbox = { image: "oven/bun:1.3.14", limits: { memoryBytes: 268435456, pids: 32, cpus: 1 } };
		const layout = { cwd: "ws", sessionDir: "private", sandbox };
		expect(parseMessengerConfig({ cwd: "ws", sessionDir: "private", platforms: { discord: { allowedUserIds: ["1"] } } }, "/tmp").sandbox).toBeUndefined();
		expect(() => parseMessengerConfig({ ...layout, platforms: { discord: { allowedUserIds: [] } } }, "/tmp")).toThrow();
		expect(() => parseMessengerConfig({ ...layout, platforms: { discord: { allowedUserIds: ["*"] } } }, "/tmp")).toThrow();
		expect(() => parseMessengerConfig({ ...layout, platforms: { discord: { allowedUserIds: ["1"], surprise: true } } }, "/tmp")).toThrow("unknown setting");
		expect(() => parseMessengerConfig({ ...layout, toolNames: ["delete"], platforms: { discord: { allowedUserIds: ["1"] } } }, "/tmp")).toThrow();
		const parsed = parseMessengerConfig({ ...layout, toolNames: ["read"], platforms: { discord: { allowedUserIds: ["1"], allowedChannelIds: ["2"] } } }, "/profile");
		expect(parseMessengerConfig({ ...layout, toolNames: ["read", "find", "search", "edit", "write", "computer"], platforms: { discord: { allowedUserIds: ["1"] } } }, "/tmp").toolNames).toEqual(["read", "find", "search", "edit", "write", "computer"]);
		expect(parsed.cwd).toBe("/profile/ws");
		expect(parsed.sandbox).toEqual(sandbox);
		expect(parsed.sessionDir).toBe("/profile/private");
		expect(() => validateMessengerEnvironment(parsed, {})).toThrow();
		validateMessengerEnvironment(parsed, { JEO_DISCORD_BOT_TOKEN: "token" });
	});

	test("Discord profile, its ancestors and descendants cannot be sandbox workspaces, including symlink aliases", async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-profile-workspace-"))); roots.push(root);
		const sessionRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-profile-session-"))); roots.push(sessionRoot);
		const profile = path.join(root, "profile");
		const workspace = path.join(root, "workspace");
		const alias = path.join(root, "profile-alias");
		await Promise.all([fs.mkdir(profile), fs.mkdir(workspace)]);
		const nested = path.join(profile, "workspace");
		const nestedAlias = path.join(root, "nested-alias");
		await fs.mkdir(nested);
		await fs.symlink(nested, nestedAlias, process.platform === "win32" ? "junction" : "dir");
		await fs.writeFile(path.join(profile, "credentials.json"), "sentinel credential");
		await fs.writeFile(path.join(profile, "launch.sh"), "sentinel launcher");
		await fs.symlink(profile, alias, process.platform === "win32" ? "junction" : "dir");
		const file = path.join(profile, "messenger.json");
		const common = { sessionDir: path.join(sessionRoot, "sessions"), sandbox: { image: "test-local-image", limits: { memoryBytes: 134217728, pids: 32, cpus: 1 } }, platforms: { discord: { allowedUserIds: ["owner"] } } };
		for (const cwd of [undefined, profile, root, alias, nested, nestedAlias]) {
			await fs.writeFile(file, JSON.stringify({ ...common, ...(cwd === undefined ? {} : { cwd }) }));
			await expect(loadMessengerConfig(file)).rejects.toThrow("messenger profile directory");
		}
		await fs.writeFile(file, JSON.stringify({ ...common, cwd: workspace }));
		expect((await loadMessengerConfig(file)).cwd).toBe(workspace);
		expect(await fs.readFile(path.join(profile, "credentials.json"), "utf8")).toBe("sentinel credential");
	});

	test("supports JEO and JEOPI default credential aliases without exposing values", () => {
		expect(resolveMessengerToken("JEO_DISCORD_BOT_TOKEN", { JEOPI_DISCORD_BOT_TOKEN: "secret" })).toBe("secret");
		expect(resolveMessengerToken("CUSTOM", { JEOPI_DISCORD_BOT_TOKEN: "secret" })).toBeUndefined();
	});

	test("authorizes only the configured user, channel and mention shape", () => {
		const settings = config();
		expect(isMessengerMessageAllowed(message(), settings)).toBe(true);
		expect(isMessengerMessageAllowed(message({ senderId: "other" }), settings)).toBe(false);
		expect(isMessengerMessageAllowed(message({ channelId: "other" }), settings)).toBe(false);
		expect(isMessengerMessageAllowed(message({ mentioned: false }), settings)).toBe(false);
		expect(isMessengerMessageAllowed(message({ direct: true, mentioned: false, channelId: "dm" }), settings)).toBe(false);
		delete settings.platforms.discord!.allowedChannelIds;
		expect(isMessengerMessageAllowed(message({ direct: true, mentioned: false, channelId: "dm" }), settings)).toBe(true);
	});
});

describe("messenger attachment boundaries", () => {
	test("accepts ten HTTPS trusted-CDN attachments and rejects an eleventh", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-messenger-")); roots.push(root);
		const attachments = Array.from({ length: 10 }, (_, index) => ({ url: `https://cdn.discordapp.com/attachments/a/b/${index}`, filename: `${index}.txt`, size: 1 }));
		const fetcher = async () => new Response(new Uint8Array([65]));
		await expect(downloadMessengerAttachments(root, message({ attachments }), new AbortController().signal, fetcher as typeof fetch)).resolves.toHaveLength(10);
		await expect(downloadMessengerAttachments(root, message({ attachments: [...attachments, attachments[0]!] }), new AbortController().signal, fetcher as typeof fetch)).rejects.toThrow("Too many attachments");
	});

	test("rejects HTTP, credentials, redirects and non-Discord hosts", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-messenger-")); roots.push(root);
		for (const url of ["http://cdn.discordapp.com/attachments/a/b/x", "https://evil.example/attachments/a/b/x", "https://user@cdn.discordapp.com/attachments/a/b/x", "https://cdn.discordapp.com/not-attachments/x"]) {
			await expect(downloadMessengerAttachments(root, message({ attachments: [{ url, filename: "x", size: 0 }] }), new AbortController().signal)).rejects.toThrow("Invalid attachment URL");
		}
	});

	test("uploads at most ten regular in-root files and blocks traversal and symlinks", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-messenger-")); roots.push(root);
		const target = path.join(root, new Bun.CryptoHasher("sha256").update(messengerConversationKey(message())).digest("hex"));
		await fs.mkdir(target); await fs.writeFile(path.join(target, "ok.txt"), "ok");
		await expect(readMessengerArtifacts(root, message(), "answer\n[artifact:ok.txt]")).resolves.toMatchObject({ text: "answer", files: [{ name: "ok.txt" }] });
		await expect(readMessengerArtifacts(root, message(), "[artifact:../x]")).rejects.toThrow("Invalid output file path");
		await fs.symlink(path.join(target, "ok.txt"), path.join(target, "link.txt"));
		await expect(readMessengerArtifacts(root, message(), "[artifact:link.txt]")).rejects.toThrow("symlinks");
		await expect(readMessengerArtifacts(root, message(), Array.from({ length: 11 }, () => "[artifact:ok.txt]").join("\n"))).rejects.toThrow("Too many output files");
	});
});

describe("messenger session routing and observable gateway behavior", () => {
	test("routes DMs by sender and server work by thread, deterministically", () => {
		const dmA = message({ direct: true, channelId: "dm-a", senderId: "u1", mentioned: false });
		const dmB = message({ direct: true, channelId: "dm-b", senderId: "u1", mentioned: false });
		expect(messengerConversationKey(dmA)).not.toBe(messengerConversationKey(dmB));
		expect(messengerSessionRoute("/repo", dmA)).not.toBe(messengerSessionRoute("/repo", dmB));
		expect(messengerSessionRoute("/repo", dmA)).toBe(messengerSessionRoute("/repo", { ...dmA, messageId: "later" }));
		expect(messengerSessionRoute("/repo", dmA)).not.toBe(messengerSessionRoute("/other", dmA));
		expect(messengerConversationKey(message({ threadId: "thread" }))).toContain("thread");
	});

	test("deduplicates, serializes a conversation, sends status and reply", async () => {
		const delivered: string[] = []; const states: string[] = []; let receiver: ((value: MessengerMessage) => Promise<void>) | undefined;
		const adapter: MessengerAdapter = { platform: "discord", start: async (onMessage, signal) => { receiver = onMessage; await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); }, send: async (_m, text) => { delivered.push(text); }, status: async (_m, state) => { states.push(state); } };
		const gateway = createMessengerGateway(config(), [adapter], async incoming => `reply:${incoming.messageId}`);
		const controller = new AbortController(); const running = gateway.run(controller.signal);
		while (!receiver) await Bun.sleep(1);
		await Promise.all([receiver!(message()), receiver!(message())]);
		expect(delivered).toEqual(["reply:message"]);
		for (let attempts = 0; states.at(-1) !== "success" && attempts < 20; attempts++) await Bun.sleep(1);
		expect(states).toEqual(["processing", "success"]);
		controller.abort(); await running;
	});

	test("registers the public messenger CLI command", () => {
		const command = COMMANDS.find(item => item.name === "messenger");
		expect(command?.usage).toContain("setup|check|run");
	});
});
