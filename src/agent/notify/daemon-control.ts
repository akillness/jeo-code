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
  purpose?: "daemon" | "pairing";
  ready?: boolean;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function parseEtimeToMs(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const dayMatch = trimmed.match(/^(\d+)-(.+)$/);
  let days = 0;
  let rest = trimmed;
  if (dayMatch) {
    days = Number(dayMatch[1]);
    rest = dayMatch[2]!;
  }
  const parts = rest.split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some(n => !Number.isFinite(n))) return undefined;
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0]!, parts[1]!];
  return ((days * 24 + h!) * 60 + m!) * 60 * 1000 + s! * 1000;
}

/**
 * Read a process's start time from `/proc` — Linux only, no subprocess.
 *
 * Field 22 of `/proc/<pid>/stat` is the process start time in clock ticks since
 * boot; `/proc/uptime` gives seconds since boot. Together they yield an epoch
 * timestamp WITHOUT spawning anything. That matters because the `ps` path below is
 * exactly what disappears in the environments a Telegram daemon actually runs in:
 * distroless and scratch containers ship no `ps`, and hardened sandboxes/seccomp
 * profiles routinely block the setuid `/bin/ps`. When the lookup dies there, the
 * PID-reuse guard silently degrades to a bare `kill(pid, 0)` — see
 * {@link isLockOwnerAlive} for why that is the dangerous case.
 *
 * The 22nd field is parsed from the LAST `)` rather than by splitting on spaces:
 * field 2 is the executable name in parentheses and may itself contain spaces.
 */
function procStartTimeMs(pid: number): number | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf-8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
    const fields = afterComm.split(" ");
    // stat field 22 (1-based) == index 19 of the post-comm remainder (fields 3+).
    const startTicks = Number(fields[19]);
    if (!Number.isFinite(startTicks)) return undefined;
    const uptimeSec = Number(fsSync.readFileSync("/proc/uptime", "utf-8").split(" ")[0]);
    if (!Number.isFinite(uptimeSec)) return undefined;
    // USER_HZ is 100 on every Linux ABI that matters; sysconf(_SC_CLK_TCK) is not
    // reachable without a native addon, and jeo is zero-native-dependency by design.
    const startSecSinceBoot = startTicks / 100;
    const bootEpochMs = Date.now() - uptimeSec * 1000;
    return bootEpochMs + startSecSinceBoot * 1000;
  } catch {
    return undefined;
  }
}

/** Best-effort actual OS process start time in epoch ms. Tries `/proc` first (Linux,
 *  no subprocess, works in distroless/sandboxed containers), then `ps -o etime=`
 *  (POSIX-portable across macOS/Linux; unsupported on Windows, where there is no
 *  equivalent zero-dependency lookup). Returns `undefined` when the lookup is
 *  unavailable or unparseable — callers MUST treat that as "cannot verify" and fall
 *  back to the existence-only check, not as "dead". */
