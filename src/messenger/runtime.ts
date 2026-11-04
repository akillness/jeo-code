import * as fs from "node:fs/promises";
import * as path from "node:path";
import pkg from "../../package.json";
import { notifyDir } from "../agent/notify/paths";
import { loadMessengerConfig } from "./config";
import { currentJeoCommand, messengerExecutablePath, messengerLauncherContent, MESSENGER_RUN_SCRIPT_POSIX, MESSENGER_RUN_SCRIPT_WINDOWS, writePrivateFile } from "./launcher";
import { messengerServicePlan, restartMessengerService } from "./service";
import { isEnoent, isRecord } from "./types";

/**
 * A messenger profile runs its gateway and workers from one of two runtimes:
 *
 * - `managed`: a private copy of the published `jeo-code` package pinned to one version under
 *   `<profile>/runtime/<version>` (jeopi's `runtime-<version>` layout). `jeo messenger setup` and
 *   `jeo update` provision it, rewrite the launcher and restart the service, so the gateway never
 *   depends on a mutable global install or a source checkout that can move away underneath it.
 * - `external`: an explicit argv (a source checkout or compiled binary). Updates leave it alone.
 */
export type MessengerRuntime =
	| { kind: "managed"; version: string }
	| { kind: "external"; command: string[] };

export interface MessengerProfileRecord {
	configPath: string;
	runScript: string;
	runtime: MessengerRuntime;
	/** Service label when a user service was installed for the profile. */
	service?: string;
	updatedAt: string;
}

export const MESSENGER_PACKAGE = "jeo-code";
export const MESSENGER_RUNTIME_DIR = "runtime";
export const MESSENGER_PROFILES_FILE = "messenger-profiles.json";
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** `<prefix>/node_modules/jeo-code/src/cli.ts` is a package install (global or a managed runtime); anything else is a checkout or binary. */
export function messengerRuntimePlan(entry = Bun.main, execPath = process.execPath, version = pkg.version): MessengerRuntime {
	const command = currentJeoCommand(entry, execPath);
	const parts = command.length === 2 ? command[1]!.replaceAll("\\", "/").split("/") : [];
	const installed = parts.length >= 4 && parts.at(-1) === "cli.ts" && parts.at(-2) === "src" && parts.at(-3) === MESSENGER_PACKAGE && parts.at(-4) === "node_modules";
	return installed && VERSION.test(version) ? { kind: "managed", version } : { kind: "external", command };
}

export function messengerRuntimeRoot(profileDir: string, version: string): string {
	if (!VERSION.test(version)) throw new Error(`Invalid messenger runtime version: ${version}`);
	return path.join(profileDir, MESSENGER_RUNTIME_DIR, version);
}

/** The argv a launcher uses for `runtime`; pure, so callers can validate it before provisioning. */
export function messengerRuntimeCommand(profileDir: string, runtime: MessengerRuntime, execPath = process.execPath): string[] {
	if (runtime.kind === "external") return runtime.command;
	return [execPath, path.join(messengerRuntimeRoot(profileDir, runtime.version), "node_modules", MESSENGER_PACKAGE, "src", "cli.ts")];
}

async function installedRuntimeVersion(root: string): Promise<string | undefined> {
	try {
		const manifest: unknown = await Bun.file(path.join(root, "node_modules", MESSENGER_PACKAGE, "package.json")).json();
		if (!isRecord(manifest) || typeof manifest.version !== "string") return undefined;
		await fs.access(path.join(root, "node_modules", MESSENGER_PACKAGE, "src", "cli.ts"));
		return manifest.version;
	} catch (error) {
		if (isEnoent(error) || error instanceof SyntaxError) return undefined;
		throw error;
	}
}

