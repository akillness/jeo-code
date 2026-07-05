/**
 * Daemon lifecycle control (gjc `daemon` command / `control-types.ts` parity,
 * scoped to jeo's one daemon kind — telegram). A pid+startedAt lock file at
 * `notifyDaemonLockPath()` enforces the singleton: Telegram allows only one
 * `getUpdates` long-poll owner per bot token, so a second daemon process must
 * refuse to start rather than race the first for updates (409 Conflict).
 */
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { notifyDaemonLockPath, notifyDaemonLogPath, notifyDir } from "./paths";
import { readGlobalConfig } from "../state";

export interface DaemonLockInfo {
  pid: number;
  startedAt: number;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readDaemonLock(): Promise<DaemonLockInfo | undefined> {
  try {
    const raw = await fs.readFile(notifyDaemonLockPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<DaemonLockInfo>;
    if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "number") return undefined;
    return { pid: parsed.pid, startedAt: parsed.startedAt };
  } catch {
    return undefined;
  }
}

/** Called by the daemon process itself on startup. Returns `undefined` when a
 *  live owner already holds the lock (caller must exit without polling
 *  Telegram); otherwise writes the lock and returns a `release()` closure. */
export async function acquireDaemonLock(): Promise<{ release: () => Promise<void> } | undefined> {
  await fs.mkdir(notifyDir(), { recursive: true, mode: 0o700 });
  const existing = await readDaemonLock();
  if (existing && existing.pid !== process.pid && isPidAlive(existing.pid)) return undefined;
  const info: DaemonLockInfo = { pid: process.pid, startedAt: Date.now() };
  await fs.writeFile(notifyDaemonLockPath(), JSON.stringify(info), { mode: 0o600 });
  return {
    release: async () => {
      await fs.unlink(notifyDaemonLockPath()).catch(() => {});
    },
  };
}

export interface DaemonStatus {
  /** `notifications.enabled` + a stored bot token + chat id are all present. */
  configured: boolean;
  running: boolean;
  /** A lock file exists but its pid is dead — a previous daemon crashed without cleanup. */
  stale: boolean;
  pid?: number;
  startedAt?: number;
}

export async function isNotifyConfigured(): Promise<boolean> {
  const config = await readGlobalConfig();
  return Boolean(config.notifications?.enabled && config.notifications.telegram?.botToken && config.notifications.telegram?.chatId);
}

export async function daemonStatus(): Promise<DaemonStatus> {
  const [lock, configured] = await Promise.all([readDaemonLock(), isNotifyConfigured()]);
  if (!lock) return { configured, running: false, stale: false };
  const alive = isPidAlive(lock.pid);
  return { configured, running: alive, stale: !alive, pid: lock.pid, startedAt: lock.startedAt };
}

/** Self-invocation argv for the daemon child (mirrors `memory.ts`'s
 *  `distillInvocation` — compiled `/$bunfs` virtual path → run the binary
 *  itself; `.ts`/`.js` source → through the runtime; anything else → directly). */
export function daemonInvocation(argv1: string | undefined, execPath: string, cwd: string): string[] {
  const entrypoint = argv1 ?? "";
  let base: string[];
  if (entrypoint === "" || entrypoint.startsWith("/$bunfs/") || entrypoint.startsWith("B:\\~BUN\\")) {
    base = [execPath];
  } else {
    const resolved = path.isAbsolute(entrypoint) ? entrypoint : path.resolve(cwd, entrypoint);
    base = /\.(ts|js|mjs)$/.test(entrypoint) ? [execPath, resolved] : [resolved];
  }
  return [...base, "notify-daemon-run"];
}

export type SpawnLike = (cmd: string[], cwd: string) => { unref(): void };

const defaultSpawn: SpawnLike = (cmd, cwd) => {
  fsSync.mkdirSync(notifyDir(), { recursive: true, mode: 0o700 });
  const logFd = fsSync.openSync(notifyDaemonLogPath(), "a");
  // node:child_process with detached:true (NOT Bun.spawn) — same rationale as
  // memory.ts's spawnDetachedDistill: the child needs its own session/process
  // group so a closing terminal/tmux pane does not kill it before it's ready.
  const child = nodeSpawn(cmd[0]!, cmd.slice(1), { cwd, detached: true, stdio: ["ignore", logFd, logFd] });
  return { unref: () => child.unref() };
};

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise(r => setTimeout(r, stepMs));
  }
  return false;
}

export async function startDaemon(spawnImpl: SpawnLike = defaultSpawn): Promise<{ ok: boolean; pid?: number; message: string }> {
  const existing = await readDaemonLock();
  if (existing && isPidAlive(existing.pid)) {
    return { ok: true, pid: existing.pid, message: `daemon already running (pid ${existing.pid})` };
  }
  // Check BEFORE spawning: an unconfigured daemon exits almost immediately (see
  // `runNotifyDaemonForeground`), which races the readiness poll below and used to
  // surface a misleading "did not report ready" — refuse early with a clear message.
  if (!(await isNotifyConfigured())) {
    return { ok: false, message: "notifications not configured — run 'jeo notify setup' first." };
  }

  const cmd = daemonInvocation(process.argv[1], process.execPath, process.cwd());
  spawnImpl(cmd, process.cwd()).unref();
  const ready = await waitFor(async () => {
    const lock = await readDaemonLock();
    return Boolean(lock && isPidAlive(lock.pid));
  }, 2_000);
  if (!ready) return { ok: false, message: `daemon did not report ready within 2s — check ${notifyDaemonLogPath()}` };
  const lock = await readDaemonLock();
  return { ok: true, pid: lock?.pid, message: `daemon started (pid ${lock?.pid})` };
}

export async function stopDaemon(): Promise<{ ok: boolean; message: string }> {
  const lock = await readDaemonLock();
  if (!lock || !isPidAlive(lock.pid)) {
    await fs.unlink(notifyDaemonLockPath()).catch(() => {});
    return { ok: true, message: "daemon was not running" };
  }
  try {
    process.kill(lock.pid, "SIGTERM");
  } catch (err) {
    return { ok: false, message: `failed to signal pid ${lock.pid}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const stopped = await waitFor(async () => !isPidAlive(lock.pid), 3_000);
  if (!stopped) return { ok: false, message: `daemon (pid ${lock.pid}) did not exit within 3s` };
  await fs.unlink(notifyDaemonLockPath()).catch(() => {});
  return { ok: true, message: `daemon stopped (was pid ${lock.pid})` };
}

export async function reloadDaemon(spawnImpl: SpawnLike = defaultSpawn): Promise<{ ok: boolean; message: string }> {
  const stopRes = await stopDaemon();
  const startRes = await startDaemon(spawnImpl);
  return { ok: startRes.ok, message: `${stopRes.message}; ${startRes.message}` };
}
