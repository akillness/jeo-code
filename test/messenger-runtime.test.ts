import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runUpdateCommandWith, type UpdateDeps } from "../src/commands/update";
import { setupDiscordMessenger } from "../src/messenger/discord-setup";
import { MESSENGER_RUN_SCRIPT_POSIX } from "../src/messenger/launcher";
import {
	MESSENGER_PACKAGE,
	messengerRuntimeCommand,
	messengerRuntimePlan,
	messengerRuntimeRoot,
	provisionMessengerRuntime,
	pruneMessengerRuntimes,
	readMessengerProfiles,
	refreshMessengerProfile,
	refreshMessengerProfiles,
	registerMessengerProfile,
	type MessengerProfileRecord,
	type MessengerRuntime,
} from "../src/messenger/runtime";
import type { MessengerServicePlan } from "../src/messenger/service";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function directory(): Promise<string> { const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-messenger-runtime-")); roots.push(root); return root; }

const bun = "/opt/bun/bin/bun";
const sandbox = { image: "local-test-image", limits: { memoryBytes: 268435456, pids: 32, cpus: 1 } };
const posix = process.platform !== "win32";
const cliOf = (profileDir: string, version: string): string => path.join(profileDir, "runtime", version, "node_modules", MESSENGER_PACKAGE, "src", "cli.ts");
const exists = (file: string): Promise<boolean> => fs.stat(file).then(() => true, () => false);

/** What `bun install` leaves behind for `jeo-code@version`, minus the registry. */
async function installPackage(root: string, version: string): Promise<void> {
	const pkg = path.join(root, "node_modules", MESSENGER_PACKAGE);
	await fs.mkdir(path.join(pkg, "src"), { recursive: true });
	await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: MESSENGER_PACKAGE, version }));
	await fs.writeFile(path.join(pkg, "src", "cli.ts"), "export {};\n");
}

function installer(behaviour: (root: string, version: string) => Promise<void> = installPackage) {
	const calls: [string, string][] = [];
	return { calls, install: async (root: string, version: string) => { calls.push([root, version]); await behaviour(root, version); } };
}

function restarter(outcome: "restarted" | "not installed") {
	const calls: { label: string; runScript: string; platform: NodeJS.Platform }[] = [];
	return { calls, restart: async (plan: MessengerServicePlan, platform: NodeJS.Platform) => { calls.push({ label: plan.label, runScript: plan.runScript, platform }); return outcome; } };
}

/** A loadable Discord profile whose workspace and session directories live outside the profile directory. */
async function profile(root: string, name: string): Promise<{ configPath: string; directory: string; runScript: string }> {
	const dir = path.join(root, name);
	const cwd = path.join(root, `${name}-workspace`);
	const sessionDir = path.join(root, `${name}-sessions`);
	await Promise.all([dir, cwd, sessionDir].map(item => fs.mkdir(item, { recursive: true, mode: 0o700 })));
	const configPath = path.join(dir, "messenger.json");
	await fs.writeFile(configPath, JSON.stringify({ cwd, sessionDir, sandbox, toolNames: [], platforms: { discord: { tokenEnv: "JEO_DISCORD_BOT_TOKEN", allowedUserIds: ["owner"], allowedChannelIds: ["channel"] } } }));
	return { configPath, directory: dir, runScript: path.join(dir, MESSENGER_RUN_SCRIPT_POSIX) };
}

