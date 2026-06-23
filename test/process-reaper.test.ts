import { test, expect } from "bun:test";
import {
  killSpec,
  BackgroundReaper,
  isBackgroundReapEnabled,
  reapIntervalMs,
} from "../src/agent/process-reaper";

test("killSpec: a grouped (POSIX detached) shell targets its whole process group", () => {
  expect(killSpec({ pid: 4321, grouped: true }, "linux")).toBe(-4321);
  expect(killSpec({ pid: 4321, grouped: true }, "darwin")).toBe(-4321);
});

test("killSpec: a non-grouped shell targets only the bare pid (group-kill would hit jeo)", () => {
  expect(killSpec({ pid: 4321, grouped: false }, "linux")).toBe(4321);
});

test("killSpec: Windows has no POSIX groups so it never negates the pid", () => {
  expect(killSpec({ pid: 4321, grouped: true }, "win32")).toBe(4321);
});

/** A fake process.kill that records targets and reports liveness from a set. */
function fakeKill(aliveTargets: Set<number>, log: Array<{ target: number; signal: unknown }>) {
  return (pid: number, signal?: string | number) => {
    log.push({ target: pid, signal });
    if (signal === 0) {
      // Liveness probe: ESRCH if the target is not alive.
      if (!aliveTargets.has(pid)) throw new Error("ESRCH");
      return;
    }
    aliveTargets.delete(pid); // a real signal terminates the group
  };
}

test("register ignores init/sentinel pids that a group-kill must never target", () => {
  const r = new BackgroundReaper({ kill: () => {}, platform: "linux" });
  for (const pid of [0, 1, -1, 1.5]) r.register({ pid, grouped: true });
  expect(r.size).toBe(0);
  r.register({ pid: 2, grouped: true });
  expect(r.size).toBe(1);
});

test("reap SIGKILLs each live group and reports the reaped pids", () => {
  const alive = new Set<number>([-100, -200]); // both groups alive (negated pgids)
  const log: Array<{ target: number; signal: unknown }> = [];
  const r = new BackgroundReaper({ kill: fakeKill(alive, log), platform: "linux" });
  r.register({ pid: 100, grouped: true }, "next dev");
  r.register({ pid: 200, grouped: true }, "vite");

  const reaped = r.reap();
  expect(reaped.sort()).toEqual([100, 200]);
  // Each group got a liveness probe (signal 0) then a SIGKILL on the negated pgid.
  expect(log).toContainEqual({ target: -100, signal: 0 });
  expect(log).toContainEqual({ target: -100, signal: "SIGKILL" });
  expect(log).toContainEqual({ target: -200, signal: "SIGKILL" });
  expect(r.size).toBe(0); // reaping forgets the groups
});

test("reap skips a group whose members already exited (no stray SIGKILL)", () => {
  const alive = new Set<number>(); // dead group: signal-0 probe throws ESRCH
  const log: Array<{ target: number; signal: unknown }> = [];
  const r = new BackgroundReaper({ kill: fakeKill(alive, log), platform: "linux" });
  r.register({ pid: 300, grouped: true });

  expect(r.reap()).toEqual([]); // nothing alive to reap
  expect(log).toEqual([{ target: -300, signal: 0 }]); // probe only, never a SIGKILL
  expect(r.size).toBe(0); // still forgotten
});

test("reap({olderThanMs}) gives a young background child a grace window", () => {
  let clock = 1_000;
  const alive = new Set<number>([-400]);
  const log: Array<{ target: number; signal: unknown }> = [];
  const r = new BackgroundReaper({ kill: fakeKill(alive, log), now: () => clock, platform: "linux" });
  r.register({ pid: 400, grouped: true }); // registered at t=1000

  clock = 1_500; // 500ms later, grace is 1000ms ⇒ too young
  expect(r.reap({ olderThanMs: 1_000 })).toEqual([]);
  expect(r.size).toBe(1); // retained for a later sweep

  clock = 2_100; // now older than the grace window ⇒ reaped
  expect(r.reap({ olderThanMs: 1_000 })).toEqual([400]);
});

test("reapOne reaps a single tracked group and unregisters it", () => {
  const alive = new Set<number>([-500]);
  const log: Array<{ target: number; signal: unknown }> = [];
  const r = new BackgroundReaper({ kill: fakeKill(alive, log), platform: "linux" });
  r.register({ pid: 500, grouped: true });

  expect(r.reapOne(500)).toBe(true);
  expect(r.size).toBe(0);
  expect(r.reapOne(500)).toBe(false); // already gone
  expect(r.reapOne(999)).toBe(false); // never tracked
});

test("isBackgroundReapEnabled is on by default and only KEEP_BACKGROUND=1 opts out", () => {
  expect(isBackgroundReapEnabled({})).toBe(true);
  expect(isBackgroundReapEnabled({ JEO_KEEP_BACKGROUND: "1" })).toBe(false);
  expect(isBackgroundReapEnabled({ JEO_KEEP_BACKGROUND: "0" })).toBe(true);
});

test("reapIntervalMs defaults to 30s, honors a valid override, and rejects junk", () => {
  expect(reapIntervalMs({})).toBe(30_000);
  expect(reapIntervalMs({ JEO_REAP_INTERVAL_MS: "5000" })).toBe(5_000);
  expect(reapIntervalMs({ JEO_REAP_INTERVAL_MS: "0" })).toBe(0); // disables the timer
  expect(reapIntervalMs({ JEO_REAP_INTERVAL_MS: "-5" })).toBe(30_000);
  expect(reapIntervalMs({ JEO_REAP_INTERVAL_MS: "nope" })).toBe(30_000);
});
