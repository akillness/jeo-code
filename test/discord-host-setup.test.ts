import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadMessengerConfig } from "../src/messenger/config";
import { setupDiscordMessenger, type DiscordSetupDeps, type DiscordSetupIO, type DiscordSetupOptions } from "../src/messenger/discord-setup";
import { isMessengerMessageAllowed } from "../src/messenger/gateway";
import { readMessengerProfiles, registerMessengerProfile, type MessengerProfileRecord } from "../src/messenger/runtime";
import type { MessengerMessage } from "../src/messenger/types";

const sandbox = { image: "local-test-image", limits: { memoryBytes: 268435456, pids: 32, cpus: 1 } };

function git(cwd: string, ...args: string[]) {
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	const result = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" } });
	if (result.exitCode !== 0) throw new Error(`Git fixture ${args.join(" ")} failed: ${result.stderr.toString()}`);
	return result.stdout.toString();
}

async function repository(directory: string, committed = true) {
	await fs.mkdir(directory, { recursive: true });
	git(directory, "init", "-q", "-b", "fixture");
	git(directory, "config", "user.name", "Discord Setup Test");
	git(directory, "config", "user.email", "discord-setup@example.invalid");
	git(directory, "config", "commit.gpgsign", "false");
	git(directory, "config", "core.hooksPath", "/dev/null");
	if (committed) {
		await fs.writeFile(path.join(directory, "source.txt"), "committed source\n");
		git(directory, "add", "source.txt");
		git(directory, "commit", "-qm", "private setup fixture");
	}
	return directory;
}

async function tree(directory: string): Promise<Record<string, string>> {
	const entries: Record<string, string> = {};
	async function visit(current: string) {
		for (const entry of await fs.readdir(current, { withFileTypes: true })) {
			const absolute = path.join(current, entry.name);
			const relative = path.relative(directory, absolute);
			if (entry.isSymbolicLink()) entries[relative] = `link:${await fs.readlink(absolute)}`;
			else if (entry.isDirectory()) { entries[`${relative}/`] = "directory"; await visit(absolute); }
			else entries[relative] = (await fs.readFile(absolute)).toString("hex");
		}
	}
	await visit(directory);
	return entries;
}

async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-discord-setup-host-")));
	const configPath = path.join(root, "profile", "messenger.json");
	const sessions = path.join(root, "sessions");
	const profilesPath = path.join(root, "profiles.json");
	const notices: string[] = [];
	const fetches: string[] = [];
	const io: DiscordSetupIO = {
		interactive: false, say(line) { notices.push(line); },
		ask: async () => { throw new Error("Unexpected setup question"); },
		askSecret: async () => { throw new Error("Unexpected credential question"); },
	};
	const responses: Record<string, unknown> = {
		"/users/@me": { id: "bot", username: "fixture-bot", bot: true },
		"/applications/@me": { id: "application", owner: { id: "owner" }, flags: 1 << 18 },
		"/users/@me/guilds": [{ id: "guild" }],
		"/guilds/guild": { id: "guild", roles: [{ id: "guild", permissions: "8" }] },
		"/guilds/guild/members/bot": { roles: [] },
		"/guilds/guild/channels": [{ id: "channel", name: "requests", type: 0 }],
		"/channels/channel": { id: "channel", guild_id: "guild", name: "requests", type: 0 },
		"/gateway/bot": { url: "wss://gateway.discord.gg" },
	};
	class ReadySocket extends EventTarget {
		constructor() { super(); queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ op: 0, t: "READY" }) }))); }
		close() {}
	}
	const deps: DiscordSetupDeps = {
		env: { JEO_DISCORD_BOT_TOKEN: "fixture-token-not-real" },
		fetch: (async (input: string | URL | Request) => {
			const route = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname.replace("/api/v10", "");
			fetches.push(route);
			if (!Object.hasOwn(responses, route)) throw new Error(`Unexpected setup request: ${route}`);
			return Response.json(responses[route]);
		}) as typeof fetch,
		WebSocket: ReadySocket as unknown as typeof WebSocket,
		jeoCommand: [process.execPath], profilesPath,
		restartService: async () => "not installed",
		installService: async () => { throw new Error("Tests must not install a service"); },
	};
	const previous = {
		cwd: path.join(root, "legacy-workspace"), sessionDir: sessions, toolNames: ["read", "write"], sandbox,
		platforms: {
			discord: { tokenEnv: "JEO_DISCORD_BOT_TOKEN", allowedUserIds: ["owner", "collaborator"], allowedChannelIds: ["channel"], model: "openai/gpt-6.1-terra", artifactDir: "./artifacts" },
			telegram: { tokenEnv: "MY_TELEGRAM_TOKEN", allowedUserIds: ["telegram-owner"], allowedChannelIds: ["telegram-room"] },
		},
	};
	async function save(config: unknown = previous, selectedPath = configPath) {
		await fs.mkdir(path.dirname(selectedPath), { recursive: true });
		await fs.writeFile(selectedPath, `${JSON.stringify(config, null, 2)}\n`);
	}
	return { root, configPath, sessions, profilesPath, io, deps, notices, fetches, previous, save, close: () => fs.rm(root, { recursive: true, force: true }) };
}

