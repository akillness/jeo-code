import { test, expect } from "bun:test";
import { LaunchTui } from "../src/tui/app";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

type TuiInternals = {
  currentActivity: () => string;
  activityLog: { at: number; line: string }[];
  timer: ReturnType<typeof setInterval>;
};

function makeTui(): { tui: LaunchTui; internals: TuiInternals } {
  const tui = new LaunchTui({ model: "m1", write: () => {} });
  tui.start();
  return { tui, internals: tui as unknown as TuiInternals };
}

// ── Subagent live activity in the status row ───────────────────────────────
// A long `task` previously rendered a static "Task: executor …" (or a bare
// "calling model") for its whole duration — the perceived-stall usability gap.
// The status row now mirrors the subagent's LATEST nested event.

test("status activity mirrors the latest subagent event while a task runs", () => {
  const { tui, internals } = makeTui();
  try {
    tui.onSubagentEvent({ kind: "start", role: "executor", detail: "inspect engine.ts" });
    expect(strip(internals.currentActivity())).toContain("EXECUTOR");
    expect(strip(internals.currentActivity())).toContain("inspect engine.ts");

    tui.onSubagentEvent({ kind: "tool", role: "executor", detail: "read src/agent/engine.ts", success: true });
    const live = strip(internals.currentActivity());
    expect(live).toContain("EXECUTOR");
    expect(live).toContain("read src/agent/engine.ts");

    tui.onSubagentEvent({ kind: "error", role: "executor", detail: "edit failed" });
    expect(strip(internals.currentActivity())).toContain("edit failed");
  } finally {
    clearInterval(internals.timer);
    tui.finish("done");
  }
});

test("subagent done clears the live activity back to the parent view", () => {
  const { tui, internals } = makeTui();
  try {
    tui.onSubagentEvent({ kind: "start", role: "planner", detail: "draft plan" });
    expect(strip(internals.currentActivity())).toContain("PLANNER");
    tui.onSubagentEvent({ kind: "done", role: "planner", detail: "plan ready", success: true });
    expect(strip(internals.currentActivity())).not.toContain("PLANNER");
  } finally {
    clearInterval(internals.timer);
    tui.finish("done");
  }
});

// ── Concurrent fan-out lanes (per-slot tracking) ────────────────────────────
// A `task {tasks:[...]}` fan-out batch (both executor and read-only roles) runs
// several subagents CONCURRENTLY. The live status line used to be one string
// clobbered by whichever worker's event landed last, and — worse — ANY one
// worker reaching "done" cleared the `(sub)` marker for the WHOLE batch even
// while siblings were still visibly running. These tests pin the per-slot fix.

test("concurrent fan-out: status shows the most recently active slot plus a running count", () => {
  const { tui, internals } = makeTui();
  try {
    tui.onSubagentEvent({ kind: "start", role: "executor", index: 1, total: 3, detail: "task A" });
    tui.onSubagentEvent({ kind: "start", role: "executor", index: 2, total: 3, detail: "task B" });
    tui.onSubagentEvent({ kind: "start", role: "executor", index: 3, total: 3, detail: "task C" });
    const live = strip(internals.currentActivity());
    // The most recently touched slot (3) is shown, with the other two counted.
    expect(live).toContain("EXECUTOR[3/3]");
    expect(live).toContain("task C");
    expect(live).toContain("+2 more running");
  } finally {
    clearInterval(internals.timer);
    tui.finish("done");
  }
});

// ── Parallel subagent panel (gjc TUI-exposure parity) ───────────────────────
// A fan-out `task` batch with MORE THAN ONE concurrent slot live renders its own
// multi-line panel — one row PER active worker — instead of collapsing every
// worker into a single "+N more running" line. Pins the actual rendered frame,
// not just the internal currentActivity() string.

test("parallel subagent panel: a 3-worker fan-out renders one status line per worker in the live frame", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
  tui.start();
  tui.onSubagentEvent({ kind: "start", role: "executor", index: 1, total: 3, detail: "task A" });
  tui.onSubagentEvent({ kind: "start", role: "executor", index: 2, total: 3, detail: "task B" });
  tui.onSubagentEvent({ kind: "start", role: "executor", index: 3, total: 3, detail: "task C" });
  const frame = strip(out.join(""));
  try {
    expect(frame).toContain("parallel · 3 running");
    expect(frame).toContain("task A");
    expect(frame).toContain("task B");
    expect(frame).toContain("task C");
  } finally {
    clearInterval((tui as unknown as TuiInternals).timer);
    tui.finish("done");
  }
});

test("parallel subagent panel: a single (non-fan-out) subagent does NOT render the panel", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
  tui.start();
  tui.onSubagentEvent({ kind: "start", role: "executor", detail: "solo task" });
  const frame = strip(out.join(""));
  try {
    expect(frame).not.toContain("parallel ·");
  } finally {
    clearInterval((tui as unknown as TuiInternals).timer);
    tui.finish("done");
  }
});


