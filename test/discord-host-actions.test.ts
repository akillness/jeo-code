import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDiscordHostAuthority } from "../src/messenger/host-actions";
import { messengerConversationKey } from "../src/messenger/gateway";
import type { DiscordHostAction, DiscordRunRef, MessengerConfig, MessengerMessage } from "../src/messenger/types";

function message(text = "work", overrides: Partial<MessengerMessage> = {}): MessengerMessage {
	return { platform: "discord", accountId: "bot", guildId: "guild", channelId: "thread-a", parentChannelId: "channel", threadId: "thread-a", senderId: "owner", messageId: "work-1", text, direct: false, mentioned: false, ...overrides };
}

async function fixture(notifyFailure = false) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-host-authority-")));
	const effects = path.join(root, "effects.txt");
	await fs.writeFile(effects, "");
	const config: MessengerConfig = {
		cwd: root, sessionDir: path.join(root, "sessions"), toolNames: ["bash", "read", "write", "edit"],
		platforms: { discord: { tokenEnv: "DISCORD_TEST_TOKEN", workerMode: "host", allowedUserIds: ["owner", "collaborator"], allowedChannelIds: ["channel"] } },
	};
	const notices: Array<{ run: DiscordRunRef; text: string }> = [];
	const waiting: Array<(notice: { run: DiscordRunRef; text: string }) => void> = [];
	const authority = createDiscordHostAuthority(config, async (run, text) => {
		const notice = { run, text };
		const waiter = waiting.shift();
		if (waiter) waiter(notice); else notices.push(notice);
		if (notifyFailure) throw new Error("private notification transport is unavailable");
	});
	const origin = message();
	const run: DiscordRunRef = { conversationKey: messengerConversationKey(origin), sessionId: "session-a", generation: 1, runId: "run-a" };
	authority.bind(run, origin, root);
	const next = () => {
		const notice = notices.shift();
		return notice ? Promise.resolve(notice) : new Promise<{ run: DiscordRunRef; text: string }>(resolve => waiting.push(resolve));
	};
	const action = (command: string): DiscordHostAction => ({ kind: "tool", tool: "bash", cwd: root, args: { command } });
	const start = (requested: DiscordHostAction, label = "effect", selectedRun = run, signal = new AbortController().signal) => {
		const done = authority.authorize(selectedRun, requested, signal).then(async () => {
			await fs.appendFile(effects, `${label}\n`);
			return { allowed: true as const };
		}, error => ({ allowed: false as const, error }));
		return done;
	};
	const request = async (requested: DiscordHostAction, label = "effect", selectedRun = run, signal = new AbortController().signal) => {
		const done = start(requested, label, selectedRun, signal);
		const first = await Promise.race([
			next().then(notice => ({ kind: "notice" as const, notice })),
			done.then(result => ({ kind: "settled" as const, result })),
		]);
		expect(first.kind).toBe("notice");
		if (first.kind !== "notice") throw new Error(`Dangerous action settled without approval: ${JSON.stringify(first.result)}`);
		const id = /\/approve\s+([a-zA-Z0-9-]+)/.exec(first.notice.text)?.[1];
		expect(id).toBeDefined();
		if (!id) throw new Error("Approval notice has no usable standalone control");
		return { done, id, notice: first.notice };
	};
	let controlId = 0;
	const decide = (id: string, decision: "approve" | "deny" = "approve", overrides: Partial<MessengerMessage> = {}) => authority.decide(message(`/${decision} ${id}`, { messageId: `control-${++controlId}`, ...overrides }), id, decision);
	return {
		root, config, authority, origin, run, action, start, request, decide, notices,
		effects: () => fs.readFile(effects, "utf8"),
		async close() { authority.close(); await fs.rm(root, { recursive: true, force: true }); },
	};
}