export async function processStartTimeMs(pid: number): Promise<number | undefined> {
  if (process.platform === "win32") return undefined;
  const viaProc = procStartTimeMs(pid);
  if (viaProc !== undefined) return viaProc;
  const output = await new Promise<string | undefined>(resolve => {
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = nodeSpawn("ps", ["-o", "etime=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(undefined);
      return;
    }
    let buf = "";
    child.stdout?.on("data", d => { buf += d; });
    child.on("error", () => resolve(undefined));
    child.on("close", code => resolve(code === 0 ? buf : undefined));
  });
  if (output === undefined) return undefined;
  const ms = parseEtimeToMs(output);
  return ms === undefined ? undefined : Date.now() - ms;
}

/** True when this host can actually verify a process's start time. Exported so
 *  status output (and tests) can distinguish "the guard says the owner is alive"
 *  from "the guard could not check" instead of conflating the two. */
export async function canVerifyProcessStartTime(): Promise<boolean> {
  return (await processStartTimeMs(process.pid)) !== undefined;
}

/** `etime` is truncated to whole seconds and adds a little spawn/poll jitter;
 *  genuine PID reuse shows up as a gap of minutes/hours/days, never a few
 *  seconds, so a generous-but-tight tolerance loses no real detections. */
const START_TIME_TOLERANCE_MS = 10_000;

/** Stronger alternative to a bare `isPidAlive(lock.pid)`: also cross-checks
 *  the recorded `startedAt` against the OS-reported actual process start
 *  time to rule out PID reuse — a dead daemon's pid can be reassigned by the
 *  OS to a completely unrelated process before the next status/stop check
 *  runs, which `kill(pid, 0)` alone cannot distinguish (gjc #2786 parity:
 *  "restore macOS daemon signaling (kill(2) + start-time recheck)"). Falls
 *  back to the existence-only result whenever the OS lookup itself is
 *  unavailable (Windows, `ps` missing, permission denied) — never a
 *  regression versus the old behavior in that case. */
export async function isLockOwnerAlive(lock: DaemonLockInfo): Promise<boolean> {
  return (await inspectLockOwner(lock)).alive;
}

/** Whether the recorded owner is alive, AND whether that answer was actually
 *  verified against the OS start time or merely assumed from `kill(pid, 0)`. */
export interface LockOwnerCheck {
  alive: boolean;
  /** False when the host could not report the process start time (no `/proc`,
   *  no usable `ps`, Windows) — `alive` is then an existence-only guess. */
  verified: boolean;
}

export async function inspectLockOwner(lock: DaemonLockInfo): Promise<LockOwnerCheck> {
  if (!isPidAlive(lock.pid)) return { alive: false, verified: true };
  const real = await processStartTimeMs(lock.pid);
  if (real === undefined) return { alive: true, verified: false };
  return { alive: Math.abs(real - lock.startedAt) <= START_TIME_TOLERANCE_MS, verified: true };
}

export async function readDaemonLock(): Promise<DaemonLockInfo | undefined> {
  try {
    const raw = await fs.readFile(notifyDaemonLockPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<DaemonLockInfo>;
    if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "number") return undefined;
    if (!Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 || !Number.isFinite(parsed.startedAt)) return undefined;
    return { pid: parsed.pid, startedAt: parsed.startedAt, purpose: parsed.purpose, ready: parsed.ready };
  } catch {
    return undefined;
  }
}

async function interruptedRecoveryMessage(): Promise<string | undefined> {
  const guard = `${notifyDaemonLockPath()}.reclaim`;
  const stat = await fs.stat(guard).catch(() => undefined);
  if (stat && Date.now() - stat.mtimeMs >= 30_000) {
    return `Notification lock recovery is blocked by ${guard}. Stop all daemon/pairing processes and verify their owners are gone before manually removing this recovery guard; it is not automatically deleted because that can race a live lock owner.`;
  }
  return undefined;
}

/** Exclusive process lock shared with Telegram pairing, which also owns getUpdates. */
export async function acquireDaemonLock(purpose: "daemon" | "pairing" = "daemon"): Promise<{ release: () => Promise<void>; markReady: () => Promise<void> } | undefined> {
  await fs.mkdir(notifyDir(), { recursive: true, mode: 0o700 });
  const lockPath = notifyDaemonLockPath();
  let contents = JSON.stringify({ pid: process.pid, startedAt: await processStartTimeMs(process.pid) ?? Date.now(), purpose, ready: false, owner: crypto.randomUUID() });
  const create = async () => {
    // Publish a fully written record atomically; a killed writer cannot leave partial JSON.
    const tmp = `${lockPath}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, contents, { mode: 0o600, flag: "wx" });
      await fs.link(tmp, lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally { await fs.unlink(tmp).catch(() => {}); }
  };
  if (!(await create())) {
    // Serialize stale-owner reclamation so a second contender cannot unlink the winner.
    let reclaim: fs.FileHandle;
    try { reclaim = await fs.open(`${lockPath}.reclaim`, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const blocked = await interruptedRecoveryMessage();
        if (blocked) throw new Error(blocked);
        return undefined;
      }
      throw error;
    }
    try {
      const existing = await readDaemonLock();
      if (existing && await isLockOwnerAlive(existing)) return undefined;
      // Recover legacy malformed locks only after a grace period for old writers.
      if (!existing && Date.now() - (await fs.stat(lockPath)).mtimeMs < 30_000) return undefined;
      await fs.unlink(lockPath);
      if (!(await create())) return undefined;
    } finally {
      await reclaim.close();
      await fs.unlink(`${lockPath}.reclaim`).catch(() => {});
    }
  }
  return {
    markReady: async () => {
      if (await fs.readFile(lockPath, "utf-8").catch(() => "") !== contents) throw new Error("Notification daemon lost lock ownership during startup");
      const next = JSON.stringify({ ...JSON.parse(contents), ready: true });
      const tmp = `${lockPath}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(tmp, next, { mode: 0o600, flag: "wx" });
        await fs.rename(tmp, lockPath);
        contents = next;
      } finally { await fs.unlink(tmp).catch(() => {}); }
    },
    release: async () => {
      // An old release closure must not remove a newer owner's lock.
      if (await fs.readFile(lockPath, "utf-8").catch(() => "") === contents) await fs.unlink(lockPath).catch(() => {});
    },
  };
}

export interface DaemonStatus {
  /** Master toggle and at least one complete, authorized transport. */
  configured: boolean;
  running: boolean;
  pairing?: boolean;
  ready?: boolean;
  /** A lock file exists but its pid is dead — a previous daemon crashed without cleanup. */
  stale: boolean;
  pid?: number;
  startedAt?: number;
  /** False when this host cannot report a process start time (no `/proc`, no usable
   *  `ps`, Windows), so `running` is an existence-only guess that cannot rule out PID
   *  reuse. Present only when a lock file exists. */
  ownerVerified?: boolean;
}

