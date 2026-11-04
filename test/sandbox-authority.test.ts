import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createGrantAuthority, ensurePrivateSandboxDirectory } from "../src/agent/sandbox/authority";
import { loadMessengerConfig, messengerProfilePrivatePaths } from "../src/messenger/config";
import type { SandboxPolicy, SandboxTermination } from "../src/agent/sandbox/types";

const config = { image: "test-local-image", limits: { memoryBytes: 128 * 1024 * 1024, pids: 32, cpus: 1 } };
const terminal = (sessionKey: string) => ({ origin: "terminal" as const, sessionKey });

// The container boundary is fake; authority, canonical paths, state and file effects are real.
// Deferred removal represents a daemon that has not yet proved its old container absent.
async function fixture(sessionKey = "session-a") {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-authority-")));
	const cwd = path.join(root, "workspace");
	const resource = path.join(root, "resource");
	const other = path.join(root, "other-resource");
	const stateDirectory = path.join(root, "private-authority");
	await Promise.all([cwd, resource, other].map(dir => fs.mkdir(dir)));
	let active = true;
	let effective: SandboxPolicy | undefined;
	let removal: Promise<SandboxTermination> | undefined;
	let entered = Promise.withResolvers<void>();
	let transitions = 0;
	let revocations = 0;
	const supervisor = {
		toolMap: () => ({}),
		async call() { return { success: false, output: "Use the effect fixture" }; },
		async exec() { return { success: false, output: "Use the effect fixture" }; },
		async replacePolicy(policy: SandboxPolicy) {
			transitions++;
			active = false;
			entered.resolve();
			const stopped = removal ? await removal : { gone: true, residual: [] };
			if (!stopped.gone) throw new Error("REVOKE_INCOMPLETE");
			effective = policy;
			active = true;
		},
		async revoke() {
			revocations++;
			active = false;
			entered.resolve();
			return removal ? await removal : { gone: true, residual: [] };
		},
		async close() { active = false; },
	};
	const authority = await createGrantAuthority({ sessionKey, cwd, config, supervisor, allowedUserIds: ["operator"], stateDirectory });
	return {
		root, cwd, resource, other, stateDirectory, supervisor, authority,
		get transitions() { return transitions; },
		get revocations() { return revocations; },
		get effective() { return effective; },
		holdRemoval() {
			const gate = Promise.withResolvers<SandboxTermination>();
			removal = gate.promise;
			entered = Promise.withResolvers<void>();
			return { entered: entered.promise, resolve: gate.resolve };
		},
		async write(host: string, value: string) {
			const allowed = effective?.mounts.some(mount => mount.mode === "rw" && (host === mount.host || host.startsWith(`${mount.host}${path.sep}`)));
			if (!active || !allowed) return false;
			await fs.writeFile(host, value);
			return true;
		},
		async close() { await supervisor.close(); await fs.rm(root, { recursive: true, force: true }); },
	};
}

test("an authenticated human grants only the requested canonical resource and access mode", async () => {
	const f = await fixture();
	try {
		const destination = path.join(f.resource, "result.txt");
		expect(await f.write(destination, "before")).toBe(false);
		const before = f.authority.snapshot().revision;
		const request = await f.authority.requestAccess(f.resource, "rw");
		const decision = await f.authority.approve(request.id, terminal("session-a"));
		expect(decision.status).toBe("approved");
		expect(f.authority.snapshot().revision).toBe(before + 1);
		expect(await f.write(destination, "approved")).toBe(true);
		expect(await fs.readFile(destination, "utf8")).toBe("approved");
		expect(await f.write(path.join(f.other, "escape.txt"), "escape")).toBe(false);
	} finally { await f.close(); }
});

test("read-only approval cannot become write access by mutating the returned request", async () => {
	const f = await fixture();
	try {
		const request = await f.authority.requestAccess(f.resource, "ro");
		try { Object.assign(request, { host: f.other, mode: "rw", sessionKey: "session-b", revision: request.revision + 10 }); } catch { /* frozen snapshots are valid */ }
		await f.authority.approve(request.id, terminal("session-a"));
		expect(f.authority.snapshot().grants.map(({ host, mode }) => ({ host, mode }))).toEqual([{ host: f.resource, mode: "ro" }]);
		expect(await f.write(path.join(f.resource, "changed.txt"), "tampered")).toBe(false);
		expect(await f.write(path.join(f.other, "changed.txt"), "tampered")).toBe(false);
	} finally { await f.close(); }
});