describe("messengerRuntimePlan", () => {
	const globalEntry = "/usr/local/lib/node_modules/jeo-code/src/cli.ts";
	test.each<{ name: string; entry: string; execPath: string; version: string; expected: MessengerRuntime }>([
		{ name: "global install", entry: globalEntry, execPath: bun, version: "1.2.3", expected: { kind: "managed", version: "1.2.3" } },
		{ name: "managed runtime install", entry: "/home/u/.jeo/notify/profile/runtime/1.2.3/node_modules/jeo-code/src/cli.ts", execPath: bun, version: "1.2.3", expected: { kind: "managed", version: "1.2.3" } },
		{ name: "prerelease version", entry: globalEntry, execPath: bun, version: "1.2.3-rc.1", expected: { kind: "managed", version: "1.2.3-rc.1" } },
		{ name: "Windows global install", entry: "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\jeo-code\\src\\cli.ts", execPath: "C:\\bun\\bun.exe", version: "1.2.3", expected: { kind: "managed", version: "1.2.3" } },
		{ name: "source checkout", entry: "/repo/src/cli.ts", execPath: bun, version: "1.2.3", expected: { kind: "external", command: [bun, "/repo/src/cli.ts"] } },
		{ name: "another package's cli", entry: "/x/node_modules/other/src/cli.ts", execPath: bun, version: "1.2.3", expected: { kind: "external", command: [bun, "/x/node_modules/other/src/cli.ts"] } },
		{ name: "compiled binary", entry: bun, execPath: bun, version: "1.2.3", expected: { kind: "external", command: [bun] } },
		{ name: "bunfs entry", entry: "/$bunfs/root/cli.ts", execPath: "/opt/jeo", version: "1.2.3", expected: { kind: "external", command: ["/opt/jeo"] } },
		{ name: "Windows bunfs entry", entry: "B:\\~BUN\\root\\cli.ts", execPath: "C:\\jeo.exe", version: "1.2.3", expected: { kind: "external", command: ["C:\\jeo.exe"] } },
		{ name: "install with a two-part version", entry: globalEntry, execPath: bun, version: "1.2", expected: { kind: "external", command: [bun, globalEntry] } },
		{ name: "install with a v-prefixed version", entry: globalEntry, execPath: bun, version: "v1.2.3", expected: { kind: "external", command: [bun, globalEntry] } },
	])("$name", ({ entry, execPath, version, expected }) => {
		expect(messengerRuntimePlan(entry, execPath, version)).toEqual(expected);
	});
});

describe("messengerRuntimeRoot and messengerRuntimeCommand", () => {
	test("root is <profile>/runtime/<version> for a semver only", () => {
		expect(messengerRuntimeRoot("/p", "1.2.3")).toBe(path.join("/p", "runtime", "1.2.3"));
		expect(messengerRuntimeRoot("/p", "1.2.3-beta.2")).toBe(path.join("/p", "runtime", "1.2.3-beta.2"));
		for (const version of ["../x", "1.2", "", "1.2.3/../../x", "v1.2.3", "1.2.3 "]) {
			expect(() => messengerRuntimeRoot("/p", version)).toThrow(`Invalid messenger runtime version: ${version}`);
		}
	});

	test("external runtimes run their own argv; managed ones run the pinned package through execPath", () => {
		expect(messengerRuntimeCommand("/p", { kind: "external", command: ["/opt/jeo", "--flag"] }, bun)).toEqual(["/opt/jeo", "--flag"]);
		expect(messengerRuntimeCommand("/p", { kind: "managed", version: "1.2.3" }, bun)).toEqual([bun, cliOf("/p", "1.2.3")]);
		expect(() => messengerRuntimeCommand("/p", { kind: "managed", version: "../x" }, bun)).toThrow("Invalid messenger runtime version");
	});
});

