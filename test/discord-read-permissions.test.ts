import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createGrantAuthority } from "../src/agent/sandbox/authority";
import { handleSandboxControl } from "../src/agent/sandbox/control";
import { createSandboxPolicy } from "../src/agent/sandbox/policy";
import { createSandboxSupervisor } from "../src/agent/sandbox/supervisor";
import type { SandboxPolicy, SandboxSupervisor } from "../src/agent/sandbox/types";

const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
	tempRoots.push(root);
	return root;
}

afterEach(async () => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop()!;
		await fs.rm(root, { recursive: true, force: true });
	}
});

describe("handleSandboxControl /sandbox grant", () => {
	test("verifies actor authority and creates + approves the ../sibling ro mount in one step", async () => {
		const root = await makeTempRoot("jeo-sandbox-grant-");
		const cwd = path.join(root, "workspace");
		const sibling = path.join(root, "sibling");
		const stateDirectory = path.join(root, "private-state");
		await Promise.all([fs.mkdir(cwd, { recursive: true }), fs.mkdir(sibling, { recursive: true })]);

		let appliedPolicy: SandboxPolicy | undefined;
		let transitions = 0;
		const authority = await createGrantAuthority({
			sessionKey: "discord-session-1",
			cwd,
			config: { backend: "native" },
			allowedUserIds: ["owner"],
			stateDirectory,
			supervisor: {
				toolMap: () => ({}),
				async call() {
					return { success: false, output: "" };
				},
				async exec() {
					return { success: false, output: "" };
				},
				async replacePolicy(next: SandboxPolicy) {
					appliedPolicy = next;
					transitions++;
				},
				async revoke() {
					return { gone: true, residual: [] };
				},
				async close() {},
			},
		});

		for (const badActor of [
			{ origin: "model" as const, sessionKey: "discord-session-1", userId: "owner" },
			{ origin: "discord" as const, sessionKey: "discord-session-1", userId: "stranger" },
			{ origin: "discord" as const, sessionKey: "other-session", userId: "owner" },
		]) {
			const denied = await handleSandboxControl("/sandbox grant ../sibling ro", badActor, authority);
			expect(denied.handled).toBe(true);
			expect(denied.output).toMatch(/UNAUTHORIZED|SESSION_MISMATCH/);
			expect(authority.snapshot().requests).toEqual([]);
			expect(authority.snapshot().grants).toEqual([]);
			expect(transitions).toBe(0);
		}

		const actor = { origin: "discord" as const, sessionKey: "discord-session-1", userId: "owner" };
		const granted = await handleSandboxControl("/sandbox grant ../sibling ro", actor, authority);
		expect(granted.handled).toBe(true);
		expect(granted.output).toBe(`Sandbox grant approved (ro ${sibling}).`);
		expect(transitions).toBe(1);
		expect(authority.snapshot(actor).grants).toEqual([{ host: sibling, guest: sibling, mode: "ro" }]);
		expect(authority.snapshot(actor).requests.map(r => ({ host: r.host, mode: r.mode, status: r.status }))).toEqual([
			{ host: sibling, mode: "ro", status: "approved" },
		]);
		expect(appliedPolicy?.mounts.find(m => m.host === sibling)?.mode).toBe("ro");
	});
});

test.skipIf(process.platform !== "darwin")(
	"macOS Seatbelt with readOnlyRoots: [parentDir] allows reading siblingDir, denies writing siblingDir, and denies reading JEO_CONFIG_DIR",
	async () => {
		const root = await makeTempRoot("jeo-seatbelt-parent-");
		const parentDir = path.join(root, "parent");
		const workspace = path.join(parentDir, "workspace");
		const siblingDir = path.join(parentDir, "sibling");
		const privateConfigDir = path.join(root, "private-config");

		await Promise.all([
			fs.mkdir(workspace, { recursive: true }),
			fs.mkdir(siblingDir, { recursive: true }),
			fs.mkdir(privateConfigDir, { recursive: true }),
		]);
		await fs.writeFile(path.join(siblingDir, "file.txt"), "sibling-read-ok\n");
		await fs.writeFile(path.join(privateConfigDir, "secret.txt"), "PRIVATE-CONFIG-SECRET\n");

		const previousConfigDir = process.env.JEO_CONFIG_DIR;
		process.env.JEO_CONFIG_DIR = privateConfigDir;
		let supervisor: SandboxSupervisor | undefined;
		try {
			const policy = await createSandboxPolicy({
				sessionKey: "discord-seatbelt-read-perms",
				revision: 1,
				cwd: workspace,
				config: { backend: "native" },
			});
			supervisor = createSandboxSupervisor({ policy, readOnlyRoots: [parentDir] });

			const siblingRead = await supervisor.call("read", { filePath: path.join(siblingDir, "file.txt") }, { cwd: workspace });
			expect(siblingRead.success).toBe(true);
			expect(siblingRead.output).toContain("sibling-read-ok");

			const workspaceWrite = await supervisor.call(
				"write",
				{ filePath: path.join(workspace, "allowed.txt"), content: "workspace-ok\n" },
				{ cwd: workspace },
			);
			expect(workspaceWrite.success).toBe(true);
			expect(await fs.readFile(path.join(workspace, "allowed.txt"), "utf8")).toBe("workspace-ok\n");

			const forbiddenPath = path.join(siblingDir, "forbidden.txt");
			const siblingWrite = await supervisor.call("write", { filePath: forbiddenPath, content: "must-fail\n" }, { cwd: workspace });
			expect(siblingWrite.success).toBe(false);
			const siblingExecWrite = await supervisor.exec(["/bin/sh", "-c", `printf blocked > ${JSON.stringify(forbiddenPath)}`], { cwd: workspace });
			expect(siblingExecWrite.success).toBe(false);
			expect(await fs.stat(forbiddenPath).catch(() => undefined)).toBeUndefined();

			const secretPath = path.join(privateConfigDir, "secret.txt");
			const secretRead = await supervisor.call("read", { filePath: secretPath }, { cwd: workspace });
			expect(secretRead.success).toBe(false);
			expect(secretRead.output).not.toContain("PRIVATE-CONFIG-SECRET");
			const secretExecRead = await supervisor.exec(["/bin/cat", secretPath], { cwd: workspace });
			expect(secretExecRead.success).toBe(false);
			expect(secretExecRead.output).not.toContain("PRIVATE-CONFIG-SECRET");
		} finally {
			await supervisor?.close().catch(() => {});
			if (previousConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
			else process.env.JEO_CONFIG_DIR = previousConfigDir;
		}
	},
	30_000,
);
