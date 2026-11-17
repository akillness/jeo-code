import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAgentLoop } from "../src/agent/engine";
import * as loop from "../src/agent/loop";
import { readTool } from "../src/agent/tools";
import { distillInvocation, spawnDetachedDistill } from "../src/agent/memory";
import { buildToolProtocol } from "../src/commands/launch/flags";
import { createDiscordHostAuthority } from "../src/messenger/host-actions";
import { messengerConversationKey } from "../src/messenger/gateway";
import { summarizeForgeInvocation } from "../src/tui/components/forge";
import { isBrokenPipeError } from "../src/util/broken-pipe";
import type { MessengerConfig, MessengerMessage } from "../src/messenger/types";

test("launch.ts KNOWN_TOOLS includes jeox, buildToolProtocol advertises jeox, and forge renders jeox cards", async () => {
  const src = await Bun.file(path.join(import.meta.dir, "..", "src", "commands", "launch.ts")).text();
  const m = /const KNOWN_TOOLS = new Set\(\[([^\]]+)\]\);/.exec(src);
  expect(m).toBeTruthy();
  expect(m![1]).toContain('"jeox"');

  const proto = buildToolProtocol(new Set(["read", "search", "jeox"]));
  expect(proto).toContain("jeox {action");
  expect(proto).toContain("prefer jeox");

  const card = summarizeForgeInvocation("jeox", { action: "who-calls", name: "openDb" });
  expect(card.title).toBe("Jeox: who-calls openDb");
  expect(card.lines).toEqual(["action: who-calls", "target: openDb"]);
});

