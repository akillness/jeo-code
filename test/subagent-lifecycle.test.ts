import { test, expect } from "bun:test";
import { SubagentRegistry } from "../src/agent/subagent-registry";
import { createSubagentTool } from "../src/agent/subagent-tool";
import type { ToolResult } from "../src/agent/tools";

for (const cancellation of ["cancelAll", "cancel tool"] as const) {
  test(`lifecycle: ${cancellation} aborts paused and running children without publishing late success`, async () => {
    const registry = new SubagentRegistry();
    const tool = createSubagentTool(registry);
    const signals: AbortSignal[] = [];
    const runners = [Promise.withResolvers<ToolResult>(), Promise.withResolvers<ToolResult>()];
    const children = runners.map((runner, index) => registry.launch("executor", `child ${index}`, signal => {
      signals.push(signal);
      signal.addEventListener("abort", () => runner.resolve({
        success: true,
        output: "late success must not replace cancellation",
      }), { once: true });
      return runner.promise;
    }));
    const ids = children.map(child => child.id);
    const completed = registry.launch("planner", "already finished", async () => ({ success: true, output: "retained report" }));
    await registry.awaitIds([completed.id]);

    try {
      registry.pause([children[0]!.id], "Yield before editing another file.");
      expect(registry.get(children[0]!.id)!.status).toBe("paused");

      if (cancellation === "cancelAll") {
        expect(registry.cancelAll().map(child => child.id)).toEqual(ids);
      } else {
        const cancelled = await tool({ action: "cancel" }, process.cwd());
        expect(cancelled.success).toBe(true);
        for (const id of ids) expect(cancelled.output).toContain(id);
        expect(cancelled.output).not.toContain(completed.id);
      }

      expect(signals.map(signal => signal.aborted)).toEqual([true, true]);
      const settled = await registry.awaitIds(ids);
      expect(settled.map(child => child.status)).toEqual(["cancelled", "cancelled"]);
      expect(settled.some(child => child.success === true)).toBe(false);
      expect(registry.inFlightMutators()).toEqual([]);
      const inspected = await tool({ action: "inspect", ids }, process.cwd());
      expect(inspected.output).not.toContain("late success must not replace cancellation");
      expect(registry.get(completed.id)).toMatchObject({ status: "completed", success: true, result: "retained report" });
    } finally {
      registry.cancel(ids);
      for (const runner of runners) runner.resolve({ success: false, output: "test cleanup" });
      await registry.awaitIds(ids);
    }
  });
}

for (const terminal of ["completed", "failed", "thrown", "cancelled"] as const) {
  for (const surface of ["registry", "tool"] as const) {
    test(`lifecycle: ${surface} rejects resuming ${terminal} children and preserves their terminal report`, async () => {
      const registry = new SubagentRegistry();
      const tool = createSubagentTool(registry);
      const runner = Promise.withResolvers<ToolResult>();
      const child = registry.launch("executor", `finish as ${terminal}`, () => runner.promise);
      if (terminal === "cancelled") registry.cancel([child.id]);
      if (terminal === "thrown") runner.reject(new Error("provider disconnected"));
      else runner.resolve({
        success: terminal === "completed",
        output: terminal === "completed" ? "finished review" : "could not complete review",
      });
      await registry.awaitIds([child.id]);
      const expectedStatus = terminal === "thrown" ? "failed" : terminal;
      const expectedReport = terminal === "completed" ? "finished review"
        : terminal === "thrown" ? "provider disconnected"
        : terminal === "failed" ? "could not complete review" : undefined;
      expect(registry.get(child.id)!.status).toBe(expectedStatus);
      expect(registry.get(child.id)!.result).toBe(expectedReport);
      const terminalRecord = { ...registry.get(child.id)! };

      const resumed = surface === "registry"
        ? registry.resume(child.id, "Review another file.")
        : await tool({ action: "resume", id: child.id, message: "Review another file." }, process.cwd());
      expect(resumed.success).toBe(false);
      expect(resumed.error).toMatch(/cannot|not|terminal|settled|finished/i);
      expect(registry.get(child.id)).toEqual(terminalRecord);
      expect(registry.running()).toEqual([]);
      expect(registry.steer(child.id, "Unreachable follow-up")).toBe(false);
      const [settled] = await registry.awaitIds([child.id]);
      expect(settled).toEqual(terminalRecord);
      const inspected = await tool({ action: "inspect", id: child.id }, process.cwd());
      expect(inspected.output).toContain(expectedStatus.toUpperCase());
      if (expectedReport) expect(inspected.output).toContain(expectedReport);
    });
  }
}

test("lifecycle: pause and resume deliver instructions to the same live child", async () => {
  const registry = new SubagentRegistry();
  const tool = createSubagentTool(registry);
  const reachPauseBoundary = Promise.withResolvers<void>();
  const pauseObserved = Promise.withResolvers<void>();
  const reachResumeBoundary = Promise.withResolvers<void>();
  const child = registry.launch("executor", "cooperative review", async (signal, id) => {
    const drain = registry.steerDrainFor(id);
    await reachPauseBoundary.promise;
    const pauseMessages = drain();
    pauseObserved.resolve();
    await reachResumeBoundary.promise;
    const resumeMessages = drain();
    return {
      success: !signal.aborted && pauseMessages.includes("Yield after this review.") && resumeMessages.includes("Review the second file."),
      output: [...pauseMessages, ...resumeMessages].join("\n"),
    };
  });

  try {
    const paused = await tool({ action: "pause", id: child.id, message: "Yield after this review." }, process.cwd());
    expect(paused.success).toBe(true);
    expect(registry.get(child.id)!.status).toBe("paused");
    reachPauseBoundary.resolve();
    await pauseObserved.promise;
    const resumed = await tool({ action: "resume", id: child.id, message: "Review the second file." }, process.cwd());
    expect(resumed.success).toBe(true);
    expect(registry.get(child.id)!.status).toBe("running");
    reachResumeBoundary.resolve();
    const [settled] = await registry.awaitIds([child.id]);
    expect(settled).toMatchObject({
      id: child.id,
      status: "completed",
      success: true,
      result: "Yield after this review.\nReview the second file.",
    });
  } finally {
    registry.cancel([child.id]);
    reachPauseBoundary.resolve();
    reachResumeBoundary.resolve();
    await registry.awaitIds([child.id]);
  }
});

