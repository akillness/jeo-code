import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadMessengerConfig, validateMessengerEnvironment } from "../messenger/config";
import { createDiscordAdapter } from "../messenger/discord";
import { setupDiscordMessenger } from "../messenger/discord-setup";
import { createMessengerGateway, messengerSessionRoute } from "../messenger/gateway";
import { createSlackAdapter } from "../messenger/slack";
import { createTelegramAdapter } from "../messenger/telegram";
import type { MessengerAdapter, MessengerConfig, MessengerReply } from "../messenger/types";
import { createSession, sessionPath } from "../agent/session";

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
	return {
		interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		say: (line: string) => process.stdout.write(`${line}\n`),
		ask: async (question: string) => { process.stdout.write(question); return (await Bun.stdin.text()).trim(); },
		askSecret: async (question: string) => { process.stdout.write(question); return (await Bun.stdin.text()).trim(); },
	};
}

function routeUuid(config: MessengerConfig, message: Parameters<MessengerReply>[0]): string {
	const hex = messengerSessionRoute(config.cwd, message);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Run each isolated conversation through jeo's normal one-shot engine while retaining its deterministic session. */
export function createMessengerCliReply(config: MessengerConfig): MessengerReply {
	return async (message, signal) => {
		const id = routeUuid(config, message);
		await fs.mkdir(config.sessionDir, { recursive: true, mode: 0o700 });
		// jeo's native session store is cwd-scoped. A deterministic id gives every chat route independent history.
		await fs.access(sessionPath(id, config.cwd)).catch(() => createSession(config.cwd, id));
		const executable = process.execPath;
		const sourceEntry = process.argv[1]?.endsWith(".ts") ? process.argv[1] : undefined;
		const command = [executable, ...(sourceEntry ? [sourceEntry] : []), "launch", "--print", "--no-tui", "--resume", id, message.text];
		const secretNames = new Set<string>();
		for (const platform of Object.values(config.platforms)) {
			if (!platform) continue;
			secretNames.add(platform.tokenEnv);
			if (platform.appTokenEnv) secretNames.add(platform.appTokenEnv);
		}
		const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && !secretNames.has(name))) as Record<string, string>;
		const child = Bun.spawn(command, { cwd: config.cwd, env, stdout: "pipe", stderr: "pipe" });
		const abort = () => child.kill();
		signal.addEventListener("abort", abort, { once: true });
		try {
			const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
			if (signal.aborted) throw new Error("Messenger request aborted");
			if (code !== 0) throw new Error(stderr.trim() || "Messenger agent process failed");
			const text = stdout.trim();
			if (!text) throw new Error("Messenger response is empty");
			return text;
		} finally {
			signal.removeEventListener("abort", abort);
		}
	};
}

export async function runMessengerCommand(args: string[]): Promise<void> {
	const { action, flags } = parse([...args]);
	if (action === "setup") {
		const result = await setupDiscordMessenger({ configPath: path.resolve(flags.config!), channelIds: flags.channel.length ? flags.channel : undefined, userIds: flags.user.length ? flags.user : undefined, toolNames: flags.tools?.split(",").filter(Boolean), artifacts: flags.artifacts, service: flags.service, dmTest: !flags.noDm }, terminalIO());
		process.stdout.write(`Discord messenger ready: ${result.configPath}\nStart: ${result.runScript}\n`);
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
	try { process.stdout.write(`Starting messenger: ${platforms.join(", ")}. Press Ctrl+C to stop.\n`); await createMessengerGateway(config, adapters, createMessengerCliReply(config), { concurrency: 4 }).run(controller.signal); }
	finally { controller.abort(); process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
