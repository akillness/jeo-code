import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMessengerCliReply } from "../src/commands/messenger";
import { parseMessengerConfig } from "../src/messenger/config";
import { createMessengerGateway } from "../src/messenger/gateway";
import { createMessengerSessionPool } from "../src/messenger/session-pool";
import type { MessengerConfig, MessengerMessage } from "../src/messenger/types";

const message: MessengerMessage = { platform: "discord", accountId: "bot", channelId: "channel", senderId: "owner", messageId: "1", text: "hello", direct: true, mentioned: false };

interface Launch { argv: string[]; sandbox: string | undefined; sessionKey: string | undefined }

/** A spawn that records how a worker would be launched, then stops before any process exists. */
function recordingSpawn(launches: Launch[]): typeof Bun.spawn {
  const record = (argv: string[], options: { env: Record<string, string> }): never => {
    launches.push({ argv, sandbox: options.env.JEO_MESSENGER_SANDBOX, sessionKey: options.env.JEO_MESSENGER_SESSION_KEY });
    throw new Error("fixture launch stopped");
  };
  return record as unknown as typeof Bun.spawn;
}

async function workspaceRoot(label: string): Promise<{ root: string; workspace: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `jeo-discord-${label}-`));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  return { root, workspace };
}

for (const sandbox of [undefined, { backend: "native" as const }]) {
  test(`Discord with ${sandbox ? "an explicit" : "no"} sandbox block runs its worker in the native sandbox, no Docker`, async () => {
    const { root, workspace } = await workspaceRoot("native-default");
    const config: MessengerConfig = { cwd: workspace, sessionDir: path.join(root, "sessions"), sandbox, toolNames: [], platforms: { discord: { tokenEnv: "TOKEN", allowedUserIds: ["owner"] } } };
    const launches: Launch[] = [];
    const reply = createMessengerCliReply(config, recordingSpawn(launches), async () => "fixture-model");
    try {
      await expect(reply(message, new AbortController().signal)).rejects.toThrow("fixture launch stopped");
      expect(launches).toHaveLength(1);
      expect(JSON.parse(launches[0]!.sandbox!)).toEqual({ backend: "native" });
      // The worker follows the globally installed skill catalog instead of running with none.
      expect(launches[0]!.argv).not.toContain("--no-skills");
      expect(launches[0]!.argv).toContain("--literal-worker");
    } finally {
      await reply.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test("every Discord conversation gets its own worker session and its own sandbox key", async () => {
  const { root, workspace } = await workspaceRoot("independent");
  const config: MessengerConfig = { cwd: workspace, sessionDir: path.join(root, "sessions"), toolNames: [], platforms: { discord: { tokenEnv: "TOKEN", allowedUserIds: ["owner"] } } };
  const launches: Launch[] = [];
  const reply = createMessengerCliReply(config, recordingSpawn(launches), async () => "fixture-model");
  const thread = (id: string): MessengerMessage => ({ ...message, direct: false, mentioned: true, channelId: id, threadId: id, parentChannelId: "channel", guildId: "guild" });
  try {
    for (const conversation of [thread("t1"), thread("t2"), thread("t1")]) {
      await expect(reply(conversation, new AbortController().signal)).rejects.toThrow("fixture launch stopped");
    }
    const keys = launches.map(launch => launch.sessionKey);
    expect(keys.every(key => typeof key === "string" && key.length > 0)).toBe(true);
    expect(keys[0]).not.toBe(keys[1]);
    // The same thread routes to the same session; a different thread never shares one.
    expect(keys[2]).toBe(keys[0]);
    const resumeIds = launches.map(launch => String(launch.argv[launch.argv.indexOf("--resume") + 1]));
    expect(resumeIds).toEqual(keys.map(String));
  } finally {
    await reply.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Discord Docker configuration reaches worker launch with sandbox configuration intact", async () => {
  const { root, workspace } = await workspaceRoot("docker-path");
  const sandbox = { backend: "docker" as const, image: "local-fixture", limits: { memoryBytes: 268435456, pids: 64, cpus: 1 } };
  const config: MessengerConfig = { cwd: workspace, sessionDir: path.join(root, "sessions"), sandbox, toolNames: [], platforms: { discord: { tokenEnv: "TOKEN", allowedUserIds: ["owner"] } } };
  const launches: Launch[] = [];
  const reply = createMessengerCliReply(config, recordingSpawn(launches), async () => "fixture-model");
  try {
    await expect(reply(message, new AbortController().signal)).rejects.toThrow();
    expect(JSON.parse(launches[0]!.sandbox!)).toEqual({ image: sandbox.image, limits: sandbox.limits });
  } finally {
    await reply.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Discord's native default is not imposed on Telegram or Slack", async () => {
  const { root, workspace } = await workspaceRoot("mixed");
  const config = parseMessengerConfig({ cwd: workspace, sessionDir: path.join(root, "sessions"), toolNames: [], platforms: {
    discord: { tokenEnv: "DISCORD_TOKEN", allowedUserIds: ["owner"] },
    telegram: { tokenEnv: "TELEGRAM_TOKEN", allowedUserIds: ["owner"] },
    slack: { tokenEnv: "SLACK_TOKEN", allowedUserIds: ["owner"] },
  } }, root);
  const launches: Launch[] = [];
  const reply = createMessengerCliReply(config, recordingSpawn(launches), async () => "fixture-model");
  try {
    await expect(reply(message, new AbortController().signal)).rejects.toThrow("fixture launch stopped");
    for (const platform of ["telegram", "slack"] as const) {
      await expect(reply({ ...message, platform, accountId: platform }, new AbortController().signal)).rejects.toThrow();
    }
    expect(launches.map(launch => launch.sandbox === undefined ? undefined : JSON.parse(launch.sandbox))).toEqual([{ backend: "native" }, undefined, undefined]);
  } finally {
    await reply.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a malformed sandbox block fails closed before any worker starts", () => {
  expect(() => parseMessengerConfig({ cwd: "/tmp", sessionDir: "/tmp/sessions", toolNames: [], sandbox: { backend: "native", image: "extra" }, platforms: { discord: { tokenEnv: "T", allowedUserIds: ["owner"] } } }, "/tmp")).toThrow();
});

test("a /sandbox control still requires an allowed Discord operator", async () => {
  const { root, workspace } = await workspaceRoot("control");
  const config = parseMessengerConfig({ cwd: workspace, sessionDir: path.join(root, "sessions"), toolNames: [], platforms: { discord: { allowedUserIds: ["owner"] } } }, root);
  const launches: Launch[] = [];
  const reply = createMessengerCliReply(config, recordingSpawn(launches), async () => "fixture-model");
  const sent: string[] = [];
  const gateway = createMessengerGateway(config, [{ platform: "discord", start: async () => {}, send: async (_message, text) => { sent.push(text); } }], reply, { sandboxControl: reply.sandboxControl });
  try {
    // An unlisted sender never reaches the control path or a worker.
    await gateway.handle({ ...message, senderId: "stranger", messageId: "2", text: "/sandbox status" });
    expect(sent).toEqual([]);
    expect(launches).toEqual([]);
    // The listed operator gets a real answer from the control path, not a blanket refusal of native sandboxes.
    await gateway.handle({ ...message, messageId: "3", text: "/sandbox status" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain("disabled pending verified isolation");
    expect(launches).toEqual([]);
  } finally {
    await reply.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

/** A worker whose process the test controls: it can crash without ever acknowledging shutdown. */
function fakeWorker() {
  const exited = Promise.withResolvers<number>();
  let stdout!: ReadableStreamDefaultController<Uint8Array>;
  let stderr!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const frames: unknown[] = [];
  let alive = true;
  const finish = (code: number): void => {
    if (!alive) return;
    alive = false;
    stdout.close();
    stderr.close();
    exited.resolve(code);
  };
  return {
    frames,
    reply(text: string): void { stdout.enqueue(encoder.encode(`JEO_MESSENGER_RESULT ${JSON.stringify(text)}\n`)); },
    crash(): void { finish(137); },
    child: {
      stdout: new ReadableStream<Uint8Array>({ start(controller) { stdout = controller; } }),
      stderr: new ReadableStream<Uint8Array>({ start(controller) { stderr = controller; } }),
      exited: exited.promise,
      stdin: { write() { return true; }, flush() {}, end() {} },
      kill() { finish(143); },
      send(frame: unknown) { frames.push(frame); return true; },
    },
  };
}

for (const reaped of [true, false]) {
  test(`a worker that crashes without acknowledging ${reaped ? "is cleaned up once its orphaned sandbox processes are reaped" : "stays unverified when the reap is incomplete"}`, async () => {
    const worker = fakeWorker();
    const reaps: Array<Readonly<Record<string, string>>> = [];
    const spawn = (() => worker.child) as unknown as typeof Bun.spawn;
    const pool = createMessengerSessionPool(spawn, 2, 60_000, 200, {
      requireSandboxCleanup: true,
      reapOrphans: async env => { reaps.push(env); return reaped; },
    });
    const env = { JEO_MESSENGER_SANDBOX: JSON.stringify({ backend: "native" }) };
    const turn = pool.turn("conversation", ["worker"], "/tmp", env, "hi", new AbortController().signal);
    worker.reply("done");
    expect(await turn).toBe("done");
    worker.crash();
    if (reaped) {
      expect(await pool.close()).toBeUndefined();
      expect(reaps).toHaveLength(1);
      expect(reaps[0]!.JEO_MESSENGER_SANDBOX).toBe(env.JEO_MESSENGER_SANDBOX);
    } else {
      await expect(pool.close()).rejects.toThrow("REVOKE_INCOMPLETE");
      expect(reaps).toHaveLength(1);
    }
  });
}
