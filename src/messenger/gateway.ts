import { MessengerHttpError } from "./http";
import { DiscordModelSelectionError } from "./model-selection";
import type {
	MessengerActivityReporter,
	MessengerAdapter,
	MessengerConfig,
	MessengerMessage,
	MessengerReply,
} from "./types";
import { MessengerFatalError, MessengerUnverifiedReplyError } from "./types";

const MAX_MESSAGE_LENGTH = 32_000;
const MAX_QUEUED_MESSAGES = 100;
const MAX_SEEN_MESSAGES = 10_000;
const STATUS_TIMEOUT_MS = 1000;
const MAX_STATUS_IN_FLIGHT = 8;
const MAX_ACTIVITY_LENGTH = 120;
// Status edits are cosmetic: keep them sparse so they never compete with reply delivery for rate limits.
const ACTIVITY_INTERVAL_MS = 2_000;
const ACTIVITY_TIMEOUT_MS = 3_000;

/** Collapse to one bounded line: drop invisible format characters, fold control and whitespace runs. */
export function activityLine(text: string): string {
	const line = text
		.replace(/\p{Cf}/gu, "")
		.replace(/[\p{Cc}\p{Z}\s]+/gu, " ")
		.trim();
	if (line.length <= MAX_ACTIVITY_LENGTH) return line;
	let end = MAX_ACTIVITY_LENGTH - 1;
	const last = line.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end--;
	return `${line.slice(0, end).trimEnd()}…`;
}

export interface ActivityReporter {
	report: MessengerActivityReporter;
	/** Stop updates and finalize the status; idempotent and never rejects. */
	close(outcome?: "success" | "failure" | "cancelled"): Promise<void>;
}

const NO_ACTIVITY: ActivityReporter = { report() {}, close: () => Promise.resolve() };

/**
 * Bound a cosmetic adapter call: a stalled provider request must not hold up the request queue. A timeout
 * rejects so callers can retry; cancellation through `signal` resolves because the request is ending.
 */
async function boundedActivity(run: (signal: AbortSignal) => Promise<void>, signal?: AbortSignal): Promise<void> {
	const timeout = new AbortController();
	const callSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
	const stopped = Promise.withResolvers<void>();
	const onStop = (): void => {
		if (timeout.signal.aborted) stopped.reject(new Error("Messenger activity update timed out"));
		else stopped.resolve();
	};
	callSignal.addEventListener("abort", onStop, { once: true });
	const timer = setTimeout(() => timeout.abort(), ACTIVITY_TIMEOUT_MS);
	try {
		await Promise.race([Promise.resolve().then(() => run(callSignal)), stopped.promise]);
	} finally {
		clearTimeout(timer);
		callSignal.removeEventListener("abort", onStop);
	}
}

/**
 * Coalesce a request's activity into one status line: show the first report at once, then at most the
 * latest line per interval. Removal skips the request signal so an aborted request still retires its line.
 */
export function createActivityReporter(
	adapter: MessengerAdapter,
	destination: MessengerMessage,
	signal: AbortSignal,
	intervalMs: number,
): ActivityReporter {
	const activity = adapter.activity;
	if (!activity) return NO_ACTIVITY;
	let latest: string | undefined;
	let sent: string | undefined;
	let shown = false;
	let closed = false;
	let pumping = false;
	let pump = Promise.resolve();
	let nextAt = 0;
	let wake: (() => void) | undefined;
	let closing: Promise<void> | undefined;
	const pause = async (ms: number): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const timer = setTimeout(resolve, ms);
		wake = () => {
			clearTimeout(timer);
			resolve();
		};
		try {
			await promise;
		} finally {
			wake = undefined;
		}
	};
	const run = async (): Promise<void> => {
		try {
			while (!closed && !signal.aborted && latest !== sent) {
				const delay = nextAt - Date.now();
				if (delay > 0) {
					await pause(delay);
					continue;
				}
				const text = latest;
				sent = text;
				shown = true;
				let spacing = intervalMs;
				try {
					await boundedActivity(bounded => activity.call(adapter, destination, text, bounded), signal);
				} catch (error) {
					if (error instanceof MessengerHttpError && error.status === 429) {
						// Keep the line pending: a rate-limited update is retried unless a newer line replaces it.
						sent = undefined;
						spacing = Math.max(spacing, error.retryAfterMs ?? 1_000);
					}
				}
				nextAt = Date.now() + spacing;
			}
		} finally {
			pumping = false;
		}
	};
	return {
		report(text) {
			if (closed || signal.aborted) return;
			const line = activityLine(text);
			if (!line) return;
			latest = line;
			if (pumping) return;
			pumping = true;
			pump = run();
		},
		close(outcome = "success") {
			closing ??= (async () => {
				closed = true;
				wake?.();
				await pump;
				if (!shown) return;
				for (let attempt = 0; ; attempt++) {
					try {
						await boundedActivity(bounded => activity.call(adapter, destination, undefined, bounded, outcome));
						return;
					} catch (error) {
						const wait =
							error instanceof MessengerHttpError && error.status === 429
								? (error.retryAfterMs ?? 1_000)
								: 1_000;
						// One bounded retry: removal holds the request queue.
						if (attempt > 0 || wait > ACTIVITY_TIMEOUT_MS) return;
						await Bun.sleep(wait);
					}
				}
			})();
			return closing;
		},
	};
}

