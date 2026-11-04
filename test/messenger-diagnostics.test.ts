import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMessengerCliReply } from "../src/commands/messenger";
import { createMessengerGateway, messengerSessionRoute } from "../src/messenger/gateway";
import { selectDiscordModel } from "../src/messenger/model-selection";
import { createMessengerSessionPool, MESSENGER_WORKER_DIAGNOSTIC_LINES } from "../src/messenger/session-pool";
import type { ProviderModelsResult } from "../src/ai/model-discovery";
import type { MessengerAdapter, MessengerConfig, MessengerMessage } from "../src/messenger/types";
import { MessengerUnverifiedReplyError } from "../src/messenger/types";

const encoder = new TextEncoder();
const signal = new AbortController().signal;

interface FakeWorker {
	/** Writes the lines to the worker's stderr as one chunk, so the pool handles them in this order. */
	stderr(...lines: string[]): void;
	stdout(...lines: string[]): void;
	/** Closes both streams and settles the exit code; later calls are ignored. */
	exit(code: number): void;
}

/**
 * Worker double whose output is driven from `onTurn`, which runs when the pool writes the turn's prompt,
 * i.e. while that turn is pending. `env` is the environment the pool handed to the process.
 */
function fakeSpawn(onTurn: (worker: FakeWorker, env: Record<string, string>) => void): typeof Bun.spawn {
	return ((_argv: string[], options: { env: Record<string, string> }) => {
		const exited = Promise.withResolvers<number>();
		let output: ReadableStreamDefaultController<Uint8Array>;
		let errors: ReadableStreamDefaultController<Uint8Array>;
		const stdout = new ReadableStream<Uint8Array>({ start(c) { output = c; } });
		const stderr = new ReadableStream<Uint8Array>({ start(c) { errors = c; } });
		let done = false;
		const worker: FakeWorker = {
			stderr: (...lines) => errors.enqueue(encoder.encode(lines.map(line => `${line}\n`).join(""))),
			stdout: (...lines) => output.enqueue(encoder.encode(lines.map(line => `${line}\n`).join(""))),
			exit(code) { if (done) return; done = true; output.close(); errors.close(); exited.resolve(code); },
		};
		return {
			stdout, stderr, exited: exited.promise,
			kill() { worker.exit(0); },
			stdin: { write() { onTurn(worker, options.env); }, flush() {}, end() {} },
		};
	}) as typeof Bun.spawn;
}

test("pool forwards stray worker stderr and an exit during a turn, never protocol lines", async () => {
	const diagnostics: [string, string][] = [];
	const reports: string[] = [];
	const spawn = fakeSpawn(worker => { worker.stderr("JEO_MESSENGER_ACTIVITY Reading files", "JEO_MESSENGER_STEP", "TypeError: boom at worker.ts:1"); worker.exit(1); });
	const pool = createMessengerSessionPool(spawn, undefined, undefined, undefined, { onDiagnostic: (key, line) => diagnostics.push([key, line]) });
	try {
		await expect(pool.turn("conversation", ["worker"], "/tmp", {}, "hello", signal, text => reports.push(text))).rejects.toThrow("Messenger worker stopped");
		expect(reports).toEqual(["Reading files", "Working on your request"]);
		expect(diagnostics).toEqual([["conversation", "TypeError: boom at worker.ts:1"], ["conversation", "worker exited with code 1 during a turn"]]);
	} finally { await pool.close(); }
});

test("pool stops forwarding after MESSENGER_WORKER_DIAGNOSTIC_LINES lines with one suppression notice", async () => {
	const lines: string[] = [];
	const spawn = fakeSpawn(worker => { worker.stderr(...Array.from({ length: 25 }, (_, i) => `line ${i + 1}`)); worker.exit(1); });
	const pool = createMessengerSessionPool(spawn, undefined, undefined, undefined, { onDiagnostic: (_key, line) => lines.push(line) });
	try {
		await expect(pool.turn("conversation", ["worker"], "/tmp", {}, "hello", signal)).rejects.toThrow("Messenger worker stopped");
		// 25 lines plus the non-zero exit: only the first 20 are forwarded, then exactly one notice and nothing else.
		expect(lines).toEqual([...Array.from({ length: MESSENGER_WORKER_DIAGNOSTIC_LINES }, (_, i) => `line ${i + 1}`), "further worker output suppressed"]);
		expect(lines).toHaveLength(21);
	} finally { await pool.close(); }
});

