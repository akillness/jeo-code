import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  readDaemonLock,
  acquireDaemonLock,
  daemonStatus,
  isNotifyConfigured,
  daemonInvocation,
  startDaemon,
  stopDaemon,
  reloadDaemon,
  isPidAlive,
  processStartTimeMs,
  parseEtimeToMs,
  isLockOwnerAlive,
} from "../src/agent/notify/daemon-control";
import { notifyDaemonLockPath } from "../src/agent/notify/paths";
import { saveConfigPatch } from "../src/agent/state";

let dir: string;
const savedCfgDir = process.env.JEO_CONFIG_DIR;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-notify-daemon-"));
  process.env.JEO_CONFIG_DIR = dir;
});

afterEach(async () => {
  if (savedCfgDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = savedCfgDir;
  await fs.rm(dir, { recursive: true, force: true });
});

async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

async function realStartedAt(pid: number): Promise<number> {
  const real = await processStartTimeMs(pid);
  return real ?? Date.now();
}

test("isPidAlive is true for our own process and false for an exited one", async () => {
  expect(isPidAlive(process.pid)).toBe(true);
  expect(isPidAlive(await deadPid())).toBe(false);
});

test("parseEtimeToMs parses mm:ss, hh:mm:ss, and dd-hh:mm:ss `ps -o etime=` formats", () => {
  expect(parseEtimeToMs("00:01")).toBe(1_000);
  expect(parseEtimeToMs("05:23")).toBe((5 * 60 + 23) * 1_000);
  expect(parseEtimeToMs("01:02:03")).toBe(((1 * 60 + 2) * 60 + 3) * 1_000);
  expect(parseEtimeToMs("2-03:04:05")).toBe((((2 * 24 + 3) * 60 + 4) * 60 + 5) * 1_000);
});

test("parseEtimeToMs returns undefined for empty or malformed input instead of throwing", () => {
  expect(parseEtimeToMs("")).toBeUndefined();
  expect(parseEtimeToMs("   ")).toBeUndefined();
  expect(parseEtimeToMs("not-a-time")).toBeUndefined();
  expect(parseEtimeToMs("1:2:3:4")).toBeUndefined();
  expect(parseEtimeToMs("1")).toBeUndefined();
});

test("processStartTimeMs returns undefined for a pid that no longer exists", async () => {
  expect(await processStartTimeMs(await deadPid())).toBeUndefined();
});

test("processStartTimeMs resolves a real live process to a plausible (not garbage) start time", async () => {
  const before = Date.now();
  const real = await processStartTimeMs(process.pid);
  expect(real).toBeDefined();
  // The Bun worker can outlive this individual test by the full suite duration.
  // Compare the OS elapsed-time-derived timestamp against the process's actual
  // runtime rather than assuming this test runs in its first minute.
  const elapsedSinceReportedStart = before - real!;
  expect(elapsedSinceReportedStart).toBeGreaterThanOrEqual(-10_000);
  expect(elapsedSinceReportedStart).toBeLessThanOrEqual(process.uptime() * 1_000 + 10_000);
});

test("readDaemonLock returns undefined when no lock file exists", async () => {
  expect(await readDaemonLock()).toBeUndefined();
});

test("readDaemonLock returns undefined for malformed JSON (never throws)", async () => {
  await fs.mkdir(path.dirname(notifyDaemonLockPath()), { recursive: true });
  await fs.writeFile(notifyDaemonLockPath(), "not json");
  expect(await readDaemonLock()).toBeUndefined();
});

test("acquireDaemonLock writes pid+startedAt and refuses when a DIFFERENT live pid already owns it", async () => {
  const other = Bun.spawn(["sleep", "5"]);
  try {
    await fs.mkdir(path.dirname(notifyDaemonLockPath()), { recursive: true });
    await fs.writeFile(notifyDaemonLockPath(), JSON.stringify({ pid: other.pid, startedAt: Date.now() }));
    const lock = await acquireDaemonLock();
    expect(lock).toBeUndefined(); // singleton refused — another owner is alive
  } finally {
    other.kill();
    await other.exited;
  }
});

test("acquireDaemonLock reclaims a stale lock (dead pid) and release() removes the file", async () => {
  await fs.mkdir(path.dirname(notifyDaemonLockPath()), { recursive: true });
  await fs.writeFile(notifyDaemonLockPath(), JSON.stringify({ pid: await deadPid(), startedAt: 1 }));
  const lock = await acquireDaemonLock();
  expect(lock).toBeDefined();
  const onDisk = await readDaemonLock();
  expect(onDisk?.pid).toBe(process.pid);
  await lock!.release();
  expect(await readDaemonLock()).toBeUndefined();
});

test("isNotifyConfigured is false until enabled + botToken + chatId are all present", async () => {
  expect(await isNotifyConfigured()).toBe(false);
  await saveConfigPatch(() => ({ notifications: { enabled: true, telegram: { botToken: "t" } } }));
  expect(await isNotifyConfigured()).toBe(false); // missing chatId
  await saveConfigPatch(() => ({ notifications: { enabled: true, telegram: { botToken: "t", chatId: "1" } } }));
  expect(await isNotifyConfigured()).toBe(true);
});

test("daemonStatus reports stopped+not-configured on a clean install", async () => {
  const status = await daemonStatus();
  expect(status).toEqual({ configured: false, running: false, stale: false });
});

test("daemonStatus reports running for a live-pid lock and stale for a dead-pid lock", async () => {
  await fs.mkdir(path.dirname(notifyDaemonLockPath()), { recursive: true });
  await fs.writeFile(notifyDaemonLockPath(), JSON.stringify({ pid: process.pid, startedAt: await realStartedAt(process.pid) }));
  const running = await daemonStatus();
  expect(running.running).toBe(true);
  expect(running.stale).toBe(false);
  expect(running.pid).toBe(process.pid);

  await fs.writeFile(notifyDaemonLockPath(), JSON.stringify({ pid: await deadPid(), startedAt: 123 }));
  const stale = await daemonStatus();
  expect(stale.running).toBe(false);
  expect(stale.stale).toBe(true);
});

test("isLockOwnerAlive is true when the recorded startedAt matches the process's real start time", async () => {
  const startedAt = await realStartedAt(process.pid);
  expect(await isLockOwnerAlive({ pid: process.pid, startedAt })).toBe(true);
});

test("isLockOwnerAlive is false when the recorded startedAt does not match — PID reuse detection", async () => {
  // Simulates a stale lock whose pid was reassigned by the OS to an unrelated
  // live process (here, this test runner) long after the original daemon
  // actually started — a bare kill(pid, 0) cannot tell these apart.
  const bogusStartedAt = (await realStartedAt(process.pid)) - 60 * 60 * 1000; // 1h off
  expect(await isLockOwnerAlive({ pid: process.pid, startedAt: bogusStartedAt })).toBe(false);
});

test("stopDaemon refuses to signal a live pid whose startedAt does not match (PID reuse) and clears the lock instead", async () => {
  const child = Bun.spawn(["sleep", "5"]);
  try {
    await fs.mkdir(path.dirname(notifyDaemonLockPath()), { recursive: true });
    // Deliberately wrong startedAt — simulates the recorded owner having
    // already died and this pid now belonging to an unrelated process.
    await fs.writeFile(notifyDaemonLockPath(), JSON.stringify({ pid: child.pid, startedAt: 1 }));
    const res = await stopDaemon();
    expect(res.ok).toBe(true);
    expect(res.message).toBe("daemon was not running");
    expect(await readDaemonLock()).toBeUndefined();
    // The unrelated live process must NOT have been signaled.
    expect(isPidAlive(child.pid)).toBe(true);
  } finally {
    child.kill();
    await child.exited;
  }
});

test("daemonInvocation resolves .ts source through the bun runtime", () => {
  expect(daemonInvocation("/repo/src/cli.ts", "/usr/bin/bun", "/repo")).toEqual(["/usr/bin/bun", "/repo/src/cli.ts", "notify-daemon-run"]);
});

test("daemonInvocation resolves a relative .ts entrypoint against cwd", () => {
  expect(daemonInvocation("src/cli.ts", "/usr/bin/bun", "/repo")).toEqual(["/usr/bin/bun", "/repo/src/cli.ts", "notify-daemon-run"]);
});

test("daemonInvocation runs a compiled bunfs binary directly (no source path)", () => {
  expect(daemonInvocation("/$bunfs/root/jeo", "/tmp/jeo-binary", "/repo")).toEqual(["/tmp/jeo-binary", "notify-daemon-run"]);
});

test("daemonInvocation runs a non-.ts entrypoint (already-built binary) directly", () => {
  expect(daemonInvocation("/usr/local/bin/jeo", "/usr/local/bin/jeo", "/repo")).toEqual(["/usr/local/bin/jeo", "notify-daemon-run"]);
});

test("startDaemon reports already-running without re-spawning when a live lock exists", async () => {
  await fs.mkdir(path.dirname(notifyDaemonLockPath()), { recursive: true });
  await fs.writeFile(notifyDaemonLockPath(), JSON.stringify({ pid: process.pid, startedAt: await realStartedAt(process.pid) }));
  let spawned = false;
  const res = await startDaemon(() => {
    spawned = true;
    return { unref: () => {} };
  });
  expect(res.ok).toBe(true);
  expect(res.pid).toBe(process.pid);
  expect(spawned).toBe(false);
});

test("startDaemon refuses to spawn when notifications are not configured", async () => {
  let spawned = false;
  const res = await startDaemon(() => {
    spawned = true;
    return { unref: () => {} };
  });
  expect(res.ok).toBe(false);
  expect(res.message).toContain("not configured");
  expect(spawned).toBe(false);
});

test("startDaemon spawns and waits for the child to write its own lock", async () => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, telegram: { botToken: "t", chatId: "1" } } }));
  const res = await startDaemon(() => {
    // Simulate the real daemon process writing its lock shortly after spawn.
    void (async () => {
      await new Promise(r => setTimeout(r, 50));
      await fs.mkdir(path.dirname(notifyDaemonLockPath()), { recursive: true });
      await fs.writeFile(notifyDaemonLockPath(), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    })();
    return { unref: () => {} };
  });
  expect(res.ok).toBe(true);
  expect(res.pid).toBe(process.pid);
});