export async function isNotifyConfigured(): Promise<boolean> {
  const config = await readGlobalConfig();
  const n = config.notifications;
  return Boolean(n?.enabled && (
    (n.telegram?.botToken && n.telegram.chatId) ||
    (n.discord?.botToken && n.discord.channelId && n.discord.allowedUserIds?.length) ||
    (n.slack?.botToken && n.slack.appToken && n.slack.channelId && n.slack.allowedUserIds?.length)
  ));
}

export async function daemonStatus(): Promise<DaemonStatus> {
  const [lock, configured] = await Promise.all([readDaemonLock(), isNotifyConfigured()]);
  if (!lock) return { configured, running: false, stale: false };
  const { alive, verified } = await inspectLockOwner(lock);
  // Surface the degraded case instead of hiding it: on a host with no `/proc` and no
  // usable `ps`, "running" is an existence-only guess that cannot rule out PID reuse.
  return { configured, running: alive && lock.purpose !== "pairing", pairing: alive && lock.purpose === "pairing", ready: alive && lock.ready === true, stale: !alive, pid: lock.pid, startedAt: lock.startedAt, ownerVerified: verified };
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
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, stepMs);
    await promise;
  }
  return false;
}

export async function startDaemon(spawnImpl: SpawnLike = defaultSpawn, waitImpl: (predicate: () => Promise<boolean>, timeoutMs: number) => Promise<boolean> = waitFor): Promise<{ ok: boolean; pid?: number; message: string }> {
  const existing = await readDaemonLock();
  if (existing && (await isLockOwnerAlive(existing))) {
    if (existing.purpose === "pairing") return { ok: false, message: "Telegram pairing currently owns the notification lock; finish setup first." };
    return { ok: existing.ready === true, pid: existing.pid, message: `daemon ${existing.ready !== true ? "is still initializing" : "already running"} (pid ${existing.pid}); connectivity not checked` };
  }
  // Check BEFORE spawning: an unconfigured daemon exits almost immediately (see
  // `runNotifyDaemonForeground`), which races the readiness poll below and used to
  // surface a misleading "did not report ready" — refuse early with a clear message.
  if (!(await isNotifyConfigured())) {
    return { ok: false, message: "notifications not configured — run 'jeo notify setup' first." };
  }

  const blocked = await interruptedRecoveryMessage();
  if (blocked) return { ok: false, message: blocked };

  const cmd = daemonInvocation(process.argv[1], process.execPath, process.cwd());
  spawnImpl(cmd, process.cwd()).unref();
  const ready = await waitImpl(async () => {
    const lock = await readDaemonLock();
    return Boolean(lock && lock.purpose === "daemon" && lock.ready === true && isPidAlive(lock.pid));
  }, 15_000);
  if (!ready) return { ok: false, message: `daemon did not initialize within 15s — check ${notifyDaemonLogPath()}` };
  const lock = await readDaemonLock();
  return { ok: true, pid: lock?.pid, message: `daemon initialized (pid ${lock?.pid}); use notify health to check platform access` };
}

async function removeStoppedLock(expected: DaemonLockInfo): Promise<void> {
  const lockPath = notifyDaemonLockPath();
  let guard: fs.FileHandle;
  try { guard = await fs.open(`${lockPath}.reclaim`, "wx", 0o600); }
  catch (error) {
    if (["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
  try {
    const current = await readDaemonLock();
    if (current?.pid === expected.pid && current.startedAt === expected.startedAt && !(await isLockOwnerAlive(current))) await fs.unlink(lockPath).catch(() => {});
  } finally {
    await guard.close();
    await fs.unlink(`${lockPath}.reclaim`).catch(() => {});
  }
}

export async function stopDaemon(): Promise<{ ok: boolean; message: string }> {
  const lock = await readDaemonLock();
  const owner = lock ? await inspectLockOwner(lock) : undefined;
  if (!lock || !owner?.alive) {
    if (lock) await removeStoppedLock(lock);
    return { ok: true, message: "daemon was not running" };
  }
  if (lock.purpose === "pairing") return { ok: false, message: "Telegram pairing is active; cancel setup in its terminal first." };
  try {
    process.kill(lock.pid, "SIGTERM");
  } catch (err) {
    return { ok: false, message: `failed to signal pid ${lock.pid}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const stopped = await waitFor(async () => !isPidAlive(lock.pid), 3_000);
  if (!stopped) return { ok: false, message: `daemon (pid ${lock.pid}) did not exit within 3s` };
  await removeStoppedLock(lock);
  const caveat = owner.verified ? "" : " (start time unverifiable on this host — PID reuse could not be ruled out)";
  return { ok: true, message: `daemon stopped (was pid ${lock.pid})${caveat}` };
}

export async function reloadDaemon(spawnImpl: SpawnLike = defaultSpawn, stopImpl: typeof stopDaemon = stopDaemon): Promise<{ ok: boolean; message: string }> {
  const stopRes = await stopImpl();
  if (!stopRes.ok) return stopRes;
  const startRes = await startDaemon(spawnImpl);
  return { ok: startRes.ok, message: `${stopRes.message}; ${startRes.message}` };
}
