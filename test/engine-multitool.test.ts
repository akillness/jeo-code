import { test, expect, mock } from "bun:test";

test("runAgentLoop: batch of 3 reads -> exactly 1 LLM call and 3 onToolResult events in order", async () => {
  let llmCalls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      llmCalls++;
      if (llmCalls === 1) {
        return JSON.stringify({
          tools: [
            { tool: "read", arguments: { filePath: "a.txt" } },
            { tool: "read", arguments: { filePath: "b.txt" } },
            { tool: "read", arguments: { filePath: "c.txt" } }
          ]
        });
      }
      return JSON.stringify({ tool: "done", arguments: { reason: "finished" } });
    }
  }));

  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }];
  const toolResults: { tool: string; success: boolean; output: string }[] = [];

  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 5,
    budget: { maxExtensions: 0 },
    tools: {
      read: async (args) => {
        return { success: true, output: `content of ${args.filePath}` };
      }
    },
    events: {
      onToolResult: (tool, success, output) => {
        toolResults.push({ tool, success, output });
      }
    }
  });

  expect(result.done).toBe(true);
  expect(llmCalls).toBe(2);
  expect(toolResults.length).toBe(3);
  expect(toolResults[0]).toEqual({ tool: "read", success: true, output: "content of a.txt" });
  expect(toolResults[1]).toEqual({ tool: "read", success: true, output: "content of b.txt" });
  expect(toolResults[2]).toEqual({ tool: "read", success: true, output: "content of c.txt" });
});

test("runAgentLoop: mixed batch read->write->read runs write as a barrier", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      return JSON.stringify({
        tools: [
          { tool: "read", arguments: { id: 1 } },
          { tool: "write", arguments: { id: 2 } },
          { tool: "read", arguments: { id: 3 } }
        ]
      });
    }
  }));

  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }];
  const log: string[] = [];

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 1,
    budget: { maxExtensions: 0 },
    tools: {
      read: async (args) => {
        log.push(`start-read-${args.id}`);
        await sleep(30);
        log.push(`end-read-${args.id}`);
        return { success: true, output: "ok" };
      },
      write: async (args) => {
        log.push(`start-write-${args.id}`);
        await sleep(10);
        log.push(`end-write-${args.id}`);
        return { success: true, output: "ok" };
      }
    }
  });

  expect(log).toEqual([
    "start-read-1",
    "end-read-1",
    "start-write-2",
    "end-write-2",
    "start-read-3",
    "end-read-3"
  ]);
});

test("runAgentLoop: batch with done+other tools rejects done", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      return JSON.stringify({
        tools: [
          { tool: "read", arguments: { filePath: "a.txt" } },
          { tool: "done", arguments: { reason: "finished" } }
        ]
      });
    }
  }));

  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }];
  const toolResults: { tool: string; success: boolean; output: string }[] = [];

  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 1,
    budget: { maxExtensions: 0 },
    tools: {
      read: async () => ({ success: true, output: "content" })
    },
    events: {
      onToolResult: (tool, success, output) => {
        toolResults.push({ tool, success, output });
      }
    }
  });

  expect(result.done).toBe(false);
  expect(toolResults.length).toBe(2);
  expect(toolResults[0]).toEqual({ tool: "read", success: true, output: "content" });
  expect(toolResults[1].tool).toBe("done");
  expect(toolResults[1].success).toBe(false);
  expect(toolResults[1].output).toContain("send 'done' alone");
});

