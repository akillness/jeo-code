import { test, expect } from "bun:test";
import {
  normalizeBaseUrl,
  chooseDefaultModel,
  recommendedModelsFor,
  buildEnabledProviders,
  buildSetupSummary,
} from "../src/commands/setup-helpers";
import type { Config } from "../src/agent/state";

const cfg = (partial: Partial<Config> & { openaiBaseUrl?: string }): Config =>
  ({ providers: {}, defaultModel: "claude-3-5-sonnet", ...partial }) as Config;

test("normalizeBaseUrl defaults, adds scheme, strips trailing slash", () => {
  expect(normalizeBaseUrl("", "http://localhost:11434")).toBe("http://localhost:11434");
  expect(normalizeBaseUrl("localhost:1234/v1/", "x")).toBe("http://localhost:1234/v1");
  expect(normalizeBaseUrl("https://api.x.com/", "x")).toBe("https://api.x.com");
  expect(normalizeBaseUrl("  http://h//  ", "x")).toBe("http://h");
});

test("chooseDefaultModel: blank → provider's recommended", () => {
  expect(chooseDefaultModel("", "openai").model).toBe("gpt-4o");
  expect(chooseDefaultModel("   ", "anthropic").model).toBe("claude-sonnet-4-5");
});

test("chooseDefaultModel: known id accepted; provider mismatch warns", () => {
  const ok = chooseDefaultModel("gpt-4o", "openai");
  expect(ok.known).toBe(true);
  expect(ok.warning).toBeUndefined();
  const mismatch = chooseDefaultModel("gpt-4o", "anthropic");
  expect(mismatch.known).toBe(true);
  expect(mismatch.warning).toContain("routes to openai");
});

test("chooseDefaultModel: unknown id accepted with suggestions", () => {
  const r = chooseDefaultModel("claude-sonnet-45", "anthropic"); // typo
  expect(r.known).toBe(false);
  expect(r.warning).toContain("not in the model catalog");
  expect(r.suggestions).toContain("claude-sonnet-4-5");
});

test("recommendedModelsFor returns annotated id lines", () => {
  const lines = recommendedModelsFor("anthropic", 3);
  expect(lines.length).toBeLessThanOrEqual(3);
  expect(lines[0]).toContain("claude-sonnet-4-5");
  expect(lines[0]).toContain("—"); // note separator
});

test("recommendedModelsFor can show Codex OAuth OpenAI defaults", () => {
  const lines = recommendedModelsFor("openai", 2, { codex: true });
  expect(lines[0]).toContain("gpt-5.5");
  expect(lines[0]).toContain("Codex OAuth");
  expect(lines.join("\n")).not.toContain("gpt-4o");
});

test("buildEnabledProviders detects keys, oauth, and base URLs", () => {
  expect(buildEnabledProviders(cfg({ providers: { anthropic: "k" } }))).toContain("anthropic");
  expect(buildEnabledProviders(cfg({ oauth: { openai: "t" } as Config["oauth"] }))).toContain("openai");
  expect(buildEnabledProviders(cfg({ ollamaBaseUrl: "http://h" }))).toEqual(["ollama(http://h)"]);
  expect(buildEnabledProviders(cfg({ openaiBaseUrl: "http://c" }))).toContain("openai-compatible(http://c)");
  expect(buildEnabledProviders(cfg({}))).toEqual([]);
});

test("buildSetupSummary reports the resolved provider + catalog metadata", () => {
  const lines = buildSetupSummary(cfg({ defaultModel: "gpt-4o", providers: { openai: "k" } }));
  expect(lines[0]).toContain("gpt-4o → openai");
  expect(lines[0]).toContain("ctx");
  expect(lines[1]).toContain("openai");
});