test("startDaemon reports failure when the child never writes a lock within the timeout", async () => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, telegram: { botToken: "t", chatId: "1" } } }));
  const res = await startDaemon(() => ({ unref: () => {} }));

  expect(res.ok).toBe(false);
  expect(res.message).toContain("did not report ready");
}, 5_000);

test("stopDaemon reports 'was not running' and clears any stale lock file when no live pid holds it", async () => {
  await fs.mkdir(path.dirname(notifyDaemonLockPath()), { recursive: true });
  await fs.writeFile(notifyDaemonLockPath(), JSON.stringify({ pid: await deadPid(), startedAt: 1 }));
  const res = await stopDaemon();
  expect(res.ok).toBe(true);
  expect(res.message).toBe("daemon was not running");
  expect(await readDaemonLock()).toBeUndefined();
});

test("stopDaemon signals a live child and clears the lock once it exits", async () => {
  const child = Bun.spawn(["sleep", "5"]);
  await fs.mkdir(path.dirname(notifyDaemonLockPath()), { recursive: true });
  await fs.writeFile(notifyDaemonLockPath(), JSON.stringify({ pid: child.pid, startedAt: Date.now() }));
  const res = await stopDaemon();
  expect(res.ok).toBe(true);
  expect(res.message).toContain("daemon stopped");
  expect(await readDaemonLock()).toBeUndefined();
  await child.exited;
});

test("reloadDaemon stops the old owner and starts a fresh one", async () => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, telegram: { botToken: "t", chatId: "1" } } }));
  const child = Bun.spawn(["sleep", "5"]);
  await fs.mkdir(path.dirname(notifyDaemonLockPath()), { recursive: true });
  await fs.writeFile(notifyDaemonLockPath(), JSON.stringify({ pid: child.pid, startedAt: Date.now() }));
  const res = await reloadDaemon(() => {

    void (async () => {
      await new Promise(r => setTimeout(r, 50));
      await fs.writeFile(notifyDaemonLockPath(), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    })();
    return { unref: () => {} };
  });
  expect(res.ok).toBe(true);
  const lock = await readDaemonLock();
  expect(lock?.pid).toBe(process.pid);
  await child.exited;
});
