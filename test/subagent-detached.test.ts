import { test, expect, mock, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolResult } from "../src/agent/tools";
import { MAX_DETACHED_RESULT_BYTES, SubagentRegistry } from "../src/agent/subagent-registry";
import { createSubagentTool } from "../src/agent/subagent-tool";
import * as loop from "../src/agent/loop";
import { createTaskTool } from "../src/agent/task-tool";

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
test("registry and control tool preserve mutation evidence from a settled delegated run", async () => {
  const reg = new SubagentRegistry();
  const control = createSubagentTool(reg);
  const rec = reg.launch("executor", "mutate workspace", async () => ({
    success: true,
    output: "changed files",
    mutationMayHaveOccurred: true,
  }));

  const [settled] = await reg.awaitIds([rec.id]);
  const awaited = await control({ action: "await", ids: [rec.id] }, await tmpDir());
  const inspected = await control({ action: "inspect", id: rec.id }, await tmpDir());

  expect(settled!.mutationMayHaveOccurred).toBe(true);
  expect(awaited.success).toBe(true);
  expect(awaited.mutationMayHaveOccurred).toBe(true);
  expect(inspected.success).toBe(true);
  expect(inspected.mutationMayHaveOccurred).toBe(true);
});

test("cancelled detached runs retain mutation evidence when their runner settles later", async () => {
  const reg = new SubagentRegistry();
  const control = createSubagentTool(reg);
  const runner = Promise.withResolvers<ToolResult>();
  const rec = reg.launch("executor", "possibly mutate workspace", () => runner.promise);

  reg.cancel([rec.id]);
  runner.resolve({ success: true, output: "late mutation", mutationMayHaveOccurred: true });
  const [settled] = await reg.awaitIds([rec.id]);
  const inspected = await control({ action: "inspect", id: rec.id }, await tmpDir());

  expect(settled!.status).toBe("cancelled");
  expect(settled!.mutationMayHaveOccurred).toBe(true);
  expect(inspected.mutationMayHaveOccurred).toBe(true);
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

test("registry: cancelled mutating runs remain in flight until their runner settles", async () => {
  const reg = new SubagentRegistry();
  const runner = Promise.withResolvers<ToolResult>();
  const rec = reg.launch("executor", "long mutation", () => runner.promise);

  reg.cancel([rec.id]);

  expect(reg.get(rec.id)!.status).toBe("cancelled");
  expect(reg.inFlightMutators().map(({ id }) => id)).toEqual([rec.id]);

  runner.resolve({ success: true, output: "late completion" });
  await reg.awaitIds([rec.id]);

  expect(reg.get(rec.id)!.status).toBe("cancelled");
  expect(reg.inFlightMutators()).toEqual([]);
});

test("registry: completed and read-only runners are not in-flight mutators", async () => {
  const reg = new SubagentRegistry();
  const completed = reg.launch("executor", "already done", async () => ({ success: true, output: "done" }));
  await reg.awaitIds([completed.id]);
  expect(reg.inFlightMutators()).toEqual([]);

  const readOnlyRun = Promise.withResolvers<ToolResult>();
  const readOnly = reg.launch("planner", "inspect only", () => readOnlyRun.promise, { readOnly: true });
  expect(reg.inFlightMutators()).toEqual([]);

  readOnlyRun.resolve({ success: true, output: "reviewed" });
  await reg.awaitIds([readOnly.id]);
  expect(reg.inFlightMutators()).toEqual([]);
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

test("createTaskTool: single delegated task returns mutation evidence to its parent", async () => {
  let turn = 0;
  const verificationCommand = `bun test ${path.join(process.cwd(), "test/engine.test.ts")} --test-name-pattern extractJsonObject`;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      if (turn === 1) return JSON.stringify({ tool: "write", arguments: { filePath: "single.txt", content: "changed" } });
      if (turn === 2) return JSON.stringify({ tool: "bash", arguments: { command: verificationCommand } });
      return JSON.stringify({ tool: "done", arguments: { reason: `Summary: ok\nChanged Files: single.txt\nVerification: ran ${verificationCommand}` } });
    },
  }));
  const { createTaskTool } = await import("../src/agent/task-tool");
  const cwd = await tmpDir();
  const result = await createTaskTool({ config: { defaultModel: "m", subagents: {} } })({ role: "executor", task: "mutate the workspace" }, cwd);

  expect(result.success).toBe(true);
  expect(result.mutationMayHaveOccurred).toBe(true);
  expect(await fs.readFile(path.join(cwd, "single.txt"), "utf8")).toBe("changed");
});