test("pool diagnostics are single printable lines bounded to 300 characters, blank output is dropped", async () => {
	const lines: string[] = [];
	const spawn = fakeSpawn(worker => { worker.stderr("x".repeat(400), "\u001b[31mred\u001b[0m text", "tabbed\tcolumns\r", "   ", ""); worker.stdout('JEO_MESSENGER_RESULT "ok"'); });
	const pool = createMessengerSessionPool(spawn, undefined, undefined, undefined, { onDiagnostic: (_key, line) => lines.push(line) });
	try {
		expect(await pool.turn("conversation", ["worker"], "/tmp", {}, "hello", signal)).toBe("ok");
		expect(lines).toEqual([`${"x".repeat(299)}…`, "[31mred [0m text", "tabbed columns"]);
		expect(lines[0]).toHaveLength(300);
	} finally { await pool.close(); }
});

test("a throwing operator log never affects the turn, and a clean idle exit is not reported", async () => {
	let calls = 0;
	const spawn = fakeSpawn(worker => { worker.stderr("stray warning"); worker.stdout('JEO_MESSENGER_RESULT "ok"'); });
	const pool = createMessengerSessionPool(spawn, undefined, undefined, undefined, { onDiagnostic: () => { calls++; throw new Error("log sink failure"); } });
	try {
		expect(await pool.turn("conversation", ["worker"], "/tmp", {}, "hello", signal)).toBe("ok");
		expect(calls).toBe(1);
	} finally { await pool.close(); }
	// close() kills the idle worker, which exits 0 with no turn pending: nothing to explain to the operator.
	expect(calls).toBe(1);
});

const gatewayConfig: MessengerConfig = { cwd: "/workspace", sessionDir: "/sessions", toolNames: [], platforms: { discord: { tokenEnv: "JEO_DISCORD_BOT_TOKEN", allowedUserIds: ["owner"], allowedChannelIds: ["channel"] } } };
const gatewayMessage: MessengerMessage = { platform: "discord", accountId: "bot", channelId: "channel", senderId: "owner", messageId: "message", text: "hello", direct: false, mentioned: true };
type RequestError = [message: MessengerMessage, error: unknown, stage: "prepare" | "reply" | "deliver"];

/** Adapter double; `settled` resolves once the request's terminal status reaction arrived. */
function fakeAdapter(overrides: Partial<Pick<MessengerAdapter, "send" | "prepare">> = {}) {
	const delivered: string[] = [];
	const states: string[] = [];
	const settled = Promise.withResolvers<void>();
	const adapter: MessengerAdapter = {
		platform: "discord",
		start: async () => {},
		send: async (_message, text) => { delivered.push(text); },
		status: async (_message, state) => { states.push(state); if (state !== "processing") settled.resolve(); },
		...overrides,
	};
	return { adapter, delivered, states, settled: settled.promise };
}

for (const throwing of [false, true]) test(`gateway reports a failed reply at stage "reply" and still answers generically${throwing ? " when the operator log throws" : ""}`, async () => {
	const { adapter, delivered, states, settled } = fakeAdapter();
	const errors: RequestError[] = [];
	const gateway = createMessengerGateway(gatewayConfig, [adapter], async () => { throw new Error("boom"); }, {
		onRequestError: (message, error, stage) => { errors.push([message, error, stage]); if (throwing) throw new Error("log sink failure"); },
	});
	await gateway.handle(gatewayMessage);
	await settled;
	expect(delivered).toEqual(["The request could not be completed. Please try again."]);
	expect(states).toEqual(["processing", "failure"]);
	expect(errors).toHaveLength(1);
	const [reported, error, stage] = errors[0]!;
	expect(reported).toEqual(gatewayMessage);
	expect(stage).toBe("reply");
	expect((error as Error).message).toBe("boom");
});

