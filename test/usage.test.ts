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
