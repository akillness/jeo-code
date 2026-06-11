import { test, expect, mock } from "bun:test";
import { getSubagentRole, subagentToolset, subagentSystemPrompt } from "../src/agent/subagents";

// End-to-end check that the subagent tool-loop actually runs with a role's
// toolset and enforces read-only roles (the executor path jeo team drives).

test("read-only role (planner) toolset rejects a write at the engine boundary", async () => {
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      // First attempt a mutating write (must be rejected for a read-only role),
      // then converge with done.
      if (turn === 1) return JSON.stringify({ tool: "write", arguments: { filePath: "x.ts", content: "nope" } });
      return JSON.stringify({ tool: "done", arguments: { reason: "reviewed" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");

  const planner = getSubagentRole("planner")!;
  const history = [{ role: "system" as const, content: subagentSystemPrompt(planner) }];
  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 5,
    tools: subagentToolset(planner),
  });

  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("reviewed");
  // The write was refused because the read-only toolset has no `write` handler.
  expect(history.some(m => m.content.includes("Unknown tool: write"))).toBe(true);
});

test("executor role toolset accepts write at the engine boundary", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "done", arguments: { reason: "ok" } }),
  }));
  const { runAgentLoop } = await import("../src/agent/engine");

  const executor = getSubagentRole("executor")!;
  // The executor toolset must expose the mutating tools.
  expect(Object.keys(subagentToolset(executor))).toContain("write");
  expect(Object.keys(subagentToolset(executor))).toContain("edit");

  const result = await runAgentLoop([{ role: "system" as const, content: "sys" }], {
    cwd: process.cwd(),
    maxSteps: 3,
    tools: subagentToolset(executor),
  });
  expect(result.done).toBe(true);
});

test("subagent loop honors a role's step budget when the model never signals done", async () => {
  await mock.module("../src/agent/loop", () => ({
    // Always request a (read-only-allowed) find so the loop runs to the cap.
    callLlm: async () => JSON.stringify({ tool: "find", arguments: { globPattern: `nomatch-${Math.random()}` } }),
  }));
  const { runAgentLoop } = await import("../src/agent/engine");

  const critic = getSubagentRole("critic")!;
  const result = await runAgentLoop([{ role: "system" as const, content: "sys" }], {
    cwd: process.cwd(),
    maxSteps: 4,
    // Production subagent delegation (task-tool/team) disables the gjc step-extension
    // flow so a role's step contract stays exact — mirror that here.
    budget: { maxExtensions: 0 },
    tools: subagentToolset(critic),
  });
  expect(result.done).toBe(false);
  expect(result.steps).toBe(4);
});