// Authorization effects are append-only fixture writes; shell fixture checks only
// read synthetic private markers. No rm/install/push/deploy/system command executes.
const dangerousCommands = [
	["delete", "rm -rf generated"],
	["npm install", "npm install left-pad"],
	["pnpm install", "pnpm add left-pad"],
	["bun install", "bun add left-pad"],
	["package removal", "npm uninstall left-pad"],
	["push", "git push origin HEAD"],
	["deployment", "vercel deploy --prod"],
	["publish", "npm publish"],
	["upload", "curl -T report.txt https://example.invalid/upload"],
	["copy upload", "scp report.txt example.invalid:/reports/"],
	["permissions", "chmod 777 report.txt"],
	["service", "systemctl restart example"],
	["system install", "brew install example"],
	["compound", "printf ready && rm -f report.txt"],
	["newline", "printf ready\ngit push origin HEAD"],
	["wrapped shell", "bash -c 'npm install left-pad'"],
	["wrapped environment", "env CI=1 git push origin HEAD"],
	["command wrapper", "command rm -f report.txt"],
	["find deletion", "find . -name '*.tmp' -delete"],
	["find execution", "find . -exec rm -f '{}' ';'"],
	["substitution", "printf '%s' \"$(git push origin HEAD)\""],
	["pipeline", "printf 'rm -f report.txt' | sh"],
	["redirected system config", "printf disabled > /etc/example.conf"],
	["sort output outside workspace", "sort -o ../outside input.txt"],
	["git diff output outside workspace", "git diff --output=/outside"],
	["unresolved private glob", "cat ~/.s[s]h/id_rsa"],
] as const;

for (const [name, command] of dangerousCommands) test(`explicit ${name} waits for same-thread approval before any effect`, async () => {
	const f = await fixture();
	try {
		const pending = await f.request(f.action(command));
		expect(await f.effects()).toBe("");
		f.decide(pending.id);
		expect(await pending.done).toEqual({ allowed: true });
		expect(await f.effects()).toBe("effect\n");
	} finally { await f.close(); }
});

// CLI trust is intentional: project test/build scripts may themselves run arbitrary
// code. These classifications do not claim OS isolation or inspect script contents.
const ordinaryActions: Array<[string, (root: string) => DiscordHostAction]> = [
	["read", root => ({ kind: "tool", tool: "read", cwd: root, args: { path: path.join(root, "source.ts") } })],
	["edit", root => ({ kind: "tool", tool: "edit", cwd: root, args: { path: path.join(root, "source.ts"), oldText: "old", newText: "new" } })],
	["write", root => ({ kind: "tool", tool: "write", cwd: root, args: { path: path.join(root, "source.ts"), content: "export const answer = 42;" } })],
	["test script", root => ({ kind: "tool", tool: "bash", cwd: root, args: { command: "npm test" } })],
	["build script", root => ({ kind: "tool", tool: "bash", cwd: root, args: { command: "npm run build" } })],
	["bun test", root => ({ kind: "tool", tool: "bash", cwd: root, args: { command: "bun test test/unit.test.ts" } })],
	["shell workspace read", root => ({ kind: "tool", tool: "bash", cwd: root, args: { command: "cat effects.txt" } })],
];
for (const [name, action] of ordinaryActions) test(`${name} proceeds without a human decision under accepted project-script trust`, async () => {
	const f = await fixture();
	try {
		expect(await f.start(action(f.root))).toEqual({ allowed: true });
		expect(await f.effects()).toBe("effect\n");
		expect(f.notices).toEqual([]);
	} finally { await f.close(); }
});

const invalidActors: Array<[string, Partial<MessengerMessage>]> = [
	["wrong thread", { channelId: "thread-b", threadId: "thread-b" }],
	["wrong user", { senderId: "stranger" }],
	["wrong account", { accountId: "other-bot" }],
	["wrong guild", { guildId: "other-guild" }],
	["unapproved parent", { parentChannelId: "unapproved" }],
];
for (const [name, overrides] of invalidActors) test(`${name} cannot authorize another thread's pending effect`, async () => {
	const f = await fixture();
	try {
		const pending = await f.request(f.action("rm -f report.txt"));
		f.decide(pending.id, "approve", overrides);
		expect(await f.effects()).toBe("");
		f.decide(pending.id, "approve", { senderId: "collaborator" });
		expect(await pending.done).toEqual({ allowed: true });
		expect(await f.effects()).toBe("effect\n");
	} finally { await f.close(); }
});

