import { test, expect } from "bun:test";
import {
  findCatalogEntry,
  catalogForProvider,
  recommendedModel,
  validateModelId,
  suggestModels,
  editDistance,
  catalogIds,
  normalizeModelId,
} from "../src/ai/model-catalog-compat";
import { resolveProvider } from "../src/ai/model-manager";

test("findCatalogEntry is normalized + adapts to {id,provider,contextWindow,reasoning}", () => {
  const e = findCatalogEntry("CLAUDE-SONNET-4-6")!;
  expect(e.id).toBe("claude-sonnet-4-6");
  expect(e.provider).toBe("anthropic");
  expect(e.contextWindow).toBeGreaterThan(0);
  expect(typeof e.reasoning).toBe("boolean");
  // provider model id also resolves
  expect(findCatalogEntry("gpt-4o")!.provider).toBe("openai");
  expect(findCatalogEntry("totally-made-up")).toBeUndefined();
});

test("adapted entries route to their declared provider", () => {
  for (const id of catalogIds()) {
    expect(resolveProvider(findCatalogEntry(id)!.id)).toBe(findCatalogEntry(id)!.provider);
  }
});

test("catalogForProvider lists recommended first", () => {
  const ant = catalogForProvider("anthropic");
  expect(ant.length).toBeGreaterThan(0);
  expect(ant[0]!.recommended).toBe(true);
  expect(ant.every(e => e.provider === "anthropic")).toBe(true);
});

test("recommendedModel returns a recommended id per provider", () => {
  expect(recommendedModel("anthropic")).toBe("claude-sonnet-4-6");
  expect(recommendedModel("openai")).toBe("gpt-4o");
  expect(recommendedModel("gemini")).toBe("gemini-2.0-flash");
});

test("validateModelId reports known + provider match", () => {
  expect(validateModelId("gpt-4o").known).toBe(true);
  expect(validateModelId("gpt-4o", "openai").providerMatch).toBe(true);
  expect(validateModelId("gpt-4o", "anthropic").providerMatch).toBe(false);
  expect(validateModelId("nope").known).toBe(false);
});

test("editDistance + suggestModels correct typos", () => {
  expect(editDistance("kitten", "sitting")).toBe(3);
  expect(suggestModels("claude-sonnet-46")).toContain("claude-sonnet-4-6");
  expect(suggestModels("gpt").length).toBeGreaterThan(0);
  expect(suggestModels("")).toEqual([]);
});

test("normalizeModelId trims + lowercases", () => {
  expect(normalizeModelId("  GPT-4o ")).toBe("gpt-4o");
});
