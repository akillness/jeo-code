import { test, expect, mock } from "bun:test";
import { extractJsonObject, tryExtractJsonObject } from "../src/agent/json";
import { truncateToolOutput, READ_OUTPUT_MAX, TOOL_OUTPUT_MAX } from "../src/agent/engine";

test("extractJsonObject: pure JSON", () => {
  expect(extractJsonObject('{"tool":"done","arguments":{"reason":"x"}}')).toEqual({
    tool: "done",
    arguments: { reason: "x" },
  });
});

test("extractJsonObject: fenced JSON", () => {
  const text = "Here you go:\n```json\n{\"tool\":\"read\",\"arguments\":{\"filePath\":\"a.ts\"}}\n```\n";
  expect(extractJsonObject(text)).toEqual({ tool: "read", arguments: { filePath: "a.ts" } });
});

test("extractJsonObject: prose wrapping + trailing commentary", () => {
  const text = 'I will write the file. {"tool":"write","arguments":{"filePath":"x","content":"hi"}} Done.';
  expect(extractJsonObject(text)).toEqual({ tool: "write", arguments: { filePath: "x", content: "hi" } });
});

test("extractJsonObject: braces inside string values are not miscounted", () => {
  const text = '{"tool":"bash","arguments":{"command":"echo \\"{not a brace}\\""}}';
  expect(extractJsonObject(text)).toEqual({ tool: "bash", arguments: { command: 'echo "{not a brace}"' } });
});

test("tryExtractJsonObject: returns null on garbage", () => {
  expect(tryExtractJsonObject("no json here at all")).toBeNull();
});

test("extractJsonObject: throws on garbage", () => {
  expect(() => extractJsonObject("totally not json")).toThrow();
});


// --- gjc-robustness hardening: trailing commas + tool-key preference ---

test("extractJsonObject: tolerates a trailing comma before }", () => {
  expect(extractJsonObject('{"tool":"read","arguments":{"filePath":"a.ts",}}')).toEqual({
    tool: "read",
    arguments: { filePath: "a.ts" },
  });
});

test("extractJsonObject: tolerates a trailing comma before ]", () => {
  expect(
    extractJsonObject('{"tools":[{"tool":"read","arguments":{"filePath":"a.ts"}},]}'),
  ).toEqual({ tools: [{ tool: "read", arguments: { filePath: "a.ts" } }] });
});

test("extractJsonObject: a comma inside a string is never stripped", () => {
  expect(extractJsonObject('{"tool":"bash","arguments":{"command":"echo a,}"}}')).toEqual({
    tool: "bash",
    arguments: { command: "echo a,}" },
  });
});

test("extractJsonObject: preferKeys picks the tool object after an earlier valid JSON object", () => {
  // A model emits a complete, parseable JSON object in its reasoning prose BEFORE
  // the real tool call. Without preferKeys the first object wins (wrong); with it,
  // the object carrying "tool" is selected.
  const text = 'Plan: {"step":1,"note":"first read the file"} then {"tool":"read","arguments":{"filePath":"a.ts"}}';
  expect(extractJsonObject(text, { preferKeys: ["tool", "tools"] })).toEqual({
    tool: "read",
    arguments: { filePath: "a.ts" },
  });
});

test("extractJsonObject: without preferKeys the first parseable object still wins (generic callers unchanged)", () => {
  const text = '{"step":1,"note":"first"} then {"tool":"read","arguments":{}}';
  expect(extractJsonObject(text)).toEqual({ step: 1, note: "first" });
});

// --- engine loop, with callLlm mocked via module mock ---

test("runAgentLoop: dispatches a tool then completes on done", async () => {
  const calls: string[] = [];
  // Mock the LLM: first return a write tool call, then a done.
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      if (turn === 1) return JSON.stringify({ tool: "echotool", arguments: { v: 1 } });
      return JSON.stringify({ tool: "done", arguments: { reason: "all set" } });
    },
  }));

  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "go" }];
  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 5,
    tools: {
      echotool: async args => {
        calls.push(`echotool:${JSON.stringify(args)}`);
        return { success: true, output: "echoed" };
      },
    },
  });

  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("all set");
  expect(calls).toEqual(['echotool:{"v":1}']);
  // [system,user] + [assistant,result] for echotool (done turn does not append)
  expect(history.length).toBe(4);
  expect(history.some(m => m.content.includes("Tool [echotool] result (ok)"))).toBe(true);
});

