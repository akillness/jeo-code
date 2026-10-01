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
  canVerifyProcessStartTime,
  inspectLockOwner,
} from "../src/agent/notify/daemon-control";
import { notifyDaemonLockPath } from "../src/agent/notify/paths";
import { saveConfigPatch } from "../src/agent/state";

// The PID-reuse guard needs the OS to report a process start time. That is a real host
// CAPABILITY, not a jeo behaviour: `/proc` is Linux-only and hardened sandboxes/seccomp
// profiles routinely block the setuid `/bin/ps`. Where the lookup is genuinely
// unavailable the guard documents itself as degrading to an existence-only check, so
// asserting the strong behaviour there would be asserting something the host cannot do.
// Skip honestly instead of failing — and keep a test below that pins the DEGRADED
// contract, so the fallback path is still covered everywhere.
const canVerifyStart = await canVerifyProcessStartTime();
const startTimeTest = canVerifyStart ? test : test.skip;

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

startTimeTest("processStartTimeMs resolves a real live process to a plausible (not garbage) start time", async () => {
  const before = Date.now();
  const uptimeMs = process.uptime() * 1_000;
  const real = await processStartTimeMs(process.pid);
  const after = Date.now();
  expect(real).toBeDefined();
  // The runner may already be minutes old when this test executes. Compare its
  // birth time with the independent runtime uptime, not with this test's start.
  // Allow ps's whole-second precision and the measured lookup duration.
  expect(real!).toBeGreaterThanOrEqual(before - uptimeMs - 1_000);
  expect(real!).toBeLessThanOrEqual(after - uptimeMs + 1_000);
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
  await saveConfigPatch(() => ({ notifications: { enabled: true, telegram: { botToken: "t" } } }));
  expect(await isNotifyConfigured()).toBe(false); // missing chatId
  await saveConfigPatch(() => ({ notifications: { enabled: true, telegram: { botToken: "t", chatId: "1" } } }));
  expect(await isNotifyConfigured()).toBe(true);
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

startTimeTest("isLockOwnerAlive is false when the recorded startedAt does not match — PID reuse detection", async () => {
  // Simulates a stale lock whose pid was reassigned by the OS to an unrelated
  // live process (here, this test runner) long after the original daemon
  // actually started — a bare kill(pid, 0) cannot tell these apart.
  const bogusStartedAt = (await realStartedAt(process.pid)) - 60 * 60 * 1000; // 1h off
  expect(await isLockOwnerAlive({ pid: process.pid, startedAt: bogusStartedAt })).toBe(false);
});

startTimeTest("stopDaemon refuses to signal a live pid whose startedAt does not match (PID reuse) and clears the lock instead", async () => {
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

test("startDaemon reports initializing until its current owner explicitly marks ready", async () => {
  const owner = await acquireDaemonLock();
  expect(owner).toBeDefined();
  let spawned = false;
  const spawn = () => { spawned = true; return { unref() {} }; };
  try {
    expect((await startDaemon(spawn)).ok).toBe(false);
    await owner!.markReady();
    const res = await startDaemon(spawn);
    expect(res.ok).toBe(true);
    expect(res.pid).toBe(process.pid);
    expect(spawned).toBe(false);
  } finally {
    await owner?.release();
  }
  expect(await readDaemonLock()).toBeUndefined();
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
      await fs.mkdir(path.dirname(notifyDaemonLockPath()), { recursive: true });
      await fs.writeFile(notifyDaemonLockPath(), JSON.stringify({ pid: process.pid, startedAt: Date.now(), purpose: "daemon", ready: true }));
    })();
    return { unref: () => {} };
  });
  expect(res.ok).toBe(true);
  expect(res.pid).toBe(process.pid);
});