const discordMessage: MessengerMessage = { platform: "discord", accountId: "bot", guildId: "guild", channelId: "thread", parentChannelId: "channel", threadId: "thread", senderId: "collaborator", messageId: "1", text: "work", direct: false, mentioned: false };

for (const scenario of ["missing", "non-Git", "unborn", "file", "root", "profile-inside-project", "project-inside-profile", "sessions-inside-project", "project-inside-sessions", "private-common-dir"] as const) test(`host setup rejects ${scenario} before network, credential or profile mutation`, async () => {
	const f = await fixture();
	try {
		let project = path.join(f.root, "project");
		let selectedPath = f.configPath;
		let sessions = f.sessions;
		if (scenario === "missing") project = path.join(f.root, "missing");
		else if (scenario === "non-Git") await fs.mkdir(project);
		else if (scenario === "unborn") await repository(project, false);
		else if (scenario === "file") await fs.writeFile(project, "not a directory\n");
		else if (scenario === "root") project = path.parse(f.root).root;
		else if (scenario === "profile-inside-project") { await repository(project); selectedPath = path.join(project, "profile", "messenger.json"); }
		else if (scenario === "project-inside-profile") { project = path.join(path.dirname(f.configPath), "project"); await repository(project); }
		else if (scenario === "sessions-inside-project") { await repository(project); sessions = path.join(project, "private-sessions"); }
		else if (scenario === "project-inside-sessions") { project = path.join(sessions, "project"); await repository(project); }
		else {
			const source = await repository(path.join(f.root, "private-source"));
			selectedPath = path.join(source, "messenger.json");
			git(source, "worktree", "add", "-qb", "linked", project);
		}
		await f.save({ ...f.previous, sessionDir: sessions }, selectedPath);
		const before = await tree(f.root);
		await expect(setupDiscordMessenger({ configPath: selectedPath, workerMode: "host", projectPath: project, dmTest: false }, f.io, f.deps)).rejects.toThrow(scenario.includes("inside") || scenario === "private-common-dir" ? /outside and disjoint/ : /existing Git project/);
		expect(f.fetches).toEqual([]);
		expect(await tree(f.root)).toEqual(before);
	} finally { await f.close(); }
});

for (const projectPath of ["", " project ", "project\nother"] as const) test(`malformed host project ${JSON.stringify(projectPath)} is refused without creating a fresh profile`, async () => {
	const f = await fixture();
	try {
		await expect(setupDiscordMessenger({ configPath: f.configPath, workerMode: "host", projectPath }, f.io, f.deps)).rejects.toThrow(/existing project directory/);
		expect(f.fetches).toEqual([]);
		expect(await fs.readdir(f.root)).toEqual([]);
	} finally { await f.close(); }
});

