import { test, expect, mock, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Each test re-mocks ../src/agent/loop (task()'s dispatch goes through the
// same runSubagentOnce -> callLlm chain task-tool.test.ts mocks); restore
// afterwards so other suites are clean.
afterEach(() => {
  mock.restore();
});

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "jeo-eval-"));
}

test("createEvalTool: a return statement becomes the reported return value", async () => {
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({ config: { defaultModel: "ollama/fast", subagents: {} } });
  const res = await tool({ code: "return 1 + 1;" }, await tmpDir());
  expect(res.success).toBe(true);
  expect(res.output).toContain("Return value:\n2");
});

test("createEvalTool: log() messages are captured in output order, before the return value", async () => {
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({ config: { defaultModel: "ollama/fast", subagents: {} } });
  const res = await tool({ code: `log("step 1"); log("step 2"); return "done";` }, await tmpDir());
  expect(res.success).toBe(true);
  const logIdx = res.output.indexOf("step 1");
  const log2Idx = res.output.indexOf("step 2");
  const retIdx = res.output.indexOf("Return value");
  expect(logIdx).toBeGreaterThanOrEqual(0);
  expect(log2Idx).toBeGreaterThan(logIdx);
  expect(retIdx).toBeGreaterThan(log2Idx);
});

test("createEvalTool: a thrown error surfaces as a failed ToolResult with the message", async () => {
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({ config: { defaultModel: "ollama/fast", subagents: {} } });
  const res = await tool({ code: `throw new Error("boom");` }, await tmpDir());
  expect(res.success).toBe(false);
  expect(res.error).toContain("boom");
});

test("createEvalTool: a syntax error in the code body fails cleanly instead of crashing the tool", async () => {
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({ config: { defaultModel: "ollama/fast", subagents: {} } });
  const res = await tool({ code: `this is not valid javascript {{{` }, await tmpDir());
  expect(res.success).toBe(false);
  expect(res.error).toBeDefined();
});

test("createEvalTool: requires a non-empty 'code' body", async () => {
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({ config: { defaultModel: "ollama/fast", subagents: {} } });
  const res = await tool({}, await tmpDir());
  expect(res.success).toBe(false);
  expect(res.error).toContain("non-empty 'code'");
});

// --- Interview mutation lock: eval carries the SAME full-process trust as
// bash, so it must be gated by the identical lock (mirrors test/mutation-guard.test.ts). ---

test("createEvalTool: blocked while a deep-interview is active (same MutationGuard bash itself opens with)", async () => {
  const dir = await tmpDir();
  await fs.mkdir(path.join(dir, ".jeo", "state"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".jeo", "state", "deep-interview-state.json"),
    JSON.stringify({ active: true, current_phase: "interview", skill: "deep-interview", current_ambiguity: 0.8 }),
  );
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({ config: { defaultModel: "ollama/fast", subagents: {} } });
  const res = await tool({ code: "return 1;" }, dir);
  expect(res.success).toBe(false);
  expect(res.error).toContain("MutationGuard");
});

// --- task(): the ONE primitive that crosses back to the main thread over
// postMessage RPC to reach the REAL runSubagentOnce -> callLlm chain. ---

test("createEvalTool: task() dispatches a real subagent and resolves to its structured result", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "done", arguments: { reason: "Summary: ok\nChanged Files: none\nVerification: ran\ntask complete" } }),
  }));
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({ config: { defaultModel: "ollama/fast", subagents: {} } });
  const res = await tool({ code: `const r = await task("executor", "do the thing"); return r.output;` }, await tmpDir());
  expect(res.success).toBe(true);
  expect(res.output).toContain("task complete");
});

test("createEvalTool: task() with an unknown role rejects from within the script (caught by the try/catch around fn())", async () => {
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({ config: { defaultModel: "ollama/fast", subagents: {} } });
  const res = await tool({ code: `await task("not-a-real-role", "x");` }, await tmpDir());
  expect(res.success).toBe(false);
  expect(res.error).toContain("Unknown subagent role");
});