test.each(["missing", "initializing", "pairing"] as const)("startup does not report success for a %s child lock", async state => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, telegram: { botToken: "t", chatId: "1" } } }));
  let release: (() => Promise<void>) | undefined;
  try {
    const res = await startDaemon(() => ({ unref() {} }), async predicate => {
      if (state !== "missing") {
        const owner = await acquireDaemonLock(state === "pairing" ? "pairing" : "daemon");
        expect(owner).toBeDefined();
        release = owner!.release;
        if (state === "pairing") await owner!.markReady();
      }
      return await predicate();
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("did not initialize");
  } finally {
    await release?.();
  }
});

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
      await fs.writeFile(notifyDaemonLockPath(), JSON.stringify({ pid: process.pid, startedAt: Date.now(), purpose: "daemon", ready: true }));
    })();
    return { unref: () => {} };
  });
  expect(res.ok).toBe(true);
  const lock = await readDaemonLock();
  expect(lock?.pid).toBe(process.pid);
  await child.exited;
});


// --- Degraded-host contract (runs everywhere) ---------------------------------
// When the start time cannot be read, the guard must stay USABLE (a daemon in a
// distroless container still has to be stoppable) but must not silently claim it
// verified anything. inspectLockOwner separates those two facts; daemonStatus and
// stopDaemon surface the caveat rather than hiding it.

test("inspectLockOwner separates 'alive' from 'verified' so a degraded host is visible", async () => {
  // The suite process may have been alive for minutes by the time this file runs;
  // a `Date.now()` stamp would then look like PID reuse (> tolerance) on a verifying host.
  const alive = await inspectLockOwner({ pid: process.pid, startedAt: Date.now() - process.uptime() * 1_000 });
  expect(alive.alive).toBe(true);
  expect(alive.verified).toBe(canVerifyStart);

  // A dead pid is always a VERIFIED negative — existence alone settles it, no start
  // time needed — so this holds on every host regardless of `ps`//proc availability.
  const dead = await inspectLockOwner({ pid: await deadPid(), startedAt: Date.now() });
  expect(dead).toEqual({ alive: false, verified: true });
});

test("daemonStatus reports whether the running claim was actually verified", async () => {
  await fs.mkdir(path.dirname(notifyDaemonLockPath()), { recursive: true });
  await fs.writeFile(notifyDaemonLockPath(), JSON.stringify({ pid: process.pid, startedAt: Date.now() - process.uptime() * 1_000 }));
  const status = await daemonStatus();
  expect(status.running).toBe(true);
  expect(status.ownerVerified).toBe(canVerifyStart);
  // No lock at all → nothing to verify, so the field stays absent rather than false.
  await fs.unlink(notifyDaemonLockPath()).catch(() => {});
  expect((await daemonStatus()).ownerVerified).toBeUndefined();
});

test("concurrent acquisition admits exactly one owner and excludes a second acquisition by the same PID", async () => {
  const attempts = await Promise.all(Array.from({ length: 8 }, () => acquireDaemonLock()));
  const winners = attempts.filter(lock => lock !== undefined);
  try {
    expect(winners).toHaveLength(1);
    expect(await acquireDaemonLock()).toBeUndefined();
  } finally {
    await Promise.all(winners.map(lock => lock.release()));
  }
  const next = await acquireDaemonLock();
  expect(next).toBeDefined();
  await next?.release();
});

test("an old release cannot remove a replacement owner's lock", async () => {
  const original = await acquireDaemonLock();
  expect(original).toBeDefined();
  await fs.unlink(notifyDaemonLockPath());
  const replacement = await acquireDaemonLock();
  expect(replacement).toBeDefined();
  try {
    await original!.release();
    expect(await acquireDaemonLock()).toBeUndefined();
  } finally {
    await replacement?.release();
  }
  expect(await readDaemonLock()).toBeUndefined();
});

test("Discord-only configuration requires an allowlist and honors the master disable switch", async () => {
  const discord = { botToken: "test-token", channelId: "123456789012345678", allowedUserIds: ["234567890123456789"] };
  await saveConfigPatch(() => ({ notifications: { enabled: true, discord: { ...discord, allowedUserIds: [] } } }));
  expect(await isNotifyConfigured()).toBe(false);
  await saveConfigPatch(() => ({ notifications: { enabled: true, discord } }));
  expect(await isNotifyConfigured()).toBe(true);
  await saveConfigPatch(() => ({ notifications: { enabled: false, discord } }));
  expect(await isNotifyConfigured()).toBe(false);
});