describe("provisionMessengerRuntime", () => {
	test("writes the pinned manifest before install and returns the runtime command", async () => {
		const dir = await directory();
		let manifest: unknown;
		const { calls, install } = installer(async (root, version) => {
			manifest = await Bun.file(path.join(root, "package.json")).json();
			await installPackage(root, version);
		});
		const command = await provisionMessengerRuntime(dir, "1.0.0", { install, execPath: bun });
		const root = path.join(dir, "runtime", "1.0.0");
		expect(calls).toEqual([[root, "1.0.0"]]);
		expect(manifest).toMatchObject({ dependencies: { [MESSENGER_PACKAGE]: "1.0.0" } });
		expect(command).toEqual([bun, cliOf(dir, "1.0.0")]);
		expect(await exists(cliOf(dir, "1.0.0"))).toBe(true);
	});

	test.each<{ name: string; behaviour: (root: string, version: string) => Promise<void>; message: string }>([
		{ name: "install leaves nothing behind", behaviour: async () => {}, message: `Could not install the messenger runtime ${MESSENGER_PACKAGE}@1.0.0: the runtime contains ${MESSENGER_PACKAGE}@nothing` },
		{ name: "install lands the wrong version", behaviour: root => installPackage(root, "0.9.0"), message: `Could not install the messenger runtime ${MESSENGER_PACKAGE}@1.0.0: the runtime contains ${MESSENGER_PACKAGE}@0.9.0` },
		{
			name: "install lands a manifest without the entry script",
			behaviour: async root => { await installPackage(root, "1.0.0"); await fs.unlink(path.join(root, "node_modules", MESSENGER_PACKAGE, "src", "cli.ts")); },
			message: `Could not install the messenger runtime ${MESSENGER_PACKAGE}@1.0.0: the runtime contains ${MESSENGER_PACKAGE}@nothing`,
		},
		{ name: "install throws", behaviour: async () => { throw new Error("registry down"); }, message: `Could not install the messenger runtime ${MESSENGER_PACKAGE}@1.0.0: registry down` },
	])("$name: throws and removes the runtime root", async ({ behaviour, message }) => {
		const dir = await directory();
		const root = path.join(dir, "runtime", "1.0.0");
		await expect(provisionMessengerRuntime(dir, "1.0.0", { install: installer(behaviour).install, execPath: bun })).rejects.toThrow(message);
		expect(await exists(root)).toBe(false);
	});

	test("an intact runtime is reused without reinstalling", async () => {
		const dir = await directory();
		const { calls, install } = installer();
		const first = await provisionMessengerRuntime(dir, "1.0.0", { install, execPath: bun });
		const marker = path.join(dir, "runtime", "1.0.0", "node_modules", MESSENGER_PACKAGE, "marker.txt");
		await fs.writeFile(marker, "keep");
		const second = await provisionMessengerRuntime(dir, "1.0.0", { install, execPath: bun });
		expect(second).toEqual(first);
		expect(calls).toHaveLength(1);
		expect(await fs.readFile(marker, "utf8")).toBe("keep");
	});

	test("a partial runtime is wiped and reinstalled", async () => {
		const dir = await directory();
		const root = path.join(dir, "runtime", "1.0.0");
		await installPackage(root, "1.0.0");
		await fs.unlink(path.join(root, "node_modules", MESSENGER_PACKAGE, "src", "cli.ts"));
		await fs.writeFile(path.join(root, "stale.txt"), "leftover");
		const { calls, install } = installer();
		await provisionMessengerRuntime(dir, "1.0.0", { install, execPath: bun });
		expect(calls).toEqual([[root, "1.0.0"]]);
		expect(await exists(path.join(root, "stale.txt"))).toBe(false);
		expect(await exists(cliOf(dir, "1.0.0"))).toBe(true);
	});
});

describe("pruneMessengerRuntimes", () => {
	test("removes semver runtimes outside keep and ignores everything else", async () => {
		const dir = await directory();
		const runtime = path.join(dir, "runtime");
		for (const name of ["1.0.0", "1.1.0", "2.0.0-rc.1", "notes"]) await fs.mkdir(path.join(runtime, name), { recursive: true });
		await fs.writeFile(path.join(runtime, "README"), "hands off");
		await fs.writeFile(path.join(runtime, "1.0.0", "file"), "x");
		expect((await pruneMessengerRuntimes(dir, ["1.1.0"])).sort()).toEqual(["1.0.0", "2.0.0-rc.1"]);
		expect((await fs.readdir(runtime)).sort()).toEqual(["1.1.0", "README", "notes"]);
	});

	test("an empty keep list removes every runtime; a missing runtime directory removes nothing", async () => {
		const dir = await directory();
		expect(await pruneMessengerRuntimes(dir, ["1.0.0"])).toEqual([]);
		await fs.mkdir(path.join(dir, "runtime", "3.0.0"), { recursive: true });
		expect(await pruneMessengerRuntimes(dir, [])).toEqual(["3.0.0"]);
		expect(await fs.readdir(path.join(dir, "runtime"))).toEqual([]);
	});
});