for (const explicitTarget of [true, false]) {
  test(`lifecycle: bounded await ${explicitTarget ? "by id" : "without ids"} reports an unresolved paused child as pending`, async () => {
    const registry = new SubagentRegistry();
    const tool = createSubagentTool(registry);
    const runner = Promise.withResolvers<ToolResult>();
    const child = registry.launch("executor", "waiting at a safe boundary", () => runner.promise);
    registry.pause([child.id], "Wait for follow-up.");
    try {
      const result = await tool({ action: "await", ...(explicitTarget ? { id: child.id } : {}), timeoutMs: 1 }, process.cwd());
      expect(result.success).toBe(false);
      expect(result.output).toContain(child.id);
      expect(result.output).toContain("PAUSED");
      expect(result.output).not.toContain("all settled");
      expect(registry.get(child.id)!.status).toBe("paused");
    } finally {
      registry.cancel([child.id]);
      runner.resolve({ success: false, output: "test cleanup" });
      await registry.awaitIds([child.id]);
    }
  });
}

for (const explicitTarget of [true, false]) {
  test(`lifecycle: bounded await ${explicitTarget ? "by id" : "without ids"} does not hide a cancelled runner still mutating`, async () => {
    const registry = new SubagentRegistry();
    const tool = createSubagentTool(registry);
    const runner = Promise.withResolvers<ToolResult>();
    const child = registry.launch("executor", "mutation that ignores cancellation", () => runner.promise);
    registry.cancel([child.id]);
    try {
      const result = await tool({ action: "await", ...(explicitTarget ? { id: child.id } : {}), timeoutMs: 1 }, process.cwd());
      expect(result.success).toBe(false);
      expect(result.output).toContain(child.id);
      expect(result.output).not.toContain("all settled");
      expect(registry.inFlightMutators().map(record => record.id)).toEqual([child.id]);
      runner.resolve({ success: true, output: "late successful write", mutationMayHaveOccurred: true });
      const [settled] = await registry.awaitIds([child.id]);
      expect(settled!.status).toBe("cancelled");
      expect(settled!.mutationMayHaveOccurred).toBe(true);
      expect(registry.inFlightMutators()).toEqual([]);
      const inspected = await tool({ action: "inspect", id: child.id }, process.cwd());
      expect(inspected.mutationMayHaveOccurred).toBe(true);
      expect(inspected.output).not.toContain("late successful write");
    } finally {
      runner.resolve({ success: false, output: "test cleanup" });
      await registry.awaitIds([child.id]);
    }
  });
}

for (const action of ["cancel", "pause", "await"] as const) {
  for (const targetKind of ["invalid id", "invalid ids", "mixed ids"] as const) {
    test(`lifecycle: ${action} rejects ${targetKind} without affecting unrelated live children`, async () => {
      const registry = new SubagentRegistry();
      const tool = createSubagentTool(registry);
      const runner = Promise.withResolvers<ToolResult>();
      let signal: AbortSignal;
      const child = registry.launch("executor", "unrelated live review", childSignal => {
        signal = childSignal;
        return runner.promise;
      });
      const target = targetKind === "invalid id" ? { id: "bad/id" }
        : { ids: targetKind === "mixed ids" ? [child.id, "bad/id"] : ["bad/id"] };
      try {
        const result = await tool({ action, ...target, message: "Must not be delivered.", timeoutMs: 1 }, process.cwd());
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/invalid/i);
        expect(signal!.aborted).toBe(false);
        expect(registry.get(child.id)!.status).toBe("running");
        expect(registry.steerDrainFor(child.id)()).toEqual([]);
      } finally {
        registry.cancel([child.id]);
        runner.resolve({ success: false, output: "test cleanup" });
        await registry.awaitIds([child.id]);
      }
    });
  }
}

test("lifecycle: an intentionally empty cancel target list aborts all live children including paused workers", async () => {
  const registry = new SubagentRegistry();
  const tool = createSubagentTool(registry);
  const runner = Promise.withResolvers<ToolResult>();
  let signal: AbortSignal;
  const child = registry.launch("executor", "paused review", childSignal => {
    signal = childSignal;
    return runner.promise;
  });
  registry.pause([child.id], "Wait for follow-up.");
  try {
    const result = await tool({ action: "cancel", ids: [] }, process.cwd());
    expect(result.success).toBe(true);
    expect(result.output).toContain(child.id);
    expect(signal!.aborted).toBe(true);
    runner.resolve({ success: true, output: "must remain cancelled" });
    const [settled] = await registry.awaitIds([child.id]);
    expect(settled!.status).toBe("cancelled");
    expect(settled!.result).toBeUndefined();
  } finally {
    registry.cancel([child.id]);
    runner.resolve({ success: false, output: "test cleanup" });
    await registry.awaitIds([child.id]);
  }
});
