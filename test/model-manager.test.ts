import { test, expect } from "bun:test";
import { resolveProvider, thinkingMaxTokens } from "../src/ai/model-manager";

test("resolveProvider: routing is stable across model id shapes", () => {
  expect(resolveProvider("ollama/qwen2.5:0.5b")).toBe("ollama");
  expect(resolveProvider("openai/local-model")).toBe("openai");
  expect(resolveProvider("gpt-4o")).toBe("openai");
  expect(resolveProvider("gemini-2.5-flash")).toBe("gemini");
  expect(resolveProvider("google/gemini-pro")).toBe("gemini");
  expect(resolveProvider("claude-3-5-sonnet")).toBe("anthropic");
});

test("thinkingMaxTokens: maps level → token budget (medium default)", () => {
  expect(thinkingMaxTokens("low")).toBe(2000);
  expect(thinkingMaxTokens("medium")).toBe(4000);
  expect(thinkingMaxTokens("high")).toBe(8000);
  expect(thinkingMaxTokens(undefined)).toBe(4000);
});
