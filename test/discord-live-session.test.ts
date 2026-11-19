import { afterEach, describe, expect, test } from "bun:test";
import { watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { LiveDiscordHost } from "../src/messenger/live-session";
import { createLiveDiscordBridge, loadAndCreateLiveDiscordBridge } from "../src/messenger/live-session";
import { defaultDiscordConfigPath, setupDiscordMessenger } from "../src/messenger/discord-setup";
import { createMessengerGateway } from "../src/messenger/gateway";
import type { DiscordSetupDeps, DiscordSetupIO } from "../src/messenger/discord-setup";
import type { MessengerAdapter, MessengerConfig, MessengerMessage } from "../src/messenger/types";

const CLI = path.resolve(import.meta.dir, "../src/cli.ts");
const GUARDIAN = path.resolve(import.meta.dir, "fixtures/sandbox-terminal-guardian.ts");
const MESSENGER_CMD_PATH = path.resolve(import.meta.dir, "../src/commands/messenger.ts");

const USER_ID = "222222222222222222";
const OTHER_USER_ID = "333333333333333333";
const CHANNEL_1 = "111111111111111111";
const CHANNEL_2 = "444444444444444444";
const UNLISTED_CHANNEL = "999999999999999999";

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function makeTempRoot(prefix: string): Promise<string> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
	tempRoots.push(root);
	return root;
}

function makeConfig(overrides: Partial<MessengerConfig> = {}): MessengerConfig {
	return {
		cwd: "/tmp/jeo-live-cwd",
		sessionDir: "/tmp/jeo-live-sessions",
		toolNames: [],
		platforms: {
			discord: {
				tokenEnv: "JEO_DISCORD_BOT_TOKEN",
				allowedUserIds: [USER_ID],
				allowedChannelIds: [CHANNEL_1, CHANNEL_2],
			},
		},
		...overrides,
	};
}

function makeMessage(overrides: Partial<MessengerMessage> = {}): MessengerMessage {
	return {
		platform: "discord",
		accountId: "bot-1",
		guildId: "guild-1",
		channelId: CHANNEL_1,
		senderId: USER_ID,
		messageId: "msg-1",
		text: "hello live session",
		direct: false,
		mentioned: true,
		...overrides,
	};
}

interface FakeAdapterHarness {
	adapter: MessengerAdapter;
	sent: Array<{ channelId: string; threadId?: string; messageId: string; text: string }>;
	activities: Array<{ channelId: string; text: string | undefined; outcome?: string }>;
	statuses: Array<{ messageId: string; status: string }>;
	emit(message: MessengerMessage): Promise<void>;
	waitReady(): Promise<void>;
	setSendError(error: Error | undefined): void;
}

function createFakeAdapterHarness(): FakeAdapterHarness {
	const ready = Promise.withResolvers<void>();
	let onMessageCb: ((message: MessengerMessage) => Promise<void>) | undefined;
	let sendError: Error | undefined;
	const sent: FakeAdapterHarness["sent"] = [];
	const activities: FakeAdapterHarness["activities"] = [];
	const statuses: FakeAdapterHarness["statuses"] = [];

	const adapter: MessengerAdapter = {
		platform: "discord",
		async start(onMessage, signal) {
			onMessageCb = onMessage;
			ready.resolve();
			const stopped = Promise.withResolvers<void>();
			if (signal.aborted) {
				stopped.resolve();
			} else {
				signal.addEventListener("abort", () => stopped.resolve(), { once: true });
			}
			await stopped.promise;
		},
		async send(message, text, signal) {
			signal?.throwIfAborted();
			if (sendError) throw sendError;
			sent.push({
				channelId: message.channelId,
				threadId: message.threadId,
				messageId: message.messageId,
				text,
			});
		},
		async status(message, status, signal) {
			signal?.throwIfAborted();
			statuses.push({ messageId: message.messageId, status });
		},
		async activity(message, text, signal, outcome) {
			if (text !== undefined) signal?.throwIfAborted();
			activities.push({ channelId: message.threadId ?? message.channelId, text, outcome });
		},
	};

	return {
		adapter,
		sent,
		activities,
		statuses,
		async emit(message) {
			await ready.promise;
			await onMessageCb!(message);
		},
		waitReady: () => ready.promise,
		setSendError(error) {
			sendError = error;
		},
	};
}

function createHostHarness(overrides: Partial<LiveDiscordHost> = {}): {
	host: LiveDiscordHost;
	prompts: string[];
	turnSignals: AbortSignal[];
	abortReasons: string[];
	statuses: string[];
	warnings: string[];
	errors: string[];
	get detached(): boolean;
	setAlive(alive: boolean): void;
	setBusy(busy: boolean): void;
} {
	let alive = true;
	let busy = false;
	let detached = false;
	const prompts: string[] = [];
	const turnSignals: AbortSignal[] = [];
	const abortReasons: string[] = [];
	const statuses: string[] = [];
	const warnings: string[] = [];
	const errors: string[] = [];

	const host: LiveDiscordHost = {
		sessionId: "session-live-1",
		cwd: "/tmp/jeo-live-cwd",
		isAlive: () => alive,
		isBusy: () => busy,
		async runTurn(promptText, signal) {
			prompts.push(promptText);
			turnSignals.push(signal);
			return { ok: true, text: `reply:${promptText}` };
		},
		async abortTurn(reason) {
			abortReasons.push(reason);
		},
		onStatus(message) {
			statuses.push(message);
		},
		onWarning(message) {
			warnings.push(message);
		},
		onError(message) {
			errors.push(message);
		},
		onDetached() {
			detached = true;
		},
		...overrides,
	};

	return {
		host,
		prompts,
		turnSignals,
		abortReasons,
		statuses,
		warnings,
		errors,
		get detached() {
			return detached;
		},
		setAlive(next) {
			alive = next;
		},
		setBusy(next) {
			busy = next;
		},
	};
}

const plain = (text: string) =>
	text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

