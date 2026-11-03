import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createGrantAuthority } from "../src/agent/sandbox/authority";
import { createSandboxPolicy } from "../src/agent/sandbox/policy";
import { encodeHandsFrame, parseHandsRequest } from "../src/agent/sandbox/rpc";
import type { HandsRequest } from "../src/agent/sandbox/rpc";
import { createSandboxSupervisor } from "../src/agent/sandbox/supervisor";
import type { SandboxBackend, SandboxPolicy, SandboxProcess, SandboxTermination } from "../src/agent/sandbox/types";

const config = { image: "test-local-image", limits: { memoryBytes: 128 * 1024 * 1024, pids: 32, cpus: 1 } };
const human = (sessionKey: string) => ({ origin: "discord" as const, sessionKey, userId: "operator" });

// Only the container boundary is controlled. The authority, supervisor, RPC parser,
// canonical resources and read effects are real; this does not qualify OS isolation.
class ReadHands implements SandboxProcess {
	private output!: ReadableStreamDefaultController<Uint8Array>;
	private diagnostics!: ReadableStreamDefaultController<Uint8Array>;
	private exit = Promise.withResolvers<number>();
	private input = "";
	readonly entered = Promise.withResolvers<void>();
	readonly held: HandsRequest[] = [];
	holdReads = false;
	removed = false;
	termination: SandboxTermination = { gone: true, residual: [] };
	readonly stdout = new ReadableStream<Uint8Array>({ start: controller => { this.output = controller; } });
	readonly stderr = new ReadableStream<Uint8Array>({ start: controller => { this.diagnostics = controller; } });
	readonly exited = this.exit.promise;
	readonly stdin = {
		write: async (data: string) => {
			if (this.removed) throw new Error("Container was removed");
			this.input += data;
			let end: number;
			while ((end = this.input.indexOf("\n")) !== -1) {
				const request = parseHandsRequest(JSON.parse(this.input.slice(0, end)));
				this.input = this.input.slice(end + 1);
				if (this.holdReads) { this.held.push(request); this.entered.resolve(); }
				else await this.read(request);
			}
		},
		flush() {},
		end() {},
	};

	constructor(readonly name: string, private readonly policy: SandboxPolicy) {}

	result(request: HandsRequest, result: { success: boolean; output: string; error?: string }) {
		this.output.enqueue(new TextEncoder().encode(encodeHandsFrame({ id: request.id, type: "result", result })));
	}

	private async read(request: HandsRequest) {
		if (request.type !== "tool" || request.tool !== "read" || typeof request.args.path !== "string") throw new Error("Unexpected fixture request");
		const target = request.args.path;
		const mount = this.policy.mounts.find(item => target === item.guest || target.startsWith(`${item.guest}/`));
		if (!mount) { this.result(request, { success: false, output: "", error: "SANDBOX_DENIED: resource is not mounted" }); return; }
		try {
			const host = path.join(mount.host, target.slice(mount.guest.length));
			this.result(request, { success: true, output: await fs.readFile(host, "utf8") });
		} catch (error) { this.result(request, { success: false, output: "", error: String(error) }); }
	}

	async stop(): Promise<SandboxTermination> {
		if (this.termination.gone && this.termination.residual.length === 0) { this.removed = true; this.exit.resolve(0); }
		return this.termination;
	}

	finish() {
		this.termination = { gone: true, residual: [] };
		this.removed = true;
		this.exit.resolve(0);
		this.output.close();
		this.diagnostics.close();
	}
}

class ReadBackend implements SandboxBackend {
	readonly processes: ReadHands[] = [];
	async preflight() { return { imageId: "sha256:" + "a".repeat(64), platform: "linux/arm64" }; }
	async launch(policy: SandboxPolicy): Promise<SandboxProcess> {
		const worker = new ReadHands(`${policy.sessionKey}-${this.processes.length}`, policy);
		this.processes.push(worker);
		return worker;
	}
}

