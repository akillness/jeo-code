import { mkdir, readFile, lstat, chmod, realpath } from "node:fs/promises";
import { join } from "node:path";
import { hostBootTimeMs, processStartTimeMs } from "../agent/notify/daemon-control";
import { discordHostActionDigest, isDiscordActionRequest, isDiscordHostBootstrap } from "./host-protocol";
import type { DiscordActionDecision, DiscordHostAction, DiscordHostBootstrap, DiscordRunRef, DiscordWorkerOwner, DiscordWorkerScope, MessengerActivityReporter } from "./types";
import { isRecord, MessengerUnverifiedReplyError } from "./types";

interface WorkerProcess {
	pid?: number;
	stdin: { write(data: string): unknown; flush(): unknown; end(): unknown };
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	kill(signal?: number | NodeJS.Signals): void;
	/** Private IPC channel; present only on workers spawned with `ipc`. */
	send?(message: unknown): unknown;
}

interface Pending {
	resolve(text: string): void;
	reject(error: Error): void;
	report?: MessengerActivityReporter;
	result?: string;
	/** The result is an UNVERIFIED-marked answer: the turn rejects with it while the worker keeps serving. */
	unverified?: boolean;
	written?: boolean;
	hostRun?: DiscordRunRef;
	actions?: AbortController;
}

interface Worker {
	key: string;
	child: WorkerProcess;
	exit: Promise<number>;
	policyKey?: string;
	pending?: Pending;
	lastUsed: number;
	dead: boolean;
	forceSent?: boolean;
	exited?: boolean;
	cleanupNonce?: string;
	cleanupGone?: boolean;
	cleanupError?: Error;
	host?: DiscordHostBootstrap;
	owner?: DiscordWorkerOwner;
	requests?: Set<string>;
	activeRequests?: Set<AbortController>;
	startup?: AbortController;
	idleTimer?: ReturnType<typeof setTimeout>;
	exitTimer?: ReturnType<typeof setTimeout>;
	/** Diagnostic lines already forwarded for this worker. */
	diagnostics: number;
}

/** Resident sessions the pool keeps, and the number of turns it runs at once. */
export const MESSENGER_SESSION_LIMIT = 8;

/** Operator-visible worker stderr is bounded per worker so a chatty worker cannot flood the gateway log. */
export const MESSENGER_WORKER_DIAGNOSTIC_LINES = 20;
const MAX_DIAGNOSTIC_LINE_LENGTH = 300;

export interface MessengerSessionPool {
	turn(key: string, command: string[], cwd: string, env: Record<string, string>, text: string, signal: AbortSignal, report?: MessengerActivityReporter, policyKey?: string, hostRun?: DiscordRunRef): Promise<string>;
	stop(key: string): Promise<void>;
	close(): Promise<void>;
}

export interface MessengerSessionPoolOptions {
	requireSandboxCleanup?: boolean;
	/**
	 * Receives bounded, non-protocol worker stderr lines and abnormal exits for the operator log. Worker
	 * environments carry no platform tokens, and the conversation key is a route digest, never message text.
	 */
	onDiagnostic?: (key: string, line: string) => void;
	/**
	 * Kills the sandbox processes a worker left behind when it exited without acknowledging shutdown (the worker's
	 * own environment says which sandbox it used). Resolves true only when nothing is left; false or a rejection
	 * keeps the worker's cleanup unproven.
	 */
	reapOrphans?: (workerEnv: Readonly<Record<string, string>>) => Promise<boolean>;
	/** Parent-bound authorization; a child never supplies an actor or conversation identity. */
	onActionRequest?: (run: DiscordRunRef, action: DiscordHostAction, signal: AbortSignal) => Promise<void>;
	/** Publish ownership durably before the first host stdin frame is written. */
	onWorkerStarted?: (scope: DiscordWorkerScope, owner: DiscordWorkerOwner) => Promise<void>;
}

