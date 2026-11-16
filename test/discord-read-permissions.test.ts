import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createGrantAuthority } from "../src/agent/sandbox/authority";
import { handleSandboxControl } from "../src/agent/sandbox/control";
import { createSandboxPolicy } from "../src/agent/sandbox/policy";
import { createSandboxSupervisor } from "../src/agent/sandbox/supervisor";
import type { SandboxPolicy, SandboxSupervisor } from "../src/agent/sandbox/types";
import { loadMessengerConfig, parseMessengerConfig } from "../src/messenger/config";
import { setupDiscordMessenger, type DiscordSetupDeps, type DiscordSetupIO } from "../src/messenger/discord-setup";
import { messengerConversationKey } from "../src/messenger/gateway";
import { createDiscordHostAuthority } from "../src/messenger/host-actions";
import type { DiscordHostAction, DiscordReadAccess, DiscordRunRef, MessengerConfig, MessengerMessage } from "../src/messenger/types";

const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
	tempRoots.push(root);
	return root;
}

afterEach(async () => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop()!;
		await fs.rm(root, { recursive: true, force: true });
	}
});

function git(cwd: string, ...args: string[]): string {
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_OPTIONAL_LOCKS: "0",
		},
	});
	if (result.exitCode !== 0) {
		throw new Error(`Git fixture ${args.join(" ")} failed: ${result.stderr.toString()}`);
	}
	return result.stdout.toString();
}

async function initGitRepo(directory: string, filename = "source.txt", content = "committed source\n"): Promise<string> {
	await fs.mkdir(directory, { recursive: true });
	git(directory, "init", "-q", "-b", "main");
	git(directory, "config", "user.name", "Read Permissions Test");
	git(directory, "config", "user.email", "read-permissions@example.invalid");
	git(directory, "config", "commit.gpgsign", "false");
	git(directory, "config", "core.hooksPath", "/dev/null");
	await fs.writeFile(path.join(directory, filename), content);
	git(directory, "add", filename);
	git(directory, "commit", "-qm", "initial fixture commit");
	return directory;
}

function discordMessage(text = "work", overrides: Partial<MessengerMessage> = {}): MessengerMessage {
	return {
		platform: "discord",
		accountId: "bot",
		guildId: "guild",
		channelId: "thread-a",
		parentChannelId: "channel",
		threadId: "thread-a",
		senderId: "owner",
		messageId: "msg-1",
		text,
		direct: false,
		mentioned: false,
		...overrides,
	};
}

describe("parseMessengerConfig readRoots and discord.readAccess", () => {
	test("parses relative readRoots deduplicated against baseDir and valid discord.readAccess", async () => {
		const root = await makeTempRoot("jeo-parse-read-perms-");
		const workspace = path.join(root, "workspace");
		const sibling = path.join(root, "sibling");
		const nested = path.join(workspace, "docs");
		const sessionDir = path.join(root, "sessions");
		await Promise.all([fs.mkdir(workspace, { recursive: true }), fs.mkdir(sibling, { recursive: true }), fs.mkdir(nested, { recursive: true })]);

		for (const readAccess of ["workspace", "global"] as const) {
			const parsed = parseMessengerConfig(
				{
					cwd: ".",
					sessionDir: "../sessions",
					readRoots: ["../sibling", "../sibling/", "./docs", "docs"],
					platforms: {
						discord: {
							allowedUserIds: ["owner"],
							allowedChannelIds: ["channel"],
							readAccess,
						},
					},
				},
				workspace,
			);
			expect(parsed.cwd).toBe(workspace);
			expect(parsed.sessionDir).toBe(sessionDir);
			expect(parsed.readRoots).toEqual([sibling, nested]);
			expect(parsed.platforms.discord?.readAccess).toBe(readAccess);
		}
	});

	test("rejects invalid discord.readAccess and non-array readRoots", async () => {
		const root = await makeTempRoot("jeo-parse-read-invalid-");
		const baseDiscord = {
			allowedUserIds: ["owner"],
			allowedChannelIds: ["channel"],
		};

		expect(() =>
			parseMessengerConfig(
				{
					cwd: ".",
					sessionDir: "./sessions",
					platforms: { discord: { ...baseDiscord, readAccess: "anywhere" } },
				},
				root,
			),
		).toThrow(/discord\.readAccess must be "workspace" or "global"/);

		for (const badReadRoots of ["../sibling", 42, { dir: "../sibling" }, true]) {
			expect(() =>
				parseMessengerConfig(
					{
						cwd: ".",
						sessionDir: "./sessions",
						readRoots: badReadRoots,
						platforms: { discord: baseDiscord },
					},
					root,
				),
			).toThrow(/readRoots must be an array/);
		}
	});
});

