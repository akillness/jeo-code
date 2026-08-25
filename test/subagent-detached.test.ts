import { test, expect, mock, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolResult } from "../src/agent/tools";
import { MAX_DETACHED_RESULT_BYTES, SubagentRegistry } from "../src/agent/subagent-registry";
import { createSubagentTool } from "../src/agent/subagent-tool";

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

test("subagent tool: truncates oversized settled output and preserves it across tool instances", async () => {
  const reg = new SubagentRegistry();
  const firstTool = createSubagentTool(reg);
  const secondTool = createSubagentTool(reg);
  const cwd = await tmpDir();
  const payload = `HEAD-${"a".repeat(4_096)}${"x".repeat(110 * 1024)}TAIL-${"z".repeat(4_096)}`;
  const originalBytes = Buffer.byteLength(payload, "utf8");
  expect(originalBytes).toBeGreaterThan(MAX_DETACHED_RESULT_BYTES);
  const rec = reg.launch("executor", "produce a large report", async () => ({ success: true, output: payload }));

  try {
    const awaited = await firstTool({ action: "await", ids: [rec.id] }, cwd);
    const inspected = await secondTool({ action: "inspect", id: rec.id }, cwd);
    const marker = /\[…output truncated \(\d+ bytes omitted; original size: \d+ bytes\)…\]/;

    expect(awaited.success).toBe(true);
    expect(awaited.output).toMatch(marker);
    expect(inspected.output).toMatch(marker);
    expect(awaited.output).toContain(`original size: ${originalBytes} bytes`);
    expect(inspected.output).toContain(`original size: ${originalBytes} bytes`);
    expect(awaited.output).toContain("HEAD-");
    expect(awaited.output).toContain("TAIL-");
    expect(inspected.output).toContain("HEAD-");
    expect(inspected.output).toContain("TAIL-");
    expect(Buffer.byteLength(awaited.output, "utf8")).toBeLessThanOrEqual(MAX_DETACHED_RESULT_BYTES + 512);
    expect(Buffer.byteLength(inspected.output, "utf8")).toBeLessThanOrEqual(MAX_DETACHED_RESULT_BYTES + 512);
  } finally {
    reg.cancelAll();
    await reg.awaitIds([rec.id]);
  }
});

test("subagent tool: explicit cancel persists across tool instances", async () => {
  const reg = new SubagentRegistry();
  const launchTool = createSubagentTool(reg);
  const cancelTool = createSubagentTool(reg);
  const inspectTool = createSubagentTool(reg);
  const cwd = await tmpDir();
  let abortSeen = false;
  const rec = reg.launch("planner", "wait for cancellation", signal =>
    new Promise<ToolResult>(resolve => {
      signal.addEventListener("abort", () => {
        abortSeen = true;
        resolve({ success: true, output: "late result must not replace cancellation" });
      });
    }),
  );

  try {
    const listed = await launchTool({ action: "list" }, cwd);
    expect(listed.output).toContain(rec.id);
    const cancelled = await cancelTool({ action: "cancel", id: rec.id }, cwd);
    expect(cancelled.success).toBe(true);
    expect(cancelled.output).toContain("Cancelled 1 subagent(s):");
    const inspected = await inspectTool({ action: "inspect", id: rec.id }, cwd);
    expect(abortSeen).toBe(true);
    expect(inspected.output).toContain("CANCELLED");
    expect(inspected.output).not.toContain("late result must not replace cancellation");
  } finally {
    reg.cancelAll();
    await reg.awaitIds([rec.id]);
  }
});

// ── task tool: detached launch ────────────────────────────────────────────────

test("createTaskTool: detached launch returns immediately and the registry collects the report", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "done", arguments: { reason: "Summary: ok\nChanged Files: a.ts\nVerification: ran" } }),
  }));
  const { createTaskTool } = await import("../src/agent/task-tool");
  const { SubagentRegistry } = await import("../src/agent/subagent-registry");
  const reg = new SubagentRegistry();
  const tool = createTaskTool({ config: { defaultModel: "m", subagents: {} }, registry: reg });

  const res = await tool({ role: "executor", task: "do a thing", detached: true }, await tmpDir());
  expect(res.success).toBe(true);
  expect(res.output).toContain("[detached] launched Executor subagent 'executor-1'");
  expect(reg.list().length).toBe(1);

  const [settled] = await reg.awaitIds(["executor-1"]);
  expect(settled!.status).toBe("completed");
  expect(settled!.result).toContain("[Executor subagent] completed");
});

test("createTaskTool: detached without a registry falls back to a synchronous run", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "done", arguments: { reason: "Summary: ok\nChanged Files: a.ts\nVerification: ran" } }),
  }));
  const { createTaskTool } = await import("../src/agent/task-tool");
  const tool = createTaskTool({ config: { defaultModel: "m", subagents: {} } }); // no registry
  const res = await tool({ role: "executor", task: "do a thing", detached: true }, await tmpDir());
  // No registry → the detached flag is ignored and the full report comes back inline.
  expect(res.output).toContain("[Executor subagent]");
  expect(res.output).not.toContain("[detached] launched");
});
