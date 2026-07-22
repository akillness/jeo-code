import { test, expect, mock, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolResult } from "../src/agent/tools";

afterEach(() => {
  mock.restore();
});

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "jeo-detach-"));
}

// ── SubagentRegistry ──────────────────────────────────────────────────────────

test("registry: launch → await reflects terminal completed state", async () => {
  const { SubagentRegistry } = await import("../src/agent/subagent-registry");
  const reg = new SubagentRegistry();
  const rec = reg.launch("executor", "do x", async () => ({ success: true, output: "done report" }));
  expect(rec.id).toBe("executor-1");
  expect(rec.status).toBe("running");
  expect(reg.running().length).toBe(1);

  const [settled] = await reg.awaitIds(["executor-1"]);
  expect(settled!.status).toBe("completed");
  expect(settled!.success).toBe(true);
  expect(settled!.result).toBe("done report");
  expect(reg.running().length).toBe(0);
});

test("registry: a failing run settles as failed and a throw becomes failed", async () => {
  const { SubagentRegistry } = await import("../src/agent/subagent-registry");
  const reg = new SubagentRegistry();
  reg.launch("executor", "fail", async () => ({ success: false, output: "nope" }) as ToolResult);
  reg.launch("executor", "throw", async () => { throw new Error("boom"); });
  const [a, b] = await reg.awaitIds(["executor-1", "executor-2"]);
  expect(a!.status).toBe("failed");
  expect(b!.status).toBe("failed");
  expect(b!.result).toContain("boom");
});

test("registry: ids increment per role", async () => {
  const { SubagentRegistry } = await import("../src/agent/subagent-registry");
  const reg = new SubagentRegistry();
  const a = reg.launch("executor", "1", async () => ({ success: true, output: "" }));
  const b = reg.launch("executor", "2", async () => ({ success: true, output: "" }));
  const c = reg.launch("planner", "3", async () => ({ success: true, output: "" }));
  expect([a.id, b.id, c.id]).toEqual(["executor-1", "executor-2", "planner-1"]);
  await reg.awaitIds([a.id, b.id, c.id]);
});

test("registry: cancel aborts a running run and the result does not overwrite the terminal state", async () => {
  const { SubagentRegistry } = await import("../src/agent/subagent-registry");
  const reg = new SubagentRegistry();
  let abortSeen = false;
  const rec = reg.launch("planner", "long", signal =>
    new Promise<ToolResult>(resolve => {
      signal.addEventListener("abort", () => { abortSeen = true; resolve({ success: true, output: "late win" }); });
    }),
  );
  const [cancelled] = reg.cancel([rec.id]);
  expect(cancelled!.status).toBe("cancelled");
  expect(abortSeen).toBe(true);
  await reg.awaitIds([rec.id]);
  // The runner resolved with success AFTER the cancel — the terminal "cancelled" wins.
  expect(reg.get(rec.id)!.status).toBe("cancelled");
  expect(reg.get(rec.id)!.result).toBeUndefined();
});

test("registry: awaitIds honours a timeout while the run is still going", async () => {
  const { SubagentRegistry } = await import("../src/agent/subagent-registry");
  const reg = new SubagentRegistry();
  const rec = reg.launch("architect", "slow", signal =>
    new Promise<ToolResult>(resolve => {
      const t = setTimeout(() => resolve({ success: true, output: "late" }), 5000);
      signal.addEventListener("abort", () => { clearTimeout(t); resolve({ success: false, output: "aborted" }); });
    }),
  );
  const snap = await reg.awaitIds([rec.id], 20);
  expect(snap[0]!.status).toBe("running"); // timed out before completion
  reg.cancelAll(); // releases the timer so the test exits cleanly
});
test("subagent tool: await timeout is a successful running snapshot", async () => {
  const { SubagentRegistry } = await import("../src/agent/subagent-registry");
  const { createSubagentTool } = await import("../src/agent/subagent-tool");
  const reg = new SubagentRegistry();
  const tool = createSubagentTool(reg);
  const rec = reg.launch("architect", "slow", signal =>
    new Promise<ToolResult>(resolve => {
      signal.addEventListener("abort", () => resolve({ success: false, output: "aborted" }));
    }),
  );

  const result = await tool({ action: "await", ids: [rec.id], timeoutMs: 1 }, await tmpDir());
  expect(result.success).toBe(true);
  expect(result.output).toContain("still running");
  expect(result.output).toContain("[RUNNING]");
  reg.cancelAll();
});

// ── subagent control tool ───────────────────────────────────────────────────────