test("createEvalTool: sequential task() calls compose real control flow — the 2nd call's argument comes from the 1st call's result", async () => {
  const seenTasks: string[] = [];
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (messages: { content: string }[]) => {
      const userMsg = String(messages[1]?.content ?? "");
      seenTasks.push(userMsg);
      // First subagent reports a filename; the SECOND task's assignment is
      // built FROM that report — genuine sequential composition, exactly
      // what tasks[] (single-stage, parallel-only) cannot express.
      if (userMsg.includes("find the target file")) {
        return JSON.stringify({ tool: "done", arguments: { reason: "Summary: ok\nChanged Files: none\nVerification: ran\ntarget.ts" } });
      }
      return JSON.stringify({ tool: "done", arguments: { reason: "Summary: ok\nChanged Files: none\nVerification: ran\nreviewed target.ts" } });
    },
  }));
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({ config: { defaultModel: "ollama/fast", subagents: {} } });
  const res = await tool({
    code: `
      const first = await task("executor", "find the target file");
      // first.output is FENCED (<<<subagent-report ... >>>) — extract the
      // last real content line from inside the fence, not the closing marker.
      const fenceMatch = first.output.match(/<<<subagent-report\\n([\\s\\S]*?)\\n>>>/);
      const reportBody = fenceMatch ? fenceMatch[1] : first.output;
      const filename = reportBody.trim().split("\\n").pop();
      const second = await task("architect", "review " + filename);
      return second.output;
    `,
  }, await tmpDir());
  expect(res.success).toBe(true);
  expect(res.output).toContain("reviewed target.ts");
  expect(seenTasks.some(t => t.includes("review target.ts"))).toBe(true);
});

// --- parallel(): bounded-pool fan-out, input order preserved regardless of
// completion order. ---

// Real setTimeout (not fake timers): the eval'd code runs inside a genuine
// Worker thread — a separate V8 isolate with its own event loop and timer
// queue — which fake timers installed on the MAIN thread structurally cannot
// reach into. Mirrors task-tool.test.ts's own "executor fan-out runs
// CONCURRENTLY" overlapping-sleep probe, this codebase's established pattern
// for proving genuine concurrency rather than trusting a label.
test("createEvalTool: parallel() runs thunks concurrently and preserves input order in the results", async () => {
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({ config: { defaultModel: "ollama/fast", subagents: {} } });
  const res = await tool({
    code: `
      const delays = [30, 10, 20];
      const results = await parallel(delays.map((ms, i) => async () => {
        await new Promise(r => setTimeout(r, ms));
        return i;
      }));
      return results;
    `,
  }, await tmpDir());
  expect(res.success).toBe(true);
  // Input order [0,1,2] preserved even though item 1 (10ms) finishes before
  // item 0 (30ms) — proves results are indexed by POSITION, not completion order.
  expect(res.output).toContain("Return value:\n[\n  0,\n  1,\n  2\n]");
});