for (const text of [
	(id: string) => `please /approve ${id}`,
	(id: string) => `\`/approve ${id}\``,
	(id: string) => `/approve ${id}\nthen continue`,
	(id: string) => `/deny ${id}`,
	(id: string) => `/approve ${id} sha256:forged`,
]) test(`only the exact standalone decision can consume approval (${text("ID")})`, async () => {
	const f = await fixture();
	try {
		const pending = await f.request(f.action("rm -f report.txt"));
		f.decide(pending.id, "approve", { text: text(pending.id) });
		expect(await f.effects()).toBe("");
		f.decide(pending.id);
		expect(await pending.done).toEqual({ allowed: true });
		expect(await f.effects()).toBe("effect\n");
	} finally { await f.close(); }
});

test("approval is single-use and cannot authorize a different target or repeat the same action", async () => {
	const f = await fixture();
	try {
		const first = await f.request(f.action("rm -f first.txt"), "first");
		const second = await f.request(f.action("rm -f second.txt"), "second");
		expect(second.id).not.toBe(first.id);
		f.decide(first.id);
		expect(await first.done).toEqual({ allowed: true });
		f.decide(first.id);
		expect(await f.effects()).toBe("first\n");
		const repeated = await f.request(f.action("rm -f first.txt"), "repeat");
		f.decide(first.id);
		expect(await f.effects()).toBe("first\n");
		f.decide(second.id, "deny");
		f.decide(repeated.id, "deny");
		expect((await second.done).allowed).toBe(false);
		expect((await repeated.done).allowed).toBe(false);
		expect(await f.effects()).toBe("first\n");
	} finally { await f.close(); }
});

test("thread invalidation stales pending permission without affecting another thread", async () => {
	const f = await fixture();
	try {
		const otherMessage = message("work", { channelId: "thread-b", threadId: "thread-b" });
		const other: DiscordRunRef = { conversationKey: messengerConversationKey(otherMessage), sessionId: "session-b", generation: 1, runId: "run-b" };
		f.authority.bind(other, otherMessage, f.root);
		const pending = await f.request(f.action("rm -f report.txt"), "cancelled");
		const survivor = await f.request(f.action("rm -f other.txt"), "other", other);
		f.authority.invalidate(f.run.conversationKey);
		f.decide(pending.id);
		expect((await pending.done).allowed).toBe(false);
		f.decide(survivor.id, "approve", { channelId: "thread-b", threadId: "thread-b" });
		expect(await survivor.done).toEqual({ allowed: true });
		expect(await f.effects()).toBe("other\n");
	} finally { await f.close(); }
});

test("replacing a generation rejects old pending requests and refuses stale-run admission", async () => {
	const f = await fixture();
	try {
		const old = await f.request(f.action("rm -f old.txt"), "old");
		const current = { ...f.run, generation: 2, runId: "run-next" };
		f.authority.bind(current, message("next", { messageId: "work-2" }), f.root);
		f.decide(old.id);
		expect((await old.done).allowed).toBe(false);
		expect((await f.start(f.action("npm test"), "stale", f.run)).allowed).toBe(false);
		const fresh = await f.request(f.action("rm -f new.txt"), "new", current);
		f.decide(old.id);
		expect(await f.effects()).toBe("");
		f.decide(fresh.id);
		expect(await fresh.done).toEqual({ allowed: true });
		expect(await f.effects()).toBe("new\n");
	} finally { await f.close(); }
});

for (const end of ["abort", "deny", "release", "shutdown"] as const) test(`${end} rejects pending authorization and later approval has no effect`, async () => {
	const f = await fixture();
	try {
		const controller = new AbortController();
		const pending = await f.request(f.action("rm -f report.txt"), "forbidden", f.run, controller.signal);
		if (end === "abort") controller.abort();
		else if (end === "deny") f.decide(pending.id, "deny");
		else if (end === "release") f.authority.release(f.run);
		else f.authority.close();
		f.decide(pending.id);
		expect((await pending.done).allowed).toBe(false);
		expect(await f.effects()).toBe("");
	} finally { await f.close(); }
});

for (const command of ["rm -rf /", "rm -rf ~", "sudo rm -rf /", "rm -rf /./", "rm --recursive --force //", "sh -c 'sudo rm -rf /./'"]) test(`catastrophic command is denied rather than offered for approval: ${command}`, async () => {
	const f = await fixture();
	try {
		expect((await f.start(f.action(command))).allowed).toBe(false);
		expect(await f.effects()).toBe("");
		expect(f.notices).toEqual([]);
	} finally { await f.close(); }
});