for (const row of [
	{ name: "model copying an allowlisted identity", actor: { origin: "model" as const, sessionKey: "session-a", userId: "operator" }, code: "UNAUTHORIZED" },
	{ name: "unlisted Discord user", actor: { origin: "discord" as const, sessionKey: "session-a", userId: "intruder" }, code: "UNAUTHORIZED" },
	{ name: "Discord without authenticated identity", actor: { origin: "discord" as const, sessionKey: "session-a" }, code: "UNAUTHORIZED" },
	{ name: "human from another session", actor: { origin: "discord" as const, sessionKey: "session-b", userId: "operator" }, code: "SESSION_MISMATCH" },
]) test(`${row.name} cannot approve, deny or revoke and leaves a valid request usable`, async () => {
	const f = await fixture();
	try {
		const request = await f.authority.requestAccess(f.resource, "rw");
		const before = f.authority.snapshot();
		await expect(f.authority.approve(request.id, row.actor)).rejects.toThrow(row.code);
		await expect(f.authority.reject(request.id, row.actor)).rejects.toThrow(row.code);
		await expect(f.authority.revoke(row.actor)).rejects.toThrow(row.code);
		expect(f.authority.snapshot()).toEqual(before);
		expect([f.transitions, f.revocations]).toEqual([0, 0]);
		expect(await f.write(path.join(f.resource, "unauthorized.txt"), "bad")).toBe(false);
		await f.authority.approve(request.id, terminal("session-a"));
		expect(await f.write(path.join(f.resource, "authorized.txt"), "good")).toBe(true);
	} finally { await f.close(); }
});

test("an allowlisted Discord approval takes effect for its exact session", async () => {
	const f = await fixture();
	try {
		const request = await f.authority.requestAccess(f.resource, "rw");
		await f.authority.approve(request.id, { origin: "discord", sessionKey: "session-a", userId: "operator" });
		expect(await f.write(path.join(f.resource, "discord.txt"), "human approved")).toBe(true);
		expect(await fs.readFile(path.join(f.resource, "discord.txt"), "utf8")).toBe("human approved");
	} finally { await f.close(); }
});

test("unknown and other-session request IDs cannot replace a policy", async () => {
	const a = await fixture("session-a");
	const b = await fixture("session-b");
	try {
		const request = await a.authority.requestAccess(a.resource, "rw");
		await expect(b.authority.approve(request.id, terminal("session-b"))).rejects.toThrow("UNKNOWN_REQUEST");
		await expect(a.authority.approve("not-a-request", terminal("session-a"))).rejects.toThrow("UNKNOWN_REQUEST");
		expect([a.transitions, b.transitions]).toEqual([0, 0]);
		expect(a.authority.snapshot().grants).toEqual([]);
		expect(b.authority.snapshot().grants).toEqual([]);
	} finally { await Promise.all([a.close(), b.close()]); }
});

test("a decision is bound to the policy revision and cannot replay after another approval", async () => {
	const f = await fixture();
	try {
		const first = await f.authority.requestAccess(f.resource, "rw");
		const stale = await f.authority.requestAccess(f.other, "rw");
		await f.authority.approve(first.id, terminal("session-a"));
		const before = f.authority.snapshot();
		await expect(f.authority.approve(stale.id, terminal("session-a"))).rejects.toThrow("STALE_REQUEST");
		await expect(f.authority.approve(first.id, terminal("session-a"))).rejects.toThrow("STALE_REQUEST");
		expect(f.authority.snapshot()).toEqual(before);
		expect(f.transitions).toBe(1);
		expect(await f.write(path.join(f.other, "stale.txt"), "bad")).toBe(false);
	} finally { await f.close(); }
});

test("explicit denial wakes the requester without granting or interrupting the running environment", async () => {
	const f = await fixture();
	try {
		const request = await f.authority.requestAccess(f.resource, "rw");
		const pending = f.authority.awaitDecision(request.id);
		const revision = f.authority.snapshot().revision;
		expect((await f.authority.reject(request.id, terminal("session-a"))).status).toBe("denied");
		expect((await pending).status).toBe("denied");
		expect(f.authority.snapshot().revision).toBe(revision);
		expect([f.transitions, f.revocations]).toEqual([0, 0]);
		await expect(f.authority.approve(request.id, terminal("session-a"))).rejects.toThrow("STALE_REQUEST");
		expect(await f.write(path.join(f.resource, "denied.txt"), "bad")).toBe(false);
	} finally { await f.close(); }
});