test("invalid worker mode is refused before token access and leaves the working profile byte-identical", async () => {
	const f = await fixture();
	try {
		await f.save();
		const before = await tree(f.root);
		const options: DiscordSetupOptions = { configPath: f.configPath, workerMode: JSON.parse('"untrusted-mode"') };
		await expect(setupDiscordMessenger(options, f.io, f.deps)).rejects.toThrow(/worker mode/);
		expect(f.fetches).toEqual([]);
		expect(await tree(f.root)).toEqual(before);
	} finally { await f.close(); }
});

for (const preserveHost of [false, true]) test(`${preserveHost ? "repairing an existing host profile" : "explicit host conversion"} preserves permissions, tools and other profiles`, async () => {
	const f = await fixture();
	try {
		const project = await repository(path.join(f.root, "project"));
		await fs.writeFile(path.join(project, "source.txt"), "dirty source must survive setup\n");
		const beforeSource = await tree(project);
		const previous = { ...f.previous, cwd: preserveHost ? project : f.previous.cwd, platforms: { ...f.previous.platforms, discord: { ...f.previous.platforms.discord, ...(preserveHost ? { workerMode: "host" } : {}) } } };
		await f.save(previous);
		const otherPath = path.join(f.root, "other-profile", "messenger.json");
		await f.save({ separate: "operator-owned profile bytes" }, otherPath);
		const otherBytes = await fs.readFile(otherPath, "utf8");
		const otherRecord: MessengerProfileRecord = { configPath: otherPath, runScript: path.join(path.dirname(otherPath), "run.sh"), runtime: { kind: "external", command: ["/operator/other-jeo"] }, updatedAt: "2026-01-01T00:00:00.000Z" };
		await registerMessengerProfile(otherRecord, f.profilesPath);
		const options: DiscordSetupOptions = { configPath: f.configPath, dmTest: false, ...(preserveHost ? {} : { workerMode: "host", projectPath: project }) };
		const result = await setupDiscordMessenger(options, f.io, f.deps);
		const loaded = await loadMessengerConfig(result.configPath);
		expect(loaded.cwd).toBe(await fs.realpath(project));
		expect(isMessengerMessageAllowed(discordMessage, loaded)).toBe(true);
		expect(isMessengerMessageAllowed({ ...discordMessage, senderId: "stranger" }, loaded)).toBe(false);
		expect(isMessengerMessageAllowed({ ...discordMessage, channelId: "outside", parentChannelId: "outside" }, loaded)).toBe(false);
		const persisted = JSON.parse(await fs.readFile(f.configPath, "utf8"));
		expect(persisted).toEqual({ ...previous, cwd: project, platforms: { ...previous.platforms, discord: { ...previous.platforms.discord, workerMode: "host" } } });
		expect(await tree(project)).toEqual(beforeSource);
		expect(await fs.readFile(otherPath, "utf8")).toBe(otherBytes);
		expect((await readMessengerProfiles(f.profilesPath)).find(record => record.configPath === otherPath)).toEqual(otherRecord);
		const disclosure = f.notices.join("\n");
		expect(disclosure).toMatch(/same OS account/);
		expect(disclosure).toMatch(/CLI trust, not OS isolation/);
		expect(disclosure).toMatch(/edits, tests and builds run automatically/);
		expect(disclosure).toMatch(/one-use exact-action approval in the same thread/);
		expect(disclosure).toMatch(/No automatic merge, push or worktree deletion/);
	} finally { await f.close(); }
});

test("legacy sandbox setup still accepts a non-Git workspace and preserves its operator-owned execution policy", async () => {
	const f = await fixture();
	try {
		await fs.mkdir(f.previous.cwd);
		await fs.writeFile(path.join(f.previous.cwd, "source.txt"), "legacy workspace\n");
		await f.save();
		await setupDiscordMessenger({ configPath: f.configPath, dmTest: false }, f.io, f.deps);
		const loaded = await loadMessengerConfig(f.configPath);
		expect(isMessengerMessageAllowed(discordMessage, loaded)).toBe(true);
		expect(await fs.readFile(path.join(loaded.cwd, "source.txt"), "utf8")).toBe("legacy workspace\n");
		expect(JSON.parse(await fs.readFile(f.configPath, "utf8"))).toEqual(f.previous);
	} finally { await f.close(); }
});

