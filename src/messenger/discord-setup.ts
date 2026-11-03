import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadMessengerConfig, parseMessengerSandbox, resolveMessengerToken, validateMessengerEnvironment } from "./config";
import { DISCORD_API, DISCORD_GATEWAY_INTENTS, discordGatewayUrl } from "./discord";
import { MessengerHttpError, messengerFetchJson } from "./http";
import { installMessengerService, messengerServicePlan } from "./service";
import { isEnoent, isRecord } from "./types";
import { notifyDir } from "../agent/notify/paths";

export const DISCORD_TOKEN_ENV = "JEO_DISCORD_BOT_TOKEN";
const TOKEN_FILE = "discord-token";
const RUN_SCRIPT_POSIX = "run-discord.sh";
const RUN_SCRIPT_WINDOWS = "run-discord.cmd";
const MESSAGE_CONTENT = 1 << 18;
const MESSAGE_CONTENT_LIMITED = 1 << 19;
/** The only application flags a bot token may change: the limited presence, member, and message intents. */
const EDITABLE_INTENT_FLAGS = (1 << 13) | (1 << 15) | MESSAGE_CONTENT_LIMITED;
const ADMINISTRATOR = 1n << 3n;
const EVERYTHING = (1n << 53n) - 1n;
/** What the gateway needs in a request channel: read, reply, react, attach, and open request threads. */
export const DISCORD_REQUIRED_PERMISSIONS: ReadonlyArray<readonly [name: string, bit: bigint]> = [
	["View Channels", 1n << 10n],
	["Send Messages", 1n << 11n],
	["Read Message History", 1n << 16n],
	["Add Reactions", 1n << 6n],
	["Attach Files", 1n << 15n],
	["Create Public Threads", 1n << 35n],
	["Send Messages in Threads", 1n << 38n],
];
const REQUIRED_MASK = DISCORD_REQUIRED_PERMISSIONS.reduce((mask, [, bit]) => mask | bit, 0n);
const REQUEST_CHANNEL_TYPES: Record<number, true> = { 0: true, 5: true };
const THREAD_TYPES: Record<number, true> = { 10: true, 11: true, 12: true };
const INVITE_POLL_MS = 3_000;
const GATEWAY_PROBE_MS = 20_000;
const DM_TEST_MESSAGE = "jeo messenger is set up for this bot. Reply here to test the connection.";

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Discord setup cancelled");
}

async function interruptibleSleep(sleep: (ms: number) => Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) return sleep(ms);
	if (signal.aborted) throw new Error("Discord setup cancelled");
	let cancel: (() => void) | undefined;
	try {
		await Promise.race([
			sleep(ms),
			new Promise<never>((_resolve, reject) => {
				cancel = () => reject(new Error("Discord setup cancelled"));
				signal.addEventListener("abort", cancel, { once: true });
				if (signal.aborted) cancel();
			}),
		]);
	} finally {
		if (cancel) signal.removeEventListener("abort", cancel);
	}
}

export interface DiscordSetupIO {
	readonly interactive: boolean;
	say(line: string): void;
	ask(question: string): Promise<string>;
	askSecret(question: string): Promise<string>;
}

export interface DiscordSetupOptions {
	/** messenger.json to create or update; its directory becomes the private profile directory. */
	configPath: string;
	channelIds?: string[];
	userIds?: string[];
	toolNames?: string[];
	artifacts?: boolean;
	service?: boolean;
	/** Open the owner's DM channel, allow it, and send one test message. Default true. */
	dmTest?: boolean;
	inviteWaitMs?: number;
}

export interface DiscordSetupDeps {
	fetch?: typeof fetch;
	WebSocket?: typeof WebSocket;
	env?: Record<string, string | undefined>;
	sleep?: (ms: number) => Promise<void>;
	/** argv that starts this jeo build; defaults to the running runtime and entry. */
	jeoCommand?: string[];
	installService?: typeof installMessengerService;
	/** Cancels invite polling and the remaining setup work (the CLI wires Ctrl+C here). */
	signal?: AbortSignal;
	/** Injectable platform/path separator for cross-platform release tests. */
	platform?: NodeJS.Platform;
	pathDelimiter?: string;
}