test("reload never launches a replacement when the current daemon cannot stop", async () => {
  let spawned = false;
  const result = await reloadDaemon(() => {
    spawned = true;
    return { unref() {} };
  }, async () => ({ ok: false, message: "permission denied" }));
  expect(result).toEqual({ ok: false, message: "permission denied" });
  expect(spawned).toBe(false);
});

test("pairing ownership is not a running daemon and daemon control cannot replace or stop it", async () => {
  const owner = await acquireDaemonLock("pairing");
  expect(owner).toBeDefined();
  let spawned = false;
  const spawn = () => { spawned = true; return { unref() {} }; };
  try {
    const status = await daemonStatus();
    expect(status.running).toBe(false);
    expect(status.stale).toBe(false);
    expect(status.pairing).toBe(true);
    expect((await startDaemon(spawn)).ok).toBe(false);
    expect((await stopDaemon()).ok).toBe(false);
    expect((await reloadDaemon(spawn)).ok).toBe(false);
    expect(spawned).toBe(false);
    expect(await acquireDaemonLock()).toBeUndefined();
  } finally {
    await owner?.release();
  }
});

test("an obsolete daemon cannot mark a replacement owner's lock ready", async () => {
  const original = await acquireDaemonLock();
  expect(original).toBeDefined();
  await fs.unlink(notifyDaemonLockPath());
  const replacement = await acquireDaemonLock();
  expect(replacement).toBeDefined();
  try {
    await expect(original!.markReady()).rejects.toThrow("lost lock ownership");
    expect((await startDaemon(() => { throw new Error("must not respawn"); })).ok).toBe(false);
    await replacement!.markReady();
    expect((await startDaemon(() => { throw new Error("must not respawn"); })).ok).toBe(true);
  } finally {
    await original?.release();
    await replacement?.release();
  }
});

test("an aged recovery guard blocks startup and acquisition without deleting recovery evidence", async () => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, telegram: { botToken: "test-token", chatId: "999" } } }));
  const lockPath = notifyDaemonLockPath();
  const guardPath = `${lockPath}.reclaim`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, "interrupted legacy lock");
  await fs.writeFile(guardPath, "recovery owner evidence");
  const old = new Date("2000-01-01T00:00:00.000Z");
  await fs.utimes(lockPath, old, old);
  await fs.utimes(guardPath, old, old);
  let spawned = false;
  const result = await startDaemon(() => { spawned = true; return { unref() {} }; });
  expect(result.ok).toBe(false);
  expect(result.message).toContain("Notification lock recovery");
  expect(result.message).toContain(guardPath);
  expect(spawned).toBe(false);
  await expect(acquireDaemonLock()).rejects.toThrow("Notification lock recovery");
  expect(await fs.readFile(lockPath, "utf-8")).toBe("interrupted legacy lock");
  expect(await fs.readFile(guardPath, "utf-8")).toBe("recovery owner evidence");
});

test("aged malformed primary lock can be recovered into an exclusive ready daemon owner", async () => {
  const lockPath = notifyDaemonLockPath();
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, "{interrupted");
  const old = new Date("2000-01-01T00:00:00.000Z");
  await fs.utimes(lockPath, old, old);
  const owner = await acquireDaemonLock();
  expect(owner).toBeDefined();
  try {
    await owner!.markReady();
    const result = await startDaemon(() => { throw new Error("recovered owner must not be replaced"); });
    expect(result.ok).toBe(true);
    expect(result.pid).toBe(process.pid);
    expect(await acquireDaemonLock()).toBeUndefined();
  } finally {
    await owner?.release();
  }
  expect(await readDaemonLock()).toBeUndefined();
});

test("a recent malformed primary lock is preserved rather than mistaken for a crashed writer", async () => {
  const lockPath = notifyDaemonLockPath();
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, "{writing");
  const future = new Date("2100-01-01T00:00:00.000Z");
  await fs.utimes(lockPath, future, future);
  expect(await acquireDaemonLock()).toBeUndefined();
  expect(await fs.readFile(lockPath, "utf-8")).toBe("{writing");
});