test("subagent tool: list / await / inspect over the registry", async () => {
  const { SubagentRegistry } = await import("../src/agent/subagent-registry");
  const { createSubagentTool } = await import("../src/agent/subagent-tool");
  const reg = new SubagentRegistry();
  const tool = createSubagentTool(reg);
  const cwd = await tmpDir();

  let res = await tool({ action: "list" }, cwd);
  expect(res.output).toContain("No detached subagents");

  reg.launch("executor", "build the thing", async () => ({ success: true, output: "report A" }));
  res = await tool({ action: "list" }, cwd);
  expect(res.output).toContain("executor-1");
  expect(res.output).toContain("build the thing");

  res = await tool({ action: "await", ids: ["executor-1"] }, cwd);
  expect(res.success).toBe(true);
  expect(res.output).toContain("all settled");
  expect(res.output).toContain("report A");

  res = await tool({ action: "inspect", ids: ["executor-1"] }, cwd);
  expect(res.output).toContain("COMPLETED");

  res = await tool({ action: "bogus" }, cwd);
  expect(res.success).toBe(false);
  expect(res.error).toContain("Unknown subagent action");
});

test("subagent tool: cancel all running detached runs", async () => {
  const { SubagentRegistry } = await import("../src/agent/subagent-registry");
  const { createSubagentTool } = await import("../src/agent/subagent-tool");
  const reg = new SubagentRegistry();
  const tool = createSubagentTool(reg);
  reg.launch("planner", "x", signal =>
    new Promise<ToolResult>(resolve => {
      signal.addEventListener("abort", () => resolve({ success: false, output: "aborted" }));
    }),
  );
  const res = await tool({ action: "cancel" }, await tmpDir());
  expect(res.output).toContain("Cancelled");
  expect(reg.get("planner-1")!.status).toBe("cancelled");
});

// ── task tool: detached launch ────────────────────────────────────────────────

test("createTaskTool: detached launch returns immediately and the registry collects the report", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "done", arguments: { reason: "Summary: ok\nChanged Files: a.ts\nVerification: ran" } }),
  }));
  const { createTaskTool } = await import("../src/agent/task-tool");
  const { SubagentRegistry } = await import("../src/agent/subagent-registry");
  const reg = new SubagentRegistry();
  const events: Array<{ id?: string; detached?: boolean }> = [];
  const tool = createTaskTool({
    config: { defaultModel: "m", subagents: {} },
    registry: reg,
    onEvent: event => events.push(event),
  });

  const res = await tool({ role: "executor", task: "do a thing", detached: true }, await tmpDir());
  expect(res.success).toBe(true);
  expect(res.output).toContain("[detached] launched Executor subagent 'executor-1'");
  expect(reg.list().length).toBe(1);

  const [settled] = await reg.awaitIds(["executor-1"]);
  expect(settled!.status).toBe("completed");
  expect(settled!.result).toContain("[Executor subagent] completed");
  expect(events.length).toBeGreaterThan(0);
  expect(events.every(event => event.id === "executor-1" && event.detached === true)).toBe(true);
});
test("createTaskTool: string true dispatches a detached run instead of silently blocking", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "done", arguments: { reason: "Summary: ok\nChanged Files: a.ts\nVerification: ran" } }),
  }));
  const { createTaskTool } = await import("../src/agent/task-tool");
  const { SubagentRegistry } = await import("../src/agent/subagent-registry");
  const reg = new SubagentRegistry();
  const res = await createTaskTool({ config: { defaultModel: "m", subagents: {} }, registry: reg })(
    { role: "executor", task: "do a thing", detached: "true" },
    await tmpDir(),
  );

  expect(res.success).toBe(true);
  expect(res.output).toContain("[detached] launched");
  expect(reg.list()).toHaveLength(1);
  await reg.awaitIds(["executor-1"]);
});