test("createTaskTool: fan-out mutation evidence is OR-aggregated across workers", async () => {
  const verificationCommand = `bun test ${path.join(process.cwd(), "test/engine.test.ts")} --test-name-pattern extractJsonObject`;
  type MessageLike = { role: string; content: string };
  const turns = new Map<string, number>();
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (messages: MessageLike[]) => {
      const task = messages.find(message => message.role === "user")?.content ?? "";
      const key = task.includes("mutate") ? "mutate" : "read";
      const turn = (turns.get(key) ?? 0) + 1;
      turns.set(key, turn);
      if (key === "read") return JSON.stringify({ tool: "done", arguments: { reason: "Summary: reviewed\nChanged Files: none\nVerification: ran" } });
      if (turn === 1) return JSON.stringify({ tool: "write", arguments: { filePath: "fanout.txt", content: "changed" } });
      if (turn === 2) return JSON.stringify({ tool: "bash", arguments: { command: verificationCommand } });
      return JSON.stringify({ tool: "done", arguments: { reason: `Summary: ok\nChanged Files: fanout.txt\nVerification: ran ${verificationCommand}` } });
    },
  }));
  const { createTaskTool } = await import("../src/agent/task-tool");
  const cwd = await tmpDir();
  const result = await createTaskTool({ config: { defaultModel: "m", subagents: {} } })({
    role: "executor",
    tasks: ["read the workspace", "mutate the workspace"],
  }, cwd);

  expect(result.success).toBe(true);
  expect(result.mutationMayHaveOccurred).toBe(true);
  expect(await fs.readFile(path.join(cwd, "fanout.txt"), "utf8")).toBe("changed");
});

test("createTaskTool: detached launch returns mutation evidence with the collected report", async () => {
  let turn = 0;
  const verificationCommand = `bun test ${path.join(process.cwd(), "test/engine.test.ts")} --test-name-pattern extractJsonObject`;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      if (turn === 1) {
        return JSON.stringify({ tool: "write", arguments: { filePath: "delegated.txt", content: "changed" } });
      }
      if (turn === 2) {
        return JSON.stringify({ tool: "bash", arguments: { command: verificationCommand } });
      }
      return JSON.stringify({ tool: "done", arguments: { reason: `Summary: ok\nChanged Files: delegated.txt\nVerification: ran ${verificationCommand}` } });
    },
  }));
  const { createTaskTool } = await import("../src/agent/task-tool");
  const { SubagentRegistry } = await import("../src/agent/subagent-registry");
  const reg = new SubagentRegistry();
  const cwd = await tmpDir();
  const tool = createTaskTool({ config: { defaultModel: "m", subagents: {} }, registry: reg });

  const res = await tool({ role: "executor", task: "mutate the workspace", detached: true }, cwd);
  expect(res.success).toBe(true);
  expect(res.mutationMayHaveOccurred).toBe(true);
  expect(reg.list().length).toBe(1);

  const [settled] = await reg.awaitIds(["executor-1"]);
  expect(settled!.status).toBe("completed");
  expect(settled!.result).toContain("[Executor subagent] completed");
  expect(settled!.mutationMayHaveOccurred).toBe(true);
  expect(await fs.readFile(path.join(cwd, "delegated.txt"), "utf8")).toBe("changed");
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