test("gateway reports a failed destination at stage \"prepare\" with a failure reaction and no delivery", async () => {
	const { adapter, delivered, states, settled } = fakeAdapter({ prepare: async () => { throw new Error("thread creation failed"); } });
	const errors: RequestError[] = [];
	let replies = 0;
	const gateway = createMessengerGateway(gatewayConfig, [adapter], async () => { replies++; return "answer"; }, { onRequestError: (...args) => { errors.push(args); } });
	await gateway.handle(gatewayMessage);
	await settled;
	expect(replies).toBe(0);
	expect(delivered).toEqual([]);
	expect(states).toEqual(["failure"]);
	expect(errors.map(([message, error, stage]) => [message, (error as Error).message, stage])).toEqual([[gatewayMessage, "thread creation failed", "prepare"]]);
});

test("gateway reports a failed send of a successful reply at stage \"deliver\"", async () => {
	const attempted: string[] = [];
	const { adapter, states, settled } = fakeAdapter({ send: async (_message, text) => { attempted.push(text); throw new Error("rate limited"); } });
	const errors: RequestError[] = [];
	const gateway = createMessengerGateway(gatewayConfig, [adapter], async () => "answer", { onRequestError: (...args) => { errors.push(args); } });
	await gateway.handle(gatewayMessage);
	await settled;
	expect(attempted).toEqual(["answer"]);
	expect(states).toEqual(["processing", "failure"]);
	expect(errors.map(([message, error, stage]) => [message, (error as Error).message, stage])).toEqual([[gatewayMessage, "rate limited", "deliver"]]);
});

test("gateway does not report a reply that failed because the request was aborted", async () => {
	const { adapter, delivered, states } = fakeAdapter();
	const errors: RequestError[] = [];
	const started = Promise.withResolvers<void>();
	const controller = new AbortController();
	const gateway = createMessengerGateway(gatewayConfig, [adapter], async (_message, requestSignal) => {
		started.resolve();
		await new Promise<void>(resolve => requestSignal.addEventListener("abort", () => resolve(), { once: true }));
		throw new Error("turn aborted");
	}, { onRequestError: (...args) => { errors.push(args); } });
	const pending = gateway.handle(gatewayMessage, controller.signal);
	await started.promise;
	controller.abort();
	await pending;
	expect(errors).toEqual([]);
	expect(delivered).toEqual([]);
	expect(states).not.toContain("failure");
});

/** Worker output of an exhausted completion gate, in the format of formatRejectedCompletion. */
const unverifiedAnswer = "UNVERIFIED - the completion gate did not accept this answer; treat it as unconfirmed.\n\nCandidate: made the change\n\nStopped: completion rejected after 3 corrections. You modified files this turn but have no passing verification.";

/** Turn 1 ends UNVERIFIED, every later turn succeeds; `workers` holds each process that served a turn. */
function unverifiedThenResultSpawn() {
	const workers = new Set<FakeWorker>();
	let turns = 0;
	const spawn = fakeSpawn(worker => {
		workers.add(worker);
		worker.stdout(++turns === 1 ? `JEO_MESSENGER_UNVERIFIED ${JSON.stringify(unverifiedAnswer)}` : 'JEO_MESSENGER_RESULT "follow-up"');
	});
	return { spawn, workers };
}

test("pool rejects an UNVERIFIED worker line with the marked answer and keeps the worker (AC-10)", async () => {
	const { spawn, workers } = unverifiedThenResultSpawn();
	const diagnostics: string[] = [];
	const pool = createMessengerSessionPool(spawn, undefined, undefined, undefined, { onDiagnostic: (_key, line) => diagnostics.push(line) });
	try {
		const error = await pool.turn("conversation", ["worker"], "/tmp", {}, "make a change", signal).then(() => undefined, (rejection: unknown) => rejection);
		expect(error).toBeInstanceOf(MessengerUnverifiedReplyError);
		expect((error as MessengerUnverifiedReplyError).reply).toBe(unverifiedAnswer);
		// The operator-visible message is content-free: the candidate only travels in `reply`.
		expect((error as Error).message).toBe("Messenger agent turn ended without verified completion");
		expect(await pool.turn("conversation", ["worker"], "/tmp", {}, "follow-up", signal)).toBe("follow-up");
		expect(workers.size).toBe(1);
		expect(diagnostics).toEqual([]);
	} finally { await pool.close(); }
});

