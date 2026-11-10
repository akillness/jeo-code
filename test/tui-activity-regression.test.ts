import { expect, test } from "bun:test";
import { LaunchTui } from "../src/tui/app";
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