function sse(text: string): Response {
	return new Response(
		`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n` +
			`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
			"data: [DONE]\n\n",
		{ headers: { "content-type": "text/event-stream" } },
	);
}

describe("live Discord bridge contracts", () => {
	test("enforces acknowledgeFullControl, nonempty allowedChannelIds, Discord config, and env validation", () => {
		const { host } = createHostHarness();
		const env = { JEO_DISCORD_BOT_TOKEN: "test-bot-token" };

		expect(() => createLiveDiscordBridge(host, makeConfig(), { env })).toThrow(/--allow-full-control/);
		expect(() =>
			createLiveDiscordBridge(host, makeConfig(), { env }, { acknowledgeFullControl: false }),
		).toThrow(/--allow-full-control/);

		expect(() =>
			createLiveDiscordBridge(
				host,
				{ ...makeConfig(), platforms: {} },
				{ env },
				{ acknowledgeFullControl: true },
			),
		).toThrow("Live Discord requires a discord platform configuration");

		expect(() =>
			createLiveDiscordBridge(
				host,
				makeConfig({
					platforms: {
						discord: { tokenEnv: "JEO_DISCORD_BOT_TOKEN", allowedUserIds: [USER_ID] },
					},
				}),
				{ env },
				{ acknowledgeFullControl: true },
			),
		).toThrow("Live Discord requires an explicit nonempty allowedChannelIds list");

		expect(() =>
			createLiveDiscordBridge(
				host,
				makeConfig({
					platforms: {
						discord: {
							tokenEnv: "JEO_DISCORD_BOT_TOKEN",
							allowedUserIds: [USER_ID],
							allowedChannelIds: [],
						},
					},
				}),
				{ env },
				{ acknowledgeFullControl: true },
			),
		).toThrow("Live Discord requires an explicit nonempty allowedChannelIds list");

		expect(() =>
			createLiveDiscordBridge(host, makeConfig(), { env: {} }, { acknowledgeFullControl: true }),
		).toThrow("discord requires a nonempty credential in JEO_DISCORD_BOT_TOKEN");

		// Other platforms are stripped so missing telegram/slack tokens do not block live Discord.
		const harness = createFakeAdapterHarness();
		const bridge = createLiveDiscordBridge(
			host,
			makeConfig({
				platforms: {
					discord: {
						tokenEnv: "JEO_DISCORD_BOT_TOKEN",
						allowedUserIds: [USER_ID],
						allowedChannelIds: [CHANNEL_1],
					},
					telegram: {
						tokenEnv: "MISSING_TELEGRAM_TOKEN",
						allowedUserIds: ["tg-user"],
					},
				},
			}),
			{ env, createAdapter: () => harness.adapter },
			{ acknowledgeFullControl: true },
		);
		expect(bridge.active).toBe(true);
		expect(Object.keys(bridge.config.platforms)).toEqual(["discord"]);
	});

	test("ignores empty toolNames, delegates authorized turns to host.runTurn, and filters unauthorized messages", async () => {
		const harness = createFakeAdapterHarness();
		const h = createHostHarness({
			async runTurn(promptText, signal) {
				h.prompts.push(promptText);
				h.turnSignals.push(signal);
				return { ok: true, text: "host turn result" };
			},
		});
		const bridge = createLiveDiscordBridge(
			h.host,
			makeConfig({ toolNames: [] }),
			{
				env: { JEO_DISCORD_BOT_TOKEN: "test-bot-token" },
				createAdapter: () => harness.adapter,
			},
			{ acknowledgeFullControl: true },
		);

		const runPromise = bridge.run();
		await harness.waitReady();

		// Unauthorized sender, unauthorized channel, and unmentioned guild message must not reach host.runTurn.
		await harness.emit(makeMessage({ messageId: "m-bad-user", senderId: OTHER_USER_ID }));
		await harness.emit(makeMessage({ messageId: "m-bad-chan", channelId: UNLISTED_CHANNEL }));
		await harness.emit(makeMessage({ messageId: "m-no-mention", mentioned: false }));
		expect(h.prompts).toEqual([]);
		expect(harness.sent).toEqual([]);

		// Authorized message proceeds even though config.toolNames is [].
		await harness.emit(makeMessage({ messageId: "m-ok", text: "inspect repo" }));
		expect(h.prompts).toEqual([`[Discord:m-ok sender:${USER_ID} channel:${CHANNEL_1}] inspect repo`]);
		expect(h.statuses).toContain(`Discord request from ${USER_ID}`);
		expect(harness.sent).toEqual([
			{
				channelId: CHANNEL_1,
				threadId: undefined,
				messageId: "m-ok",
				text: "host turn result",
			},
		]);

		await bridge.close();
		await runPromise;
		expect(h.detached).toBe(true);
	});

	test("rejects incoming requests when host.isBusy() is true or a Discord turn is already in flight", async () => {
		const harnessBusy = createFakeAdapterHarness();
		const busyHost = createHostHarness();
		busyHost.setBusy(true);
		const busyBridge = createLiveDiscordBridge(
			busyHost.host,
			makeConfig(),
			{
				env: { JEO_DISCORD_BOT_TOKEN: "test-bot-token" },
				createAdapter: () => harnessBusy.adapter,
			},
			{ acknowledgeFullControl: true },
		);

		const busyRun = busyBridge.run();
		await harnessBusy.waitReady();
		await harnessBusy.emit(makeMessage({ messageId: "m-busy-host", text: "blocked by host" }));
		expect(busyHost.prompts).toEqual([]);
		expect(harnessBusy.sent.map(entry => entry.text)).toEqual([
			"The live session is busy. Please try again when it is idle.",
		]);
		await busyBridge.close();
		await busyRun;

		// Concurrent turn protection when gateway schedules two conversations at once.
		const harness = createFakeAdapterHarness();
		const firstTurnStarted = Promise.withResolvers<void>();
		const releaseFirstTurn = Promise.withResolvers<{ ok: boolean; text?: string }>();
		let turnCount = 0;

		const h = createHostHarness({
			async runTurn(promptText, signal) {
				turnCount++;
				h.prompts.push(promptText);
				h.turnSignals.push(signal);
				if (turnCount === 1) {
					firstTurnStarted.resolve();
					return await releaseFirstTurn.promise;
				}
				return { ok: true, text: "unexpected second turn" };
			},
		});

		const bridge = createLiveDiscordBridge(
			h.host,
			makeConfig(),
			{
				env: { JEO_DISCORD_BOT_TOKEN: "test-bot-token" },
				createAdapter: () => harness.adapter,
				createGateway: (cfg, adapters, reply) => createMessengerGateway(cfg, adapters, reply, { concurrency: 2 }),
			},
			{ acknowledgeFullControl: true },
		);

		const runPromise = bridge.run();
		await harness.waitReady();

		const firstEmit = harness.emit(makeMessage({ messageId: "m-1", channelId: CHANNEL_1, text: "first" }));
		await firstTurnStarted.promise;

		await harness.emit(makeMessage({ messageId: "m-2", channelId: CHANNEL_2, text: "second" }));
		expect(turnCount).toBe(1);
		expect(harness.sent.at(-1)).toMatchObject({
			channelId: CHANNEL_2,
			messageId: "m-2",
			text: "The live session is busy. Please try again when it is idle.",
		});

		releaseFirstTurn.resolve({ ok: true, text: "first complete" });
		await firstEmit;
		expect(harness.sent.at(-1)).toMatchObject({
			channelId: CHANNEL_1,
			messageId: "m-1",
			text: "first complete",
		});

		await bridge.close();
		await runPromise;
	});

	test("enforces relay destination allowlist and delivers or warns cleanly on relayLocalOutput", async () => {
		const harness = createFakeAdapterHarness();
		const h = createHostHarness();
		const bridge = createLiveDiscordBridge(
			h.host,
			makeConfig(),
			{
				env: { JEO_DISCORD_BOT_TOKEN: "test-bot-token" },
				createAdapter: () => harness.adapter,
			},
			{ acknowledgeFullControl: true },
		);

		expect(bridge.relayDestination).toBeUndefined();
		expect(() => bridge.setRelayDestination(UNLISTED_CHANNEL)).toThrow(
			"Discord relay destination must be an explicitly allowed channel ID",
		);
		expect(bridge.relayDestination).toBeUndefined();

		// Whitespace/no-destination relay is a no-op.
		await bridge.relayLocalOutput("no destination yet");
		expect(harness.sent).toEqual([]);

		bridge.setRelayDestination(CHANNEL_2);
		expect(bridge.relayDestination).toBe(CHANNEL_2);

		await bridge.relayLocalOutput("   \n\t  ");
		expect(harness.sent).toEqual([]);

		await bridge.relayLocalOutput("local answer 1");
		expect(harness.sent).toEqual([
			{ channelId: CHANNEL_2, threadId: undefined, messageId: "", text: "local answer 1" },
		]);

		// Relay send failure surfaces via host.onWarning instead of throwing.
		harness.setSendError(new Error("discord 503"));
		await bridge.relayLocalOutput("local answer 2");
		expect(h.warnings).toContain("Discord relay delivery failed: discord 503");
		harness.setSendError(undefined);

		// Clearing destination stops further relay deliveries.
		bridge.setRelayDestination(undefined);
		expect(bridge.relayDestination).toBeUndefined();
		await bridge.relayLocalOutput("after clear");
		expect(harness.sent).toHaveLength(1);

		// Dead host rejects setRelayDestination and suppresses relayLocalOutput.
		bridge.setRelayDestination(CHANNEL_1);
		h.setAlive(false);
		await bridge.relayLocalOutput("host died");
		expect(harness.sent).toHaveLength(1);
		expect(() => bridge.setRelayDestination(CHANNEL_1)).toThrow(
			"The live Discord bridge is no longer attached to this session.",
		);

		await bridge.close();
	});

	test("aborts in-flight turn, calls abortTurn, clears relay, and fires onDetached on close", async () => {
		const harness = createFakeAdapterHarness();
		const turnStarted = Promise.withResolvers<void>();
		const turnAborted = Promise.withResolvers<void>();

		const h = createHostHarness({
			async runTurn(promptText, signal) {
				h.prompts.push(promptText);
				h.turnSignals.push(signal);
				signal.addEventListener("abort", () => turnAborted.resolve(), { once: true });
				turnStarted.resolve();
				await turnAborted.promise;
				return { ok: false };
			},
		});

		const bridge = createLiveDiscordBridge(
			h.host,
			makeConfig(),
			{
				env: { JEO_DISCORD_BOT_TOKEN: "test-bot-token" },
				createAdapter: () => harness.adapter,
			},
			{ acknowledgeFullControl: true },
		);

		const runPromise = bridge.run();
		await harness.waitReady();
		bridge.setRelayDestination(CHANNEL_1);

		const messagePromise = harness.emit(makeMessage({ messageId: "m-abort", text: "long task" }));
		await turnStarted.promise;

		await bridge.close();
		await Promise.all([runPromise, messagePromise]);

		expect(bridge.active).toBe(false);
		expect(bridge.relayDestination).toBeUndefined();
		expect(h.turnSignals[0]?.aborted).toBe(true);
		expect(h.abortReasons).toEqual(["Discord live bridge revoked"]);
		expect(h.detached).toBe(true);
		expect(() => bridge.setRelayDestination(CHANNEL_1)).toThrow(
			"The live Discord bridge is no longer attached to this session.",
		);
		await bridge.relayLocalOutput("must not send after close");
		expect(harness.sent.filter(item => item.text === "must not send after close")).toEqual([]);
	});

	test("warns when host.abortTurn rejects during external AbortSignal revocation", async () => {
		const harness = createFakeAdapterHarness();
		const turnStarted = Promise.withResolvers<void>();
		const h = createHostHarness({
			async runTurn(promptText, signal) {
				h.prompts.push(promptText);
				h.turnSignals.push(signal);
				const aborted = Promise.withResolvers<void>();
				signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				turnStarted.resolve();
				await aborted.promise;
				return { ok: false };
			},
			async abortTurn() {
				throw new Error("cannot interrupt");
			},
		});

		const bridge = createLiveDiscordBridge(
			h.host,
			makeConfig(),
			{
				env: { JEO_DISCORD_BOT_TOKEN: "test-bot-token" },
				createAdapter: () => harness.adapter,
			},
			{ acknowledgeFullControl: true },
		);

		const controller = new AbortController();
		const runPromise = bridge.run(controller.signal);
		await harness.waitReady();
		const msgPromise = harness.emit(makeMessage({ messageId: "m-ext-abort", text: "wait" }));
		await turnStarted.promise;

		controller.abort();
		await Promise.all([runPromise, msgPromise]);

		expect(bridge.active).toBe(false);
		expect(h.detached).toBe(true);
		expect(h.warnings).toContain(
			"Discord live turn could not be interrupted; press Esc or Ctrl+C to interrupt it.",
		);
	});

	test("loadAndCreateLiveDiscordBridge loads messenger.json and drives real createDiscordAdapter + createMessengerGateway", async () => {
		const root = await makeTempRoot("jeo-live-load-");
		const configPath = path.join(root, "messenger.json");
		const workspace = path.join(root, "workspace");
		const sessionDir = path.join(root, "sessions");
		await fs.mkdir(workspace, { recursive: true });
		await fs.mkdir(sessionDir, { recursive: true });
		await fs.writeFile(
			configPath,
			JSON.stringify({
				cwd: "./workspace",
				sessionDir: "./sessions",
				toolNames: [],
				platforms: {
					discord: {
						tokenEnv: "JEO_DISCORD_BOT_TOKEN",
						allowedUserIds: [USER_ID],
						allowedChannelIds: [CHANNEL_1],
					},
				},
			}),
		);

		const h = createHostHarness({
			cwd: workspace,
			async runTurn(promptText, signal) {
				h.prompts.push(promptText);
				h.turnSignals.push(signal);
				return { ok: true, text: "real-adapter-reply" };
			},
		});

		await expect(
			loadAndCreateLiveDiscordBridge(h.host, configPath, {
				env: { JEO_DISCORD_BOT_TOKEN: "test-bot-token" },
			}),
		).rejects.toThrow(/--allow-full-control/);

		const postedMessages: Array<{ url: string; content: string }> = [];
		const replyDelivered = Promise.withResolvers<void>();
		let gatewaySocket: LiveTestSocket | undefined;

		class LiveTestSocket extends EventTarget {
			constructor() {
				super();
				gatewaySocket = this;
				queueMicrotask(() => {
					this.dispatchEvent(
						new MessageEvent("message", {
							data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }),
						}),
					);
				});
			}
			send(raw: string) {
				const parsed = JSON.parse(raw) as { op: number };
				if (parsed.op === 2) {
					queueMicrotask(() => {
						this.dispatchEvent(
							new MessageEvent("message", {
								data: JSON.stringify({
									op: 0,
									t: "READY",
									s: 1,
									d: {
										v: 10,
										user: { id: "bot-user", username: "jeo-bot" },
										session_id: "gw-session-1",
										resume_gateway_url: "wss://gateway.discord.gg",
									},
								}),
							}),
						);
						this.dispatchEvent(
							new MessageEvent("message", {
								data: JSON.stringify({
									op: 0,
									t: "MESSAGE_CREATE",
									s: 2,
									d: {
										id: "discord-msg-42",
										channel_id: CHANNEL_1,
										guild_id: "guild-1",
										author: { id: USER_ID, bot: false },
										content: "<@bot-user> check status",
										mentions: [{ id: "bot-user" }],
									},
								}),
							}),
						);
					});
				}
			}
			close() {}
		}

		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
			const pathname = new URL(url).pathname.replace("/api/v10", "");
			const method = init?.method ?? "GET";
			if (method === "GET" && pathname === "/users/@me") {
				return Response.json({ id: "bot-user", username: "jeo-bot", bot: true });
			}
			if (method === "GET" && pathname === "/gateway/bot") {
				return Response.json({ url: "wss://gateway.discord.gg", session_start_limit: { remaining: 100 } });
			}
			if (method === "GET" && pathname === `/channels/${CHANNEL_1}`) {
				return Response.json({ id: CHANNEL_1, guild_id: "guild-1", type: 0 });
			}
			if (method === "POST" && pathname === `/channels/${CHANNEL_1}/messages/discord-msg-42/threads`) {
				return Response.json({ id: "thread-42", parent_id: CHANNEL_1, guild_id: "guild-1" });
			}
			if (pathname.includes("/reactions/")) {
				return new Response(null, { status: 204 });
			}
			if (method === "POST" && pathname === "/channels/thread-42/messages") {
				const parsed = JSON.parse(String(init?.body ?? "{}")) as { content?: string };
				postedMessages.push({ url: pathname, content: parsed.content ?? "" });
				if (parsed.content === "real-adapter-reply") replyDelivered.resolve();
				return Response.json({ id: "posted-1" });
			}
			if (method === "PATCH" && pathname.startsWith("/channels/thread-42/messages/")) {
				return Response.json({ id: "posted-1" });
			}
			throw new Error(`Unexpected Discord fetch: ${method} ${pathname}`);
		}) as typeof fetch;

		const bridge = await loadAndCreateLiveDiscordBridge(
			h.host,
			configPath,
			{
				env: { JEO_DISCORD_BOT_TOKEN: "test-bot-token" },
				transport: {
					fetch: fetchImpl,
					WebSocket: LiveTestSocket as unknown as typeof WebSocket,
				},
			},
			{ acknowledgeFullControl: true },
		);

		const running = bridge.run();
		await replyDelivered.promise;
		await bridge.close();
		await running;

		expect(gatewaySocket).toBeDefined();
		expect(h.prompts).toEqual([`[Discord:discord-msg-42 sender:${USER_ID} channel:${CHANNEL_1}] check status`]);
		expect(postedMessages.some(item => item.content === "real-adapter-reply")).toBe(true);
		expect(h.detached).toBe(true);
	});

	test("blocks remote slash/bang/Ctrl-C commands, passes trustedContext guardrails, and redacts bot token", async () => {
		const harness = createFakeAdapterHarness();
		const trustedContexts: Array<string | undefined> = [];
		const h = createHostHarness({
			async runTurn(promptText, signal, trustedContext) {
				h.prompts.push(promptText);
				h.turnSignals.push(signal);
				trustedContexts.push(trustedContext);
				return { ok: true, text: "leaked secret-live-token here" };
			},
		});
		const bridge = createLiveDiscordBridge(
			h.host,
			makeConfig(),
			{
				env: { JEO_DISCORD_BOT_TOKEN: "secret-live-token" },
				createAdapter: () => harness.adapter,
			},
			{ acknowledgeFullControl: true },
		);

		const runPromise = bridge.run();
		await harness.waitReady();

		for (const [idx, badText] of ["/sandbox status", "!rm -rf", "$deep-interview", "abort\u0003now"].entries()) {
			await harness.emit(makeMessage({ messageId: `bad-${idx}`, text: badText }));
		}
		expect(h.prompts).toEqual([]);
		expect(harness.sent.slice(0, 3).every(entry => entry.text.includes("Remote commands are disabled"))).toBe(true);
		// \u0003 is rejected by isMessengerMessageAllowed before reaching reply/host.runTurn.
		expect(harness.sent).toHaveLength(3);

		await harness.emit(makeMessage({ messageId: "m-ok-guardrail", text: "summarize status" }));
		expect(h.prompts).toEqual([`[Discord:m-ok-guardrail sender:${USER_ID} channel:${CHANNEL_1}] summarize status`]);
		expect(trustedContexts[0]).toContain("Discord live session guardrail");
		expect(trustedContexts[0]).toContain(USER_ID);
		expect(harness.sent.at(-1)?.text).toBe("leaked [REDACTED_TOKEN] here");

		bridge.setRelayDestination(CHANNEL_2);
		await bridge.relayLocalOutput("local secret-live-token output");
		expect(harness.sent.at(-1)?.text).toBe("local [REDACTED_TOKEN] output");

		await bridge.close();
		await runPromise;
	});
});

describe("default Discord setup and messenger setup command", () => {
	test("defaultDiscordConfigPath follows JEO_CONFIG_DIR and setupDiscordMessenger defaults without configPath in a non-Git dir", async () => {
		const root = await makeTempRoot("jeo-discord-default-setup-");
		const cfgDir = path.join(root, "jeo-home");
		const nonGitCwd = path.join(root, "non-git-dir");
		await fs.mkdir(nonGitCwd, { recursive: true });

		const prevConfigDir = process.env.JEO_CONFIG_DIR;
		const prevCwd = process.cwd();
		process.env.JEO_CONFIG_DIR = cfgDir;
		process.chdir(nonGitCwd);

		try {
			const expectedConfigPath = path.join(cfgDir, "discord", "messenger.json");
			expect(defaultDiscordConfigPath()).toBe(expectedConfigPath);

			const io: DiscordSetupIO = {
				interactive: false,
				say() {},
				ask: async () => {
					throw new Error("Unexpected question");
				},
				askSecret: async () => {
					throw new Error("Unexpected secret prompt");
				},
			};

			class ReadySocket extends EventTarget {
				constructor() {
					super();
					queueMicrotask(() => {
						this.dispatchEvent(
							new MessageEvent("message", {
								data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }),
							}),
						);
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
											session_id: "sess",
											resume_gateway_url: "wss://gateway.discord.gg",
										},
									}),
								}),
							);
						});
					}
				}
				close() {}
			}

			const responses: Record<string, unknown> = {
				"/users/@me": { id: "bot", username: "fixture-bot", bot: true },
				"/applications/@me": { id: "app", owner: { id: USER_ID }, flags: 1 << 18 },
				"/users/@me/guilds": [{ id: "guild", name: "Guild" }],
				"/guilds/guild": { id: "guild", roles: [{ id: "guild", permissions: "8" }] },
				"/guilds/guild/members/bot": { roles: [] },
				"/guilds/guild/channels": [{ id: CHANNEL_1, name: "general", type: 0 }],
				"/gateway/bot": { url: "wss://gateway.discord.gg" },
			};

			const deps: DiscordSetupDeps = {
				env: { JEO_DISCORD_BOT_TOKEN: "fixture-token" },
				fetch: (async (input: string | URL | Request) => {
					const route = new URL(
						typeof input === "string" || input instanceof URL ? input : input.url,
					).pathname.replace("/api/v10", "");
					if (!Object.hasOwn(responses, route)) throw new Error(`Unexpected setup fetch: ${route}`);
					return Response.json(responses[route]);
				}) as typeof fetch,
				WebSocket: ReadySocket as unknown as typeof WebSocket,
				jeoCommand: [process.execPath],
				profilesPath: path.join(root, "profiles.json"),
				restartService: async () => "not installed",
				installService: async () => {
					throw new Error("Unexpected service install");
				},
			};

			const result = await setupDiscordMessenger({ dmTest: false }, io, deps);
			expect(result.configPath).toBe(expectedConfigPath);

			const written = JSON.parse(await fs.readFile(expectedConfigPath, "utf8")) as Record<string, unknown>;
			expect(written.toolNames).toEqual([]);
			expect(written.cwd).toBe("./workspace");
			expect(written.sessionDir).toBe("./sessions");
			expect(Object.hasOwn(written, "sandbox")).toBe(false);
			const discordCfg = (written.platforms as Record<string, Record<string, unknown>>).discord!;
			expect(Object.hasOwn(discordCfg, "workerMode")).toBe(false);
			expect(discordCfg.allowedUserIds).toEqual([USER_ID]);
			expect(discordCfg.allowedChannelIds).toEqual([CHANNEL_1]);
		} finally {
			process.chdir(prevCwd);
			if (prevConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
			else process.env.JEO_CONFIG_DIR = prevConfigDir;
		}
	});

	test("runMessengerCommand(['setup']) defaults to defaultDiscordConfigPath and prints /discord live --allow-full-control", async () => {
		const root = await makeTempRoot("jeo-messenger-setup-cmd-");
		const home = path.join(root, "home");
		const cfgDir = path.join(home, ".jeo");
		const nonGitCwd = path.join(root, "non-git-workspace");
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(nonGitCwd, { recursive: true });

		const runnerScript = path.join(root, "run-setup.ts");
		await fs.writeFile(
			runnerScript,
			`
import { runMessengerCommand } from ${JSON.stringify(MESSENGER_CMD_PATH)};

class ReadySocket extends EventTarget {
	constructor() {
		super();
		queueMicrotask(() => {
			this.dispatchEvent(new MessageEvent("message", {
				data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }),
			}));
		});
	}
	send(raw: string) {
		if (JSON.parse(raw).op === 2) {
			queueMicrotask(() => {
				this.dispatchEvent(new MessageEvent("message", {
					data: JSON.stringify({
						op: 0,
						t: "READY",
						s: 1,
						d: {
							v: 10,
							user: { id: "bot", username: "fixture-bot" },
							session_id: "sess",
							resume_gateway_url: "wss://gateway.discord.gg",
						},
					}),
				}));
			});
		}
	}
	close() {}
}

