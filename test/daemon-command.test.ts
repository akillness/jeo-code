import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runDaemonCommand } from "../src/commands/daemon";
import { notifyDaemonLockPath } from "../src/agent/notify/paths";
import { processStartTimeMs } from "../src/agent/notify/daemon-control";

let dir: string;
const savedCfgDir = process.env.JEO_CONFIG_DIR;
let logs: string[];
let logSpy: ReturnType<typeof spyOn>;

async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}
async function realStartedAt(pid: number): Promise<number> {
  const real = await processStartTimeMs(pid);
  return real ?? Date.now();
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-daemon-cmd-"));
  process.env.JEO_CONFIG_DIR = dir;
  logs = [];
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  logSpy.mockRestore();
  process.exitCode = 0;
  if (savedCfgDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = savedCfgDir;
  await fs.rm(dir, { recursive: true, force: true });
});

test("default action (no args) is 'status'", async () => {
  await runDaemonCommand([]);
  expect(logs.join("\n")).toContain("not configured");
  expect(logs.join("\n")).toContain("stopped");
});

test("status reports 'running' with pid + ISO timestamp for a live-pid lock", async () => {
  await fs.mkdir(path.dirname(notifyDaemonLockPath()), { recursive: true });
  const startedAt = await realStartedAt(process.pid);
  await fs.writeFile(notifyDaemonLockPath(), JSON.stringify({ pid: process.pid, startedAt }));
  await runDaemonCommand(["status"]);
  const text = logs.join("\n");
  expect(text).toContain(`running (pid ${process.pid}`);
  expect(text).toContain(new Date(startedAt).toISOString());
});

test("status reports 'stale' for a dead-pid lock", async () => {
  await fs.mkdir(path.dirname(notifyDaemonLockPath()), { recursive: true });
  await fs.writeFile(notifyDaemonLockPath(), JSON.stringify({ pid: await deadPid(), startedAt: 1 }));
  await runDaemonCommand(["status"]);
  expect(logs.join("\n")).toContain("stale");
});

test("stop when nothing is running reports 'was not running' and exits ok", async () => {
  await runDaemonCommand(["stop"]);
  expect(logs.join("\n")).toContain("daemon was not running");
  expect(process.exitCode).toBe(0);
});

test("stop on a live pid signals it and clears the lock, reporting ok", async () => {
  const child = Bun.spawn(["sleep", "5"]);
  await fs.mkdir(path.dirname(notifyDaemonLockPath()), { recursive: true });
  await fs.writeFile(notifyDaemonLockPath(), JSON.stringify({ pid: child.pid, startedAt: Date.now() }));
  await runDaemonCommand(["stop"]);
  expect(logs.join("\n")).toContain("daemon stopped");
  expect(process.exitCode).toBe(0);
  await child.exited;
});

test("an unknown action reports usage and sets a non-zero exit code", async () => {
  await runDaemonCommand(["bogus"]);
  expect(logs.join("\n")).toContain("Unknown 'jeo daemon' action");
  expect(process.exitCode).toBe(1);
});

test("'list' is an alias for 'status'", async () => {
  await runDaemonCommand(["list"]);
  expect(logs.join("\n")).toContain("stopped");
});
