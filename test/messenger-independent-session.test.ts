import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMessengerCliReply } from "../src/commands/messenger";
import { parseMessengerConfig } from "../src/messenger/config";
import { createDiscordAdapter } from "../src/messenger/discord";
import { createMessengerGateway, messengerSessionRoute } from "../src/messenger/gateway";
import { createMessengerSessionPool } from "../src/messenger/session-pool";
import { selectDiscordModel } from "../src/messenger/model-selection";
import type { ProviderModelsResult } from "../src/ai/model-discovery";
import type { MessengerAdapter, MessengerConfig, MessengerMessage } from "../src/messenger/types";
import { SessionNotifyEndpoint } from "../src/agent/notify/session-endpoint";
import { createGrantAuthority } from "../src/agent/sandbox/authority";
import { handleSandboxControl } from "../src/agent/sandbox/control";
import type { SandboxSupervisor } from "../src/agent/sandbox/types";

const baseMessage: MessengerMessage = {
	platform: "discord",
	accountId: "bot",
	channelId: "channel-1",
	senderId: "user-1",
	messageId: "msg-1",
	text: "hello first",
	direct: false,
	mentioned: true,
};

const selectModel: typeof selectDiscordModel = (explicit, opts) => selectDiscordModel(explicit, {
	...opts,
	config: { providers: {}, defaultModel: "gpt-6.1-terra", thinkingLevel: "medium" },
	list: async (provider: ProviderModelsResult["provider"]) => ({ provider, ok: true, source: "oauth", models: provider === "openai" ? ["gpt-6.1-terra"] : [] }),
});

function threadMessage(threadId: string, messageId: string, text: string, senderId = "user-1"): MessengerMessage {
	return { ...baseMessage, guildId: "guild", channelId: threadId, parentChannelId: "channel-1", threadId, messageId, text, senderId };
}

function sessionConfig(root: string): MessengerConfig {
	return parseMessengerConfig({
		cwd: path.join(root, "workspace"), sessionDir: path.join(root, "private-sessions"), toolNames: [],
		sandbox: { image: "local-test-image", limits: { memoryBytes: 268435456, pids: 32, cpus: 1 } },
		platforms: { discord: { allowedUserIds: ["user-1", "user-2"], allowedChannelIds: ["channel-1"] } },
	}, root);
}

interface ControlledTurn {
	complete(): void;
	fail(): void;
}

// A real protocol boundary, with completed conversation history visible in replies.
// Holding a result lets tests order events without sleeping or patching the clock.
function controlledWorkers(heldPrompts: string[] = []) {
	const turns = new Map<string, ControlledTurn>();
	const waiting = new Map<string, { promise: Promise<ControlledTurn>; resolve(value: ControlledTurn): void }>();
	let workerCount = 0;
	const spawn = ((_argv: string[], options: { env: Record<string, string> }) => {
		// Only sandbox-cleanup pools (createMessengerCliReply) supply a nonce; a plain pool expects no acknowledgement.
		const nonce = options.env.JEO_MESSENGER_SHUTDOWN_NONCE;
		const id = workerCount++;
		const history: string[] = [];
		const exit = Promise.withResolvers<number>();
		let stopped = false;
		let out: ReadableStreamDefaultController<Uint8Array>;
		let err: ReadableStreamDefaultController<Uint8Array>;
		const stdout = new ReadableStream<Uint8Array>({ start(controller) { out = controller; } });
		const stderr = new ReadableStream<Uint8Array>({ start(controller) { err = controller; } });
		// Graceful stop only through the exact private IPC frame with the parent's nonce (protected pools).
		const send = (frame: unknown) => {
			const f = frame as { type?: unknown; nonce?: unknown } | null;
			if (!nonce || !f || Object.keys(f).sort().join() !== "nonce,type" || f.type !== "jeo_messenger_shutdown" || f.nonce !== nonce) return true;
			if (stopped) return true;
			stopped = true;
			err.enqueue(new TextEncoder().encode(`JEO_MESSENGER_SHUTDOWN_ACK ${JSON.stringify({ nonce, gone: true })}\n`));
			out.close(); err.close(); exit.resolve(143);
			return true;
		};
		// A signal is an actual crash: no acknowledgement.
		const kill = () => {
			if (stopped) return;
			stopped = true;
			out.close(); err.close(); exit.resolve(143);
		};
		return {
			stdout, stderr, exited: exit.promise, kill, ...(nonce ? { send } : {}),
			stdin: {
				write(chunk: string) {
					for (const line of chunk.trim().split("\n")) {
						const prompt: string = JSON.parse(line);
						const context = [...history, prompt];
						let settled = false;
						const turn: ControlledTurn = {
							complete() {
								if (settled || stopped) return;
								settled = true;
								history.push(prompt);
								out.enqueue(new TextEncoder().encode(`JEO_MESSENGER_RESULT ${JSON.stringify(`worker ${id}: ${context.join(" -> ")}`)}\n`));
							},
							fail() {
								if (settled || stopped) return;
								settled = true;
								out.enqueue(new TextEncoder().encode("JEO_MESSENGER_ERROR\n"));
							},
						};
						turns.set(prompt, turn);
						waiting.get(prompt)?.resolve(turn);
						if (!heldPrompts.includes(prompt)) turn.complete();
					}
					return chunk.length;
				},
				flush() {}, end() {},
			},
		};
	}) as typeof Bun.spawn;
	return {
		spawn,
		started(prompt: string): Promise<ControlledTurn> {
			const turn = turns.get(prompt);
			if (turn) return Promise.resolve(turn);
			let pending = waiting.get(prompt);
			if (!pending) { pending = Promise.withResolvers<ControlledTurn>(); waiting.set(prompt, pending); }
			return pending.promise;
		},
		completeAll() { for (const turn of turns.values()) turn.complete(); },
	};
}