describe("setupDiscordMessenger persistence", () => {
	function setupHarness(root: string) {
		const configPath = path.join(root, "profile", "messenger.json");
		const profilesPath = path.join(root, "profiles.json");
		const notices: string[] = [];
		const io: DiscordSetupIO = {
			interactive: false,
			say(line) {
				notices.push(line);
			},
			ask: async () => {
				throw new Error("Unexpected setup prompt");
			},
			askSecret: async () => {
				throw new Error("Unexpected credential prompt");
			},
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
			constructor() {
				super();
				queueMicrotask(() => {
					this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }) }));
				});
			}
			send(data: string) {
				if (JSON.parse(data).op === 2) {
					queueMicrotask(() => {
						this.dispatchEvent(
							new MessageEvent("message", {
								data: JSON.stringify({
									op: 0,
									t: "READY",
									s: 1,
									d: {
										v: 10,
										user: { id: "bot", username: "fixture-bot" },
										session_id: "session",
										resume_gateway_url: "wss://gateway.discord.gg",
										guilds: [],
										application: { id: "application", flags: 0 },
									},
								}),
							}),
						);
					});
				}
			}
			close() {}
		}
		const deps: DiscordSetupDeps = {
			env: { JEO_DISCORD_BOT_TOKEN: "fixture-token-not-real" },
			fetch: (async (input: string | URL | Request) => {
				const route = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname.replace("/api/v10", "");
				if (!Object.hasOwn(responses, route)) throw new Error(`Unexpected Discord route: ${route}`);
				return Response.json(responses[route]);
			}) as typeof fetch,
			WebSocket: ReadySocket as unknown as typeof WebSocket,
			jeoCommand: [process.execPath],
			profilesPath,
			restartService: async () => "not installed",
			installService: async () => {
				throw new Error("Tests must not install a service");
			},
		};
		return { configPath, io, deps, notices };
	}

	test("saves readRoots and readAccess and preserves them across re-runs", async () => {
		const root = await makeTempRoot("jeo-setup-read-perms-");
		const project = await initGitRepo(path.join(root, "project"));
		const sibling = path.join(root, "sibling");
		const extra = path.join(root, "extra");
		await Promise.all([fs.mkdir(sibling, { recursive: true }), fs.mkdir(extra, { recursive: true })]);
		const previousConfigDir = process.env.JEO_CONFIG_DIR;
		process.env.JEO_CONFIG_DIR = path.join(root, "jeo-home");
		try {
			const { configPath, io, deps } = setupHarness(root);
			await setupDiscordMessenger(
				{
					configPath,
					projectPath: project,
					workerMode: "host",
					readAccess: "global",
					readRoots: [sibling, extra],
					dmTest: false,
				},
				io,
				deps,
			);

			const firstLoaded = await loadMessengerConfig(configPath);
			expect(firstLoaded.readRoots).toEqual([sibling, extra]);
			expect(firstLoaded.platforms.discord?.readAccess).toBe("global");

			// Re-running setup without readRoots or readAccess must preserve both settings.
			await setupDiscordMessenger(
				{
					configPath,
					dmTest: false,
				},
				io,
				deps,
			);

			const secondLoaded = await loadMessengerConfig(configPath);
			expect(secondLoaded.readRoots).toEqual([sibling, extra]);
			expect(secondLoaded.platforms.discord?.readAccess).toBe("global");

			const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as {
				readRoots?: string[];
				platforms?: { discord?: { readAccess?: string } };
			};
			expect(persisted.readRoots).toEqual([sibling, extra]);
			expect(persisted.platforms?.discord?.readAccess).toBe("global");
		} finally {
			if (previousConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
			else process.env.JEO_CONFIG_DIR = previousConfigDir;
		}
	});
});

