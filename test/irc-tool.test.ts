import { test, expect, mock, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolResult } from "../src/agent/tools";

afterEach(() => {
  mock.restore();
});

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "jeo-irc-"));
}

// ── SubagentRegistry.steer() ────────────────────────────────────────────────────

test("registry: steer returns false for an unknown id and for an already-finished id", async () => {
  const { SubagentRegistry } = await import("../src/agent/subagent-registry");
  const reg = new SubagentRegistry();
  expect(reg.steer("nope-1", "hello")).toBe(false);

  reg.launch("executor", "quick", async () => ({ success: true, output: "done" }));
  await reg.awaitIds(["executor-1"]);
  expect(reg.get("executor-1")!.status).toBe("completed");
  expect(reg.steer("executor-1", "too late")).toBe(false);
});

test("registry: steer returns true for a running id, message observable via steerDrainFor, second drain empty", async () => {
  const { SubagentRegistry } = await import("../src/agent/subagent-registry");
  const reg = new SubagentRegistry();
  let releaseRunner: (() => void) | undefined;
  const rec = reg.launch("planner", "long", signal =>
    new Promise<ToolResult>(resolve => {
      releaseRunner = () => resolve({ success: true, output: "done" });
      signal.addEventListener("abort", () => resolve({ success: false, output: "aborted" }));
    }),
  );

  expect(reg.steer(rec.id, "  do the extra check  ")).toBe(true);
  const drain = reg.steerDrainFor(rec.id);
  expect(drain()).toEqual(["do the extra check"]);
  expect(drain()).toEqual([]);

  releaseRunner!();
  await reg.awaitIds([rec.id]);
});

// ── task tool: steer reaches a detached subagent's own loop ────────────────────

test("createTaskTool: detached launch + registry.steer reaches the subagent's own agent loop", async () => {
  const capturedHistories: string[] = [];
  let call = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (history: { role: string; content: string }[]) => {
      call++;
      const lastUser = [...history].reverse().find(m => m.role === "user");
      capturedHistories.push(lastUser?.content ?? "");
      if (call === 1) {
        return JSON.stringify({ tool: "read", arguments: { filePath: "x" } });
      }
      return JSON.stringify({
        tool: "done",
        arguments: { reason: "Summary: done\nChanged Files: x.ts\nVerification: ran\nOpen Risks: none\ndone" },
      });
    },
  }));

  const { createTaskTool } = await import("../src/agent/task-tool");
  const { SubagentRegistry } = await import("../src/agent/subagent-registry");
  const reg = new SubagentRegistry();
  const tool = createTaskTool({ config: { defaultModel: "m", subagents: {} }, registry: reg });

  const cwd = await tmpDir();
  const launchRes = await tool({ role: "executor", task: "do a thing", detached: true }, cwd);
  expect(launchRes.success).toBe(true);
  expect(reg.list().length).toBe(1);

  // Window between launch and the 2nd mocked callLlm call: steer the running subagent.
  const ok = reg.steer("executor-1", "some distinctive text");
  expect(ok).toBe(true);

  const [settled] = await reg.awaitIds(["executor-1"]);
  expect(settled!.status).toBe("completed");
  expect(capturedHistories.some(h => h.includes("some distinctive text"))).toBe(true);
});

// ── irc tool ─────────────────────────────────────────────────────────────────

test("createIrcTool: list shows a running peer's id/role/task", async () => {
  const { SubagentRegistry } = await import("../src/agent/subagent-registry");
  const { createIrcTool } = await import("../src/agent/irc-tool");
  const reg = new SubagentRegistry();
  const tool = createIrcTool(reg);
  const cwd = await tmpDir();

  let res = await tool({ action: "list" }, cwd);
  expect(res.output).toContain("No running subagent peers");

  reg.launch("executor", "build the thing", signal =>
    new Promise<ToolResult>(resolve => {
      signal.addEventListener("abort", () => resolve({ success: false, output: "aborted" }));
    }),
  );
  res = await tool({ action: "list" }, cwd);
  expect(res.success).toBe(true);
  expect(res.output).toContain("executor-1");
  expect(res.output).toContain("executor");
  expect(res.output).toContain("build the thing");

  reg.cancelAll();
});

test("createIrcTool: send to a specific id succeeds and is drainable via steerDrainFor", async () => {
  const { SubagentRegistry } = await import("../src/agent/subagent-registry");
  const { createIrcTool } = await import("../src/agent/irc-tool");
  const reg = new SubagentRegistry();
  const tool = createIrcTool(reg);

  const rec = reg.launch("planner", "x", signal =>
    new Promise<ToolResult>(resolve => {
      signal.addEventListener("abort", () => resolve({ success: false, output: "aborted" }));
    }),
  );

  const res = await tool({ action: "send", to: rec.id, message: "hello peer" }, await tmpDir());
  expect(res.success).toBe(true);
  expect(res.output).toContain(rec.id);
  expect(reg.steerDrainFor(rec.id)()).toEqual(["hello peer"]);

  reg.cancelAll();
});

test("createIrcTool: send to 'all' reaches multiple running peers", async () => {
  const { SubagentRegistry } = await import("../src/agent/subagent-registry");
  const { createIrcTool } = await import("../src/agent/irc-tool");
  const reg = new SubagentRegistry();
  const tool = createIrcTool(reg);

  const a = reg.launch("executor", "a", signal =>
    new Promise<ToolResult>(resolve => { signal.addEventListener("abort", () => resolve({ success: false, output: "aborted" })); }),
  );
  const b = reg.launch("planner", "b", signal =>
    new Promise<ToolResult>(resolve => { signal.addEventListener("abort", () => resolve({ success: false, output: "aborted" })); }),
  );

  const res = await tool({ action: "send", to: "all", message: "broadcast" }, await tmpDir());
  expect(res.success).toBe(true);
  expect(res.output).toContain("2 running peer");
  expect(reg.steerDrainFor(a.id)()).toEqual(["broadcast"]);
  expect(reg.steerDrainFor(b.id)()).toEqual(["broadcast"]);

  reg.cancelAll();
});

test("createIrcTool: send to an unknown id fails with a clear error", async () => {
  const { SubagentRegistry } = await import("../src/agent/subagent-registry");
  const { createIrcTool } = await import("../src/agent/irc-tool");
  const reg = new SubagentRegistry();
  const tool = createIrcTool(reg);

  const res = await tool({ action: "send", to: "ghost-1", message: "hi" }, await tmpDir());
  expect(res.success).toBe(false);
  expect(res.error).toContain("ghost-1");
});

test("createIrcTool: unknown action fails", async () => {
  const { SubagentRegistry } = await import("../src/agent/subagent-registry");
  const { createIrcTool } = await import("../src/agent/irc-tool");
  const reg = new SubagentRegistry();
  const tool = createIrcTool(reg);

  const res = await tool({ action: "bogus" }, await tmpDir());
  expect(res.success).toBe(false);
  expect(res.error).toContain("Unknown irc action");
});
