import type { MessengerActivityReporter } from "./types";

interface WorkerProcess {
	stdin: { write(data: string): unknown; flush(): unknown; end(): unknown };
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	kill(signal?: number | NodeJS.Signals): void;
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
	pending?: Pending;
	lastUsed: number;
	dead: boolean;
	exited?: boolean;
	idleTimer?: ReturnType<typeof setTimeout>;
	exitTimer?: ReturnType<typeof setTimeout>;
}

export function createMessengerSessionPool(spawn: typeof Bun.spawn = Bun.spawn, limit = 16, idleTimeoutMs = 5 * 60_000, shutdownTimeoutMs = 5_000) {
	const workers = new Map<string, Worker>();
	const allWorkers = new Map<Worker, string>();
	const exits = new Map<Promise<number>, WorkerProcess>();
	const retiring = new Map<string, Promise<number>>();

	let closed = false;
	const closedSignal = new AbortController();

	let tick = 0;

	function retire(key: string, worker: Worker) {
		if (worker.dead) return;
		worker.dead = true;
		if (workers.get(key) === worker) workers.delete(key);
		allWorkers.delete(worker);
		if (!worker.exited) {
			retiring.set(key, worker.child.exited);
			void worker.child.exited.then(
				() => { if (retiring.get(key) === worker.child.exited) retiring.delete(key); },
				() => { if (retiring.get(key) === worker.child.exited) retiring.delete(key); },
			);
		}
		if (worker.idleTimer) clearTimeout(worker.idleTimer);
		if (worker.exitTimer) clearTimeout(worker.exitTimer);
		worker.idleTimer = undefined;
		worker.pending?.reject(new Error("Messenger worker stopped"));
		worker.pending = undefined;
		if (!worker.exited) {
			try { worker.child.kill(); } catch { /* Shutdown will attempt forced termination. */ }
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

	function start(key: string, command: string[], cwd: string, env: Record<string, string>): Worker {
		if (workers.size >= limit) {
			const idle = [...workers.entries()].filter(([, worker]) => !worker.pending).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
			if (!idle) throw new Error("Messenger worker capacity reached");
			retire(idle[0], idle[1]);
		}
		const child = spawn(command, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" }) as unknown as WorkerProcess;
		const worker: Worker = { child, lastUsed: ++tick, dead: false };
		exits.set(child.exited, child);
		void child.exited.then(() => exits.delete(child.exited), () => exits.delete(child.exited));
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
		void readLines(child.stderr, line => {
			if (line.startsWith("JEO_MESSENGER_ACTIVITY ")) {
				const activityText = line.slice("JEO_MESSENGER_ACTIVITY ".length).trim();
				if (activityText) worker.pending?.report?.(activityText);
			} else if (line === "JEO_MESSENGER_STEP") {
				worker.pending?.report?.("Working on your request");
			}
		}).catch(() => retire(key, worker));
		void child.exited.then(() => {
			if (worker.dead) return;
			worker.exited = true;
			if (workers.get(key) === worker) workers.delete(key);
			worker.exitTimer = setTimeout(() => retire(key, worker), shutdownTimeoutMs);
			worker.exitTimer.unref();
			void stdoutDone.then(() => {
				if (!worker.pending?.result || worker.pending.written) retire(key, worker);
			});
		}, () => retire(key, worker));
		return worker;
	}

	async function turn(key: string, command: string[], cwd: string, env: Record<string, string>, text: string, signal: AbortSignal, report?: MessengerActivityReporter): Promise<string> {
		if (closed || signal.aborted) throw new Error("Messenger request aborted");
		const previousExit = retiring.get(key);
		if (previousExit) {
			await new Promise<void>((resolve, reject) => {
				const abort = () => { cleanup(); reject(new Error("Messenger request aborted")); };
				const cleanup = () => { signal.removeEventListener("abort", abort); closedSignal.signal.removeEventListener("abort", abort); };
				signal.addEventListener("abort", abort, { once: true });
				closedSignal.signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted || closed) { abort(); return; }
				void previousExit.then(() => { cleanup(); resolve(); }, () => { cleanup(); resolve(); });
			});
		}
		if (closed || signal.aborted) throw new Error("Messenger request aborted");
		if ([...allWorkers].some(([worker, workerKey]) => workerKey === key && worker.pending)) {
			throw new Error("Messenger conversation is already active");
		}
		const worker = workers.get(key) ?? start(key, command, cwd, env);
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
					Promise.allSettled([...exits.keys()]).then(() => true),
					new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), shutdownTimeoutMs); }),
				]);
			} finally { if (timer) clearTimeout(timer); }
		};
		if (await waitForExits()) return;
		for (const child of exits.values()) {
			try { child.kill("SIGKILL"); } catch { /* The process may have exited concurrently. */ }
		}
		if (!(await waitForExits())) throw new Error("Messenger workers did not exit after forced termination");
	}

	return { turn, close };
}