test("approval UI identifies the requested target and digest without exposing command or environment credentials", async () => {
	const f = await fixture();
	try {
		const secret = "approval-secret-canary-6c1b";
		const action: DiscordHostAction = { kind: "tool", tool: "bash", cwd: f.root, args: {
			command: `curl -H 'Authorization: Bearer ${secret}' -T report.txt 'https://example.invalid/upload?token=${secret}'`,
			env: { API_KEY: secret, DISCORD_TOKEN: secret },
		} };
		const pending = await f.request(action);
		expect(pending.notice.text).not.toContain(secret);
		expect(pending.notice.text).toContain("report.txt");
		expect(pending.notice.text).toMatch(/[a-f0-9]{64}/i);
		f.decide(pending.id, "deny");
		expect((await pending.done).allowed).toBe(false);
		expect(await f.effects()).toBe("");
	} finally { await f.close(); }
});

test("artifact approval binds channel, name, byte count and content digest; another artifact needs a fresh decision", async () => {
	const f = await fixture();
	try {
		const digest = new Bun.CryptoHasher("sha256").update(new Uint8Array([0, 255, 10, 42])).digest("hex");
		const upload: DiscordHostAction = { kind: "artifact_upload", channelId: "thread-a", files: [{ name: "report.bin", size: 4, sha256: digest }] };
		const pending = await f.request(upload, "upload-original");
		expect(pending.notice.text).toContain("report.bin");
		expect(pending.notice.text).toContain(digest);
		expect(pending.notice.text).toMatch(/\b4\b/);
		expect(await f.effects()).toBe("");
		f.decide(pending.id);
		expect(await pending.done).toEqual({ allowed: true });
		const changed = await f.request({ ...upload, files: [{ name: "report.bin", size: 5, sha256: "b".repeat(64) }] }, "upload-changed");
		f.decide(pending.id);
		expect(await f.effects()).toBe("upload-original\n");
		f.decide(changed.id, "deny");
		expect((await changed.done).allowed).toBe(false);
		expect(await f.effects()).toBe("upload-original\n");
	} finally { await f.close(); }
});

test("artifact requested for another channel is denied before notification or upload", async () => {
	const f = await fixture();
	try {
		const upload: DiscordHostAction = { kind: "artifact_upload", channelId: "thread-b", files: [{ name: "private.bin", size: 4, sha256: "a".repeat(64) }] };
		expect((await f.start(upload, "leak")).allowed).toBe(false);
		expect(await f.effects()).toBe("");
		expect(f.notices).toEqual([]);
	} finally { await f.close(); }
});

const changedToolActions: Array<[string, (action: Extract<DiscordHostAction, { kind: "tool" }>, root: string) => void]> = [
	["tool", action => { action.tool = "delete"; }],
	["command", action => { action.args = { command: "rm -f substituted.txt" }; }],
	["environment", action => { action.args = { ...action.args, env: { PATH: "/untrusted/bin" } }; }],
	["cwd", (action, root) => { action.cwd = path.join(root, "replacement"); }],
];
for (const [field, mutate] of changedToolActions) test(`approval for the original digest cannot execute after its ${field} changes`, async () => {
	const f = await fixture();
	try {
		const action: Extract<DiscordHostAction, { kind: "tool" }> = { kind: "tool", tool: "bash", cwd: f.root, args: { command: "rm -f original.txt" } };
		const pending = await f.request(action, "substituted");
		mutate(action, f.root);
		f.decide(pending.id);
		expect((await pending.done).allowed).toBe(false);
		expect(await f.effects()).toBe("");
	} finally { await f.close(); }
});

for (const field of ["name", "size", "sha256", "channelId"] as const) test(`artifact approval rejects changed ${field} instead of uploading substituted bytes`, async () => {
	const f = await fixture();
	try {
		const file = { name: "report.bin", size: 4, sha256: "a".repeat(64) };
		const action: Extract<DiscordHostAction, { kind: "artifact_upload" }> = { kind: "artifact_upload", channelId: "thread-a", files: [file] };
		const pending = await f.request(action, "substituted upload");
		if (field === "name") file.name = "secret.bin";
		else if (field === "size") file.size = 5;
		else if (field === "sha256") file.sha256 = "b".repeat(64);
		else action.channelId = "thread-b";
		f.decide(pending.id);
		expect((await pending.done).allowed).toBe(false);
		expect(await f.effects()).toBe("");
	} finally { await f.close(); }
});

