import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMessengerCliReply } from "../src/commands/messenger";
import { parseMessengerConfig, DEFAULT_MESSENGER_TOOLS } from "../src/messenger/config";
import { createDiscordAdapter } from "../src/messenger/discord";
import type { MessengerConfig, MessengerMessage } from "../src/messenger/types";

const baseMessage: MessengerMessage = {
	platform: "discord",
	accountId: "bot",
	channelId: "channel-1",
	senderId: "user-1",
	messageId: "msg-1",
	text: "hello first",
	direct: false,
	mentioned: true,
};

test("messenger config defaults to sandbox tools and computer, with independent sessions enabled", () => {
	const parsed = parseMessengerConfig(
		{ platforms: { discord: { allowedUserIds: ["user-1"] } } },
		"/test-profile",
	);
	expect(parsed.toolNames).toEqual(DEFAULT_MESSENGER_TOOLS);
	expect(parsed.toolNames).toContain("computer");
	expect(parsed.toolNames).toContain("bash");
	expect(parsed.toolNames).toContain("read");
	expect(parsed.toolNames).toContain("write");
	expect(parsed.independentSessions).toBe(true);
});

test("independent sessions allocate separate workers and session files per invocation", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-independent-test-"));
	const config: MessengerConfig = {
		cwd: root,
		sessionDir: path.join(root, "sessions"),
		toolNames: ["read", "bash", "computer"],
		independentSessions: true,
		platforms: { discord: { tokenEnv: "JEO_DISCORD_BOT_TOKEN", allowedUserIds: ["user-1"] } },
	};

	const workers: { id: number; requests: string[]; env: Record<string, string> }[] = [];
	const spawn = ((argv: string[], options: { env: Record<string, string> }) => {
		const worker = { id: workers.length, requests: [] as string[], env: options.env };
		workers.push(worker);
		const exit = Promise.withResolvers<number>();
		let out: ReadableStreamDefaultController<Uint8Array>;
		let err: ReadableStreamDefaultController<Uint8Array>;
		const stdout = new ReadableStream<Uint8Array>({ start(c) { out = c; } });
		const stderr = new ReadableStream<Uint8Array>({ start(c) { err = c; } });
		const kill = () => { out.close(); err.close(); exit.resolve(0); };
		return {
			stdout, stderr, exited: exit.promise, kill,
			stdin: {
				write(chunk: string | Uint8Array) {
					const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
					for (const line of text.trim().split("\n")) {
						const prompt = JSON.parse(line);
						worker.requests.push(prompt);
						err.enqueue(new TextEncoder().encode("JEO_MESSENGER_ACTIVITY Reading workspace files\n"));
						out.enqueue(new TextEncoder().encode(`JEO_MESSENGER_RESULT ${JSON.stringify(`result for ${prompt}`)}\n`));
					}
					return text.length;
				},
				flush() {},
				end() { kill(); },
			},
		};
	}) as typeof Bun.spawn;

	const reply = createMessengerCliReply(config, spawn);
	try {
		const signal = new AbortController().signal;
		const activities: string[] = [];
		const onActivity = (text: string) => activities.push(text);

		const r1 = await reply(baseMessage, signal, onActivity);
		expect(r1).toBe("result for hello first");
		expect(activities).toContain("Reading workspace files");

		// A second invocation from the same user/channel but with a different messageId:
		const r2 = await reply({ ...baseMessage, messageId: "msg-2", text: "hello second" }, signal, onActivity);
		expect(r2).toBe("result for hello second");

		// Independent sessions must create independent workers!
		expect(workers).toHaveLength(2);
		expect(workers[0]!.requests).toEqual(["hello first"]);
		expect(workers[1]!.requests).toEqual(["hello second"]);
		expect(workers[0]!.env.JEO_MESSENGER_COMPUTER_ENABLED).toBe("1");
		expect(workers[1]!.env.JEO_MESSENGER_COMPUTER_ENABLED).toBe("1");

		// Session directory should have 2 distinct session files
		const files = await fs.readdir(config.sessionDir);
		expect(files.filter(f => f.endsWith(".jsonl"))).toHaveLength(2);
	} finally {
		await reply.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("Discord activity updates progress and marks complete on finish without deleting the message", async () => {
	const requests: { method: string; url: string; body?: unknown }[] = [];
	const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const urlStr = url.toString();
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(init.body as string) : undefined;
		requests.push({ method, url: urlStr, body });
		if (method === "POST") return Response.json({ id: "activity-msg-123" });
		return Response.json({ id: "activity-msg-123" });
	}) as typeof fetch;

	const adapter = createDiscordAdapter(
		{ tokenEnv: "JEO_DISCORD_BOT_TOKEN", allowedUserIds: ["user-1"] },
		{ JEO_DISCORD_BOT_TOKEN: "secret-token" },
		{ fetch: fakeFetch },
	);

	const signal = new AbortController().signal;
	await adapter.activity!(baseMessage, "Processing step 1", signal);
	expect(requests[0]!.method).toBe("POST");
	expect(requests[0]!.body).toMatchObject({ content: "⏳ Processing step 1" });

	await adapter.activity!(baseMessage, "Using computer tool", signal);
	expect(requests[1]!.method).toBe("PATCH");
	expect(requests[1]!.body).toMatchObject({ content: "⏳ Using computer tool" });

	// When completed (text === undefined)
	await adapter.activity!(baseMessage, undefined, signal);
	expect(requests[2]!.method).toBe("PATCH");
	expect(requests[2]!.body).toMatchObject({ content: "✅ Complete" });
	// Must NOT delete!
	expect(requests.some(r => r.method === "DELETE")).toBe(false);
});
