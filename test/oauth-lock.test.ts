import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireLock, releaseLock } from "../src/auth/storage";

// Regression: acquireLock retried every 50ms FOREVER when the lock file stayed
// fresh (wedged holder, churn between concurrent sessions) or could not be
// unlinked — a mid-turn OAuth refresh then froze the whole agent turn. The wait
// is now bounded: stale locks are removed, and at the deadline the lock is
// stolen instead of hanging the caller.
test("acquireLock: a constantly-refreshed (wedged) lock cannot hang the caller", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-oauth-lock-"));
  const prevEnv = process.env.JEO_CONFIG_DIR;
  process.env.JEO_CONFIG_DIR = dir;
  const lockPath = path.join(dir, "oauth-anthropic.lock");
  // A foreign holder that keeps its lock perpetually fresh (never goes stale).
  await fs.writeFile(lockPath, JSON.stringify({ pid: 999_999, createdAt: Date.now() }), "utf-8");
  const refresher = setInterval(() => {
    fs.writeFile(lockPath, JSON.stringify({ pid: 999_999, createdAt: Date.now() }), "utf-8").catch(() => {});
  }, 100);
  // Stop refreshing just before the steal deadline so the steal's unlink+create
  // cannot race a concurrent rewrite (the deadline for timeoutMs=300 is 1000ms).
  const stopper = setTimeout(() => clearInterval(refresher), 940);
  try {
    const started = Date.now();
    await acquireLock("anthropic", 300);
    const took = Date.now() - started;
    expect(took).toBeLessThan(3_000); // bounded — previously this waited forever
    const info = JSON.parse(await fs.readFile(lockPath, "utf-8"));
    expect(info.pid).toBe(process.pid); // we hold it now
  } finally {
    clearInterval(refresher);
    clearTimeout(stopper);
    await releaseLock("anthropic");
    if (prevEnv === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = prevEnv;
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("acquireLock: a stale dead-holder lock is removed promptly", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-oauth-lock-"));
  const prevEnv = process.env.JEO_CONFIG_DIR;
  process.env.JEO_CONFIG_DIR = dir;
  const lockPath = path.join(dir, "oauth-openai.lock");
  await fs.writeFile(lockPath, JSON.stringify({ pid: 999_999, createdAt: Date.now() - 60_000 }), "utf-8");
  try {
    const started = Date.now();
    await acquireLock("openai", 500);
    expect(Date.now() - started).toBeLessThan(2_000);
  } finally {
    await releaseLock("openai");
    if (prevEnv === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = prevEnv;
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("acquireLock: refuses to steal a lock held by a live PID even when timestamp is stale", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-oauth-lock-"));
  const prevEnv = process.env.JEO_CONFIG_DIR;
  process.env.JEO_CONFIG_DIR = dir;
  const lockPath = path.join(dir, "oauth-anthropic.lock");
  const liveRecord = { pid: process.pid, nonce: "live-owner-nonce", acquiredAt: Date.now() - 60_000 };
  await fs.writeFile(lockPath, JSON.stringify(liveRecord), "utf-8");
  try {
    await expect(acquireLock("anthropic", 50)).rejects.toThrow(/held by live process \d+; refusing to steal/);
    const onDisk = JSON.parse(await fs.readFile(lockPath, "utf-8"));
    expect(onDisk.pid).toBe(process.pid);
    expect(onDisk.nonce).toBe("live-owner-nonce");
  } finally {
    await fs.unlink(lockPath).catch(() => {});
    if (prevEnv === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = prevEnv;
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("acquireLock: steals a fresh lock held by a dead PID at the deadline and returns a fresh nonce", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-oauth-lock-"));
  const prevEnv = process.env.JEO_CONFIG_DIR;
  process.env.JEO_CONFIG_DIR = dir;
  const deadProc = Bun.spawn(["true"]);
  await deadProc.exited;
  const lockPath = path.join(dir, "oauth-openai.lock");
  await fs.writeFile(
    lockPath,
    JSON.stringify({ pid: deadProc.pid, nonce: "dead-owner-nonce", acquiredAt: Date.now() }),
    "utf-8",
  );
  let acquiredNonce: string | undefined;
  try {
    acquiredNonce = await acquireLock("openai", 50);
    expect(acquiredNonce.length).toBeGreaterThan(0);
    expect(acquiredNonce).not.toBe("dead-owner-nonce");
    const onDisk = JSON.parse(await fs.readFile(lockPath, "utf-8"));
    expect(onDisk.pid).toBe(process.pid);
    expect(onDisk.nonce).toBe(acquiredNonce);
  } finally {
    await releaseLock("openai", acquiredNonce);
    if (prevEnv === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = prevEnv;
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("releaseLock: nonce guard refuses to unlink another owner's lock and unlinks only on matching nonce", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-oauth-lock-"));
  const prevEnv = process.env.JEO_CONFIG_DIR;
  process.env.JEO_CONFIG_DIR = dir;
  const lockPath = path.join(dir, "oauth-anthropic.lock");
  try {
    const ownerANonce = await acquireLock("anthropic", 200);
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, nonce: "owner-b-nonce", acquiredAt: Date.now() }),
      "utf-8",
    );

    // Explicit stale nonce from Owner A must NOT unlink Owner B's lock.
    await releaseLock("anthropic", ownerANonce);
    let onDisk = JSON.parse(await fs.readFile(lockPath, "utf-8"));
    expect(onDisk.nonce).toBe("owner-b-nonce");

    // Implicit heldLockNonces release and arbitrary wrong nonce must also leave Owner B's lock intact.
    await releaseLock("anthropic");
    await releaseLock("anthropic", "wrong-nonce");
    onDisk = JSON.parse(await fs.readFile(lockPath, "utf-8"));
    expect(onDisk.nonce).toBe("owner-b-nonce");

    // Only Owner B's matching nonce unlinks the lock file.
    await releaseLock("anthropic", "owner-b-nonce");
    await expect(fs.stat(lockPath)).rejects.toThrow();
  } finally {
    await fs.unlink(lockPath).catch(() => {});
    if (prevEnv === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = prevEnv;
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 10_000);
