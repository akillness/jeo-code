import { test, expect, mock } from "bun:test";

// Regression: a turn that successfully writes/edits files must SURFACE those paths
// on the loop result (result.mutatedFiles) so a caller/orchestrator can collect the
// run's code artifacts. Previously AgentLoopResult exposed only a boolean-free
// done/steps/usage shape, so an orchestrator that read a "finalArtifacts" change set
// always saw it empty even after real edits ("Agent finished but made zero valid
// code changes (finalArtifacts is empty)").

test("runAgentLoop: a successful write/edit turn returns the mutated file paths (repo-relative, sorted, de-duped)", async () => {
  let llmCalls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      llmCalls++;
      if (llmCalls === 1) {
        return JSON.stringify({
          tools: [
            { tool: "write", arguments: { filePath: "src/b.ts", content: "b" } },
            { tool: "edit", arguments: { filePath: "src/a.ts", editBlock: "x" } },
          ],
        });
      }
      if (llmCalls === 2) {
        // A second edit to an already-mutated file must NOT duplicate the entry.
        return JSON.stringify({ tool: "edit", arguments: { filePath: "./src/a.ts", editBlock: "y" } });
      }
      return JSON.stringify({ tool: "done", arguments: { reason: "done" } });
    },
  }));

  const { runAgentLoop } = await import("../src/agent/engine");
  const result = await runAgentLoop([{ role: "system" as const, content: "sys" }], {
    cwd: process.cwd(),
    maxSteps: 6,
    budget: { maxExtensions: 0 },
    tools: {
      write: async () => ({ success: true, output: "wrote" }),
      edit: async () => ({ success: true, output: "edited" }),
    },
  });

  expect(result.done).toBe(true);
  expect(result.mutatedFiles).toEqual(["src/a.ts", "src/b.ts"]);
});

test("runAgentLoop: a FAILED write is not counted as an artifact", async () => {
  let llmCalls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      llmCalls++;
      if (llmCalls === 1) return JSON.stringify({ tool: "write", arguments: { filePath: "src/x.ts", content: "x" } });
      return JSON.stringify({ tool: "done", arguments: { reason: "done" } });
    },
  }));

  const { runAgentLoop } = await import("../src/agent/engine");
  const result = await runAgentLoop([{ role: "system" as const, content: "sys" }], {
    cwd: process.cwd(),
    maxSteps: 4,
    budget: { maxExtensions: 0 },
    tools: { write: async () => ({ success: false, output: "", error: "boom" }) },
  });

  expect(result.done).toBe(true);
  expect(result.mutatedFiles).toBeUndefined();
});

test("runAgentLoop: a read-only turn exposes no mutatedFiles", async () => {
  let llmCalls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      llmCalls++;
      if (llmCalls === 1) return JSON.stringify({ tool: "read", arguments: { filePath: "src/x.ts" } });
      return JSON.stringify({ tool: "done", arguments: { reason: "looked" } });
    },
  }));

  const { runAgentLoop } = await import("../src/agent/engine");
  const result = await runAgentLoop([{ role: "system" as const, content: "sys" }], {
    cwd: process.cwd(),
    maxSteps: 4,
    budget: { maxExtensions: 0 },
    tools: { read: async () => ({ success: true, output: "contents" }) },
  });

  expect(result.done).toBe(true);
  expect(result.mutatedFiles).toBeUndefined();
});