type OptionalIdentity = readonly ["absent"] | readonly ["present", string];

/**
 * Canonical, ordered remote-session identity. `thread` and `conversation` are mutually exclusive
 * alternatives; Discord supplies `thread`, while adapters with another conversation primitive may
 * supply `conversation`. IDs are opaque and therefore are never trimmed or case-folded.
 */
export type MessengerSessionIdentity = readonly [
	version: "messenger-session-v1",
	platform: MessengerMessage["platform"],
	account: string,
	guild: OptionalIdentity,
	channel: string,
	thread: OptionalIdentity,
	conversation: OptionalIdentity,
	user: OptionalIdentity,
];

function optionalIdentity(name: string, value: string | undefined): OptionalIdentity {
	if (value === undefined) return ["absent"];
	if (!value || value.trim() !== value) throw new Error(`Messenger ${name} identifier is invalid`);
	return ["present", value];
}

export function messengerSessionIdentity(message: MessengerMessage): MessengerSessionIdentity {
	if (message.threadId !== undefined && message.conversationId !== undefined) {
		throw new Error("Messenger thread and conversation identifiers are mutually exclusive");
	}
	for (const [name, value] of [
		["account", message.accountId],
		["channel", message.parentChannelId ?? message.channelId],
		["user", message.senderId],
	] as const) {
		if (!value || value.trim() !== value) throw new Error(`Messenger ${name} identifier is invalid`);
	}
	return [
		"messenger-session-v1",
		message.platform,
		message.accountId,
		optionalIdentity("guild", message.guildId),
		message.parentChannelId ?? message.channelId,
		optionalIdentity("thread", message.threadId),
		optionalIdentity("conversation", message.conversationId),
		message.platform === "discord" && message.threadId !== undefined ? ["absent"] : ["present", message.senderId],
	];
}

/** Collision-safe JSON serialization of the canonical identity tuple. */
export function messengerConversationKey(message: MessengerMessage): string {
	return JSON.stringify(messengerSessionIdentity(message));
}

/** Stable per-conversation route shared by the persisted session file and its session process. */
export function messengerSessionRoute(cwd: string, message: MessengerMessage): string {
	return new Bun.CryptoHasher("sha256").update(JSON.stringify([cwd, messengerConversationKey(message)])).digest("hex");
}

/**
 * Admission lane. A top-level message has no thread yet, so only its raw channel can order it against its
 * neighbours; anything already resolved is ordered by its own conversation. A lane is held only until the request
 * is queued, never while it runs, so it cannot serialize requests that end up in different threads.
 */
function admissionKey(message: MessengerMessage, adapter: MessengerAdapter): string {
	if (adapter.prepare && !message.direct && !message.threadId && !message.parentChannelId) {
		return JSON.stringify([message.platform, message.accountId, message.guildId, message.channelId, message.platform === "discord" ? null : message.senderId]);
	}
	return messengerConversationKey(message);
}

export function isMessengerMessageAllowed(message: MessengerMessage, config: MessengerConfig): boolean {
	const platform = config.platforms[message.platform];
	return Boolean(
		platform &&
			message.accountId &&
			message.channelId &&
			message.senderId &&
			message.messageId &&
			(message.text.trim() ||
				(message.platform === "discord" && config.platforms.discord?.artifactDir && message.attachments?.length)) &&
			message.text.length <= MAX_MESSAGE_LENGTH &&
			platform.allowedUserIds.includes(message.senderId) &&
			(!platform.allowedChannelIds ||
				platform.allowedChannelIds.includes(message.channelId) ||
				(Boolean(message.parentChannelId) && platform.allowedChannelIds.includes(message.parentChannelId!))) &&
			(message.direct || message.mentioned || (message.platform === "discord" && Boolean(message.parentChannelId))),
	);
}

interface PendingMessage {
	/** Prepared destination: replies, deliveries and activity target it. */
	message: MessengerMessage;
	adapter: MessengerAdapter;
	signal: AbortSignal;
	resolve: () => void;
	/** Destination conversation key; requests sharing it never run at the same time. */
	key: string;
	/** Status reactions on the user's original message. */
	status: (state: "processing" | "success" | "failure") => void;
}