describe("messenger profile registry", () => {
	test("registerMessengerProfile upserts by configPath into a private file", async () => {
		const root = await directory();
		const file = path.join(root, "registry", "messenger-profiles.json");
		const a = await profile(root, "a");
		const b = await profile(root, "b");
		const record = (configPath: string, runtime: MessengerRuntime, extra: Partial<MessengerProfileRecord> = {}): MessengerProfileRecord =>
			({ configPath, runScript: path.join(path.dirname(configPath), MESSENGER_RUN_SCRIPT_POSIX), runtime, updatedAt: "2026-01-01T00:00:00.000Z", ...extra });
		await registerMessengerProfile(record(a.configPath, { kind: "managed", version: "1.0.0" }, { service: "dev.jeo.messenger.a" }), file);
		await registerMessengerProfile(record(b.configPath, { kind: "external", command: ["/opt/jeo"] }), file);
		const replacement = record(a.configPath, { kind: "managed", version: "2.0.0" }, { updatedAt: "2026-02-02T00:00:00.000Z" });
		await registerMessengerProfile(replacement, file);
		const records = await readMessengerProfiles(file);
		expect(records).toHaveLength(2);
		expect(records.find(item => item.configPath === a.configPath)).toEqual(replacement);
		expect(records.find(item => item.configPath === b.configPath)).toEqual(record(b.configPath, { kind: "external", command: ["/opt/jeo"] }));
		if (posix) expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
	});

	test.each([
		{ name: "missing", content: undefined },
		{ name: "malformed", content: "{ not json" },
		{ name: "not a list", content: JSON.stringify({ configPath: "/x" }) },
	])("readMessengerProfiles returns nothing for a $name registry", async ({ content }) => {
		const root = await directory();
		const file = path.join(root, "messenger-profiles.json");
		if (content !== undefined) await fs.writeFile(file, content);
		expect(await readMessengerProfiles(file)).toEqual([]);
	});

	test("readMessengerProfiles drops records whose profile is gone or whose runtime is invalid", async () => {
		const root = await directory();
		const file = path.join(root, "messenger-profiles.json");
		const live = await profile(root, "live");
		const gone = await profile(root, "gone");
		await fs.unlink(gone.configPath);
		const base = { runScript: "/run.sh", updatedAt: "2026-01-01T00:00:00.000Z" };
		await fs.writeFile(file, JSON.stringify([
			{ ...base, configPath: live.configPath, runtime: { kind: "managed", version: "1.0.0" } },
			{ ...base, configPath: gone.configPath, runtime: { kind: "managed", version: "1.0.0" } },
			{ ...base, configPath: live.configPath, runtime: { kind: "managed", version: "nope" } },
			{ ...base, configPath: live.configPath, runtime: { kind: "external", command: [] } },
			{ ...base, configPath: live.configPath, runtime: { kind: "external", command: ["", "/opt/jeo"] } },
			{ ...base, configPath: live.configPath, runtime: { kind: "unknown" } },
			{ ...base, configPath: path.relative(process.cwd(), live.configPath), runtime: { kind: "managed", version: "1.0.0" } },
			{ ...base, configPath: live.configPath, runtime: { kind: "external", command: ["/opt/jeo", "--x"] } },
			"garbage",
		]));
		expect((await readMessengerProfiles(file)).map(item => [item.configPath, item.runtime])).toEqual([
			[live.configPath, { kind: "managed", version: "1.0.0" }],
			[live.configPath, { kind: "external", command: ["/opt/jeo", "--x"] }],
		]);
	});
});