const responses: Record<string, unknown> = {
	"/users/@me": { id: "bot", username: "fixture-bot", bot: true },
	"/applications/@me": { id: "app", owner: { id: ${JSON.stringify(USER_ID)} }, flags: 1 << 18 },
	"/users/@me/guilds": [{ id: "guild", name: "Guild" }],
	"/guilds/guild": { id: "guild", roles: [{ id: "guild", permissions: "8" }] },
	"/guilds/guild/members/bot": { roles: [] },
	"/guilds/guild/channels": [{ id: ${JSON.stringify(CHANNEL_1)}, name: "general", type: 0 }],
	"/gateway/bot": { url: "wss://gateway.discord.gg" },
	"/users/@me/channels": { id: "dm-channel" },
	"/channels/dm-channel/messages": { id: "dm-msg" },
};

globalThis.WebSocket = ReadySocket as unknown as typeof WebSocket;
globalThis.fetch = (async (input: string | URL | Request) => {
	const route = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname.replace("/api/v10", "");
	if (!Object.hasOwn(responses, route)) throw new Error("Unexpected setup fetch: " + route);
	return Response.json(responses[route]);
}) as typeof fetch;

await runMessengerCommand(["setup"]);
`,
		);

		const cleanEnv = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !key.startsWith("JEO_") && !key.startsWith("GIT_")),
		);
		const proc = Bun.spawn([process.execPath, runnerScript], {
			cwd: nonGitCwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...cleanEnv,
				HOME: home,
				USERPROFILE: home,
				JEO_CONFIG_DIR: cfgDir,
				JEO_DISCORD_BOT_TOKEN: "fixture-token",
			},
			timeout: 15_000,
		});

		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		const expectedConfigPath = path.join(cfgDir, "discord", "messenger.json");
		expect(stdout).toContain(`Discord messenger ready: ${expectedConfigPath}`);
		expect(stdout).toContain("Default (connect running terminal session): in 'jeo', run /discord live --allow-full-control");

		const written = JSON.parse(await fs.readFile(expectedConfigPath, "utf8")) as Record<string, unknown>;
		expect(written.toolNames).toEqual([]);
		expect(Object.hasOwn(written, "sandbox")).toBe(false);
		const discordCfg = (written.platforms as Record<string, Record<string, unknown>>).discord!;
		expect(Object.hasOwn(discordCfg, "workerMode")).toBe(false);
		expect(discordCfg.allowedChannelIds).toEqual([CHANNEL_1, "dm-channel"]);
	});
});

describe("unsandboxed launch PTY Discord control", () => {
	test("enables /discord control on --allow-full-control without sandbox, executes remote_request, reports status, and revokes on /discord control off", async () => {
		const root = await makeTempRoot("jeo-discord-unsandboxed-pty-");
		const home = path.join(root, "home");
		const config = path.join(root, "config");
		const workspace = path.join(root, "workspace");
		const sessions = path.join(config, "notifications", "sessions");
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(sessions, { recursive: true });
		await fs.mkdir(workspace, { recursive: true });
		await fs.chmod(config, 0o700);

		const providerPrompts: string[] = [];
		const provider = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (request.method !== "POST") return Response.json({ data: [{ id: "pty-model" }] });
				const body = (await request.json()) as {
					stream?: boolean;
					messages?: Array<{ role?: string; content?: unknown }>;
				};
				const serializedMessages = JSON.stringify(body.messages ?? []);
				providerPrompts.push(serializedMessages);
				const text = "unsandboxed remote answer";
				return body.stream
					? sse(text)
					: Response.json({
							choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
						});
			},
		});

		// Intentionally omit `sandbox` from config.json to verify unsandboxed host-session control.
		await fs.writeFile(
			path.join(config, "config.json"),
			JSON.stringify({
				providers: {},
				defaultModel: "openai/pty-model",
				openaiBaseUrl: `http://127.0.0.1:${provider.port}/v1`,
				notifications: { enabled: true, discord: { allowedUserIds: [USER_ID] } },
				routing: { enabled: false },
				computer: { enabled: false },
				gitAutoCommit: false,
			}),
		);

		let output = "";
		let outputWaiters: Array<() => void> = [];
		const pending = new Set<string>();
		let typedCharacter = "";
		let cliExitCode: number | undefined;
		const { promise: deadline, reject: rejectDeadline } = Promise.withResolvers<never>();
		deadline.catch(() => {});

		const phase = async <T>(label: string, action: () => Promise<T>): Promise<T> => {
			pending.add(label);
			try {
				return await Promise.race([action(), deadline]);
			} finally {
				pending.delete(label);
			}
		};

		const terminal = new Bun.Terminal({
			cols: 120,
			rows: 36,
			data(_terminal, bytes) {
				output += new TextDecoder().decode(bytes);
				for (const resolve of outputWaiters.splice(0)) resolve();
			},
		});

		const waitOutput = (needle: string, from = 0) =>
			phase(`output ${JSON.stringify(needle)} from ${from}`, async () => {
				while (!plain(output.slice(from)).includes(needle)) {
					const { promise, resolve } = Promise.withResolvers<void>();
					outputWaiters.push(resolve);
					await promise;
				}
			});

		const typed = (text: string) =>
			phase(`typing ${JSON.stringify(text)}`, async () => {
				let index = 0;
				for (const character of text) {
					typedCharacter = `${index++}:${JSON.stringify(character)}`;
					const { promise, resolve } = Promise.withResolvers<void>();
					outputWaiters.push(resolve);
					terminal.write(character);
					await promise;
				}
				terminal.write("\r");
			});

		const discoveryReady = Promise.withResolvers<{ url: string; token: string; id: string }>();
		const scanDiscovery = async () => {
			const names = await fs.readdir(sessions).catch(() => []);
			for (const name of names) {
				if (!name.endsWith(".json")) continue;
				try {
					const data = JSON.parse(await fs.readFile(path.join(sessions, name), "utf8")) as {
						url: string;
						token: string;
					};
					discoveryReady.resolve({ ...data, id: name.slice(0, -5) });
				} catch {
					// File may still be mid-write; next scan picks it up.
				}
			}
		};
		const watcher = watch(sessions, () => {
			void scanDiscovery();
		});

		const env = {
			HOME: home,
			USERPROFILE: home,
			PATH: process.env.PATH ?? "",
			JEO_CONFIG_DIR: config,
			OPENAI_API_KEY: "sk-test-fake-local-openai-key",
			JEO_STATIC_MEMORY: "1",
			NO_COLOR: "1",
			TERM: "xterm-256color",
		};

		const proc = Bun.spawn(
			[process.execPath, GUARDIAN, process.execPath, CLI, "launch", "--no-tui", "--no-skills", "--model", "openai/pty-model"],
			{
				cwd: workspace,
				env,
				terminal,
				detached: true,
				ipc(message) {
					if (message.type === "exit") cliExitCode = message.exitCode;
				},
			},
		);
		void proc.exited.then(code => rejectDeadline(new Error(`PTY guardian exited unexpectedly: ${code}`)));

		let ws: WebSocket | undefined;
		let testFailure: unknown;

		try {
			const diagnostic = setTimeout(() => {
				rejectDeadline(
					new Error(
						`Unsandboxed Discord PTY stalled; pending: ${[...pending].join("; ")}; character: ${typedCharacter}; child exit: ${cliExitCode}; output tail: ${JSON.stringify(output.slice(-1000))}`,
					),
				);
			}, 55_000);

			try {
				await waitOutput("Type your message");
				const discoveryPoll = setInterval(() => {
					void scanDiscovery();
				}, 100);
				let discovery: { url: string; token: string; id: string };
				try {
					await scanDiscovery();
					discovery = await phase("session discovery", () => discoveryReady.promise);
				} finally {
					clearInterval(discoveryPoll);
				}

				ws = new WebSocket(`${discovery.url}/?token=${encodeURIComponent(discovery.token)}`);
				const frames: Array<Record<string, unknown>> = [];
				const listeners: Array<() => void> = [];
				ws.addEventListener("message", event => {
					frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
					for (const resolve of listeners.splice(0)) resolve();
				});
				const waitFrame = (predicate: (frame: Record<string, unknown>) => boolean, from = 0) =>
					phase(`frame from ${from}`, async () => {
						for (;;) {
							const found = frames.slice(from).find(predicate);
							if (found) return found;
							const { promise, resolve } = Promise.withResolvers<void>();
							listeners.push(resolve);
							await promise;
						}
					});

				await waitFrame(frame => frame.type === "snapshot");

				// Enable Discord control without sandbox.
				const beforeControlOn = output.length;
				await typed("/discord control on --allow-full-control");
				const outcome = await Promise.race([
					waitFrame(frame => frame.type === "discord_control" && frame.enabled === true).then(frame => ({
						frame,
					})),
					waitOutput("Confirm Discord control: press y to allow, any other key to cancel.", beforeControlOn).then(
						() => ({ frame: undefined }),
					),
				]);
				let enabled = outcome.frame;
				if (!enabled) {
					terminal.write("y");
					enabled = await waitFrame(frame => frame.type === "discord_control" && frame.enabled === true);
				}
				expect(plain(output.slice(beforeControlOn))).not.toContain("SANDBOX_REQUIRED");
				expect(enabled.enabled).toBe(true);
				await waitOutput("Discord control enabled for this host session.", beforeControlOn);

				// Verify /discord status reports daemon control enabled.
				const beforeStatusOn = output.length;
				await waitOutput("Type your message", beforeControlOn);
				await typed("/discord status");
				await waitOutput(
					`Discord live bridge: off; daemon control: enabled; cwd: ${workspace};`,
					beforeStatusOn,
				);

				// Execute a remote_request via SessionNotifyEndpoint against the fake OpenAI server.
				const reqId = crypto.randomUUID();
				const beforeRemote = output.length;
				ws.send(
					JSON.stringify({
						type: "remote_request",
						sessionId: discovery.id,
						reqId,
						controlGeneration: enabled.generation,
						actor: { origin: "discord", sessionKey: discovery.id, userId: USER_ID },
						text: "hello from unsandboxed discord",
					}),
				);
				const accepted = await waitFrame(frame => frame.type === "ack" && frame.reqId === reqId);
				expect(accepted.ok).toBe(true);

				const final = await waitFrame(frame => frame.type === "remote_final" && frame.reqId === reqId);
				expect(final.ok).toBe(true);
				expect(final.text).toBe("unsandboxed remote answer");
				expect(providerPrompts).toHaveLength(1);
				expect(providerPrompts[0]).toContain("hello from unsandboxed discord");

				// Revoke control via /discord control off and confirm /discord status + subsequent remote rejection.
				await waitOutput("Type your message", beforeRemote);
				const beforeOff = output.length;
				await typed("/discord control off");
				const disabled = await waitFrame(
					frame =>
						frame.type === "discord_control" &&
						frame.enabled === false &&
						(frame.generation as number) > (enabled.generation as number),
				);
				expect(disabled.enabled).toBe(false);
				await waitOutput("Discord control revoked for this session.", beforeOff);

				const beforeStatusOff = output.length;
				await waitOutput("Type your message", beforeOff);
				await typed("/discord status");
				await waitOutput(
					`Discord live bridge: off; daemon control: off; cwd: ${workspace};`,
					beforeStatusOff,
				);

				const rejectedReqId = crypto.randomUUID();
				ws.send(
					JSON.stringify({
						type: "remote_request",
						sessionId: discovery.id,
						reqId: rejectedReqId,
						controlGeneration: enabled.generation,
						actor: { origin: "discord", sessionKey: discovery.id, userId: USER_ID },
						text: "must be rejected after control off",
					}),
				);
				const rejectedAck = await waitFrame(frame => frame.type === "ack" && frame.reqId === rejectedReqId);
				expect(rejectedAck.ok).toBe(false);
				expect(providerPrompts).toHaveLength(1);
			} finally {
				clearTimeout(diagnostic);
			}
		} catch (error) {
			testFailure = error;
			throw error;
		} finally {
			watcher.close();
			ws?.close();
			let cleanupFailure: unknown;
			const { promise: cleanupDeadline, reject: rejectCleanup } = Promise.withResolvers<never>();
			const cleanupTimer = setTimeout(
				() => rejectCleanup(new Error("PTY guardian did not stop within 10 seconds")),
				10_000,
			);
			try {
				if (proc.exitCode === null) proc.send("stop");
				await Promise.race([proc.exited, cleanupDeadline]);
			} catch (error) {
				cleanupFailure = error;
				try {
					proc.disconnect();
				} catch {}
			} finally {
				clearTimeout(cleanupTimer);
				terminal.close();
				provider.stop(true);
			}
			if (cleanupFailure) {
				if (testFailure) throw new AggregateError([testFailure, cleanupFailure], "PTY test and cleanup failed");
				throw cleanupFailure;
			}
		}
	}, 90_000);

	test("clearing an open mid-turn paste after remote cancellation allows direct /discord control off", async () => {
		const root = await makeTempRoot("jeo-discord-paste-abort-");
		const config = path.join(root, "config");
		const workspace = path.join(root, "workspace");
		const sessions = path.join(config, "notifications", "sessions");
		await fs.mkdir(sessions, { recursive: true });
		await fs.mkdir(workspace);
		await fs.chmod(config, 0o700);

		const providerReady = Promise.withResolvers<void>();
		const providerAborted = Promise.withResolvers<void>();
		const providerRequests: { release: () => void }[] = [];
		const provider = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (request.method !== "POST") return Response.json({ data: [{ id: "pty-model" }] });
				const released = Promise.withResolvers<void>();
				providerRequests.push({ release: released.resolve });
				request.signal.addEventListener("abort", () => {
					providerAborted.resolve();
					released.resolve();
				});
				providerReady.resolve();
				await released.promise;
				return Response.json({
					choices: [{ message: { role: "assistant", content: "released" }, finish_reason: "stop" }],
				});
			},
		});

		await fs.writeFile(
			path.join(config, "config.json"),
			JSON.stringify({
				providers: {},
				defaultModel: "openai/pty-model",
				openaiBaseUrl: `http://127.0.0.1:${provider.port}/v1`,
				notifications: { enabled: true, discord: { allowedUserIds: [USER_ID] } },
				routing: { enabled: false },
				computer: { enabled: false },
				gitAutoCommit: false,
			}),
		);

		let output = "";
		let outputWaiters: Array<() => void> = [];
		let consumedStdin = "";
		const stdinWaiters: Array<() => void> = [];
		const { promise: deadline, reject: rejectDeadline } = Promise.withResolvers<never>();
		deadline.catch(() => {});
		const pending = new Set<string>();
		const phase = async <T>(label: string, action: () => Promise<T>): Promise<T> => {
			pending.add(label);
			try {
				return await Promise.race([action(), deadline]);
			} finally {
				pending.delete(label);
			}
		};
		const terminal = new Bun.Terminal({
			cols: 120,
			rows: 36,
			data(_terminal, bytes) {
				output += new TextDecoder().decode(bytes);
				for (const resolve of outputWaiters.splice(0)) resolve();
			},
		});
		const nextOutput = () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			outputWaiters.push(resolve);
			return promise;
		};
		const plain = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
		const waitOutput = (needle: string, from = 0) =>
			phase(`output ${JSON.stringify(needle)}`, async () => {
				while (!plain(output.slice(from)).includes(needle)) await nextOutput();
			});
		const typed = (text: string) =>
			phase(`typing ${JSON.stringify(text)}`, async () => {
				for (const character of text) {
					const echoed = nextOutput();
					terminal.write(character);
					await echoed;
				}
				terminal.write("\r");
			});

		const discoveryReady = Promise.withResolvers<{ url: string; token: string; id: string }>();
		const scanDiscovery = async () => {
			const names = await fs.readdir(sessions).catch(() => []);
			for (const name of names) {
				if (!name.endsWith(".json")) continue;
				try {
					const data = JSON.parse(await fs.readFile(path.join(sessions, name), "utf8")) as { url: string; token: string };
					discoveryReady.resolve({ ...data, id: name.slice(0, -5) });
				} catch {}
			}
		};
		const watcher = watch(sessions, () => {
			void scanDiscovery();
		});
		const env = {
			HOME: process.env.HOME ?? "",
			PATH: process.env.PATH ?? "",
			JEO_CONFIG_DIR: config,
			OPENAI_API_KEY: "sk-test-fake-local-openai-key",
			JEO_STATIC_MEMORY: "1",
			NO_COLOR: "1",
			TERM: "xterm-256color",
			JEO_TEST_DISCORD_STDIN: "1",
		};
		const cliExited = Promise.withResolvers<number>();
		const proc = Bun.spawn(
			[process.execPath, GUARDIAN, process.execPath, CLI, "launch", "--no-skills", "--model", "openai/pty-model"],
			{
				cwd: workspace,
				env,
				terminal,
				detached: true,
				ipc(message) {
					if (message.type === "exit") cliExited.resolve(message.exitCode);
					if (message.type === "stdin-consumed") {
						consumedStdin += message.data;
						for (const resolve of stdinWaiters.splice(0)) resolve();
					}
				},
			},
		);
		void proc.exited.then(code => rejectDeadline(new Error(`PTY guardian exited unexpectedly: ${code}`)));

		let ws: WebSocket | undefined;
		let testFailure: unknown;
		try {
			const diagnostic = setTimeout(() => {
				rejectDeadline(new Error(`Discord paste-abort PTY stalled; pending: ${[...pending].join("; ")}; tail: ${JSON.stringify(output.slice(-800))}`));
			}, 45_000);
			try {
				await waitOutput("Type your message");
				const discoveryPoll = setInterval(() => {
					void scanDiscovery();
				}, 100);
				let discovery: { url: string; token: string; id: string };
				try {
					await scanDiscovery();
					discovery = await phase("session discovery", () => discoveryReady.promise);
				} finally {
					clearInterval(discoveryPoll);
				}

				ws = new WebSocket(`${discovery.url}/?token=${encodeURIComponent(discovery.token)}`);
				const frames: Array<Record<string, unknown>> = [];
				const listeners: Array<() => void> = [];
				ws.addEventListener("message", event => {
					frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
					for (const resolve of listeners.splice(0)) resolve();
				});
				const waitFrame = (predicate: (frame: Record<string, unknown>) => boolean, from = 0) =>
					phase(`frame from ${from}`, async () => {
						for (;;) {
							const found = frames.slice(from).find(predicate);
							if (found) return found;
							const { promise, resolve } = Promise.withResolvers<void>();
							listeners.push(resolve);
							await promise;
						}
					});
				await waitFrame(frame => frame.type === "snapshot");

				const beforeControlOn = output.length;
				await typed("/discord control on --allow-full-control");
				const outcome = await Promise.race([
					waitFrame(frame => frame.type === "discord_control" && frame.enabled === true).then(frame => ({ frame })),
					waitOutput("Confirm Discord control: press y to allow, any other key to cancel.", beforeControlOn).then(() => ({ frame: undefined })),
				]);
				let enabled = outcome.frame;
				if (!enabled) {
					terminal.write("y");
					enabled = await waitFrame(frame => frame.type === "discord_control" && frame.enabled === true);
				}

				// Security invariant: bracketed-pasted /discord control off must still be rejected.
				const beforePastedOff = output.length;
				await waitOutput("Type your message", beforeControlOn);
				terminal.write("\u001b[200~/discord control off\u001b[201~\r");
				await waitOutput("Discord control requires a directly submitted local prompt.", beforePastedOff);
				await waitOutput("Type your message", beforePastedOff);

				// Start a remote turn, leave an open bracketed paste across remote_cancel, clear with Ctrl+C + paste-end, then revoke.
				const reqId = crypto.randomUUID();
				ws.send(
					JSON.stringify({
						type: "remote_request",
						sessionId: discovery.id,
						reqId,
						controlGeneration: enabled.generation,
						actor: { origin: "discord", sessionKey: discovery.id, userId: USER_ID },
						text: "long remote task",
					}),
				);
				expect((await waitFrame(frame => frame.type === "ack" && frame.reqId === reqId)).ok).toBe(true);
				await phase("provider ready", () => providerReady.promise);

				const beforePaste = output.length;
				const beforeInput = consumedStdin.length;
				const paste = "\u001b[200~paste before abort\u001b[201~\u001b[200~paste before abort";
				terminal.write(paste);
				await phase("compact paste display", async () => {
					while (!/\[Paste #\d+, 1 lines, 18 cols\]/.test(plain(output.slice(beforePaste)))) await nextOutput();
				});
				await phase("open paste consumed", async () => {
					while (!consumedStdin.slice(beforeInput).includes(paste)) {
						const { promise, resolve } = Promise.withResolvers<void>();
						stdinWaiters.push(resolve);
						await promise;
					}
				});

				ws.send(JSON.stringify({ type: "remote_cancel", sessionId: discovery.id, reqId }));
				await phase("provider abort", () => providerAborted.promise);
				terminal.write("\u0003\u001b[201~");
				terminal.write("/discord  control   off\r");

				const disabled = await waitFrame(
					frame =>
						frame.type === "discord_control" &&
						frame.enabled === false &&
						(frame.generation as number) > (enabled.generation as number),
				);
				expect(disabled.enabled).toBe(false);
				terminal.write("\u0003");
				expect(await phase("terminal exit", () => cliExited.promise)).not.toBe(0);
			} finally {
				clearTimeout(diagnostic);
			}
		} catch (error) {
			testFailure = error;
			throw error;
		} finally {
			watcher.close();
			ws?.close();
			for (const request of providerRequests) request.release();
			let cleanupFailure: unknown;
			const { promise: cleanupDeadline, reject: rejectCleanup } = Promise.withResolvers<never>();
			const cleanupTimer = setTimeout(() => rejectCleanup(new Error("PTY guardian did not stop within 10 seconds")), 10_000);
			try {
				if (proc.exitCode === null) proc.send("stop");
				await Promise.race([proc.exited, cleanupDeadline]);
			} catch (error) {
				cleanupFailure = error;
				try {
					proc.disconnect();
				} catch {}
			} finally {
				clearTimeout(cleanupTimer);
				terminal.close();
				provider.stop(true);
			}
			if (cleanupFailure) {
				if (testFailure) throw new AggregateError([testFailure, cleanupFailure], "PTY test and cleanup failed");
				throw cleanupFailure;
			}
		}
	}, 90_000);
});
