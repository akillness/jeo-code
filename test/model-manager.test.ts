import { test, expect } from "bun:test";
import { resolveProvider, thinkingMaxTokens, thinkingToReasoningEffort } from "../src/ai/model-manager";

test("resolveProvider: routing is stable across model id shapes", () => {
  expect(resolveProvider("ollama/qwen2.5:0.5b")).toBe("ollama");
  expect(resolveProvider("openai/local-model")).toBe("openai");
  expect(resolveProvider("gpt-4o")).toBe("openai");
  expect(resolveProvider("gemini-2.5-flash")).toBe("gemini");
  expect(resolveProvider("google/gemini-pro")).toBe("gemini");
  expect(resolveProvider("claude-3-5-sonnet")).toBe("anthropic");
  // Reasoning models must route to OpenAI (previously fell through to anthropic).
  expect(resolveProvider("o1")).toBe("openai");
  expect(resolveProvider("o1-preview")).toBe("openai");
  expect(resolveProvider("o3-mini")).toBe("openai");
  expect(resolveProvider("o4-mini")).toBe("openai");
  expect(resolveProvider("openai/o3")).toBe("openai");
  expect(resolveProvider("GPT-4O")).toBe("openai");
  // Non-OpenAI ids with an embedded "o<digit>" must not be misrouted.
  expect(resolveProvider("claude-opus-4")).toBe("anthropic");
  expect(resolveProvider("echo1-model")).toBe("anthropic");
});

test("thinkingMaxTokens: maps level → token budget (medium default)", () => {
  expect(thinkingMaxTokens("low")).toBe(8000);
  expect(thinkingMaxTokens("medium")).toBe(16000);
  expect(thinkingMaxTokens("high")).toBe(24000);
  expect(thinkingMaxTokens(undefined)).toBe(16000);
});

test("thinkingToReasoningEffort: maps session level → provider reasoning tier", () => {
  // minimal/low collapse to the lowest tier the o-series reliably accepts.
  expect(thinkingToReasoningEffort("minimal")).toBe("low");
  expect(thinkingToReasoningEffort("low")).toBe("low");
  expect(thinkingToReasoningEffort("medium")).toBe("medium");
  // high AND xhigh both map to the deepest provider tier.
  expect(thinkingToReasoningEffort("high")).toBe("high");
  expect(thinkingToReasoningEffort("xhigh")).toBe("high");
  // Unset → undefined so the caller falls back to the global config.
  expect(thinkingToReasoningEffort(undefined)).toBeUndefined();
});