test("createTaskTool: detached without a registry falls back to a synchronous run", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "done", arguments: { reason: "Summary: ok\nChanged Files: a.ts\nVerification: ran" } }),
  }));
  const { createTaskTool } = await import("../src/agent/task-tool");
  const events: Array<{ id?: string; detached?: boolean }> = [];
  const tool = createTaskTool({
    config: { defaultModel: "m", subagents: {} },
    onEvent: event => events.push(event),
  }); // no registry
  const res = await tool({ role: "executor", task: "do a thing", detached: true }, await tmpDir());
  // No registry → the detached flag is ignored and the full report comes back inline.
  expect(res.output).toContain("[Executor subagent]");
  expect(res.output).not.toContain("[detached] launched");
  expect(events.every(event => event.id === undefined && event.detached === undefined)).toBe(true);
});
test("createTaskTool: detached cap refuses a fifth running run but permits a terminal record to remain inspectable", async () => {
  const releases: Array<() => void> = [];
  let started = 0;
  let fourStarted!: () => void;
  const allStarted = new Promise<void>(resolve => { fourStarted = resolve; });
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      started++;
      if (started === 4) fourStarted();
      await new Promise<void>(resolve => releases.push(resolve));
      return JSON.stringify({ tool: "done", arguments: { reason: "Summary: ok\nChanged Files: a.ts\nVerification: ran" } });
    },
  }));

  const { createTaskTool } = await import("../src/agent/task-tool");
  const { SubagentRegistry } = await import("../src/agent/subagent-registry");
  const reg = new SubagentRegistry();
  const tool = createTaskTool({ config: { defaultModel: "m", subagents: {} }, registry: reg });
  const cwd = await tmpDir();

  for (let n = 0; n < 4; n++) {
    expect((await tool({ role: "executor", task: `run ${n}`, detached: true }, cwd)).success).toBe(true);
  }
  await allStarted;
  const refused = await tool({ role: "executor", task: "fifth", detached: true }, cwd);
  expect(refused.success).toBe(false);
  expect(refused.error).toContain("limit reached");
  expect(reg.running()).toHaveLength(4);
  expect(started).toBe(4);

  for (const release of releases) release();
  await reg.awaitIds(reg.running().map(rec => rec.id));
  expect(reg.get("executor-1")!.result).toContain("[Executor subagent] completed");
  expect((await tool({ role: "executor", task: "after terminal", detached: true }, cwd)).success).toBe(true);
  reg.cancelAll();
});
test("createTaskTool: cancelling a detached bash run kills the active child process", async () => {
  const cwd = await tmpDir();
  const started = path.join(cwd, "bash-started");
  const leaked = path.join(cwd, "must-not-exist");
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({
      tool: "bash",
      arguments: {
        command: `printf started > ${JSON.stringify(started)}; sleep 1; printf leaked > ${JSON.stringify(leaked)}`,
      },
    }),
  }));
  const { createTaskTool } = await import("../src/agent/task-tool");
  const { SubagentRegistry } = await import("../src/agent/subagent-registry");
  const reg = new SubagentRegistry();
  try {
    const result = await createTaskTool({ config: { defaultModel: "m", subagents: {} }, registry: reg })(
      { role: "executor", task: "run a long command", detached: true },
      cwd,
    );
    expect(result.success).toBe(true);

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        await fs.access(started);
        break;
      } catch {
        await Bun.sleep(10);
      }
    }
    await fs.access(started);

    reg.cancel(["executor-1"]);
    await reg.awaitIds(["executor-1"]);
    await Bun.sleep(1_200);
    await expect(fs.access(leaked)).rejects.toThrow();
    expect(reg.get("executor-1")!.status).toBe("cancelled");
  } finally {
    reg.cancelAll();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
test("createTaskTool: cancellation before a detached write prevents the mutation", async () => {
  const cwd = await tmpDir();
  const leaked = path.join(cwd, "must-not-write.txt");
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({
      tool: "write",
      arguments: { filePath: "must-not-write.txt", content: "leaked" },
    }),
  }));
  const { createTaskTool } = await import("../src/agent/task-tool");
  const { SubagentRegistry } = await import("../src/agent/subagent-registry");
  const reg = new SubagentRegistry();
  try {
    const tool = createTaskTool({
      config: { defaultModel: "m", subagents: {} },
      registry: reg,
      onEvent: event => {
        if (event.kind === "step" && event.id) reg.cancel([event.id]);
      },
    });
    const result = await tool({ role: "executor", task: "write a file", detached: true }, cwd);
    expect(result.success).toBe(true);
    await reg.awaitIds(["executor-1"]);
    expect(reg.get("executor-1")!.status).toBe("cancelled");
    await expect(fs.access(leaked)).rejects.toThrow();
  } finally {
    reg.cancelAll();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("createTaskTool: rejects detached fan-out instead of silently running it synchronously", async () => {
  const { createTaskTool } = await import("../src/agent/task-tool");
  const { SubagentRegistry } = await import("../src/agent/subagent-registry");
  const cwd = await tmpDir();
  const reg = new SubagentRegistry();
  try {
    const result = await createTaskTool({ config: { defaultModel: "m", subagents: {} }, registry: reg })(
      { role: "executor", tasks: ["one", "two"], detached: true },
      cwd,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Detached task fan-out is not supported");
    expect(reg.list()).toEqual([]);
  } finally {
    reg.cancelAll();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
