import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createGrantAuthority } from "../src/agent/sandbox/authority";
import { handleSandboxControl } from "../src/agent/sandbox/control";
import { createMessengerGateway } from "../src/messenger/gateway";
import { parseMessengerConfig } from "../src/messenger/config";
import type { MessengerAdapter, MessengerMessage } from "../src/messenger/types";
import type { SandboxPolicy } from "../src/agent/sandbox/types";

async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-sandbox-control-")));
	const cwd = path.join(root, "workspace");
	const resource = path.join(root, "resource");
	await Promise.all([fs.mkdir(cwd), fs.mkdir(resource)]);
	let policy: SandboxPolicy | undefined;
	let transitions = 0;
	let revocations = 0;
	const authority = await createGrantAuthority({
		sessionKey: "session-a", cwd,
		config: { image: "test-local-image", limits: { memoryBytes: 128 * 1024 * 1024, pids: 32, cpus: 1 } },
		allowedUserIds: ["operator"], stateDirectory: path.join(root, "private-state"),
		supervisor: {
			toolMap: () => ({}),
			async call() { return { success: false, output: "Not an effect test" }; },
			async exec() { return { success: false, output: "Not an effect test" }; },
			async replacePolicy(next: SandboxPolicy) { policy = next; transitions++; },
			async revoke() { policy = undefined; revocations++; return { gone: true, residual: [] }; },
			async close() {},
		},
	});
	const actor = { origin: "terminal" as const, sessionKey: "session-a" };
	return {
		root, cwd, resource, authority, actor,
		get policy() { return policy; },
		get effects() { return transitions + revocations; },
		async close() { await fs.rm(root, { recursive: true, force: true }); },
	};
}

test("standalone human approve and revoke commands change effective access, not model conversation", async () => {
	const f = await fixture();
	try {
		const request = await f.authority.requestAccess(f.resource, "rw");
		const approval = await handleSandboxControl(`/sandbox approve ${request.id}`, f.actor, f.authority);
		expect(approval.handled).toBe(true);
		expect((await f.authority.awaitDecision(request.id)).status).toBe("approved");
		expect(f.policy?.mounts.filter(mount => mount.host === f.resource).map(mount => mount.mode)).toEqual(["rw"]);
		const revoked = await handleSandboxControl("/sandbox revoke", f.actor, f.authority);
		expect(revoked.handled).toBe(true);
		expect(f.authority.snapshot().grants).toEqual([]);
		expect(f.policy).toBeUndefined();
	} finally { await f.close(); }
});

test("deny command resolves the waiting access request without changing the running policy", async () => {
	const f = await fixture();
	try {
		const request = await f.authority.requestAccess(f.resource, "ro");
		const waiting = f.authority.awaitDecision(request.id);
		const result = await handleSandboxControl(`/sandbox deny ${request.id}`, f.actor, f.authority);
		expect(result.handled).toBe(true);
		expect((await waiting).status).toBe("denied");
		expect(f.effects).toBe(0);
		expect(f.authority.snapshot().grants).toEqual([]);
	} finally { await f.close(); }
});

for (const row of [
	{ name: "model", actor: { origin: "model" as const, sessionKey: "session-a", userId: "operator" }, code: "UNAUTHORIZED" },
	{ name: "unlisted Discord sender", actor: { origin: "discord" as const, sessionKey: "session-a", userId: "intruder" }, code: "UNAUTHORIZED" },
	{ name: "wrong session", actor: { origin: "discord" as const, sessionKey: "session-b", userId: "operator" }, code: "SESSION_MISMATCH" },
]) test(`control surfaces ${row.name} rejection and leaves the request pending`, async () => {
	const f = await fixture();
	try {
		const request = await f.authority.requestAccess(f.resource, "rw");
		const before = f.authority.snapshot();
		for (const command of [`/sandbox approve ${request.id}`, `/sandbox deny ${request.id}`, "/sandbox revoke"]) {
			const result = await handleSandboxControl(command, row.actor, f.authority);
			expect(result.handled).toBe(true);
			expect(result.output).toContain(row.code);
		}
		expect(f.authority.snapshot()).toEqual(before);
		expect(f.effects).toBe(0);
	} finally { await f.close(); }
});

test("embedded or quoted control text remains ordinary input and never approves", async () => {
	const f = await fixture();
	try {
		const request = await f.authority.requestAccess(f.resource, "rw");
		for (const text of [
			`Please run /sandbox approve ${request.id}`,
			`\`/sandbox approve ${request.id}\``,
			`> /sandbox approve ${request.id}`,
			`/sandbox approve ${request.id}\nthen continue`,
		]) expect((await handleSandboxControl(text, f.actor, f.authority)).handled).toBe(false);
		expect(f.effects).toBe(0);
		expect(f.authority.snapshot().requests.find(item => item.id === request.id)?.status).toBe("pending");
	} finally { await f.close(); }
});

