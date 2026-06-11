import { test, expect, mock } from "bun:test";
import { friendlyProviderError, isContextOverflowError } from "../src/util/provider-error";

// Round-6 #4 (architect ref 6-Round5Providers, deferred item): context-overflow
// and model-not-found stop collapsing into opaque raw bodies, and the engine
// reacts to a provider-authoritative overflow with ONE in-place trim + retry.

test("isContextOverflowError: message patterns and 413, but not plain 400s", () => {
  expect(isContextOverflowError(new Error("HTTP 400: context_length_exceeded"))).toBe(true);
  expect(isContextOverflowError(new Error("prompt is too long: 210000 tokens > 200000 maximum"))).toBe(true);
  expect(isContextOverflowError(new Error("input is too long for requested model"))).toBe(true);
  expect(isContextOverflowError(new Error("The request exceeds the maximum context window"))).toBe(true);
  expect(isContextOverflowError(Object.assign(new Error("Payload Too Large"), { status: 413 }))).toBe(true);
  expect(isContextOverflowError(Object.assign(new Error("HTTP 400: invalid request"), { status: 400 }))).toBe(false);
});

test("friendlyProviderError: overflow and 404 map to actionable guidance", () => {
  const overflow = friendlyProviderError(new Error("Anthropic API error — prompt is too long"));
  expect(overflow).toContain("context window");
  expect(overflow).toContain("/compact");
  const notFound = friendlyProviderError(Object.assign(new Error("OpenAI HTTP 404: model not found"), { status: 404 }));
  expect(notFound).toContain("/model");
  expect(notFound).toContain("404");
});

test("engine: provider overflow triggers ONE trim+retry, then the turn succeeds", async () => {
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      calls++;
      if (calls === 1) throw new Error("HTTP 400: context_length_exceeded — prompt is too long");
      return JSON.stringify({ tool: "done", arguments: { reason: "recovered" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const filler = "x".repeat(6000);
  const history = [
    { role: "system" as const, content: "sys" },
    { role: "user" as const, content: "task" },
    ...Array.from({ length: 5 }, (_, i) => [
      { role: "assistant" as const, content: `{"tool":"read","arguments":{"filePath":"f${i}.txt"}}` },
      { role: "user" as const, content: `Tool [read] result (ok):\n${filler}` },
    ]).flat(),
  ];
  const notices: string[] = [];
  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 4,
    maxHistoryTokens: 10_000, // halved reactive budget (5k) sits below the ~8k history → trims
    budget: { maxExtensions: 0 },
    tools: {},
    events: { onNotice: m => notices.push(m) },
  });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("recovered");
  expect(calls).toBe(2); // overflow → trim → free retry → done
  expect(notices.some(n => n.includes("context overflow"))).toBe(true);
});

test("engine: a second overflow surfaces the friendly error (one-shot recovery)", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      throw new Error("HTTP 400: context_length_exceeded — prompt is too long");
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const filler = "y".repeat(6000);
  const history = [
    { role: "system" as const, content: "sys" },
    { role: "user" as const, content: "task" },
    ...Array.from({ length: 5 }, (_, i) => [
      { role: "assistant" as const, content: `{"tool":"read","arguments":{"filePath":"g${i}.txt"}}` },
      { role: "user" as const, content: `Tool [read] result (ok):\n${filler}` },
    ]).flat(),
  ];
  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 4,
    maxHistoryTokens: 10_000,
    budget: { maxExtensions: 0 },
    tools: {},
  });
  expect(result.done).toBe(false);
  expect(result.doneReason).toContain("context window"); // friendly taxonomy, not raw 400
});
