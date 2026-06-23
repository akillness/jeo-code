/**
 * Background-process reaper for the bash tool (src/agent/tools.ts:bashTool).
 *
 * THE LEAK IT CLOSES
 * ------------------
 * When a model command backgrounds a long-lived grandchild — `npm run dev &`,
 * `next dev &`, a daemon, `nohup …` — the bash SHELL exits immediately but the
 * grandchild is reparented to init (PID 1) and keeps running. jeo's bash tool
 * kills the shell, not the subtree, so on Linux that grandchild survives every
 * turn. Each `next dev` restart that doesn't kill its predecessor leaves another
 * live `next-server` holding hundreds of MB; across a session the resident set
 * climbs monotonically — the reported "next-server 메모리 점유율이 점점 높아진다".
 *
 * THE FIX (more efficient than name-based periodic `pkill`)
 * --------------------------------------------------------
 * bashTool now spawns each command as its OWN process-group leader (Bun.spawn
 * `detached:true` ⇒ pgid == shell pid on POSIX). A backgrounded grandchild joins
 * that group, so the whole subtree is reachable by a single `process.kill(-pgid)`
 * WITHOUT touching jeo (which lives in a different group). Reaping is therefore:
 *   - PRECISE   — only groups jeo itself spawned, never a `pkill -f next-server`
 *                 that could nuke a dev server the user runs in another terminal;
 *   - O(1)      — one group signal, no full process-table scan per sweep;
 *   - DETERMINISTIC — the leak is closed at the exact turn boundary that creates
 *                 it, so steady-state cost is zero (the periodic sweep below is a
 *                 belt-and-suspenders net for turns that abort before cleanup).
 *
 * This module is the pure, injectable core: `killSpec` decides the signal target
 * and `BackgroundReaper` tracks groups + reaps the orphaned ones. All OS effects
 * (`kill`, the clock) are injected so the selection logic is unit-testable.
 */

import { jeoEnv } from "../util/env";

export type KillFn = (pid: number, signal?: string | number) => void;

/** A spawned shell tracked for reaping. `grouped` is true when it leads its own
 *  process group (POSIX detached spawn) and can be signalled as `-pid`. */
export interface ReapTarget {
  /** Shell pid; equals the process-group id when `grouped` (detached) is true. */
  pid: number;
  /** Spawned as a process-group leader (POSIX detached) — group-killable. */
  grouped: boolean;
}

/**
 * The argument to pass to `process.kill`: the NEGATED pgid to signal the whole
 * group (reaping backgrounded grandchildren) when the shell leads its own group,
 * or the bare pid otherwise. A group-kill is only safe when `grouped` — signalling
 * `-pid` of a non-leader would hit jeo's own group and self-terminate the agent;
 * Windows has no POSIX process groups, so it always falls back to the bare pid.
 */
export function killSpec(target: ReapTarget, platform: NodeJS.Platform = process.platform): number {
  if (target.grouped && platform !== "win32") return -target.pid;
  return target.pid;
}

interface GroupRecord extends ReapTarget {
  /** Short human label (the command head) for diagnostics. */
  label: string;
  registeredAt: number;
}

export interface ReaperDeps {
  /** Inject for tests; defaults to process.kill. Signal `0` is a liveness probe. */
  kill?: KillFn;
  now?: () => number;
  platform?: NodeJS.Platform;
}

/**
 * Tracks process groups jeo's bash tool spawned and reaps the ones still alive.
 * Registration happens when a command leaves a lingering background grandchild;
 * `reap()` SIGKILLs each registered group that is still alive and forgets it.
 */
export class BackgroundReaper {
  private groups = new Map<number, GroupRecord>();
  private readonly kill: KillFn;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;

  constructor(deps: ReaperDeps = {}) {
    this.kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal as NodeJS.Signals));
    this.now = deps.now ?? Date.now;
    this.platform = deps.platform ?? process.platform;
  }

  get size(): number {
    return this.groups.size;
  }

  /** Track a spawned shell's group as a reap candidate (idempotent per pid). */
  register(target: ReapTarget, label = ""): void {
    if (!Number.isInteger(target.pid) || target.pid <= 1) return; // never 0/-1/1 (init)
    this.groups.set(target.pid, { ...target, label: label.slice(0, 80), registeredAt: this.now() });
  }

  /** Forget a group (e.g. the command cleaned itself up). */
  unregister(pid: number): void {
    this.groups.delete(pid);
  }

  /** True if any process in the target's group is still alive (signal-0 probe). */
  private isAlive(rec: ReapTarget): boolean {
    try {
      this.kill(killSpec(rec, this.platform), 0);
      return true;
    } catch {
      return false; // ESRCH ⇒ nothing left in the group
    }
  }

  /** Best-effort SIGKILL of one tracked group; returns true if a signal landed. */
  reapOne(pid: number): boolean {
    const rec = this.groups.get(pid);
    if (!rec) return false;
    this.groups.delete(pid);
    if (!this.isAlive(rec)) return false;
    try {
      this.kill(killSpec(rec, this.platform), "SIGKILL");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reap tracked groups. Default: only groups still alive (the leaked orphans).
   * `olderThanMs` limits reaping to groups registered before now-olderThanMs, so a
   * brand-new turn's background child gets a grace window before the periodic sweep
   * claims it. Returns the pids that received a kill.
   */
  reap(opts: { olderThanMs?: number } = {}): number[] {
    const reaped: number[] = [];
    const cutoff = opts.olderThanMs != null ? this.now() - opts.olderThanMs : Infinity;
    for (const [pid, rec] of [...this.groups]) {
      if (rec.registeredAt > cutoff) continue;
      this.groups.delete(pid);
      if (!this.isAlive(rec)) continue;
      try {
        this.kill(killSpec(rec, this.platform), "SIGKILL");
        reaped.push(pid);
      } catch {
        /* group vanished between probe and kill — fine */
      }
    }
    return reaped;
  }

  /** Drop all tracking without signalling (used when reaping is disabled). */
  clear(): void {
    this.groups.clear();
  }
}

/** Process-group spawning + background reaping are on unless opted out. */
export function isBackgroundReapEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return jeoEnv("KEEP_BACKGROUND", env) !== "1";
}

/** Periodic-sweep cadence; 0/invalid disables the timer (deterministic reap still runs). */
export function reapIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = jeoEnv("REAP_INTERVAL_MS", env);
  if (raw == null) return 30_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
}

/** Shared session-scoped reaper used by the bash tool. */
export const backgroundReaper = new BackgroundReaper();

let sweeper: ReturnType<typeof setInterval> | undefined;

/**
 * Lazily start the periodic safety-net sweep (idempotent). It reaps any tracked
 * group that outlived a grace window — covering turns that abort before their
 * deterministic finally-block reap runs. The timer is `unref`'d so it never keeps
 * the process alive, and a 0 interval (or KEEP_BACKGROUND=1) skips it entirely.
 */
export function ensureBackgroundSweeper(
  reaper: BackgroundReaper = backgroundReaper,
  env: Record<string, string | undefined> = process.env,
): void {
  if (sweeper || !isBackgroundReapEnabled(env)) return;
  const interval = reapIntervalMs(env);
  if (interval <= 0) return;
  sweeper = setInterval(() => {
    // Grace = one interval: a background child younger than this is left for its
    // own turn's finally-block to reap, so the sweep only claims true orphans.
    reaper.reap({ olderThanMs: interval });
  }, interval);
  (sweeper as { unref?: () => void }).unref?.();
}

/** Stop the periodic sweep (tests / shutdown). */
export function stopBackgroundSweeper(): void {
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
}
