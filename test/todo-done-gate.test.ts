import { test, expect, spyOn, beforeEach, afterEach, mock } from "bun:test";
import * as loop from "../src/agent/loop";
import { runAgentLoop } from "../src/agent/engine";
import type { Message } from "../src/agent/loop";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

let cwd: string;
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-done-gate-"));
  await fs.mkdir(path.join(cwd, ".jeo"));
  await fs.writeFile(path.join(cwd, ".jeo", "hooks.json"), JSON.stringify({ enabled: false }));
});

afterEach(async () => {
  mock.restore();
  await fs.rm(cwd, { recursive: true, force: true });
});

const done = JSON.stringify({ tool: "done", arguments: { reason: "finished" } });

test("onBeforeDone rechecks reconciled todos before accepting completion", async () => {
  let todoUpdated = false;
  let checks = 0;
  spyOn(loop, "callLlm").mockImplementation(async (history: Message[]) => {
    if (history.some(m => m.role === "user" && m.content.includes("Reconcile the plan")) && !todoUpdated) {
      return JSON.stringify({ tool: "todo", arguments: { todos: [{ title: "a", status: "done" }] } });
    }
    return done;
  });
  const result = await runAgentLoop([{ role: "user", content: "go" }], {
    cwd, maxSteps: 10, budget: { maxExtensions: 0 },
    tools: { todo: async () => { todoUpdated = true; return { success: true, output: "plan updated" }; } },
    events: { onBeforeDone: () => { checks++; return todoUpdated ? null : "Reconcile the plan first"; } },
  });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("finished");
  expect(todoUpdated).toBe(true);
  expect(checks).toBe(2);
});

test("onBeforeDone repeated rejection stops incomplete with the unmet reason within the step budget", async () => {
  let checks = 0;
  spyOn(loop, "callLlm").mockResolvedValue(done);
  const result = await runAgentLoop([{ role: "user", content: "go" }], {
    cwd, maxSteps: 10, budget: { maxExtensions: 0 }, tools: {},
    events: { onBeforeDone: () => { checks++; return "Goal NOT_MET: receipt not verified"; } },
  });
  expect(result.done).toBe(false);
  expect(result.doneReason).toContain("receipt not verified");
  expect(checks).toBeGreaterThan(1);
  expect(result.steps).toBeLessThanOrEqual(10);
});

test("todo reconciliation cannot skip a subsequent rejecting goal gate", async () => {
  let todoUpdated = false;
  let goalChecks = 0;
  let calls = 0;
  spyOn(loop, "callLlm").mockImplementation(async () => {
    calls++;
    return calls === 2 ? JSON.stringify({ tool: "todo", arguments: { todos: [{ title: "a", status: "done" }] } }) : done;
  });
  const result = await runAgentLoop([{ role: "user", content: "go" }], {
    cwd, maxSteps: 10, budget: { maxExtensions: 0 },
    tools: { todo: async () => { todoUpdated = true; return { success: true, output: "plan reconciled" }; } },
    events: { onBeforeDone: () => {
      if (!todoUpdated) return "Reconcile the plan first";
      goalChecks++;
      return "Goal NOT_MET: missing deployment receipt";
    } },
  });
  expect(result.done).toBe(false);
  expect(result.doneReason).toContain("missing deployment receipt");
  expect(todoUpdated).toBe(true);
  expect(goalChecks).toBeGreaterThan(0);
  expect(calls).toBeLessThanOrEqual(10);
});

test("onBeforeDone accepts a goal only after its rejection is resolved", async () => {
  let checks = 0;
  spyOn(loop, "callLlm").mockResolvedValue(done);
  const result = await runAgentLoop([{ role: "user", content: "go" }], {
    cwd, maxSteps: 10, budget: { maxExtensions: 0 }, tools: {},
    events: { onBeforeDone: () => ++checks < 3 ? "Goal NOT_MET: evidence pending" : null },
  });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("finished");
  expect(checks).toBe(3);
});

test("non-JSON prose cannot bypass a rejecting completion gate", async () => {
  spyOn(loop, "callLlm").mockResolvedValue("The requested work is complete and all changes are ready for review.");
  const result = await runAgentLoop([{ role: "user", content: "go" }], {
    cwd, maxSteps: 10, budget: { maxExtensions: 0 }, tools: {},
    events: { onBeforeDone: () => "Goal NOT_MET: missing evidence" },
  });
  expect(result.done).toBe(false);
  expect(result.doneReason).toContain("missing evidence");
  expect(result.steps).toBeLessThanOrEqual(10);
});

test("onBeforeDone returning null finishes immediately", async () => {
  spyOn(loop, "callLlm").mockResolvedValue(done);
  const result = await runAgentLoop([{ role: "user", content: "go" }], {
    cwd, maxSteps: 10, budget: { maxExtensions: 0 }, tools: {},
    events: { onBeforeDone: () => null },
  });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("finished");
  expect(result.steps).toBe(1);
});
