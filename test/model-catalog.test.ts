import { test, expect } from "bun:test";
import {
  MODEL_CATALOG,
  THINK_LEVELS,
  formatTokens,
  findCatalogModel,
  fuzzyMatchCatalog,
  catalogByProvider,
  catalogMetadata,
  supportsThinking,
} from "../src/ai/model-catalog";
import { thinkingMaxTokens } from "../src/ai/model-manager";
import { formatCatalogTable, formatCapabilityLine } from "../src/tui/components/config-panel";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("THINK_LEVELS is the five-level gjc-parity ladder", () => {
  expect(THINK_LEVELS).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
});

test("thinkingMaxTokens covers the extended levels additively", () => {
  expect(thinkingMaxTokens("minimal")).toBe(1000);
  expect(thinkingMaxTokens("low")).toBe(2000);
  expect(thinkingMaxTokens("medium")).toBe(4000);
  expect(thinkingMaxTokens("high")).toBe(8000);
  expect(thinkingMaxTokens("xhigh")).toBe(16000);
  expect(thinkingMaxTokens(undefined)).toBe(4000);
});

test("formatTokens renders K/M compactly", () => {
  expect(formatTokens(8_192)).toBe("8K");
  expect(formatTokens(200_000)).toBe("200K");
  expect(formatTokens(1_000_000)).toBe("1M");
  expect(formatTokens(900)).toBe("900");
});

test("catalog entries are well-formed (provider, positive limits)", () => {
  expect(MODEL_CATALOG.length).toBeGreaterThan(5);
  for (const m of MODEL_CATALOG) {
    expect(["anthropic", "openai", "gemini", "ollama"]).toContain(m.provider);
    expect(m.contextTokens).toBeGreaterThan(0);
    expect(m.maxOutputTokens).toBeGreaterThan(0);
    for (const lvl of m.thinking) expect(THINK_LEVELS).toContain(lvl);
  }
});

test("findCatalogModel matches canonical and provider model id", () => {
  expect(findCatalogModel("gpt-4o")?.provider).toBe("openai");
  expect(findCatalogModel("claude-sonnet-4-5-20250929")?.canonical).toBe("claude-sonnet-4-5");
  expect(findCatalogModel("nope")).toBeUndefined();
});

test("fuzzyMatchCatalog does case-insensitive substring matching", () => {
  expect(fuzzyMatchCatalog("gpt").every(m => m.provider === "openai")).toBe(true);
  expect(fuzzyMatchCatalog("CLAUDE").length).toBeGreaterThan(0);
  expect(fuzzyMatchCatalog("zzz")).toEqual([]);
});

test("catalogByProvider filters", () => {
  expect(catalogByProvider("gemini").every(m => m.provider === "gemini")).toBe(true);
  expect(catalogByProvider("ollama").length).toBeGreaterThan(0);
});

test("catalogMetadata tolerates provider-prefixed ids", () => {
  expect(catalogMetadata("ollama/qwen2.5:0.5b")?.canonical).toBe("qwen2.5");
  expect(catalogMetadata("gpt-4o")?.canonical).toBe("gpt-4o");
  expect(catalogMetadata("unknown-model-x")).toBeUndefined();
});

test("supportsThinking reflects the catalog", () => {
  expect(supportsThinking("claude-sonnet-4-5", "high")).toBe(true);
  expect(supportsThinking("gpt-4o", "high")).toBe(false); // gpt-4o has no thinking
  expect(supportsThinking("unknown", "low")).toBe(false);
});

test("formatCatalogTable renders a header and capability columns", () => {
  const out = formatCatalogTable([...MODEL_CATALOG].slice(0, 3), { current: "gpt-4o" }).map(strip);
  expect(out[0]).toContain("provider");
  expect(out[0]).toContain("thinking");
  expect(out[0]).toContain("img");
  expect(out.join("\n")).toMatch(/200K|128K|1M/);
});

test("formatCatalogTable empty → message", () => {
  expect(formatCatalogTable([])).toEqual(["  (no catalog matches)"]);
});

test("formatCapabilityLine summarizes one model", () => {
  const m = findCatalogModel("gemini-2.5-pro")!;
  const line = strip(formatCapabilityLine(m));
  expect(line).toContain("ctx 1M");
  expect(line).toContain("thinking");
  expect(line).toContain("images yes");
});