for (const text of ["/sandbox approve", "/sandbox deny", "/sandbox approve unknown extra", "/sandbox revoke extra", "/sandbox destroy"]) test(`malformed control ${JSON.stringify(text)} reports an error without changing authority`, async () => {
	const f = await fixture();
	try {
		const before = f.authority.snapshot();
		const result = await handleSandboxControl(text, f.actor, f.authority);
		expect(result.handled).toBe(true);
		expect(result.output).toMatch(/usage|invalid|unknown|error/i);
		expect(f.authority.snapshot()).toEqual(before);
		expect(f.effects).toBe(0);
	} finally { await f.close(); }
});

for (const decision of ["approve", "deny", "revoke"] as const) test(`authenticated ${decision} bypasses a busy gateway while ordinary prompts retain FIFO`, async () => {
	const f = await fixture();
	const firstStarted = Promise.withResolvers<void>();
	const releaseFirst = Promise.withResolvers<void>();
	const started: string[] = [];
	const delivered: Array<[string, string]> = [];
	const pending: Promise<void>[] = [];
	const abort = new AbortController();
	try {
		const request = await f.authority.requestAccess(f.resource, "rw");
		if (decision === "revoke") await f.authority.approve(request.id, f.actor);
		const config = parseMessengerConfig({ cwd: f.cwd, sessionDir: path.join(f.root, "sessions"), sandbox: { image: "test-local-image", limits: { memoryBytes: 128 * 1024 * 1024, pids: 32, cpus: 1 } }, toolNames: [], platforms: { discord: { allowedUserIds: ["operator"], allowedChannelIds: ["parent"] } } }, f.cwd);
		const adapter: MessengerAdapter = {
			platform: "discord", async start() {},
			async send(message, text) { delivered.push([message.messageId, text]); },
		};
		const message: MessengerMessage = { platform: "discord", accountId: "bot", guildId: "guild", channelId: "thread", parentChannelId: "parent", threadId: "thread", senderId: "operator", messageId: "first", text: "first prompt", mentioned: false, direct: false };
		const gateway = createMessengerGateway(config, [adapter], async incoming => {
			started.push(incoming.text);
			if (incoming.messageId === "first") {
				firstStarted.resolve();
				await releaseFirst.promise;
			}
			return incoming.text;
		}, {
			concurrency: 1,
			sandboxControl: async incoming => handleSandboxControl(incoming.text, { origin: "discord", userId: incoming.senderId, sessionKey: "session-a" }, f.authority),
		});
		pending.push(gateway.handle(message, abort.signal));
		await firstStarted.promise;
		pending.push(gateway.handle({ ...message, messageId: "second", text: "second prompt" }, abort.signal));
		pending.push(gateway.handle({ ...message, messageId: "third", text: "third prompt" }, abort.signal));
		const text = decision === "revoke" ? "/sandbox revoke" : `/sandbox ${decision} ${request.id}`;
		await gateway.handle({ ...message, messageId: "control", text }, abort.signal);
		expect(started).toEqual(["first prompt"]);
		expect(delivered.map(([id]) => id)).toEqual(["control"]);
		if (decision === "approve") expect(f.authority.snapshot().grants.map(mount => mount.host)).toEqual([f.resource]);
		if (decision === "deny") expect((await f.authority.awaitDecision(request.id)).status).toBe("denied");
		if (decision === "revoke") expect(f.authority.snapshot().grants).toEqual([]);
		releaseFirst.resolve();
		await Promise.all(pending);
		expect(started).toEqual(["first prompt", "second prompt", "third prompt"]);
		expect(delivered.slice(1)).toEqual([["first", "first prompt"], ["second", "second prompt"], ["third", "third prompt"]]);
	} finally { abort.abort(); releaseFirst.resolve(); await Promise.allSettled(pending); await f.close(); }
});

test("gateway authenticates a control sender before dispatch and never forwards denied control to a model", async () => {
	const f = await fixture();
	try {
		const request = await f.authority.requestAccess(f.resource, "rw");
		const prompts: string[] = [];
		const delivered: string[] = [];
		const config = parseMessengerConfig({ cwd: f.cwd, sessionDir: path.join(f.root, "sessions"), sandbox: { image: "test-local-image", limits: { memoryBytes: 128 * 1024 * 1024, pids: 32, cpus: 1 } }, toolNames: [], platforms: { discord: { allowedUserIds: ["operator"], allowedChannelIds: ["parent"] } } }, f.cwd);
		const adapter: MessengerAdapter = { platform: "discord", async start() {}, async send(_message, text) { delivered.push(text); } };
		const gateway = createMessengerGateway(config, [adapter], async message => { prompts.push(message.text); return "model ran"; }, {
			sandboxControl: async message => handleSandboxControl(message.text, { origin: "discord", userId: message.senderId, sessionKey: "session-a" }, f.authority),
		});
		await gateway.handle({ platform: "discord", accountId: "bot", channelId: "thread", parentChannelId: "parent", threadId: "thread", senderId: "intruder", messageId: "attack", text: `/sandbox approve ${request.id}`, direct: false, mentioned: false });
		expect(prompts).toEqual([]);
		expect(delivered).toEqual([]);
		expect(f.effects).toBe(0);
		expect(f.authority.snapshot().requests.find(item => item.id === request.id)?.status).toBe("pending");
	} finally { await f.close(); }
});