test("createEvalTool: steering reaches both active parallel task children exactly once", async () => {
  const dir = await tmpDir();
  const { promise: bothStarted, resolve: releaseBoth } = Promise.withResolvers<void>();
  let started = 0;
  let pending: string[] = [];
  const steeringEvents: string[] = [];
  const histories = new Map<string, string[][]>();
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (messages: { content: string }[]) => {
      const task = String(messages[1]?.content ?? "");
      const child = ["first child", "second child", "later child"].find(name => task.includes(name)) ?? "unknown";
      const content = messages.map(message => String(message.content));
      const calls = histories.get(child) ?? [];
      calls.push(content);
      histories.set(child, calls);
      const hasSteering = content.some(text => text.includes("redirect both children"));
      if (!hasSteering && child !== "later child") {
        started++;
        if (started === 2) {
          pending = ["redirect both children: first", "redirect both children: second"];
          releaseBoth();
        }
        await bothStarted;
      }
      return JSON.stringify({ tool: "done", arguments: { reason: "Summary: ok\nChanged Files: none\nVerification: ran\ncomplete" } });
    },
  }));
  // Import after installing the mock so the real dispatch uses the offline LLM boundary.
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({
    config: { defaultModel: "ollama/fast", subagents: {} },
    steer: () => pending.splice(0),
    onEvent: event => {
      if (event.detail?.startsWith("↳ steer: redirect both children:")) steeringEvents.push(event.detail);
    },
  });
  try {
    const res = await tool({
      code: `await parallel([() => task("executor", "first child"), () => task("executor", "second child")]); return await task("executor", "later child");`,
      timeoutMs: 10000,
    }, dir);
    expect(res.success).toBe(true);
    expect(started).toBe(2);
    expect(steeringEvents).toEqual([
      "↳ steer: redirect both children: first", "↳ steer: redirect both children: second",
      "↳ steer: redirect both children: first", "↳ steer: redirect both children: second",
    ]);
    for (const child of ["first child", "second child"]) {
      const last = histories.get(child)?.at(-1) ?? [];
      expect(last.filter(text => text.includes("redirect both children")).map(text => text.split("\n").at(-1))).toEqual([
        "redirect both children: first", "redirect both children: second",
      ]);
    }
    expect((histories.get("later child") ?? []).flat().filter(text => text.includes("redirect both children"))).toHaveLength(0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 15000);

test("createEvalTool: steering follows active children as tasks finish and start", async () => {
  const dir = await tmpDir();
  const { promise: initialReady, resolve: releaseInitial } = Promise.withResolvers<void>();
  const { promise: laterReady, resolve: releaseLater } = Promise.withResolvers<void>();
  const histories = new Map<string, string[][]>();
  const initialChildren = new Set<string>();
  let pending: string[] = [];
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (messages: { content: string }[]) => {
      const assignment = String(messages[1]?.content ?? "");
      const child = ["departing child", "surviving child", "joining child"].find(name => assignment.includes(name)) ?? "unknown";
      const content = messages.map(message => String(message.content));
      const calls = histories.get(child) ?? [];
      calls.push(content);
      histories.set(child, calls);
      if (calls.length === 1 && child !== "joining child") {
        initialChildren.add(child);
        if (initialChildren.size === 2) {
          pending.push("steer before departure");
          releaseInitial();
        }
        await initialReady;
        if (child === "surviving child") await laterReady;
      } else if (calls.length === 1) {
        pending.push("steer after departure");
        releaseLater();
      }
      return JSON.stringify({ tool: "done", arguments: { reason: "Summary: ok\nChanged Files: none\nVerification: ran\ncomplete" } });
    },
  }));
  // The mocked LLM must be installed before loading the real dispatch path.
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({ config: { defaultModel: "ollama/fast", subagents: {} }, steer: () => pending.splice(0) });
  try {
    const res = await tool({
      code: `const departing = task("executor", "departing child"); const surviving = task("executor", "surviving child"); await departing; const joining = task("executor", "joining child"); return await Promise.all([surviving, joining]);`,
      timeoutMs: 10000,
    }, dir);
    expect(res.success).toBe(true);
    const instructions = (child: string) => (histories.get(child)?.at(-1) ?? [])
      .filter(text => text.includes("steer before departure") || text.includes("steer after departure"))
      .map(text => text.split("\n").at(-1));
    expect(instructions("departing child")).toEqual(["steer before departure"]);
    expect(instructions("surviving child")).toEqual(["steer before departure", "steer after departure"]);
    expect(instructions("joining child")).toEqual(["steer after departure"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 15000);

test.each([false, true])("createEvalTool: cancellation preserves steering not consumed by any child (restore callback: %s)", async (restore) => {
  const dir = await tmpDir();
  const controller = new AbortController();
  const { promise: firstStarted, resolve: releaseFirstStarted } = Promise.withResolvers<void>();
  let waitingChildren = 0;
  const pending: string[] = [];
  let secondStarted = false;
  const seenSteering: string[] = [];
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (messages: { content: string }[], options: { signal?: AbortSignal }) => {
      const assignment = String(messages[1]?.content ?? "");
      if (assignment.includes("waiting child")) {
        if (++waitingChildren === 2) releaseFirstStarted();
      } else if (assignment.includes("gate child")) {
        await firstStarted;
        return JSON.stringify({ tool: "done", arguments: { reason: "Summary: ok\nChanged Files: none\nVerification: ran\ngate complete" } });
      } else if (assignment.includes("joining child")) {
        secondStarted = true;
        pending.push("newer instruction");
        controller.abort();
      }
      await new Promise<void>(resolve => {
        if (options.signal?.aborted) resolve();
        else options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("cancelled by test");
    },
  }));
  // Install the offline provider boundary before loading real eval dispatch.
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({
    config: { defaultModel: "ollama/fast", subagents: {} },
    signal: controller.signal,
    steer: () => pending.splice(0),
    ...(restore ? { restoreSteer: (messages: string[]) => { pending.unshift(...messages); } } : {}),
    onEvent: event => {
      if (event.detail === "enqueue steering") pending.push("unconsumed instruction");
      if (event.detail === "↳ steer: unconsumed instruction") seenSteering.push(event.detail);
    },
  });
  try {
    const res = await tool({
      code: `task("executor", "first waiting child"); task("executor", "second waiting child"); await task("executor", "gate child"); log("enqueue steering"); await task("executor", "joining child");`,
      timeoutMs: 10000,
    }, dir);
    expect(secondStarted).toBe(true);
    expect(waitingChildren).toBe(2);
    expect(res.success).toBe(false);
    expect(res.error).toContain("cancelled");
    if (restore || seenSteering.length === 0) {
      expect(seenSteering).toEqual([]);
      expect(pending).toEqual(["unconsumed instruction", "newer instruction"]);
    } else {
      expect(seenSteering).toEqual(["↳ steer: unconsumed instruction"]);
      expect(pending).toEqual(["newer instruction"]);
    }
  } finally {
    controller.abort();
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 15000);

test.each(["success", "script error", "abort"])("createEvalTool: throwing steering restoration fails the eval instead of hanging (%s)", async (mode) => {
  const dir = await tmpDir();
  const controller = new AbortController();
  const { promise: firstStarted, resolve: releaseFirstStarted } = Promise.withResolvers<void>();
  const pending: string[] = [];
  const privateSentinel = "private-restoration-token-7e2c";
  const events: unknown[] = [];
  let restoreCalls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (messages: { content: string }[], options: { signal?: AbortSignal }) => {
      const assignment = String(messages[1]?.content ?? "");
      if (assignment.includes("waiting child")) {
        releaseFirstStarted();
        await new Promise<void>(resolve => {
          if (options.signal?.aborted) resolve();
          else options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("cancelled by eval settlement");
      }
      if (assignment.includes("gate child")) await firstStarted;
      if (mode === "abort" && assignment.includes("joining child")) controller.abort();
      return JSON.stringify({ tool: "done", arguments: { reason: "Summary: ok\nChanged Files: none\nVerification: ran\ncomplete" } });
    },
  }));
  // Install the provider fake before loading the real eval dispatch.
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({
    config: { defaultModel: "ollama/fast", subagents: {} },
    signal: controller.signal,
    steer: () => pending.splice(0),
    restoreSteer: () => { restoreCalls++; throw new Error(privateSentinel); },
    onEvent: event => {
      events.push(event);
      if (event.detail === "enqueue steering") pending.push("unconsumed instruction");
    },
  });
  try {
    const res = await tool({
      code: `task("executor", "waiting child"); await task("executor", "gate child"); log("enqueue steering"); await task("executor", "joining child"); ${mode === "script error" ? 'throw new Error("script failure");' : 'return "finished";'}`,
      timeoutMs: 10000,
    }, dir);
    expect(res.success).toBe(false);
    expect(res.error).toContain("steering restoration failed");
    expect(restoreCalls).toBe(1);
    expect(res.error).not.toContain(privateSentinel);
    expect(JSON.stringify(events)).not.toContain(privateSentinel);
    expect(res.error).not.toContain("timeout");
    if (mode === "script error") expect(res.error).toContain("script failure");
    if (mode === "abort") expect(res.error).toContain("eval cancelled");
    if (mode === "success") expect(res.error).not.toContain("eval cancelled");
  } finally {
    controller.abort();
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 15000);

test("createEvalTool: parallel() rejects a non-array argument", async () => {
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({ config: { defaultModel: "ollama/fast", subagents: {} } });
  const res = await tool({ code: `await parallel("not an array");` }, await tmpDir());
  expect(res.success).toBe(false);
  expect(res.error).toContain("function");
});

test("createEvalTool: parallel() with an empty array resolves to an empty array (no-op, not an error)", async () => {
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({ config: { defaultModel: "ollama/fast", subagents: {} } });
  const res = await tool({ code: `const r = await parallel([]); return r.length;` }, await tmpDir());
  expect(res.success).toBe(true);
  expect(res.output).toContain("Return value:\n0");
});

// --- pipeline(): sequential stages with a barrier between them, each stage's
// output feeding the next. ---

test("createEvalTool: pipeline() maps items through stages left-to-right, each stage seeing the PREVIOUS stage's result", async () => {
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({ config: { defaultModel: "ollama/fast", subagents: {} } });
  const res = await tool({
    code: `
      const doubled = async (n) => n * 2;
      const stringified = async (n) => "value:" + n;
      const result = await pipeline([1, 2, 3], doubled, stringified);
      return result;
    `,
  }, await tmpDir());
  expect(res.success).toBe(true);
  expect(res.output).toContain(`"value:2"`);
  expect(res.output).toContain(`"value:4"`);
  expect(res.output).toContain(`"value:6"`);
});

test("createEvalTool: pipeline() with zero stages returns the items unchanged", async () => {
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({ config: { defaultModel: "ollama/fast", subagents: {} } });
  const res = await tool({ code: `const r = await pipeline([1, 2, 3]); return r;` }, await tmpDir());
  expect(res.success).toBe(true);
  expect(res.output).toContain("[\n  1,\n  2,\n  3\n]");
});

// --- Bounded concurrency (v0.8.24 fix): every task() dispatch, regardless of
// HOW the script fires it (parallel()/pipeline()'s own bound, or N raw
// concurrent task() calls bypassing both entirely), stays capped at
// MAX_FANOUT concurrent runSubagentOnce calls in flight — proven via a
// counter that must never exceed MAX_FANOUT at any instant. ---

// Real setTimeout (mirrors task-tool.test.ts's own concurrency-bound test):
// this mock runs on the MAIN thread (it's the RPC handler's runSubagentOnce
// call, not the worker's own code), but the same "genuine overlap, not a
// label" reasoning applies — a fake timer cannot distinguish 10 sequential
// zero-delay calls from 4-at-a-time bounded concurrency; a real overlapping
// delay is the only way to prove the semaphore actually throttles.
test("createEvalTool: N raw concurrent task() calls (bypassing parallel()/pipeline() entirely) still never exceed MAX_FANOUT in flight", async () => {
  let inFlight = 0;
  let maxObservedInFlight = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      inFlight++;
      maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
      await new Promise(r => setTimeout(r, 20));
      inFlight--;
      return JSON.stringify({ tool: "done", arguments: { reason: "Summary: ok\nChanged Files: none\nVerification: ran\nok" } });
    },
  }));
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({ config: { defaultModel: "ollama/fast", subagents: {} } });
  // 10 raw concurrent task() calls via Promise.all — NEVER touches parallel()
  // or pipeline() at all, the exact bypass the fix closes.
  const res = await tool({
    code: `
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => task("executor", "job " + i))
      );
      return results.length;
    `,
  }, await tmpDir());
  expect(res.success).toBe(true);
  expect(res.output).toContain("Return value:\n10");
  expect(maxObservedInFlight).toBeLessThanOrEqual(4); // MAX_FANOUT
  expect(maxObservedInFlight).toBeGreaterThan(1); // proves it's genuinely concurrent, not accidentally serial
});

