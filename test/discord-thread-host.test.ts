import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMessengerCliReply } from "../src/commands/messenger";
import { parseMessengerConfig } from "../src/messenger/config";
import { createMessengerGateway, isMessengerMessageAllowed } from "../src/messenger/gateway";
import { isDiscordHostBootstrap, isDiscordHostTurn } from "../src/messenger/host-protocol";
import { isRecord } from "../src/messenger/types";
import type { MessengerAdapter, MessengerConfig, MessengerMessage, MessengerReply } from "../src/messenger/types";

const sandbox = { image: "local-test-image", limits: { memoryBytes: 268435456, pids: 32, cpus: 1 } };
const selectModel = async () => "fixture-model";

function threadMessage(threadId: string, messageId: string, text: string, senderId = "owner"): MessengerMessage {
	return { platform: "discord", accountId: "bot", guildId: "guild", channelId: threadId, parentChannelId: "channel", threadId, senderId, messageId, text, direct: false, mentioned: false };
}

function configInput(root: string) {
	return {
		cwd: path.join(root, "workspace"), sessionDir: path.join(root, "sessions"), toolNames: [], sandbox,
		platforms: { discord: { tokenEnv: "DISCORD_TEST_TOKEN", allowedUserIds: ["owner", "collaborator"], allowedChannelIds: ["channel"] } },
	};
}

// Exercise runtime behavior independently of the parser RED. No new production API or registry layout is assumed.
function hostConfig(root: string): MessengerConfig {
	const config = parseMessengerConfig(configInput(root), root);
	Object.assign(config.platforms.discord!, { workerMode: "host" });
	return config;
}

interface Workspace { root: string; cwd: string }
interface Launch { argv: string[]; cwd: string; env: Record<string, string>; prompts: string[] }
interface Turn { complete(): void }
interface ClosableReply extends MessengerReply { close(): Promise<void> }

async function workspace(): Promise<Workspace> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-discord-host-")));
	const cwd = path.join(root, "workspace");
	await fs.mkdir(cwd);
	return { root, cwd };
}

function git(cwd: string, ...args: string[]): string {
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
	const result = Bun.spawnSync(["git", ...args], {
		cwd, stdout: "pipe", stderr: "pipe",
		env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" },
	});
	if (result.exitCode !== 0) throw new Error(`Git fixture failed (${args.join(" ")}): ${result.stderr.toString()}`);
	return result.stdout.toString();
}

async function gitWorkspace(): Promise<Workspace> {
	const fixture = await workspace();
	git(fixture.cwd, "init", "-q", "-b", "source");
	git(fixture.cwd, "config", "user.name", "Discord Host Test");
	git(fixture.cwd, "config", "user.email", "discord-host@example.invalid");
	git(fixture.cwd, "config", "commit.gpgsign", "false");
	git(fixture.cwd, "config", "core.hooksPath", "/dev/null");
	await fs.writeFile(path.join(fixture.cwd, "shared.txt"), "committed base\n");
	git(fixture.cwd, "add", "shared.txt");
	git(fixture.cwd, "commit", "-qm", "fixture base");
	return fixture;
}

async function dirtySource(cwd: string) {
	await fs.writeFile(path.join(cwd, "shared.txt"), "staged source\n");
	git(cwd, "add", "shared.txt");
	await fs.writeFile(path.join(cwd, "shared.txt"), "unstaged source\n");
	await fs.writeFile(path.join(cwd, "untracked.bin"), new Uint8Array([0, 255, 13, 10, 42]));
}

