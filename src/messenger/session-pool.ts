import type { MessengerActivityReporter } from "./types";

interface WorkerProcess {
	stdin: { write(data: string): unknown; flush(): unknown; end(): unknown };
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	kill(): void;
}

interface Pending {
	resolve(text: string): void;
	reject(error: Error): void;
	report?: MessengerActivityReporter;
}

interface Worker {
	child: WorkerProcess;
	pending?: Pending;
	lastUsed: number;
	dead: boolean;
}

export function createMessengerSessionPool(spawn: typeof Bun.spawn = Bun.spawn, limit = 16) {
	const workers = new Map<string, Worker>();
	let closed = false;
	let tick = 0;

	function retire(key: string, worker: Worker) {
		if (worker.dead) return;
		worker.dead = true;
		if (workers.get(key) === worker) workers.delete(key);
		worker.pending?.reject(new Error("Messenger worker stopped"));
		worker.pending = undefined;
		worker.child.kill();
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
		workers.set(key, worker);
		void readLines(child.stdout, line => {
			const pending = worker.pending;
			if (!pending) return;
			if (line === "JEO_MESSENGER_ERROR") { retire(key, worker); return; }
			if (!line.startsWith("JEO_MESSENGER_RESULT ")) return;
			try {
				const text: unknown = JSON.parse(line.slice("JEO_MESSENGER_RESULT ".length));
				if (typeof text !== "string" || !text.trim()) throw new Error("Invalid response");
				worker.pending = undefined;
				worker.lastUsed = ++tick;
				pending.resolve(text);
			} catch { retire(key, worker); }
		}).catch(() => retire(key, worker));
		void readLines(child.stderr, line => {
			if (line === "JEO_MESSENGER_STEP") worker.pending?.report?.("Working on your request");
		}).catch(() => retire(key, worker));
		void child.exited.then(() => retire(key, worker), () => retire(key, worker));
		return worker;
	}

	async function turn(key: string, command: string[], cwd: string, env: Record<string, string>, text: string, signal: AbortSignal, report?: MessengerActivityReporter): Promise<string> {
		if (closed || signal.aborted) throw new Error("Messenger request aborted");
		const worker = workers.get(key) ?? start(key, command, cwd, env);
		if (worker.pending) throw new Error("Messenger conversation is already active");
		return await new Promise<string>((resolve, reject) => {
			const abort = () => retire(key, worker);
			const cleanup = () => signal.removeEventListener("abort", abort);
			worker.pending = { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); }, report };
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) { abort(); return; }
			void (async () => {
				await worker.child.stdin.write(`${JSON.stringify(text)}\n`);
				if (!worker.dead) await worker.child.stdin.flush();
			})().catch(() => retire(key, worker));
		});
	}

	async function close() {
		closed = true;
		const all = [...workers.entries()];
		for (const [key, worker] of all) retire(key, worker);
		await Promise.allSettled(all.map(([, worker]) => worker.child.exited));
	}

	return { turn, close };
}
