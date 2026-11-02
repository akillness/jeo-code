import { readMessengerArtifacts } from "./artifacts";
import { resolveMessengerToken } from "./config";
import { MessengerHttpError, messengerFetchJson } from "./http";
import {
	isRecord,
	type MessengerAdapter,
	type MessengerMessage,
	type MessengerPlatformConfig,
	type MessengerTransportDeps,
} from "./types";

export const DISCORD_API = "https://discord.com/api/v10";
export const DISCORD_GATEWAY_INTENTS = (1 << 9) | (1 << 12) | (1 << 15);
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
): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	const result = Promise.withResolvers<void>();
	let socket: WebSocket;
	try {
		socket = new WebSocketImpl(url);
	} catch {
		clearSession(session);
		return Promise.resolve();
	}
	let finished = false;
	let hello = false;
	let established = false;
	let acknowledged = true;
	let cancelHeartbeat: (() => void) | undefined;
	let cancelHandshake: (() => void) | undefined;

	const finish = (error?: Error): void => {
		if (finished) return;
		finished = true;
		if (!established) clearSession(session);
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
				cancelHandshake?.();
			} else if (packet.t === "MESSAGE_CREATE") {
				const message = normalizeMessage(packet.d, accountId);
				if (message) {
					void Promise.resolve()
						.then(() => {
							if (!signal.aborted) return onMessage(message);
						})
						.catch(() => {});
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
	const createdThreads = new Map<string, { parentChannelId: string; senderId: string }>();
	const rememberThread = (threadId: string, parentChannelId: string, senderId: string): void => {
		createdThreads.set(threadId, { parentChannelId, senderId });
		if (createdThreads.size > 10_000) {
			const oldest = createdThreads.keys().next().value;
			if (oldest !== undefined) createdThreads.delete(oldest);
		}
	};
	const activityMessages = new Map<string, string>();
	const headers = (): Record<string, string> => {
		if (!token) throw new DiscordConfigurationError("Discord bot token is missing");
		return { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
	};
	return {
		platform: "discord",
		async start(onMessage, signal) {
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
					const deliver = async (message: MessengerMessage): Promise<void> => {
						const thread = createdThreads.get(message.channelId);
						if (thread && thread.senderId === message.senderId) {
							await onMessage({
								...message,
								threadId: message.channelId,
								parentChannelId: thread.parentChannelId,
							});
						} else if (
							!message.direct &&
							config.allowedUserIds.includes(message.senderId) &&
							config.allowedChannelIds &&
							(!message.mentioned || !config.allowedChannelIds.includes(message.channelId))
						) {
							try {
								const channel = await messengerFetchJson(
									`${DISCORD_API}/channels/${encodeURIComponent(message.channelId)}`,
									{ headers: headers() },
									signal,
									deps.fetch,
								);
								if (
									isRecord(channel) &&
									channel.id === message.channelId &&
									typeof channel.type === "number" &&
									[10, 11, 12].includes(channel.type) &&
									typeof channel.parent_id === "string" &&
									channel.parent_id
								) {
									if (!message.mentioned) {
										const originalId = typeof channel.name === "string" ? /^Request (\d{1,20})$/.exec(channel.name)?.[1] : undefined;
										if (channel.owner_id !== accountId || !originalId ||
											(!config.allowedChannelIds.includes(channel.parent_id) && !config.allowedChannelIds.includes(message.channelId))) return;
										const original = await messengerFetchJson(
											`${DISCORD_API}/channels/${encodeURIComponent(channel.parent_id)}/messages/${originalId}`,
											{ headers: headers() }, signal, deps.fetch,
										);
										if (!isRecord(original) || original.id !== originalId || original.channel_id !== channel.parent_id ||
											!isRecord(original.author) || original.author.id !== message.senderId || original.author.bot === true || original.webhook_id) return;
										rememberThread(message.channelId, channel.parent_id, message.senderId);
									}
									await onMessage({
										...message,
										threadId: message.channelId,
										parentChannelId: channel.parent_id,
									});
								}
							} catch {
								/* ignore thread lookup failure */
							}
						} else {
							await onMessage(message);
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
		},
		async prepare(message, signal) {
			if (message.direct) return message;
			if (message.threadId) {
				if (message.parentChannelId) rememberThread(message.threadId, message.parentChannelId, message.senderId);
				return message;
			}
			const channel = await messengerFetchJson(
				`${DISCORD_API}/channels/${encodeURIComponent(message.channelId)}`,
				{ headers: headers() },
				signal,
				deps.fetch,
			);
			if (!isRecord(channel) || typeof channel.type !== "number")
				throw new Error("Discord channel type unavailable");
			if ([10, 11, 12].includes(channel.type)) {
				if (typeof channel.parent_id !== "string" || !channel.parent_id)
					throw new Error("Discord thread parent unavailable");
				rememberThread(message.channelId, channel.parent_id, message.senderId);
				return { ...message, threadId: message.channelId, parentChannelId: channel.parent_id };
			}
			if (channel.type !== 0 && channel.type !== 5) throw new Error("Discord channel cannot host a reply thread");
			const thread = await messengerFetchJson(
				`${DISCORD_API}/channels/${encodeURIComponent(message.channelId)}/messages/${encodeURIComponent(message.messageId)}/threads`,
				{ method: "POST", headers: headers(), body: JSON.stringify({ name: `Request ${message.messageId}` }) },
				signal,
				deps.fetch,
			);
			if (!isRecord(thread) || typeof thread.id !== "string" || !thread.id)
				throw new Error("Discord thread creation returned no ID");
			rememberThread(thread.id, message.channelId, message.senderId);
			return { ...message, threadId: thread.id };
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
		async activity(message, text, signal) {
			const channelId = message.threadId ?? message.channelId;
			const key = JSON.stringify([channelId, message.messageId]);
			const messages = `${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages`;
			const statusId = activityMessages.get(key);
			if (text === undefined) {
				if (!statusId) return;
				try {
					await messengerFetchJson(
						`${messages}/${encodeURIComponent(statusId)}`,
						{
							method: "PATCH",
							headers: headers(),
							body: JSON.stringify({ content: "✅ Complete", allowed_mentions: { parse: [] } }),
						},
						signal,
						deps.fetch,
					);
				} catch (error) {
					if (!(error instanceof MessengerHttpError && error.status === 404)) throw error;
				}
				activityMessages.delete(key);
				return;
			}
			const content = `⏳ ${text}`;
			if (statusId) {
				try {
					await messengerFetchJson(
						`${messages}/${encodeURIComponent(statusId)}`,
						{
							method: "PATCH",
							headers: headers(),
							body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
						},
						signal,
						deps.fetch,
					);
					return;
				} catch (error) {
					if (!(error instanceof MessengerHttpError && error.status === 404)) throw error;
					activityMessages.delete(key);
				}
			}
			const created = await messengerFetchJson(
				messages,
				{
					method: "POST",
					headers: headers(),
					body: JSON.stringify({ content, allowed_mentions: { parse: [] }, flags: DISCORD_ACTIVITY_FLAGS }),
				},
				signal,
				deps.fetch,
			);
			if (!isRecord(created) || typeof created.id !== "string" || !created.id)
				throw new Error("Discord activity message returned no ID");
			activityMessages.set(key, created.id);
		},
		async send(message, text, signal) {
			let files: { name: string; data: Uint8Array }[] = [];
			if (config.artifactDir) {
				try {
					const result = await readMessengerArtifacts(config.artifactDir, message, text);
					text = result.text;
					files = result.files;
				} catch {
					await messengerFetchJson(
						`${DISCORD_API}/channels/${encodeURIComponent(message.threadId ?? message.channelId)}/messages`,
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
			for (const file of files) {
				const requestHeaders = headers();
				delete requestHeaders["Content-Type"];
				const form = new FormData();
				form.append("payload_json", JSON.stringify({ allowed_mentions: { parse: [], replied_user: false } }));
				form.append("files[0]", new Blob([file.data]), file.name);
				for (let attempt = 0; ; attempt++) {
					try {
						await messengerFetchJson(
							`${DISCORD_API}/channels/${encodeURIComponent(message.threadId ?? message.channelId)}/messages`,
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
								`${DISCORD_API}/channels/${encodeURIComponent(message.threadId ?? message.channelId)}/messages`,
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
