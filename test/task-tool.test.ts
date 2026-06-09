import { test, expect, mock, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Each test re-mocks ../src/agent/loop; restore afterwards so other suites are clean.
afterEach(() => {
  mock.restore();
});

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "joc-task-"));
}

test("createTaskTool: executor delegates, runs a tool, then completes on done", async () => {
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      if (turn === 1) return JSON.stringify({ tool: "find", arguments: { globPattern: "*" } });
      return JSON.stringify({ tool: "done", arguments: { reason: "Summary:\nChanged Files:\nVerification:\nOpen Risks:\nscaffold ready" } });
    },
  }));

  const { createTaskTool } = await import("../src/agent/task-tool");
  const events: string[] = [];
  const tool = createTaskTool({
    config: { defaultModel: "ollama/fast", subagents: {} },
    onEvent: e => events.push(`${e.role}:${e.kind}${e.detail ? ":" + e.detail : ""}`),
  });

  const cwd = await tmpDir();
  const res = await tool({ role: "executor", task: "scaffold the project" }, cwd);

  expect(res.success).toBe(true);
  expect(res.output).toContain("[Executor subagent] completed");
  expect(res.output).toContain("scaffold ready");
  expect(res.output).toContain("step 1/15: find *");
  expect(res.output).toContain("✓ find");
  expect(events.some(e => e.startsWith("executor:start"))).toBe(true);
  expect(events.some(e => e === "executor:step:find *")).toBe(true); // step header carries the pending target before the result
  expect(events.some(e => e === "executor:tool:find *")).toBe(true); // detail carries the glob target
  expect(events.some(e => e.startsWith("executor:done"))).toBe(true);
});

test("createTaskTool: subagent tool events carry the concrete target (file/command), not just the name", async () => {
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      if (turn === 1) return JSON.stringify({ tool: "read", arguments: { filePath: "src/agent/engine.ts" } });
      if (turn === 2) return JSON.stringify({ tool: "bash", arguments: { command: "echo hi\nsecond line" } });
      return JSON.stringify({ tool: "done", arguments: { reason: "ok" } });
    },
  }));
  const { createTaskTool } = await import("../src/agent/task-tool");
  const toolEvents: string[] = [];
  const toolSummaries: string[] = [];
  const tool = createTaskTool({
    config: { defaultModel: "ollama/fast", subagents: {} },
    onEvent: e => {
      if (e.kind === "tool") {
        toolEvents.push(e.detail ?? "");
        toolSummaries.push(e.summary ?? "");
      }
    },
  });
  const res = await tool({ role: "executor", task: "inspect" }, await tmpDir());

  expect(toolEvents).toContain("read src/agent/engine.ts"); // file target, not bare "read"
  expect(toolEvents).toContain("bash: echo hi");            // first command line only
  expect(res.output).toContain("read src/agent/engine.ts"); // trace also carries the enriched target
  expect(toolSummaries.some(s => s.length > 0)).toBe(true);          // result summary is surfaced for cmd/TUI streams
});

test("createTaskTool: unknown explicit role is rejected instead of executor fallback", async () => {
  const { createTaskTool } = await import("../src/agent/task-tool");
  const tool = createTaskTool({ config: { defaultModel: "m", subagents: {} } });
  const res = await tool({ role: "nonsense", task: "do a thing" }, await tmpDir());
  expect(res.success).toBe(false);
  expect(res.error).toContain("Unknown subagent role 'nonsense'");
  expect(res.error).toContain("executor, planner, architect, critic");
});

test("createTaskTool: omitted role defaults to executor", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "done", arguments: { reason: "Summary:\nChanged Files:\nVerification:\nOpen Risks:" } }),
  }));
  const { createTaskTool } = await import("../src/agent/task-tool");
  const tool = createTaskTool({ config: { defaultModel: "m", subagents: {} } });
  const res = await tool({ task: "do a thing" }, await tmpDir());
  expect(res.success).toBe(true);
  expect(res.output).toContain("[Executor subagent]");
});