test("granting one session cannot authorize another session even for the same human and host resource", async () => {
	const a = await fixture("session-a");
	const b = await fixture("session-b");
	try {
		const request = await a.authority.requestAccess(a.resource, "rw");
		await a.authority.approve(request.id, terminal("session-a"));
		expect(await a.write(path.join(a.resource, "shared.txt"), "from a")).toBe(true);
		expect(await b.write(path.join(a.resource, "shared.txt"), "from b")).toBe(false);
		expect(await fs.readFile(path.join(a.resource, "shared.txt"), "utf8")).toBe("from a");
		expect(b.authority.snapshot().grants).toEqual([]);
	} finally { await Promise.all([a.close(), b.close()]); }
});

test("approval acknowledgement waits for old container removal and freezes effects during transition", async () => {
	const f = await fixture();
	const gate = f.holdRemoval();
	let pending: Promise<unknown> | undefined;
	try {
		const request = await f.authority.requestAccess(f.resource, "rw");
		let acknowledged = false;
		pending = f.authority.approve(request.id, terminal("session-a")).then(value => { acknowledged = true; return value; });
		await gate.entered;
		expect(acknowledged).toBe(false);
		expect(await f.write(path.join(f.resource, "premature.txt"), "bad")).toBe(false);
		gate.resolve({ gone: true, residual: [] });
		await pending;
		expect(await f.write(path.join(f.resource, "after.txt"), "good")).toBe(true);
	} finally { gate.resolve({ gone: true, residual: [] }); await pending; await f.close(); }
});

test("revoke prevents existing effects before acknowledgement and acknowledges only confirmed removal", async () => {
	const f = await fixture();
	let pending: Promise<unknown> | undefined;
	let release: (() => void) | undefined;
	try {
		const request = await f.authority.requestAccess(f.resource, "rw");
		await f.authority.approve(request.id, terminal("session-a"));
		const marker = path.join(f.resource, "ongoing.txt");
		expect(await f.write(marker, "before revoke")).toBe(true);
		const gate = f.holdRemoval();
		release = () => gate.resolve({ gone: true, residual: [] });
		let acknowledged = false;
		pending = f.authority.revoke(terminal("session-a")).then(value => { acknowledged = true; return value; });
		await gate.entered;
		expect(acknowledged).toBe(false);
		expect(await f.write(marker, "during revoke")).toBe(false);
		release(); await pending;
		expect(acknowledged).toBe(true);
		expect(await f.write(marker, "after revoke")).toBe(false);
		expect(await fs.readFile(marker, "utf8")).toBe("before revoke");
		expect(f.authority.snapshot().grants).toEqual([]);
	} finally { release?.(); await pending; await f.close(); }
});

for (const operation of ["approve", "revoke"] as const) test(`incomplete container removal during ${operation} blocks further grants and relaunch`, async () => {
	const f = await fixture();
	try {
		const granted = await f.authority.requestAccess(f.resource, "rw");
		await f.authority.approve(granted.id, terminal("session-a"));
		const later = await f.authority.requestAccess(f.other, "rw");
		const gate = f.holdRemoval();
		const transition = operation === "approve" ? f.authority.approve(later.id, terminal("session-a")) : f.authority.revoke(terminal("session-a"));
		const rejected = transition.then(() => ({ resolved: true, error: "" }), error => ({ resolved: false, error: String(error) }));
		await gate.entered;
		gate.resolve({ gone: false, residual: ["owned-container-still-running"] });
		const observed = await rejected;
		expect(observed.resolved).toBe(false);
		expect(observed.error).toContain("REVOKE_INCOMPLETE");
		expect(f.authority.snapshot().blocked).toBe(true);
		const transitions = f.transitions;
		await expect(f.authority.requestAccess(f.other, "rw")).rejects.toThrow("REVOKE_INCOMPLETE");
		await expect(f.authority.approve(later.id, terminal("session-a"))).rejects.toThrow("REVOKE_INCOMPLETE");
		expect(f.transitions).toBe(transitions);
		expect(await f.write(path.join(f.resource, "after-failure.txt"), "bad")).toBe(false);
		expect(await f.write(path.join(f.other, "after-failure.txt"), "bad")).toBe(false);
	} finally { await f.close(); }
});

test("authority state is private and cannot be exposed by a later grant", async () => {
	const f = await fixture();
	try {
		if (process.platform !== "win32") expect((await fs.stat(f.stateDirectory)).mode & 0o077).toBe(0);
		for (const resource of [f.stateDirectory, f.root]) {
			await expect((async () => {
				const request = await f.authority.requestAccess(resource, "rw");
				await f.authority.approve(request.id, terminal("session-a"));
			})()).rejects.toThrow();
		}
		expect(f.transitions).toBe(0);
		expect(f.authority.snapshot().grants).toEqual([]);
	} finally { await f.close(); }
});