test("Discord host authority allows read-only jeox within workspace without approval, blocks privateRoots", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jeo-host-jeox-")));
  try {
    const config: MessengerConfig = {
      cwd: root,
      sessionDir: path.join(root, "sessions"),
      toolNames: ["read", "jeox"],
      platforms: {
        discord: {
          tokenEnv: "DISCORD_TEST_TOKEN",
          workerMode: "host",
          allowedUserIds: ["owner"],
          allowedChannelIds: ["channel"],
        },
      },
    };
    const notices: string[] = [];
    const authority = createDiscordHostAuthority(config, async (_run, text) => { notices.push(text); });
    const msg: MessengerMessage = {
      platform: "discord",
      accountId: "bot",
      guildId: "guild",
      channelId: "thread-1",
      parentChannelId: "channel",
      threadId: "thread-1",
      senderId: "owner",
      messageId: "m-1",
      text: "check",
      direct: false,
      mentioned: false,
    };
    const run = {
      conversationKey: messengerConversationKey(msg),
      sessionId: "sess-1",
      generation: 1,
      runId: "run-1",
    };
    authority.bind(run, msg, root);
    const ac = new AbortController();
    await authority.authorize(run, { kind: "tool", tool: "jeox", cwd: root, args: { action: "search", query: "openDb" } }, ac.signal);
    expect(notices.length).toBe(0);

    await expect(
      authority.authorize(run, { kind: "tool", tool: "jeox", cwd: path.join(root, "sessions"), args: { action: "status" } }, ac.signal),
    ).rejects.toThrow("Private host configuration");
    authority.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readTool fails fast on FIFO/named pipes, binary NUL files, and files exceeding JEO_MAX_READ_BYTES", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeo-read-guard-"));
  const prevMax = process.env.JEO_MAX_READ_BYTES;
  try {
    // 1. Binary NUL rejection
    const binPath = path.join(dir, "blob.bin");
    fs.writeFileSync(binPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
    const binRes = await readTool(binPath, undefined, dir);
    expect(binRes.success).toBe(false);
    expect(binRes.error).toContain("Binary file");

    // 2. Oversize rejection
    process.env.JEO_MAX_READ_BYTES = "1048576";
    const bigPath = path.join(dir, "huge.txt");
    fs.writeFileSync(bigPath, Buffer.alloc(1_150_000, 0x61));
    const bigRes = await readTool(bigPath, undefined, dir);
    expect(bigRes.success).toBe(false);
    expect(bigRes.error).toContain("too large");

    // 3. FIFO named pipe non-blocking rejection (Unix)
    if (process.platform !== "win32" && Bun.which("mkfifo")) {
      const fifoPath = path.join(dir, "hang.fifo");
      const mk = Bun.spawnSync(["mkfifo", fifoPath]);
      if (mk.exitCode === 0) {
        const started = Date.now();
        const fifoRes = await readTool(fifoPath, undefined, dir);
        expect(Date.now() - started).toBeLessThan(1000);
        expect(fifoRes.success).toBe(false);
        expect(fifoRes.error).toContain("non-regular file");
      }
    }
  } finally {
    if (prevMax === undefined) delete process.env.JEO_MAX_READ_BYTES;
    else process.env.JEO_MAX_READ_BYTES = prevMax;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runAgentLoop per-tool watchdog aborts a hung tool so the loop recovers instead of freezing", async () => {
  const prev = process.env.JEO_TOOL_TIMEOUT_MS;
  process.env.JEO_TOOL_TIMEOUT_MS = "80";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeo-watchdog-"));
  fs.mkdirSync(path.join(dir, ".jeo"));
  fs.writeFileSync(path.join(dir, ".jeo", "hooks.json"), JSON.stringify({ enabled: false }));
  let calls = 0;
  let toolSignalAborted = false;
  const llm = spyOn(loop, "callLlm").mockImplementation(async () => {
    calls++;
    if (calls === 1) return JSON.stringify({ tool: "search", arguments: { pattern: "never" } });
    return JSON.stringify({ tool: "done", arguments: { reason: "Recovered after tool timeout." } });
  });
  try {
    const seenToolResults: Array<{ tool: string; success: boolean; output: string }> = [];
    const res = await runAgentLoop(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "run the slow check" },
      ],
      {
        cwd: dir,
        maxSteps: 4,
        tools: {
          search: (_args, _cwd, _onProgress, signal) => {
            signal?.addEventListener("abort", () => { toolSignalAborted = true; }, { once: true });
            return new Promise(() => {});
          },
        },
        events: {
          onToolResult: (tool, success, output) => { seenToolResults.push({ tool, success, output }); },
        },
      },
    );
    expect(res.done).toBe(true);
    expect(res.doneReason).toContain("Recovered after tool timeout.");
    expect(toolSignalAborted).toBe(true);
    expect(seenToolResults.length).toBe(1);
    expect(seenToolResults[0]!.success).toBe(false);
    expect(seenToolResults[0]!.output).toContain("timed out");
  } finally {
    llm.mockRestore();
    if (prev === undefined) delete process.env.JEO_TOOL_TIMEOUT_MS;
    else process.env.JEO_TOOL_TIMEOUT_MS = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runAgentLoop wrap-up call respects JEO_WRAPUP_TIMEOUT_MS when step budget exhausts", async () => {
  const prev = process.env.JEO_WRAPUP_TIMEOUT_MS;
  process.env.JEO_WRAPUP_TIMEOUT_MS = "80";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeo-wrapup-timeout-"));
  fs.mkdirSync(path.join(dir, ".jeo"));
  fs.writeFileSync(path.join(dir, ".jeo", "hooks.json"), JSON.stringify({ enabled: false }));
  let calls = 0;
  let wrapUpSignalAborted = false;
  const llm = spyOn(loop, "callLlm").mockImplementation(async (_hist, options) => {
    calls++;
    if (calls === 1) return JSON.stringify({ tool: "ls", arguments: { dirPath: "." } });
    options?.signal?.addEventListener("abort", () => { wrapUpSignalAborted = true; }, { once: true });
    return new Promise(() => {});
  });
  try {
    const started = Date.now();
    const res = await runAgentLoop(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "keep calling ls" },
      ],
      {
        cwd: dir,
        maxSteps: 1,
        budget: { maxExtensions: 0 },
        tools: {
          ls: async () => ({ success: true, output: "src" }),
        },
      },
    );
    expect(Date.now() - started).toBeLessThan(1500);
    expect(wrapUpSignalAborted).toBe(true);
    expect(res.done).toBe(false);
  } finally {
    llm.mockRestore();
    if (prev === undefined) delete process.env.JEO_WRAPUP_TIMEOUT_MS;
    else process.env.JEO_WRAPUP_TIMEOUT_MS = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isBrokenPipeError handles write EIO and spawnDetachedDistill skips spawning without spy under bun test", async () => {
  expect(isBrokenPipeError(Object.assign(new Error("EIO: i/o error, write"), { code: "EIO", syscall: "write" }))).toBe(true);
  expect(isBrokenPipeError(Object.assign(new Error("EIO: i/o error, open"), { code: "EIO", syscall: "open" }))).toBe(false);

  const cmd = distillInvocation("/repo/test/some-suite.test.ts", "/usr/bin/bun", "/repo", "/f.json");
  expect(cmd[1]).toEndWith(path.join("src", "cli.ts"));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jeo-distill-notestspawn-"));
  try {
    const ok = await spawnDetachedDistill(
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "more" },
        { role: "assistant", content: "done" },
      ],
      tmp,
      "m",
    );
    expect(ok).toBe(false);
    expect(fs.existsSync(path.join(tmp, ".jeo", "memory"))).toBe(false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
