import { test, expect, mock, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Each test re-mocks ../src/agent/loop; restore afterwards so other suites stay clean.
afterEach(() => {
  mock.restore();
});

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "jeo-steer-"));
}

test("runAgentLoop: mid-turn steering is injected as a user message and fires onSteer", async () => {
  // Capture the latest user-message content the model sees at each step.
  const seenUser: string[] = [];
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (history: { role: string; content: string }[]) => {
      const lastUser = [...history].reverse().find(m => m.role === "user");
      seenUser.push(lastUser?.content ?? "");
      return JSON.stringify({ tool: "done", arguments: { reason: "ok" } });
    },
  }));

  const { runAgentLoop } = await import("../src/agent/engine");
  const steerQueue = ["please also rename foo to bar"];
  const steered: string[] = [];
  const history = [
    { role: "system" as const, content: "sys" },
    { role: "user" as const, content: "go" },
  ];

  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 5,
    steer: () => steerQueue.splice(0, steerQueue.length),
    events: { onSteer: t => steered.push(t) },
  });

  expect(result.done).toBe(true);
  // Drain happens at the top of the step, BEFORE the model call — so the very first
  // call already sees the steering message framed as a mid-turn instruction.
  expect(seenUser[0]).toContain("please also rename foo to bar");
  expect(seenUser[0]).toContain("mid-turn steering");
  expect(steered).toEqual(["please also rename foo to bar"]);
  // The injected message is persisted into the shared history (callers keep it).
  expect(
    history.some(m => m.role === "user" && String(m.content).includes("rename foo to bar")),
  ).toBe(true);
});

test("runAgentLoop: an empty steer drain injects nothing and never fires onSteer", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "done", arguments: { reason: "ok" } }),
  }));

  const { runAgentLoop } = await import("../src/agent/engine");
  const steered: string[] = [];
  const history = [
    { role: "system" as const, content: "sys" },
    { role: "user" as const, content: "go" },
  ];

  await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 3,
    steer: () => [],
    events: { onSteer: t => steered.push(t) },
  });

  expect(steered).toEqual([]);
  // Only the original user message — no injected steering messages.
  expect(history.filter(m => m.role === "user").length).toBe(1);
});

test("runAgentLoop: blank/whitespace steering lines are ignored", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "done", arguments: { reason: "ok" } }),
  }));

  const { runAgentLoop } = await import("../src/agent/engine");
  const steered: string[] = [];
  const queue = ["   ", "\n", ""];
  const history = [
    { role: "system" as const, content: "sys" },
    { role: "user" as const, content: "go" },
  ];

  await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 3,
    steer: () => queue.splice(0, queue.length),
    events: { onSteer: t => steered.push(t) },
  });

  expect(steered).toEqual([]);
  expect(history.filter(m => m.role === "user").length).toBe(1);
});

test("StepBudget.noteSteer grants headroom and clears the scoring window", async () => {
  const { StepBudget, resolveStepBudgetConfig } = await import("../src/agent/step-budget");
  const cfg = resolveStepBudgetConfig(10);
  const budget = new StepBudget(cfg);
  const before = budget.limit();

  // A couple of failures would normally bias the next extend toward declining.
  budget.record("sig-a", false);
  budget.record("sig-b", false);
  expect(budget.progress().total).toBe(2);

  budget.noteSteer();

  expect(budget.limit()).toBe(Math.min(before + cfg.extensionSteps, cfg.hardCap));
  expect(budget.progress().total).toBe(0); // window cleared — stale failures dropped
});

test("createTaskTool: forwards steering to a single running subagent", async () => {
  const seenUser: string[] = [];
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (history: { role: string; content: string }[]) => {
      const lastUser = [...history].reverse().find(m => m.role === "user");
      seenUser.push(lastUser?.content ?? "");
      return JSON.stringify({
        tool: "done",
        arguments: { reason: "Summary: done\nChanged Files: x.ts\nVerification: ran\nOpen Risks: none\ndone" },
      });
    },
  }));

  const { createTaskTool } = await import("../src/agent/task-tool");
  const steerQueue = ["also check the empty-input edge case"];
  const steerEvents: string[] = [];
  const tool = createTaskTool({
    config: { defaultModel: "ollama/fast", subagents: {} },
    steer: () => steerQueue.splice(0, steerQueue.length),
    onEvent: e => {
      if (e.kind === "step" && e.detail?.startsWith("↳ steer:")) steerEvents.push(e.detail);
    },
  });

  await tool({ role: "executor", task: "do a thing" }, await tmpDir());

  // The subagent loop drained the parent's steering and saw it as a user message.
  expect(seenUser.some(s => s.includes("also check the empty-input edge case"))).toBe(true);
  expect(steerEvents.some(d => d.includes("also check the empty-input edge case"))).toBe(true);
});

test("createTaskTool: fan-out broadcasts parent steering to every running worker", async () => {
  const seenUser: string[] = [];
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (history: { role: string; content: string }[]) => {
      const lastUser = [...history].reverse().find(m => m.role === "user");
      seenUser.push(lastUser?.content ?? "");
      return JSON.stringify({
        tool: "done",
        arguments: { reason: "Summary: ok\nFindings: none\nRecommendations: ship\nArchitectural Status: CLEAR\nCode Review Recommendation: APPROVE" },
      });
    },
  }));

  const { createTaskTool } = await import("../src/agent/task-tool");
  const steerQueue = ["redirect everything"];
  const tool = createTaskTool({
    config: { defaultModel: "ollama/fast", subagents: {} },
    steer: () => steerQueue.splice(0, steerQueue.length),
  });

  // architect is read-only → concurrent fan-out; #7 routes steering through a
  // broadcast hub so the redirect reaches the running subagents (each once)
  // instead of being dropped.
  await tool({ role: "architect", tasks: ["review a", "review b"] }, await tmpDir());

  // The redirect reached at least one running subagent and the parent queue drained.
  expect(seenUser.some(s => s.includes("redirect everything"))).toBe(true);
  expect(steerQueue).toEqual([]);
});

test("runAgentLoop: steering during the final step reopens the turn instead of finishing", async () => {
  const seenUser: string[] = [];
  let modelCalls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (history: { role: string; content: string }[]) => {
      modelCalls++;
      const lastUser = [...history].reverse().find(m => m.role === "user");
      seenUser.push(lastUser?.content ?? "");
      return JSON.stringify({ tool: "done", arguments: { reason: `done#${modelCalls}` } });
    },
  }));

  const { runAgentLoop } = await import("../src/agent/engine");
  // drain #1 = step-1 top-of-loop (empty); drain #2 = step-1 done-time (the steer
  // "arrived during the final step"); later drains empty.
  let drains = 0;
  const steer = () => {
    drains++;
    return drains === 2 ? ["one more thing: add a test"] : [];
  };
  const steered: string[] = [];
  const history = [
    { role: "system" as const, content: "sys" },
    { role: "user" as const, content: "go" },
  ];

  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 5,
    steer,
    events: { onSteer: t => steered.push(t) },
  });

  expect(result.done).toBe(true);
  // The turn reopened: the model was called again after the first `done`.
  expect(modelCalls).toBeGreaterThanOrEqual(2);
  expect(seenUser.some(s => s.includes("one more thing: add a test"))).toBe(true);
  expect(steered).toContain("one more thing: add a test");
  // The reopened turn still terminates cleanly.
  expect(result.doneReason).toBe(`done#${modelCalls}`);
});