describe("refreshMessengerProfile", () => {
	const now = () => new Date("2026-03-04T05:06:07.000Z");
	const env = { PATH: "/usr/bin:/bin" };

	test("provisions the managed runtime, rewrites the launcher, restarts the service and prunes older runtimes", async () => {
		const root = await directory();
		const file = path.join(root, "messenger-profiles.json");
		const { configPath, directory: dir, runScript } = await profile(root, "Profile_One");
		for (const version of ["0.9.0", "1.0.0"]) await installPackage(path.join(dir, "runtime", version), version);
		await registerMessengerProfile({ configPath, runScript, runtime: { kind: "managed", version: "1.0.0" }, service: "dev.jeo.messenger.legacy-label", updatedAt: "2026-01-01T00:00:00.000Z" }, file);
		const { calls, install } = installer();
		const restart = restarter("not installed");
		const result = await refreshMessengerProfile(configPath, { runtime: { kind: "managed", version: "2.0.0" }, runtimeDeps: { install }, restartService: restart.restart, profilesPath: file, env, platform: "darwin", execPath: bun, now });
		expect(result).toEqual({ configPath, runtime: { kind: "managed", version: "2.0.0" }, service: "not installed", removedRuntimes: ["0.9.0"] });
		expect(calls).toEqual([[path.join(dir, "runtime", "2.0.0"), "2.0.0"]]);
		const launcher = await fs.readFile(runScript, "utf8");
		expect(launcher).toContain(`exec '${bun}' '${cliOf(dir, "2.0.0")}' messenger run --config "$dir/messenger.json"`);
		if (posix) expect((await fs.stat(runScript)).mode & 0o777).toBe(0o700);
		expect(restart.calls).toEqual([{ label: "dev.jeo.messenger.profile-one", runScript, platform: "darwin" }]);
		expect((await fs.readdir(path.join(dir, "runtime"))).sort()).toEqual(["1.0.0", "2.0.0"]);
		// The service was not restarted here, so the label recorded by the earlier setup survives.
		expect(await readMessengerProfiles(file)).toEqual([{ configPath, runScript, runtime: { kind: "managed", version: "2.0.0" }, service: "dev.jeo.messenger.legacy-label", updatedAt: now().toISOString() }]);
	});

	test("records the restarted service label and no label when nothing was ever installed", async () => {
		const root = await directory();
		const file = path.join(root, "messenger-profiles.json");
		const { configPath, runScript } = await profile(root, "svc");
		const deps = { runtime: { kind: "managed", version: "2.0.0" } as const, runtimeDeps: { install: installer().install }, profilesPath: file, env, platform: "darwin" as const, execPath: bun, now };
		expect((await refreshMessengerProfile(configPath, { ...deps, restartService: restarter("not installed").restart })).service).toBe("not installed");
		expect(await readMessengerProfiles(file)).toEqual([{ configPath, runScript, runtime: { kind: "managed", version: "2.0.0" }, updatedAt: now().toISOString() }]);
		expect((await refreshMessengerProfile(configPath, { ...deps, restartService: restarter("restarted").restart })).service).toBe("restarted");
		expect((await readMessengerProfiles(file))[0]?.service).toBe("dev.jeo.messenger.svc");
	});

	test("a failed install leaves the launcher, service and registry untouched", async () => {
		const root = await directory();
		const file = path.join(root, "messenger-profiles.json");
		const { configPath, directory: dir, runScript } = await profile(root, "broken");
		await fs.writeFile(runScript, "#!/bin/sh\nexec /previous/jeo messenger run\n");
		const restart = restarter("restarted");
		await expect(refreshMessengerProfile(configPath, {
			runtime: { kind: "managed", version: "2.0.0" }, runtimeDeps: { install: installer(async () => { throw new Error("registry down"); }).install },
			restartService: restart.restart, profilesPath: file, env, platform: "darwin", execPath: bun, now,
		})).rejects.toThrow(`Could not install the messenger runtime ${MESSENGER_PACKAGE}@2.0.0: registry down`);
		expect(await fs.readFile(runScript, "utf8")).toBe("#!/bin/sh\nexec /previous/jeo messenger run\n");
		expect(restart.calls).toEqual([]);
		expect(await exists(file)).toBe(false);
		expect(await exists(path.join(dir, "runtime", "2.0.0"))).toBe(false);
	});

	test("an external runtime is written verbatim without installing or pruning", async () => {
		const root = await directory();
		const file = path.join(root, "messenger-profiles.json");
		const { configPath, directory: dir, runScript } = await profile(root, "ext");
		await fs.mkdir(path.join(dir, "runtime", "0.1.0"), { recursive: true });
		const { calls, install } = installer();
		const result = await refreshMessengerProfile(configPath, { runtime: { kind: "external", command: ["/opt/jeo"] }, runtimeDeps: { install }, restartService: restarter("not installed").restart, profilesPath: file, env, platform: "darwin", execPath: bun, now });
		expect(result).toEqual({ configPath, runtime: { kind: "external", command: ["/opt/jeo"] }, service: "not installed", removedRuntimes: [] });
		expect(calls).toEqual([]);
		expect(await fs.readFile(runScript, "utf8")).toContain(`exec '/opt/jeo' messenger run --config "$dir/messenger.json"`);
		expect(await exists(path.join(dir, "runtime", "0.1.0"))).toBe(true);
		expect((await readMessengerProfiles(file))[0]?.runtime).toEqual({ kind: "external", command: ["/opt/jeo"] });
	});
});