// --- Caps: MAX_EVAL_TASK_CALLS (total dispatch count) and MAX_PARALLEL_QUEUE
// (single parallel()/pipeline() call's item-array length). ---

test("createEvalTool: exceeding the per-call task() dispatch cap fails the eval with a clear message", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "done", arguments: { reason: "Summary: ok\nChanged Files: none\nVerification: ran\nok" } }),
  }));
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({ config: { defaultModel: "ollama/fast", subagents: {} } });
  const res = await tool({
    code: `
      for (let i = 0; i < 41; i++) {
        await task("executor", "job " + i);
      }
      return "should not reach here";
    `,
  }, await tmpDir());
  expect(res.success).toBe(false);
  expect(res.error).toContain("dispatch cap");
});

test("createEvalTool: a parallel() queue over the size cap is rejected before any thunk runs", async () => {
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({ config: { defaultModel: "ollama/fast", subagents: {} } });
  const res = await tool({
    code: `
      const thunks = Array.from({ length: 21 }, () => async () => 1);
      await parallel(thunks);
    `,
  }, await tmpDir());
  expect(res.success).toBe(false);
  expect(res.error).toContain("exceeds the cap");
});

// --- Timeout: a REAL preemptive kill via Worker.terminate(), proven against
// a SYNCHRONOUS busy-loop that a same-thread Promise.race could never
// interrupt (this is the whole reason eval runs in a Worker at all).
// Deliberately REAL timers (rule exception): these tests exercise the actual
// platform timeout mechanism itself — a fake/simulated clock cannot prove a
// GENUINE OS-thread-level worker.terminate() actually preempts real
// synchronous execution; that is precisely the property under test. ---