test("failed approval delivery cannot authorize or leave an actionable permission", async () => {
	const f = await fixture(true);
	try {
		expect((await f.start(f.action("rm -f report.txt"))).allowed).toBe(false);
		const id = /\/approve\s+([a-zA-Z0-9-]+)/.exec(f.notices[0]!.text)![1]!;
		f.decide(id);
		expect(await f.effects()).toBe("");
	} finally { await f.close(); }
});

test("a restarted authority cannot revive a pre-restart approval ID", async () => {
	const first = await fixture();
	const replacement = await fixture();
	try {
		const old = await first.request(first.action("rm -f report.txt"));
		first.authority.close();
		expect((await old.done).allowed).toBe(false);
		const fresh = await replacement.request(replacement.action("rm -f report.txt"));
		replacement.decide(old.id);
		expect(await replacement.effects()).toBe("");
		replacement.decide(fresh.id);
		expect(await fresh.done).toEqual({ allowed: true });
		expect(await replacement.effects()).toBe("effect\n");
		expect(await first.effects()).toBe("");
	} finally { await first.close(); await replacement.close(); }
});

test("one Discord decision message cannot be reused to approve a later request", async () => {
	const f = await fixture();
	try {
		const first = await f.request(f.action("rm -f first.txt"), "first");
		f.decide(first.id, "approve", { messageId: "one-authenticated-decision" });
		expect(await first.done).toEqual({ allowed: true });
		const second = await f.request(f.action("rm -f second.txt"), "second");
		f.decide(second.id, "approve", { messageId: "one-authenticated-decision" });
		expect(await f.effects()).toBe("first\n");
		f.decide(second.id);
		expect(await second.done).toEqual({ allowed: true });
		expect(await f.effects()).toBe("first\nsecond\n");
	} finally { await f.close(); }
});

for (const tool of ["write", "delete"] as const) test(`${tool} outside the bound worktree cannot proceed on an ordinary edit permission`, async () => {
	const f = await fixture();
	try {
		const action: DiscordHostAction = { kind: "tool", tool, cwd: f.root, args: { path: "/etc/example.conf", content: "changed" } };
		const pending = await f.request(action);
		expect(await f.effects()).toBe("");
		f.decide(pending.id, "deny");
		expect((await pending.done).allowed).toBe(false);
		expect(await f.effects()).toBe("");
	} finally { await f.close(); }
});

test("private messenger session files cannot be read even by an approved Discord actor", async () => {
	const f = await fixture();
	try {
		const action: DiscordHostAction = { kind: "tool", tool: "read", cwd: f.root, args: { path: path.join(f.config.sessionDir, "private.json") } };
		expect((await f.start(action)).allowed).toBe(false);
		expect(await f.effects()).toBe("");
		expect(f.notices).toEqual([]);
	} finally { await f.close(); }
});

for (const alias of ["relative", "symlink"] as const) test(`shell reads cannot bypass private session denial through a ${alias} path`, async () => {
	const f = await fixture();
	try {
		await fs.mkdir(f.config.sessionDir);
		const privateFile = path.join(f.config.sessionDir, "private-fixture.json");
		await fs.writeFile(privateFile, "private fixture, not a real credential\n");
		const link = path.join(f.root, "innocent.txt");
		await fs.symlink(privateFile, link);
		const operand = alias === "relative" ? "sessions/private-fixture.json" : "innocent.txt";
		expect((await f.start(f.action(`cat ${operand}`))).allowed).toBe(false);
		expect(await f.effects()).toBe("");
		expect(f.notices).toEqual([]);
		expect(await fs.readFile(privateFile, "utf8")).toBe("private fixture, not a real credential\n");
	} finally { await f.close(); }
});

test("a dangling symlink cannot redirect an ordinary write into private session storage", async () => {
	const f = await fixture();
	try {
		await fs.mkdir(f.config.sessionDir);
		const link = path.join(f.root, "new-report.txt");
		await fs.symlink(path.join(f.config.sessionDir, "not-created.json"), link);
		const action: DiscordHostAction = { kind: "tool", tool: "write", cwd: f.root, args: { path: link, content: "changed" } };
		expect((await f.start(action)).allowed).toBe(false);
		expect(await f.effects()).toBe("");
		expect(f.notices).toEqual([]);
	} finally { await f.close(); }
});