describe("refreshMessengerProfiles", () => {
	const now = () => new Date("2026-03-04T05:06:07.000Z");
	const env = { PATH: "/usr/bin:/bin" };

	test("an empty registry is reported without refreshing anything", async () => {
		const root = await directory();
		const lines: string[] = [];
		const { calls, install } = installer();
		const result = await refreshMessengerProfiles(undefined, line => lines.push(line), { runtime: { kind: "managed", version: "2.0.0" }, runtimeDeps: { install }, restartService: restarter("not installed").restart, profilesPath: path.join(root, "messenger-profiles.json"), env, platform: "darwin", execPath: bun, now });
		expect(result).toEqual({ refreshed: 0, failed: 0, skipped: 0 });
		expect(lines).toEqual(["No messenger profiles are registered; run `jeo messenger setup --config <file>` first."]);
		expect(calls).toEqual([]);
	});

	test("every registered managed profile is refreshed and failures are counted per profile", async () => {
		const root = await directory();
		const file = path.join(root, "messenger-profiles.json");
		const first = await profile(root, "first");
		const second = await profile(root, "second");
		for (const item of [first, second]) await registerMessengerProfile({ configPath: item.configPath, runScript: item.runScript, runtime: { kind: "managed", version: "1.0.0" }, updatedAt: "2026-01-01T00:00:00.000Z" }, file);
		const lines: string[] = [];
		const { install } = installer(async (dir, version) => {
			if (dir.startsWith(second.directory)) throw new Error("registry down");
			await installPackage(dir, version);
		});
		const result = await refreshMessengerProfiles(undefined, line => lines.push(line), { runtime: { kind: "managed", version: "2.0.0" }, runtimeDeps: { install }, restartService: restarter("restarted").restart, profilesPath: file, env, platform: "darwin", execPath: bun, now });
		expect(result).toEqual({ refreshed: 1, failed: 1, skipped: 0 });
		expect(lines).toEqual([
			`${first.configPath}: launcher runs ${MESSENGER_PACKAGE}@2.0.0 (managed runtime); service restarted.`,
			`${second.configPath}: not refreshed — Could not install the messenger runtime ${MESSENGER_PACKAGE}@2.0.0: registry down`,
		]);
		expect((await readMessengerProfiles(file)).map(item => [item.configPath, item.runtime.kind === "managed" ? item.runtime.version : ""])).toEqual([[second.configPath, "1.0.0"], [first.configPath, "2.0.0"]]);
	});

	test("a registered external profile is skipped implicitly and re-pinned only when named", async () => {
		const root = await directory();
		const file = path.join(root, "messenger-profiles.json");
		const { configPath, directory: dir, runScript } = await profile(root, "ext");
		await fs.writeFile(runScript, "#!/bin/sh\nexec /opt/jeo messenger run\n");
		await registerMessengerProfile({ configPath, runScript, runtime: { kind: "external", command: ["/opt/jeo"] }, updatedAt: "2026-01-01T00:00:00.000Z" }, file);
		const { calls, install } = installer();
		const deps = { runtime: { kind: "managed", version: "2.0.0" } as const, runtimeDeps: { install }, restartService: restarter("not installed").restart, profilesPath: file, env, platform: "darwin" as const, execPath: bun, now };
		const skippedLines: string[] = [];
		expect(await refreshMessengerProfiles(undefined, line => skippedLines.push(line), deps)).toEqual({ refreshed: 0, failed: 0, skipped: 1 });
		expect(skippedLines).toHaveLength(1);
		expect(skippedLines[0]).toStartWith(`${configPath}: launcher runs /opt/jeo (external); left unchanged`);
		expect(calls).toEqual([]);
		expect(await fs.readFile(runScript, "utf8")).toBe("#!/bin/sh\nexec /opt/jeo messenger run\n");
		expect((await readMessengerProfiles(file))[0]?.runtime).toEqual({ kind: "external", command: ["/opt/jeo"] });

		const pinnedLines: string[] = [];
		expect(await refreshMessengerProfiles([configPath], line => pinnedLines.push(line), deps)).toEqual({ refreshed: 1, failed: 0, skipped: 0 });
		expect(pinnedLines).toEqual([`${configPath}: launcher runs ${MESSENGER_PACKAGE}@2.0.0 (managed runtime); service not installed.`]);
		expect(calls).toEqual([[path.join(dir, "runtime", "2.0.0"), "2.0.0"]]);
		expect(await fs.readFile(runScript, "utf8")).toContain(cliOf(dir, "2.0.0"));
		expect((await readMessengerProfiles(file))[0]?.runtime).toEqual({ kind: "managed", version: "2.0.0" });
	});
});