for (const payload of ['""', '"   "', '{"text":"x"}', "not json"]) test(`pool retires the worker on a malformed UNVERIFIED payload ${payload}`, async () => {
	const workers = new Set<FakeWorker>();
	const spawn = fakeSpawn(worker => {
		workers.add(worker);
		worker.stdout(workers.size === 1 ? `JEO_MESSENGER_UNVERIFIED ${payload}` : 'JEO_MESSENGER_RESULT "fresh"');
	});
	const pool = createMessengerSessionPool(spawn);
	try {
		await expect(pool.turn("conversation", ["worker"], "/tmp", {}, "hello", signal)).rejects.toThrow("Messenger worker stopped");
		expect(await pool.turn("conversation", ["worker"], "/tmp", {}, "again", signal)).toBe("fresh");
		expect(workers.size).toBe(2);
	} finally { await pool.close(); }
});

test("gateway delivers an unverified answer with a failure reaction, not the generic text (AC-10)", async () => {
	const { spawn } = unverifiedThenResultSpawn();
	const pool = createMessengerSessionPool(spawn);
	const { adapter, delivered, states, settled } = fakeAdapter();
	const errors: RequestError[] = [];
	try {
		const gateway = createMessengerGateway(gatewayConfig, [adapter], (m, s) => pool.turn("c", ["worker"], "/tmp", {}, m.text, s), {
			onRequestError: (...args) => { errors.push(args); },
		});
		await gateway.handle(gatewayMessage);
		await settled;
		expect(delivered).toEqual([unverifiedAnswer]);
		expect(delivered[0]).toContain("UNVERIFIED");
		expect(delivered[0]).toContain("Candidate: made the change");
		expect(delivered).not.toContain("The request could not be completed. Please try again.");
		expect(states).toEqual(["processing", "failure"]);
		expect(errors).toHaveLength(1);
		const [reported, error, stage] = errors[0]!;
		expect(reported).toEqual(gatewayMessage);
		expect(stage).toBe("reply");
		expect(error).toBeInstanceOf(MessengerUnverifiedReplyError);
		expect((error as Error).message).not.toContain("Candidate");
	} finally { await pool.close(); }
});

// Fixtures mirror test/messenger-worker-pool.test.ts: a Discord profile requires the sandbox section, and the
// workspace and private session storage are disjoint siblings.
const message: MessengerMessage = { platform: "discord", accountId: "bot", channelId: "channel", senderId: "owner", messageId: "1", text: "hello", direct: true, mentioned: false };
const sandbox = { image: "local-test-image", limits: { memoryBytes: 268435456, pids: 32, cpus: 1 } };
const selectModel: typeof selectDiscordModel = (explicit, opts) => selectDiscordModel(explicit, {
	...opts,
	config: { providers: {}, defaultModel: "gpt-6.1-terra", thinkingLevel: "medium" },
	list: async (provider: ProviderModelsResult["provider"]) => ({ provider, ok: true, source: "oauth", models: provider === "openai" ? ["gpt-6.1-terra"] : [] }),
});

test("the CLI reply prefixes worker diagnostics with the conversation route, never the shutdown acknowledgement", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-worker-diagnostics-"));
	const workspace = path.join(root, "workspace");
	await fs.mkdir(workspace);
	const config: MessengerConfig = { cwd: workspace, sessionDir: path.join(root, "sessions"), sandbox, toolNames: [], platforms: { discord: { tokenEnv: "JEO_DISCORD_BOT_TOKEN", allowedUserIds: ["owner"] } } };
	const log: string[] = [];
	// The supervisor cleaned up (authenticated acknowledgement) but the runtime failed to boot and exited 1.
	const spawn = fakeSpawn((worker, env) => {
		worker.stderr("boot failure", `JEO_MESSENGER_SHUTDOWN_ACK ${JSON.stringify({ nonce: env.JEO_MESSENGER_SHUTDOWN_NONCE, gone: true })}`);
		worker.exit(1);
	});
	const reply = createMessengerCliReply(config, spawn, selectModel, { log: line => log.push(line) });
	try {
		await expect(reply(message, signal)).rejects.toThrow("Messenger worker stopped");
		const prefix = `worker ${messengerSessionRoute(config.cwd, message).slice(0, 8)}: `;
		expect(log).toEqual([`${prefix}boot failure`, `${prefix}worker exited with code 1 during a turn`]);
	} finally { await reply.close(); await fs.rm(root, { recursive: true, force: true }); }
});
