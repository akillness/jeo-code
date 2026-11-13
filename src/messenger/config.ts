import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MessengerConfig, MessengerPlatform, MessengerPlatformConfig } from "./types";
import { canonicalSandboxPath, sandboxPathContains, validateSandboxConfig } from "../agent/sandbox/policy";
import type { SandboxConfig } from "../agent/sandbox/types";
import { notifyDir } from "../agent/notify/paths";

const PLATFORMS: MessengerPlatform[] = ["discord", "telegram", "slack"];
const TOOLS: Record<string, true> = {
	read: true,
	grep: true,
	glob: true,
	find: true,
	search: true,
	bash: true,
	edit: true,
	write: true,
	computer: true,
	sandbox_request: true,
};

function object(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
	if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label} contains an unknown setting`);
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() !== value || !value || /[\u0000-\u001f\u007f]/u.test(value)) {
		throw new Error(`${label} must be a nonempty string without surrounding whitespace or control characters`);
	}
	return value;
}

function ids(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a nonempty list of exact IDs`);
	const result = value.map(item => string(item, label));
	if (result.some(id => /[\s*]/u.test(id)) || new Set(result).size !== result.length) {
		throw new Error(`${label} must contain unique exact IDs, without whitespace or wildcards`);
	}
	return result;
}

function envName(value: unknown, fallback: string, label: string): string {
	const result = value === undefined ? fallback : string(value, label);
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(result)) throw new Error(`${label} must name an environment variable`);
	return result;
}

/** Resolve a platform credential from `env`, honoring JEO_<X> <-> JEOPI_<X> aliases when using default names. */
export function resolveMessengerToken(
	name: string | undefined,
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	if (!name) return undefined;
	const direct = env[name];
	if (direct !== undefined) return direct;
	if (name.startsWith("JEO_")) return env[`JEOPI_${name.slice(4)}`];
	if (name.startsWith("JEOPI_")) return env[`JEO_${name.slice(6)}`];
	return undefined;
}

export const DEFAULT_MESSENGER_TOOLS = ["read", "find", "search", "write", "edit", "bash", "computer", "sandbox_request"];

/**
 * `{ "backend": "native" }` selects the operating system's own sandbox (no image, no daemon).
 * `{ "image", "limits" }`, optionally with `"backend": "docker"`, selects a session container.
 */
export function parseMessengerSandbox(value: unknown): SandboxConfig {
	const input = object(value, "sandbox");
	if (input.backend === "native") {
		keys(input, ["backend"], "sandbox");
		return { backend: "native" };
	}
	keys(input, ["backend", "image", "limits"], "sandbox");
	if (input.backend !== undefined && input.backend !== "docker") throw new Error('sandbox.backend must be "native" or "docker"');
	const limits = object(input.limits, "sandbox.limits");
	keys(limits, ["memoryBytes", "pids", "cpus"], "sandbox.limits");
	const config: SandboxConfig = {
		image: string(input.image, "sandbox.image"),
		limits: { memoryBytes: limits.memoryBytes as number, pids: limits.pids as number, cpus: limits.cpus as number },
	};
	validateSandboxConfig(config);
	return config;
}

