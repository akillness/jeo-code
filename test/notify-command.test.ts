import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runNotifyCommand } from "../src/commands/notify";
import { readGlobalConfig } from "../src/agent/state";

let dir: string;
const savedCfgDir = process.env.JEO_CONFIG_DIR;
let logs: string[];
let logSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-notify-cmd-"));
  process.env.JEO_CONFIG_DIR = dir;
  logs = [];
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  logSpy.mockRestore();
  if (savedCfgDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = savedCfgDir;
  await fs.rm(dir, { recursive: true, force: true });
});

test("status on a clean install reports disabled + unset credentials + stopped daemon", async () => {
  await runNotifyCommand(["status"]);
  const text = logs.join("\n");
  expect(text).toContain("enabled=false");
  expect(text).toContain("botToken=(not set)");
  expect(text).toContain("chatId=(not set)");
  expect(text).toContain("daemon=stopped");
});

test("setup with no TTY and no --token/--chat-id refuses without touching config", async () => {
  // bun test's stdin is never a TTY, so this exercises the non-interactive guard.
  await runNotifyCommand(["setup"]);
  expect(logs.join("\n")).toContain("needs an interactive terminal");
  const cfg = await readGlobalConfig();
  expect(cfg.notifications?.enabled).toBeFalsy();
});

test("setup --token/--chat-id validates the token via getMe and persists settings on success", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
    return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, username: "jeo_bot" } }), { status: 200 });
  });
  try {
    await runNotifyCommand(["setup", "--token", "999:BOT", "--chat-id", "12345"]);
  } finally {
    fetchSpy.mockRestore();
  }
  const cfg = await readGlobalConfig();
  expect(cfg.notifications?.enabled).toBe(true);
  expect(cfg.notifications?.telegram?.botToken).toBe("999:BOT");
  expect(cfg.notifications?.telegram?.chatId).toBe("12345");
  expect(logs.join("\n")).toContain("Notifications enabled");
  expect(logs.join("\n")).not.toContain("999:BOT"); // token must be masked in output
});

test("setup --token/--chat-id with an invalid token reports the failure and does NOT persist", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
    return new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 });
  });
  try {
    await runNotifyCommand(["setup", "--token", "bad-token", "--chat-id", "1"]);
  } finally {
    fetchSpy.mockRestore();
  }
  expect(logs.join("\n")).toContain("getMe failed");
  const cfg = await readGlobalConfig();
  expect(cfg.notifications?.enabled).toBeFalsy();
});

test("status after setup reports enabled + a masked token + the stored chat id", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
    return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, username: "jeo_bot" } }), { status: 200 });
  });
  try {
    await runNotifyCommand(["setup", "--token", "999999:LONGTOKEN", "--chat-id", "42"]);
  } finally {
    fetchSpy.mockRestore();
  }
  logs = [];
  await runNotifyCommand(["status"]);
  const text = logs.join("\n");
  expect(text).toContain("enabled=true");
  expect(text).toContain("chatId=42");
  expect(text).not.toContain("999999:LONGTOKEN");
  expect(text).toMatch(/botToken=9999…/);
});

test("an unknown subcommand reports usage", async () => {
  await runNotifyCommand(["bogus"]);
  expect(logs.join("\n")).toContain("Unknown 'jeo notify' subcommand");
});
