import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { loadMessengerConfig, validateMessengerEnvironment } from "../messenger/config";
import { createDiscordAdapter } from "../messenger/discord";
import { defaultDiscordConfigPath, setupDiscordMessenger } from "../messenger/discord-setup";
import { refreshMessengerProfiles } from "../messenger/runtime";
import { messengerArtifactPrompt } from "../messenger/artifacts";
import { createMessengerGateway, messengerSessionRoute } from "../messenger/gateway";
import { createMessengerSessionPool } from "../messenger/session-pool";
import { createSlackAdapter } from "../messenger/slack";
import { createTelegramAdapter } from "../messenger/telegram";
import { isEnoent, type MessengerAdapter, type MessengerConfig, type MessengerReply } from "../messenger/types";
import { createSession } from "../agent/session";
import { selectDiscordModel } from "../messenger/model-selection";
import type { MessengerGatewayOptions } from "../messenger/gateway";
import { isBrokenPipeError } from "../util/broken-pipe";

type MessengerAction = "setup" | "check" | "run" | "update";
type Flags = { config?: string; channel: string[]; user: string[]; tools?: string; artifacts: boolean; service: boolean; noDm: boolean; projectPath?: string };
const VALUE_FLAGS: Record<string, true> = { "--config": true, "--channel": true, "--user": true, "--tools": true, "--project": true };
const STRIPPED_WORKER_ENV: Record<string, true> = {
	JEO_MESSENGER_SANDBOX: true,
	JEO_MESSENGER_ALLOWED_USER_IDS: true,
	JEO_MESSENGER_SESSION_KEY: true,
	JEO_MESSENGER_PROFILE_DIR: true,
	JEO_MESSENGER_HOST_BOOTSTRAP: true,
	JEO_MESSENGER_SHUTDOWN_NONCE: true,
	JEO_MESSENGER_READ_ROOTS: true,
	JEO_MESSENGER_READ_ACCESS: true,
	JEO_MESSENGER_COMPUTER_ENABLED: true,
	JEO_MESSENGER_USAGE_FALLBACK_MODEL: true,
	JEO_MESSENGER_FIXED_MODEL: true,
};

function parse(args: string[]): { action: MessengerAction; flags: Flags } {
	const action = args.shift();
	if (action !== "setup" && action !== "check" && action !== "run" && action !== "update") {
		throw new Error("Usage: jeo messenger setup|check|run [--config <file>] | jeo messenger update [--config <file>]");
	}
	const flags: Flags = { channel: [], user: [], artifacts: false, service: false, noDm: false };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--artifacts") flags.artifacts = true;
		else if (arg === "--service") flags.service = true;
		else if (arg === "--no-dm") flags.noDm = true;
		else if (Object.hasOwn(VALUE_FLAGS, arg)) {
			const value = args[++index];
			if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
			if (arg === "--config") flags.config = value;
			else if (arg === "--tools") flags.tools = value;
			else if (arg === "--project") flags.projectPath = value;
			else flags[arg === "--channel" ? "channel" : "user"].push(...value.split(",").filter(Boolean));
		} else throw new Error(`Unknown messenger option: ${arg}`);
	}
	if (action !== "setup" && flags.projectPath !== undefined) {
		throw new Error("--project is only supported by messenger setup");
	}
	return { action, flags };
}

function terminalIO() {
	let muted = false;
	const safeWrite = (text: string) => {
		try { process.stdout.write(text); }
		catch (err) { if (!isBrokenPipeError(err)) throw err; }
	};
	const output = new Writable({
		write(chunk, _encoding, callback) {
			if (!muted) {
				try { process.stdout.write(chunk); }
				catch (err) {
					if (!isBrokenPipeError(err)) { callback(err as Error); return; }
				}
			}
			callback();
		},
	});
	const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY), historySize: 0 });
	const controller = new AbortController();
	const interrupted = new AbortController();
	rl.on("SIGINT", () => { interrupted.abort(); rl.close(); });
	rl.on("close", () => controller.abort());
	const ask = async (question: string, secret = false) => {
		safeWrite(question);
		muted = secret;
		try { return (await rl.question("", { signal: controller.signal })).trim(); }
		finally { muted = false; if (secret) safeWrite("\n"); }
	};
	return {
		interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		signal: interrupted.signal,
		say: (line: string) => safeWrite(`${line}\n`),
		ask: (question: string) => ask(question),
		askSecret: (question: string) => ask(question, true),
		close: () => rl.close(),
	};
}

