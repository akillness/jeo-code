import { readMessengerArtifacts } from "./artifacts";
import { resolveMessengerToken } from "./config";
import { MessengerHttpError, messengerFetchJson } from "./http";
import {
	isRecord,
	type DiscordThreadLifecycle,
	type MessengerAdapter,
	type MessengerMessage,
	type MessengerPlatformConfig,
	type MessengerTransportDeps,
} from "./types";

export const DISCORD_API = "https://discord.com/api/v10";
export const DISCORD_GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const PERMANENT_CLOSE_CODES: Record<number, true> = {
	4004: true,
	4010: true,
	4011: true,
	4012: true,
	4013: true,
	4014: true,
};

// Discord strips boundary whitespace. Invisible guards preserve it in message content;
// they are part of the delivered text, and consume one UTF-16 unit each.
const DISCORD_WHITESPACE = /^[\s\u0085\u001c-\u001f]$/u;
const DISCORD_BOUNDARY_GUARD = "\u200b";
// SUPPRESS_EMBEDS | SUPPRESS_NOTIFICATIONS: a status line never unfurls links or pings on creation.
const DISCORD_ACTIVITY_FLAGS = (1 << 2) | (1 << 12);

function splitDiscordText(text: string): { chunks: string[]; needsAttachment: boolean } {
	const chunks: string[] = [];
	let needsAttachment = false;
	for (let start = 0; start < text.length; ) {
		const leadingGuard = DISCORD_WHITESPACE.test(text[start]!) ? DISCORD_BOUNDARY_GUARD : "";
		let fallback = 0;
		let end = Math.min(start + 2_000 - leadingGuard.length, text.length);
		for (; end > start; end--) {
			const last = text.charCodeAt(end - 1);
			if (end < text.length && last >= 0xd800 && last <= 0xdbff) continue;
			const trailingWhitespace = DISCORD_WHITESPACE.test(text[end - 1]!);
			if (end - start + leadingGuard.length + Number(trailingWhitespace) > 2_000) continue;
			if (!fallback) fallback = end;
			if (end === text.length || (!trailingWhitespace && !DISCORD_WHITESPACE.test(text[end]!))) break;
		}
		if (end === start) end = fallback;
		const chunk = text.slice(start, end);
		const trailingGuard = DISCORD_WHITESPACE.test(chunk[chunk.length - 1]!) ? DISCORD_BOUNDARY_GUARD : "";
		if (leadingGuard || trailingGuard) needsAttachment = true;
		chunks.push(`${leadingGuard}${chunk}${trailingGuard}`);
		start = end;
	}
	return { chunks, needsAttachment };
}

class DiscordConfigurationError extends Error {}

export interface DiscordClock {
	/** Schedule once and return an idempotent cancellation function. */
	schedule(callback: () => void, delayMs: number): () => void;
	random(): number;
}

export interface DiscordTransportDeps extends MessengerTransportDeps {
	clock?: DiscordClock;
	/** Authorize the exact already-loaded project files; response.txt is ordinary response text. */
	authorizeArtifacts?: (message: MessengerMessage, files: readonly { name: string; data: Uint8Array }[], signal: AbortSignal) => Promise<void>;
}

const defaultClock: DiscordClock = {
	schedule(callback, delayMs) {
		const timer = setTimeout(callback, delayMs);
		return () => clearTimeout(timer);
	},
	random: Math.random,
};

function waitForReconnect(delayMs: number, signal: AbortSignal, clock: DiscordClock): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	const result = Promise.withResolvers<void>();
	const finish = (): void => {
		cancel();
		signal.removeEventListener("abort", finish);
		result.resolve();
	};
	const cancel = clock.schedule(finish, delayMs);
	signal.addEventListener("abort", finish, { once: true });
	if (signal.aborted) finish();
	return result.promise;
}

interface DiscordSession {
	id?: string;
	url?: string;
	sequence: number | null;
}

export function discordGatewayUrl(value: unknown): string {
	let url: URL;
	try {
		if (typeof value !== "string") throw new Error();
		url = new URL(value);
	} catch {
		throw new DiscordConfigurationError("Discord returned an invalid Gateway URL");
	}
	if (
		url.protocol !== "wss:" ||
		!/^gateway(?:-[a-z0-9-]+)?\.discord\.gg$/.test(url.hostname) ||
		url.username ||
		url.password ||
		url.port ||
		url.hash ||
		url.pathname !== "/"
	) {
		throw new DiscordConfigurationError("Discord returned an untrusted Gateway URL");
	}
	url.search = "?v=10&encoding=json";
	return url.href;
}

function clearSession(session: DiscordSession): void {
	session.id = undefined;
	session.url = undefined;
	session.sequence = null;
}