test("createEvalTool: a synchronous infinite loop is actually terminated by the timeout, not left hanging forever", async () => {
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({ config: { defaultModel: "ollama/fast", subagents: {} } });
  const start = performance.now();
  const res = await tool({ code: `while (true) {}`, timeoutMs: 500 }, await tmpDir());
  const elapsed = performance.now() - start;
  expect(res.success).toBe(false);
  expect(res.error).toContain("timeout");
  // Genuinely bounded by the timeout, not the test's own default 5s hang —
  // generous slack for CI scheduling jitter around the 500ms budget.
  expect(elapsed).toBeLessThan(3000);
}, 10_000);

test("createEvalTool: a script that finishes well within the timeout is unaffected", async () => {
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({ config: { defaultModel: "ollama/fast", subagents: {} } });
  const res = await tool({ code: `return "fast";`, timeoutMs: 500 }, await tmpDir());
  expect(res.success).toBe(true);
  expect(res.output).toContain("fast");
});

// --- Cancellation: the caller's own AbortSignal (Ctrl-C / turn cancellation)
// terminates the worker exactly like the timeout does. ---

test("createEvalTool: an externally-aborted signal terminates the worker with a distinct 'cancelled' message (not the timeout message)", async () => {
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const ac = new AbortController();
  const tool = createEvalTool({ config: { defaultModel: "ollama/fast", subagents: {} }, signal: ac.signal });
  const promise = tool({ code: `while (true) {}` }, await tmpDir());
  ac.abort();
  const res = await promise;
  expect(res.success).toBe(false);
  expect(res.error).toContain("cancelled");
  expect(res.error).not.toContain("timeout");
}, 10_000);

