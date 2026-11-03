import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { loadMessengerConfig, validateMessengerEnvironment } from "../messenger/config";
import { createDiscordAdapter } from "../messenger/discord";
import { setupDiscordMessenger } from "../messenger/discord-setup";
import { messengerArtifactPrompt } from "../messenger/artifacts";
import { createMessengerGateway, messengerSessionRoute, messengerConversationKey } from "../messenger/gateway";
import { createMessengerSessionPool } from "../messenger/session-pool";
import { createSlackAdapter } from "../messenger/slack";
import { createTelegramAdapter } from "../messenger/telegram";
import type { MessengerAdapter, MessengerConfig, MessengerReply } from "../messenger/types";
import { createSession } from "../agent/session";
import { selectDiscordModel } from "../messenger/model-selection";

type Flags = { config?: string; channel: string[]; user: string[]; tools?: string; artifacts: boolean; service: boolean; noDm: boolean };

function parse(args: string[]): { action: "setup" | "check" | "run"; flags: Flags } {
	const action = args.shift();
	if (action !== "setup" && action !== "check" && action !== "run") throw new Error("Usage: jeo messenger setup|check|run --config <file>");
	const flags: Flags = { channel: [], user: [], artifacts: false, service: false, noDm: false };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--artifacts") flags.artifacts = true;
		else if (arg === "--service") flags.service = true;
		else if (arg === "--no-dm") flags.noDm = true;
		else if (["--config", "--channel", "--user", "--tools"].includes(arg)) {
			const value = args[++index];
			if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
			if (arg === "--config") flags.config = value;
			else if (arg === "--tools") flags.tools = value;
			else flags[arg === "--channel" ? "channel" : "user"].push(...value.split(",").filter(Boolean));
		} else throw new Error(`Unknown messenger option: ${arg}`);
	}
	if (!flags.config) throw new Error("Messenger requires --config <file>");
	return { action, flags };
}

function terminalIO() {
	let muted = false;
	const output = new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
	const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
	const controller = new AbortController();
	rl.on("close", () => controller.abort());
	const ask = async (question: string, secret = false) => {
		process.stdout.write(question);
		muted = secret;
		try { return (await rl.question("", { signal: controller.signal })).trim(); }
		finally { muted = false; if (secret) process.stdout.write("\n"); }
	};
	return {
		interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		say: (line: string) => process.stdout.write(`${line}\n`),
		ask: (question: string) => ask(question),
		askSecret: (question: string) => ask(question, true),
		close: () => rl.close(),
	};
}