async function fixture(sessionKey: string) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-regrant-")));
	const cwd = path.join(root, "workspace");
	const oldResource = path.join(root, "old-resource");
	const newResource = path.join(root, "new-resource");
	await Promise.all([cwd, oldResource, newResource].map(directory => fs.mkdir(directory)));
	const oldFile = path.join(oldResource, "data.txt");
	const newFile = path.join(newResource, "data.txt");
	await Promise.all([fs.writeFile(oldFile, "old grant bytes"), fs.writeFile(newFile, "fresh grant bytes")]);
	const backend = new ReadBackend();
	const policy = await createSandboxPolicy({ sessionKey, revision: 0, cwd, config });
	const supervisor = createSandboxSupervisor({ policy, backend, bundlePath: path.join(root, "controlled-hands.js") });
	const authority = await createGrantAuthority({ sessionKey, cwd, config, supervisor, allowedUserIds: ["operator"], stateDirectory: path.join(root, "private-authority") });
	return {
		authority, supervisor, backend, oldResource, newResource, oldFile, newFile,
		async close() {
			for (const worker of backend.processes) worker.finish();
			await supervisor.close().catch(() => {});
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}

function denied(result: { success: boolean; error?: string }, reason: RegExp) {
	expect(result.success).toBe(false);
	expect(result.error).toMatch(reason);
}

test("fresh human approval after revoke launches new hands without restoring old grants, pending work or another session", async () => {
	const a = await fixture("regrant-a");
	const b = await fixture("regrant-b");
	try {
		const oldGrant = await a.authority.requestAccess(a.oldResource, "ro");
		await a.authority.approve(oldGrant.id, human("regrant-a"));
		const otherGrant = await b.authority.requestAccess(b.oldResource, "ro");
		await b.authority.approve(otherGrant.id, human("regrant-b"));
		expect(await a.supervisor.call("read", { path: a.oldFile })).toEqual({ success: true, output: "old grant bytes" });
		expect(await b.supervisor.call("read", { path: b.oldFile })).toEqual({ success: true, output: "old grant bytes" });
		const oldWorker = a.backend.processes[0]!;
		const otherWorker = b.backend.processes[0]!;
		const otherAuthority = b.authority.snapshot();
		const pending = await a.authority.requestAccess(a.newResource, "ro");
		const pendingDecision = a.authority.awaitDecision(pending.id);
		oldWorker.holdReads = true;
		const active = a.supervisor.call("read", { path: a.oldFile });
		await oldWorker.entered.promise;
		const queued = a.supervisor.call("read", { path: a.oldFile });
		const beforeRevoke = a.authority.snapshot().revision;

		expect(await a.authority.revoke(human("regrant-a"))).toEqual({ gone: true, residual: [] });
		expect(oldWorker.removed).toBe(true);
		denied(await active, /REVOKED/);
		denied(await queued, /REVOKED/);
		expect(oldWorker.held).toHaveLength(1);
		expect((await pendingDecision).status).toBe("stale");
		expect(a.authority.snapshot().grants).toEqual([]);
		expect(a.authority.snapshot().revision).toBe(beforeRevoke + 1);
		await expect(a.authority.approve(pending.id, human("regrant-a"))).rejects.toThrow("STALE_REQUEST");
		await expect(a.authority.approve(oldGrant.id, human("regrant-a"))).rejects.toThrow("STALE_REQUEST");
		denied(await a.supervisor.call("read", { path: a.newFile }), /REVOKED/);

		const fresh = await a.authority.requestAccess(a.newResource, "ro");
		expect(fresh.id).not.toBe(pending.id);
		expect(fresh.revision).toBe(beforeRevoke + 1);
		await expect(a.authority.approve(fresh.id, { origin: "model", sessionKey: "regrant-a", userId: "operator" })).rejects.toThrow("UNAUTHORIZED");
		expect((await a.authority.approve(fresh.id, human("regrant-a"))).status).toBe("approved");
		expect(a.authority.snapshot().revision).toBe(beforeRevoke + 2);
		expect(a.authority.snapshot().grants.map(({ host, mode }) => ({ host, mode }))).toEqual([{ host: a.newResource, mode: "ro" }]);
		expect(a.backend.processes).toHaveLength(1); // Approval is lazy; no worker before an effect.
		oldWorker.result(oldWorker.held[0]!, { success: true, output: "stale worker success" });
		expect(await a.supervisor.call("read", { path: a.newFile })).toEqual({ success: true, output: "fresh grant bytes" });
		expect(a.backend.processes).toHaveLength(2);
		expect(a.backend.processes[1]!.name).not.toBe(oldWorker.name);
		denied(await a.supervisor.call("read", { path: a.oldFile }), /SANDBOX_DENIED/);
		await expect(a.authority.approve(pending.id, human("regrant-a"))).rejects.toThrow("STALE_REQUEST");
		expect(await b.supervisor.call("read", { path: b.oldFile })).toEqual({ success: true, output: "old grant bytes" });
		expect(b.authority.snapshot()).toEqual(otherAuthority);
		expect(otherWorker.removed).toBe(false);
		expect(b.backend.processes).toHaveLength(1);
	} finally { await Promise.all([a.close(), b.close()]); }
});

test("closing a revoked supervisor cannot be undone by a later human grant", async () => {
	const f = await fixture("regrant-closed");
	try {
		const granted = await f.authority.requestAccess(f.oldResource, "ro");
		await f.authority.approve(granted.id, human("regrant-closed"));
		expect((await f.supervisor.call("read", { path: f.oldFile })).output).toBe("old grant bytes");
		await f.authority.revoke(human("regrant-closed"));
		const fresh = await f.authority.requestAccess(f.newResource, "ro");
		await f.supervisor.close();
		await expect(f.authority.approve(fresh.id, human("regrant-closed"))).rejects.toThrow("REVOKE_INCOMPLETE");
		denied(await f.supervisor.call("read", { path: f.newFile }), /CLOSED/);
		expect(f.authority.snapshot().grants).toEqual([]);
		expect(f.authority.snapshot().blocked).toBe(true);
		expect(f.backend.processes).toHaveLength(1);
	} finally { await f.close(); }
});

test("revoke after close cannot reopen the supervisor for a fresh human approval", async () => {
	const f = await fixture("regrant-closed-revoked");
	const actor = human("regrant-closed-revoked");
	try {
		const granted = await f.authority.requestAccess(f.oldResource, "ro");
		await f.authority.approve(granted.id, actor);
		expect(await f.supervisor.call("read", { path: f.oldFile })).toEqual({ success: true, output: "old grant bytes" });
		const worker = f.backend.processes[0]!;
		await f.supervisor.close();
		expect(await f.authority.revoke(actor)).toEqual({ gone: true, residual: [] });
		const fresh = await f.authority.requestAccess(f.newResource, "ro");
		await expect(f.authority.approve(fresh.id, actor)).rejects.toThrow("REVOKE_INCOMPLETE");
		denied(await f.supervisor.call("read", { path: f.newFile }), /CLOSED/);
		expect(worker.removed).toBe(true);
		expect(f.authority.snapshot().grants).toEqual([]);
		expect(f.authority.snapshot().blocked).toBe(true);
		expect(f.backend.processes).toHaveLength(1);
	} finally { await f.close(); }
});

test("a failed supervisor close stays terminal for a later fresh human approval", async () => {
  const f = await fixture("regrant-close-failed");
  const actor = human("regrant-close-failed");
  try {
    const granted = await f.authority.requestAccess(f.oldResource, "ro");
    await f.authority.approve(granted.id, actor);
    expect((await f.supervisor.call("read", { path: f.oldFile })).output).toBe("old grant bytes");
    const worker = f.backend.processes[0]!;
    worker.termination = { gone: false, residual: [worker.name] };
    await expect(f.supervisor.close()).rejects.toThrow("REVOKE_INCOMPLETE");
    expect(worker.removed).toBe(false);
    const fresh = await f.authority.requestAccess(f.newResource, "ro");
    await expect(f.authority.approve(fresh.id, actor)).rejects.toThrow("REVOKE_INCOMPLETE");
    denied(await f.supervisor.call("read", { path: f.newFile }), /REVOKE_INCOMPLETE/);
    expect(f.authority.snapshot().blocked).toBe(true);
    expect(f.authority.snapshot().grants.map(({ host }) => host)).toEqual([f.oldResource]);
    expect(f.backend.processes).toHaveLength(1);
    // Even a later verified close cannot reopen the blocked authority.
    worker.termination = { gone: true, residual: [] };
    await f.supervisor.close();
    await expect(f.authority.requestAccess(f.newResource, "ro")).rejects.toThrow("REVOKE_INCOMPLETE");
    await expect(f.authority.approve(fresh.id, actor)).rejects.toThrow("REVOKE_INCOMPLETE");
    expect(f.backend.processes).toHaveLength(1);
  } finally { await f.close(); }
});

test("unconfirmed revoke cleanup blocks fresh requests and stale approvals instead of relaunching hands", async () => {
	const f = await fixture("regrant-residual");
	try {
		const granted = await f.authority.requestAccess(f.oldResource, "ro");
		await f.authority.approve(granted.id, human("regrant-residual"));
		expect((await f.supervisor.call("read", { path: f.oldFile })).output).toBe("old grant bytes");
		const pending = await f.authority.requestAccess(f.newResource, "ro");
		const decision = f.authority.awaitDecision(pending.id);
		const worker = f.backend.processes[0]!;
		worker.termination = { gone: false, residual: [worker.name] };
		await expect(f.authority.revoke(human("regrant-residual"))).rejects.toThrow("REVOKE_INCOMPLETE");
		expect(worker.removed).toBe(false);
		expect((await decision).status).toBe("stale");
		await expect(f.authority.requestAccess(f.newResource, "ro")).rejects.toThrow("REVOKE_INCOMPLETE");
		await expect(f.authority.approve(pending.id, human("regrant-residual"))).rejects.toThrow("REVOKE_INCOMPLETE");
		denied(await f.supervisor.call("read", { path: f.newFile }), /REVOKE_INCOMPLETE/);
		expect(f.authority.snapshot().blocked).toBe(true);
		expect(f.backend.processes).toHaveLength(1);
	} finally { await f.close(); }
});
