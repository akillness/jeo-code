import { test, expect, vi, setSystemTime } from "bun:test";
import { LaunchTui } from "../src/tui/app";
import { visibleWidth } from "../src/tui/components/width";
import { Renderer } from "../src/tui/renderer";

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
    expect(strip(internals.currentActivity())).not.toContain("EXECUTOR");
    expect(tui.recentActivity().join("\n")).toContain("edit failed");
  } finally {
    clearInterval(internals.timer);
    tui.finish("done");
  }
});
test("a subagent error clears its running slot and persists a failed card", () => {
  const { tui, internals } = makeTui();
  const logged: string[] = [];
  const originalLog = console.log;
  try {
    tui.onSubagentEvent({ kind: "start", role: "executor", detail: "inspect engine.ts" });
    tui.onSubagentEvent({ kind: "error", role: "executor", detail: "edit failed" });
    expect(strip(internals.currentActivity())).not.toContain("EXECUTOR");
    clearInterval(internals.timer);
    console.log = (...args: unknown[]) => logged.push(args.join(" "));
    tui.finish("done");
    const final = strip(logged.join("\n"));
    expect(final).toContain("EXECUTOR failed");
    expect(final).toContain("edit failed");
  } finally {
    console.log = originalLog;
    clearInterval(internals.timer);
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

// ── Parallel subagent panel ───────────────────────────────────────────────
// Every live subagent renders a panel, with one row per active worker.
// Pin the rendered frame rather than only the currentActivity() string.

test("parallel subagent panel: a 3-worker fan-out renders one status line per worker in the live frame", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
  tui.start();
  tui.onSubagentEvent({ kind: "start", role: "executor", index: 1, total: 3, detail: "task A" });
  tui.onSubagentEvent({ kind: "start", role: "executor", index: 2, total: 3, detail: "task B" });
  tui.onSubagentEvent({ kind: "start", role: "executor", index: 3, total: 3, detail: "task C" });
  const frame = strip(out.join(""));
  try {
    expect(frame).toContain("subagents · 3 running");
    expect(frame).toContain("task A");
    expect(frame).toContain("task B");
    expect(frame).toContain("task C");
  } finally {
    clearInterval((tui as unknown as TuiInternals).timer);
    tui.finish("done");
  }
});

test("subagent panel: a single subagent renders its own live panel", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
  tui.start();
  tui.onSubagentEvent({ kind: "start", role: "executor", detail: "solo task" });
  const frame = strip(out.join(""));
  try {
    expect(frame).toContain("subagents · 1 running");
    expect(frame).toContain("solo task");
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

test("detached subagent events keep distinct identities while settling independently", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
  tui.start();
  const internals = tui as unknown as TuiInternals;
  try {
    tui.onSubagentEvent({
      kind: "start",
      role: "executor",
      detachedId: "executor-1",
      detail: "first detached task",
    });
    tui.onSubagentEvent({
      kind: "start",
      role: "executor",
      detachedId: "executor-2",
      detail: "second detached task",
    });

    const frame = strip(out.join(""));
    expect(frame).toContain("subagents · 2 running");
    expect(frame).toContain("EXECUTOR[executor-1]");
    expect(frame).toContain("first detached task");
    expect(frame).toContain("EXECUTOR[executor-2]");
    expect(frame).toContain("second detached task");

    tui.onSubagentEvent({
      kind: "done",
      role: "executor",
      detachedId: "executor-1",
      detail: "first detached task done",
      success: true,
    });
    const remaining = strip(internals.currentActivity());
    expect(remaining).toContain("EXECUTOR[executor-2]");
    expect(remaining).toContain("second detached task");

    tui.onSubagentEvent({
      kind: "done",
      role: "executor",
      detachedId: "executor-2",
      detail: "second detached task done",
      success: true,
    });
    expect(strip(internals.currentActivity())).not.toContain("EXECUTOR");
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("parseLineSelector tolerates numeric selectors and rejects junk politely", () => {
  expect(parseLineSelector(10, 100)).toEqual({ ranges: [[10, 10]] });
  const junk = parseLineSelector({ from: 1 } as unknown as string, 100);
  expect("error" in junk && junk.error).toContain("selector must be a string");
});

test("readTool no longer crashes on a numeric lineRange", async () => {
  // Anchor to this module, not ambient process.cwd() (other suites may chdir).
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const res = await readTool(join(repoRoot, "package.json"), 2 as unknown as string, repoRoot);
  expect(res.success).toBe(true);
  expect(res.output).toMatch(/^2[a-z0-9]{2}\|/); // line-2 slice, anchor-prefixed
});

function callRenderSubagentPanel(tui: LaunchTui, cols: number): string[] {
  const fn = Reflect.get(tui, "renderSubagentPanel");
  if (typeof fn !== "function") throw new Error("renderSubagentPanel missing");
  const res = fn.call(tui, cols);
  if (!Array.isArray(res) || !res.every((x): x is string => typeof x === "string")) {
    throw new Error("renderSubagentPanel did not return string[]");
  }
  return res;
}

test("Readability: renderSubagentPanel keeps assignment alongside └─ active sub-row and step/tool/elapsed/model stats", () => {
  const tui = new LaunchTui({ model: "m1", tty: true, write: () => {} });
  try {
    tui.start();
    tui.onSubagentEvent({
      kind: "start",
      role: "executor",
      runId: "r-panel-1",
      detail: "Refactor auth middleware",
      model: "anthropic/claude-sonnet-4-6",
    });
    tui.onSubagentEvent({
      kind: "step",
      role: "executor",
      runId: "r-panel-1",
      step: 2,
      maxSteps: 8,
      detail: "trace session checks",
    });
    tui.onSubagentEvent({
      kind: "tool",
      role: "executor",
      runId: "r-panel-1",
      detail: "read src/auth.ts",
      success: true,
    });
    tui.onSubagentEvent({
      kind: "tool",
      role: "executor",
      runId: "r-panel-1",
      detail: "edit src/auth.ts",
      success: true,
    });

    const panel = callRenderSubagentPanel(tui, 100).map(strip);
    const joined = panel.join("\n");
    // Assignment remains visible even after step and tool updates.
    expect(joined).toContain("Refactor auth middleware");
    // Active tool/step sub-row with tree glyph.
    expect(joined).toMatch(/(└─|`-)\s*[^\n]*edit src\/auth\.ts/);
    // Rich jeopi-style worker metadata: step N/M, tool count, elapsed time, short model.
    expect(joined).toMatch(/2\/8/);
    expect(joined).toMatch(/\b2\s*tools?\b/i);
    expect(joined).toMatch(/\b\d+(?:\.\d+)?(?:ms|s)\b/);
    expect(joined).toContain("sonnet-4-6");
  } finally {
    const timer = Reflect.get(tui, "timer");
    if (timer) clearInterval(timer as NodeJS.Timeout);
    tui.finish("done");
  }
});

test("Readability: renderSubagentPanel compacts cleanly for >3 workers and narrow cols=48", () => {
  const tui = new LaunchTui({ model: "m1", tty: true, write: () => {} });
  try {
    tui.start();
    for (let i = 1; i <= 6; i++) {
      tui.onSubagentEvent({
        kind: "start",
        role: "executor",
        runId: `compact-${i}`,
        index: i,
        total: 6,
        detail: `Very long worker assignment number ${i} inspecting subsystem`,
        model: "anthropic/claude-sonnet-4-6",
      });
      tui.onSubagentEvent({
        kind: "tool",
        role: "executor",
        runId: `compact-${i}`,
        index: i,
        total: 6,
        detail: `read src/module-${i}.ts`,
        success: true,
      });
    }

    const manyPanel = callRenderSubagentPanel(tui, 100).map(strip);
    expect(manyPanel[0]).toContain("subagents · 6 running");
    // Compacted: does not expand into 6 * 2 + 2 = 14 rows.
    expect(manyPanel.length).toBeLessThanOrEqual(10);

    const narrowPanel = callRenderSubagentPanel(tui, 48).map(strip);
    expect(narrowPanel.length).toBeLessThanOrEqual(10);
    for (const row of narrowPanel) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(48);
    }
    // Borders stay uniform width in narrow mode.
    const widths = new Set(narrowPanel.map(row => visibleWidth(row)));
    expect(widths.size).toBe(1);
  } finally {
    const timer = Reflect.get(tui, "timer");
    if (timer) clearInterval(timer as NodeJS.Timeout);
    tui.finish("done");
  }
});

test("Speed: 50 rapid thinking events throttle Renderer.render while non-thinking events draw immediately", () => {
  const realRender = Renderer.prototype.render;
  let renderCalls = 0;
  const tui = new LaunchTui({ model: "m1", tty: true, write: () => {} });
  try {
    vi.useFakeTimers();
    Renderer.prototype.render = function () { renderCalls++; };
    tui.start();
    tui.onSubagentEvent({ kind: "start", role: "executor", runId: "throttle-1", detail: "analyze" });
    renderCalls = 0;

    for (let i = 0; i < 50; i++) {
      tui.onSubagentEvent({ kind: "thinking", role: "executor", runId: "throttle-1", detail: `thought ${i}` });
      if (i % 10 === 9) vi.advanceTimersByTime(1);
    }

    expect(renderCalls).toBeLessThan(15);
    const slots = Reflect.get(tui, "subagentLiveSlots");
    expect(slots instanceof Map).toBe(true);
    if (slots instanceof Map) {
      expect(String(slots.get("throttle-1") ?? "")).toContain("thought 49");
    }

    const beforeStep = renderCalls;
    tui.onSubagentEvent({ kind: "step", role: "executor", runId: "throttle-1", step: 1, maxSteps: 5, detail: "step 1" });
    expect(renderCalls).toBe(beforeStep + 1);

    const beforeTool = renderCalls;
    tui.onSubagentEvent({ kind: "tool", role: "executor", runId: "throttle-1", detail: "read a.ts", success: true });
    expect(renderCalls).toBe(beforeTool + 1);

    const beforeStart2 = renderCalls;
    tui.onSubagentEvent({ kind: "start", role: "reviewer", runId: "throttle-2", detail: "review" });
    expect(renderCalls).toBe(beforeStart2 + 1);

    const beforeError = renderCalls;
    tui.onSubagentEvent({ kind: "error", role: "reviewer", runId: "throttle-2", detail: "failed" });
    expect(renderCalls).toBe(beforeError + 1);

    const beforeDone = renderCalls;
    tui.onSubagentEvent({ kind: "done", role: "executor", runId: "throttle-1", detail: "finished", success: true });
    expect(renderCalls).toBe(beforeDone + 1);
  } finally {
    const timer = Reflect.get(tui, "timer");
    if (timer) clearInterval(timer as NodeJS.Timeout);
    tui.finish("done");
    Renderer.prototype.render = realRender;
    vi.useRealTimers();
  }
});

test("Speed: repeated renderSubagentPanel calls at same tick/cols/rev reuse cached panel rows", () => {
  const tui = new LaunchTui({ model: "m1", tty: true, write: () => {} });
  try {
    tui.start();
    const timer = Reflect.get(tui, "timer");
    if (timer) clearInterval(timer as NodeJS.Timeout);
    tui.onSubagentEvent({ kind: "start", role: "executor", runId: "cache-1", detail: "cache test" });

    const first = callRenderSubagentPanel(tui, 100);
    const second = callRenderSubagentPanel(tui, 100);
    expect(second).toBe(first);

    // Different cols invalidates cache
    const differentCols = callRenderSubagentPanel(tui, 80);
    expect(differentCols).not.toBe(first);

    // New subagent revision invalidates cache
    const at80 = callRenderSubagentPanel(tui, 80);
    tui.onSubagentEvent({ kind: "tool", role: "executor", runId: "cache-1", detail: "read x.ts", success: true });
    const afterEvent = callRenderSubagentPanel(tui, 80);
    expect(afterEvent).not.toBe(at80);
  } finally {
    const timer = Reflect.get(tui, "timer");
    if (timer) clearInterval(timer as NodeJS.Timeout);
    tui.finish("done");
  }
});

test("Readability: ASCII mode (unicode=false) at cols=72 does not clip trailing model/stats suffix", () => {
  const origTerm = process.env.TERM;
  let tui: LaunchTui | undefined;
  try {
    process.env.TERM = "dumb";
    tui = new LaunchTui({ model: "m1", tty: true, write: () => {} });
    tui.start();
    const timer = Reflect.get(tui, "timer");
    if (timer) clearInterval(timer as NodeJS.Timeout);
    tui.onSubagentEvent({
      kind: "start",
      role: "executor",
      runId: "ascii-clip-1",
      detail: "Analyze and refactor the entire authentication subsystem across all modules",
      model: "anthropic/claude-sonnet-4-6",
      step: 2,
      maxSteps: 8,
    });
    const panel = callRenderSubagentPanel(tui, 72).map(strip);
    const joined = panel.join("\n");
    expect(joined).toContain("sonnet-4-6");
    expect(joined).toContain("2/8");
    for (const row of panel) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(72);
    }
  } finally {
    if (tui) {
      const timer = Reflect.get(tui, "timer");
      if (timer) clearInterval(timer as NodeJS.Timeout);
      tui.finish("done");
    }
    if (origTerm === undefined) delete process.env.TERM;
    else process.env.TERM = origTerm;
  }
});

test("Speed/Readability: staggered worker elapsed cache invalidates when second worker crosses 1s boundary", () => {
  let tui: LaunchTui | undefined;
  try {
    setSystemTime(new Date(10_000));
    tui = new LaunchTui({ model: "m1", tty: true, write: () => {} });
    tui.start();
    const timer = Reflect.get(tui, "timer");
    if (timer) clearInterval(timer as NodeJS.Timeout);

    tui.onSubagentEvent({ kind: "start", role: "executor", runId: "stagger-1", detail: "worker-one" });
    setSystemTime(new Date(10_500));
    tui.onSubagentEvent({ kind: "start", role: "reviewer", runId: "stagger-2", detail: "worker-two" });

    setSystemTime(new Date(11_200));
    const at11200 = callRenderSubagentPanel(tui, 100).map(strip);
    const w2Before = at11200.find(l => l.includes("worker-two")) ?? "";
    expect(w2Before).toContain("0s");

    setSystemTime(new Date(11_600));
    const at11600 = callRenderSubagentPanel(tui, 100).map(strip);
    const w2After = at11600.find(l => l.includes("worker-two")) ?? "";
    expect(w2After).toContain("1s");
  } finally {
    if (tui) {
      const timer = Reflect.get(tui, "timer");
      if (timer) clearInterval(timer as NodeJS.Timeout);
      tui.finish("done");
    }
    setSystemTime();
  }
});

test("Readability: failed tool sub-row stays visible even when tool detail matches start assignment", () => {
  const tui = new LaunchTui({ model: "m1", tty: true, write: () => {} });
  try {
    tui.start();
    const timer = Reflect.get(tui, "timer");
    if (timer) clearInterval(timer as NodeJS.Timeout);
    tui.onSubagentEvent({ kind: "start", role: "tester", runId: "same-fail-1", detail: "run bun test" });
    tui.onSubagentEvent({ kind: "tool", role: "tester", runId: "same-fail-1", detail: "run bun test", success: false });

    const panel = callRenderSubagentPanel(tui, 100).map(strip).join("\n");
    expect(panel).toMatch(/(?:└─|`-)\s*[✗x]\s*run bun test/);
  } finally {
    const timer = Reflect.get(tui, "timer");
    if (timer) clearInterval(timer as NodeJS.Timeout);
    tui.finish("done");
  }
});
test("In-place stability: parallel workers keep stable row order and constant box height across start/step/tool updates", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
  try {
    tui.start();
    const timer = Reflect.get(tui, "timer");
    if (timer) clearInterval(timer as NodeJS.Timeout);

    tui.onSubagentEvent({ kind: "start", role: "executor", runId: "s1", index: 1, total: 3, detail: "first task" });
    tui.onSubagentEvent({ kind: "start", role: "executor", runId: "s2", index: 2, total: 3, detail: "second task" });
    tui.onSubagentEvent({ kind: "start", role: "executor", runId: "s3", index: 3, total: 3, detail: "third task" });

    const startPanel = callRenderSubagentPanel(tui, 100).map(strip);
    expect(startPanel.join("\n")).toMatch(/(?:└─|`-)\s*[▸>]\s*starting/);
    expect(strip(out.join(""))).toContain("(sub ×3)");
    out.length = 0;

    // Out-of-order updates (worker 3 -> worker 1 -> worker 2) must not reshuffle rows or emit newlines.
    tui.onSubagentEvent({ kind: "tool", role: "executor", runId: "s3", index: 3, total: 3, detail: "read c.ts", success: true, summary: "3 lines" });
    tui.onSubagentEvent({ kind: "tool", role: "executor", runId: "s1", index: 1, total: 3, detail: "read a.ts", success: true });
    tui.onSubagentEvent({ kind: "step", role: "executor", runId: "s2", index: 2, total: 3, step: 2, maxSteps: 5, detail: "check b.ts" });

    expect(out.join("")).not.toContain("\n");
    const updatedPanel = callRenderSubagentPanel(tui, 100).map(strip);
    expect(updatedPanel.length).toBe(startPanel.length);
    const joined = updatedPanel.join("\n");
    const i1 = joined.indexOf("EXECUTOR[1/3]");
    const i2 = joined.indexOf("EXECUTOR[2/3]");
    const i3 = joined.indexOf("EXECUTOR[3/3]");
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
    expect(joined).toContain("subagents · 3 running · 2 tools");
    expect(joined).toContain("read c.ts — 3 lines");
  } finally {
    const timer = Reflect.get(tui, "timer");
    if (timer) clearInterval(timer as NodeJS.Timeout);
    tui.finish("done");
  }
});