describe("createDiscordHostAuthority read permissions", () => {
	async function hostFixture(options: { includeSiblingReadRoot?: boolean; readAccess?: DiscordReadAccess } = {}) {
		const root = await makeTempRoot("jeo-host-read-perms-");
		const workspace = await initGitRepo(path.join(root, "workspace"), "app.ts", "export const app = 1;\n");
		const siblingDir = await initGitRepo(path.join(root, "sibling"), "file.txt", "sibling content\n");
		const outsideDir = await initGitRepo(path.join(root, "outside"), "outside.txt", "outside content\n");
		const sessionDir = path.join(root, "sessions");
		const profileDir = path.join(root, "profile");

		await Promise.all([
			fs.mkdir(path.join(siblingDir, "src"), { recursive: true }),
			fs.mkdir(path.join(outsideDir, "src"), { recursive: true }),
			fs.mkdir(sessionDir, { recursive: true }),
			fs.mkdir(profileDir, { recursive: true }),
		]);
		await Promise.all([
			fs.writeFile(path.join(workspace, "input.txt"), "b\na\n"),
			fs.writeFile(path.join(siblingDir, "src", "match.ts"), "export const needle = 1;\n"),
			fs.writeFile(path.join(outsideDir, "src", "outside.ts"), "export const needle = 2;\n"),
			fs.writeFile(path.join(sessionDir, "secret.json"), '{"token":"secret"}\n'),
		]);

		const config: MessengerConfig = {
			profileDir,
			cwd: workspace,
			sessionDir,
			toolNames: ["read", "ls", "find", "search", "write", "edit", "delete", "bash"],
			...(options.includeSiblingReadRoot ? { readRoots: [siblingDir] } : {}),
			platforms: {
				discord: {
					tokenEnv: "DISCORD_TEST_TOKEN",
					workerMode: "host",
					...(options.readAccess ? { readAccess: options.readAccess } : {}),
					allowedUserIds: ["owner"],
					allowedChannelIds: ["channel"],
				},
			},
		};
		await fs.writeFile(path.join(profileDir, "messenger.json"), `${JSON.stringify(config, null, 2)}\n`);

		const notices: Array<{ run: DiscordRunRef; text: string }> = [];
		const waiting: Array<(notice: { run: DiscordRunRef; text: string }) => void> = [];
		let notificationCount = 0;
		const authority = createDiscordHostAuthority(config, async (run, text) => {
			notificationCount++;
			const notice = { run, text };
			const waiter = waiting.shift();
			if (waiter) waiter(notice);
			else notices.push(notice);
		});
		const origin = discordMessage();
		const conversationKey = messengerConversationKey(origin);
		const run: DiscordRunRef = {
			conversationKey,
			sessionId: "session-a",
			generation: 1,
			runId: "run-a",
		};
		authority.bind(run, origin, workspace);

		const nextNotice = () => {
			const notice = notices.shift();
			return notice ? Promise.resolve(notice) : new Promise<{ run: DiscordRunRef; text: string }>(resolve => waiting.push(resolve));
		};

		const authorizeAttempt = (action: DiscordHostAction, signal = new AbortController().signal) =>
			authority.authorize(run, action, signal).then(
				() => ({ allowed: true as const }),
				(error: unknown) => ({ allowed: false as const, error }),
			);

		let controlSeq = 0;
		const approvePending = async (action: DiscordHostAction) => {
			const controller = new AbortController();
			const done = authorizeAttempt(action, controller.signal);
			const first = await Promise.race([
				nextNotice().then(notice => ({ kind: "notice" as const, notice })),
				done.then(result => ({ kind: "settled" as const, result })),
			]);
			expect(first.kind).toBe("notice");
			if (first.kind !== "notice") {
				throw new Error(`Expected approval prompt, got settled result: ${JSON.stringify(first.result)}`);
			}
			const requestId = /\/approve\s+([a-zA-Z0-9-]+)/.exec(first.notice.text)?.[1];
			expect(requestId).toBeDefined();
			if (!requestId) throw new Error("Missing requestId in approval notice");
			const decisionMessage = discordMessage(`/approve ${requestId}`, { messageId: `ctrl-${++controlSeq}` });
			expect(authority.decide(decisionMessage, requestId, "approve")).toContain("Exact action approved once");
			expect(await done).toEqual({ allowed: true });
		};

		return {
			root,
			workspace,
			siblingDir,
			outsideDir,
			sessionDir,
			config,
			authority,
			conversationKey,
			run,
			notificationCount: () => notificationCount,
			authorizeAttempt,
			approvePending,
			close() {
				authority.close();
			},
		};
	}

	test("readRoots allows read-only tools and read-only shell on siblingDir without approval while writes require approval and sessionDir is hard-denied", async () => {
		const f = await hostFixture({ includeSiblingReadRoot: true });
		try {
			const autoReadActions: DiscordHostAction[] = [
				{ kind: "tool", tool: "read", cwd: f.workspace, args: { path: path.join(f.siblingDir, "file.txt") } },
				{ kind: "tool", tool: "ls", cwd: f.workspace, args: { path: f.siblingDir } },
				{ kind: "tool", tool: "find", cwd: f.workspace, args: { globPattern: "../sibling/**/*.ts" } },
				{ kind: "tool", tool: "search", cwd: f.workspace, args: { path: f.siblingDir, pattern: "needle" } },
				{ kind: "tool", tool: "bash", cwd: f.workspace, args: { command: "cat ../sibling/file.txt" } },
				{ kind: "tool", tool: "bash", cwd: f.workspace, args: { command: "git -C ../sibling status" } },
			];

			for (const action of autoReadActions) {
				expect(await f.authorizeAttempt(action)).toEqual({ allowed: true });
			}
			expect(f.notificationCount()).toBe(0);

			// Writes and deletes on siblingDir still require one-use human approval.
			await f.approvePending({
				kind: "tool",
				tool: "write",
				cwd: f.workspace,
				args: { path: path.join(f.siblingDir, "new.txt"), content: "hi" },
			});
			await f.approvePending({
				kind: "tool",
				tool: "delete",
				cwd: f.workspace,
				args: { path: path.join(f.siblingDir, "file.txt") },
			});
			expect(f.notificationCount()).toBe(2);

			// Private sessionDir remains hard-denied without sending an approval notification.
			const denied = await f.authorizeAttempt({
				kind: "tool",
				tool: "read",
				cwd: f.workspace,
				args: { path: path.join(f.sessionDir, "secret.json") },
			});
			expect(denied.allowed).toBe(false);
			if (!denied.allowed) {
				expect(String(denied.error)).toMatch(/Private host configuration and credentials/);
			}
			expect(f.notificationCount()).toBe(2);
		} finally {
			f.close();
		}
	});

	test("readAccess: 'global' allows reading non-private outside paths while write/delete/sort -o still require approval and sessionDir is hard-denied", async () => {
		const f = await hostFixture({ readAccess: "global" });
		try {
			const autoReads: DiscordHostAction[] = [
				{ kind: "tool", tool: "read", cwd: f.workspace, args: { path: path.join(f.outsideDir, "outside.txt") } },
				{ kind: "tool", tool: "ls", cwd: f.workspace, args: { path: f.outsideDir } },
				{ kind: "tool", tool: "find", cwd: f.workspace, args: { globPattern: "../outside/**/*.ts" } },
				{ kind: "tool", tool: "search", cwd: f.workspace, args: { path: f.outsideDir, pattern: "needle" } },
				{ kind: "tool", tool: "bash", cwd: f.workspace, args: { command: "cat ../outside/outside.txt" } },
				{ kind: "tool", tool: "bash", cwd: f.workspace, args: { command: "git -C ../outside status" } },
			];
			for (const action of autoReads) {
				expect(await f.authorizeAttempt(action)).toEqual({ allowed: true });
			}
			expect(f.notificationCount()).toBe(0);

			await f.approvePending({
				kind: "tool",
				tool: "write",
				cwd: f.workspace,
				args: { path: path.join(f.outsideDir, "new.txt"), content: "blocked without approval" },
			});
			await f.approvePending({
				kind: "tool",
				tool: "delete",
				cwd: f.workspace,
				args: { path: path.join(f.outsideDir, "outside.txt") },
			});
			await f.approvePending({
				kind: "tool",
				tool: "bash",
				cwd: f.workspace,
				args: { command: "sort -o ../outside/sorted.txt input.txt" },
			});
			expect(f.notificationCount()).toBe(3);

			const denied = await f.authorizeAttempt({
				kind: "tool",
				tool: "read",
				cwd: f.workspace,
				args: { path: path.join(f.sessionDir, "secret.json") },
			});
			expect(denied.allowed).toBe(false);
			if (!denied.allowed) {
				expect(String(denied.error)).toMatch(/Private host configuration and credentials/);
			}
			expect(f.notificationCount()).toBe(3);
		} finally {
			f.close();
		}
	});

	test("grantReadRoot, revokeReadRoots, and readStatus dynamically grant/revoke ../sibling and 'global' and reject sessionDir", async () => {
		const f = await hostFixture();
		try {
			expect(f.authority.readStatus(f.conversationKey)).toEqual({
				readAccess: "workspace",
				readRoots: [],
			});

			// Baseline: sibling read triggers approval before grant.
			await f.approvePending({
				kind: "tool",
				tool: "read",
				cwd: f.workspace,
				args: { path: path.join(f.siblingDir, "file.txt") },
			});
			expect(f.notificationCount()).toBe(1);

			// Grant ../sibling dynamically.
			const afterSibling = f.authority.grantReadRoot(f.conversationKey, "../sibling", f.workspace);
			expect(afterSibling).toEqual({
				readAccess: "workspace",
				readRoots: [f.siblingDir],
			});
			expect(f.authority.readStatus(f.conversationKey)).toEqual(afterSibling);
			// Thread grant stays scoped to that conversationKey.
			expect(f.authority.readStatus()).toEqual({ readAccess: "workspace", readRoots: [] });

			expect(
				await f.authorizeAttempt({
					kind: "tool",
					tool: "read",
					cwd: f.workspace,
					args: { path: path.join(f.siblingDir, "file.txt") },
				}),
			).toEqual({ allowed: true });
			expect(
				await f.authorizeAttempt({
					kind: "tool",
					tool: "bash",
					cwd: f.workspace,
					args: { command: "git -C ../sibling status" },
				}),
			).toEqual({ allowed: true });
			expect(f.notificationCount()).toBe(1);

			// Grant "global" dynamically.
			const afterGlobal = f.authority.grantReadRoot(f.conversationKey, "global");
			expect(afterGlobal).toEqual({
				readAccess: "global",
				readRoots: [f.siblingDir],
			});
			expect(
				await f.authorizeAttempt({
					kind: "tool",
					tool: "read",
					cwd: f.workspace,
					args: { path: path.join(f.outsideDir, "outside.txt") },
				}),
			).toEqual({ allowed: true });
			expect(f.notificationCount()).toBe(1);

			// Revoke restores workspace-only read scope.
			const afterRevoke = f.authority.revokeReadRoots(f.conversationKey);
			expect(afterRevoke).toEqual({
				readAccess: "workspace",
				readRoots: [],
			});
			expect(f.authority.readStatus(f.conversationKey)).toEqual(afterRevoke);

			await f.approvePending({
				kind: "tool",
				tool: "read",
				cwd: f.workspace,
				args: { path: path.join(f.siblingDir, "file.txt") },
			});
			expect(f.notificationCount()).toBe(2);

			// Attempting to grant sessionDir (absolute or relative) throws.
			expect(() => f.authority.grantReadRoot(f.conversationKey, f.sessionDir, f.workspace)).toThrow(/cannot be granted as a read root/);
			expect(() => f.authority.grantReadRoot(f.conversationKey, "../sessions", f.workspace)).toThrow(/cannot be granted as a read root/);
		} finally {
			f.close();
		}
	});
});

