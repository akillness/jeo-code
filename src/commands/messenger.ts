import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { loadMessengerConfig, parseMessengerSandbox, validateMessengerEnvironment, validateMessengerStorage } from "../messenger/config";
import { createDiscordAdapter } from "../messenger/discord";
import { setupDiscordMessenger } from "../messenger/discord-setup";
import { refreshMessengerProfiles } from "../messenger/runtime";
import { messengerArtifactPrompt } from "../messenger/artifacts";
import { createMessengerGateway, isMessengerMessageAllowed, messengerConversationKey, messengerSessionRoute } from "../messenger/gateway";
import { createMessengerSessionPool } from "../messenger/session-pool";
import { createDiscordThreadRegistry } from "../messenger/thread-registry";
import type { DiscordThreadAdmission } from "../messenger/thread-registry";
import { createDiscordHostAuthority } from "../messenger/host-actions";
import { createSlackAdapter } from "../messenger/slack";
import { createTelegramAdapter } from "../messenger/telegram";
import { isEnoent, MessengerUnverifiedReplyError, type DiscordRunRef, type DiscordWorkerMode, type MessengerAdapter, type MessengerConfig, type MessengerMessage, type MessengerReply, type MessengerRequestOutcome } from "../messenger/types";
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
type Flags = { config?: string; channel: string[]; user: string[]; tools?: string; artifacts: boolean; service: boolean; noDm: boolean; workerMode?: DiscordWorkerMode; projectPath?: string };

function parse(args: string[]): { action: MessengerAction; flags: Flags } {
	const action = args.shift();
	if (action !== "setup" && action !== "check" && action !== "run" && action !== "update") throw new Error("Usage: jeo messenger setup|check|run --config <file> | jeo messenger update [--config <file>]");
	const flags: Flags = { channel: [], user: [], artifacts: false, service: false, noDm: false };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--artifacts") flags.artifacts = true;
		else if (arg === "--service") flags.service = true;
		else if (arg === "--no-dm") flags.noDm = true;
		else if (["--config", "--channel", "--user", "--tools", "--worker-mode", "--project"].includes(arg)) {
			const value = args[++index];
			if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
			if (arg === "--config") flags.config = value;
			else if (arg === "--tools") flags.tools = value;
			else if (arg === "--worker-mode") {
				if (value !== "host" && value !== "sandbox") throw new Error("--worker-mode must be host or sandbox");
				flags.workerMode = value;
			} else if (arg === "--project") flags.projectPath = value;
			else flags[arg === "--channel" ? "channel" : "user"].push(...value.split(",").filter(Boolean));
		} else throw new Error(`Unknown messenger option: ${arg}`);
	}
	if (action !== "setup" && (flags.workerMode !== undefined || flags.projectPath !== undefined)) throw new Error("--worker-mode and --project are only supported by messenger setup");
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
	/** Send approval text directly, without artifact parsing or another agent turn. */
	notifyHostAction?: (message: MessengerMessage, text: string, signal: AbortSignal) => Promise<void>;
	/** Synchronously fence queued and active deliveries before retiring a thread worker. */
	cancelConversation?: (conversationKey: string) => void;
}

export type MessengerCliReply = MessengerReply & {
	close(): Promise<void>;
	sandboxControl: NonNullable<MessengerGatewayOptions["sandboxControl"]>;
	onThreadLifecycle: NonNullable<MessengerGatewayOptions["onThreadLifecycle"]>;
	onRequestSettled: NonNullable<MessengerGatewayOptions["onRequestSettled"]>;
	authorizeArtifacts(message: MessengerMessage, files: readonly { name: string; data: Uint8Array }[], signal: AbortSignal): Promise<void>;
};

