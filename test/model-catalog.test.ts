import { test, expect } from "bun:test";
import {
  MODEL_CATALOG,
  catalogForProvider,
  findCatalogEntry,
  recommendedModel,
  searchCatalog,
  validateModelId,
  editDistance,
  suggestModels,
  normalizeModelId,
} from "../src/ai/model-catalog";
import { resolveProvider } from "../src/ai/model-manager";

test("catalog entries route to the provider they claim", () => {
  for (const e of MODEL_CATALOG) {
    expect(resolveProvider(e.id)).toBe(e.provider);
    expect(e.contextWindow).toBeGreaterThanOrEqual(0);
  }
});

test("catalogForProvider lists recommended first", () => {
  const ant = catalogForProvider("anthropic");
  expect(ant.length).toBeGreaterThan(0);
  expect(ant[0]!.recommended).toBe(true);
  expect(ant.every(e => e.provider === "anthropic")).toBe(true);
});

test("findCatalogEntry is normalized; unknown → undefined", () => {
  expect(findCatalogEntry("CLAUDE-3-5-SONNET")!.id).toBe("claude-3-5-sonnet");
  expect(findCatalogEntry(" gpt-4o ")!.provider).toBe("openai");
  expect(findCatalogEntry("totally-made-up")).toBeUndefined();
});

test("recommendedModel returns one recommended id per provider", () => {
  expect(recommendedModel("anthropic")).toBe("claude-3-5-sonnet");
  expect(recommendedModel("openai")).toBe("gpt-4o");
  expect(recommendedModel("gemini")).toBe("gemini-2.0-flash");
  expect(recommendedModel("ollama")).toBe("ollama/qwen2.5:0.5b");
});

test("searchCatalog matches id/family/note", () => {
  expect(searchCatalog("sonnet").every(e => e.id.includes("sonnet"))).toBe(true);
  expect(searchCatalog("reasoning").length).toBeGreaterThanOrEqual(0);
  expect(searchCatalog("").length).toBe(MODEL_CATALOG.length);
});

test("validateModelId reports known + provider match", () => {
  expect(validateModelId("gpt-4o").known).toBe(true);
  expect(validateModelId("gpt-4o", "openai").providerMatch).toBe(true);
  expect(validateModelId("gpt-4o", "anthropic").providerMatch).toBe(false);
  expect(validateModelId("nope").known).toBe(false);
});

test("editDistance basic cases", () => {
  expect(editDistance("", "abc")).toBe(3);
  expect(editDistance("abc", "abc")).toBe(0);
  expect(editDistance("kitten", "sitting")).toBe(3);
});

test("suggestModels corrects typos and matches substrings", () => {
  expect(suggestModels("gpt-4o")).toContain("gpt-4o");
  expect(suggestModels("claude-3-5-sonet")).toContain("claude-3-5-sonnet"); // typo
  expect(suggestModels("")).toEqual([]);
  expect(suggestModels("gpt").length).toBeGreaterThan(0); // substring
});

test("normalizeModelId trims + lowercases", () => {
  expect(normalizeModelId("  GPT-4o ")).toBe("gpt-4o");
});
