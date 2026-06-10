import { test, expect } from "bun:test";
import { MODEL_CATALOG, findCatalogModel } from "../src/ai/model-catalog";
import { providerModelFor } from "../src/ai/model-manager";
import { expandAlias } from "../src/ai/model-registry";

test("catalog has the three new canonical entries with correct providerModel", () => {
  const sonnet45 = findCatalogModel("claude-sonnet-4-5");
  expect(sonnet45).toBeDefined();
  expect(sonnet45!.providerModel).toBe("claude-sonnet-4-5-20250929");
  expect(sonnet45!.provider).toBe("anthropic");
  expect(sonnet45!.contextTokens).toBe(200_000);
  expect(sonnet45!.maxOutputTokens).toBe(64_000);
  expect(sonnet45!.thinking).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
  expect(sonnet45!.images).toBe(true);

  const haiku45 = findCatalogModel("claude-haiku-4-5");
  expect(haiku45).toBeDefined();
  expect(haiku45!.providerModel).toBe("claude-haiku-4-5-20251001");
  expect(haiku45!.provider).toBe("anthropic");
  expect(haiku45!.contextTokens).toBe(200_000);
  expect(haiku45!.maxOutputTokens).toBe(64_000);
  expect(haiku45!.thinking).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
  expect(haiku45!.images).toBe(true);

  const opus45 = findCatalogModel("claude-opus-4-5");
  expect(opus45).toBeDefined();
  expect(opus45!.providerModel).toBe("claude-opus-4-5-20251101");
  expect(opus45!.provider).toBe("anthropic");
  expect(opus45!.contextTokens).toBe(200_000);
  expect(opus45!.maxOutputTokens).toBe(64_000);
  expect(opus45!.thinking).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
  expect(opus45!.images).toBe(true);
});

test("providerModelFor maps correctly", () => {
  expect(providerModelFor("claude-sonnet-4-5")).toBe("claude-sonnet-4-5-20250929");
  expect(providerModelFor("claude-3-5-sonnet")).toBe("claude-3-5-sonnet-20241022");
  expect(providerModelFor("ollama/qwen2.5:0.5b")).toBe("ollama/qwen2.5:0.5b");
  expect(providerModelFor("unknown-model-id-123")).toBe("unknown-model-id-123");
});

test("alias sonnet resolves to claude-sonnet-4-5", () => {
  expect(expandAlias("sonnet")).toBe("claude-sonnet-4-5");
  expect(expandAlias("haiku")).toBe("claude-haiku-4-5");
  expect(expandAlias("opus")).toBe("claude-opus-4-5");
});