/** One printable, bounded line: control characters collapse to spaces. */
function diagnosticLine(text: string): string {
	const line = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
	return line.length > MAX_DIAGNOSTIC_LINE_LENGTH ? `${line.slice(0, MAX_DIAGNOSTIC_LINE_LENGTH - 1)}…` : line;
}

export function createMessengerSessionPool(spawn: typeof Bun.spawn = Bun.spawn, limit = MESSENGER_SESSION_LIMIT, idleTimeoutMs = 10 * 60_000, shutdownTimeoutMs = 5_000, options: MessengerSessionPoolOptions = {}): MessengerSessionPool {
	const workers = new Map<string, Worker>();
	const allWorkers = new Map<Worker, string>();
	const exits = new Map<Promise<number>, Worker>();
	const retiring = new Map<string, Promise<number>>();
	const keyTails = new Map<string, Promise<void>>();
	const keySignals = new Map<string, AbortController>();
	const stops = new Map<string, Promise<void>>();
	const quarantined = new Map<string, Error>();
	const requireSandboxCleanup = options.requireSandboxCleanup === true;
	const onDiagnostic = options.onDiagnostic;
	const reapOrphans = options.reapOrphans;
	const incomplete = (detail: string) => new Error(`REVOKE_INCOMPLETE: ${detail}`);

	let closed = false;
	const closedSignal = new AbortController();

	let tick = 0;

	// Admission: at most `limit` turns hold a worker at once. Later turns wait here in arrival order until a
	// running turn settles, so a busy pool is backpressure on the waiting request, never a failure of it.
	let admitted = 0;
	const waiting: Array<() => void> = [];

	function admit(signal: AbortSignal): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const grant = () => { cleanup(); resolve(); };
			const abort = () => {
				const index = waiting.indexOf(grant);
				if (index >= 0) waiting.splice(index, 1);
				cleanup();
				reject(new Error("Messenger request aborted"));
			};
			const cleanup = () => { signal.removeEventListener("abort", abort); closedSignal.signal.removeEventListener("abort", abort); };
			signal.addEventListener("abort", abort, { once: true });
			closedSignal.signal.addEventListener("abort", abort, { once: true });
			waiting.push(grant);
		});
	}

	/** Hand the finished turn's slot straight to the oldest waiter, or free it. */
	function release() {
		const next = waiting.shift();
		if (next) next(); else admitted--;
	}

	function forceKill(worker: Worker) {
		if (worker.cleanupNonce) return;
		if (worker.forceSent) return;
		try { worker.child.kill("SIGKILL"); worker.forceSent = true; } catch { /* Retry on shutdown if termination failed. */ }
	}

	function retire(key: string, worker: Worker, preservePending = false) {
		worker.pending?.actions?.abort();
		worker.startup?.abort();
		for (const request of worker.activeRequests ?? []) request.abort();
		if (!preservePending) {
			worker.pending?.reject(new Error("Messenger worker stopped"));
			worker.pending = undefined;
		}
		if (worker.dead) return;
		worker.dead = true;
		if (workers.get(key) === worker) workers.delete(key);
		if (!worker.cleanupNonce) allWorkers.delete(worker);
		if (!worker.exited || worker.cleanupNonce) {
			retiring.set(key, worker.exit);
			void worker.exit.then(
				() => { if (retiring.get(key) === worker.exit) retiring.delete(key); },
				() => { /* Keep the key blocked when process exit cannot be confirmed. */ },
			);
		}
		if (worker.idleTimer) clearTimeout(worker.idleTimer);
		if (worker.exitTimer) clearTimeout(worker.exitTimer);
		worker.idleTimer = undefined;
		if (!worker.exited) {
			if (worker.cleanupNonce) {
				// Protected workers never receive a kill signal: Windows cannot deliver a catchable SIGTERM.
				// Shutdown is a private IPC message; a missing or failing channel is visible, never success.
				const channel = worker.child.send;
				if (typeof channel !== "function") {
					worker.cleanupError = incomplete("worker shutdown channel unavailable");
				} else {
					try {
						const sent = channel.call(worker.child, { type: "jeo_messenger_shutdown", nonce: worker.cleanupNonce, ...(worker.host ? { epoch: worker.host.scope.epoch } : {}) });
						if (sent && typeof (sent as PromiseLike<unknown>).then === "function") {
							void (sent as PromiseLike<unknown>).then(undefined, error => { worker.cleanupError = incomplete(`worker shutdown request failed: ${String(error)}`); });
						}
					} catch (error) { worker.cleanupError = incomplete(`worker shutdown request failed: ${String(error)}`); }
				}
			} else {
				try { worker.child.kill(); }
				catch (error) { worker.cleanupError = incomplete(`worker termination failed: ${String(error)}`); }
			}
			if (!worker.cleanupNonce) {
				const force = setTimeout(() => forceKill(worker), shutdownTimeoutMs);
				force.unref();
				void worker.exit.then(() => clearTimeout(force), () => clearTimeout(force));
			}
		}
	}

	function finishTurn(key: string, worker: Worker, pending: Pending) {
		if (worker.pending !== pending || !pending.written || pending.result === undefined) return;
		pending.actions?.abort();
		clearTimeout(worker.exitTimer);
		worker.exitTimer = undefined;
		worker.pending = undefined;
		if (worker.exited || worker.dead) {
			retire(key, worker);
		} else {
			worker.lastUsed = ++tick;
			worker.idleTimer = setTimeout(() => retire(key, worker), idleTimeoutMs);
			worker.idleTimer.unref();
		}
		if (pending.unverified) pending.reject(new MessengerUnverifiedReplyError(pending.result));
		else pending.resolve(pending.result);
	}

	async function readLines(stream: ReadableStream<Uint8Array>, handle: (line: string) => void) {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				buffer += decoder.decode(chunk.value, { stream: true });
				if (buffer.length > 1_000_000) throw new Error("Messenger worker output too large");
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) handle(line);
			}
		} finally { reader.releaseLock(); }
	}

	function waitForExit(exit: Promise<number>, signal: AbortSignal, capacity = false): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const abort = () => { cleanup(); reject(new Error("Messenger request aborted")); };
			const unavailable = () => new Error("Messenger worker capacity unavailable while another session is being cleaned up");
			const timer = setTimeout(() => { cleanup(); reject(capacity ? unavailable() : requireSandboxCleanup ? incomplete("previous worker cleanup is still pending") : new Error("Messenger worker did not exit")); }, shutdownTimeoutMs * 2);
			const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); closedSignal.signal.removeEventListener("abort", abort); };
			signal.addEventListener("abort", abort, { once: true });
			closedSignal.signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted || closed) { abort(); return; }
			void exit.then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(capacity ? unavailable() : requireSandboxCleanup ? incomplete(`previous worker cleanup failed: ${String(error)}`) : new Error("Messenger worker exit could not be confirmed")); });
		});
	}

	function receiveAction(worker: Worker, message: unknown): void {
		const pending = worker.pending;
		const host = worker.host;
		if (!host || worker.dead || !pending?.hostRun || pending.actions?.signal.aborted || !isDiscordActionRequest(message) || message.nonce !== host.nonce || message.epoch !== host.scope.epoch || message.runId !== pending.hostRun.runId || worker.requests?.has(message.requestId)) return;
		// Keep both concurrent authorization and replay bookkeeping bounded for a resident worker.
		if (!worker.requests || !worker.activeRequests || worker.requests.size >= 4096 || worker.activeRequests.size >= MESSENGER_SESSION_LIMIT) { retire(worker.key, worker); return; }
		worker.requests.add(message.requestId);
		let action: DiscordHostAction;
		let actionDigest: string;
		try { action = structuredClone(message.action); actionDigest = discordHostActionDigest(action); }
		catch { retire(worker.key, worker); return; }
		const request = new AbortController();
		worker.activeRequests.add(request);
		const abort = () => request.abort();
		pending.actions?.signal.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(abort, 5 * 60_000);
		timer.unref();
		void (async () => {
			let decision: DiscordActionDecision["decision"] = "deny";
			let abortWait: (() => void) | undefined;
			try {
				if (!options.onActionRequest) throw new Error("Host action authority unavailable");
				await Promise.race([
					options.onActionRequest(pending.hostRun!, action, request.signal),
					new Promise<never>((_, reject) => { abortWait = () => reject(new Error("Host action request aborted")); request.signal.addEventListener("abort", abortWait, { once: true }); if (request.signal.aborted) abortWait(); }),
				]);
				if (!request.signal.aborted) decision = "allow";
			} catch { /* Authorization failure is a one-use denial, never an implicit permission. */ }
			finally {
				clearTimeout(timer);
				if (abortWait) request.signal.removeEventListener("abort", abortWait);
				pending.actions?.signal.removeEventListener("abort", abort);
				worker.activeRequests?.delete(request);
			}
			if (worker.dead || worker.pending !== pending || pending.actions?.signal.aborted) return;
			const response: DiscordActionDecision = { type: "action_decision", nonce: host.nonce, epoch: host.scope.epoch, runId: pending.hostRun!.runId, requestId: message.requestId, actionDigest, decision };
			try {
				if (!worker.child.send) throw new Error("Host action IPC unavailable");
				await worker.child.send(response);
			} catch { retire(worker.key, worker); }
		})();
	}

	async function start(key: string, command: string[], cwd: string, env: Record<string, string>, signal: AbortSignal, policyKey?: string, hostRun?: DiscordRunRef): Promise<Worker> {
		const workerEnv = { ...env };
		delete workerEnv.JEO_MESSENGER_HOST_BOOTSTRAP;
		delete workerEnv.JEO_MESSENGER_SHUTDOWN_NONCE;
		const cleanupNonce = requireSandboxCleanup || hostRun ? crypto.randomUUID() : undefined;
		let host: DiscordHostBootstrap | undefined;
		if (hostRun) {
			if (!options.onWorkerStarted || hostRun.sessionId !== key || !/^[a-zA-Z0-9_-]+$/.test(key) || !Number.isSafeInteger(hostRun.generation) || hostRun.generation < 0 || !hostRun.runId || !hostRun.conversationKey) throw new Error("Invalid host worker admission");
			let context: unknown;
			try { context = JSON.parse(env.JEO_MESSENGER_HOST_BOOTSTRAP ?? ""); } catch { throw new Error("Host worker bootstrap unavailable"); }
			if (!isRecord(context) || context.sessionDir !== env.JEO_SESSION_DIR || context.cwd !== cwd || typeof context.sessionDir !== "string") throw new Error("Host worker bootstrap mismatch");
			const sessionDir = await realpath(context.sessionDir);
			workerEnv.JEO_SESSION_DIR = sessionDir;
			const scope: DiscordWorkerScope = { sessionId: key, generation: hostRun.generation, epoch: crypto.randomUUID() };
			const runtimeDir = join(sessionDir, "host-runtime");
			const receiptDir = join(runtimeDir, key);
			for (const directory of [runtimeDir, receiptDir]) {
				await mkdir(directory, { recursive: true, mode: 0o700 });
				const stat = await lstat(directory);
				if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) throw new Error("Host runtime directory is not private");
				await chmod(directory, 0o700);
			}
			const candidate = { ...context, sessionDir, scope, nonce: cleanupNonce, cleanupReceipt: join(receiptDir, `${scope.epoch}.json`), bootStartedAt: await hostBootTimeMs() };
			if (!isDiscordHostBootstrap(candidate)) throw new Error("Invalid host worker bootstrap");
			host = candidate;
			workerEnv.JEO_MESSENGER_HOST_BOOTSTRAP = JSON.stringify(host);
		}
		// Protected retiring processes still occupy capacity; unprotected legacy accounting stays unchanged.
		while (workers.size + [...allWorkers.keys()].filter(worker => worker.cleanupNonce && workers.get(worker.key) !== worker).length >= limit) {
			if (closed || signal.aborted) throw new Error("Messenger request aborted");
			const idle = [...workers.entries()].filter(([, worker]) => !worker.pending && !worker.startup).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
			if (!idle) {
				const retiringWorker = [...allWorkers.keys()].find(worker => worker.dead && worker.cleanupNonce);
				if (!retiringWorker) throw new Error("Messenger worker capacity reached");
				await waitForExit(retiringWorker.exit, signal, true);
				continue;
			}
			retire(idle[0], idle[1]);
			if (idle[1].cleanupNonce) await waitForExit(idle[1].exit, signal, true);
		}
		if (closed || signal.aborted) throw new Error("Messenger request aborted");
		if (cleanupNonce) workerEnv.JEO_MESSENGER_SHUTDOWN_NONCE = cleanupNonce;
		let spawnedWorker: Worker | undefined;
		const spawnOptions = { cwd, env: workerEnv, stdin: "pipe", stdout: "pipe", stderr: "pipe", ...(cleanupNonce ? { ipc(message: unknown) { if (spawnedWorker) receiveAction(spawnedWorker, message); }, serialization: "json" } : {}) };
		const child = spawn(command, spawnOptions as never) as unknown as WorkerProcess;
		const cleanup = Promise.withResolvers<number>();
		// A stopped bootstrap cannot finish a durable owner write after this key is admitted again.
		const publication = Promise.withResolvers<void>();
		const worker: Worker = { key, child, exit: host ? Promise.all([cleanup.promise, publication.promise]).then(([code]) => code) : cleanupNonce ? cleanup.promise : child.exited, cleanupNonce, policyKey, host, ...(host ? { requests: new Set<string>(), activeRequests: new Set<AbortController>(), startup: new AbortController() } : {}), lastUsed: ++tick, dead: false, diagnostics: 0 };
		spawnedWorker = worker;
		const diagnose = (text: string): void => {
			if (!onDiagnostic || worker.diagnostics > MESSENGER_WORKER_DIAGNOSTIC_LINES) return;
			const line = diagnosticLine(text);
			if (!line) return;
			worker.diagnostics++;
			try { onDiagnostic(key, worker.diagnostics > MESSENGER_WORKER_DIAGNOSTIC_LINES ? "further worker output suppressed" : line); }
			catch { /* The operator log never affects the turn. */ }
		};
		// An exit during a turn, or a non-zero exit, explains the user-visible failure; a clean idle exit is routine.
		void child.exited.then(code => { if (code !== 0 || worker.pending) diagnose(`worker exited with code ${code}${worker.pending ? " during a turn" : ""}`); }, () => {});
		exits.set(worker.exit, worker);
		void worker.exit.then(() => {
			exits.delete(worker.exit);
			if (cleanupNonce) allWorkers.delete(worker);
		}, () => { if (!cleanupNonce) exits.delete(worker.exit); });
		workers.set(key, worker);
		allWorkers.set(worker, key);
		const stdoutDone = readLines(child.stdout, line => {
			const pending = worker.pending;
			if (!pending) return;
			if (line === "JEO_MESSENGER_ERROR") { retire(key, worker); return; }
			// An exhausted completion gate is a controlled turn end: deliver the marked answer, keep the worker.
			if (line.startsWith("JEO_MESSENGER_UNVERIFIED ")) {
				try {
					const text: unknown = JSON.parse(line.slice("JEO_MESSENGER_UNVERIFIED ".length));
					if (typeof text !== "string" || !text.trim()) throw new Error("Invalid response");
					pending.result = text;
					pending.unverified = true;
					finishTurn(key, worker, pending);
				} catch { retire(key, worker); }
				return;
			}
			if (!line.startsWith("JEO_MESSENGER_RESULT ")) return;
			try {
				const text: unknown = JSON.parse(line.slice("JEO_MESSENGER_RESULT ".length));
				if (typeof text !== "string" || !text.trim()) throw new Error("Invalid response");
				pending.result = text;
				finishTurn(key, worker, pending);
			} catch { retire(key, worker); }
		}).catch(() => retire(key, worker));
		const stderrDone = readLines(child.stderr, line => {
			if (cleanupNonce && line.startsWith("JEO_MESSENGER_SHUTDOWN_ACK ")) {
				try {
					const ack: unknown = JSON.parse(line.slice("JEO_MESSENGER_SHUTDOWN_ACK ".length));
					if (isRecord(ack) && ack.nonce === cleanupNonce && typeof ack.gone === "boolean" && (!host || ack.epoch === host.scope.epoch)) {
						worker.cleanupGone = ack.gone === true;
						worker.cleanupError = worker.cleanupGone ? undefined : incomplete("worker supervisor cleanup failed");
						// EOF/disconnect can finish cleanup before parent retirement; fence further input immediately.
						if (host && !worker.dead) {
							// stdout/stderr are independent: an already-buffered final result must drain first.
							retire(key, worker, true);
							void stdoutDone.then(() => {
								const pending = worker.pending;
								if (!pending) return;
								if (pending.result === undefined) { retire(key, worker); return; }
								finishTurn(key, worker, pending);
								if (worker.pending === pending) {
									worker.exitTimer = setTimeout(() => retire(key, worker), shutdownTimeoutMs);
									worker.exitTimer.unref();
								}
							});
						}
					}
				} catch { /* Unauthenticated or malformed output is never cleanup proof. */ }
				return;
			}
			if (line.startsWith("JEO_MESSENGER_ACTIVITY ")) {
				const activityText = line.slice("JEO_MESSENGER_ACTIVITY ".length).trim();
				if (activityText) worker.pending?.report?.(activityText);
			} else if (line === "JEO_MESSENGER_STEP") {
				worker.pending?.report?.("Working on your request");
			} else diagnose(line);
		}).catch(() => retire(key, worker));
		if (cleanupNonce) {
			void Promise.all([child.exited, stderrDone, stdoutDone]).then(async ([code]) => {
				// A worker that died before acknowledging (killed, crashed) never ran its supervisor close, so the
				// processes of its sandbox are orphans: reap them, and only a complete reap counts as cleanup proof.
				if (host) {
					try {
						const stat = await lstat(host.cleanupReceipt);
						if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || (stat.mode & 0o077) !== 0 || await realpath(host.cleanupReceipt) !== host.cleanupReceipt) throw new Error("Invalid host cleanup receipt file");
						const receipt: unknown = JSON.parse(await readFile(host.cleanupReceipt, "utf8"));
						if (!worker.cleanupGone || !isRecord(receipt) || receipt.version !== 1 || receipt.sessionId !== host.scope.sessionId || receipt.generation !== host.scope.generation || receipt.epoch !== host.scope.epoch || receipt.pid !== child.pid || receipt.nonce !== host.nonce || receipt.gone !== true) throw new Error("Host cleanup receipt does not match worker");
						cleanup.resolve(code);
					} catch { cleanup.reject(incomplete("host worker exited without authenticated cleanup receipt and acknowledgement")); }
					return;
				}
				const reaped = worker.cleanupGone || !reapOrphans ? false : await reapOrphans(env).catch(() => false);
				if (worker.cleanupGone || reaped) cleanup.resolve(code);
				else cleanup.reject(worker.cleanupError ?? incomplete("worker exited without supervisor cleanup acknowledgement"));
			}, error => cleanup.reject(incomplete(`worker exit could not be verified: ${String(error)}`)));
		}
		void worker.exit.then(() => {
			worker.exited = true;
			if (worker.dead) return;
			if (workers.get(key) === worker) workers.delete(key);
			worker.exitTimer = setTimeout(() => retire(key, worker), shutdownTimeoutMs);
			worker.exitTimer.unref();
			void stdoutDone.then(() => {
				if (!worker.pending?.result || worker.pending.written) retire(key, worker);
			});
		}, () => retire(key, worker));
		if (host) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let abortStart: (() => void) | undefined;
			const startupSignal = AbortSignal.any([signal, closedSignal.signal, worker.startup!.signal]);
			try {
				await Promise.race([
					(async () => {
						if (!Number.isSafeInteger(child.pid) || child.pid! <= 0) throw new Error("Host worker process identity unavailable");
						const startedAt = await processStartTimeMs(child.pid!);
						if (startedAt === undefined) throw new Error("Host worker process ownership cannot be verified");
						const owner: DiscordWorkerOwner = { ...host.scope, pid: child.pid!, startedAt, cleanupReceipt: host.cleanupReceipt, ...(host.bootStartedAt ? { bootStartedAt: host.bootStartedAt } : {}) };
						worker.owner = owner;
						if (signal.aborted || closed || worker.dead) throw new Error("Messenger worker stopped");
						await options.onWorkerStarted!(host.scope, owner);
					})().finally(() => publication.resolve()),
					new Promise<never>((_, reject) => {
						abortStart = () => reject(new Error("Messenger worker stopped during startup"));
						startupSignal.addEventListener("abort", abortStart, { once: true });
						timer = setTimeout(() => reject(incomplete("host worker ownership publication timed out")), Math.max(5_000, shutdownTimeoutMs));
						if (signal.aborted || closed || worker.dead) abortStart();
					}),
				]);
			} catch (error) { retire(key, worker); throw error; }
			finally {
				clearTimeout(timer);
				if (abortStart) startupSignal.removeEventListener("abort", abortStart);
				worker.startup = undefined;
			}
		}
		return worker;
	}

	function turn(key: string, command: string[], cwd: string, env: Record<string, string>, text: string, signal: AbortSignal, report?: MessengerActivityReporter, policyKey?: string, hostRun?: DiscordRunRef): Promise<string> {
		const blocked = quarantined.get(key);
		if (blocked) return Promise.reject(blocked);
		if (closed || signal.aborted || stops.has(key)) return Promise.reject(new Error("Messenger request aborted"));
		if (hostRun) hostRun = { ...hostRun };
		let keySignal = keySignals.get(key);
		if (!keySignal) { keySignal = new AbortController(); keySignals.set(key, keySignal); }
		signal = AbortSignal.any([signal, keySignal.signal]);
		const run = () => runTurn(key, command, cwd, env, text, signal, report, policyKey, hostRun).finally(release);
		const admitRun = () => {
			if (closed || signal.aborted) return Promise.reject(new Error("Messenger request aborted"));
			if (admitted < limit && waiting.length === 0) {
				admitted++;
				return run();
			}
			return admit(signal).then(run);
		};
		// Same-key turns run strictly in arrival order. Queued turns hold no admission slot while they wait,
		// so they never block other sessions; different keys are fully independent.
		const previous = keyTails.get(key);
		const result = previous ? waitForTurn(previous, signal).then(admitRun) : admitRun();
		const settled = result.then(() => undefined, () => undefined);
		// The tail also covers the predecessor, so an aborted queued turn never lets its successor overtake it.
		const tail: Promise<void> = previous ? Promise.all([previous, settled]).then(() => undefined) : settled;
		keyTails.set(key, tail);
		void tail.then(() => { if (keyTails.get(key) === tail) { keyTails.delete(key); if (keySignals.get(key) === keySignal) keySignals.delete(key); } });
		return result;
	}

	function waitForTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const abort = () => { cleanup(); reject(new Error("Messenger request aborted")); };
			const cleanup = () => { signal.removeEventListener("abort", abort); closedSignal.signal.removeEventListener("abort", abort); };
			signal.addEventListener("abort", abort, { once: true });
			closedSignal.signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted || closed) { abort(); return; }
			void previous.then(() => { cleanup(); resolve(); });
		});
	}

	async function runTurn(key: string, command: string[], cwd: string, env: Record<string, string>, text: string, signal: AbortSignal, report?: MessengerActivityReporter, policyKey?: string, hostRun?: DiscordRunRef): Promise<string> {
		if (closed || signal.aborted) throw new Error("Messenger request aborted");
		for (;;) {
			const existing = workers.get(key);
			if (existing && (existing.policyKey !== policyKey || Boolean(existing.host) !== Boolean(hostRun) || hostRun && (existing.host?.scope.generation !== hostRun.generation || existing.host.scope.sessionId !== hostRun.sessionId))) {
				if (existing.pending) throw new Error("Messenger conversation is already active");
				retire(key, existing);
			}
			const previousExit = retiring.get(key);
			if (!previousExit) break;
			await waitForExit(previousExit, signal);
		}
		if (closed || signal.aborted) throw new Error("Messenger request aborted");
		if ([...allWorkers].some(([worker, workerKey]) => workerKey === key && worker.pending)) {
			throw new Error("Messenger conversation is already active");
		}
		const worker = workers.get(key) ?? await start(key, command, cwd, env, signal, policyKey, hostRun);
		if (closed || signal.aborted || worker.dead) {
			retire(key, worker);
			throw new Error("Messenger worker stopped");
		}
		if (worker.pending) throw new Error("Messenger conversation is already active");
		if (worker.idleTimer) clearTimeout(worker.idleTimer);
		worker.idleTimer = undefined;
		return await new Promise<string>((resolve, reject) => {
			const abort = () => retire(key, worker);
			const cleanup = () => signal.removeEventListener("abort", abort);
			const pending: Pending = { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); }, report, hostRun, ...(hostRun ? { actions: new AbortController() } : {}) };
			worker.pending = pending;
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) { abort(); return; }
			void (async () => {
				await worker.child.stdin.write(`${JSON.stringify(hostRun ? { type: "host_turn", runId: hostRun.runId, text } : text)}\n`);
				if (!worker.dead) await worker.child.stdin.flush();
				pending.written = true;
				finishTurn(key, worker, pending);
			})().catch(() => retire(key, worker));
		});
	}

	/** Fence this key's queued turns, then require owned cleanup and observed exit before reuse. */
	function stop(key: string): Promise<void> {
		const previous = stops.get(key);
		if (previous) return previous;
		keySignals.get(key)?.abort();
		const stopping = (async () => {
			const owned = [...exits.values()].filter(worker => worker.key === key);
			for (const worker of owned) retire(key, worker);
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					Promise.all(owned.map(worker => worker.exit)),
					new Promise<never>((_, reject) => { timer = setTimeout(() => reject(incomplete("worker cleanup is still pending; key quarantined")), shutdownTimeoutMs * 2); }),
				]);
				if (quarantined.has(key)) throw quarantined.get(key);
			} catch (error) {
				const failure = incomplete(`worker cleanup failed; key quarantined: ${error instanceof Error ? error.message : "unknown failure"}`);
				quarantined.set(key, failure);
				throw failure;
			} finally { clearTimeout(timer); }
		})();
		stops.set(key, stopping);
		void stopping.then(() => { stops.delete(key); keySignals.delete(key); }, () => { /* Failed cleanup retains the quarantine and its rejected stop proof. */ });
		return stopping;
	}

	async function close() {
		closed = true;
		closedSignal.abort();
		for (const [worker, key] of allWorkers) retire(key, worker);
		const waitForExits = async () => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					Promise.allSettled([...exits.keys()]).then(results => {
						const failure = results.find(result => result.status === "rejected");
						if (failure?.status === "rejected" && (requireSandboxCleanup || [...exits.values()].some(worker => worker.host))) throw incomplete(`worker cleanup failed: ${String(failure.reason)}`);
						return true;
					}),
					new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), shutdownTimeoutMs); }),
				]);
			} finally { if (timer) clearTimeout(timer); }
		};
		if (await waitForExits()) return;
		if (requireSandboxCleanup || [...exits.values()].some(worker => worker.host)) throw incomplete("worker cleanup is still pending; cleanup owner retained");
		for (const worker of exits.values()) forceKill(worker);
		if (!(await waitForExits())) throw new Error("Messenger workers did not exit after forced termination");
	}

	return { turn, stop, close };
}
