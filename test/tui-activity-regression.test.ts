import { expect, test } from "bun:test";
import { LaunchTui, renderSubagentHistory } from "../src/tui/app";
import type { TaskSubEvent } from "../src/agent/task-tool";
import { Renderer } from "../src/tui/renderer";

const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

test("skill reads show their real output in a bordered history card, including failures", () => {
  for (const success of [true, false]) {
    const out: string[] = [];
    const tui = new LaunchTui({ model: "m1", tty: true, write: text => out.push(text) });
    try {
      tui.start();
      const events = tui.events();
      events.onAssistant!("", { tool: "read", arguments: { path: "skill://debugging" } });
      out.length = 0;
      const result = success ? "Reproduce and isolate the failure" : "Skill resource unavailable";
      events.onToolResult!("read", success, result);
      const output = strip(out.join(""));
      expect(output).toContain("skill://debugging");
      expect(output).toContain(result);
      expect(output).toMatch(/[┌╭+]/);
      expect(output).toMatch(success ? /[✓v]/ : /[✗x]/);
    } finally {
      tui.finish("done");
    }
  }
});

test("parallel subagents keep the remaining worker active after a sibling completes", () => {
  const originalRender = Renderer.prototype.render;
  let frame: string[] = [];
  Renderer.prototype.render = function (lines: string[]) { frame = lines.slice(); };
  const tui = new LaunchTui({ model: "m1", tty: true, write: () => {} });
  try {
    tui.start();
    tui.onSubagentEvent({ role: "reviewer", kind: "start", index: 1, total: 2, detail: "Review security" });
    tui.onSubagentEvent({ role: "tester", kind: "start", index: 2, total: 2, detail: "Check recovery" });
    tui.onSubagentEvent({ role: "reviewer", kind: "done", index: 1, total: 2, detail: "Review complete", success: true });
    const live = strip(frame.join("\n"));
    expect(live).toContain("Check recovery");
    expect(live).not.toContain("Review security");
    expect(live).toMatch(/[┌╭+]/);
  } finally {
    tui.finish("done");
    Renderer.prototype.render = originalRender;
  }
});

test("finishing while a subagent is still active does not claim it completed", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: text => out.push(text) });
  tui.start();
  tui.onSubagentEvent({ role: "executor", kind: "start", detail: "Check interrupted task" });
  out.length = 0;
  tui.finish("stopped");
  const output = strip(out.join(""));
  expect(output).toContain("Check interrupted task");
  expect(output).toMatch(/interrupt|unfinished|incomplete/i);
  expect(output).not.toMatch(/EXECUTOR.*\bdone\b/i);
});

test("a completed subagent writes a bordered outcome with its real summary", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: text => out.push(text) });
  try {
    tui.start();
    tui.onSubagentEvent({ role: "tester", kind: "start", detail: "Verify recovery" });
    out.length = 0;
    tui.onSubagentEvent({ role: "tester", kind: "done", detail: "Recovery verified", success: true });
    const output = strip(out.join(""));
    expect(output).toContain("TESTER");
    expect(output).toContain("Recovery verified");
    expect(output).toMatch(/[┌╭+]/);
  } finally {
    tui.finish("done");
  }
});

test("recent activity retains the actual completed subagent result rather than only a box border", () => {
  const tui = new LaunchTui({ model: "m1", tty: true, write: () => {} });
  try {
    tui.start();
    tui.onSubagentEvent({ role: "reviewer", kind: "start", detail: "Inspect session restore" });
    tui.onSubagentEvent({ role: "reviewer", kind: "done", detail: "Found one issue", success: true });
    const activity = tui.recentActivity().join("\n");
    expect(activity).toContain("REVIEWER");
    expect(activity).toContain("Found one issue");
  } finally {
    tui.finish("done");
  }
});

test("finishing a foreground turn does not mark a detached worker as interrupted", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: text => out.push(text) });
  tui.start();
  tui.onSubagentEvent({ role: "executor", kind: "start", runId: "detached-run", detachedId: "background-1", detail: "Continue background work" });
  out.length = 0;
  tui.finish("done");
  const output = strip(out.join(""));
  expect(output).not.toMatch(/interrupted|unfinished|incomplete/i);
  expect(output).not.toMatch(/EXECUTOR[^\n]*\bdone\b/i);
});

function readMapValues(target: object, key: string): string[] {
  const value = Reflect.get(target, key);
  if (!(value instanceof Map)) return [];
  const out: string[] = [];
  for (const entry of value.values()) {
    if (typeof entry === "string") out.push(entry);
  }
  return out;
}

function hasControlOrEscape(text: string): boolean {
  return /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text);
}

