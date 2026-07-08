import { test, expect, mock } from "bun:test";
import { friendlyProviderError, isContextOverflowError } from "../src/util/provider-error";
import { ConnectionContextError } from "../src/util/retry";

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

test("friendlyProviderError: a ConnectionContextError names the provider + base URL and gives local-server guidance for ollama/lmstudio", () => {
  const raw = Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" });
  const ollamaMsg = friendlyProviderError(new ConnectionContextError("ollama", "http://localhost:11434", raw));
  expect(ollamaMsg).toContain("Ollama");
  expect(ollamaMsg).toContain("http://localhost:11434");
  expect(ollamaMsg).toContain("Start the Ollama server");
  expect(ollamaMsg).toContain("ollamaBaseUrl");

  const lmstudioMsg = friendlyProviderError(new ConnectionContextError("lmstudio", "http://localhost:1234/v1", raw));
  expect(lmstudioMsg).toContain("LM Studio");
  expect(lmstudioMsg).toContain("Start the LM Studio server");
});

test("friendlyProviderError: a ConnectionContextError for a NON-local provider gets base-URL/network guidance, not local-server instructions", () => {
  const raw = Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" });
  const msg = friendlyProviderError(new ConnectionContextError("openai", "http://my-proxy.internal:9000/v1", raw));
  expect(msg).toContain("OpenAI");
  expect(msg).toContain("http://my-proxy.internal:9000/v1");
  expect(msg).not.toContain("Start the");
  expect(msg).toContain("network connection");
});

test("friendlyProviderError: a bare (un-enriched) connection error — e.g. from a call site outside the routing veto gate — still gets an actionable message, not the raw Bun text", () => {
  const raw = Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" });
  const msg = friendlyProviderError(raw);
  expect(msg).toContain("Could not connect");
  expect(msg).not.toBe(raw.message); // never the bare, provider-less original text
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