describe("setupDiscordMessenger runtime pinning", () => {
	const responses: Record<string, unknown> = {
		"/users/@me": { id: "bot", username: "test-bot", bot: true },
		"/applications/@me": { id: "application", owner: { id: "owner" }, flags: 1 << 18 },
		"/users/@me/guilds": [{ id: "guild" }],
		"/channels/channel": { id: "channel", guild_id: "guild", type: 0, name: "requests" },
		"/guilds/guild": { id: "guild", roles: [{ id: "guild", permissions: "8" }] },
		"/guilds/guild/members/bot": { roles: [] },
		"/guilds/guild/channels": [{ id: "channel", guild_id: "guild", type: 0, name: "requests" }],
		"/gateway/bot": { url: "wss://gateway.discord.gg" },
	};
	const fetchImpl = (async (input: string | URL | Request) => {
		const route = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname.replace("/api/v10", "");
		if (!Object.hasOwn(responses, route)) throw new Error(`Unexpected setup request: ${route}`);
		return Response.json(responses[route]);
	}) as typeof fetch;
	class ReadySocket extends EventTarget {
		constructor() {
			super();
			queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }) })));
		}
		send(data: string) {
			if (JSON.parse(data).op === 2) {
				queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ op: 0, t: "READY", s: 1, d: { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg", user: { id: "bot" } } }) })));
			}
		}
		close() {}
	}
	const io = (notices: string[]) => ({ interactive: false, say(line: string) { notices.push(line); }, ask: async () => { throw new Error("Unexpected prompt"); }, askSecret: async () => { throw new Error("Unexpected credential prompt"); } });
	const shared = { env: { JEO_DISCORD_BOT_TOKEN: "test-token" }, fetch: fetchImpl, WebSocket: ReadySocket as unknown as typeof WebSocket };

	test("pins the managed runtime, registers the profile and prunes stale runtimes", async () => {
		const root = await directory();
		const file = path.join(root, "messenger-profiles.json");
		const { configPath, directory: dir, runScript } = await profile(root, "pinned");
		await fs.mkdir(path.join(dir, "runtime", "0.1.0"), { recursive: true });
		const { calls, install } = installer();
		const notices: string[] = [];
		const result = await setupDiscordMessenger({ configPath, dmTest: false }, io(notices), { ...shared, runtime: { kind: "managed", version: "9.9.9" }, runtimeDeps: { install }, restartService: restarter("not installed").restart, profilesPath: file });
		expect(result.runtime).toEqual({ kind: "managed", version: "9.9.9" });
		expect(result.service).toBeUndefined();
		expect(calls).toEqual([[path.join(dir, "runtime", "9.9.9"), "9.9.9"]]);
		expect(await fs.readFile(runScript, "utf8")).toContain(`'${cliOf(dir, "9.9.9")}' messenger run --config "$dir/messenger.json"`);
		expect(notices.some(line => line.includes(`pinned runtime ${MESSENGER_PACKAGE}@9.9.9`))).toBe(true);
		expect(notices).toContain("Removed stale messenger runtimes: 0.1.0.");
		expect(await exists(path.join(dir, "runtime", "0.1.0"))).toBe(false);
		const records = await readMessengerProfiles(file);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ configPath, runScript, runtime: { kind: "managed", version: "9.9.9" } });
		expect(records[0]?.service).toBeUndefined();
	});

	test("an explicit jeoCommand is an external runtime that updates leave alone", async () => {
		const root = await directory();
		const file = path.join(root, "messenger-profiles.json");
		const { configPath, runScript } = await profile(root, "external");
		const { calls, install } = installer();
		const notices: string[] = [];
		const result = await setupDiscordMessenger({ configPath, dmTest: false }, io(notices), { ...shared, jeoCommand: ["/opt/jeo"], runtime: { kind: "managed", version: "9.9.9" }, runtimeDeps: { install }, restartService: restarter("not installed").restart, profilesPath: file });
		expect(result.runtime).toEqual({ kind: "external", command: ["/opt/jeo"] });
		expect(calls).toEqual([]);
		expect(await fs.readFile(runScript, "utf8")).toContain(`exec '/opt/jeo' messenger run --config "$dir/messenger.json"`);
		expect(notices.some(line => line.includes("The launcher runs /opt/jeo; `jeo update` leaves it unchanged"))).toBe(true);
		expect((await readMessengerProfiles(file)).map(item => item.runtime)).toEqual([{ kind: "external", command: ["/opt/jeo"] }]);
	});

	test("an already installed service is restarted and its label recorded without --service", async () => {
		const root = await directory();
		const file = path.join(root, "messenger-profiles.json");
		const { configPath, runScript } = await profile(root, "My Bot");
		const restart = restarter("restarted");
		const notices: string[] = [];
		const result = await setupDiscordMessenger({ configPath, dmTest: false }, io(notices), { ...shared, runtime: { kind: "managed", version: "9.9.9" }, runtimeDeps: { install: installer().install }, restartService: restart.restart, profilesPath: file });
		expect(result.service).toBeUndefined();
		expect(restart.calls).toEqual([{ label: "dev.jeo.messenger.my-bot", runScript, platform: process.platform }]);
		expect(notices).toContain("Restarted dev.jeo.messenger.my-bot on the new launcher.");
		expect((await readMessengerProfiles(file))[0]?.service).toBe("dev.jeo.messenger.my-bot");
	});
});