describe("handleSandboxControl /sandbox grant", () => {
	test("verifies actor authority and creates + approves the ../sibling ro mount in one step", async () => {
		const root = await makeTempRoot("jeo-sandbox-grant-");
		const cwd = path.join(root, "workspace");
		const sibling = path.join(root, "sibling");
		const stateDirectory = path.join(root, "private-state");
		await Promise.all([fs.mkdir(cwd, { recursive: true }), fs.mkdir(sibling, { recursive: true })]);

		let appliedPolicy: SandboxPolicy | undefined;
		let transitions = 0;
		const authority = await createGrantAuthority({
			sessionKey: "discord-session-1",
			cwd,
			config: { backend: "native" },
			allowedUserIds: ["owner"],
			stateDirectory,
			supervisor: {
				toolMap: () => ({}),
				async call() {
					return { success: false, output: "" };
				},
				async exec() {
					return { success: false, output: "" };
				},
				async replacePolicy(next: SandboxPolicy) {
					appliedPolicy = next;
					transitions++;
				},
				async revoke() {
					return { gone: true, residual: [] };
				},
				async close() {},
			},
		});

		// Unauthorized actors must be rejected BEFORE any pending grant request is created.
		for (const badActor of [
			{ origin: "model" as const, sessionKey: "discord-session-1", userId: "owner" },
			{ origin: "discord" as const, sessionKey: "discord-session-1", userId: "stranger" },
			{ origin: "discord" as const, sessionKey: "other-session", userId: "owner" },
		]) {
			const denied = await handleSandboxControl("/sandbox grant ../sibling ro", badActor, authority);
			expect(denied.handled).toBe(true);
			expect(denied.output).toMatch(/UNAUTHORIZED|SESSION_MISMATCH/);
			expect(authority.snapshot().requests).toEqual([]);
			expect(authority.snapshot().grants).toEqual([]);
			expect(transitions).toBe(0);
		}

		// Authorized Discord actor grants ../sibling ro in a single control call.
		const actor = { origin: "discord" as const, sessionKey: "discord-session-1", userId: "owner" };
		const granted = await handleSandboxControl("/sandbox grant ../sibling ro", actor, authority);
		expect(granted.handled).toBe(true);
		expect(granted.output).toBe(`Sandbox grant approved (ro ${sibling}).`);
		expect(transitions).toBe(1);
		expect(authority.snapshot(actor).grants).toEqual([{ host: sibling, guest: sibling, mode: "ro" }]);
		expect(authority.snapshot(actor).requests.map(r => ({ host: r.host, mode: r.mode, status: r.status }))).toEqual([
			{ host: sibling, mode: "ro", status: "approved" },
		]);
		expect(appliedPolicy?.mounts.find(m => m.host === sibling)?.mode).toBe("ro");
	});
});