test("createTaskTool: read-only role (architect) cannot write — write tool is absent", async () => {
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      // Architect tries to write (not in its toolset) → unknown tool, then reviews via done.
      if (turn === 1) return JSON.stringify({ tool: "write", arguments: { filePath: "x.txt", content: "hi" } });
      return JSON.stringify({ tool: "done", arguments: { reason: "Summary:\nFindings:\nRecommendations:\nArchitectural Status: WATCH\nCode Review Recommendation: COMMENT" } });
    },
  }));
  const { createTaskTool } = await import("../src/agent/task-tool");
  const tool = createTaskTool({ config: { defaultModel: "m", subagents: {} } });
  const cwd = await tmpDir();
  const res = await tool({ role: "architect", task: "review the design" }, cwd);

  expect(res.success).toBe(true);
  expect(res.output).toContain("[Architect subagent]");
  // The write must NOT have created a file (tool was unavailable to the read-only role).
  await expect(fs.access(path.join(cwd, "x.txt"))).rejects.toThrow();
});

test("createTaskTool: empty task is rejected with a helpful error", async () => {
  const { createTaskTool } = await import("../src/agent/task-tool");
  const tool = createTaskTool({ config: { defaultModel: "m", subagents: {} } });
  const res = await tool({ role: "executor", task: "   " }, await tmpDir());
  expect(res.success).toBe(false);
  expect(res.error).toContain("requires a non-empty 'task'");
});

test("createTaskTool: per-role model override is reported in the output", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "done", arguments: { reason: "Summary:\nIn Scope:\nOut of Scope:\nFile-level Changes:\nSequencing:\nAcceptance Criteria:\nVerification:\nRisks:" } }),
  }));
  const { createTaskTool } = await import("../src/agent/task-tool");
  const tool = createTaskTool({
    config: { defaultModel: "ollama/fast", subagents: { planner: { model: "gemini-2.5-pro" } } },
  });
  const res = await tool({ role: "planner", task: "sequence the work" }, await tmpDir());
  expect(res.success).toBe(true);
  expect(res.output).toContain("on gemini-2.5-pro");
});
test("createTaskTool: read-only fan-out runs all tasks and combines results", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "done", arguments: { reason: "Summary:\nFindings:\nRecommendations:\nArchitectural Status: CLEAR\nCode Review Recommendation: APPROVE" } }),
  }));
  const { createTaskTool } = await import("../src/agent/task-tool");
  const tool = createTaskTool({ config: { defaultModel: "m", subagents: {} } });
  const res = await tool({ role: "architect", tasks: ["review A", "review B", "review C"] }, await tmpDir());
  expect(res.success).toBe(true);
  expect(res.output).toContain("[Architect fan-out] 3/3 completed (concurrency 3)");
  expect(res.output).toContain("### Task 1/3");
  expect(res.output).toContain("### Task 3/3");
});

test("createTaskTool: executor fan-out is serialized for mutation safety", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "done", arguments: { reason: "Summary:\nChanged Files:\nVerification:\nOpen Risks:" } }),
  }));
  const { createTaskTool } = await import("../src/agent/task-tool");
  const tool = createTaskTool({ config: { defaultModel: "m", subagents: {} } });
  const res = await tool({ role: "executor", tasks: ["t1", "t2"] }, await tmpDir());
  expect(res.output).toContain("executor — serialized");
});

test("createTaskTool: empty tasks array is a soft error", async () => {
  const { createTaskTool } = await import("../src/agent/task-tool");
  const tool = createTaskTool({ config: { defaultModel: "m", subagents: {} } });
  const res = await tool({ role: "architect", tasks: [] }, await tmpDir());
  expect(res.success).toBe(false);
  expect(res.error).toContain("non-empty 'tasks'");
});

test("createTaskTool: invalid planner report is surfaced as incomplete", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "done", arguments: { reason: "planned" } }),
  }));
  const { createTaskTool } = await import("../src/agent/task-tool");
  const tool = createTaskTool({ config: { defaultModel: "m", subagents: {} } });
  const res = await tool({ role: "planner", task: "sequence the work" }, await tmpDir());
  expect(res.success).toBe(false);
  expect(res.output).toContain("contract incomplete");
  expect(res.output).toContain("File-level Changes:");
});