test("runAgentLoop: unknown tool surfaces error and keeps going until cap", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "nope", arguments: {} }),
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }];
  const result = await runAgentLoop(history, { cwd: process.cwd(), maxSteps: 3, tools: {} });
  expect(result.done).toBe(false);
  expect(result.steps).toBe(3);
  expect(history.some(m => m.content.includes("Unknown tool: nope"))).toBe(true);
});

test("runAgentLoop: invalid JSON is fed back to the model for repair", async () => {
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      if (turn === 1) return '{"tool":"done","arguments":{"reason":"broken"';
      return JSON.stringify({ tool: "done", arguments: { reason: "recovered" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }];
  const result = await runAgentLoop(history, { cwd: process.cwd(), maxSteps: 5 });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("recovered");
  expect(history.some(m => m.content.includes("not a valid tool call"))).toBe(true);
});

test("runAgentLoop: stops on repeated identical tool calls (weak-model no-progress guard)", async () => {
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    // Always emit the SAME write call, never `done` — simulates a weak local model.
    callLlm: async () => {
      calls++;
      return JSON.stringify({ tool: "write", arguments: { filePath: "x.txt", content: "hi" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }];
  let writes = 0;
  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 25,
    tools: { write: async () => { writes++; return { success: true, output: "wrote" }; } },
  });
  expect(result.done).toBe(false);
  expect(result.doneReason).toContain("repeated the same 'write' call");
  // Repeat handling runs BEFORE execution: the 1st call runs, the 2nd identical
  // call is SKIPPED with a corrective bounce, and the 3rd (repeated through the
  // correction) trips the stop — a mutating call never re-executes.
  expect(writes).toBe(1);
  expect(history.some(m => m.content.includes("repeated the EXACT same"))).toBe(true);
  expect(calls).toBeLessThan(25);
});

test("runAgentLoop: an aborted signal stops before any tool call", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "write", arguments: {} }),
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const ac = new AbortController();
  ac.abort();
  let toolCalls = 0;
  const history = [{ role: "system" as const, content: "sys" }];
  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 5,
    signal: ac.signal,
    tools: { write: async () => { toolCalls++; return { success: true, output: "x" }; } },
  });
  expect(result.done).toBe(false);
  expect(result.doneReason).toBe("Cancelled.");
  expect(toolCalls).toBe(0);
});

test("runAgentLoop: stops after 5 consecutive failing tool calls (distinct args)", async () => {
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    // Different args each turn → dodges the identical-call guard, exercises the failure guard.
    callLlm: async () => JSON.stringify({ tool: "flaky", arguments: { n: ++turn } }),
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }];
  let calls = 0;
  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 25,
    tools: { flaky: async () => { calls++; return { success: false, output: "", error: "nope" }; } },
  });
  expect(result.done).toBe(false);
  expect(result.doneReason).toContain("consecutive failing tool calls");
  expect(calls).toBe(5);
  expect(result.steps).toBe(5);
});

test("runAgentLoop: a thrown LLM error becomes the doneReason (not a step-limit message)", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => { throw new Error("HTTP 401: bad key"); },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }];
  const result = await runAgentLoop(history, { cwd: process.cwd(), maxSteps: 5 });
  expect(result.done).toBe(false);
  expect(result.doneReason).toContain("Error:");
  expect(result.doneReason).toContain("HTTP 401");
});