// A child-local HOME/JEO_CONFIG_DIR contains fresh setup's private storage. No
// process.env mutation, user's default workspace, native sandbox or Docker is used.
for (const relative of [false, true]) test(`fresh host setup admits an existing ${relative ? "invocation-relative" : "absolute"} Git project without provisioning an empty workspace`, async () => {
	const f = await fixture();
	try {
		const project = await repository(path.join(f.root, "project"));
		const source = await tree(project);
		const script = path.join(f.root, "fresh-setup.ts");
		await fs.writeFile(script, `
import { setupDiscordMessenger } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/messenger/discord-setup.ts"))};
import { loadMessengerConfig } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/messenger/config.ts"))};
import * as fs from "node:fs/promises";
import * as path from "node:path";
const root = process.env.FIXTURE_ROOT!;
const calls: string[] = [];
const notices: string[] = [];
const responses: Record<string, unknown> = {
  "/users/@me": { id: "bot", username: "fixture-bot", bot: true },
  "/applications/@me": { id: "application", owner: { id: "owner" }, flags: 1 << 18 },
  "/users/@me/guilds": [{ id: "guild" }],
  "/guilds/guild": { id: "guild", roles: [{ id: "guild", permissions: "8" }] },
  "/guilds/guild/members/bot": { roles: [] },
  "/guilds/guild/channels": [{ id: "channel", name: "requests", type: 0 }],
  "/channels/channel": { id: "channel", guild_id: "guild", name: "requests", type: 0 },
  "/gateway/bot": { url: "wss://gateway.discord.gg" },
};
class ReadySocket extends EventTarget {
  constructor() { super(); queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ op: 0, t: "READY" }) }))); }
  close() {}
}
const result = await setupDiscordMessenger({ configPath: path.join(root, "profile", "messenger.json"), workerMode: "host", projectPath: ${JSON.stringify(relative ? "project" : project)}, userIds: ["owner"], channelIds: ["channel"], toolNames: ["read", "write"], dmTest: false }, {
  interactive: false, say(line) { notices.push(line); }, ask: async () => { throw new Error("unexpected prompt"); }, askSecret: async () => { throw new Error("unexpected credential prompt"); },
}, {
  env: { JEO_DISCORD_BOT_TOKEN: "fixture-token-not-real" },
  fetch: (async (input: string | URL | Request) => {
    const route = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname.replace("/api/v10", "");
    calls.push(route);
    if (!Object.hasOwn(responses, route)) throw new Error("unexpected setup request: " + route);
    return Response.json(responses[route]);
  }) as typeof fetch,
  WebSocket: ReadySocket as unknown as typeof WebSocket,
  jeoCommand: [process.execPath], profilesPath: path.join(root, "profiles.json"), restartService: async () => "not installed",
  installService: async () => { throw new Error("must not install service"); },
});
const loaded = await loadMessengerConfig(result.configPath);
console.log(JSON.stringify({ cwd: loaded.cwd, notices, calls, homeEntries: await fs.readdir(process.env.HOME!) }));
`);
		const home = path.join(f.root, "home");
		await fs.mkdir(home);
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && !key.startsWith("JEO_")));
		const child = Bun.spawn([process.execPath, script], { cwd: f.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...env, HOME: home, USERPROFILE: home, JEO_CONFIG_DIR: path.join(home, ".jeo"), FIXTURE_ROOT: f.root }, timeout: 15_000 });
		const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		expect({ code, error: err }).toEqual({ code: 0, error: "" });
		const output = JSON.parse(out.trim());
		expect(output.cwd).toBe(project);
		expect(output.calls).toContain("/gateway/bot");
		expect(output.notices.join("\n")).toMatch(/same OS account.*not OS isolation/);
		expect(Object.keys(await tree(home)).filter(entry => path.basename(entry) === ".jeo-workspace")).toEqual([]);
		expect(await tree(project)).toEqual(source);
	} finally { await f.close(); }
});