function recordingAdapter(delivered: Array<[string, string]>): MessengerAdapter {
	return { platform: "discord", start: async () => {}, send: async (message, text) => { delivered.push([message.messageId, text]); } };
}

test("persistent sessions retain same-thread conversation across different message IDs", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-independent-test-"));
	await fs.mkdir(path.join(root, "workspace"));
	const workers = controlledWorkers();
	const reply = createMessengerCliReply(sessionConfig(root), workers.spawn, selectModel);
	try {
		const signal = new AbortController().signal;
		expect(await reply(threadMessage("thread-a", "msg-1", "remember amber"), signal)).toBe("worker 0: remember amber");
		expect(await reply(threadMessage("thread-a", "msg-2", "recall color"), signal)).toBe("worker 0: remember amber -> recall color");
		expect(await reply(threadMessage("thread-b", "msg-3", "other task"), signal)).toBe("worker 1: other task");
	} finally { await reply.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("session routing preserves shared thread continuity and isolates distinct threads", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-session-routing-"));
	await fs.mkdir(path.join(root, "workspace"));
	const workers = controlledWorkers();
	const reply = createMessengerCliReply(sessionConfig(root), workers.spawn, selectModel);
	try {
		const signal = new AbortController().signal;
		expect(await reply(threadMessage("thread-a", "1", "first"), signal)).toBe("worker 0: first");
		expect(await reply(threadMessage("thread-a", "2", "second"), signal)).toBe("worker 0: first -> second");
		expect(await reply(threadMessage("thread-a", "3", "collaborator", "user-2"), signal)).toBe("worker 0: first -> second -> collaborator");
		expect(await reply(threadMessage("thread-b", "4", "separate task"), signal)).toBe("worker 1: separate task");
	} finally { await reply.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("gateway serializes authorized authors into one shared thread history", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-thread-authors-"));
	const config = sessionConfig(root);
	await fs.mkdir(config.cwd);
	const workers = controlledWorkers(["first"]);
	const reply = createMessengerCliReply(config, workers.spawn, selectModel);
	const delivered: Array<[string, string]> = [];
	const gateway = createMessengerGateway(config, [recordingAdapter(delivered)], reply, { concurrency: 3 });
	const pending: Promise<void>[] = [];
	try {
		pending.push(gateway.handle(threadMessage("thread-a", "1", "first")));
		const first = await workers.started("first");
		pending.push(gateway.handle(threadMessage("thread-a", "2", "second", "user-2")));
		pending.push(gateway.handle(threadMessage("thread-a", "3", "third")));
		first.complete();
		await Promise.all(pending);
		expect(delivered.sort(([a], [b]) => a.localeCompare(b))).toEqual([
			["1", "worker 0: first"],
			["2", "worker 0: first -> second"],
			["3", "worker 0: first -> second -> third"],
		]);
	} finally { workers.completeAll(); await reply.close(); await Promise.allSettled(pending); await fs.rm(root, { recursive: true, force: true }); }
});

test("authenticated thread controls reach the live session endpoint while its model reply is busy", async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-live-control-")));
	const cwd = path.join(root, "workspace");
	const resource = path.join(root, "approved-resource");
	await Promise.all([fs.mkdir(cwd), fs.mkdir(resource)]);
	const previousConfig = process.env.JEO_CONFIG_DIR;
	process.env.JEO_CONFIG_DIR = path.join(root, "configuration");
	const config = sessionConfig(root);
	const message = threadMessage("thread-a", "busy", "held prompt");
	const digest = messengerSessionRoute(cwd, message);
	const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
	const endpoint = new SessionNotifyEndpoint(cwd, id);
	let replacements = 0;
	let revocations = 0;
	const supervisor: SandboxSupervisor = {
		toolMap() { return {}; }, async call() { throw new Error("Unexpected effect"); }, async exec() { throw new Error("Unexpected exec"); },
		async replacePolicy() { replacements++; }, async revoke() { revocations++; return { gone: true, residual: [] }; }, async close() {},
	};
	const authority = await createGrantAuthority({ sessionKey: id, cwd, config: config.sandbox!, supervisor, allowedUserIds: ["user-1", "user-2"], stateDirectory: path.join(root, "private-state") });
	endpoint.onSandboxControl = (text, actor) => handleSandboxControl(text, actor, authority);
	const workers = controlledWorkers(["held prompt"]);
	const reply = createMessengerCliReply(config, workers.spawn, selectModel);
	const delivered: Array<[string, string]> = [];
	const gateway = createMessengerGateway(config, [recordingAdapter(delivered)], reply, { concurrency: 1, sandboxControl: reply.sandboxControl });
	const pending: Promise<void>[] = [];
	try {
		await endpoint.start();
		endpoint.setDiscordControlEnabled(false);
		const request = await authority.requestAccess(resource, "rw");
		pending.push(gateway.handle(message));
		const held = await workers.started("held prompt");
		pending.push(gateway.handle(threadMessage("thread-a", "follow-up", "queued prompt")));
		await gateway.handle(threadMessage("thread-a", "intruder", `/sandbox approve ${request.id}`, "outsider"));
		expect(authority.snapshot().requests[0]?.status).toBe("pending");
		await gateway.handle(threadMessage("thread-a", "disabled", `/sandbox approve ${request.id}`, "user-2"));
		expect(authority.snapshot().requests[0]?.status).toBe("pending");
		expect(replacements).toBe(0);
		expect(delivered).toEqual([["disabled", "Discord sandbox control is disabled"]]);
		endpoint.setDiscordControlEnabled(true);
		await gateway.handle(threadMessage("thread-a", "approve", `/sandbox approve ${request.id}`, "user-2"));
		expect(authority.snapshot().grants.map(mount => ({ host: mount.host, mode: mount.mode }))).toEqual([{ host: resource, mode: "rw" }]);
		expect(replacements).toBe(1);
		expect(delivered.map(([messageId]) => messageId)).toEqual(["disabled", "approve"]);
		await gateway.handle(threadMessage("thread-a", "revoke", "/sandbox revoke"));
		expect(authority.snapshot().grants).toEqual([]);
		expect(revocations).toBe(1);
		expect(delivered.map(([messageId]) => messageId)).toEqual(["disabled", "approve", "revoke"]);
		held.complete();
		await Promise.all(pending);
		expect(delivered.slice(3)).toEqual([["busy", "worker 0: held prompt"], ["follow-up", "worker 0: held prompt -> queued prompt"]]);
	} finally {
		workers.completeAll(); await reply.close(); await Promise.allSettled(pending); await endpoint.stop();
		if (previousConfig === undefined) delete process.env.JEO_CONFIG_DIR; else process.env.JEO_CONFIG_DIR = previousConfig;
		await fs.rm(root, { recursive: true, force: true });
	}
});

for (const outcome of ["failure", "abort"] as const) test(`gateway runs distinct threads simultaneously and isolates worker ${outcome}`, async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-thread-isolation-"));
	const config = sessionConfig(root);
	await fs.mkdir(config.cwd);
	const workers = controlledWorkers(["task A", "task B"]);
	const reply = createMessengerCliReply(config, workers.spawn, selectModel);
	const delivered: Array<[string, string]> = [];
	const gateway = createMessengerGateway(config, [recordingAdapter(delivered)], reply, { concurrency: 2 });
	const controller = new AbortController();
	const pending: Promise<void>[] = [];
	try {
		pending.push(gateway.handle(threadMessage("thread-a", "A", "task A"), controller.signal));
		const first = await workers.started("task A");
		pending.push(gateway.handle(threadMessage("thread-b", "B", "task B")));
		const second = await workers.started("task B");
		if (outcome === "abort") controller.abort(); else first.fail();
		await pending[0];
		second.complete();
		await pending[1];
		expect(delivered.filter(([id]) => id === "B")).toEqual([["B", "worker 1: task B"]]);
		if (outcome === "abort") expect(delivered.filter(([id]) => id === "A")).toEqual([]);
	} finally { workers.completeAll(); await reply.close(); await Promise.allSettled(pending); await fs.rm(root, { recursive: true, force: true }); }
});

test("gateway delivers queued follow-ups only after the current reply completes, preserving arrival order", async () => {
	const config = sessionConfig("/workspace");
	const deliveryStarted = Promise.withResolvers<void>();
	const releaseDelivery = Promise.withResolvers<void>();
	const events: string[] = [];
	const adapter: MessengerAdapter = {
		platform: "discord", start: async () => {},
		send: async (message, text) => {
			if (message.threadId !== "thread-a") return;
			if (message.messageId === "1") { deliveryStarted.resolve(); await releaseDelivery.promise; }
			events.push(`delivered:${text}`);
		},
	};
	const gateway = createMessengerGateway(config, [adapter], async message => {
		if (message.threadId !== "thread-a") return "probe";
		events.push(`started:${message.messageId}`);
		return message.text;
	}, { concurrency: 3 });
	const pending = [gateway.handle(threadMessage("thread-a", "1", "first"))];
	try {
		await deliveryStarted.promise;
		pending.push(gateway.handle(threadMessage("thread-a", "2", "second")));
		pending.push(gateway.handle(threadMessage("thread-a", "3", "third")));
		// A separate thread is a progress barrier: queued same-thread work must
		// remain blocked even while another lane runs and delivers successfully.
		await gateway.handle(threadMessage("thread-probe", "probe", "probe"));
		releaseDelivery.resolve();
		await Promise.all(pending);
		expect(events).toEqual(["started:1", "delivered:first", "started:2", "delivered:second", "started:3", "delivered:third"]);
	} finally { releaseDelivery.resolve(); await Promise.allSettled(pending); }
});

test("gateway preserves raw-thread arrival order across asynchronous preparation without blocking other threads", async () => {
	const config = sessionConfig("/workspace");
	// Existing-thread events can arrive before the adapter has resolved their
	// parent/thread metadata; an unrestricted channel list admits these mentions.
	config.platforms.discord!.allowedChannelIds = undefined;
	const firstPreparing = Promise.withResolvers<void>();
	const releaseFirstPreparation = Promise.withResolvers<void>();
	const delivered: Array<[string, string]> = [];
	const histories = new Map<string, string[]>();
	const adapter: MessengerAdapter = {
		...recordingAdapter(delivered),
		prepare: async message => {
			if (message.messageId === "1") {
				firstPreparing.resolve();
				await releaseFirstPreparation.promise;
			}
			return threadMessage(message.channelId, message.messageId, message.text, message.senderId);
		},
	};
	const gateway = createMessengerGateway(config, [adapter], async message => {
		const key = message.threadId!;
		const history = histories.get(key) ?? [];
		history.push(message.text);
		histories.set(key, history);
		return history.join(" -> ");
	}, { concurrency: 3 });
	const firstRaw = { ...baseMessage, channelId: "thread-a", messageId: "1", text: "first" };
	const pending = [gateway.handle(firstRaw)];
	try {
		await firstPreparing.promise;
		pending.push(gateway.handle({ ...firstRaw, messageId: "2", text: "second" }));
		pending.push(gateway.handle({ ...firstRaw, senderId: "user-2", messageId: "other", text: "collaborator" }));
		// This delivery is a progress barrier, not a delay: an unrelated resolved
		// thread must finish even while the earlier raw-thread lookup is held.
		await gateway.handle(threadMessage("thread-b", "probe", "unrelated"));
		const deliveredWhileFirstLookupHeld = [...delivered];
		releaseFirstPreparation.resolve();
		await Promise.all(pending);
		expect(deliveredWhileFirstLookupHeld).toEqual([["probe", "unrelated"]]);
		expect(delivered.filter(([id]) => id !== "probe")).toEqual([["1", "first"], ["2", "first -> second"], ["other", "first -> second -> collaborator"]]);
	} finally { releaseFirstPreparation.resolve(); await Promise.allSettled(pending); }
});

test("gateway waits for pool capacity instead of turning a queued thread into a request failure", async () => {
	const config = sessionConfig("/workspace");
	const workers = controlledWorkers(["task A"]);
	const pool = createMessengerSessionPool(workers.spawn, 1);
	const delivered: Array<[string, string]> = [];
	const secondAttempted = Promise.withResolvers<void>();
	const gateway = createMessengerGateway(config, [recordingAdapter(delivered)], (message, signal) => {
		const turn = pool.turn(message.threadId!, ["fake-worker"], config.cwd, {}, message.text, signal);
		if (message.messageId === "B") secondAttempted.resolve();
		return turn;
	}, { concurrency: 2 });
	const pending: Promise<void>[] = [];
	try {
		pending.push(gateway.handle(threadMessage("thread-a", "A", "task A")));
		const first = await workers.started("task A");
		pending.push(gateway.handle(threadMessage("thread-b", "B", "task B")));
		await secondAttempted.promise;
		first.complete();
		await Promise.all(pending);
		expect(Object.fromEntries(delivered)).toEqual({ A: "worker 0: task A", B: "worker 1: task B" });
	} finally { workers.completeAll(); await pool.close(); await Promise.allSettled(pending); }
});

test("Discord activity updates progress and marks complete on finish without deleting the message", async () => {
	const requests: { method: string; url: string; body?: unknown }[] = [];
	const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const urlStr = url.toString();
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(init.body as string) : undefined;
		requests.push({ method, url: urlStr, body });
		if (method === "POST") return Response.json({ id: "activity-msg-123" });
		return Response.json({ id: "activity-msg-123" });
	}) as typeof fetch;

	const adapter = createDiscordAdapter(
		{ tokenEnv: "JEO_DISCORD_BOT_TOKEN", allowedUserIds: ["user-1"] },
		{ JEO_DISCORD_BOT_TOKEN: "secret-token" },
		{ fetch: fakeFetch },
	);

	const signal = new AbortController().signal;
	await adapter.activity!(baseMessage, "Processing step 1", signal);
	expect(requests[0]!.method).toBe("POST");
	expect(requests[0]!.body).toMatchObject({ content: "⏳ Processing step 1", allowed_mentions: { parse: [] } });

	await adapter.activity!(baseMessage, "Using computer tool", signal);
	expect(requests[1]!.method).toBe("PATCH");
	expect(requests[1]!.body).toMatchObject({ content: "⏳ Using computer tool" });

	// When completed (text === undefined)
	await adapter.activity!(baseMessage, undefined, signal);
	expect(requests[2]!.method).toBe("PATCH");
	expect(requests[2]!.body).toMatchObject({ content: "✅ Complete" });
	// Must NOT delete!
	expect(requests.some(r => r.method === "DELETE")).toBe(false);
});

test("Discord displays only the latest progress and marks a failed request", async () => {
	const contents: string[] = [];
	const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
		contents.push(JSON.parse(init!.body as string).content);
		return Response.json({ id: "status" });
	}) as typeof fetch;
	const adapter = createDiscordAdapter({ tokenEnv: "TOKEN", allowedUserIds: ["user-1"] }, { TOKEN: "secret" }, { fetch: fetcher });
	for (let i = 1; i <= 8; i++) await adapter.activity!(baseMessage, `Step ${i}`, undefined);
	await adapter.activity!(baseMessage, undefined, undefined, "failure");
	expect(contents.slice(0, 8)).toEqual(Array.from({ length: 8 }, (_, i) => `⏳ Step ${i + 1}`));
	expect(contents.at(-1)).toBe("❌ Failed");
	await adapter.activity!(baseMessage, "First\nSecond", undefined);
	expect(contents.at(-1)).toBe("⏳ First Second");
	await adapter.activity!(baseMessage, undefined, undefined, "cancelled");
	expect(contents.at(-1)).toBe("⏹ Cancelled");
});