export function parseMessengerConfig(value: unknown, baseDir: string): MessengerConfig {
	const input = object(value, "Messenger config");
	if (Object.hasOwn(input, "independentSessions")) throw new Error("independentSessions is obsolete; run messenger setup to migrate to persistent conversation sessions");
	keys(input, ["cwd", "sessionDir", "sandbox", "toolNames", "platforms"], "Messenger config");
	const platformsInput = object(input.platforms, "platforms");
	keys(platformsInput, PLATFORMS, "platforms");
	if (Object.keys(platformsInput).length === 0) throw new Error("At least one messenger platform is required");
	const platforms: MessengerConfig["platforms"] = {};
	for (const platform of PLATFORMS) {
		if (!Object.hasOwn(platformsInput, platform)) continue;
		const item = object(platformsInput[platform], `${platform} config`);
		keys(
			item,
			platform === "slack"
				? ["tokenEnv", "appTokenEnv", "allowedUserIds", "allowedChannelIds"]
				: platform === "discord"
					? ["tokenEnv", "allowedUserIds", "allowedChannelIds", "artifactDir", "model", "usageFallbackModel", "workerMode"]
					: ["tokenEnv", "allowedUserIds", "allowedChannelIds"],
			`${platform} config`,
		);
		const config: MessengerPlatformConfig = {
			tokenEnv: envName(item.tokenEnv, `JEO_${platform.toUpperCase()}_BOT_TOKEN`, `${platform}.tokenEnv`),
			allowedUserIds: ids(item.allowedUserIds, `${platform}.allowedUserIds`),
		};
		if (platform === "slack")
			config.appTokenEnv = envName(item.appTokenEnv, "JEO_SLACK_APP_TOKEN", "slack.appTokenEnv");
		if (item.allowedChannelIds !== undefined)
			config.allowedChannelIds = ids(item.allowedChannelIds, `${platform}.allowedChannelIds`);
		if (platform === "discord" && item.workerMode !== undefined) {
			if (item.workerMode !== "sandbox" && item.workerMode !== "host")
				throw new Error('discord.workerMode must be "sandbox" or "host"');
			config.workerMode = item.workerMode;
		}
		if (platform === "discord" && item.artifactDir !== undefined)
			config.artifactDir = path.resolve(baseDir, string(item.artifactDir, "discord.artifactDir"));
		if (platform === "discord" && item.model !== undefined)
			config.model = string(item.model, "discord.model");
		if (platform === "discord" && item.usageFallbackModel !== undefined) {
			if (!config.model) throw new Error("discord.usageFallbackModel requires discord.model");
			config.usageFallbackModel = string(item.usageFallbackModel, "discord.usageFallbackModel");
		}
		platforms[platform] = config;
	}
	const toolNames = input.toolNames === undefined ? DEFAULT_MESSENGER_TOOLS : input.toolNames;
	if (
		!Array.isArray(toolNames) ||
		toolNames.some(name => typeof name !== "string" || !Object.hasOwn(TOOLS, name)) ||
		new Set(toolNames).size !== toolNames.length
	) {
		throw new Error("toolNames must be a unique list drawn from read, grep, glob, find, search, bash, edit, write, computer");
	}
	// Discord's default is selected per request, without imposing it on other platforms.
	const sandbox: SandboxConfig | undefined = input.sandbox !== undefined ? parseMessengerSandbox(input.sandbox) : undefined;
	const cwd = path.resolve(baseDir, input.cwd === undefined ? "." : string(input.cwd, "cwd"));
	const sessionDir = input.sessionDir === undefined ? path.join(notifyDir(), "messenger-sessions") : path.resolve(baseDir, string(input.sessionDir, "sessionDir"));
	if ((sandbox || platforms.discord) && (sandboxPathContains(cwd, sessionDir) || sandboxPathContains(sessionDir, cwd))) {
		throw new Error("sessionDir must be outside and disjoint from the sandbox workspace");
	}
	return {
		cwd,
		sessionDir,
		toolNames: [...toolNames] as string[],
		...(sandbox ? { sandbox } : {}),
		platforms,
	};
}

