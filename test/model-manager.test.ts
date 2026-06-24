import { test, expect } from "bun:test";
import { resolveProvider, thinkingMaxTokens, thinkingToReasoningEffort, effectiveCredentialForProvider } from "../src/ai/model-manager";
import type { Credential } from "../src/auth/storage";

test("effectiveCredentialForProvider: anthropic OAuth wins even when an API key is configured", () => {
  const oauth: Credential = { kind: "oauth", provider: "anthropic", token: "oauth-tok" };
  const eff = effectiveCredentialForProvider("anthropic", oauth, { providers: { anthropic: "sk-ant" } }, "claude-3-5-sonnet");
  expect(eff.kind).toBe("oauth");
});

test("effectiveCredentialForProvider: gemini OAuth wins over API key (Cloud Code Assist serves it)", () => {
  const oauth: Credential = { kind: "oauth", provider: "gemini", token: "oauth-tok" };
  const eff = effectiveCredentialForProvider("gemini", oauth, { providers: { gemini: "AIza" } }, "gemini-2.5-flash");
  expect(eff.kind).toBe("oauth");
});

test("effectiveCredentialForProvider: OpenAI OAuth serves Codex models but falls back to API key for others", () => {
  const oauth: Credential = { kind: "oauth", provider: "openai", token: "oauth-tok" };
  const codex = effectiveCredentialForProvider("openai", oauth, { providers: { openai: "sk-oai" } }, "gpt-5.5");
  expect(codex.kind).toBe("oauth");
  const other = effectiveCredentialForProvider("openai", oauth, { providers: { openai: "sk-oai" } }, "gpt-4o");
  expect(other.kind).toBe("api_key");
});

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
  // minimal is a GENUINE (lightest) reasoning effort — reasoning works at EVERY level
  // (gajae parity: Minimal is a real effort), no longer collapsed to low.
  expect(thinkingToReasoningEffort("minimal")).toBe("minimal");
  expect(thinkingToReasoningEffort("low")).toBe("low");
  expect(thinkingToReasoningEffort("medium")).toBe("medium");
  // high AND xhigh both map to the deepest provider tier.
  expect(thinkingToReasoningEffort("high")).toBe("high");
  expect(thinkingToReasoningEffort("xhigh")).toBe("high");
  // Unset → undefined so the caller falls back to the global config.
  expect(thinkingToReasoningEffort(undefined)).toBeUndefined();
});