test.skipIf(process.platform !== "darwin")(
	"macOS Seatbelt with readOnlyRoots: [parentDir] allows reading siblingDir, denies writing siblingDir, and denies reading JEO_CONFIG_DIR",
	async () => {
		const root = await makeTempRoot("jeo-seatbelt-parent-");
		const parentDir = path.join(root, "parent");
		const workspace = path.join(parentDir, "workspace");
		const siblingDir = path.join(parentDir, "sibling");
		const privateConfigDir = path.join(root, "private-config");

		await Promise.all([
			fs.mkdir(workspace, { recursive: true }),
			fs.mkdir(siblingDir, { recursive: true }),
			fs.mkdir(privateConfigDir, { recursive: true }),
		]);
		await fs.writeFile(path.join(siblingDir, "file.txt"), "sibling-read-ok\n");
		await fs.writeFile(path.join(privateConfigDir, "secret.txt"), "PRIVATE-CONFIG-SECRET\n");

		const previousConfigDir = process.env.JEO_CONFIG_DIR;
		process.env.JEO_CONFIG_DIR = privateConfigDir;
		let supervisor: SandboxSupervisor | undefined;
		try {
			const policy = await createSandboxPolicy({
				sessionKey: "discord-seatbelt-read-perms",
				revision: 1,
				cwd: workspace,
				config: { backend: "native" },
			});
			supervisor = createSandboxSupervisor({ policy, readOnlyRoots: [parentDir] });

			// Reading siblingDir/file.txt succeeds under parentDir readOnlyRoot.
			const siblingRead = await supervisor.call("read", { filePath: path.join(siblingDir, "file.txt") }, { cwd: workspace });
			expect(siblingRead.success).toBe(true);
			expect(siblingRead.output).toContain("sibling-read-ok");

			// Writing inside workspace succeeds.
			const workspaceWrite = await supervisor.call(
				"write",
				{ filePath: path.join(workspace, "allowed.txt"), content: "workspace-ok\n" },
				{ cwd: workspace },
			);
			expect(workspaceWrite.success).toBe(true);
			expect(await fs.readFile(path.join(workspace, "allowed.txt"), "utf8")).toBe("workspace-ok\n");

			// Writing siblingDir/forbidden.txt fails and does not create the file.
			const forbiddenPath = path.join(siblingDir, "forbidden.txt");
			const siblingWrite = await supervisor.call("write", { filePath: forbiddenPath, content: "must-fail\n" }, { cwd: workspace });
			expect(siblingWrite.success).toBe(false);
			const siblingExecWrite = await supervisor.exec(["/bin/sh", "-c", `printf blocked > ${JSON.stringify(forbiddenPath)}`], { cwd: workspace });
			expect(siblingExecWrite.success).toBe(false);
			expect(await fs.stat(forbiddenPath).catch(() => undefined)).toBeUndefined();

			// Reading privateConfigDir/secret.txt fails and never exposes the secret.
			const secretPath = path.join(privateConfigDir, "secret.txt");
			const secretRead = await supervisor.call("read", { filePath: secretPath }, { cwd: workspace });
			expect(secretRead.success).toBe(false);
			expect(secretRead.output).not.toContain("PRIVATE-CONFIG-SECRET");
			const secretExecRead = await supervisor.exec(["/bin/cat", secretPath], { cwd: workspace });
			expect(secretExecRead.success).toBe(false);
			expect(secretExecRead.output).not.toContain("PRIVATE-CONFIG-SECRET");
		} finally {
			await supervisor?.close().catch(() => {});
			if (previousConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
			else process.env.JEO_CONFIG_DIR = previousConfigDir;
		}
	},
	30_000,
);
