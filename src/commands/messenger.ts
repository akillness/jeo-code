import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { loadMessengerConfig, parseMessengerSandbox, validateMessengerEnvironment, validateMessengerStorage } from "../messenger/config";
import { createDiscordAdapter } from "../messenger/discord";
import { setupDiscordMessenger } from "../messenger/discord-setup";
import { refreshMessengerProfiles } from "../messenger/runtime";
import { messengerArtifactPrompt } from "../messenger/artifacts";
import { createMessengerGateway, messengerSessionRoute } from "../messenger/gateway";
import { createMessengerSessionPool } from "../messenger/session-pool";
import { createSlackAdapter } from "../messenger/slack";
import { createTelegramAdapter } from "../messenger/telegram";
import type { MessengerAdapter, MessengerConfig, MessengerReply } from "../messenger/types";
import { reapOrphanedNativeProcesses } from "../agent/sandbox/native";
import { createSession } from "../agent/session";
import { selectDiscordModel } from "../messenger/model-selection";
import type { MessengerGatewayOptions } from "../messenger/gateway";
import { notifySessionEndpointPath } from "../agent/notify/paths";
import { parseSessionEndpoint } from "../agent/notify/session-discovery";
import type { SandboxConfig } from "../agent/sandbox/types";

async function sendSandboxControl(config: MessengerConfig, id: string, userId: string, text: string, signal: AbortSignal): Promise<string> {
	const file = await fs.open(notifySessionEndpointPath(id), constants.O_RDONLY | constants.O_NOFOLLOW);
	let raw: string;
	try {
		const stat = await file.stat();
		if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error("Sandbox endpoint discovery is not private");
		raw = await file.readFile("utf8");
	} finally { await file.close(); }
	const endpoint = parseSessionEndpoint(raw);
	if (!endpoint || endpoint.cwd !== config.cwd) throw new Error("Sandbox endpoint session mismatch");
	if (signal.aborted) throw new Error("Sandbox control aborted");
	const { promise, resolve, reject } = Promise.withResolvers<string>();
		const reqId = crypto.randomUUID();
		const ws = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
		let sent = false;
		let settled = false;
		const finish = (error?: Error, output?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			ws.close();
			if (error) reject(error); else resolve(output ?? "Sandbox control returned no output");
		};
		const abort = () => finish(new Error("Sandbox control aborted"));
		const timer = setTimeout(() => finish(new Error("Sandbox control timed out; outcome is unconfirmed")), 30_000);
		signal.addEventListener("abort", abort, { once: true });
		ws.addEventListener("error", () => finish(new Error("Sandbox control endpoint unavailable")));
		ws.addEventListener("close", () => finish(new Error("Sandbox control endpoint closed")));
		ws.addEventListener("message", event => {
			try {
				const frame = JSON.parse(String(event.data));
				if (frame.type === "discord_control" && frame.sessionId === id && !sent) {
					if (frame.enabled !== true || !Number.isSafeInteger(frame.generation)) return finish(new Error("Discord sandbox control is disabled"));
					sent = true;
					ws.send(JSON.stringify({ type: "sandbox_control", sessionId: id, reqId, text, actor: { origin: "discord", sessionKey: id, userId }, controlGeneration: frame.generation }));
				} else if (frame.type === "ack" && frame.reqId === reqId && typeof frame.output === "string") finish(undefined, frame.output);
			} catch { finish(new Error("Invalid sandbox control response")); }
		});
		if (signal.aborted) abort();
	return promise;
}

type MessengerAction = "setup" | "check" | "run" | "update";
type Flags = { config?: string; channel: string[]; user: string[]; tools?: string; artifacts: boolean; service: boolean; noDm: boolean };

function parse(args: string[]): { action: MessengerAction; flags: Flags } {
	const action = args.shift();
	if (action !== "setup" && action !== "check" && action !== "run" && action !== "update") throw new Error("Usage: jeo messenger setup|check|run --config <file> | jeo messenger update [--config <file>]");
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
	if (!flags.config && action !== "update") throw new Error("Messenger requires --config <file>");
	return { action, flags };
}

