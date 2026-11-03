import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  currentJeoCommand,
  discordRunCommand,
  discordRunScript,
  messengerExecutablePath,
  waitForDiscordGuilds,
  probeDiscordGateway,
  setupDiscordMessenger,
} from "../src/messenger/discord-setup";

const io = { interactive: true, say() {}, ask: async () => "", askSecret: async () => "" };

test("Windows launcher keeps credentials in the sidecar and preserves drive-letter PATH entries", () => {
	const executablePath = messengerExecutablePath("C:\\Program Files\\Bun\\bun.exe", "C:\\Program Files\\Bun;D:\\tools", ";", "win32");
	expect(executablePath).toBe("C:\\Program Files\\Bun;D:\\tools");
  const script = discordRunCommand(
    ["C:\\Program Files\\jeo\\jeo.exe"],
    "messenger.json",
    "JEO_DISCORD_BOT_TOKEN",
    executablePath,
  );
  expect(script).toContain('set "PATH=C:\\Program Files\\Bun;D:\\tools"');
  expect(script).toContain('set /p "JEO_DISCORD_BOT_TOKEN="<"%~dp0discord-token"');
  expect(script).toContain('"C:\\Program Files\\jeo\\jeo.exe" messenger run --config "%~dp0messenger.json"');
  expect(script).not.toContain("#!/bin/sh");
  expect(script).not.toContain("secret");
});

test("POSIX launcher retains its private token-file check", () => {
  const script = discordRunScript(["/opt/jeo"], "messenger.json", "JEO_DISCORD_BOT_TOKEN", "/opt:/usr/bin");
  expect(script).toContain("discord-token must be readable by its owner only");
  expect(script).toContain('JEO_DISCORD_BOT_TOKEN=$(cat "$token_file")');
  expect(script).not.toContain("bot-token-value");
});

test("compiled Bun entrypoints are recognized on POSIX and Windows", () => {
  expect(currentJeoCommand("/$bunfs/root/jeo", "/tmp/jeo")).toEqual(["/tmp/jeo"]);
  expect(currentJeoCommand("B:\\~BUN\\root\\jeo.exe", "C:\\bin\\jeo.exe")).toEqual(["C:\\bin\\jeo.exe"]);
  expect(currentJeoCommand("C:\\src\\cli.ts", "C:\\bun.exe")).toEqual(["C:\\bun.exe", "C:\\src\\cli.ts"]);
});

test("invite polling covers success and API failure", async () => {
  let calls = 0;
  const success = await waitForDiscordGuilds(async () => {
    calls++;
    return calls === 1 ? [] : [{ id: "guild" }];
  }, "https://discord.example/invite", io, async () => {}, 10);
  expect(success).toEqual([{ id: "guild" }]);
  await expect(waitForDiscordGuilds(async () => { throw new Error("offline"); }, "invite", io, async () => {}, 10)).rejects.toThrow("offline");
});

test("invite polling cancellation interrupts a pending sleep without another API request", async () => {
  let calls = 0;
  const controller = new AbortController();
  const started = performance.now();
  const polling = waitForDiscordGuilds(async () => { calls++; return []; }, "invite", io, ms => new Promise(resolve => setTimeout(resolve, ms)), 300_000, controller.signal);
  setTimeout(() => controller.abort(), 20);
  await expect(polling).rejects.toThrow("cancelled");
  expect(performance.now() - started).toBeLessThan(500);
  expect(calls).toBe(1);
});

test("abortable polling is measurably faster than the former non-abortable sleep baseline", async () => {
  const baselineStart = performance.now();
  await new Promise(resolve => setTimeout(resolve, 80));
  const baselineMs = performance.now() - baselineStart;
  const controller = new AbortController();
  const improvedStart = performance.now();
  const polling = waitForDiscordGuilds(async () => [], "invite", io, ms => new Promise(resolve => setTimeout(resolve, ms)), 300_000, controller.signal);
  controller.abort();
  await expect(polling).rejects.toThrow("cancelled");
  const improvedMs = performance.now() - improvedStart;
  expect(improvedMs).toBeLessThan(baselineMs);
});

test("PTY Ctrl+C interrupts Discord setup while readline is waiting for a secret", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-messenger-setup-pty-"));
  const cli = path.resolve(import.meta.dir, "../src/cli.ts");
  let output = "";
  const ready = Promise.withResolvers<void>();
  const terminal = new Bun.Terminal({ cols: 100, rows: 30, data(_terminal, bytes) {
    output += new TextDecoder().decode(bytes);
    if (output.includes("Discord bot token:")) ready.resolve();
  } });
  const proc = Bun.spawn([process.execPath, cli, "messenger", "setup", "--config", path.join(root, "messenger.json")], {
    cwd: root,
    env: { ...process.env, JEO_DISCORD_BOT_TOKEN: "" },
    terminal,
  });
  try {
    await Promise.race([ready.promise, Bun.sleep(2_000).then(() => { throw new Error(`setup prompt did not appear: ${output}`); })]);
    const started = performance.now();
    terminal.write("\u0003");
    const code = await Promise.race([proc.exited, Bun.sleep(2_000).then(() => { throw new Error("setup ignored PTY Ctrl+C"); })]);
    expect(code).not.toBe(0);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(output).not.toContain("JEO_DISCORD_BOT_TOKEN=");
  } finally {
    terminal.close();
    proc.kill();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("gateway pre-abort does not make an API request or construct a socket", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  class Socket { constructor() { calls++; } }
  const api = async () => { calls++; return {}; };
  await expect(probeDiscordGateway(api, "token", Socket as unknown as typeof WebSocket, controller.signal)).rejects.toThrow("cancelled");
  expect(calls).toBe(0);
});

test("Windows service rejection precedes network, prompts and filesystem writes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-discord-service-"));
  let calls = 0;
  try {
    const configPath = path.join(directory, "profile", "messenger.json");
    const guardedIO = { interactive: true, say() { calls++; }, ask: async () => { calls++; return ""; }, askSecret: async () => { calls++; return ""; } };
    await expect(setupDiscordMessenger({ configPath, service: true }, guardedIO, { platform: "win32", fetch: (async () => { calls++; throw new Error("unexpected fetch"); }) as typeof fetch })).rejects.toThrow("only on macOS and Linux");
    expect(calls).toBe(0);
    expect(await fs.readdir(directory)).toEqual([]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("Windows batch generation escapes percent and disables exclamation expansion", () => {
  const script = discordRunCommand(["C:\\Apps\\100%ready!\\jeo.exe"], "messenger.json", "JEO_DISCORD_BOT_TOKEN", "C:\\Tools\\100%ready!");
  expect(script).toContain("setlocal DisableDelayedExpansion");
  expect(script).toContain("C:\\Apps\\100%%ready!\\jeo.exe");
  expect(script).toContain("C:\\Tools\\100%%ready!");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`${signal} interrupts Discord setup while a secret prompt is pending`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-discord-signal-"));
    let output = "";
    const ready = Promise.withResolvers<void>();
    const terminal = new Bun.Terminal({ cols: 100, rows: 30, data(_terminal, bytes) {
      output += new TextDecoder().decode(bytes);
      if (output.includes("Discord bot token:")) ready.resolve();
    } });
    const proc = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../src/cli.ts"), "messenger", "setup", "--config", path.join(root, "messenger.json")], {
      cwd: root, env: { ...process.env, JEO_DISCORD_BOT_TOKEN: "" }, terminal,
    });
    try {
      await ready.promise;
      proc.kill(signal);
      const code = await proc.exited;
      expect(code).not.toBe(0);
    } finally {
      terminal.close();
      proc.kill();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 5000);
}
