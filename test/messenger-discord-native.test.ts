import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMessengerCliReply } from "../src/commands/messenger";
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

test("Discord runs its worker directly on the host without imposing a sandbox", async () => {
  const { root, workspace } = await workspaceRoot("host-default");
  const config: MessengerConfig = { cwd: workspace, sessionDir: path.join(root, "sessions"), toolNames: [], platforms: { discord: { tokenEnv: "TOKEN", allowedUserIds: ["owner"] } } };
  const launches: Launch[] = [];
  const reply = createMessengerCliReply(config, recordingSpawn(launches), async () => "fixture-model");
  try {
    await expect(reply(message, new AbortController().signal)).rejects.toThrow("fixture launch stopped");
    expect(launches).toHaveLength(1);
    expect(launches[0]!.sandbox).toBeUndefined();
    expect(launches[0]!.argv).not.toContain("--no-skills");
    expect(launches[0]!.argv).toContain("--literal-worker");
    expect(launches[0]!.argv).toContain("--no-tools");
  } finally {
    await reply.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("every Discord conversation gets its own deterministic session resume ID", async () => {
  const { root, workspace } = await workspaceRoot("independent");
  const config: MessengerConfig = { cwd: workspace, sessionDir: path.join(root, "sessions"), toolNames: [], platforms: { discord: { tokenEnv: "TOKEN", allowedUserIds: ["owner"] } } };
  const launches: Launch[] = [];
  const reply = createMessengerCliReply(config, recordingSpawn(launches), async () => "fixture-model");
  const thread = (id: string): MessengerMessage => ({ ...message, direct: false, mentioned: true, channelId: id, threadId: id, parentChannelId: "channel", guildId: "guild" });
  try {
    for (const conversation of [thread("t1"), thread("t2"), thread("t1")]) {
      await expect(reply(conversation, new AbortController().signal)).rejects.toThrow("fixture launch stopped");
    }
    const resumeIds = launches.map(launch => String(launch.argv[launch.argv.indexOf("--resume") + 1]));
    expect(resumeIds.every(id => typeof id === "string" && id.length > 0)).toBe(true);
    expect(resumeIds[0]).not.toBe(resumeIds[1]);
    expect(resumeIds[2]).toBe(resumeIds[0]);
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
