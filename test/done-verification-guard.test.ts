import { test, expect, mock } from "bun:test";

// gjc-inherited done-verification guard (plan/gjc-inheritance.md B4):
// a turn that mutated files but ran no verification gets exactly ONE pushback
// on `done`; the second `done` always passes (escape hatch for doc-only work).

test("runAgentLoop: unverified mutation gets one done pushback, second done passes", async () => {
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      calls++;
      if (calls === 1) return JSON.stringify({ tool: "edit", arguments: { filePath: "a.ts", editBlock: "x" } });
      // Model tries to finish without verifying — twice.
      return JSON.stringify({ tool: "done", arguments: { reason: "all done" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "user" as const, content: "fix it" }];
  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 10,
    budget: { maxExtensions: 0 },
    tools: { edit: async () => ({ success: true, output: "Successfully updated a.ts" }) },
  });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("all done");
  expect(calls).toBe(3); // edit → done (pushed back) → done (passes)
  expect(history.some(m => m.role === "user" && m.content.includes("ran NO verification"))).toBe(true);
});

test("runAgentLoop: mutation followed by a test run passes done immediately", async () => {
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      calls++;
      if (calls === 1) return JSON.stringify({ tool: "write", arguments: { filePath: "b.ts", content: "x" } });
      if (calls === 2) return JSON.stringify({ tool: "bash", arguments: { command: "bun test b.test.ts" } });
      return JSON.stringify({ tool: "done", arguments: { reason: "verified" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const result = await runAgentLoop([{ role: "user", content: "go" }], {
    cwd: process.cwd(),
    maxSteps: 10,
    budget: { maxExtensions: 0 },
    tools: {
      write: async () => ({ success: true, output: "ok" }),
      bash: async () => ({ success: true, output: "2 pass\n0 fail" }),
    },
  });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("verified");
  expect(calls).toBe(3); // no pushback
});

test("runAgentLoop: read-only turns finish without any pushback", async () => {
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      calls++;
      if (calls === 1) return JSON.stringify({ tool: "read", arguments: { filePath: "a.ts" } });
      return JSON.stringify({ tool: "done", arguments: { reason: "answered" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const result = await runAgentLoop([{ role: "user", content: "what is in a.ts?" }], {
    cwd: process.cwd(),
    maxSteps: 10,
    budget: { maxExtensions: 0 },
    tools: { read: async () => ({ success: true, output: "content" }) },
  });
  expect(result.done).toBe(true);
  expect(calls).toBe(2);
});

test("runAgentLoop: failed mutations alone do not arm the guard", async () => {
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      calls++;
      if (calls === 1) return JSON.stringify({ tool: "edit", arguments: { filePath: "a.ts", editBlock: "x" } });
      return JSON.stringify({ tool: "done", arguments: { reason: "could not edit" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const result = await runAgentLoop([{ role: "user", content: "go" }], {
    cwd: process.cwd(),
    maxSteps: 10,
    budget: { maxExtensions: 0 },
    tools: { edit: async () => ({ success: false, output: "", error: "no match" }) },
  });
  expect(result.done).toBe(true);
  expect(calls).toBe(2); // nothing actually changed → no pushback
});
