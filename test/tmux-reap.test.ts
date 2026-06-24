import { test, expect } from "bun:test";
import {
  parseTmuxSessionList,
  selectReapableTmuxSessions,
  tmuxReapEnabled,
  tmuxReapIdleMs,
  reapStaleTmuxSessions,
  TMUX_REAP_LIST_FORMAT,
  type TmuxSessionInfo,
} from "../src/commands/launch/tmux";

const NOW_SEC = 1_782_252_314;
const NOW_MS = NOW_SEC * 1000;
const HOUR = 3600;

test("TMUX_REAP_LIST_FORMAT is tab-separated and carries the @jeo-profile marker", () => {
  expect(TMUX_REAP_LIST_FORMAT).toContain("\t");
  expect(TMUX_REAP_LIST_FORMAT).toContain("#{session_name}");
  expect(TMUX_REAP_LIST_FORMAT).toContain("#{session_attached}");
  expect(TMUX_REAP_LIST_FORMAT).toContain("#{session_activity}");
  expect(TMUX_REAP_LIST_FORMAT).toContain("#{@jeo-profile}");
});

test("parseTmuxSessionList parses fields, blank lines, and a missing/empty marker", () => {
  const raw = [
    `jeo-dev-abc\t1\t${NOW_SEC}\t1`,
    "", // blank line is skipped
    `jeo-old-xyz\t0\t${NOW_SEC - 10 * HOUR}\t1`,
    `user-shell\t0\t${NOW_SEC}\t`, // no jeo marker
    "   ", // whitespace-only line is skipped
  ].join("\n");
  const parsed = parseTmuxSessionList(raw);
  expect(parsed).toHaveLength(3);
  expect(parsed[0]).toEqual({ name: "jeo-dev-abc", attached: true, activitySec: NOW_SEC, jeoOwned: true } satisfies TmuxSessionInfo);
  expect(parsed[1]).toEqual({ name: "jeo-old-xyz", attached: false, activitySec: NOW_SEC - 10 * HOUR, jeoOwned: true });
  expect(parsed[2]).toEqual({ name: "user-shell", attached: false, activitySec: NOW_SEC, jeoOwned: false });
});

test("parseTmuxSessionList coerces a non-numeric activity to 0", () => {
  const parsed = parseTmuxSessionList("jeo-x\t0\tnotanumber\t1");
  expect(parsed[0]!.activitySec).toBe(0);
});

const sessions: TmuxSessionInfo[] = [
  { name: "jeo-attached-idle", attached: true, activitySec: NOW_SEC - 20 * HOUR, jeoOwned: true },
  { name: "jeo-detached-fresh", attached: false, activitySec: NOW_SEC - 1 * HOUR, jeoOwned: true },
  { name: "jeo-detached-stale", attached: false, activitySec: NOW_SEC - 20 * HOUR, jeoOwned: true },
  { name: "foreign-detached-stale", attached: false, activitySec: NOW_SEC - 20 * HOUR, jeoOwned: false },
  { name: "jeo-just-created", attached: false, activitySec: NOW_SEC - 20 * HOUR, jeoOwned: true },
];

test("selectReapableTmuxSessions reaps only jeo-owned, unattached, long-idle sessions", () => {
  const reapable = selectReapableTmuxSessions(sessions, { nowSec: NOW_SEC, idleMs: 6 * HOUR * 1000 });
  expect(reapable).toEqual(["jeo-detached-stale", "jeo-just-created"]);
});

test("selectReapableTmuxSessions never reaps a session in `keep` (the one about to attach)", () => {
  const reapable = selectReapableTmuxSessions(sessions, {
    nowSec: NOW_SEC,
    idleMs: 6 * HOUR * 1000,
    keep: ["jeo-just-created"],
  });
  expect(reapable).toEqual(["jeo-detached-stale"]);
});

test("selectReapableTmuxSessions never reaps an attached session even when long idle", () => {
  const onlyAttached: TmuxSessionInfo[] = [
    { name: "jeo-attached-very-idle", attached: true, activitySec: NOW_SEC - 1000 * HOUR, jeoOwned: true },
  ];
  expect(selectReapableTmuxSessions(onlyAttached, { nowSec: NOW_SEC, idleMs: 0 })).toEqual([]);
});