for (const [name, command] of [
	["clustered sort output option", "sort -no../outside input"],
	["recursive symlink-following grep", "grep -RS . ."],
	["symlink-following ripgrep", "rg --follow . ."],
	["piped cwd change", "cd sub | cat ../sessions/private.json"],
	["failed cwd change", "cd absent || cat ../sessions/private.json"],
	["Maven attached project option", "mvn test -f.."],
	["pytest attached config option", "pytest -cbridge.ini"],
] as const) test(`${name} cannot borrow read-only auto-authorization`, async () => {
	const f = await fixture();
	try {
		const pending = await f.request(f.action(command), "escaped read");
		expect(await f.effects()).toBe("");
		f.decide(pending.id, "deny");
		expect((await pending.done).allowed).toBe(false);
		expect(await f.effects()).toBe("");
	} finally { await f.close(); }
});

for (const [name, alias, command] of [
	["option terminator", "-n", "cat -- -n"],
	["literal backslash inside double quotes", "foo\\bar", 'cat "foo\\bar"'],
] as const) test(`private-file denial follows shell ${name} semantics`, async () => {
	const f = await fixture();
	try {
		await fs.mkdir(f.config.sessionDir);
		const target = path.join(f.config.sessionDir, "private-fixture.txt");
		await fs.writeFile(target, "private fixture, not a credential\n");
		await fs.symlink(target, path.join(f.root, alias));
		// Prove the same POSIX shell bytes actually reach the synthetic private
		// target, including a literal backslash inside double quotes on Linux.
		const shell = Bun.spawn(["/bin/sh", "-c", command], { cwd: f.root, stdout: "pipe", stderr: "pipe" });
		const [exitCode, stdout, stderr] = await Promise.all([shell.exited, new Response(shell.stdout).text(), new Response(shell.stderr).text()]);
		expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "private fixture, not a credential\n", stderr: "" });
		expect((await f.start(f.action(command), "private read")).allowed).toBe(false);
		expect(await f.effects()).toBe("");
		expect(f.notices).toEqual([]);
	} finally { await f.close(); }
});

for (const executable of ["grep", "rg"] as const) test(`${executable} attached pattern-file flag cannot automatically read a private symlink`, async () => {
	const f = await fixture();
	try {
		await fs.mkdir(f.config.sessionDir);
		const target = path.join(f.config.sessionDir, "private-pattern.txt");
		await fs.writeFile(target, "private fixture, not a credential\n");
		await fs.symlink(target, path.join(f.root, "foo"));
		await fs.writeFile(path.join(f.root, "input.txt"), "ordinary project input\n");
		const pending = await f.request(f.action(`${executable} -ffoo input.txt`), "pattern-file read");
		expect(await f.effects()).toBe("");
		f.decide(pending.id, "deny");
		expect((await pending.done).allowed).toBe(false);
		expect(await f.effects()).toBe("");
	} finally { await f.close(); }
});

test("directory diff cannot automatically discover and follow a private-file symlink", async () => {
	const f = await fixture();
	try {
		await fs.mkdir(f.config.sessionDir);
		await fs.mkdir(path.join(f.root, "left"));
		await fs.mkdir(path.join(f.root, "right"));
		const target = path.join(f.config.sessionDir, "private-diff.txt");
		await fs.writeFile(target, "private fixture, not a credential\n");
		await fs.symlink(target, path.join(f.root, "left", "report.txt"));
		await fs.writeFile(path.join(f.root, "right", "report.txt"), "ordinary project input\n");
		const pending = await f.request(f.action("diff left right"), "directory discovery");
		expect(await f.effects()).toBe("");
		f.decide(pending.id, "deny");
		expect((await pending.done).allowed).toBe(false);
		expect(await f.effects()).toBe("");
	} finally { await f.close(); }
});

test("private session cwd is hard-denied even when the shell command has no file operands", async () => {
	const f = await fixture();
	try {
		await fs.mkdir(f.config.sessionDir);
		const action: DiscordHostAction = { kind: "tool", tool: "bash", cwd: f.config.sessionDir, args: { command: "pwd" } };
		expect((await f.start(action, "private cwd")).allowed).toBe(false);
		expect(await f.effects()).toBe("");
		expect(f.notices).toEqual([]);
	} finally { await f.close(); }
});