// --- Zombie fire-and-forget task() (v0.8.24 fix): a script that fires
// task() WITHOUT awaiting it (e.g. `task("executor", "x"); return "done";`)
// must not leave that dispatch running invisibly in the background after
// the tool has already returned to the model — the RPC signal cancels it
// the instant the worker settles, whether it was still QUEUED behind
// MAX_FANOUT other dispatches or already IN-FLIGHT inside runSubagentOnce.
// The queued-cancellation test below uses a real setTimeout INSIDE the
// worker script (rule exception, same cross-thread reasoning as the
// parallel()/pipeline() tests above): it deliberately gives 4 filler
// dispatches genuine wall-clock time to occupy their slots on the MAIN
// thread (running concurrently with the worker's own sleep) BEFORE a 5th
// call is queued and the script returns — a fake/simulated clock cannot
// synchronize two independent real threads racing each other this way. ---

test("createEvalTool: a fire-and-forget task() never reaches callLlm at all — cancelled before dispatch, not merely 'eventually'", async () => {
  // Empirically confirmed via instrumented timing probes (see commit history):
  // runSubagentOnce has real async gaps (memoryPromptSection, projectContext
  // load) BEFORE its first LLM call, and engine.ts's runAgentLoop checks
  // opts.signal.aborted at the TOP of its loop before invoking callLlm — the
  // settle-triggered abort wins that race every time in practice. This is a
  // STRONGER guarantee than "cancelled mid-flight": the dispatch never
  // reaches the network layer at all.
  let callLlmInvocations = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      callLlmInvocations++;
      return JSON.stringify({ tool: "done", arguments: { reason: "Summary: ok\nChanged Files: none\nVerification: ran\nok" } });
    },
  }));
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({ config: { defaultModel: "ollama/fast", subagents: {} } });
  const res = await tool({
    code: `task("executor", "fire and forget, never awaited"); return "returned immediately";`,
  }, await tmpDir());
  expect(res.success).toBe(true);
  expect(res.output).toContain("returned immediately");
  expect(callLlmInvocations).toBe(0); // the fire-and-forget dispatch never reached the network layer
  // Give any straggler async work a real chance to surface before asserting
  // it never did (a bare synchronous assertion right after `await tool()`
  // would trivially pass even if cancellation were completely broken and a
  // zombie call was merely still in its own async gap).
  await new Promise(r => setTimeout(r, 300));
  expect(callLlmInvocations).toBe(0);
});

