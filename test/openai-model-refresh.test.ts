import { afterEach, expect, test } from "bun:test";
import {
  isCodexModel, isLiveProviderModel, liveProviderCatalogModels,
  recordLiveCodexModels, recordLiveProviderModels,
  resetLiveCodexModels, resetLiveProviderModels, setOpenAIOauthAccountScope,
} from "../src/ai/model-catalog";
import { applyCachedModels, mergeCacheEntries, normalizeCacheEntries } from "../src/ai/model-cache";

afterEach(() => {
  resetLiveCodexModels();
  resetLiveProviderModels();
});

test("a confirmed Codex catalog replaces old models and overrides the bundled snapshot", () => {
  recordLiveCodexModels(["gpt-5.5", "gpt-old"], "account-a");
  recordLiveCodexModels(["gpt-new"], "account-a");
  expect(isCodexModel("gpt-old")).toBe(false);
  expect(isCodexModel("gpt-5.5")).toBe(false);
  expect(isCodexModel("openai/gpt-new")).toBe(true);
  recordLiveCodexModels([], "account-a");
  expect(isCodexModel("gpt-new")).toBe(false);
  expect(isCodexModel("gpt-5.5")).toBe(false);
  setOpenAIOauthAccountScope("account-b");
  expect(isCodexModel("gpt-new")).toBe(false);
  expect(isCodexModel("gpt-5.5")).toBe(true);
});

test("complete OpenAI refreshes evict stale routing rows only within their own auth and endpoint scope", () => {
  recordLiveProviderModels("openai", ["gpt-old", "gpt-shared"], { source: "api_key" });
  recordLiveProviderModels("openai", ["gpt-shared", "gpt-subscription"], { source: "oauth", accountId: "account-a" });
  recordLiveProviderModels("openai", ["gpt-proxy"], { source: "api_key", baseUrl: "https://proxy.example/v1" });
  recordLiveProviderModels("openai", ["gpt-new"], { source: "api_key", replace: true });
  expect(isLiveProviderModel("openai", "gpt-old")).toBe(false);
  expect(isLiveProviderModel("openai", "gpt-new")).toBe(true);
  expect(isLiveProviderModel("openai", "gpt-shared")).toBe(true);
  expect(isLiveProviderModel("openai", "gpt-proxy", { openaiBaseUrl: "https://proxy.example/v1" })).toBe(true);
  recordLiveProviderModels("openai", [], { source: "oauth", accountId: "account-a", replace: true });
  expect(isLiveProviderModel("openai", "gpt-shared")).toBe(false);
  expect(liveProviderCatalogModels().map(row => row.canonical)).toEqual(["gpt-new"]);
});

test("other providers keep additive routing observations even when replace is requested", () => {
  recordLiveProviderModels("anthropic", ["claude-old"], { source: "api_key" });
  recordLiveProviderModels("anthropic", ["claude-new"], { source: "api_key", replace: true });
  expect(isLiveProviderModel("anthropic", "claude-old")).toBe(true);
  expect(isLiveProviderModel("anthropic", "claude-new")).toBe(true);
});

test("successful empty OpenAI cache refreshes are authoritative while failures and fallback leave cache intact", () => {
  const previous = [{ provider: "openai" as const, source: "oauth" as const, accountId: "account-a", models: ["gpt-old"] }];
  expect(mergeCacheEntries(previous, [{ ...previous[0], models: ["gpt-fake"], ok: true, fallback: true }])).toEqual(previous);
  expect(mergeCacheEntries(previous, [{ ...previous[0], models: [], ok: false }])).toEqual(previous);
  const refreshed = mergeCacheEntries(previous, [{ ...previous[0], models: [], ok: true }]);
  expect(refreshed).toEqual([{ ...previous[0], models: [] }]);
  expect(normalizeCacheEntries(refreshed)).toEqual(refreshed);
  applyCachedModels({ version: 3, updatedAt: Date.now(), providers: refreshed }, "account-a");
  expect(isCodexModel("gpt-5.5")).toBe(false);
});

test("cache keeps API and keyless endpoint lists separate and preserves complete OpenAI lists", () => {
  const models = Array.from({ length: 600 }, (_, i) => `gpt-deployment-${i}`);
  const merged = mergeCacheEntries([
    { provider: "openai", source: "api_key", models: ["gpt-api"], baseUrl: "https://proxy.example/v1/" },
  ], [{ provider: "openai", source: "keyless", models, baseUrl: "https://proxy.example/v1", ok: true }]);
  expect(merged).toHaveLength(2);
  expect(normalizeCacheEntries(merged)[1].models).toHaveLength(600);
});

test("proxy OAuth cache rows never authorize Codex models", () => {
  applyCachedModels({ version: 3, updatedAt: Date.now(), providers: [
    { provider: "openai", source: "oauth", accountId: "account-a", baseUrl: "https://proxy.example/v1", models: ["gpt-proxy"] },
  ] }, "account-a");
  expect(isCodexModel("gpt-proxy")).toBe(false);
  expect(isLiveProviderModel("openai", "gpt-proxy", { openaiBaseUrl: "https://proxy.example/v1", openaiOauthScope: "account-a" })).toBe(true);
});