test("Security: onSubagentEvent strips CSI/OSC/C1/CR and redacts Bearer/API_KEY across all subagent surfaces", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: text => out.push(text) });
  const bearerSecret = "sk-live-bearer-99887766";
  const apiKeySecret = "sk-live-apikey-11223344";
  const roleSecret = "sk-live-role-55667788";
  const detSecret = "sk-live-det-44332211";
  const sumSecret = "sk-live-sum-77665544";
  const timer = Reflect.get(tui, "timer");
  try {
    tui.start();
    out.length = 0;

    const maliciousRole = `exec\x1b[2J\x1b]0;spoof\x07\x9b2J\r Bearer ${roleSecret}`;
    const maliciousDetached = `det\x1b[31m\x9d0;pwn\x07\r API_KEY=${detSecret}`;
    const maliciousDetail = `inspect\x1b[2J\x1b]2;evil\x1b\\\x9b1A\r Bearer ${bearerSecret} API_KEY=${apiKeySecret}`;
    const maliciousSummary = `ok\x1b[0J\x9d0;sum\x07\x9c\r Bearer ${sumSecret}`;

    tui.onSubagentEvent({
      kind: "start",
      role: maliciousRole,
      detachedId: maliciousDetached,
      runId: "sec-1",
      detail: maliciousDetail,
    });

    const liveAfterStart = readMapValues(tui, "subagentLiveSlots").join("\n");
    const recAfterStart = readMapValues(tui, "subagentRecordedSlots").join("\n");
    expect(liveAfterStart.length).toBeGreaterThan(0);
    expect(recAfterStart.length).toBeGreaterThan(0);
    expect(hasControlOrEscape(liveAfterStart)).toBe(false);
    expect(hasControlOrEscape(recAfterStart)).toBe(false);
    for (const secret of [roleSecret, detSecret, bearerSecret, apiKeySecret]) {
      expect(liveAfterStart).not.toContain(secret);
      expect(recAfterStart).not.toContain(secret);
    }
    expect(liveAfterStart).toContain("<redacted>");
    expect(recAfterStart).toContain("<redacted>");

    tui.onSubagentEvent({
      kind: "tool",
      role: maliciousRole,
      detachedId: maliciousDetached,
      runId: "sec-1",
      detail: maliciousDetail,
      summary: maliciousSummary,
      success: true,
    });

    const liveAfterTool = readMapValues(tui, "subagentLiveSlots").join("\n");
    const recAfterTool = readMapValues(tui, "subagentRecordedSlots").join("\n");
    expect(hasControlOrEscape(liveAfterTool)).toBe(false);
    expect(hasControlOrEscape(recAfterTool)).toBe(false);
    for (const secret of [roleSecret, detSecret, bearerSecret, apiKeySecret, sumSecret]) {
      expect(liveAfterTool).not.toContain(secret);
      expect(recAfterTool).not.toContain(secret);
    }

    tui.onSubagentEvent({
      kind: "done",
      role: maliciousRole,
      detachedId: maliciousDetached,
      runId: "sec-1",
      detail: maliciousDetail,
      summary: maliciousSummary,
      success: true,
    });

    const ledgerAndCardRaw = out.join("");
    // No injected CSI erase, OSC title spoof, C1 introducers, BEL, or CR survive.
    expect(ledgerAndCardRaw).not.toContain("\x1b[2J");
    expect(ledgerAndCardRaw).not.toContain("\x1b[0J");
    expect(ledgerAndCardRaw).not.toContain("\x1b[1A");
    expect(ledgerAndCardRaw).not.toContain("\x1b]0;");
    expect(ledgerAndCardRaw).not.toContain("\x1b]2;");
    expect(ledgerAndCardRaw).not.toContain("\x07");
    expect(ledgerAndCardRaw).not.toContain("\r");
    expect(ledgerAndCardRaw).not.toMatch(/[\x80-\x9f]/);
    for (const secret of [roleSecret, detSecret, bearerSecret, apiKeySecret, sumSecret]) {
      expect(ledgerAndCardRaw).not.toContain(secret);
    }
    expect(strip(ledgerAndCardRaw)).toContain("<redacted>");

    const recent = tui.recentActivity(50).join("\n");
    expect(hasControlOrEscape(recent)).toBe(false);
    for (const secret of [roleSecret, detSecret, bearerSecret, apiKeySecret, sumSecret]) {
      expect(recent).not.toContain(secret);
    }
    expect(recent).toContain("<redacted>");
  } finally {
    const activeTimer = Reflect.get(tui, "timer") ?? timer;
    if (activeTimer) clearInterval(activeTimer as NodeJS.Timeout);
    tui.finish("done");
  }
});