function normalizeMessage(value: unknown, accountId: string): MessengerMessage | undefined {
	if (!isRecord(value) || !isRecord(value.author)) return;
	if (value.author.bot || value.webhook_id || value.author.id === accountId) return;
	if (
		typeof value.id !== "string" ||
		!value.id ||
		typeof value.channel_id !== "string" ||
		!value.channel_id ||
		(value.guild_id !== undefined && (typeof value.guild_id !== "string" || !value.guild_id)) ||
		typeof value.author.id !== "string" ||
		!value.author.id ||
		typeof value.content !== "string" ||
		(!value.content.trim() && !(Array.isArray(value.attachments) && value.attachments.length > 0)) ||
		(value.type !== undefined && value.type !== 0 && value.type !== 19)
	)
		return;
	const mentioned =
		Array.isArray(value.mentions) && value.mentions.some(user => isRecord(user) && user.id === accountId);
	const text = value.content.replaceAll(`<@${accountId}>`, "").replaceAll(`<@!${accountId}>`, "").trim();
	const attachments = Array.isArray(value.attachments)
		? value.attachments.map(item =>
				isRecord(item) &&
				typeof item.url === "string" &&
				typeof item.filename === "string" &&
				typeof item.size === "number"
					? { url: item.url, filename: item.filename, size: item.size }
					: { url: "", filename: "", size: -1 },
			)
		: [];
	if (!text && attachments.length === 0) return;
	return {
		platform: "discord",
		accountId,
		channelId: value.channel_id,
		senderId: value.author.id,
		messageId: value.id,
		text,
		...(typeof value.guild_id === "string" && value.guild_id ? { guildId: value.guild_id } : {}),
		direct: value.guild_id === undefined,
		attachments,
		mentioned,
	};
}

