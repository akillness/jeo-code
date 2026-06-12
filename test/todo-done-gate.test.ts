import { test, expect, mock } from "bun:test";
import type { Message } from "../src/agent/loop";

test("onBeforeDone gate: a done with stale todos is bounced ONCE; the model reconciles and finishes", async () => {
  let calls = 0;
  let todoUpdated = false;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (history: Message[]) => {
      calls++;
      const nudged = history.some(m => m.role === "user" && m.content.includes("Reconcile the plan"));
      if (!nudged) return JSON.stringify({ tool: "done", arguments: { reason: "all work finished" } });
      // After the nudge: update the plan, then done again.
      if (!todoUpdated) return JSON.stringify({ tool: "todo", arguments: { todos: [{ title: "a", status: "done" }] } });
      return JSON.stringify({ tool: "done", arguments: { reason: "reconciled" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  let todos = [{ title: "a", status: "in_progress" }];
  const result = await runAgentLoop([{ role: "system", content: "sys" }, { role: "user", content: "go" }], {
    cwd: process.cwd(),
    maxSteps: 10,
    budget: { maxExtensions: 0 },
    tools: {
      todo: async () => { todoUpdated = true; todos = [{ title: "a", status: "done" }]; return { success: true, output: "plan updated" }; },
    },
    events: {
      onBeforeDone: () => {
        const open = todos.filter(t => t.status !== "done");
        return open.length ? `Your todo list still shows ${open.length} unfinished item(s). Reconcile the plan first, then call done again.` : null;
      },
    },
  });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("reconciled");
  expect(todoUpdated).toBe(true);
  expect(calls).toBe(3); // done (bounced) -> todo update -> done (accepted)
});

test("onBeforeDone gate is single-use: a stubborn second done passes even with stale todos (no loop)", async () => {
  let hookCalls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "done", arguments: { reason: "stubborn" } }),
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const result = await runAgentLoop([{ role: "system", content: "sys" }], {
    cwd: process.cwd(),
    maxSteps: 10,
    budget: { maxExtensions: 0 },
    tools: {},
    events: { onBeforeDone: () => { hookCalls++; return "still unfinished — reconcile first"; } },
  });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("stubborn");
  expect(hookCalls).toBe(1); // consulted once; the escape hatch prevents loops
});

test("onBeforeDone returning null finishes immediately (clean plans pay nothing)", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "done", arguments: { reason: "clean" } }),
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const result = await runAgentLoop([{ role: "system", content: "sys" }], {
    cwd: process.cwd(),
    maxSteps: 10,
    budget: { maxExtensions: 0 },
    tools: {},
    events: { onBeforeDone: () => null },
  });
  expect(result.done).toBe(true);
  expect(result.steps).toBe(1);
});