/** Run each conversation in its own reusable agent process. */
export function createMessengerCliReply(config: MessengerConfig, spawn: typeof Bun.spawn = Bun.spawn, selectModel: typeof selectDiscordModel = selectDiscordModel, options: MessengerCliReplyOptions = {}): MessengerCliReply {
	const lifetime = new AbortController();
	const inflight = new Set<Promise<string>>();
	interface RunOwner {
		run: DiscordRunRef;
		message: MessengerMessage;
		controller: AbortController;
		signal: AbortSignal;
		outcome?: MessengerRequestOutcome;
	}
	const owners = new Map<string, RunOwner>();
	const requestRuns = new Map<string, string>();
	const requestKey = (message: MessengerMessage): string => JSON.stringify([messengerConversationKey(message), message.messageId]);
	const hostMessage = (message: MessengerMessage): boolean => message.platform === "discord" && config.platforms.discord?.workerMode === "host";
	const authority = createDiscordHostAuthority(config, async (run, text, signal) => {
		const owner = owners.get(run.runId);
		if (!owner || owner.signal.aborted || !options.notifyHostAction) throw new Error("Discord host approval delivery is unavailable");
		await options.notifyHostAction(owner.message, text, AbortSignal.any([signal, owner.signal]));
	});
	const registry = createDiscordThreadRegistry(config, async thread => {
		options.cancelConversation?.(thread.conversationKey);
		authority.invalidate(thread.conversationKey);
		for (const owner of owners.values()) if (owner.run.conversationKey === thread.conversationKey) owner.controller.abort();
		// The registry holds its thread lane: never await a reply or settlement here.
		await pool.stop(thread.sessionId);
	});
	const pool = createMessengerSessionPool(spawn, undefined, undefined, undefined, {
		requireSandboxCleanup: true,
		// Host cleanup is epoch-owned; only legacy native sandboxes use the global orphan reaper.
		reapOrphans: async workerEnv => usesNativeSandbox(workerEnv) && (await reapOrphanedNativeProcesses()).complete,
		onWorkerStarted: registry.recordWorker,
		onActionRequest: authority.authorize,
		...(options.log ? { onDiagnostic: (key: string, line: string) => options.log!(`worker ${key.slice(0, 8)}: ${line}`) } : {}),
	});
	async function releaseOwner(owner: RunOwner, outcome: MessengerRequestOutcome | "interrupted"): Promise<void> {
		owners.delete(owner.run.runId);
		const key = requestKey(owner.message);
		if (requestRuns.get(key) === owner.run.runId) requestRuns.delete(key);
		authority.release(owner.run);
		await registry.settle(owner.run, owner.signal.aborted ? "cancelled" : outcome);
	}
	const runReply: MessengerReply = async (message, signal, onActivity) => {
		signal = AbortSignal.any([signal, lifetime.signal]);
		signal.throwIfAborted();
		const host = hostMessage(message);
		if (host && (!message.threadId || !isMessengerMessageAllowed(message, config))) throw new Error("UNAUTHORIZED: Discord host work requires an allowed user and thread");
		await validateMessengerStorage(config);
		await fs.mkdir(config.sessionDir, { recursive: true, mode: 0o700 });
		let sessionDir = config.sessionDir;
		if (host) {
			sessionDir = await fs.realpath(config.sessionDir);
			const stat = await fs.lstat(sessionDir);
			if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Discord host session directory must be private");
		}
		signal.throwIfAborted();
		let owner: RunOwner | undefined;
		let cwd = config.cwd;
		let id = routeUuid(config, message);
		let workspaceRoot: string | undefined;
		let sourceRoot: string | undefined;
		if (host) {
			let admission: DiscordThreadAdmission | undefined;
			try { admission = await registry.begin(message, signal); }
			catch (error) {
				if (!signal.aborted && error instanceof Error && /Git project/.test(error.message)) throw new MessengerUnverifiedReplyError(`UNVERIFIED: ${error.message}`);
				throw error;
			}
			if (!admission) return ""; // Durable duplicate admission must never write worker stdin.
			const { thread, run } = admission;
			const workspace = thread.workspaces.find(entry => entry.id === thread.activeWorkspace);
			if (!workspace) { await registry.settle(run, "failed"); throw new Error("Discord host workspace is unavailable"); }
			cwd = thread.cwd;
			id = thread.sessionId;
			workspaceRoot = workspace.worktreePath;
			sourceRoot = workspace.sourceRoot;
			const controller = new AbortController();
			signal = AbortSignal.any([signal, controller.signal]);
			owner = { run, message: Object.freeze(structuredClone(message)), controller, signal };
			owners.set(run.runId, owner);
			requestRuns.set(requestKey(message), run.runId);
		}
		try {
			const target = path.join(sessionDir, `${id}.jsonl`);
			try { await fs.access(target); }
			catch (error) {
				if (!isEnoent(error)) throw error;
				try { await createSession(cwd, id, undefined, sessionDir, true); }
				catch (createError) { if (!(createError instanceof Error && "code" in createError && createError.code === "EEXIST")) throw createError; }
			}
			signal.throwIfAborted();
			const artifactPrompt = await messengerArtifactPrompt(config.platforms[message.platform]?.artifactDir, message, signal);
			const executable = process.execPath;
			const sourceEntry = process.argv[1]?.endsWith(".ts") ? process.argv[1] : undefined;
			const tools = [...new Set(config.toolNames.map(name => name === "grep" ? "search" : name === "glob" ? "find" : name))];
			const toolFlags = tools.length ? ["--tools", tools.join(",")] : ["--no-tools"];
			const platformConfig = config.platforms[message.platform];
			const model = message.platform === "discord" ? await selectModel(platformConfig?.model, { signal }) : platformConfig?.model;
			const modelFlags = model ? ["--model", model] : [];
			// Literal workers keep normal skills and transcript history, without interpreting remote slash text.
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
			const env: Record<string, string> = {};
			for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !secretNames.has(name)) env[name] = value;
			for (const name of secretNames) env[name] = "";
			env.JEO_SESSION_DIR = sessionDir;
			for (const name of ["JEO_MESSENGER_SANDBOX", "JEO_MESSENGER_ALLOWED_USER_IDS", "JEO_MESSENGER_SESSION_KEY", "JEO_MESSENGER_PROFILE_DIR", "JEO_MESSENGER_HOST_BOOTSTRAP", "JEO_MESSENGER_SHUTDOWN_NONCE"]) delete env[name];
			if (config.profileDir !== undefined) env.JEO_MESSENGER_PROFILE_DIR = config.profileDir;
			if (host) {
				env.JEO_MESSENGER_HOST_BOOTSTRAP = JSON.stringify({ version: 1, mode: "host", cwd, workspaceRoot, sourceRoot, sessionDir });
			} else {
				// Only legacy Discord defaults to native; other platforms inherit their global sandbox.
				const sandbox: SandboxConfig | undefined = config.sandbox !== undefined ? parseMessengerSandbox(config.sandbox) : message.platform === "discord" ? { backend: "native" } : undefined;
				if (sandbox) {
					env.JEO_MESSENGER_SANDBOX = JSON.stringify(sandbox);
					env.JEO_MESSENGER_ALLOWED_USER_IDS = JSON.stringify(platformConfig?.allowedUserIds ?? []);
					env.JEO_MESSENGER_SESSION_KEY = id;
				}
			}
			env.JEO_MESSENGER_COMPUTER_ENABLED = tools.includes("computer") ? "1" : "0";
			delete env.JEO_MESSENGER_USAGE_FALLBACK_MODEL;
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
			delete env.JEO_MESSENGER_FIXED_MODEL;
			if (model) env.JEO_MESSENGER_FIXED_MODEL = "1";
			const policyKey = message.platform === "discord" ? JSON.stringify([model, env.JEO_MESSENGER_USAGE_FALLBACK_MODEL]) : undefined;
			signal.throwIfAborted();
			if (owner && workspaceRoot) {
				const current = await registry.get(owner.run.conversationKey);
				signal.throwIfAborted();
				if (!current || current.generation !== owner.run.generation || current.state !== "ready") throw new Error("Discord host run became stale before execution");
				authority.bind(owner.run, owner.message, workspaceRoot);
			}
			const text = await pool.turn(id, command, cwd, env, [message.text, artifactPrompt].filter(Boolean).join("\n\n"), signal, onActivity, policyKey, owner?.run);
			signal.throwIfAborted();
			if (owner) owner.outcome = "completed";
			return text;
		} catch (error) {
			if (owner) {
				owner.outcome = signal.aborted ? "cancelled" : "failed";
				// UNVERIFIED answers may still carry files; keep their binding through delivery, without completing the run.
				if (!(error instanceof MessengerUnverifiedReplyError) || signal.aborted) await releaseOwner(owner, owner.outcome);
			}
			throw error;
		}
	};
	const reply: MessengerReply = (message, signal, onActivity) => {
		const turn = runReply(message, signal, onActivity);
		inflight.add(turn);
		void turn.then(() => inflight.delete(turn), () => inflight.delete(turn));
		return turn;
	};
	const sandboxControl: MessengerCliReply["sandboxControl"] = async (message, signal) => {
		const text = message.text.trim();
		if (message.attachments?.length || /[\r\n]/.test(message.text)) return { handled: false, output: "" };
		const sandbox = /^\/sandbox(?:[ \t]+[^\r\n]*)?$/.test(text);
		const control = /^(?:\/session[ \t]+status|\/cwd(?:[ \t]+[^\r\n]+)?|\/cancel|\/(?:approve|deny)[ \t]+\S+)$/.test(text);
		if (!sandbox && !(hostMessage(message) && control)) return { handled: false, output: "" };
		if (message.platform !== "discord" || !isMessengerMessageAllowed(message, config)) return { handled: true, output: "UNAUTHORIZED: Discord control requires an allowed user and channel" };
		try {
			signal.throwIfAborted();
			if (!hostMessage(message)) return { handled: true, output: await sendSandboxControl(config, routeUuid(config, message), message.senderId, message.text, signal) };
			if (sandbox) return { handled: true, output: "Discord host mode uses the bot's OS user and CLI trust, not OS isolation. Use /session status, /cwd, /cancel, /approve or /deny." };
			if (!message.threadId) return { handled: true, output: "Discord host controls require their originating thread." };
			const decision = /^\/(approve|deny)[ \t]+(\S+)$/.exec(text);
			if (decision) return { handled: true, output: authority.decide(message, decision[2]!, decision[1] === "approve" ? "approve" : "deny") };
			const key = messengerConversationKey(message);
			if (text === "/cancel") {
				// A first task may still be queued, before registry.begin creates its durable record.
				options.cancelConversation?.(key);
				authority.invalidate(key);
				await registry.cancel(key);
				return { handled: true, output: "Thread work cancelled; transcript, branch and worktree retained." };
			}
			const requested = /^\/cwd[ \t]+(.+)$/.exec(text);
			const thread = requested ? await registry.changeCwd(key, requested[1]!, signal) : await registry.get(key);
			if (!thread) return { handled: true, output: "No thread session exists yet. Send a task to start the configured Git project." };
			const workspace = thread.workspaces.find(entry => entry.id === thread.activeWorkspace);
			return { handled: true, output: `Discord host session ${thread.sessionId}\nState: ${thread.state}; generation: ${thread.generation}\nCwd: ${thread.cwd}\nBranch: ${workspace?.branch ?? "not provisioned"}\nRuns: ${thread.runs.filter(run => run.state === "running").length} active\nTrust: bot OS user, CLI-trusted scripts; not OS isolation.` };
		} catch (error) { return { handled: true, output: error instanceof Error ? error.message : "Discord control failed" }; }
	};
	const onRequestSettled: MessengerCliReply["onRequestSettled"] = async (message, outcome) => {
		const runId = requestRuns.get(requestKey(message));
		const owner = runId === undefined ? undefined : owners.get(runId);
		if (owner) await releaseOwner(owner, owner.outcome === "failed" ? "failed" : outcome);
	};
	const authorizeArtifacts: MessengerCliReply["authorizeArtifacts"] = async (message, files, signal) => {
		if (!hostMessage(message) || files.length === 0) return;
		const runId = requestRuns.get(requestKey(message));
		const owner = runId === undefined ? undefined : owners.get(runId);
		if (!owner || !isMessengerMessageAllowed(message, config)) throw new Error("Discord artifact upload has no active authenticated run");
		await authority.authorize(owner.run, { kind: "artifact_upload", channelId: message.threadId ?? message.channelId,
			files: files.map(file => ({ name: file.name, size: file.data.byteLength, sha256: createHash("sha256").update(file.data).digest("hex") })) }, AbortSignal.any([signal, owner.signal]));
	};
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => closing ??= (async () => {
		lifetime.abort();
		authority.close();
		try {
			await pool.close();
			await Promise.allSettled(inflight);
			for (const owner of owners.values()) await releaseOwner(owner, "interrupted");
		} finally {
			owners.clear(); requestRuns.clear();
			await registry.close();
		}
	})();
	return Object.assign(reply, { close, sandboxControl, onThreadLifecycle: registry.transition, onRequestSettled, authorizeArtifacts });
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
			const result = await setupDiscordMessenger({ configPath: path.resolve(flags.config!), channelIds: flags.channel.length ? flags.channel : undefined, userIds: flags.user.length ? flags.user : undefined, toolNames: flags.tools?.split(",").filter(Boolean), artifacts: flags.artifacts, service: flags.service, dmTest: !flags.noDm, workerMode: flags.workerMode, projectPath: flags.projectPath }, io, { signal: AbortSignal.any([controller.signal, io.signal]) });
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
	const host = config.platforms.discord?.workerMode === "host";
	if (host) process.stderr.write("Discord host tools execute as the bot's OS user in retained per-thread Git worktrees. Scripts use local CLI trust, not OS isolation; explicit risky actions require one-use thread approval.\n");
	if (!host || config.platforms.telegram || config.platforms.slack) process.stderr.write(`Sandbox messenger tools execute in ${boundary} with approved workspace mounts and no network. Sandbox failures do not fall back to host execution.\n`);
	const adapters: MessengerAdapter[] = [];
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGINT", stop); process.once("SIGTERM", stop);
	const log = (line: string): void => { process.stderr.write(`[jeo messenger ${new Date().toISOString()}] ${line}\n`); };
	// Host-only profiles never run the global native orphan reaper.
	if (!host || config.platforms.telegram || config.platforms.slack) {
		const orphans = await reapOrphanedNativeProcesses().catch(() => undefined);
		if (orphans && (orphans.reaped > 0 || !orphans.complete)) log(`ended ${orphans.reaped} orphaned sandbox process(es)${orphans.complete ? "" : "; some could not be confirmed gone"}`);
	}
	let cancelConversation: ((key: string) => void) | undefined;
	// Approval notices are plain text: this send-only adapter cannot parse or upload artifacts recursively.
	const approvalAdapter = config.platforms.discord ? createDiscordAdapter({ ...config.platforms.discord, artifactDir: undefined }) : undefined;
	const reply = createMessengerCliReply(config, undefined, undefined, {
		log, cancelConversation: key => cancelConversation?.(key),
		notifyHostAction: async (message, text, signal) => {
			if (!approvalAdapter || message.platform !== "discord") throw new Error("Discord approval transport unavailable");
			await approvalAdapter.send(message, text, signal);
		},
	});
	if (config.platforms.discord) adapters.push(createDiscordAdapter(config.platforms.discord, undefined, { authorizeArtifacts: reply.authorizeArtifacts }));
	if (config.platforms.telegram) adapters.push(createTelegramAdapter(config.platforms.telegram));
	if (config.platforms.slack) adapters.push(createSlackAdapter(config.platforms.slack));
	const onRequestError: NonNullable<MessengerGatewayOptions["onRequestError"]> = (message, error, stage) =>
		log(`${message.platform} request failed at ${stage} (conversation ${routeUuid(config, message).slice(0, 8)}): ${error instanceof Error ? error.message : String(error)}`);
	try {
		const gateway = createMessengerGateway(config, adapters, reply, { concurrency: 4, sandboxControl: reply.sandboxControl,
			onThreadLifecycle: reply.onThreadLifecycle, onRequestSettled: reply.onRequestSettled, onRequestError });
		cancelConversation = gateway.cancelConversation;
		process.stdout.write(`Starting messenger: ${platforms.join(", ")}. Press Ctrl+C to stop.\n`);
		await gateway.run(controller.signal);
	} finally {
		controller.abort();
		try { await reply.close(); }
		finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
	}
}