async function sourceState(cwd: string) {
	return {
		status: git(cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"),
		branch: git(cwd, "symbolic-ref", "HEAD"),
		head: git(cwd, "rev-parse", "HEAD"),
		index: await fs.readFile(path.join(cwd, ".git", "index")),
		tracked: await fs.readFile(path.join(cwd, "shared.txt")),
		untracked: await fs.readFile(path.join(cwd, "untracked.bin")),
	};
}

function resumeId(launch: Launch): string {
	const index = launch.argv.indexOf("--resume");
	if (index < 0 || !launch.argv[index + 1]) throw new Error("Worker launch must resume its persisted conversation");
	return launch.argv[index + 1]!;
}

// Replace only the agent/provider process. Git, disk persistence, admission and routing remain real.
// Per-prompt barriers let interruption tests synchronize on accepted input, never on a wall-clock sleep.
// Host PIDs belong to tiny real sentinels, which exit naturally on stdin EOF. This permits
// ownership/restart checks without ever signalling this test process or claiming descendant cleanup.
// Receipts and acknowledgements below are fixture protocol responses, not operating-system proof.
function protocolWorkers(held: string[] = []) {
	const launches: Launch[] = [];
	const turns = new Map<string, Turn>();
	const waiting = new Map<string, { promise: Promise<Turn>; resolve(value: Turn): void }>();
	const spawn = ((argv: string[], options: { cwd: string; env: Record<string, string> }) => {
		const launch = { argv: [...argv], cwd: options.cwd, env: { ...options.env }, prompts: [] as string[] };
		launches.push(launch);
		const rawHost: unknown = options.env.JEO_MESSENGER_HOST_BOOTSTRAP ? JSON.parse(options.env.JEO_MESSENGER_HOST_BOOTSTRAP) : undefined;
		if (rawHost !== undefined && !isDiscordHostBootstrap(rawHost)) throw new Error("Invalid host bootstrap reached fixture");
		const host = isDiscordHostBootstrap(rawHost) ? rawHost : undefined;
		const sentinel = host ? Bun.spawn([process.execPath, "--no-env-file", "--eval", "await Bun.stdin.text();"], { stdin: "pipe", stdout: "ignore", stderr: "ignore", env: {} }) : undefined;
		const exited = Promise.withResolvers<number>();
		let out: ReadableStreamDefaultController<Uint8Array>;
		let err: ReadableStreamDefaultController<Uint8Array>;
		let stopped = false;
		const stdout = new ReadableStream<Uint8Array>({ start(controller) { out = controller; } });
		const stderr = new ReadableStream<Uint8Array>({ start(controller) { err = controller; } });
		let stopping: Promise<void> | undefined;
		const stop = () => stopping ??= (async () => {
			stopped = true;
			if (sentinel) { sentinel.stdin.end(); await sentinel.exited; }
			out.close(); err.close(); exited.resolve(143);
		})();
		return {
			pid: sentinel?.pid,
			stdout, stderr, exited: exited.promise,
			kill() { throw new Error("Protected fixture workers must never receive an OS signal"); },
			async send(frame: unknown) {
				const nonce = options.env.JEO_MESSENGER_SHUTDOWN_NONCE;
				if (!stopped && nonce && isRecord(frame) && frame.type === "jeo_messenger_shutdown" && frame.nonce === nonce && (!host || frame.epoch === host.scope.epoch)) {
					try {
						if (host) await fs.writeFile(host.cleanupReceipt, JSON.stringify({ version: 1, ...host.scope, pid: sentinel!.pid, nonce: host.nonce, gone: true }), { mode: 0o600 });
						err.enqueue(new TextEncoder().encode(`JEO_MESSENGER_SHUTDOWN_ACK ${JSON.stringify({ nonce, gone: true, ...(host ? { epoch: host.scope.epoch } : {}) })}\n`));
					} finally { await stop(); }
				}
				return true;
			},
			stdin: {
				write(chunk: string) {
					for (const line of chunk.trim().split("\n")) {
						const frame: unknown = JSON.parse(line);
						if (host ? !isDiscordHostTurn(frame) : typeof frame !== "string") throw new Error("Worker received the wrong prompt protocol");
						const prompt = isDiscordHostTurn(frame) ? frame.text : String(frame);
						launch.prompts.push(prompt);
						let complete = false;
						const turn = { complete() {
							if (complete || stopped) return;
							complete = true;
							out.enqueue(new TextEncoder().encode(`JEO_MESSENGER_RESULT ${JSON.stringify(`completed: ${prompt}`)}\n`));
						} };
						turns.set(prompt, turn);
						waiting.get(prompt)?.resolve(turn);
						if (!held.includes(prompt)) turn.complete();
					}
					return chunk.length;
				},
				flush() {}, end() {},
			},
		};
	}) as typeof Bun.spawn;
	return {
		spawn, launches,
		started(prompt: string): Promise<Turn> {
			const turn = turns.get(prompt);
			if (turn) return Promise.resolve(turn);
			let pending = waiting.get(prompt);
			if (!pending) { pending = Promise.withResolvers<Turn>(); waiting.set(prompt, pending); }
			return pending.promise;
		},
	};
}

function adapter(delivered: Array<[string, string]>, platform: MessengerAdapter["platform"] = "discord"): MessengerAdapter {
	return { platform, start: async () => {}, send: async (message, text) => { delivered.push([message.messageId, text]); } };
}

test("parsed Discord host opt-in selects host execution without widening authorized users or channels", async () => {
	const { root, cwd } = await gitWorkspace();
	let reply: ClosableReply | undefined;
	try {
		const input = configInput(root);
		const config = parseMessengerConfig({ ...input, platforms: { discord: { ...input.platforms.discord, workerMode: "host" } } }, root);
		expect(isMessengerMessageAllowed(threadMessage("thread-a", "1", "work"), config)).toBe(true);
		expect(isMessengerMessageAllowed(threadMessage("thread-a", "2", "work", "stranger"), config)).toBe(false);
		expect(isMessengerMessageAllowed({ ...threadMessage("thread-a", "3", "work"), parentChannelId: "unapproved" }, config)).toBe(false);
		const workers = protocolWorkers();
		reply = createMessengerCliReply(config, workers.spawn, selectModel);
		expect(await reply(threadMessage("thread-a", "4", "parsed host task"), new AbortController().signal)).toBe("completed: parsed host task");
		expect(workers.launches).toHaveLength(1);
		expect(workers.launches[0]!.cwd).not.toBe(cwd);
		expect(workers.launches[0]!.env.JEO_MESSENGER_SANDBOX).toBeUndefined();
	} finally { await reply?.close(); await fs.rm(root, { recursive: true, force: true }); }
});

for (const platform of ["telegram", "slack"] as const) test(`${platform} cannot opt itself into Discord host execution`, () => {
	expect(() => parseMessengerConfig({ ...configInput("/tmp/host-platform"), platforms: { [platform]: { allowedUserIds: ["owner"], workerMode: "host" } } }, "/tmp/host-platform")).toThrow();
});

test("legacy Discord without the opt-in still answers in its configured sandbox without creating a worktree", async () => {
	const { root, cwd } = await workspace();
	const config = parseMessengerConfig(configInput(root), root);
	const workers = protocolWorkers();
	const reply = createMessengerCliReply(config, workers.spawn, selectModel);
	try {
		expect(await reply(threadMessage("legacy", "1", "legacy task"), new AbortController().signal)).toBe("completed: legacy task");
		expect(workers.launches.map(launch => launch.cwd)).toEqual([cwd]);
		expect(JSON.parse(workers.launches[0]!.env.JEO_MESSENGER_SANDBOX!)).toEqual(sandbox);
		expect(await fs.readdir(cwd)).toEqual([]);
	} finally { await reply.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("Discord host opt-in does not change Telegram or Slack execution in the same configuration", async () => {
	const { root, cwd } = await workspace();
	const config = hostConfig(root);
	for (const platform of ["telegram", "slack"] as const) config.platforms[platform] = { tokenEnv: `${platform.toUpperCase()}_TEST_TOKEN`, allowedUserIds: ["owner"] };
	const workers = protocolWorkers();
	const reply = createMessengerCliReply(config, workers.spawn, selectModel);
	try {
		for (const platform of ["telegram", "slack"] as const) {
			const message = { ...threadMessage(platform, platform, platform), platform, direct: true };
			expect(await reply(message, new AbortController().signal)).toBe(`completed: ${platform}`);
		}
		expect(workers.launches.map(launch => launch.cwd)).toEqual([cwd, cwd]);
		for (const launch of workers.launches) expect(JSON.parse(launch.env.JEO_MESSENGER_SANDBOX!)).toEqual(sandbox);
		expect(await fs.readdir(cwd)).toEqual([]);
	} finally { await reply.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("authorized Discord threads use distinct linked worktrees, branches and sessions without changing dirty source bytes", async () => {
	const { root, cwd } = await gitWorkspace();
	await dirtySource(cwd);
	const before = await sourceState(cwd);
	const config = hostConfig(root);
	const workers = protocolWorkers();
	const reply = createMessengerCliReply(config, workers.spawn, selectModel);
	const delivered: Array<[string, string]> = [];
	const gateway = createMessengerGateway(config, [adapter(delivered)], reply, { concurrency: 2 });
	try {
		await gateway.handle(threadMessage("thread-a", "denied", "unauthorized", "stranger"));
		expect(workers.launches).toHaveLength(0);
		await Promise.all([
			gateway.handle(threadMessage("thread-a", "1", "task a")),
			gateway.handle(threadMessage("thread-b", "2", "task b", "collaborator")),
		]);
		expect(delivered.sort(([a], [b]) => a.localeCompare(b))).toEqual([["1", "completed: task a"], ["2", "completed: task b"]]);
		expect(workers.launches).toHaveLength(2);
		const [a, b] = workers.launches as [Launch, Launch];
		expect(a.cwd).not.toBe(cwd);
		expect(b.cwd).not.toBe(cwd);
		expect(a.cwd).not.toBe(b.cwd);
		expect(resumeId(a)).not.toBe(resumeId(b));
		const branches = [git(a.cwd, "symbolic-ref", "HEAD"), git(b.cwd, "symbolic-ref", "HEAD")];
		expect(branches[0]).not.toBe(branches[1]);
		for (const branch of branches) expect(branch).not.toBe(before.branch);
		for (const launch of [a, b]) {
			expect(git(launch.cwd, "rev-parse", "--git-common-dir").trim()).toBe(path.join(cwd, ".git"));
			expect(git(launch.cwd, "rev-parse", "HEAD")).toBe(before.head);
			expect(await fs.readFile(path.join(launch.cwd, "shared.txt"), "utf8")).toBe("committed base\n");
			expect(launch.env.JEO_MESSENGER_SANDBOX).toBeUndefined();
		}
		await fs.writeFile(path.join(a.cwd, "shared.txt"), "thread a change\n");
		expect(await fs.readFile(path.join(b.cwd, "shared.txt"), "utf8")).toBe("committed base\n");
		await gateway.handle(threadMessage("thread-a", "3", "follow up", "collaborator"));
		expect(delivered).toContainEqual(["3", "completed: follow up"]);
		expect(workers.launches).toHaveLength(2);
		expect(workers.launches.find(launch => launch.prompts.includes("task a"))!.prompts).toEqual(["task a", "follow up"]);
		expect(await sourceState(cwd)).toEqual(before);
		await reply.close();
		for (const launch of [a, b]) expect(git(cwd, "worktree", "list", "--porcelain")).toContain(`worktree ${launch.cwd}\n`);
	} finally { await reply.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("non-Git host source refuses before launching or copying and tells the Discord user to select a Git project", async () => {
	const { root, cwd } = await workspace();
	const content = new Uint8Array([0, 255, 10, 13]);
	await fs.writeFile(path.join(cwd, "keep.bin"), content);
	const config = hostConfig(root);
	const workers = protocolWorkers();
	const reply = createMessengerCliReply(config, workers.spawn, selectModel);
	const delivered: Array<[string, string]> = [];
	const gateway = createMessengerGateway(config, [adapter(delivered)], reply);
	try {
		await gateway.handle(threadMessage("thread-a", "1", "change code"));
		expect(workers.launches).toHaveLength(0);
		expect(await fs.readdir(cwd)).toEqual(["keep.bin"]);
		expect(await fs.readFile(path.join(cwd, "keep.bin"))).toEqual(Buffer.from(content));
		expect(delivered).toHaveLength(1);
		expect(delivered[0]![1]).toMatch(/git/i);
		expect(delivered[0]![1]).toMatch(/select|choose|configure|설정|선택/i);
	} finally { await reply.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("restart preserves a thread session and edited worktree while interrupted message redelivery never reruns it", async () => {
	const { root, cwd } = await gitWorkspace();
	const firstWorkers = protocolWorkers(["interrupted task"]);
	const first = createMessengerCliReply(hostConfig(root), firstWorkers.spawn, selectModel);
	let second: ClosableReply | undefined;
	const controller = new AbortController();
	const interrupted = threadMessage("thread-a", "1", "interrupted task");
	const pending = first(interrupted, controller.signal).then(value => ({ value }), error => ({ error }));
	try {
		await Promise.race([
			firstWorkers.started("interrupted task"),
			pending.then(outcome => { throw new Error(`Turn settled before reaching the provider boundary: ${JSON.stringify(outcome)}`); }),
		]);
		const original = firstWorkers.launches[0]!;
		const originalBranch = git(original.cwd, "symbolic-ref", "HEAD");
		await fs.writeFile(path.join(original.cwd, "retained.txt"), "unfinished thread work\n");
		controller.abort();
		expect(await pending).toHaveProperty("error");
		await first.close();
		const resumedWorkers = protocolWorkers();
		second = createMessengerCliReply(hostConfig(root), resumedWorkers.spawn, selectModel);
		const delivered: Array<[string, string]> = [];
		const gateway = createMessengerGateway(hostConfig(root), [adapter(delivered)], second);
		await gateway.handle(threadMessage("thread-a", "ignored", "not authorized", "stranger"));
		expect(resumedWorkers.launches).toHaveLength(0);
		await gateway.handle(interrupted);
		expect(resumedWorkers.launches).toHaveLength(0);
		await gateway.handle(threadMessage("thread-a", "2", "continue safely", "collaborator"));
		expect(resumedWorkers.launches).toHaveLength(1);
		const resumed = resumedWorkers.launches[0]!;
		expect(resumeId(resumed)).toBe(resumeId(original));
		expect(resumed.cwd).toBe(original.cwd);
		expect(resumed.cwd).not.toBe(cwd);
		expect(git(resumed.cwd, "symbolic-ref", "HEAD")).toBe(originalBranch);
		expect(await fs.readFile(path.join(resumed.cwd, "retained.txt"), "utf8")).toBe("unfinished thread work\n");
		expect(resumed.prompts).toEqual(["continue safely"]);
		expect(delivered).toContainEqual(["2", "completed: continue safely"]);
	} finally {
		controller.abort(); await pending; await first.close(); await second?.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});
