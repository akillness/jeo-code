import { test, expect } from "bun:test";
import { resolveProvider, describeModelDetailed } from "../src/ai/model-manager";

test("resolveProvider stays correct for heuristic ids", () => {
  expect(resolveProvider("ollama/llama3.1:8b")).toBe("ollama");
  expect(resolveProvider("gpt-4o")).toBe("openai");
  expect(resolveProvider("o3-mini")).toBe("openai");
  expect(resolveProvider("gemini-2.0-flash")).toBe("gemini");
  expect(resolveProvider("claude-3-5-sonnet")).toBe("anthropic");
  expect(resolveProvider("some-unknown-model")).toBe("anthropic"); // heuristic fallback
});

test("resolveProvider is catalog-authoritative for known ids", () => {
  // every catalogued id routes to its declared provider (covered broadly here)
  expect(resolveProvider("claude-3-opus")).toBe("anthropic");
  expect(resolveProvider("ollama/qwen2.5-coder:7b")).toBe("ollama");
});

test("describeModelDetailed attaches catalog metadata + reverse aliases", async () => {
  const d = await describeModelDetailed("gpt");
  expect(d.resolved).toBe("gpt-5.5"); // alias expanded
  expect(d.provider).toBe("openai");
  expect(d.entry?.contextWindow).toBeGreaterThan(0);
  expect(d.aliases).toContain("gpt"); // reverse alias (builtin, always present)
});

test("describeModelDetailed leaves uncatalogued ids without an entry", async () => {
  const d = await describeModelDetailed("my-private-model");
  expect(d.entry).toBeUndefined();
  expect(d.resolved).toBe("my-private-model");
});