test("Security: renderSubagentHistory sanitizes CSI/OSC/C1/CR and redacts Bearer/API_KEY secrets", () => {
  const bearerSecret = "sk-hist-bearer-123456";
  const apiKeySecret = "sk-hist-apikey-654321";
  const lines = renderSubagentHistory([
    {
      kind: "start",
      runId: "hist-sec",
      role: "planner\x1b[2J\x9b2J\r",
      detachedId: "det\x1b]0;spoof\x07\x9d0;c1\x07",
      detail: `plan\x1b]2;evil\x1b\\\r Bearer ${bearerSecret}`,
    },
    {
      kind: "tool",
      runId: "hist-sec",
      role: "planner\x1b[2J",
      detail: `curl\x9b1A API_KEY=${apiKeySecret}`,
      summary: `res\x1b]0;x\x07\r Bearer ${bearerSecret}`,
      success: true,
    },
    {
      kind: "done",
      runId: "hist-sec",
      role: "planner",
      detail: `done\x1b[0J API_KEY=${apiKeySecret}`,
      success: true,
    },
  ], { cols: 100, unicode: true, color: false });

  const rendered = lines.join("\n");
  expect(hasControlOrEscape(rendered)).toBe(false);
  expect(rendered).not.toContain(bearerSecret);
  expect(rendered).not.toContain(apiKeySecret);
  expect(rendered).toContain("<redacted>");
});

test("Security: setTurnTitle neutralizes BEL/ESC/C1/CR so OSC 2 pane title cannot break out", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: text => out.push(text) });
  try {
    tui.start();
    out.length = 0;
    tui.setTurnTitle("fix bug\x07\x1b[2J\x1b]0;spoof\x1b\\\x9c\x9b2J\r tail");
    const oscWrites = out.join("");
    const turnTitle = Reflect.get(tui, "turnTitle");
    expect(typeof turnTitle).toBe("string");
    expect(hasControlOrEscape(String(turnTitle ?? ""))).toBe(false);
    expect(String(turnTitle ?? "")).toContain("fix bug");
    // Must open OSC 2 once and close with a single BEL, with zero injected escapes/C1/CR.
    const oscStart = oscWrites.indexOf("\x1b]2;jeo: ");
    expect(oscStart).toBeGreaterThanOrEqual(0);
    const firstBel = oscWrites.indexOf("\x07", oscStart);
    const lastBel = oscWrites.lastIndexOf("\x07");
    expect(firstBel).toBe(lastBel);
    expect(oscWrites).not.toContain("\x1b[2J");
    expect(oscWrites).not.toContain("\x1b]0;");
    expect(oscWrites).not.toContain("\x9c");
    expect(oscWrites).not.toContain("\x9b");
    expect(oscWrites).not.toContain("\r");
    const payload = oscWrites.slice(oscStart + "\x1b]2;jeo: ".length, firstBel);
    expect(payload).toContain("fix bug");
    expect(hasControlOrEscape(payload)).toBe(false);
  } finally {
    const activeTimer = Reflect.get(tui, "timer");
    if (activeTimer) clearInterval(activeTimer as NodeJS.Timeout);
    tui.finish("done");
  }
});

test("Readability: completed subagent cards surface step, tool, token, and model stats cleanly", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: text => out.push(text) });
  try {
    tui.start();
    tui.onSubagentEvent({
      kind: "start",
      runId: "stats-1",
      role: "reviewer",
      detail: "Audit token cache",
      model: "anthropic/claude-sonnet-4-6",
    });
    tui.onSubagentEvent({
      kind: "step",
      runId: "stats-1",
      role: "reviewer",
      step: 3,
      maxSteps: 10,
      detail: "inspect session cache",
    });
    tui.onSubagentEvent({
      kind: "tool",
      runId: "stats-1",
      role: "reviewer",
      detail: "read src/cache.ts",
      success: true,
    });
    tui.onSubagentEvent({
      kind: "tool",
      runId: "stats-1",
      role: "reviewer",
      detail: "search token",
      success: true,
    });
    out.length = 0;
    tui.onSubagentEvent({
      kind: "done",
      runId: "stats-1",
      role: "reviewer",
      detail: "Cache verified safe",
      step: 3,
      maxSteps: 10,
      model: "anthropic/claude-sonnet-4-6",
      tokens: { input: 1200, output: 300 },
      success: true,
    });

    const card = strip(out.join(""));
    expect(card).toContain("REVIEWER");
    expect(card).toContain("Cache verified safe");
    expect(card).toMatch(/3\/10|3\s*steps?/i);
    expect(card).toMatch(/\b2\s*tools?\b/i);
    expect(card).toMatch(/(1\.5k|1500)\s*tok/i);
    expect(card).toContain("sonnet-4-6");
  } finally {
    const activeTimer = Reflect.get(tui, "timer");
    if (activeTimer) clearInterval(activeTimer as NodeJS.Timeout);
    tui.finish("done");
  }
});