export interface DiscordSetupResult {
	configPath: string;
	botName: string;
	applicationId: string;
	inviteUrl: string;
	allowedUserIds: string[];
	allowedChannelIds: string[];
	runScript: string;
	service?: string;
}

export interface DiscordBotInfo {
	id: string;
	username: string;
	applicationId: string;
	flags: number;
	ownerIds: string[];
}

export interface RequestChannel {
	id: string;
	name: string;
	guildName: string;
}

type DiscordApiFn = (method: string, route: string, body?: unknown) => Promise<unknown>;

function discordApi(token: string, fetchImpl: typeof fetch, signal?: AbortSignal): DiscordApiFn {
	return async (method, route, body) => {
		throwIfAborted(signal);
		const result = await messengerFetchJson(
			`${DISCORD_API}${route}`,
			{
				method,
				signal,
				headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			},
			undefined,
			fetchImpl,
		);
		throwIfAborted(signal);
		return result;
	};
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function discordInviteUrl(applicationId: string): string {
	const query = new URLSearchParams({ client_id: applicationId, scope: "bot", permissions: String(REQUIRED_MASK) });
	return `https://discord.com/oauth2/authorize?${query}`;
}

async function resolveToken(
	env: Record<string, string | undefined>,
	tokenPath: string,
	io: DiscordSetupIO,
): Promise<string> {
	let token = resolveMessengerToken(DISCORD_TOKEN_ENV, env)?.trim();
	if (!token) {
		try {
			token = (await Bun.file(tokenPath).text()).trim();
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	if (!token && io.interactive) {
		io.say("Developer Portal > your application > Bot > Reset Token, then paste it here (input is hidden).");
		token = (await io.askSecret("Discord bot token: ")).trim();
	}
	if (!token) throw new Error(`Set ${DISCORD_TOKEN_ENV} or run this command in a terminal to enter the bot token`);
	if (/\s/u.test(token)) throw new Error("The Discord bot token must not contain whitespace");
	return token;
}

export async function inspectDiscordBot(api: DiscordApiFn): Promise<DiscordBotInfo> {
	let user: unknown;
	let app: unknown;
	try {
		user = await api("GET", "/users/@me");
		app = await api("GET", "/applications/@me");
	} catch (error) {
		if (error instanceof MessengerHttpError && error.status === 401) {
			throw new Error("Discord rejected the bot token; copy a fresh one from Bot > Reset Token");
		}
		throw new Error("Could not reach Discord to verify the bot token");
	}
	if (!isRecord(user) || user.bot !== true || !str(user.id)) {
		throw new Error("The token does not belong to a bot user; copy it from the Bot page, not OAuth2");
	}
	if (!isRecord(app) || !str(app.id)) throw new Error("Discord returned no application for this bot");
	const team = isRecord(app.team) ? app.team : undefined;
	const ownerIds = team
		? [
				str(team.owner_user_id),
				...records(team.members)
					.filter(member => member.membership_state === 2)
					.map(member => (isRecord(member.user) ? str(member.user.id) : undefined)),
			]
		: [isRecord(app.owner) ? str(app.owner.id) : undefined];
	return {
		id: user.id as string,
		username: str(user.username) ?? "bot",
		applicationId: app.id as string,
		flags: typeof app.flags === "number" ? app.flags : 0,
		ownerIds: [...new Set(ownerIds.filter((id): id is string => Boolean(id)))],
	};
}

export async function ensureMessageContentIntent(
	api: DiscordApiFn,
	bot: DiscordBotInfo,
	io: DiscordSetupIO,
): Promise<void> {
	if (bot.flags & (MESSAGE_CONTENT | MESSAGE_CONTENT_LIMITED)) return;
	let flags = 0;
	try {
		const updated = await api("PATCH", "/applications/@me", {
			flags: (bot.flags & EDITABLE_INTENT_FLAGS) | MESSAGE_CONTENT_LIMITED,
		});
		flags = isRecord(updated) && typeof updated.flags === "number" ? updated.flags : 0;
	} catch {
		// Verified or large applications must use the portal toggle.
	}
	if (!(flags & (MESSAGE_CONTENT | MESSAGE_CONTENT_LIMITED))) {
		throw new Error(
			`Enable Message Content Intent at https://discord.com/developers/applications/${bot.applicationId}/bot, then rerun`,
		);
	}
	io.say("Enabled Message Content Intent for the application.");
}

export async function waitForDiscordGuilds(
	api: DiscordApiFn,
	inviteUrl: string,
	io: DiscordSetupIO,
	sleep: (ms: number) => Promise<void>,
	waitMs: number,
	signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
	throwIfAborted(signal);
	let guilds = records(await api("GET", "/users/@me/guilds"));
	throwIfAborted(signal);
	if (guilds.length) return guilds;
	if (!io.interactive) throw new Error(`Invite the bot to a server, then rerun: ${inviteUrl}`);
	io.say(`Invite the bot to your server (choose the server and authorize):\n  ${inviteUrl}`);
	io.say("Waiting for the bot to join…");
	for (const deadline = Date.now() + waitMs; Date.now() < deadline; ) {
		throwIfAborted(signal);
		await interruptibleSleep(sleep, Math.min(INVITE_POLL_MS, Math.max(0, deadline - Date.now())), signal);
		throwIfAborted(signal);
		guilds = records(await api("GET", "/users/@me/guilds"));
		throwIfAborted(signal);
		if (guilds.length) return guilds;
	}
	throw new Error(`The bot has not joined a server yet; invite it, then rerun: ${inviteUrl}`);
}

/** Discord's documented order: @everyone and role bits, Administrator, then @everyone/role/member overwrites. */
export function discordChannelPermissions(
	guild: Record<string, unknown>,
	memberRoleIds: string[],
	channel: Record<string, unknown>,
	botId: string,
): bigint {
	if (guild.owner_id === botId) return EVERYTHING;
	const guildId = str(guild.id);
	const parseBits = (value: unknown): bigint =>
		typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : 0n;
	const roles = new Map(records(guild.roles).map(role => [str(role.id), parseBits(role.permissions)]));
	let permissions = roles.get(guildId) ?? 0n;
	for (const id of memberRoleIds) permissions |= roles.get(id) ?? 0n;
	if (permissions & ADMINISTRATOR) return EVERYTHING;
	const overwrites = records(channel.permission_overwrites);
	const everyone = overwrites.find(overwrite => overwrite.id === guildId);
	if (everyone) permissions = (permissions & ~parseBits(everyone.deny)) | parseBits(everyone.allow);
	let allow = 0n;
	let deny = 0n;
	for (const overwrite of overwrites) {
		if (overwrite.type === 0 && memberRoleIds.includes(str(overwrite.id) ?? "")) {
			allow |= parseBits(overwrite.allow);
			deny |= parseBits(overwrite.deny);
		}
	}
	permissions = (permissions & ~deny) | allow;
	const member = overwrites.find(overwrite => overwrite.type === 1 && overwrite.id === botId);
	if (member) permissions = (permissions & ~parseBits(member.deny)) | parseBits(member.allow);
	return permissions;
}

export async function selectDiscordChannels(
	api: DiscordApiFn,
	bot: DiscordBotInfo,
	guilds: Record<string, unknown>[],
	requested: string[] | undefined,
	inviteUrl: string,
	io: DiscordSetupIO,
): Promise<RequestChannel[]> {
	const guildCache = new Map<
		string,
		{ guild: Record<string, unknown>; roles: string[]; channels: Record<string, unknown>[] }
	>();
	const loadGuild = async (guildId: string) => {
		let entry = guildCache.get(guildId);
		if (!entry) {
			const [guild, member, channels] = await Promise.all([
				api("GET", `/guilds/${guildId}`),
				api("GET", `/guilds/${guildId}/members/${bot.id}`),
				api("GET", `/guilds/${guildId}/channels`),
			]);
			entry = {
				guild: isRecord(guild) ? guild : {},
				roles:
					isRecord(member) && Array.isArray(member.roles) ? member.roles.filter(id => typeof id === "string") : [],
				channels: records(channels),
			};
			guildCache.set(guildId, entry);
		}
		return entry;
	};
	const guildIds = new Set(guilds.map(guild => str(guild.id)));
	const nameOf = (guildId: string): string => str(guilds.find(guild => guild.id === guildId)?.name) ?? guildId;
	const missingOf = (permissions: bigint): string[] =>
		DISCORD_REQUIRED_PERMISSIONS.filter(([, bit]) => !(permissions & bit)).map(([name]) => name);

	if (requested?.length) {
		const selected: RequestChannel[] = [];
		for (const id of requested) {
			let channel: unknown;
			try {
				channel = await api("GET", `/channels/${id}`);
			} catch {
				throw new Error(`The bot cannot see channel ${id}; invite it to that server: ${inviteUrl}`);
			}
			if (!isRecord(channel) || !str(channel.guild_id) || !guildIds.has(str(channel.guild_id))) {
				throw new Error(`Channel ${id} is not in a server the bot has joined; invite it: ${inviteUrl}`);
			}
			if (typeof channel.type !== "number" || (!Object.hasOwn(REQUEST_CHANNEL_TYPES, channel.type) && !Object.hasOwn(THREAD_TYPES, channel.type))) {
				throw new Error(`Channel ${id} must be a text channel or thread`);
			}
			if (Object.hasOwn(THREAD_TYPES, channel.type) && !str(channel.parent_id)) throw new Error(`Thread ${id} has no parent channel`);
			const guildId = channel.guild_id as string;
			const { guild, roles, channels } = await loadGuild(guildId);
			const targetId =
				typeof channel.type === "number" && Object.hasOwn(THREAD_TYPES, channel.type) ? channel.parent_id : id;
			const target = channels.find(candidate => candidate.id === targetId) ?? channel;
			const missing = missingOf(discordChannelPermissions(guild, roles, target, bot.id));
			if (missing.length) throw new Error(`The bot lacks ${missing.join(", ")} in #${str(channel.name) ?? id}`);
			selected.push({ id, name: str(channel.name) ?? id, guildName: nameOf(guildId) });
		}
		return selected;
	}

	const candidates: RequestChannel[] = [];
	for (const guildId of guildIds) {
		if (!guildId) continue;
		const { guild, roles, channels } = await loadGuild(guildId);
		for (const channel of channels) {
			if (
				typeof channel.type !== "number" ||
				!Object.hasOwn(REQUEST_CHANNEL_TYPES, channel.type) ||
				!str(channel.id)
			)
				continue;
			if (missingOf(discordChannelPermissions(guild, roles, channel, bot.id)).length) continue;
			candidates.push({
				id: channel.id as string,
				name: str(channel.name) ?? (channel.id as string),
				guildName: nameOf(guildId),
			});
		}
	}
	if (!candidates.length) {
		throw new Error(
			`No text channel grants the bot ${DISCORD_REQUIRED_PERMISSIONS.map(([name]) => name).join(", ")}; grant them or pass --channel`,
		);
	}
	if (candidates.length === 1) return candidates;
	const listing = candidates.map(
		(channel, index) => `  ${index + 1}. #${channel.name} in ${channel.guildName} (${channel.id})`,
	);
	if (!io.interactive) throw new Error(`Several channels qualify; pass --channel <id>:\n${listing.join("\n")}`);
	io.say(`Channels where the bot can work:\n${listing.join("\n")}`);
	const answer = (await io.ask("Request channel number [1]: ")).trim();
	const index = answer ? Number.parseInt(answer, 10) - 1 : 0;
	const choice = candidates[index];
	if (!choice) throw new Error("No channel selected");
	return [choice];
}

async function openOwnerDm(api: DiscordApiFn, userId: string, io: DiscordSetupIO): Promise<string | undefined> {
	try {
		const channel = await api("POST", "/users/@me/channels", { recipient_id: userId });
		const id = isRecord(channel) ? str(channel.id) : undefined;
		if (id) return id;
	} catch {
		// Reported below; server requests still work.
	}
	io.say(`Could not open a DM with ${userId}; DMs to the bot will be ignored until its DM channel is allowed.`);
	return undefined;
}

export async function probeDiscordGateway(
	api: DiscordApiFn,
	token: string,
	WebSocketImpl: typeof WebSocket,
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	const discovery = await api("GET", "/gateway/bot");
	throwIfAborted(signal);
	const url = discordGatewayUrl(isRecord(discovery) ? discovery.url : undefined);
	const result = Promise.withResolvers<void>();
	const socket = new WebSocketImpl(url);
	const timer = setTimeout(
		() => result.reject(new Error("Discord Gateway did not confirm the bot session in time")),
		GATEWAY_PROBE_MS,
	);
	const cancel = () => result.reject(new Error("Discord setup cancelled"));
	signal?.addEventListener("abort", cancel, { once: true });
	if (signal?.aborted) cancel();
	socket.addEventListener("message", (event: MessageEvent) => {
		if (signal?.aborted) return;
		let packet: unknown;
		try {
			packet = typeof event.data === "string" ? JSON.parse(event.data) : undefined;
		} catch {
			return;
		}
		if (!isRecord(packet)) return;
		if (packet.op === 10) {
			socket.send(
				JSON.stringify({
					op: 2,
					d: {
						token,
						intents: DISCORD_GATEWAY_INTENTS,
						properties: { os: process.platform, browser: "jeo", device: "jeo" },
					},
				}),
			);
		} else if (packet.op === 0 && packet.t === "READY") {
			result.resolve();
		}
	});
	socket.addEventListener("close", (event: CloseEvent) => {
		if (event.code === 4004) result.reject(new Error("Discord Gateway rejected the bot token (4004)"));
		else if (event.code === 4013 || event.code === 4014) {
			result.reject(new Error("Discord Gateway refused the message intents (4014); enable Message Content Intent"));
		} else result.reject(new Error(`Discord Gateway closed before the session was ready (${event.code})`));
	});
	socket.addEventListener("error", () => result.reject(new Error("Discord Gateway connection failed")));
	try {
		await result.promise;
		throwIfAborted(signal);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
		try {
			socket.close(1000);
		} catch {
			// Already closed.
		}
	}
}

/** The token is read from the 0600 file at launch, so it never lands in this script or a service definition. */
export function discordRunScript(command: string[], configName: string, tokenEnv: string, envPath: string): string {
	const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
	return `#!/bin/sh
# Generated by \`jeo messenger setup\`: starts this profile's Discord gateway.
set -eu
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
token_file="$dir/${TOKEN_FILE}"
case "$(ls -ln "$token_file" | cut -c5-10)" in
	------) ;;
	*) echo "${TOKEN_FILE} must be readable by its owner only (chmod 600)" >&2; exit 1 ;;
esac
PATH=${quote(envPath)}
export PATH
${tokenEnv}=$(cat "$token_file")
export ${tokenEnv}
exec ${command.map(quote).join(" ")} messenger run --config "$dir/${configName}"
`;
}

/** The Windows launcher inherits PATH at launch; the token remains in the private sidecar. */
export function discordRunCommand(command: string[], configName: string, tokenEnv: string): string {
	if (!/^[A-Za-z_]/u.test(tokenEnv) || /[^A-Za-z0-9_]/u.test(tokenEnv)) throw new Error("discord.tokenEnv must name an environment variable");
	const literal = (value: string, label: string): string => {
		if (/["\r\n]/.test(value)) throw new Error(`Windows launcher ${label} must not contain quotes or newlines`);
		if (/[^\x00-\x7f]/.test(value)) throw new Error(`Windows launcher ${label} must contain only ASCII characters; use ASCII paths`);
		return value.replace(/%/g, "%%");
	};
	const quote = (value: string): string => `"${literal(value, "command")}"`;
	return `@echo off\r\nsetlocal DisableDelayedExpansion\r\nset /p "${tokenEnv}="<"%~dp0${TOKEN_FILE}"\r\n${command.map(quote).join(" ")} messenger run --config "%~dp0${literal(configName, "config name")}"\r\n`;
}

async function writePrivate(file: string, content: string, mode: number): Promise<void> {
	const temporary = `${file}.${process.pid}.tmp`;
	await Bun.write(temporary, content);
	await fs.chmod(temporary, mode);
	await fs.rename(temporary, file);
}

async function readExistingConfig(configPath: string): Promise<Record<string, unknown> | undefined> {
	let text: string;
	try {
		text = await Bun.file(configPath).text();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	try {
		const value: unknown = JSON.parse(text);
		if (isRecord(value)) return value;
	} catch {
		// Fall through to the refusal below.
	}
	throw new Error(`${configPath} exists but is not a JSON object; fix or move it before setup`);
}

export function currentJeoCommand(entry = Bun.main, execPath = process.execPath): string[] {
	return entry === execPath || entry.startsWith("/$bunfs/") || entry.replaceAll("\\", "/").startsWith("B:/~BUN/") ? [execPath] : [execPath, entry];
}

export function messengerExecutablePath(execPath: string, inheritedPath: string | undefined, delimiter: string, platform: NodeJS.Platform): string {
	const fallbackPath = platform === "win32" ? "" : "/usr/bin:/bin";
	const runtimeDirectory = platform === "win32" ? path.win32.dirname(execPath) : path.dirname(execPath);
	return [...new Set([runtimeDirectory, ...(inheritedPath ?? fallbackPath).split(delimiter).filter(Boolean)])].join(delimiter);
}

/** Create or repair a Discord messenger profile with as few manual steps as Discord allows. */
export async function setupDiscordMessenger(
	options: DiscordSetupOptions,
	io: DiscordSetupIO,
	deps: DiscordSetupDeps = {},
): Promise<DiscordSetupResult> {
	const env = deps.env ?? process.env;
	const configPath = path.resolve(options.configPath);
	const directory = path.dirname(configPath);
	const tokenPath = path.join(directory, TOKEN_FILE);
	const platform = deps.platform ?? process.platform;
	throwIfAborted(deps.signal);
	if (options.service && platform !== "darwin" && platform !== "linux") {
		throw new Error("Background services are supported only on macOS and Linux");
	}
	const runScript = path.join(directory, platform === "win32" ? RUN_SCRIPT_WINDOWS : RUN_SCRIPT_POSIX);
	const delimiter = deps.pathDelimiter ?? path.delimiter;
	const envPath = messengerExecutablePath(process.execPath, env.PATH, delimiter, platform);
	const command = deps.jeoCommand ?? currentJeoCommand();
	const existing = await readExistingConfig(configPath);
	const sandbox = existing?.sandbox !== undefined ? parseMessengerSandbox(existing.sandbox) : parseMessengerSandbox({
		image: await io.ask("Existing local Linux sandbox image (no image will be pulled): "),
		limits: {
			memoryBytes: Number(await io.ask("Sandbox memory limit in bytes: ")),
			pids: Number(await io.ask("Sandbox process limit: ")),
			cpus: Number(await io.ask("Sandbox CPU limit: ")),
		},
	});
	if (existing && Object.hasOwn(existing, "independentSessions")) {
		delete existing.independentSessions;
		io.say("Removed obsolete independentSessions setting. Discord threads now keep one persistent session.");
	}
	if (platform === "win32") discordRunCommand(command, path.basename(configPath), DISCORD_TOKEN_ENV);

	const token = await resolveToken(env, tokenPath, io);
	throwIfAborted(deps.signal);
	const api = discordApi(token, deps.fetch ?? fetch, deps.signal);
	const bot = await inspectDiscordBot(api);
	throwIfAborted(deps.signal);
	io.say(`Bot ${bot.username} (${bot.id}), application ${bot.applicationId}`);
	await ensureMessageContentIntent(api, bot, io);
	throwIfAborted(deps.signal);

	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	throwIfAborted(deps.signal);
	await writePrivate(tokenPath, `${token}\n`, 0o600);
	throwIfAborted(deps.signal);

	const inviteUrl = discordInviteUrl(bot.applicationId);
	const guilds = await waitForDiscordGuilds(api, inviteUrl, io, deps.sleep ?? Bun.sleep, options.inviteWaitMs ?? 300_000, deps.signal);
	throwIfAborted(deps.signal);
	const platforms = isRecord(existing?.platforms) ? existing.platforms : {};
	const previous = isRecord(platforms.discord) ? platforms.discord : {};
	const previousList = (key: string): string[] | undefined => {
		const value = previous[key];
		return Array.isArray(value) && value.length ? value.filter(id => typeof id === "string") : undefined;
	};

	const userIds = options.userIds?.length ? options.userIds : (previousList("allowedUserIds") ?? bot.ownerIds);
	if (!userIds.length) throw new Error("Could not identify the application owner; pass --user <your Discord user id>");
	let channelIds: string[];
	if (options.channelIds?.length || !previousList("allowedChannelIds")) {
		const channels = await selectDiscordChannels(api, bot, guilds, options.channelIds, inviteUrl, io);
		throwIfAborted(deps.signal);
		for (const channel of channels) io.say(`Request channel: #${channel.name} in ${channel.guildName}`);
		channelIds = channels.map(channel => channel.id);
	} else {
		channelIds = previousList("allowedChannelIds") as string[];
	}
	const dmChannel = options.dmTest === false ? undefined : await openOwnerDm(api, userIds[0]!, io);
	throwIfAborted(deps.signal);
	const allowedChannelIds = [...new Set([...channelIds, ...(dmChannel ? [dmChannel] : [])])];
	const tokenEnv = str(previous.tokenEnv) ?? DISCORD_TOKEN_ENV;
	if (platform === "win32") discordRunCommand(command, path.basename(configPath), tokenEnv);

	const discord: Record<string, unknown> = { ...previous, tokenEnv, allowedUserIds: userIds, allowedChannelIds };
	if (options.artifacts) discord.artifactDir = "./artifacts";
	const defaultTools = ["read", "find", "search", "write", "edit", "bash", "computer"];
	const config = {
		...existing,
		cwd: str(existing?.cwd) ?? "./workspace",
		sessionDir: str(existing?.sessionDir) ?? path.join(notifyDir(), "messenger-sessions"),
		sandbox,
		toolNames: options.toolNames ?? (Array.isArray(existing?.toolNames) ? existing.toolNames : defaultTools),
		platforms: { ...platforms, discord },
	};
	for (const relative of [config.cwd, config.sessionDir, discord.artifactDir]) {
		if (typeof relative === "string")
			await fs.mkdir(path.resolve(directory, relative), { recursive: true, mode: 0o700 });
		throwIfAborted(deps.signal);
	}
	await writePrivate(configPath, `${JSON.stringify(config, null, 2)}\n`, 0o600);
	throwIfAborted(deps.signal);
	await writePrivate(
		runScript,
		platform === "win32"
			? discordRunCommand(command, path.basename(configPath), tokenEnv)
			: discordRunScript(command, path.basename(configPath), tokenEnv, envPath),
		0o700,
	);
	throwIfAborted(deps.signal);
	// The same loader `messenger run` uses must accept what was written.
	const written = await loadMessengerConfig(configPath);
	validateMessengerEnvironment(
		{ ...written, platforms: { discord: written.platforms.discord } },
		{ [tokenEnv]: token },
	);

	await probeDiscordGateway(api, token, deps.WebSocket ?? WebSocket, deps.signal);
	throwIfAborted(deps.signal);
	io.say("Discord Gateway accepted the bot session and intents.");

	let service: string | undefined;
	if (options.service) {
		service = await (deps.installService ?? installMessengerService)(messengerServicePlan(directory, runScript));
		throwIfAborted(deps.signal);
		io.say(`Gateway running as ${service}`);
	}
	if (dmChannel) {
		try {
			await api("POST", `/channels/${dmChannel}/messages`, { content: DM_TEST_MESSAGE });
			io.say("Sent a test DM to the owner.");
		} catch {
			io.say(
				"Could not send the test DM (the owner may block DMs from server members); server requests still work.",
			);
			throwIfAborted(deps.signal);
		}
	}
	throwIfAborted(deps.signal);
	return {
		configPath,
		botName: bot.username,
		applicationId: bot.applicationId,
		inviteUrl,
		allowedUserIds: userIds,
		allowedChannelIds,
		runScript,
		...(service ? { service } : {}),
	};
}