export interface MessengerGateway {
	run(signal: AbortSignal): Promise<void>;
	handle(message: MessengerMessage, signal?: AbortSignal): Promise<void>;
}

export interface MessengerGatewayOptions {
	/** Minimum spacing between in-place activity edits for one request. */
	activityIntervalMs?: number;
	/**
	 * Requests processed at once (default 1). Requests of one conversation answer and deliver in arrival order and
	 * wait in the queue, not in a slot, behind their predecessor; above 1 the reply implementation must accept
	 * concurrent turns for different conversations.
	 */
	concurrency?: number;
	/** Authenticated human controls bypass model queues, including busy sessions. */
	sandboxControl?: (message: MessengerMessage, signal: AbortSignal) => Promise<{ handled: boolean; output: string }>;
	/**
	 * Operator log for a request that failed before or during delivery. Users see the generic failure text, except
	 * an unverified completion, whose marked answer is delivered; this is the one place the cause is observable,
	 * and it receives the conversation, never message text.
	 */
	onRequestError?: (message: MessengerMessage, error: unknown, stage: "prepare" | "reply" | "deliver") => void;
}

export function createMessengerGateway(
	config: MessengerConfig,
	adapters: MessengerAdapter[],
	reply: MessengerReply,
	options: MessengerGatewayOptions = {},
): MessengerGateway {
	const activityIntervalMs = Math.max(0, options.activityIntervalMs ?? ACTIVITY_INTERVAL_MS);
	const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 1));
	const byPlatform = new Map(adapters.map(adapter => [adapter.platform, adapter]));
	if (byPlatform.size !== adapters.length) throw new Error("Duplicate messenger adapter");
	for (const platform of Object.keys(config.platforms)) {
		if (!adapters.some(adapter => adapter.platform === platform))
			throw new Error("Missing configured messenger adapter");
	}
	const seen = new Set<string>();
	const queue: PendingMessage[] = [];
	const reportError = (message: MessengerMessage, error: unknown, stage: "prepare" | "reply" | "deliver"): void => {
		try { options.onRequestError?.(message, error, stage); } catch { /* Operator logging never affects the request. */ }
	};
	const activeKeys = new Set<string>();
	const turns = new Set<Promise<void>>();
	/** Orders admission (sandbox control, capacity check, destination preparation) per raw lane. */
	const admissionTails = new Map<string, Promise<void>>();
	/** Requests holding a queue slot while the adapter prepares their destination; counted against the queue cap. */
	let preparing = 0;
	const lifetime = new AbortController();
	let running = false;
	let fatalError: MessengerFatalError | undefined;
	let statusInFlight = 0;

	function createStatusReporter(
		adapter: MessengerAdapter,
		message: MessengerMessage,
		signal: AbortSignal,
	): (state: "processing" | "success" | "failure") => void {
		let statusChain = Promise.resolve();
		return state => {
			if (!adapter.status) return;
			statusChain = statusChain.then(async () => {
				if (signal.aborted || statusInFlight >= MAX_STATUS_IN_FLIGHT) return;
				const timeout = new AbortController();
				const statusSignal = AbortSignal.any([signal, timeout.signal]);
				const stopped = Promise.withResolvers<void>();
				const onAbort = (): void => stopped.resolve();
				statusSignal.addEventListener("abort", onAbort, { once: true });
				statusInFlight++;
				const operation = Promise.resolve().then(() => adapter.status!(message, state, statusSignal));
				void operation.then(
					() => {
						statusInFlight--;
					},
					() => {
						statusInFlight--;
					},
				);
				const timer = setTimeout(() => timeout.abort(), STATUS_TIMEOUT_MS);
				try {
					await Promise.race([operation, stopped.promise]);
				} catch {
					/* best-effort status reaction */
				} finally {
					clearTimeout(timer);
					statusSignal.removeEventListener("abort", onAbort);
				}
			});
		};
	}

	async function processRequest(pending: PendingMessage): Promise<void> {
		const { message, adapter, signal, resolve, status } = pending;
		let failed = false;
		let activity = NO_ACTIVITY;
		try {
			if (signal.aborted) return;
			status("processing");
			activity = createActivityReporter(adapter, message, signal, activityIntervalMs);
			activity.report("Starting request");
			let text: string;
			try {
				text = await reply(message, signal, activity.report);
			} catch (error) {
				failed = true;
				if (error instanceof MessengerFatalError) {
					fatalError = error;
					status("failure");
					lifetime.abort();
					return;
				}
				if (signal.aborted) return;
				reportError(message, error, "reply");
				text = error instanceof MessengerUnverifiedReplyError
					? error.reply
					: error instanceof DiscordModelSelectionError
						? "Discord could not verify a model. Ask the operator to configure an explicit Discord model, check provider credentials and live model discovery, then restart the messenger service."
						: "The request could not be completed. Please try again.";
			}
			if (!signal.aborted && text.trim()) {
				// A failed send may already have delivered a chunk: never retry the entire reply.
				await adapter.send(message, text, signal);
			}
			if (!signal.aborted) status(failed ? "failure" : "success");
		} catch (error) {
			failed = true;
			if (!signal.aborted) { status("failure"); reportError(message, error, "deliver"); }
		} finally {
			await activity.close(failed ? "failure" : signal.aborted ? "cancelled" : "success");
			resolve();
		}
	}

	/** Start queued requests in arrival order while capacity allows, skipping conversations already running. */
	function schedule(): void {
		for (let index = 0; index < queue.length && turns.size < concurrency; ) {
			const pending = queue[index]!;
			if (activeKeys.has(pending.key)) {
				index++;
				continue;
			}
			queue.splice(index, 1);
			activeKeys.add(pending.key);
			const turn = processRequest(pending).finally(() => {
				activeKeys.delete(pending.key);
				turns.delete(turn);
				schedule();
			});
			turns.add(turn);
		}
	}

	async function handle(message: MessengerMessage, signal?: AbortSignal): Promise<void> {
		const adapter = byPlatform.get(message.platform);
		const effectiveSignal = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
		if (effectiveSignal.aborted || !adapter || !isMessengerMessageAllowed(message, config)) return Promise.resolve();
		const id = JSON.stringify([message.platform, message.accountId, message.channelId, message.messageId]);
		if (seen.has(id)) return;
		seen.add(id);
		if (seen.size > MAX_SEEN_MESSAGES) {
			const oldest = seen.values().next().value;
			if (oldest !== undefined) seen.delete(oldest);
		}
		const lane = admissionKey(message, adapter);
		const previous = admissionTails.get(lane) ?? Promise.resolve();
		const ready = Promise.withResolvers<void>();
		const tail = previous.then(() => ready.promise);
		admissionTails.set(lane, tail);
		void tail.then(() => { if (admissionTails.get(lane) === tail) admissionTails.delete(lane); });
		try {
			if (options.sandboxControl) {
				const control = await options.sandboxControl(message, effectiveSignal);
				if (control.handled) {
					if (!effectiveSignal.aborted && control.output.trim()) await adapter.send(message, control.output, effectiveSignal);
					return;
				}
			}
			await previous;
			if (effectiveSignal.aborted) return;
			const status = createStatusReporter(adapter, message, effectiveSignal);
			// Capacity is claimed before preparing: a request that cannot be queued must never create a thread.
			if (queue.length + preparing >= MAX_QUEUED_MESSAGES) {
				// Never executed, so forget the id: a redelivery is accepted once capacity returns, replaying nothing.
				seen.delete(id);
				status("failure");
				return;
			}
			let destination: MessengerMessage;
			let key: string;
			preparing++;
			try {
				destination = (await adapter.prepare?.(message, effectiveSignal)) ?? message;
				key = messengerConversationKey(destination);
			} catch (error) {
				if (!effectiveSignal.aborted) { status("failure"); reportError(message, error, "prepare"); }
				return;
			} finally {
				preparing--;
			}
			if (effectiveSignal.aborted) return;
			const { promise, resolve } = Promise.withResolvers<void>();
			queue.push({ message: destination, adapter, signal: effectiveSignal, resolve, key, status });
			schedule();
			return promise;
		} finally { ready.resolve(); }
	}

	return {
		handle,
		async run(signal) {
			if (running || lifetime.signal.aborted) throw new Error("Messenger gateway cannot be restarted");
			running = true;
			const abort = (): void => lifetime.abort();
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			const starts: Promise<void>[] = [];
			try {
				if (lifetime.signal.aborted) return;
				for (const adapter of adapters) {
					starts.push(
						Promise.resolve().then(async () => {
							await adapter.start(msg => handle(msg, lifetime.signal), lifetime.signal);
							if (!lifetime.signal.aborted) throw new Error(`${adapter.platform} adapter stopped unexpectedly`);
						}),
					);
				}
				await Promise.all(starts);
			} catch (error) {
				lifetime.abort();
				await Promise.allSettled(starts);
				throw fatalError ?? error;
			} finally {
				lifetime.abort();
				signal.removeEventListener("abort", abort);
				while (queue.length > 0) queue.shift()?.resolve();
				await Promise.allSettled(turns);
				if (fatalError) throw fatalError;
			}
		},
	};
}