test("runAgentLoop: >6 entries truncated", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      return JSON.stringify({
        tools: [
          { tool: "read", arguments: { id: 1 } },
          { tool: "read", arguments: { id: 2 } },
          { tool: "read", arguments: { id: 3 } },
          { tool: "read", arguments: { id: 4 } },
          { tool: "read", arguments: { id: 5 } },
          { tool: "read", arguments: { id: 6 } },
          { tool: "read", arguments: { id: 7 } }
        ]
      });
    }
  }));

  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }];
  const toolResults: string[] = [];
  let noticeMessage = "";

  await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 1,
    budget: { maxExtensions: 0 },
    tools: {
      read: async (args) => {
        toolResults.push(`read-${args.id}`);
        return { success: true, output: "ok" };
      }
    },
    events: {
      onNotice: (msg) => {
        noticeMessage = msg;
      }
    }
  });

  // A parallel read group has no completion-order contract — compare as a set.
  expect([...toolResults].sort()).toEqual([
    "read-1",
    "read-2",
    "read-3",
    "read-4",
    "read-5",
    "read-6"
  ]);
  expect(noticeMessage).toContain("capping at 6");
});

test("runAgentLoop: legacy single-tool object unchanged", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      return JSON.stringify({
        tool: "read",
        arguments: { filePath: "legacy.txt" }
      });
    }
  }));

  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }];
  const toolResults: { tool: string; success: boolean; output: string }[] = [];

  await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 1,
    budget: { maxExtensions: 0 },
    tools: {
      read: async (args) => ({ success: true, output: `content of ${args.filePath}` })
    },
    events: {
      onToolResult: (tool, success, output) => {
        toolResults.push({ tool, success, output });
      }
    }
  });

  expect(toolResults.length).toBe(1);
  expect(toolResults[0]).toEqual({ tool: "read", success: true, output: "content of legacy.txt" });
});

test("runAgentLoop: all-fail batch increments the consecutive-failure guard", async () => {
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      return JSON.stringify({
        tools: [
          { tool: "failtool", arguments: { turn } },
          { tool: "failtool", arguments: { turn } }
        ]
      });
    }
  }));

  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }];
  let calls = 0;

  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 10,
    budget: { maxExtensions: 0 },
    tools: {
      failtool: async () => {
        calls++;
        return { success: false, output: "failed" };
      }
    }
  });

  expect(result.done).toBe(false);
  expect(result.doneReason).toContain("consecutive failing tool steps");
  expect(calls).toBe(10);
  expect(result.steps).toBe(5);
});

test("runAgentLoop: trivial read success cannot reset the failure streak (F6)", async () => {
  // read(ok)+edit(fail) with VARYING targets each turn: pre-F6 the green read
  // reset consecutiveFailures every step, so this looped to maxSteps. Now the
  // step is judged by its non-trivial (mutating) calls and stops at MAX_FAILURES.
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      return JSON.stringify({
        tools: [
          { tool: "read", arguments: { filePath: `a${turn}.txt` } },
          { tool: "edit", arguments: { filePath: `b${turn}.ts`, editBlock: `x${turn}` } },
        ],
      });
    },
  }));

  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }];

  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 12,
    budget: { maxExtensions: 0 },
    tools: {
      read: async () => ({ success: true, output: "file content" }),
      edit: async () => ({ success: false, output: "Failed to apply edit" }),
    },
  });

  expect(result.done).toBe(false);
  expect(result.doneReason).toContain("consecutive failing tool steps");
  expect(result.steps).toBe(5); // stopped at MAX_FAILURES, not maxSteps
});

test("runAgentLoop: read-only-only failing steps still trip the guard; mixed ok-edit resets", async () => {
  // Sanity for the F6 boundary: a step whose MUTATING call SUCCEEDS resets the
  // streak even if a read in the same batch failed.
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      if (turn <= 8) {
        return JSON.stringify({
          tools: [
            { tool: "read", arguments: { filePath: `missing${turn}.txt` } },
            { tool: "edit", arguments: { filePath: `ok${turn}.ts`, editBlock: `y${turn}` } },
          ],
        });
      }
      return JSON.stringify({ tool: "done", arguments: { reason: "Summary: ok Changed Files: x Verification: y" } });
    },
  }));

  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }];

  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 12,
    budget: { maxExtensions: 0 },
    tools: {
      read: async () => ({ success: false, output: "not found" }),
      edit: async () => ({ success: true, output: "updated, tests pass" }),
    },
  });

  expect(result.done).toBe(true); // edits kept succeeding → no failure stop
});
