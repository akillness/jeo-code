import { test, expect } from "bun:test";
import { ollamaAdapter } from "../src/ai/providers/ollama";
import type { CallOptions, Usage } from "../src/ai/types";

test("ollamaAdapter.call: reports token usage via onUsage", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({
      message: { content: "hi" },
      prompt_eval_count: 5,
      eval_count: 7,
      total_duration: 2_000_000, // 2ms in ns
    })) as typeof fetch;
  try {
    let usage: Usage | undefined;
    const opts: CallOptions = { model: "ollama/qwen2.5:0.5b", onUsage: u => { usage = u; } };
    const text = await ollamaAdapter.call([{ role: "user", content: "x" }], opts, { kind: "none", provider: "openai" });
    expect(text).toBe("hi");
    expect(usage).toEqual({ inputTokens: 5, outputTokens: 7, durationMs: 2 });
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("openaiAdapter.call: reports usage", async () => {
  const { openaiAdapter } = await import("../src/ai/providers/openai");
  const prev = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 11, completion_tokens: 3 } })) as typeof fetch;
  try {
    let u: Usage | undefined;
    const t = await openaiAdapter.call([{ role: "user", content: "x" }], { model: "gpt-4o", onUsage: x => { u = x; } }, { kind: "api_key", provider: "openai", token: "k" });
    expect(t).toBe("ok");
    expect(u).toEqual({ inputTokens: 11, outputTokens: 3 });
  } finally { globalThis.fetch = prev; }
});

test("anthropicAdapter.call: reports usage", async () => {
  const { anthropicAdapter } = await import("../src/ai/providers/anthropic");
  const prev = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 9, output_tokens: 4 } })) as typeof fetch;
  try {
    let u: Usage | undefined;
    const t = await anthropicAdapter.call([{ role: "user", content: "x" }], { model: "claude-3-5-sonnet", onUsage: x => { u = x; } }, { kind: "api_key", provider: "anthropic", token: "k" });
    expect(t).toBe("ok");
    expect(u).toEqual({ inputTokens: 9, outputTokens: 4 });
  } finally { globalThis.fetch = prev; }
});