function routeUuid(config: MessengerConfig, message: Parameters<MessengerReply>[0]): string {
	if (config.independentSessions) {
		const hex = new Bun.CryptoHasher("sha256").update(JSON.stringify([config.cwd, messengerConversationKey(message), message.messageId])).digest("hex");
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
	}
	const hex = messengerSessionRoute(config.cwd, message);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Run each conversation in its own reusable agent process. */
export function createMessengerCliReply(config: MessengerConfig, spawn: typeof Bun.spawn = Bun.spawn, selectModel: typeof selectDiscordModel = selectDiscordModel): MessengerReply & { close(): Promise<void> } {
	const pool = createMessengerSessionPool(spawn);
	const reply: MessengerReply = async (message, signal, onActivity) => {
		if (signal.aborted) throw new Error("Messenger request aborted");
		const id = routeUuid(config, message);
		await fs.mkdir(config.sessionDir, { recursive: true, mode: 0o700 });
		if (signal.aborted) throw new Error("Messenger request aborted");
		const target = path.join(config.sessionDir, `${id}.jsonl`);
		const legacy = path.join(config.cwd, ".jeo", "sessions", `${id}.jsonl`);
		try {
			await fs.access(target);
			if (signal.aborted) throw new Error("Messenger request aborted");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			let old;
			try { old = await fs.open(legacy, constants.O_RDONLY | constants.O_NOFOLLOW); }
			catch (openError) { if ((openError as NodeJS.ErrnoException).code !== "ENOENT") throw openError; }
			if (signal.aborted) { await old?.close(); throw new Error("Messenger request aborted"); }
			try {
				if (old) {
					if (!(await old.stat()).isFile()) throw new Error("Invalid legacy messenger session");
					if (signal.aborted) throw new Error("Messenger request aborted");
					const contents = await old.readFile();
					if (signal.aborted) throw new Error("Messenger request aborted");
					const temporary = `${target}.${crypto.randomUUID()}.tmp`;
					try {
						await fs.writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
						if (signal.aborted) throw new Error("Messenger request aborted");
						await fs.link(temporary, target);
					} finally { await fs.unlink(temporary).catch(() => {}); }
				} else {
					await createSession(config.cwd, id, undefined, config.sessionDir, true);
				}
			} catch (createError) {
				if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError;
			} finally { await old?.close(); }
		}
		const artifactPrompt = await messengerArtifactPrompt(config.platforms[message.platform]?.artifactDir, message, signal);
		if (signal.aborted) throw new Error("Messenger request aborted");
		const executable = process.execPath;
		const sourceEntry = process.argv[1]?.endsWith(".ts") ? process.argv[1] : undefined;
		const tools = [...new Set(config.toolNames.map(name => name === "grep" ? "search" : name === "glob" ? "find" : name))];
		const toolFlags = tools.length ? ["--tools", tools.join(",")] : ["--no-tools"];
		const platformConfig = config.platforms[message.platform];
		const model = message.platform === "discord" ? await selectModel(platformConfig?.model, { signal }) : platformConfig?.model;
		const modelFlags = model ? ["--model", model] : [];
		const command = [executable, ...(sourceEntry ? ["--no-env-file", sourceEntry] : []), "launch", "--print", "--no-tui", "--no-skills", "--literal-worker", ...toolFlags, ...modelFlags, "--resume", id, "--", "worker"];
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
		const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && !secretNames.has(name))) as Record<string, string>;
		for (const name of secretNames) env[name] = "";
		env.JEO_SESSION_DIR = config.sessionDir;
		// The explicit tool allowlist is the opt-in for this worker only.
		env.JEO_MESSENGER_COMPUTER_ENABLED = tools.includes("computer") ? "1" : "0";
		// Never inherit another platform's fallback policy from the gateway environment.
		delete env.JEO_MESSENGER_USAGE_FALLBACK_MODEL;
		if (platformConfig?.usageFallbackModel) {
			if (message.platform !== "discord") env.JEO_MESSENGER_USAGE_FALLBACK_MODEL = platformConfig.usageFallbackModel;
			else {
				try { env.JEO_MESSENGER_USAGE_FALLBACK_MODEL = await selectModel(platformConfig.usageFallbackModel, { signal }); }
				catch {
					if (signal.aborted) throw new Error("Messenger request aborted");
					console.warn("Discord usage fallback model could not be verified; fallback disabled for this request.");
				}
			}
		}
		delete env.JEO_MESSENGER_FIXED_MODEL;
		if (model) env.JEO_MESSENGER_FIXED_MODEL = "1";
		const policyKey = message.platform === "discord" ? JSON.stringify([model, env.JEO_MESSENGER_USAGE_FALLBACK_MODEL]) : undefined;
		return pool.turn(id, command, config.cwd, env, [message.text, artifactPrompt].filter(Boolean).join("\n\n"), signal, onActivity, policyKey);
	};
	return Object.assign(reply, { close: pool.close });
}

export async function runMessengerCommand(args: string[]): Promise<void> {
	const { action, flags } = parse([...args]);
	if (action === "setup") {
		const io = terminalIO();
		const controller = new AbortController();
		const stop = () => { controller.abort(); io.close(); };
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		try {
			const result = await setupDiscordMessenger({ configPath: path.resolve(flags.config!), channelIds: flags.channel.length ? flags.channel : undefined, userIds: flags.user.length ? flags.user : undefined, toolNames: flags.tools?.split(",").filter(Boolean), artifacts: flags.artifacts, service: flags.service, dmTest: !flags.noDm }, io, { signal: controller.signal });
			process.stdout.write(`Discord messenger ready: ${result.configPath}\nStart: ${result.runScript}\n`);
		} finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); io.close(); }
		return;
	}
	let config: MessengerConfig;
	try { config = await loadMessengerConfig(flags.config!); validateMessengerEnvironment(config); }
	catch { throw new Error("Messenger configuration or required environment is invalid"); }
	const platforms = Object.keys(config.platforms);
	if (action === "check") { process.stdout.write(`Messenger configuration valid: ${platforms.join(", ")}; ${config.toolNames.length} tools enabled. No network checks performed.\n`); return; }
	if (config.toolNames.length) process.stderr.write("Warning: messenger tools grant authorized remote users local machine authority; this is not a sandbox.\n");
	const adapters: MessengerAdapter[] = [];
	if (config.platforms.discord) adapters.push(createDiscordAdapter(config.platforms.discord));
	if (config.platforms.telegram) adapters.push(createTelegramAdapter(config.platforms.telegram));
	if (config.platforms.slack) adapters.push(createSlackAdapter(config.platforms.slack));
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGINT", stop); process.once("SIGTERM", stop);
	const reply = createMessengerCliReply(config);
	try { process.stdout.write(`Starting messenger: ${platforms.join(", ")}. Press Ctrl+C to stop.\n`); await createMessengerGateway(config, adapters, reply, { concurrency: 4 }).run(controller.signal); }
	finally { controller.abort(); await reply.close(); process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
