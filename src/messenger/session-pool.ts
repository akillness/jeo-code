import type { MessengerActivityReporter } from "./types";

interface WorkerProcess {
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
	written?: boolean;
}

interface Worker {
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
	idleTimer?: ReturnType<typeof setTimeout>;
	exitTimer?: ReturnType<typeof setTimeout>;
}

/** Resident sessions the pool keeps, and the number of turns it runs at once. */
export const MESSENGER_SESSION_LIMIT = 16;

export function createMessengerSessionPool(spawn: typeof Bun.spawn = Bun.spawn, limit = MESSENGER_SESSION_LIMIT, idleTimeoutMs = 5 * 60_000, shutdownTimeoutMs = 5_000, options: { requireSandboxCleanup?: boolean } = {}) {
	const workers = new Map<string, Worker>();
	const allWorkers = new Map<Worker, string>();
	const exits = new Map<Promise<number>, Worker>();
	const retiring = new Map<string, Promise<number>>();
	const keyTails = new Map<string, Promise<void>>();
	const requireSandboxCleanup = options.requireSandboxCleanup === true;
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

	function retire(key: string, worker: Worker) {
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
		worker.pending?.reject(new Error("Messenger worker stopped"));
		worker.pending = undefined;
		if (!worker.exited) {
			if (worker.cleanupNonce) {
				// Protected workers never receive a kill signal: Windows cannot deliver a catchable SIGTERM.
				// Shutdown is a private IPC message; a missing or failing channel is visible, never success.
				const channel = worker.child.send;
				if (typeof channel !== "function") {
					worker.cleanupError = incomplete("worker shutdown channel unavailable");
				} else {
					try {
						const sent = channel.call(worker.child, { type: "jeo_messenger_shutdown", nonce: worker.cleanupNonce });
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
		worker.pending = undefined;
		if (worker.exited) {
			retire(key, worker);
		} else {
			worker.lastUsed = ++tick;
			worker.idleTimer = setTimeout(() => retire(key, worker), idleTimeoutMs);
			worker.idleTimer.unref();
		}
		pending.resolve(pending.result);
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

	async function start(key: string, command: string[], cwd: string, env: Record<string, string>, signal: AbortSignal, policyKey?: string): Promise<Worker> {
		while ((requireSandboxCleanup ? allWorkers.size : workers.size) >= limit) {
			const idle = [...workers.entries()].filter(([, worker]) => !worker.pending).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
			if (!idle) {
				const retiringWorker = requireSandboxCleanup ? [...allWorkers.keys()].find(worker => worker.dead) : undefined;
				if (!retiringWorker) throw new Error("Messenger worker capacity reached");
				await waitForExit(retiringWorker.exit, signal, true);
				continue;
			}
			retire(idle[0], idle[1]);
			if (requireSandboxCleanup) await waitForExit(idle[1].exit, signal, true);
		}
		if (closed || signal.aborted) throw new Error("Messenger request aborted");
		const cleanupNonce = requireSandboxCleanup ? crypto.randomUUID() : undefined;
		const workerEnv = { ...env };
		delete workerEnv.JEO_MESSENGER_SHUTDOWN_NONCE;
		if (cleanupNonce) workerEnv.JEO_MESSENGER_SHUTDOWN_NONCE = cleanupNonce;
		const spawnOptions = { cwd, env: workerEnv, stdin: "pipe", stdout: "pipe", stderr: "pipe", ...(cleanupNonce ? { ipc() {}, serialization: "json" } : {}) };
		const child = spawn(command, spawnOptions as never) as unknown as WorkerProcess;
		const cleanup = Promise.withResolvers<number>();
		const worker: Worker = { child, exit: cleanupNonce ? cleanup.promise : child.exited, cleanupNonce, policyKey, lastUsed: ++tick, dead: false };
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
					if (typeof ack === "object" && ack !== null && "nonce" in ack && ack.nonce === cleanupNonce && "gone" in ack) {
						worker.cleanupGone = ack.gone === true;
						worker.cleanupError = worker.cleanupGone ? undefined : incomplete("worker supervisor cleanup failed");
					}
				} catch { /* Unauthenticated or malformed output is never cleanup proof. */ }
				return;
			}
			if (line.startsWith("JEO_MESSENGER_ACTIVITY ")) {
				const activityText = line.slice("JEO_MESSENGER_ACTIVITY ".length).trim();
				if (activityText) worker.pending?.report?.(activityText);
			} else if (line === "JEO_MESSENGER_STEP") {
				worker.pending?.report?.("Working on your request");
			}
		}).catch(() => retire(key, worker));
		if (cleanupNonce) {
			void Promise.all([child.exited, stderrDone, stdoutDone]).then(([code]) => {
				if (worker.cleanupGone) cleanup.resolve(code);
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
		return worker;
	}

	function turn(key: string, command: string[], cwd: string, env: Record<string, string>, text: string, signal: AbortSignal, report?: MessengerActivityReporter, policyKey?: string): Promise<string> {
		if (closed || signal.aborted) return Promise.reject(new Error("Messenger request aborted"));
		const run = () => runTurn(key, command, cwd, env, text, signal, report, policyKey).finally(release);
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
		void tail.then(() => { if (keyTails.get(key) === tail) keyTails.delete(key); });
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

	async function runTurn(key: string, command: string[], cwd: string, env: Record<string, string>, text: string, signal: AbortSignal, report?: MessengerActivityReporter, policyKey?: string): Promise<string> {
		if (closed || signal.aborted) throw new Error("Messenger request aborted");
		for (;;) {
			const existing = workers.get(key);
			if (existing && existing.policyKey !== policyKey) {
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
		const worker = workers.get(key) ?? await start(key, command, cwd, env, signal, policyKey);
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
			const pending: Pending = { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); }, report };
			worker.pending = pending;
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) { abort(); return; }
			void (async () => {
				await worker.child.stdin.write(`${JSON.stringify(text)}\n`);
				if (!worker.dead) await worker.child.stdin.flush();
				pending.written = true;
				finishTurn(key, worker, pending);
			})().catch(() => retire(key, worker));
		});
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
						if (failure?.status === "rejected" && requireSandboxCleanup) throw incomplete(`worker cleanup failed: ${String(failure.reason)}`);
						return true;
					}),
					new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), shutdownTimeoutMs); }),
				]);
			} finally { if (timer) clearTimeout(timer); }
		};
		if (await waitForExits()) return;
		if (requireSandboxCleanup) throw incomplete("worker cleanup is still pending; cleanup owner retained");
		for (const worker of exits.values()) forceKill(worker);
		if (!(await waitForExits())) throw new Error("Messenger workers did not exit after forced termination");
	}

	return { turn, close };
}