describe("jeo update refreshes registered messengers", () => {
	let logged: string[] = [];
	const originalLog = console.log;
	const originalError = console.error;
	const originalWarn = console.warn;
	beforeEach(() => {
		logged = [];
		console.log = (...args: unknown[]) => { logged.push(args.map(item => typeof item === "object" ? JSON.stringify(item) : String(item)).join(" ")); };
		console.error = () => {};
		console.warn = () => {};
		process.exitCode = 0;
	});
	afterEach(() => {
		console.log = originalLog;
		console.error = originalError;
		console.warn = originalWarn;
		process.exitCode = 0;
	});
	const deps = (overrides: Partial<UpdateDeps>): UpdateDeps => ({ fetchJson: async () => ({ version: "0.2.0" }), localVersion: () => "0.1.0", install: async () => ({ success: true }), activeVersion: () => "0.2.0", ...overrides });

	test.each([
		{ name: "a clean install", install: { success: true }, success: "Successfully installed jeo-code@0.2.0" },
		{ name: "an install the active jeo recovered from", install: { success: false }, success: "Successfully installed jeo-code@0.2.0 (package manager reported an error, but the runtime verified clean)." },
	])("after $name the refresh runs once, after the success line and before the release notes", async ({ install, success }) => {
		const events: unknown[] = [];
		await runUpdateCommandWith(["--install"], deps({
			install: async () => install,
			refreshMessengers: quiet => { events.push({ type: "refresh", quiet, announced: logged.includes(success) }); return true; },
			showWhatsNew: () => { events.push({ type: "whats-new" }); },
		}));
		expect(events).toEqual([{ type: "refresh", quiet: false, announced: true }, { type: "whats-new" }]);
		expect(process.exitCode).toBe(0);
	});

	test.each([
		{ name: "every profile refreshed", outcome: true, install: { success: true } },
		{ name: "a profile failed", outcome: false, install: { success: true } },
		{ name: "no profile registered", outcome: null, install: { success: true } },
		{ name: "a recovered install with profiles", outcome: true, install: { success: false } },
	])("--json reports messengersRefreshed only when $name", async ({ outcome, install }) => {
		const calls: boolean[] = [];
		await runUpdateCommandWith(["--json", "--install"], deps({ install: async () => install, refreshMessengers: quiet => { calls.push(quiet); return outcome; } }));
		expect(calls).toEqual([true]);
		expect(logged).toHaveLength(1);
		const report = JSON.parse(logged[0]!);
		expect(report).toMatchObject({ latest: "0.2.0", installed: true });
		if (outcome === null) expect(report).not.toHaveProperty("messengersRefreshed");
		else expect(report.messengersRefreshed).toBe(outcome);
	});

	test.each([{ args: ["--install"] }, { args: ["--json", "--install"] }])("a stale active jeo never refreshes messengers ($args)", async ({ args }) => {
		let called = false;
		await runUpdateCommandWith(args, deps({ activeVersion: () => "0.1.0", refreshMessengers: () => { called = true; return true; } }));
		expect(called).toBe(false);
		expect(process.exitCode).toBe(1);
		if (args.includes("--json")) expect(JSON.parse(logged[0]!)).not.toHaveProperty("messengersRefreshed");
	});
});