test("subagent tool: supports pause, resume, verbosity, limit, and id security validation", async () => {
  const reg = new SubagentRegistry();
  const tool = createSubagentTool(reg);
  const cwd = await tmpDir();

  // 1. Launch a subagent that keeps running and drains steering
  let pausedSeen = false;
  let resumeSeen = false;
  const rec = reg.launch("executor", "long task", async (signal, id) => {
    const drain = reg.steerDrainFor(id);
    while (!signal.aborted) {
      const msgs = drain();
      if (msgs.some(m => m.includes("Stop at the next safe boundary"))) {
        pausedSeen = true;
      }
      if (msgs.some(m => m.includes("resume work"))) {
        resumeSeen = true;
        return { success: true, output: "Resumed work finished successfully." };
      }
      await new Promise(r => setTimeout(r, 10));
    }
    return { success: false, output: "Aborted." };
  });

  // 2. Pause action
  const pauseRes = await tool({ action: "pause", id: rec.id }, cwd);
  expect(pauseRes.success).toBe(true);
  expect(pauseRes.output).toContain("PAUSED");
  await new Promise(r => setTimeout(r, 25));
  expect(pausedSeen).toBe(true);

  // 3. Verbosity and limit in list/inspect
  const listReceipt = await tool({ action: "list", verbosity: "receipt" }, cwd);
  expect(listReceipt.success).toBe(true);
  expect(listReceipt.output).toContain(rec.id);

  // full verbosity forbidden on list
  const listFull = await tool({ action: "list", verbosity: "full" }, cwd);
  expect(listFull.success).toBe(false);
  expect(listFull.error).toContain("verbosity='full' is not permitted with action='list'");

  // 4. Resume action
  const resumeRes = await tool({ action: "resume", id: rec.id, message: "resume work" }, cwd);
  expect(resumeRes.success).toBe(true);
  expect(resumeRes.output).toContain("Resumed subagent");

  // 5. Await settled
  const awaitRes = await tool({ action: "await", id: rec.id, timeoutMs: 1000 }, cwd);
  expect(awaitRes.success).toBe(true);
  expect(resumeSeen).toBe(true);
  expect(awaitRes.output).toContain("Resumed work finished successfully.");

  // 6. Security: reject invalid subagent IDs (prevent path traversal / malicious payload injection)
  const invalidIdRes = await tool({ action: "steer", id: "../../evil/path", message: "hi" }, cwd);
  expect(invalidIdRes.success).toBe(false);
  expect(invalidIdRes.error).toContain("Invalid subagent id");
});
test("registry: setActivity tracks live subagent activity in list and inspect", async () => {
  const reg = new SubagentRegistry();
  const tool = createSubagentTool(reg);
  const cwd = await tmpDir();

  const rec = reg.launch("executor", "long task", async () => {
    return { success: true, output: "done" };
  });

  reg.setActivity(rec.id, "tool: bash");
  expect(reg.get(rec.id)?.activity).toBe("tool: bash");

  const inspectRes = await tool({ action: "inspect", id: rec.id }, cwd);
  expect(inspectRes.success).toBe(true);
  expect(inspectRes.output).toContain("(tool: bash)");

  reg.setActivity(rec.id, undefined);
  expect(reg.get(rec.id)?.activity).toBeUndefined();
});


const mergeDone = JSON.stringify({
  tool: "done",
  arguments: { reason: "Summary: finished\nChanged Files: none\nVerification: reviewed" },
});