test("runAgentLoop: provider auto-retry surfaces as onNotice and the terminal error is reported ONCE (via doneReason)", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (_h: unknown, options: { onRetry?: (attempt: number, err: unknown, delayMs: number) => void }) => {
      // Simulate the model-manager retry layer: one 429 backoff wait, then exhaustion.
      options.onRetry?.(1, { status: 429, message: "rate limited" }, 4000);
      throw { status: 429, message: "Anthropic request failed (HTTP 429): rate limited" };
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const notices: string[] = [];
  const history = [{ role: "system" as const, content: "sys" }];
  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 5,
    events: { onNotice: msg => notices.push(msg) },
  });
  // The retry wait is visible while it happens…
  expect(notices).toEqual(["rate limited (HTTP 429) — auto-retry #1 in 4s"]);
  // …and the final failure is carried ONLY by doneReason (no duplicate error event).
  expect(result.done).toBe(false);
  expect(result.doneReason).toContain("Rate limited");
  expect(result.doneReason).toContain("429");
});

test("truncateToolOutput: keeps head and tail (tail holds the decisive part)", () => {
  const short = "all good";
  expect(truncateToolOutput(short, 100)).toBe(short);

  const body = "HEAD_MARKER" + "x".repeat(5000) + "TAIL_MARKER";
  const out = truncateToolOutput(body, 1000);
  expect(out.length).toBeLessThan(body.length);
  expect(out).toContain("HEAD_MARKER");
  expect(out).toContain("TAIL_MARKER"); // would be lost by a pure head-cut
  expect(out).toContain("chars truncated");
});

test("truncateToolOutput: headOnly keeps a contiguous front slice (read mode)", () => {
  const body = "HEAD_MARKER" + "x".repeat(5000) + "TAIL_MARKER";
  const out = truncateToolOutput(body, 1000, true);
  expect(out.length).toBeLessThan(body.length);
  expect(out).toContain("HEAD_MARKER");
  expect(out).not.toContain("TAIL_MARKER"); // head-only: no tail fragment to mangle the slice
  expect(out).toContain("chars truncated");
  // The kept content is a single contiguous prefix, not two stitched ends.
  expect(out.slice(0, 1000)).toBe(body.slice(0, 1000));
});

test("READ_OUTPUT_MAX: read budget is far larger than the generic cap (fits ~500 lines)", () => {
  // A 500-line read (~50 chars/line incl. anchors) must fit without truncation so
  // reads are no longer silently re-shrunk to ~100 lines by the generic 4k cap.
  expect(READ_OUTPUT_MAX).toBeGreaterThanOrEqual(25_000);
  expect(READ_OUTPUT_MAX).toBeGreaterThan(TOOL_OUTPUT_MAX);
});

test("runAgentLoop: a model that never emits a 'tool' field stops with a clear, actionable reason", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ arguments: { foo: 1 } }), // valid JSON, no "tool" field
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }];
  const result = await runAgentLoop(history, { cwd: process.cwd(), maxSteps: 8, tools: {} });
  expect(result.done).toBe(false);
  expect(result.doneReason).toContain("no valid tool call");
  expect(result.doneReason).toContain("/model"); // points the user at a stronger model
  expect(result.steps).toBeLessThanOrEqual(3); // stops at the guard, not the step cap
});

test("runAgentLoop: exhausted step budget triggers a no-tools consolidation wrap-up", async () => {
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (_h: unknown, options: { jsonMode?: boolean }) => {
      calls++;
      // Tool-call JSON while jsonMode is on; PROSE for the final wrap-up call (jsonMode:false).
      if (options?.jsonMode === false) return "Consolidated: read 2 files, found the bug in x.ts; next: apply the fix.";
      return JSON.stringify({ tool: "spin", arguments: { n: calls } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const result = await runAgentLoop([{ role: "user", content: "go" }], {
    cwd: process.cwd(),
    maxSteps: 3,
    // Legacy fixed counter (extensions off) — the consolidation contract under test.
    budget: { maxExtensions: 0 },
    tools: { spin: async () => ({ success: true, output: "ok" }) },
  });
  expect(result.done).toBe(false);
  expect(result.steps).toBe(3);
  // The reply is the consolidated wrap-up, not a bare "(reached the limit)" failure.
  expect(result.doneReason).toContain("Consolidated: read 2 files");
  expect(result.doneReason).toContain("step budget of 3 reached");
  expect(calls).toBe(4); // 3 tool steps + 1 wrap-up
});