function connectGateway(
	url: string,
	token: string,
	accountId: string,
	session: DiscordSession,
	onMessage: (message: MessengerMessage) => Promise<void>,
	signal: AbortSignal,
	WebSocketImpl: typeof WebSocket,
	clock: DiscordClock,
	onThreadEvent: (type: "THREAD_UPDATE" | "THREAD_DELETE", value: unknown) => Promise<void>,
): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	const result = Promise.withResolvers<void>();
	let socket: WebSocket;
	try {
		socket = new WebSocketImpl(url);
	} catch {
		return Promise.resolve();
	}
	let finished = false;
	let hello = false;
	let established = false;
	let resuming = false;
	let acknowledged = true;
	let cancelHeartbeat: (() => void) | undefined;
	let cancelHandshake: (() => void) | undefined;

	const finish = (error?: Error): void => {
		if (finished) return;
		finished = true;
		cancelHeartbeat?.();
		cancelHandshake?.();
		signal.removeEventListener("abort", abort);
		socket.removeEventListener("message", receive);
		socket.removeEventListener("close", close);
		socket.removeEventListener("error", failed);
		try {
			socket.close(signal.aborted ? 1000 : 4000);
		} catch {
			/* already closed */
		}
		if (error) result.reject(error);
		else result.resolve();
	};
	const abort = (): void => finish();
	const failed = (): void => finish();
	const send = (op: number, d: unknown): void => {
		if (finished) return;
		try {
			socket.send(JSON.stringify({ op, d }));
		} catch {
			finish();
		}
	};
	const heartbeat = (): void => {
		acknowledged = false;
		send(1, session.sequence);
	};
	const close = (event: CloseEvent): void => {
		if (Object.hasOwn(PERMANENT_CLOSE_CODES, event.code)) {
			const reason =
				event.code === 4004
					? "authentication failed"
					: event.code === 4013 || event.code === 4014
						? "message intents are invalid or not enabled"
						: "Gateway configuration is unsupported";
			finish(new DiscordConfigurationError(`Discord ${reason} (Gateway ${event.code})`));
			return;
		}
		if ([1000, 1001, 4003, 4007, 4009].includes(event.code)) clearSession(session);
		finish();
	};
	const receive = (event: MessageEvent): void => {
		if (finished || signal.aborted) return;
		let packet: unknown;
		try {
			if (typeof event.data !== "string") return;
			packet = JSON.parse(event.data);
		} catch {
			finish();
			return;
		}
		if (!isRecord(packet)) return;
		if (packet.op === 10) {
			if (hello) return;
			if (
				!isRecord(packet.d) ||
				typeof packet.d.heartbeat_interval !== "number" ||
				!Number.isFinite(packet.d.heartbeat_interval) ||
				packet.d.heartbeat_interval <= 0 ||
				packet.d.heartbeat_interval > 300_000
			) {
				finish(new DiscordConfigurationError("Discord returned an invalid heartbeat interval"));
				return;
			}
			hello = true;
			const interval = packet.d.heartbeat_interval;
			const tick = (): void => {
				if (finished) return;
				if (!acknowledged) {
					finish();
					return;
				}
				heartbeat();
				if (!finished) cancelHeartbeat = clock.schedule(tick, interval);
			};
			cancelHeartbeat = clock.schedule(tick, clock.random() * interval);
			if (session.id && session.sequence !== null) {
				resuming = true;
				send(6, { token, session_id: session.id, seq: session.sequence });
			} else {
				send(2, {
					token,
					intents: DISCORD_GATEWAY_INTENTS,
					properties: { os: process.platform, browser: "jeo", device: "jeo" },
				});
			}
		} else if (packet.op === 11) {
			acknowledged = true;
		} else if (packet.op === 1) {
			send(1, session.sequence);
		} else if (packet.op === 7 || packet.op === 9) {
			if (packet.op === 9 && packet.d !== true) clearSession(session);
			finish();
		} else if (packet.op === 0) {
			if (typeof packet.s === "number" && Number.isSafeInteger(packet.s)) session.sequence = packet.s;
			if (packet.t === "READY") {
				if (!isRecord(packet.d) || typeof packet.d.session_id !== "string" || !packet.d.session_id) {
					finish(new DiscordConfigurationError("Discord returned an invalid Gateway session"));
					return;
				}
				if (isRecord(packet.d.user) && packet.d.user.id !== accountId) {
					finish(new DiscordConfigurationError("Discord Gateway account does not match the authenticated bot"));
					return;
				}
				try {
					session.url = discordGatewayUrl(packet.d.resume_gateway_url);
				} catch {
					finish(new DiscordConfigurationError("Discord returned an untrusted resume Gateway URL"));
					return;
				}
				session.id = packet.d.session_id;
				established = true;
				cancelHandshake?.();
			} else if (packet.t === "RESUMED") {
				established = true;
				resuming = false;
				cancelHandshake?.();
			} else if ((established || resuming) && (packet.t === "THREAD_UPDATE" || packet.t === "THREAD_DELETE")) {
				void onThreadEvent(packet.t, packet.d).catch(() => finish(new DiscordConfigurationError("Discord thread lifecycle handling failed")));
			} else if ((established || resuming) && packet.t === "MESSAGE_CREATE") {
				const message = normalizeMessage(packet.d, accountId);
				if (message) {
					void Promise.resolve()
						.then(() => {
							if (!signal.aborted) return onMessage(message);
						})
						.catch(() => finish(new DiscordConfigurationError("Discord message delivery failed")));
				}
			}
		}
	};
	socket.addEventListener("message", receive);
	socket.addEventListener("close", close);
	socket.addEventListener("error", failed);
	signal.addEventListener("abort", abort, { once: true });
	cancelHandshake = clock.schedule(() => finish(), 35_000);
	if (signal.aborted) finish();
	return result.promise;
}