export async function validateMessengerStorage(config: MessengerConfig): Promise<void> {
	if (!config.sandbox && !config.platforms.discord) return;
	const [cwd, sessionDir] = await Promise.all([canonicalSandboxPath(config.cwd), canonicalSandboxPath(config.sessionDir, false)]);
	if (sandboxPathContains(cwd, sessionDir) || sandboxPathContains(sessionDir, cwd)) {
		throw new Error("sessionDir must be outside and disjoint from the sandbox workspace");
	}
	if (config.profileDir !== undefined) {
		const profile = await canonicalSandboxPath(config.profileDir);
		if (sandboxPathContains(cwd, profile) || sandboxPathContains(profile, cwd)) {
			throw new Error("The sandbox workspace must be disjoint from the messenger profile directory (configuration and credentials); set cwd to a directory outside it");
		}
	}
	// Host workers use isolated clean worktrees, not the source checkout as a sandbox mount.
	if (config.platforms.discord?.workerMode === "host" && (!config.sandbox || (!config.platforms.telegram && !config.platforms.slack))) return;
	const pending = [path.join(cwd, ".jeo", "sessions"), path.join(cwd, ".jeo", "messenger-sessions"), path.join(cwd, ".jeo", "memory", "raw")];
	while (pending.length) {
		const directory = pending.pop()!;
		let entries;
		try { entries = await fs.readdir(directory, { withFileTypes: true }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
		for (const entry of entries) {
			if (/\.(?:jsonl|json)$/i.test(entry.name) || entry.isSymbolicLink()) {
				throw new Error("Legacy session transcripts or raw history may be exposed in the sandbox workspace; move existing private history outside the workspace before starting the sandbox");
			}
			if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
		}
	}
}

/**
 * Host paths a sandbox mount or grant must never touch: the whole profile directory (messenger.json, token file,
 * run script, anything created later) and every direct entry that is a symlink leaving it. Entries are canonicalized,
 * so a symlink cannot move a secret outside the list. The workspace must be disjoint from the profile in both
 * directions; any failure to inspect the profile throws instead of returning a shorter list.
 */
export async function messengerProfilePrivatePaths(profileDir: string, cwd: string): Promise<string[]> {
	const [profile, workspace] = await Promise.all([canonicalSandboxPath(profileDir), canonicalSandboxPath(cwd)]);
	if (sandboxPathContains(workspace, profile) || sandboxPathContains(profile, workspace)) {
		throw new Error("SANDBOX_PRIVATE_STATE: the sandbox workspace must be disjoint from the messenger profile directory (configuration and credentials)");
	}
	const privatePaths = [profile];
	for (const name of await fs.readdir(profile)) {
		const entry = await canonicalSandboxPath(path.join(profile, name), false);
		if (!sandboxPathContains(profile, entry)) privatePaths.push(entry);
	}
	return privatePaths;
}

export async function loadMessengerConfig(file: string): Promise<MessengerConfig> {
	let value: unknown;
	let configFile: string;
	try {
		configFile = await canonicalSandboxPath(file);
		value = await Bun.file(configFile).json();
	} catch {
		throw new Error("Cannot read messenger configuration as JSON");
	}
	const profileDir = path.dirname(path.resolve(file));
	const profileKey = createHash("sha256").update(configFile).digest("hex");
	const config: MessengerConfig = { ...parseMessengerConfig(value, profileDir), profileDir, profileKey };
	await validateMessengerStorage(config);
	const artifactDir = config.platforms.discord?.artifactDir;
	if (artifactDir) {
		const stat = await fs.lstat(artifactDir).catch(() => undefined);
		if (!stat?.isDirectory() || stat.isSymbolicLink())
			throw new Error("discord.artifactDir must be an existing directory, not a symlink");
	}
	return config;
}

export function validateMessengerEnvironment(
	config: MessengerConfig,
	env: Record<string, string | undefined> = process.env,
): void {
	for (const platform of PLATFORMS) {
		const item = config.platforms[platform];
		if (!item) continue;
		for (const name of [item.tokenEnv, item.appTokenEnv]) {
			if (name === undefined) continue;
			const token = resolveMessengerToken(name, env);
			if (!token?.trim() || token !== token.trim() || /[\s\u0000-\u001f\u007f]/u.test(token)) {
				throw new Error(`${platform} requires a nonempty credential in ${name}`);
			}
		}
	}
}