/** `bun install` the pinned package; `--force` recovers a registry manifest bun cached before a fresh publish. */
async function installWithBun(root: string, execPath: string): Promise<void> {
	let failure = "";
	for (const extra of [[], ["--force"]]) {
		const proc = Bun.spawn([execPath, "install", "--no-progress", "--no-summary", ...extra], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		if (code === 0) return;
		failure = stderr.trim().split("\n").slice(-3).join(" ").trim() || `bun install exited with code ${code}`;
	}
	throw new Error(failure);
}

export interface MessengerRuntimeDeps {
	/** Install `jeo-code@version` into `root` (its `package.json` is already written). Defaults to `bun install`. */
	install?: (root: string, version: string) => Promise<void>;
	execPath?: string;
}

/** Idempotent: an intact runtime for `version` is reused; a partial one is replaced. Failure leaves no runtime behind. */
export async function provisionMessengerRuntime(profileDir: string, version: string, deps: MessengerRuntimeDeps = {}): Promise<string[]> {
	const root = messengerRuntimeRoot(profileDir, version);
	const execPath = deps.execPath ?? process.execPath;
	const command = messengerRuntimeCommand(profileDir, { kind: "managed", version }, execPath);
	if ((await installedRuntimeVersion(root)) === version) return command;
	await fs.rm(root, { recursive: true, force: true });
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	await Bun.write(path.join(root, "package.json"), `${JSON.stringify({ name: "jeo-messenger-runtime", private: true, dependencies: { [MESSENGER_PACKAGE]: version } }, null, 2)}\n`);
	try {
		await (deps.install ?? (dir => installWithBun(dir, execPath)))(root, version);
		const installed = await installedRuntimeVersion(root);
		if (installed !== version) throw new Error(`the runtime contains ${MESSENGER_PACKAGE}@${installed ?? "nothing"}`);
	} catch (error) {
		await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
		throw new Error(`Could not install the messenger runtime ${MESSENGER_PACKAGE}@${version}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	return command;
}

/** Remove runtime versions other than `keep` (the active one and its predecessor, for rollback). Returns removed versions. */
export async function pruneMessengerRuntimes(profileDir: string, keep: string[]): Promise<string[]> {
	const directory = path.join(profileDir, MESSENGER_RUNTIME_DIR);
	let entries: string[];
	try { entries = await fs.readdir(directory); }
	catch (error) { if (isEnoent(error)) return []; throw error; }
	const removed: string[] = [];
	for (const entry of entries) {
		if (keep.includes(entry) || !VERSION.test(entry)) continue;
		await fs.rm(path.join(directory, entry), { recursive: true, force: true });
		removed.push(entry);
	}
	return removed;
}

export function messengerProfilesPath(): string {
	return path.join(notifyDir(), MESSENGER_PROFILES_FILE);
}

function parseRuntime(value: unknown): MessengerRuntime | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind === "managed" && typeof value.version === "string" && VERSION.test(value.version)) return { kind: "managed", version: value.version };
	if (value.kind === "external" && Array.isArray(value.command) && value.command.length && value.command.every(item => typeof item === "string" && item)) {
		return { kind: "external", command: value.command as string[] };
	}
	return undefined;
}

/** Records whose profile no longer exists are dropped on read, so a deleted profile never fails a later refresh. */
export async function readMessengerProfiles(file = messengerProfilesPath()): Promise<MessengerProfileRecord[]> {
	let raw: unknown;
	try { raw = await Bun.file(file).json(); }
	catch (error) { if (isEnoent(error) || error instanceof SyntaxError) return []; throw error; }
	if (!Array.isArray(raw)) return [];
	const records: MessengerProfileRecord[] = [];
	for (const item of raw) {
		if (!isRecord(item) || typeof item.configPath !== "string" || typeof item.runScript !== "string" || !path.isAbsolute(item.configPath)) continue;
		const runtime = parseRuntime(item.runtime);
		if (!runtime || !(await fs.stat(item.configPath).then(stat => stat.isFile(), () => false))) continue;
		records.push({
			configPath: item.configPath,
			runScript: item.runScript,
			runtime,
			...(typeof item.service === "string" && item.service ? { service: item.service } : {}),
			updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date(0).toISOString(),
		});
	}
	return records;
}

export async function registerMessengerProfile(record: MessengerProfileRecord, file = messengerProfilesPath()): Promise<void> {
	const records = (await readMessengerProfiles(file)).filter(item => item.configPath !== record.configPath);
	records.push(record);
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await writePrivateFile(file, `${JSON.stringify(records, null, 2)}\n`, 0o600);
}

export interface MessengerRefreshDeps {
	/** The runtime the running jeo offers; defaults to `messengerRuntimePlan()`. */
	runtime?: MessengerRuntime;
	runtimeDeps?: MessengerRuntimeDeps;
	restartService?: typeof restartMessengerService;
	profilesPath?: string;
	env?: Record<string, string | undefined>;
	platform?: NodeJS.Platform;
	pathDelimiter?: string;
	execPath?: string;
	now?: () => Date;
}

export interface MessengerRefreshResult {
	configPath: string;
	runtime: MessengerRuntime;
	service: "restarted" | "not installed";
	removedRuntimes: string[];
}

/**
 * Point one profile's launcher at the runtime the running jeo offers, restart its installed service and prune
 * stale runtimes. A managed runtime is provisioned before the launcher changes, so a failed install leaves the
 * previous launcher and service untouched.
 */
export async function refreshMessengerProfile(configPath: string, deps: MessengerRefreshDeps = {}): Promise<MessengerRefreshResult> {
	const platform = deps.platform ?? process.platform;
	const execPath = deps.execPath ?? process.execPath;
	const runtime = deps.runtime ?? messengerRuntimePlan();
	const resolvedConfig = path.resolve(configPath);
	const directory = path.dirname(resolvedConfig);
	const config = await loadMessengerConfig(resolvedConfig);
	const tokenEnv = config.platforms.discord?.tokenEnv ?? "JEO_DISCORD_BOT_TOKEN";
	const configName = path.basename(resolvedConfig);
	const envPath = messengerExecutablePath(execPath, (deps.env ?? process.env).PATH, deps.pathDelimiter ?? path.delimiter, platform);
	// Validate launcher inputs for the planned command before provisioning anything.
	messengerLauncherContent(messengerRuntimeCommand(directory, runtime, execPath), configName, tokenEnv, envPath, platform);
	const previous = (await readMessengerProfiles(deps.profilesPath)).find(record => record.configPath === resolvedConfig);
	const command = runtime.kind === "managed" ? await provisionMessengerRuntime(directory, runtime.version, { execPath, ...deps.runtimeDeps }) : runtime.command;
	const runScript = path.join(directory, platform === "win32" ? MESSENGER_RUN_SCRIPT_WINDOWS : MESSENGER_RUN_SCRIPT_POSIX);
	await writePrivateFile(runScript, messengerLauncherContent(command, configName, tokenEnv, envPath, platform), 0o700);
	const plan = messengerServicePlan(directory, runScript);
	const service = await (deps.restartService ?? restartMessengerService)(plan, platform);
	const keep = [runtime, previous?.runtime].flatMap(item => (item?.kind === "managed" ? [item.version] : []));
	const removedRuntimes = runtime.kind === "managed" ? await pruneMessengerRuntimes(directory, keep) : [];
	await registerMessengerProfile({
		configPath: resolvedConfig,
		runScript,
		runtime,
		...(service === "restarted" ? { service: plan.label } : previous?.service ? { service: previous.service } : {}),
		updatedAt: (deps.now ?? (() => new Date()))().toISOString(),
	}, deps.profilesPath);
	return { configPath: resolvedConfig, runtime, service, removedRuntimes };
}

/**
 * `jeo messenger update`: refresh the named profiles, or every registered managed one. Without explicit
 * paths, a profile on an external runtime (a checkout or binary the operator chose) is reported and left
 * alone; naming it with `--config` re-pins it to the running jeo. Failures are reported per profile.
 */
export async function refreshMessengerProfiles(
	configPaths: string[] | undefined,
	say: (line: string) => void,
	deps: MessengerRefreshDeps = {},
): Promise<{ refreshed: number; failed: number; skipped: number }> {
	const explicit = Boolean(configPaths?.length);
	const records = explicit ? [] : await readMessengerProfiles(deps.profilesPath);
	const targets = explicit ? configPaths!.map(file => path.resolve(file)) : records.filter(record => record.runtime.kind === "managed").map(record => record.configPath);
	let skipped = 0;
	for (const record of records) {
		if (record.runtime.kind !== "external") continue;
		skipped++;
		say(`${record.configPath}: launcher runs ${record.runtime.command.join(" ")} (external); left unchanged. Pass --config to re-pin it.`);
	}
	if (!targets.length && !skipped) {
		say("No messenger profiles are registered; run `jeo messenger setup --config <file>` first.");
		return { refreshed: 0, failed: 0, skipped: 0 };
	}
	let refreshed = 0;
	let failed = 0;
	for (const configPath of targets) {
		try {
			const result = await refreshMessengerProfile(configPath, deps);
			refreshed++;
			const where = result.runtime.kind === "managed" ? `${MESSENGER_PACKAGE}@${result.runtime.version} (managed runtime)` : `${result.runtime.command.join(" ")} (external; \`jeo update\` leaves it unchanged)`;
			say(`${configPath}: launcher runs ${where}; service ${result.service}${result.removedRuntimes.length ? `; removed runtimes ${result.removedRuntimes.join(", ")}` : ""}.`);
		} catch (error) {
			failed++;
			say(`${configPath}: not refreshed — ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { refreshed, failed, skipped };
}