export function createDiscordAdapter(
	config: MessengerPlatformConfig,
	env: Record<string, string | undefined> = process.env,
	deps: DiscordTransportDeps = {},
): MessengerAdapter {
	const token = resolveMessengerToken(config.tokenEnv, env)?.trim();
	const clock = deps.clock ?? defaultClock;
	interface KnownThread {
		accountId: string;
		guildId?: string;
		parentChannelId: string;
		state: "active" | "archived" | "deleted";
		verified: boolean;
		revision: number;
		stateRevision: number;
		lineage: object;
		archiveTimestamp?: number;
	}
	const createdThreads = new Map<string, KnownThread>();
	interface ThreadLookup { accountId: string; guildId?: string; invalidatedParents: Set<string> }
	const threadLookups = new Map<string, ThreadLookup>();
	const threadPreparations = new Set<{ accountId: string; guildId?: string; channelId: string; invalidated: Set<string> }>();
	const rememberThread = (threadId: string, message: MessengerMessage, parentChannelId: string): KnownThread => {
		const previous = createdThreads.get(threadId);
		if (previous && (previous.accountId !== message.accountId || previous.guildId !== message.guildId ||
			previous.parentChannelId !== parentChannelId || previous.state === "deleted")) throw new Error("Discord thread identity changed");
		const thread: KnownThread = { accountId: message.accountId, guildId: message.guildId, parentChannelId,
			state: "active", verified: true, revision: previous?.revision ?? 0,
			stateRevision: (previous?.stateRevision ?? 0) + (previous && previous.state !== "active" ? 1 : 0),
			lineage: previous?.lineage ?? {}, archiveTimestamp: previous?.archiveTimestamp };
		createdThreads.set(threadId, thread);
		if (createdThreads.size > 10_000) {
			const oldest = createdThreads.keys().next().value;
			if (oldest !== undefined) createdThreads.delete(oldest);
		}
		return thread;
	};
	const normalizationTails = new Map<string, Promise<void>>();
	const activityMessages = new Map<string, string>();
	const headers = (): Record<string, string> => {
		if (!token) throw new DiscordConfigurationError("Discord bot token is missing");
		return { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
	};
	const allowedThread = (threadId: string, parentChannelId: string): boolean =>
		!config.allowedChannelIds || config.allowedChannelIds.includes(parentChannelId) || config.allowedChannelIds.includes(threadId);
	return {
		platform: "discord",
		async start(onMessage, signal, onThreadLifecycle) {
			const lifetime = new AbortController();
			signal = AbortSignal.any([signal, lifetime.signal]);
			const dispatchFailure = Promise.withResolvers<never>();
			const failDispatch = (message: string): void => {
				if (signal.aborted) return;
				dispatchFailure.reject(new Error(message));
				lifetime.abort();
			};
			const run = async (): Promise<void> => {
			const session: DiscordSession = { sequence: null };
			let accountId: string | undefined;
			let initialUrl: string | undefined;
			let delay = 5_000;
			while (!signal.aborted) {
				let retryDelay = delay;
				try {
					if (!accountId) {
						const user = await messengerFetchJson(
							`${DISCORD_API}/users/@me`,
							{ headers: headers() },
							signal,
							deps.fetch,
						);
						if (signal.aborted) return;
						if (!isRecord(user) || typeof user.id !== "string" || !user.id || user.bot !== true) {
							throw new DiscordConfigurationError("Discord credentials must identify a bot account");
						}
						accountId = user.id;
					}
					if (!initialUrl) {
						const gateway = await messengerFetchJson(
							`${DISCORD_API}/gateway/bot`,
							{ headers: headers() },
							signal,
							deps.fetch,
						);
						if (!isRecord(gateway))
							throw new DiscordConfigurationError("Discord returned invalid Gateway discovery");
						if (isRecord(gateway.session_start_limit) && gateway.session_start_limit.remaining === 0) {
							throw new DiscordConfigurationError("Discord Gateway session start limit is exhausted");
						}
						initialUrl = discordGatewayUrl(gateway.url);
					}
					const lifecycle = async (type: "THREAD_UPDATE" | "THREAD_DELETE", value: unknown): Promise<void> => {
						// Dispatch data is trusted only on this authenticated account's established socket and known thread tuple.
						if (!isRecord(value) || typeof value.id !== "string" || typeof value.guild_id !== "string" ||
							typeof value.parent_id !== "string" || typeof value.type !== "number" || ![10, 11, 12].includes(value.type)) return;
						const archived = isRecord(value.thread_metadata) ? value.thread_metadata.archived : undefined;
						if (type === "THREAD_UPDATE" && typeof archived !== "boolean") return;
						const thread = createdThreads.get(value.id);
						const timestamp = isRecord(value.thread_metadata) && typeof value.thread_metadata.archive_timestamp === "string"
							? Date.parse(value.thread_metadata.archive_timestamp) : NaN;
						if (thread && thread.accountId === accountId && thread.guildId === value.guild_id &&
							thread.parentChannelId === value.parent_id && type !== "THREAD_DELETE" &&
							thread.archiveTimestamp !== undefined && Number.isFinite(timestamp) && timestamp < thread.archiveTimestamp) return;
						if (type === "THREAD_DELETE" || archived === true) {
							for (const preparation of threadPreparations) {
								if (preparation.accountId === accountId && preparation.guildId === value.guild_id &&
									(preparation.channelId === value.id || preparation.channelId === value.parent_id) && allowedThread(value.id, value.parent_id)) {
									preparation.invalidated.add(JSON.stringify([value.id, value.parent_id]));
								}
							}
						}
						if (!thread) {
							// An unknown event cannot establish trust, but it must fence an older in-flight REST snapshot.
							const lookup = threadLookups.get(value.id);
							if (lookup && lookup.accountId === accountId && lookup.guildId === value.guild_id && allowedThread(value.id, value.parent_id)) {
								lookup.invalidatedParents.add(value.parent_id);
							}
							return;
						}
						if (thread.accountId !== accountId || thread.guildId !== value.guild_id ||
							thread.parentChannelId !== value.parent_id || !allowedThread(value.id, value.parent_id) || thread.state === "deleted") return;
						const state = type === "THREAD_DELETE" ? "deleted" : archived ? "archived" : "active";
						const changed = state !== thread.state;
						const unknownArchive = thread.state === "archived" && thread.archiveTimestamp === undefined;
						if (type !== "THREAD_DELETE" && thread.archiveTimestamp !== undefined) {
							if (changed && (timestamp === thread.archiveTimestamp || (state === "active" && !Number.isFinite(timestamp))))
								throw new Error("Discord thread archive state is ambiguous");
						}
						thread.state = state;
						thread.verified = false;
						thread.revision++;
						if (changed) thread.stateRevision++;
						if (Number.isFinite(timestamp) && (!unknownArchive || changed)) thread.archiveTimestamp = timestamp;
						else if (changed) thread.archiveTimestamp = undefined;
						const event: DiscordThreadLifecycle = { kind: state === "deleted" ? "delete" : state === "archived" ? "archive" : "unarchive",
							accountId: thread.accountId, guildId: thread.guildId, parentChannelId: thread.parentChannelId, threadId: value.id };
						if (changed) await onThreadLifecycle?.(event);
					};
					const deliver = async (message: MessengerMessage): Promise<void> => {
						const previous = normalizationTails.get(message.channelId) ?? Promise.resolve();
						const ready = Promise.withResolvers<void>();
						const tail = previous.then(() => ready.promise);
						normalizationTails.set(message.channelId, tail);
						const forward = (destination: MessengerMessage): Promise<void> => {
							ready.resolve();
							return onMessage(destination);
						};
						await previous;
						let lookup: ThreadLookup | undefined;
						try {
							if (signal.aborted) return;
							let thread = createdThreads.get(message.channelId);
							if (thread?.state === "deleted") return;
							if (thread?.verified && thread.state === "active" && thread.accountId === message.accountId &&
								thread.guildId === message.guildId && config.allowedUserIds.includes(message.senderId)) {
								await forward({ ...message, threadId: message.channelId, parentChannelId: thread.parentChannelId });
							} else if (!message.direct && config.allowedUserIds.includes(message.senderId)) {
								const revision = thread?.revision;
								const stateRevision = thread?.stateRevision;
								const unchanged = (): boolean => {
									const current = createdThreads.get(message.channelId);
									if (current !== thread) {
										if (!thread || !current || current.lineage !== thread.lineage) return false;
										thread = current;
									}
									if (thread?.revision === revision) return true;
									if (thread?.state !== "active" || thread.stateRevision !== stateRevision) return false;
									if (!message.mentioned) throw new Error("Discord thread metadata changed during lookup");
									return true;
								};
								lookup = { accountId: message.accountId, guildId: message.guildId, invalidatedParents: new Set() };
								threadLookups.set(message.channelId, lookup);
								const channel = await messengerFetchJson(
									`${DISCORD_API}/channels/${encodeURIComponent(message.channelId)}`,
									{ headers: headers() }, signal, deps.fetch,
								);
								if (signal.aborted) return;
								if (!isRecord(channel) || channel.id !== message.channelId) return;
								if (!unchanged()) return;
								if (channel.guild_id !== undefined && channel.guild_id !== message.guildId) return;
								if (typeof channel.type === "number" && [10, 11, 12].includes(channel.type)) {
									if (typeof channel.parent_id !== "string" || !channel.parent_id || !allowedThread(message.channelId, channel.parent_id)) return;
									if (lookup.invalidatedParents.has(channel.parent_id)) throw new Error("Discord thread changed during lookup");
									if (!message.mentioned) {
										const originalId = typeof channel.name === "string" ? /^Request (\d{1,20})$/.exec(channel.name)?.[1] : undefined;
										if (channel.owner_id !== accountId || !originalId ||
											(config.allowedChannelIds && !config.allowedChannelIds.includes(channel.parent_id) && !config.allowedChannelIds.includes(message.channelId))) return;
										const original = await messengerFetchJson(
											`${DISCORD_API}/channels/${encodeURIComponent(channel.parent_id)}/messages/${originalId}`,
											{ headers: headers() }, signal, deps.fetch,
										);
										if (!isRecord(original) || original.id !== originalId || original.channel_id !== channel.parent_id ||
											!isRecord(original.author) || typeof original.author.id !== "string" || original.author.bot === true || original.webhook_id) return;
									}
									if (signal.aborted || !unchanged()) return;
									if (lookup.invalidatedParents.has(channel.parent_id)) throw new Error("Discord thread changed during lookup");
									let archived = isRecord(channel.thread_metadata) && typeof channel.thread_metadata.archived === "boolean"
										? channel.thread_metadata.archived : undefined;
									const restTimestamp = isRecord(channel.thread_metadata) && typeof channel.thread_metadata.archive_timestamp === "string"
										? Date.parse(channel.thread_metadata.archive_timestamp) : NaN;
									if (thread?.state === "archived" && archived === undefined)
										throw new Error("Discord thread archive state is ambiguous");
									if (thread && archived !== undefined && archived !== (thread.state === "archived") &&
										(thread.state === "archived" || thread.revision !== revision || thread.archiveTimestamp !== undefined)) {
										if (thread.archiveTimestamp === undefined || !Number.isFinite(restTimestamp) || restTimestamp === thread.archiveTimestamp)
											throw new Error("Discord thread archive state is ambiguous");
										if (restTimestamp < thread.archiveTimestamp) archived = thread.state === "archived";
										if (archived && thread.state === "archived") return;
									}
									const recovered = rememberThread(message.channelId, message, channel.parent_id);
									const recoveredStateRevision = recovered.stateRevision;
									if (archived !== undefined) {
										if (!(thread?.state === "archived" && thread.archiveTimestamp === undefined) && Number.isFinite(restTimestamp) &&
											(recovered.archiveTimestamp === undefined || restTimestamp > recovered.archiveTimestamp))
											recovered.archiveTimestamp = restTimestamp;
										recovered.state = archived ? "archived" : "active";
										await onThreadLifecycle?.({ kind: archived ? "archive" : "unarchive", accountId: message.accountId,
											guildId: message.guildId, parentChannelId: channel.parent_id, threadId: message.channelId });
										if (archived) return;
									}
									const current = createdThreads.get(message.channelId);
									if (signal.aborted || !current || current.accountId !== recovered.accountId ||
										current.guildId !== recovered.guildId || current.parentChannelId !== recovered.parentChannelId ||
										current.lineage !== recovered.lineage || current.stateRevision !== recoveredStateRevision || current.state !== "active" ||
										lookup.invalidatedParents.has(channel.parent_id)) return;
									await forward({ ...message, threadId: message.channelId, parentChannelId: channel.parent_id });
								} else {
									await forward(message);
								}
							} else {
								await forward(message);
							}
						} catch (error) {
							failDispatch("Discord message delivery failed");
							throw error;
						} finally {
							if (threadLookups.get(message.channelId) === lookup) threadLookups.delete(message.channelId);
							ready.resolve();
							if (normalizationTails.get(message.channelId) === tail) normalizationTails.delete(message.channelId);
						}
					};
					await connectGateway(
						session.url ?? initialUrl,
						token!,
						accountId,
						session,
						deliver,
						signal,
						deps.WebSocket ?? WebSocket,
						clock,
						(type, value) => lifecycle(type, value).catch(error => {
							failDispatch("Discord thread lifecycle handling failed");
							throw error;
						}),
					);
				} catch (error) {
					if (signal.aborted) return;
					if (error instanceof DiscordConfigurationError) throw error;
					if (
						error instanceof MessengerHttpError &&
						error.status >= 400 &&
						error.status < 500 &&
						error.status !== 429
					) {
						throw new DiscordConfigurationError(
							`Discord authentication or configuration failed (HTTP ${error.status})`,
						);
					}
					if (error instanceof MessengerHttpError && error.retryAfterMs !== undefined) {
						retryDelay = Math.max(retryDelay, error.retryAfterMs);
					}
				}
				if (signal.aborted) return;
				try {
					await waitForReconnect(retryDelay, signal, clock);
				} catch {
					if (signal.aborted) return;
					throw new Error("Discord reconnect wait failed");
				}
				delay = Math.min(delay * 2, 30_000);
			}
			};
			try {
				await Promise.race([run(), dispatchFailure.promise]);
			} finally {
				lifetime.abort();
			}
		},
		async prepare(message, signal) {
			if (message.direct) return message;
			if (message.threadId) {
				const known = createdThreads.get(message.threadId);
				if (known && known.state !== "active") throw new Error("Discord thread is not active");
				if (message.parentChannelId) rememberThread(message.threadId, message, message.parentChannelId);
				return message;
			}
			const preparation = { accountId: message.accountId, guildId: message.guildId, channelId: message.channelId, invalidated: new Set<string>() };
			const known = createdThreads.get(message.channelId);
			const revision = known?.revision;
			threadPreparations.add(preparation);
			try {
				const channel = await messengerFetchJson(
					`${DISCORD_API}/channels/${encodeURIComponent(message.channelId)}`,
					{ headers: headers() }, signal, deps.fetch,
				);
				signal?.throwIfAborted();
				if (!isRecord(channel) || channel.id !== message.channelId || typeof channel.type !== "number" ||
					(channel.guild_id !== undefined && channel.guild_id !== message.guildId)) throw new Error("Discord channel type unavailable");
				if ([10, 11, 12].includes(channel.type)) {
					if (typeof channel.parent_id !== "string" || !channel.parent_id) throw new Error("Discord thread parent unavailable");
					if (!allowedThread(message.channelId, channel.parent_id)) throw new Error("Discord thread is not authorized");
					if ((isRecord(channel.thread_metadata) && channel.thread_metadata.archived === true) ||
						preparation.invalidated.has(JSON.stringify([message.channelId, channel.parent_id])) ||
						createdThreads.get(message.channelId) !== known || known?.revision !== revision) throw new Error("Discord thread changed during preparation");
					rememberThread(message.channelId, message, channel.parent_id);
					return { ...message, threadId: message.channelId, parentChannelId: channel.parent_id };
				}
				if (channel.type !== 0 && channel.type !== 5) throw new Error("Discord channel cannot host a reply thread");
				const thread = await messengerFetchJson(
					`${DISCORD_API}/channels/${encodeURIComponent(message.channelId)}/messages/${encodeURIComponent(message.messageId)}/threads`,
					{ method: "POST", headers: headers(), body: JSON.stringify({ name: `Request ${message.messageId}` }) }, signal, deps.fetch,
				);
				signal?.throwIfAborted();
				if (!isRecord(thread) || typeof thread.id !== "string" || !thread.id) throw new Error("Discord thread creation returned no ID");
				if ((thread.parent_id !== undefined && thread.parent_id !== message.channelId) ||
					(thread.guild_id !== undefined && thread.guild_id !== message.guildId)) throw new Error("Discord thread creation returned a different destination");
				if (preparation.invalidated.has(JSON.stringify([thread.id, message.channelId]))) throw new Error("Discord thread closed during creation");
				rememberThread(thread.id, message, message.channelId);
				return { ...message, threadId: thread.id, parentChannelId: message.channelId };
			} finally {
				threadPreparations.delete(preparation);
			}
		},
		async status(message, state, signal) {
			const base = `${DISCORD_API}/channels/${encodeURIComponent(message.channelId)}/messages/${encodeURIComponent(message.messageId)}/reactions`;
			const processing = encodeURIComponent("⏳");
			if (state !== "processing") {
				try {
					await messengerFetchJson(
						`${base}/${processing}/@me`,
						{ method: "DELETE", headers: headers() },
						signal,
						deps.fetch,
					);
				} catch {
					/* best-effort reaction removal */
				}
			}
			const emoji = state === "processing" ? "⏳" : state === "success" ? "✅" : "❌";
			await messengerFetchJson(
				`${base}/${encodeURIComponent(emoji)}/@me`,
				{ method: "PUT", headers: headers() },
				signal,
				deps.fetch,
			);
		},
		async activity(message, text, signal, outcome = "success") {
			const channelId = message.threadId ?? message.channelId;
			const key = JSON.stringify([channelId, message.messageId]);
			const thread = createdThreads.get(channelId);
			if (thread && thread.state !== "active") {
				activityMessages.delete(key);
				return;
			}
			const messages = `${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages`;
			const statusId = activityMessages.get(key);
			if (text === undefined) {
				if (!statusId) return;
				const label = outcome === "success" ? "✅ Complete" : outcome === "failure" ? "❌ Failed" : "⏹ Cancelled";
				try {
					await messengerFetchJson(
						`${messages}/${encodeURIComponent(statusId)}`,
						{ method: "PATCH", headers: headers(), body: JSON.stringify({ content: label, allowed_mentions: { parse: [] } }) },
						signal, deps.fetch,
					);
				} catch (error) {
					if (!(error instanceof MessengerHttpError && error.status === 404)) throw error;
				}
				activityMessages.delete(key);
				return;
			}
			const content = `⏳ ${text.replace(/[\r\n]+/g, " ")}`;
			if (statusId) {
				try {
					await messengerFetchJson(
						`${messages}/${encodeURIComponent(statusId)}`,
						{ method: "PATCH", headers: headers(), body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) },
						signal, deps.fetch,
					);
					return;
				} catch (error) {
					if (!(error instanceof MessengerHttpError && error.status === 404)) throw error;
					activityMessages.delete(key);
				}
			}
			const created = await messengerFetchJson(
				messages,
				{ method: "POST", headers: headers(), body: JSON.stringify({ content, allowed_mentions: { parse: [] }, flags: DISCORD_ACTIVITY_FLAGS }) },
				signal, deps.fetch,
			);
			if (!isRecord(created) || typeof created.id !== "string" || !created.id)
				throw new Error("Discord activity message returned no ID");
			activityMessages.set(key, created.id);
		},
		async send(message, text, signal) {
			message = Object.freeze({ ...message });
			const endpoint = `${DISCORD_API}/channels/${encodeURIComponent(message.threadId ?? message.channelId)}/messages`;
			let files: { name: string; data: Uint8Array }[] = [];
			if (config.artifactDir) {
				try {
					const result = await readMessengerArtifacts(config.artifactDir, message, text);
					text = result.text;
					files = result.files;
				} catch {
					await messengerFetchJson(
						endpoint,
						{
							method: "POST",
							headers: headers(),
							body: JSON.stringify({
								content: "File delivery failed: check the output path and size (maximum 8 MiB).",
								allowed_mentions: { parse: [], replied_user: false },
							}),
						},
						signal,
						deps.fetch,
					);
					throw new Error("Discord artifact delivery failed");
				}
			}
			signal?.throwIfAborted();
			const { chunks, needsAttachment } = splitDiscordText(text);
			for (let index = 0; index < chunks.length + Number(needsAttachment); index++) {
				for (let attempt = 0; ; attempt++) {
					try {
						const attachment = index === chunks.length;
						const requestHeaders = headers();
						let body: string | FormData;
						if (attachment) {
							delete requestHeaders["Content-Type"];
							const form = new FormData();
							form.append(
								"payload_json",
								JSON.stringify({ allowed_mentions: { parse: [], replied_user: false } }),
							);
							form.append("files[0]", new Blob([text], { type: "text/plain; charset=utf-8" }), "response.txt");
							body = form;
						} else {
							body = JSON.stringify({
								content: chunks[index],
								allowed_mentions: { parse: [], replied_user: false },
								...(index === 0 &&
								message.messageId &&
								(!message.threadId || message.threadId === message.channelId)
									? { message_reference: { message_id: message.messageId, fail_if_not_exists: false } }
									: {}),
							});
						}
						await messengerFetchJson(
							`${DISCORD_API}/channels/${encodeURIComponent(message.threadId ?? message.channelId)}/messages`,
							{
								method: "POST",
								headers: requestHeaders,
								body,
							},
							signal,
							deps.fetch,
						);
						break;
					} catch (error) {
						if (error instanceof MessengerHttpError && error.status === 429 && attempt < 3 && !signal?.aborted) {
							try {
								await waitForReconnect(
									error.retryAfterMs ?? 1_000,
									signal ?? new AbortController().signal,
									clock,
								);
								if (!signal?.aborted) continue;
							} catch {
								/* stop retry on cancellation */
							}
						}
						throw error;
					}
				}
			}
			// Pin upload bytes before asking the parent. Never reread a path after an approval.
			const uploads = files.map(file => ({ name: file.name, blob: new Blob([file.data.slice()]),
				digest: new Bun.CryptoHasher("sha256").update(file.data).digest("hex") }));
			if (files.length > 0) {
				signal?.throwIfAborted();
				if (config.workerMode === "host" && !deps.authorizeArtifacts) throw new Error("Discord host artifact delivery requires parent authorization");
				await deps.authorizeArtifacts?.(message, Object.freeze(files.map(file => Object.freeze(file))), signal ?? new AbortController().signal);
				signal?.throwIfAborted();
				if (files.some((file, index) => file.name !== uploads[index]!.name ||
					new Bun.CryptoHasher("sha256").update(file.data).digest("hex") !== uploads[index]!.digest)) throw new Error("Discord artifact bytes changed during authorization");
			}
			for (const file of uploads) {
				signal?.throwIfAborted();
				const requestHeaders = headers();
				delete requestHeaders["Content-Type"];
				const form = new FormData();
				form.append("payload_json", JSON.stringify({ allowed_mentions: { parse: [], replied_user: false } }));
				form.append("files[0]", file.blob, file.name);
				for (let attempt = 0; ; attempt++) {
					try {
						signal?.throwIfAborted();
						await messengerFetchJson(
							endpoint,
							{ method: "POST", headers: requestHeaders, body: form },
							signal,
							deps.fetch,
						);
						break;
					} catch (error) {
						if (error instanceof MessengerHttpError && error.status === 429 && attempt < 3 && !signal?.aborted) {
							await waitForReconnect(error.retryAfterMs ?? 1_000, signal ?? new AbortController().signal, clock);
							continue;
						}
						if (!signal?.aborted) {
							await messengerFetchJson(
								endpoint,
								{
									method: "POST",
									headers: headers(),
									body: JSON.stringify({
										content: "File upload failed; some files may not have been delivered.",
										allowed_mentions: { parse: [], replied_user: false },
									}),
								},
								signal,
								deps.fetch,
							).catch(() => {});
						}
						throw error;
					}
				}
			}
		},
	};
}