test("selectReapableTmuxSessions respects the idle boundary (>= threshold)", () => {
  const s: TmuxSessionInfo[] = [
    { name: "exactly-6h", attached: false, activitySec: NOW_SEC - 6 * HOUR, jeoOwned: true },
    { name: "just-under-6h", attached: false, activitySec: NOW_SEC - (6 * HOUR - 1), jeoOwned: true },
  ];
  expect(selectReapableTmuxSessions(s, { nowSec: NOW_SEC, idleMs: 6 * HOUR * 1000 })).toEqual(["exactly-6h"]);
});

test("tmuxReapEnabled is on by default and off only for JEO_TMUX_REAP=0", () => {
  expect(tmuxReapEnabled({})).toBe(true);
  expect(tmuxReapEnabled({ JEO_TMUX_REAP: "1" })).toBe(true);
  expect(tmuxReapEnabled({ JEO_TMUX_REAP: "0" })).toBe(false);
});

test("tmuxReapIdleMs defaults to 6h and honors a valid override; invalid falls back", () => {
  expect(tmuxReapIdleMs({})).toBe(6 * 60 * 60 * 1000);
  expect(tmuxReapIdleMs({ JEO_TMUX_REAP_IDLE_MS: "1000" })).toBe(1000);
  expect(tmuxReapIdleMs({ JEO_TMUX_REAP_IDLE_MS: "0" })).toBe(0);
  expect(tmuxReapIdleMs({ JEO_TMUX_REAP_IDLE_MS: "nope" })).toBe(6 * 60 * 60 * 1000);
  expect(tmuxReapIdleMs({ JEO_TMUX_REAP_IDLE_MS: "-5" })).toBe(6 * 60 * 60 * 1000);
});

test("reapStaleTmuxSessions kills the stale jeo sessions and skips `keep`", () => {
  const killed: string[] = [];
  const raw = [
    `jeo-keep-me\t0\t${NOW_SEC - 20 * HOUR}\t1`,
    `jeo-stale\t0\t${NOW_SEC - 20 * HOUR}\t1`,
    `jeo-attached\t1\t${NOW_SEC - 20 * HOUR}\t1`,
    `user-stale\t0\t${NOW_SEC - 20 * HOUR}\t`,
  ].join("\n");
  const reaped = reapStaleTmuxSessions("/usr/bin/tmux", ["jeo-keep-me"], {
    env: {},
    now: () => NOW_MS,
    list: () => raw,
    kill: name => killed.push(name),
  });
  expect(reaped).toEqual(["jeo-stale"]);
  expect(killed).toEqual(["jeo-stale"]);
});

test("reapStaleTmuxSessions is a no-op when disabled via JEO_TMUX_REAP=0 (never lists)", () => {
  let listed = false;
  const reaped = reapStaleTmuxSessions("/usr/bin/tmux", [], {
    env: { JEO_TMUX_REAP: "0" },
    list: () => { listed = true; return "jeo-stale\t0\t0\t1"; },
    kill: () => {},
    now: () => NOW_MS,
  });
  expect(reaped).toEqual([]);
  expect(listed).toBe(false);
});

test("reapStaleTmuxSessions returns [] when listing fails (no tmux server)", () => {
  let killed = false;
  const reaped = reapStaleTmuxSessions("/usr/bin/tmux", [], {
    env: {},
    list: () => null,
    kill: () => { killed = true; },
    now: () => NOW_MS,
  });
  expect(reaped).toEqual([]);
  expect(killed).toBe(false);
});

test("reapStaleTmuxSessions honors a custom idle TTL override", () => {
  const killed: string[] = [];
  const raw = [
    `jeo-2h\t0\t${NOW_SEC - 2 * HOUR}\t1`,
    `jeo-30m\t0\t${NOW_SEC - 1800}\t1`,
  ].join("\n");
  const reaped = reapStaleTmuxSessions("/usr/bin/tmux", [], {
    env: { JEO_TMUX_REAP_IDLE_MS: String(HOUR * 1000) }, // 1h threshold
    now: () => NOW_MS,
    list: () => raw,
    kill: name => killed.push(name),
  });
  expect(reaped).toEqual(["jeo-2h"]);
  expect(killed).toEqual(["jeo-2h"]);
});