function routeUuid(config: MessengerConfig, message: Parameters<MessengerReply>[0]): string {
	const hex = messengerSessionRoute(config.cwd, message);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface MessengerCliReplyOptions {
	/** Operator log line sink (gateway stderr); receives bounded worker diagnostics, never message text or tokens. */
	log?: (line: string) => void;
}

export type MessengerCliReply = MessengerReply & {
	close(): Promise<void>;
};

/** Run each conversation in its own reusable host session process (jeopi-compatible, non-sandboxed). */
export function createMessengerCliReply(
	config: MessengerConfig,
	spawn: typeof Bun.spawn = Bun.spawn,
	selectModel: typeof selectDiscordModel = selectDiscordModel,
	options: MessengerCliReplyOptions = {},
): MessengerCliReply {
	const lifetime = new AbortController();
	const inflight = new Set<Promise<string>>();
	const pool = createMessengerSessionPool(spawn, undefined, undefined, undefined, {
		requireSandboxCleanup: true,
		...(options.log ? { onDiagnostic: (key: string, line: string) => options.log!(`worker ${key.slice(0, 8)}: ${line}`) } : {}),
	});
	const cwd = path.resolve(config.cwd);
	const sessionDir = path.resolve(config.sessionDir);
	const executable = process.execPath;
	const sourceEntry = process.argv[1]?.endsWith(".ts") ? process.argv[1] : undefined;
	const tools = [...new Set(config.toolNames.map(name => name === "grep" ? "search" : name === "glob" ? "find" : name))];
	const toolFlags = tools.length ? ["--tools", tools.join(",")] : ["--no-tools"];
	const secretNames = new Set<string>();
	for (const platform of Object.values(config.platforms)) {
		if (!platform) continue;
		secretNames.add(platform.tokenEnv);
		if (platform.appTokenEnv) secretNames.add(platform.appTokenEnv);
		for (const name of [platform.tokenEnv, platform.appTokenEnv]) {
			if (name?.startsWith("JEO_")) secretNames.add(`JEOPI_${name.slice(4)}`);
			if (name?.startsWith("JEOPI_")) secretNames.add(`JEO_${name.slice(6)}`);
		}
	}
	let sessionDirReady: Promise<void> | undefined;

	const runReply: MessengerReply = async (message, signal, onActivity) => {
		signal = AbortSignal.any([signal, lifetime.signal]);
		signal.throwIfAborted();
		await (sessionDirReady ??= fs.mkdir(sessionDir, { recursive: true, mode: 0o700 }).then(() => undefined));
		signal.throwIfAborted();
		const id = routeUuid(config, message);
		const target = path.join(sessionDir, `${id}.jsonl`);
		try { await fs.access(target); }
		catch (error) {
			if (!isEnoent(error)) throw error;
			try { await createSession(cwd, id, undefined, sessionDir, true); }
			catch (createError) { if (!(createError instanceof Error && "code" in createError && createError.code === "EEXIST")) throw createError; }
		}
		signal.throwIfAborted();
		const artifactPrompt = await messengerArtifactPrompt(config.platforms[message.platform]?.artifactDir, message, signal);
		const platformConfig = config.platforms[message.platform];
		const model = message.platform === "discord" ? await selectModel(platformConfig?.model, { signal }) : platformConfig?.model;
		const modelFlags = model ? ["--model", model] : [];
		const command = [executable, ...(sourceEntry ? ["--no-env-file", sourceEntry] : []), "launch", "--print", "--no-tui", "--literal-worker", ...toolFlags, ...modelFlags, "--resume", id, "--", "worker"];

		const env: Record<string, string> = {};
		for (const [name, value] of Object.entries(process.env)) {
			if (value !== undefined && !secretNames.has(name) && !Object.hasOwn(STRIPPED_WORKER_ENV, name)) env[name] = value;
		}
		for (const name of secretNames) env[name] = "";
		env.JEO_SESSION_DIR = sessionDir;
		if (platformConfig?.usageFallbackModel) {
			if (message.platform !== "discord") env.JEO_MESSENGER_USAGE_FALLBACK_MODEL = platformConfig.usageFallbackModel;
			else {
				try { env.JEO_MESSENGER_USAGE_FALLBACK_MODEL = await selectModel(platformConfig.usageFallbackModel, { signal }); }
				catch {
					signal.throwIfAborted();
					console.warn("Discord usage fallback model could not be verified; fallback disabled for this request.");
				}
			}
		}
		if (model) env.JEO_MESSENGER_FIXED_MODEL = "1";
		const policyKey = message.platform === "discord" ? JSON.stringify([model, env.JEO_MESSENGER_USAGE_FALLBACK_MODEL]) : undefined;
		signal.throwIfAborted();
		return await pool.turn(id, command, cwd, env, [message.text, artifactPrompt].filter(Boolean).join("\n\n"), signal, onActivity, policyKey);
	};

	const reply: MessengerReply = (message, signal, onActivity) => {
		const turn = runReply(message, signal, onActivity);
		inflight.add(turn);
		void turn.then(() => inflight.delete(turn), () => inflight.delete(turn));
		return turn;
	};

	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => closing ??= (async () => {
		lifetime.abort();
		await pool.close();
		await Promise.allSettled(inflight);
	})();

	return Object.assign(reply, { close });
}

export async function runMessengerCommand(args: string[]): Promise<void> {
	const { action, flags } = parse([...args]);
	const configPath = path.resolve(flags.config ?? defaultDiscordConfigPath());
	if (action === "setup") {
		const io = terminalIO();
		const controller = new AbortController();
		const stop = () => { controller.abort(); io.close(); };
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		try {
			const result = await setupDiscordMessenger(
				{
					configPath,
					channelIds: flags.channel.length ? flags.channel : undefined,
					userIds: flags.user.length ? flags.user : undefined,
					toolNames: flags.tools === undefined ? undefined : flags.tools.split(",").map(item => item.trim()).filter(Boolean),
					artifacts: flags.artifacts,
					service: flags.service,
					dmTest: !flags.noDm,
					projectPath: flags.projectPath,
				},
				io,
				{ signal: AbortSignal.any([controller.signal, io.signal]) },
			);
			const isDefaultPath = path.resolve(result.configPath) === path.resolve(defaultDiscordConfigPath());
			const liveCmd = isDefaultPath
				? "/discord live --allow-full-control"
				: `/discord live ${result.configPath} --allow-full-control`;
			process.stdout.write(
				`Discord messenger ready: ${result.configPath}\n` +
				`  allowed users: ${result.allowedUserIds.join(", ")}\n` +
				`  allowed channels: ${result.allowedChannelIds.join(", ")}\n` +
				`Default (connect running terminal session): in 'jeo', run ${liveCmd}\n` +
				`Standalone gateway (optional): ${result.runScript}\n`,
			);
		} finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); io.close(); }
		return;
	}
	if (action === "update") {
		const { failed } = await refreshMessengerProfiles(flags.config ? [flags.config] : undefined, line => process.stdout.write(`${line}\n`));
		if (failed) process.exitCode = 1;
		return;
	}
	let config: MessengerConfig;
	try { config = await loadMessengerConfig(configPath); validateMessengerEnvironment(config); }
	catch (error) { throw new Error(error instanceof Error ? error.message : "Messenger configuration or required environment is invalid"); }
	const platforms = Object.keys(config.platforms);
	if (action === "check") {
		process.stdout.write(`Messenger configuration valid: ${platforms.join(", ")}; ${config.toolNames.length} tools enabled. No network checks performed.\n`);
		return;
	}
	if (config.toolNames.length > 0) {
		process.stderr.write("Warning: enabled messenger tools grant authorized remote users local machine authority; this is not a sandbox.\n");
	}
	const adapters: MessengerAdapter[] = [];
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGINT", stop); process.once("SIGTERM", stop);
	const log = (line: string): void => { process.stderr.write(`[jeo messenger ${new Date().toISOString()}] ${line}\n`); };
	const reply = createMessengerCliReply(config, undefined, undefined, { log });
	if (config.platforms.discord) adapters.push(createDiscordAdapter(config.platforms.discord));
	if (config.platforms.telegram) adapters.push(createTelegramAdapter(config.platforms.telegram));
	if (config.platforms.slack) adapters.push(createSlackAdapter(config.platforms.slack));
	const onRequestError: NonNullable<MessengerGatewayOptions["onRequestError"]> = (message, error, stage) =>
		log(`${message.platform} request failed at ${stage} (conversation ${routeUuid(config, message).slice(0, 8)}): ${error instanceof Error ? error.message : String(error)}`);
	try {
		const gateway = createMessengerGateway(config, adapters, reply, { concurrency: 4, onRequestError });
		process.stdout.write(`Starting messenger: ${platforms.join(", ")}. Press Ctrl+C to stop.\n`);
		await gateway.run(controller.signal);
	} finally {
		controller.abort();
		try { await reply.close(); }
		finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
	}
}