test("Readability: renderSubagentHistory groups runs with tree structure and run stats", () => {
  const lines = renderSubagentHistory([
    {
      kind: "start",
      runId: "run-a",
      role: "executor",
      detail: "Harden parser",
      model: "anthropic/claude-sonnet-4-6",
    },
    { kind: "step", runId: "run-a", role: "executor", step: 2, maxSteps: 6, detail: "edit parser.ts" },
    { kind: "tool", runId: "run-a", role: "executor", detail: "read src/parser.ts", success: true },
    { kind: "tool", runId: "run-a", role: "executor", detail: "edit src/parser.ts", success: true },
    {
      kind: "done",
      runId: "run-a",
      role: "executor",
      detail: "Parser hardened",
      step: 2,
      maxSteps: 6,
      model: "anthropic/claude-sonnet-4-6",
      tokens: { input: 800, output: 200 },
      success: true,
    },
    { kind: "start", runId: "run-b", role: "tester", detail: "Run suite" },
    { kind: "error", runId: "run-b", role: "tester", detail: "Timed out" },
  ], { cols: 100, unicode: true, color: false });

  const rendered = lines.join("\n");
  expect(rendered).toContain("executor");
  expect(rendered).toContain("tester");
  expect(rendered).toMatch(/[├└]─/);
  expect(rendered).toMatch(/2\/6|2\s*steps?/i);
  expect(rendered).toMatch(/\b2\s*tools?\b/i);
  expect(rendered).toMatch(/(1\.0k|1k|1000)\s*tok/i);
  expect(rendered).toContain("sonnet-4-6");
});

test("Readability: renderSubagentHistory({ unicode: false }) uses ASCII '...' instead of '…'", () => {
  const events: TaskSubEvent[] = Array.from({ length: 8 }, (_, idx) => ({
    kind: "start",
    runId: `ascii-run-${idx}`,
    role: "executor",
    detail: `task ${idx}`,
  }));
  // Give the last run >7 events so both earlier-runs and earlier-events truncation trigger.
  for (let i = 0; i < 9; i++) {
    events.push({
      kind: "tool",
      runId: "ascii-run-7",
      role: "executor",
      detail: `step tool ${i}`,
    });
  }
  const rendered = renderSubagentHistory(events, { cols: 100, unicode: false, color: false }).join("\n");
  expect(rendered).toContain("...");
  expect(rendered).not.toContain("…");
});

test("Security/UTF-16: surrogate-safe slicing in onSubagentEvent & setTurnTitle and pre-strip redaction with lone surrogate", () => {
  const out: string[] = [];
  const realRender = Renderer.prototype.render;
  Renderer.prototype.render = function () {};
  const tui = new LaunchTui({ model: "m1", tty: true, write: text => out.push(text) });
  try {
    tui.start();
    const timer = Reflect.get(tui, "timer");
    if (timer) clearInterval(timer as NodeJS.Timeout);

    const emojiDetail = "a".repeat(139) + "🚀tail";
    tui.onSubagentEvent({ kind: "start", role: "executor", runId: "surr-1", detail: emojiDetail });
    const liveSlot = readMapValues(tui, "subagentLiveSlots").join("\n");
    const recSlot = readMapValues(tui, "subagentRecordedSlots").join("\n");
    expect(liveSlot.isWellFormed()).toBe(true);
    expect(recSlot.isWellFormed()).toBe(true);
    expect(out.join("").isWellFormed()).toBe(true);
    expect(tui.recentActivity(10).join("\n").isWellFormed()).toBe(true);

    out.length = 0;
    tui.setTurnTitle("a".repeat(48) + "😀bcdef");
    const turnTitle = String(Reflect.get(tui, "turnTitle") ?? "");
    expect(turnTitle.isWellFormed()).toBe(true);
    expect(out.join("").isWellFormed()).toBe(true);

    out.length = 0;
    tui.onSubagentEvent({
      kind: "start",
      role: "executor",
      runId: "surr-sec-1",
      detachedId: "det\x1b[31m\uD800Bearer sk-secret-99",
      detail: "det\x1b[31m\uD800Bearer sk-secret-99",
    });
    const liveSec = readMapValues(tui, "subagentLiveSlots").join("\n");
    const recSec = readMapValues(tui, "subagentRecordedSlots").join("\n");
    const recentSec = tui.recentActivity(20).join("\n");
    const ledgerSec = out.join("");
    for (const surface of [liveSec, recSec, recentSec, ledgerSec]) {
      expect(surface).not.toContain("sk-secret-99");
      expect(surface).toContain("<redacted>");
      expect(surface.isWellFormed()).toBe(true);
    }
  } finally {
    const timer = Reflect.get(tui, "timer");
    if (timer) clearInterval(timer as NodeJS.Timeout);
    tui.finish("done");
    Renderer.prototype.render = realRender;
  }
});