test("merge regression: detached string true returns a controllable handle before the runner settles", async () => {
  const cwd = await tmpDir();
  const reg = new SubagentRegistry();
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<string>();
  const provider = spyOn(loop, "callLlm").mockImplementation(async () => {
    entered.resolve();
    return response.promise;
  });
  const dispatch = createTaskTool({ config: { defaultModel: "m", subagents: {} }, registry: reg })({
    role: "executor", task: "hold this task", detached: "true",
  }, cwd);
  try {
    await entered.promise;
    expect(reg.pending().map(record => record.id)).toEqual(["executor-1"]);
    const receipt = await dispatch;
    expect(receipt.success).toBe(true);
    expect(receipt.output).toContain("[detached] launched");
    expect(receipt.output).toContain("executor-1");
    const inspection = await createSubagentTool(reg)({ action: "inspect", id: "executor-1" }, cwd);
    expect(inspection.output).toContain("[RUNNING]");
  } finally {
    reg.cancelAll();
    response.resolve(mergeDone);
    await dispatch;
    await reg.awaitIds(reg.list().map(record => record.id));
    provider.mockRestore();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

for (const heldState of ["running", "paused", "cancelled"] as const) {
  test(`merge regression: fifth detached task is refused while four ${heldState} runners are unsettled`, async () => {
    const cwd = await tmpDir();
    const reg = new SubagentRegistry();
    const response = Promise.withResolvers<string>();
    const entered = Promise.withResolvers<void>();
    let started = 0;
    const provider = spyOn(loop, "callLlm").mockImplementation(() => {
      if (++started === 4) entered.resolve();
      return response.promise;
    });
    const control = createSubagentTool(reg);
    const tool = createTaskTool({ config: { defaultModel: "m", subagents: {} }, registry: reg });
    const completed = reg.launch("executor", "settled success", async () => ({ success: true, output: "completed report" }));
    const failed = reg.launch("executor", "settled failure", async () => ({ success: false, output: "failed report" }));
    const cancelled = reg.launch("executor", "settled cancellation", async () => ({ success: true, output: "late report" }));
    reg.cancel([cancelled.id]);
    await reg.awaitIds([completed.id, failed.id, cancelled.id]);
    try {
      for (let i = 0; i < 4; i++) {
        const receipt = await tool({ role: "executor", task: `held task ${i}`, detached: true }, cwd);
        expect(receipt.success).toBe(true);
      }
      await entered.promise;
      const activeIds = reg.pending().map(record => record.id);
      expect(activeIds).toHaveLength(4);
      if (heldState === "paused") reg.pause([activeIds[0]!]);
      if (heldState === "cancelled") reg.cancel([activeIds[0]!]);

      const refused = await tool({ role: "executor", task: "must not launch yet", detached: true }, cwd);
      expect(refused.success).toBe(false);
      expect(refused.error).toMatch(/(?:limit|cap|at most|maximum|already|active).*4|4.*(?:active|running|limit|cap)/i);
      expect(reg.pending().map(record => record.id)).toEqual(activeIds);
      expect((await control({ action: "inspect", id: completed.id }, cwd)).output).toContain("completed report");
      expect((await control({ action: "inspect", id: failed.id }, cwd)).output).toContain("failed report");
      expect((await control({ action: "inspect", id: cancelled.id }, cwd)).output).toContain("[CANCELLED]");

      response.resolve(mergeDone);
      await reg.awaitIds(activeIds);
      const replacement = await tool({ role: "executor", task: "capacity released after settlement", detached: true }, cwd);
      expect(replacement.success).toBe(true);
      expect(replacement.output).toContain("[detached] launched");
    } finally {
      reg.cancelAll();
      response.resolve(mergeDone);
      await reg.awaitIds(reg.list().map(record => record.id));
      provider.mockRestore();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
}

for (const detached of [true, "true"]) {
  for (const tasks of [["first assignment", "second assignment"], JSON.stringify(["first assignment", "second assignment"])]) {
    test(`merge regression: detached fanout is rejected for ${typeof detached} flag and ${typeof tasks} tasks`, async () => {
      const cwd = await tmpDir();
      const reg = new SubagentRegistry();
      const provider = spyOn(loop, "callLlm").mockResolvedValue(mergeDone);
      try {
        const result = await createTaskTool({ config: { defaultModel: "m", subagents: {} }, registry: reg })({
          role: "executor", tasks, detached,
        }, cwd);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/detached/i);
        expect(result.error).toMatch(/single|fan.?out|tasks/i);
        expect(reg.list()).toEqual([]);
      } finally {
        reg.cancelAll();
        await reg.awaitIds(reg.list().map(record => record.id));
        provider.mockRestore();
        await fs.rm(cwd, { recursive: true, force: true });
      }
    });
  }
}

test("merge regression: cancelling a detached write while directory creation is pending prevents the file commit", async () => {
  const cwd = await tmpDir();
  const reg = new SubagentRegistry();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const targetDirectory = path.join(cwd, "pending-write");
  const originalMkdir = fs.mkdir;
  const mkdir = spyOn(fs, "mkdir").mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
    if (String(args[0]) === targetDirectory) {
      entered.resolve();
      await release.promise;
    }
    return originalMkdir(...args);
  });
  const provider = spyOn(loop, "callLlm").mockResolvedValue(JSON.stringify({
    tool: "write", arguments: { filePath: "pending-write/result.txt", content: "must never commit" },
  }));
  try {
    const receipt = await createTaskTool({ config: { defaultModel: "m", subagents: {} }, registry: reg })({
      role: "executor", task: "write a result", detached: true,
    }, cwd);
    expect(receipt.success).toBe(true);
    await entered.promise;
    reg.cancel(["executor-1"]);
    expect(reg.inFlightMutators().map(record => record.id)).toEqual(["executor-1"]);
    release.resolve();
    await reg.awaitIds(["executor-1"]);
    expect(await fs.readFile(path.join(targetDirectory, "result.txt"), "utf8").catch(error => error.code)).toBe("ENOENT");
    expect(reg.get("executor-1")!.status).toBe("cancelled");
    expect(reg.inFlightMutators()).toEqual([]);
  } finally {
    reg.cancelAll();
    release.resolve();
    await reg.awaitIds(reg.list().map(record => record.id));
    mkdir.mockRestore();
    provider.mockRestore();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("merge regression: cancelling detached bash terminates the active local child before runner settlement", async () => {
  const cwd = await tmpDir();
  const reg = new SubagentRegistry();
  const pidPath = path.join(cwd, "child.pid");
  const childScript = path.join(cwd, "child.cjs");
  await fs.writeFile(childScript, 'require("node:fs").watch(".", () => {}); require("node:fs").writeFileSync("child.pid", String(process.pid));');
  const readyEvents = fs.watch(cwd, { signal: AbortSignal.timeout(5_000) });
  const provider = spyOn(loop, "callLlm").mockResolvedValue(JSON.stringify({
    tool: "bash", arguments: { command: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(childScript)}` },
  }));
  let childPid: number | undefined;
  const childAlive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  try {
    const receipt = await createTaskTool({ config: { defaultModel: "m", subagents: {} }, registry: reg })({
      role: "executor", task: "run the cancellable local child", detached: true,
    }, cwd);
    expect(receipt.success).toBe(true);
    for await (const event of readyEvents) {
      if (event.filename !== "child.pid") continue;
      const value = await fs.readFile(pidPath, "utf8");
      if (!/^\d+$/.test(value)) continue;
      childPid = Number(value);
      break;
    }
    expect(childAlive(childPid!)).toBe(true);
    reg.cancel(["executor-1"]);
    await reg.awaitIds(["executor-1"], 1_500);
    expect(reg.pending().map(record => record.id)).toEqual([]);
    expect(childAlive(childPid!)).toBe(false);
    expect(reg.get("executor-1")!.status).toBe("cancelled");
  } finally {
    await readyEvents.return?.();
    reg.cancelAll();
    const ownedPid = childPid ?? Number(await fs.readFile(pidPath, "utf8").catch(() => "0"));
    if (ownedPid > 0 && childAlive(ownedPid)) process.kill(ownedPid, "SIGKILL");
    await reg.awaitIds(reg.list().map(record => record.id));
    provider.mockRestore();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