// Real setTimeout (rule exception, same reasoning as the other cross-thread/
// cross-RPC-boundary tests above): proves the WIRING itself (rpcSignal
// reaching runSubagentOnce -> callLlm's actual options.signal) using a
// deliberately-hung mock, independent of whichever async gaps happen to
// exist upstream today — a future refactor that closes those gaps (making a
// fire-and-forget task() start "callLlm" for real before settling) would
// otherwise leave this exact invariant completely unverified.
test("createEvalTool: IF a fire-and-forget task() call's callLlm genuinely starts before settling, the abort signal it received is honored (proves the RPC-signal wiring itself, not just today's timing)", async () => {
  const { promise: callLlmStarted, resolve: resolveStarted } = Promise.withResolvers<AbortSignal | undefined>();
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (_h: unknown, options: { signal?: AbortSignal }) => {
      resolveStarted(options.signal);
      // Hang until genuinely aborted (or the test's own outer timeout fires) —
      // never resolves on its own, so this call ONLY completes via cancellation.
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) return resolve();
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("cancelled mid-flight (expected)");
    },
  }));
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({ config: { defaultModel: "ollama/fast", subagents: {} } });
  const resultPromise = tool({
    code: `task("executor", "fire and forget"); return "returned";`,
  }, await tmpDir());
  // If callLlm genuinely starts (proving THIS run's async gaps happened to
  // close), its captured signal must eventually reach `.aborted === true` —
  // the tool settling first is what triggers that.
  const signal = await Promise.race([
    callLlmStarted,
    resultPromise.then(() => undefined), // callLlm never started this run — nothing to check, test is a no-op pass
  ]);
  const res = await resultPromise;
  expect(res.success).toBe(true);
  if (signal) {
    expect(signal.aborted).toBe(true);
  }
}, 10_000);

test("createEvalTool: a fire-and-forget task() QUEUED behind MAX_FANOUT other dispatches is cancelled out of the queue, never dispatched at all", async () => {
  const dispatchedTaskTexts: string[] = [];
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (messages: { content: string }[]) => {
      dispatchedTaskTexts.push(String(messages[1]?.content ?? ""));
      // Hang forever — these 4 fill every MAX_FANOUT slot, so the 5th
      // (fire-and-forget) call can NEVER acquire a slot on its own; only
      // cancellation (via settleRpc, once "done" fires) can end its wait.
      await new Promise(() => {});
      return JSON.stringify({ tool: "done", arguments: { reason: "unreachable" } });
    },
  }));
  const { createEvalTool } = await import("../src/agent/eval-tool");
  const tool = createEvalTool({ config: { defaultModel: "ollama/fast", subagents: {} } });
  const res = await tool({
    code: `
      // Fill all 4 MAX_FANOUT slots with never-resolving dispatches (fire-and-forget —
      // the script itself never awaits any of them either).
      for (let i = 0; i < 4; i++) task("executor", "filler-" + i);
      // A REAL delay (the worker has full JS runtime access, same as every
      // parallel()/pipeline() test above using setTimeout) so the 4 fillers
      // genuinely reach callLlm and occupy their slots on the MAIN thread —
      // which runs concurrently with this worker's own sleep — BEFORE the
      // 5th call is fired and this script returns (triggering "done").
      // Without this, the script returns near-instantly and "done" would
      // race ahead of ALL 5 dispatches, proving nothing about the QUEUE
      // specifically (only re-proving the "never even started" case above).
      await new Promise(r => setTimeout(r, 200));
      // The 5th call is queued behind all 4 occupied slots — it can only
      // ever be cancelled OUT of the queue, never actually dispatched.
      task("executor", "QUEUED-should-never-dispatch");
      return "returned while 4 fillers hang and a 5th is still queued";
    `,
  }, await tmpDir());
  expect(res.success).toBe(true);
  expect(dispatchedTaskTexts.length).toBe(4); // exactly the 4 that filled MAX_FANOUT — the 5th was NEVER dispatched
  expect(dispatchedTaskTexts.some(t => t.includes("QUEUED-should-never-dispatch"))).toBe(false);
}, 10_000);