test("authority refuses state placed inside its workspace mount", async () => {
	const f = await fixture();
	try {
		await expect(createGrantAuthority({ sessionKey: "unsafe", cwd: f.cwd, config, supervisor: f.supervisor, allowedUserIds: ["operator"], stateDirectory: path.join(f.cwd, "state") })).rejects.toThrow();
		expect([f.transitions, f.revocations]).toEqual([0, 0]);
	} finally { await f.close(); }
});

test("authority refuses pre-existing state readable by another user", async () => {
	const f = await fixture();
	try {
		const exposed = path.join(f.root, "exposed-state");
		await fs.mkdir(exposed, { mode: 0o755 });
		await fs.chmod(exposed, 0o755);
		await expect(createGrantAuthority({ sessionKey: "unsafe", cwd: f.cwd, config, supervisor: f.supervisor, allowedUserIds: ["operator"], stateDirectory: exposed })).rejects.toThrow();
		expect(f.transitions).toBe(0);
	} finally { await f.close(); }
});
test("profile credentials stay outside approved grants through ancestors and symlink aliases", async () => {
	const f = await fixture();
	try {
		const profileParent = path.join(f.root, "sensitive");
		const profile = path.join(profileParent, "profile");
		const alias = path.join(f.root, "profile-alias");
		await fs.mkdir(profile, { recursive: true });
		await fs.writeFile(path.join(profile, "credentials.json"), "sentinel credential");
		await fs.writeFile(path.join(profile, "launch.sh"), "sentinel launcher");
		const linkedSecret = path.join(f.root, "linked-credential.json");
		await fs.writeFile(linkedSecret, "linked sentinel");
		let linked = true;
		try {
			await fs.symlink(linkedSecret, path.join(profile, "linked-credential.json"));
		} catch (error) {
			if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") linked = false;
			else throw error;
		}
		await fs.symlink(profile, alias, process.platform === "win32" ? "junction" : "dir");
		const file = path.join(profile, "messenger.json");
		await fs.writeFile(file, JSON.stringify({ cwd: f.cwd, sessionDir: path.join(f.root, "messenger-sessions"), sandbox: config, platforms: { discord: { allowedUserIds: ["operator"] } } }));
		const loaded = await loadMessengerConfig(file);
		const privateRoots = await messengerProfilePrivatePaths(loaded.profileDir!, loaded.cwd);
		const authority = await createGrantAuthority({ sessionKey: "profile-session", cwd: loaded.cwd, config, supervisor: f.supervisor, allowedUserIds: ["operator"], stateDirectory: path.join(f.root, "profile-authority"), privateRoots });
		const restrictedTargets = [profile, path.join(profile, "credentials.json"), profileParent, alias, ...(linked ? [linkedSecret] : [])];
		for (const target of restrictedTargets) {
			for (const mode of ["ro", "rw"] as const) {
				await expect(authority.requestAccess(target, mode)).rejects.toThrow("SANDBOX_POLICY");
			}
		}
		expect(authority.snapshot().grants).toEqual([]);
		const request = await authority.requestAccess(f.resource, "rw");
		await authority.approve(request.id, { origin: "discord", sessionKey: "profile-session", userId: "operator" });
		expect(await f.write(path.join(f.resource, "allowed.txt"), "allowed")).toBe(true);
		for (const target of restrictedTargets) {
			await expect(authority.requestAccess(target, "ro")).rejects.toThrow("SANDBOX_POLICY");
		}
		expect(await f.write(path.join(profile, "credentials.json"), "leaked")).toBe(false);
		expect(await fs.readFile(path.join(profile, "credentials.json"), "utf8")).toBe("sentinel credential");
	} finally { await f.close(); }
});

test("ensurePrivateSandboxDirectory serializes concurrent callers and re-verifies existing owner-only state", async () => {
	const f = await fixture();
	try {
		const target = path.join(f.root, "concurrent-private-state");
		const results = await Promise.all(Array.from({ length: 8 }, () => ensurePrivateSandboxDirectory(target)));
		expect(new Set(results).size).toBe(1);
		expect(await ensurePrivateSandboxDirectory(target)).toBe(results[0]!);
	} finally { await f.close(); }
}, process.platform === "win32" ? 30_000 : 5000);