test("concurrent fan-out: one worker finishing does NOT clear the (sub) marker while siblings still run", () => {
  const { tui, internals } = makeTui();
  try {
    tui.onSubagentEvent({ kind: "start", role: "executor", index: 1, total: 2, detail: "task A" });
    tui.onSubagentEvent({ kind: "start", role: "executor", index: 2, total: 2, detail: "task B" });
    // Slot 1 finishes first — its sibling (slot 2) is still running.
    tui.onSubagentEvent({ kind: "done", role: "executor", index: 1, total: 2, detail: "task A done", success: true });
    const live = strip(internals.currentActivity());
    expect(live).toContain("EXECUTOR[2/2]");
    expect(live).toContain("task B");
    expect(live).not.toContain("+1 more running"); // only slot 2 remains — no "+N more"
    // Slot 2 now finishes too — the whole batch is done, marker clears.
    tui.onSubagentEvent({ kind: "done", role: "executor", index: 2, total: 2, detail: "task B done", success: true });
    expect(strip(internals.currentActivity())).not.toContain("EXECUTOR");
  } finally {
    clearInterval(internals.timer);
    tui.finish("done");
  }
});
test("concurrent detached runs retain separate ids and only remove the completed run", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
  const internals = tui as unknown as TuiInternals;
  tui.start();
  try {
    tui.onSubagentEvent({ kind: "start", role: "executor", detached: true, id: "run-alpha", detail: "inspect A" });
    tui.onSubagentEvent({ kind: "start", role: "reviewer", detached: true, id: "run-beta", detail: "inspect B" });

    const frame = strip(out.join(""));
    expect(frame).toContain("parallel · 2 running");
    expect(frame).toContain("[run-alpha]");
    expect(frame).toContain("[run-beta]");

    tui.onSubagentEvent({ kind: "done", role: "executor", detached: true, id: "run-alpha", detail: "A done", success: true });
    const live = strip(internals.currentActivity());
    expect(live).toContain("REVIEWER [run-beta]");
    expect(live).toContain("inspect B");
    expect(live).not.toContain("+1 more running");

    tui.onSubagentEvent({ kind: "done", role: "reviewer", detached: true, id: "run-beta", detail: "B done", success: true });
    expect(strip(internals.currentActivity())).not.toContain("RUN-BETA");
  } finally {
    clearInterval(internals.timer);
    tui.finish("done");
  }
});
test("monitor events render as distinct sanitized background activity", () => {
  const { tui, internals } = makeTui();
  const record = {
    id: "job-1",
    command: "printf ready",
    cwd: process.cwd(),
    status: "running" as const,
    startedAt: Date.now(),
    category: "watch" as const,
    description: "readiness probe",
    persistent: false,
  };
  try {
    tui.onMonitorEvent({ type: "start", record });
    tui.onMonitorEvent({ type: "line", record, line: "ready\u001b[2J" });

    const activity = tui.recentActivity().join("\n");
    expect(activity).toContain("Monitor job-1");
    expect(activity).toContain("ready");
    expect(activity).not.toContain("\u001b[2J");
  } finally {
    clearInterval(internals.timer);
    tui.finish("done");
  }
});

// ── Activity-history ring (Ctrl+O tail) ────────────────────────────────────

test("recentActivity records ledger events with turn-relative timestamps, ANSI-stripped", () => {
  const { tui, internals } = makeTui();
  try {
    const ev = tui.events();
    ev.onStep!(1);
    ev.onAssistant!("", { tool: "read", arguments: { filePath: "src/cli.ts" } });
    ev.onToolResult!("read", true, "1|const ok = true;");
    const recent = tui.recentActivity();
    expect(recent.length).toBeGreaterThan(0);
    const joined = recent.join("\n");
    expect(joined).toContain("Read src/cli.ts");
    // turn-relative `+N.Ns` prefix on every entry, no ANSI escapes survive
    for (const line of recent) expect(line).toMatch(/^\+\d+\.\ds /);
    expect(joined).not.toContain("\x1b[");
  } finally {
    clearInterval(internals.timer);
    tui.finish("done");
  }
});

test("activity ring is bounded and resets per turn", () => {
  const { tui, internals } = makeTui();
  try {
    const ev = tui.events();
    ev.onStep!(1);
    for (let i = 0; i < 300; i++) {
      ev.onAssistant!("", { tool: "read", arguments: { filePath: `f${i}.ts` } });
      ev.onToolResult!("read", true, "ok");
    }
    expect(internals.activityLog.length).toBeLessThanOrEqual(200); // bounded ring
    // A new turn starts a fresh ring (timestamps are turn-relative).
    tui.start();
    expect(internals.activityLog.length).toBe(0);
    expect(tui.recentActivity().length).toBe(0);
  } finally {
    clearInterval(internals.timer);
    tui.finish("done");
  }
});

// ── read lineRange crash guard (field bug: `spec.split is not a function`) ──
import { parseLineSelector, readTool } from "../src/agent/tools";

test("parseLineSelector tolerates numeric selectors and rejects junk politely", () => {
  expect(parseLineSelector(10, 100)).toEqual({ ranges: [[10, 10]] });
  const junk = parseLineSelector({ from: 1 } as unknown as string, 100);
  expect("error" in junk && junk.error).toContain("selector must be a string");
});

test("readTool no longer crashes on a numeric lineRange", async () => {
  const res = await readTool("package.json", 2 as unknown as string, process.cwd());
  expect(res.success).toBe(true);
  expect(res.output).toMatch(/^2[a-z0-9]{2}\|/); // line-2 slice, anchor-prefixed
});