function terminalIO() {
	let muted = false;
	const output = new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
	const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY), historySize: 0 });
	const controller = new AbortController();
	const interrupted = new AbortController();
	rl.on("SIGINT", () => { interrupted.abort(); rl.close(); });
	rl.on("close", () => controller.abort());
	const ask = async (question: string, secret = false) => {
		process.stdout.write(question);
		muted = secret;
		try { return (await rl.question("", { signal: controller.signal })).trim(); }
		finally { muted = false; if (secret) process.stdout.write("\n"); }
	};
	return {
		interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		signal: interrupted.signal,
		say: (line: string) => process.stdout.write(`${line}\n`),
		ask: (question: string) => ask(question),
		askSecret: (question: string) => ask(question, true),
		close: () => rl.close(),
	};
}

function routeUuid(config: MessengerConfig, message: Parameters<MessengerReply>[0]): string {
	const hex = messengerSessionRoute(config.cwd, message);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Whether a worker's environment selects the Docker-free native sandbox. */
function usesNativeSandbox(workerEnv: Readonly<Record<string, string>>): boolean {
	const raw = workerEnv.JEO_MESSENGER_SANDBOX;
	if (!raw) return false;
	try {
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null && "backend" in parsed && parsed.backend === "native";
	} catch { return false; }
}

export interface MessengerCliReplyOptions {
	/** Operator log line sink (gateway stderr); receives bounded worker diagnostics, never message text or tokens. */
	log?: (line: string) => void;
}

/** Run each conversation in its own reusable agent process. */
export function createMessengerCliReply(config: MessengerConfig, spawn: typeof Bun.spawn = Bun.spawn, selectModel: typeof selectDiscordModel = selectDiscordModel, options: MessengerCliReplyOptions = {}): MessengerReply & { close(): Promise<void>; sandboxControl: NonNullable<MessengerGatewayOptions["sandboxControl"]> } {
	const log = options.log;
	const pool = createMessengerSessionPool(spawn, undefined, undefined, undefined, {
		requireSandboxCleanup: true,
		// A killed worker never ran its supervisor close: end the native sandbox processes it left (a container's cleanup stays with the container runtime).
		reapOrphans: async workerEnv => usesNativeSandbox(workerEnv) && (await reapOrphanedNativeProcesses()).complete,
		...(log ? { onDiagnostic: (key: string, line: string) => log(`worker ${key.slice(0, 8)}: ${line}`) } : {}),
	});
	const reply: MessengerReply = async (message, signal, onActivity) => {
		if (signal.aborted) throw new Error("Messenger request aborted");
		// Only Discord defaults to native; other platforms inherit their global sandbox.
		const sandbox: SandboxConfig | undefined = config.sandbox !== undefined ? parseMessengerSandbox(config.sandbox) : message.platform === "discord" ? { backend: "native" } : undefined;
		await validateMessengerStorage(config);
		const id = routeUuid(config, message);
		await fs.mkdir(config.sessionDir, { recursive: true, mode: 0o700 });
		if (signal.aborted) throw new Error("Messenger request aborted");
		const target = path.join(config.sessionDir, `${id}.jsonl`);
		try {
			await fs.access(target);
			if (signal.aborted) throw new Error("Messenger request aborted");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			try { await createSession(config.cwd, id, undefined, config.sessionDir, true); }
			catch (createError) { if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError; }
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
		// No --no-skills: a conversation worker follows the globally installed skill catalog, like a local session.
		const command = [executable, ...(sourceEntry ? ["--no-env-file", sourceEntry] : []), "launch", "--print", "--no-tui", "--literal-worker", ...toolFlags, ...modelFlags, "--resume", id, "--", "worker"];
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
		delete env.JEO_MESSENGER_SANDBOX;
		delete env.JEO_MESSENGER_ALLOWED_USER_IDS;
		delete env.JEO_MESSENGER_SESSION_KEY;
		delete env.JEO_MESSENGER_PROFILE_DIR;
		if (config.profileDir !== undefined) env.JEO_MESSENGER_PROFILE_DIR = config.profileDir;
		if (sandbox) {
			env.JEO_MESSENGER_SANDBOX = JSON.stringify(sandbox);
			env.JEO_MESSENGER_ALLOWED_USER_IDS = JSON.stringify(platformConfig?.allowedUserIds ?? []);
			env.JEO_MESSENGER_SESSION_KEY = id;
		}
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
	const sandboxControl: NonNullable<MessengerGatewayOptions["sandboxControl"]> = async (message, signal) => {
		if (!/^\/sandbox(?:\s|$)/.test(message.text)) return { handled: false, output: "" };
		if (message.platform !== "discord" || !config.platforms.discord?.allowedUserIds.includes(message.senderId)) return { handled: true, output: "UNAUTHORIZED: Discord sandbox control required" };
		try { return { handled: true, output: await sendSandboxControl(config, routeUuid(config, message), message.senderId, message.text, signal) }; }
		catch (error) { return { handled: true, output: error instanceof Error ? error.message : "Sandbox control failed" }; }
	};
	return Object.assign(reply, { close: pool.close, sandboxControl });
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
			const result = await setupDiscordMessenger({ configPath: path.resolve(flags.config!), channelIds: flags.channel.length ? flags.channel : undefined, userIds: flags.user.length ? flags.user : undefined, toolNames: flags.tools?.split(",").filter(Boolean), artifacts: flags.artifacts, service: flags.service, dmTest: !flags.noDm }, io, { signal: AbortSignal.any([controller.signal, io.signal]) });
			process.stdout.write(`Discord messenger ready: ${result.configPath}\nStart: ${result.runScript}\n`);
		} finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); io.close(); }
		return;
	}
	if (action === "update") {
		// Re-pin every registered profile (or the named one) to the jeo running this command, then restart its service.
		const { failed } = await refreshMessengerProfiles(flags.config ? [flags.config] : undefined, line => process.stdout.write(`${line}\n`));
		if (failed) process.exitCode = 1;
		return;
	}
	let config: MessengerConfig;
	try { config = await loadMessengerConfig(flags.config!); validateMessengerEnvironment(config); }
	catch (error) { throw new Error(error instanceof Error ? error.message : "Messenger configuration or required environment is invalid"); }
	const platforms = Object.keys(config.platforms);
	if (action === "check") { process.stdout.write(`Messenger configuration valid: ${platforms.join(", ")}; ${config.toolNames.length} tools enabled. No network checks performed.\n`); return; }
	const boundary = !config.sandbox ? "the globally configured sandbox, or the operating system's own sandbox when none is configured,"
		: config.sandbox.backend === "native" ? "the operating system's own sandbox (macOS Seatbelt or Linux bubblewrap; no Docker)" : "session-specific containers";
	process.stderr.write(`Messenger tools execute in ${boundary} with approved workspace mounts and no network. Sandbox failures do not fall back to host execution.\n`);
	const adapters: MessengerAdapter[] = [];
	if (config.platforms.discord) adapters.push(createDiscordAdapter(config.platforms.discord));
	if (config.platforms.telegram) adapters.push(createTelegramAdapter(config.platforms.telegram));
	if (config.platforms.slack) adapters.push(createSlackAdapter(config.platforms.slack));
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGINT", stop); process.once("SIGTERM", stop);
	const log = (line: string): void => { process.stderr.write(`[jeo messenger ${new Date().toISOString()}] ${line}\n`); };
	// A previous gateway or worker that was killed left its sandbox processes running: end them before serving.
	const orphans = await reapOrphanedNativeProcesses().catch(() => undefined);
	if (orphans && (orphans.reaped > 0 || !orphans.complete)) log(`ended ${orphans.reaped} orphaned sandbox process(es)${orphans.complete ? "" : "; some could not be confirmed gone"}`);
	const reply = createMessengerCliReply(config, undefined, undefined, { log });
	const onRequestError: NonNullable<MessengerGatewayOptions["onRequestError"]> = (message, error, stage) =>
		log(`${message.platform} request failed at ${stage} (conversation ${routeUuid(config, message).slice(0, 8)}): ${error instanceof Error ? error.message : String(error)}`);
	try { process.stdout.write(`Starting messenger: ${platforms.join(", ")}. Press Ctrl+C to stop.\n`); await createMessengerGateway(config, adapters, reply, { concurrency: 4, sandboxControl: reply.sandboxControl, onRequestError }).run(controller.signal); }
	finally { controller.abort(); await reply.close(); process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
