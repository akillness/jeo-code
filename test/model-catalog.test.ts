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
  inferCatalogMetadata,
  companyLabel,
} from "../src/ai/model-catalog";
import { thinkingMaxTokens } from "../src/ai/model-manager";
import { formatCatalogTable, formatCapabilityLine } from "../src/tui/components/config-panel";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("THINK_LEVELS is the five-level gjc-parity ladder", () => {
  expect(THINK_LEVELS).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
});

test("thinkingMaxTokens covers the extended levels additively", () => {
  expect(thinkingMaxTokens("minimal")).toBe(4000);
  expect(thinkingMaxTokens("low")).toBe(8000);
  expect(thinkingMaxTokens("medium")).toBe(16000);
  expect(thinkingMaxTokens("high")).toBe(24000);
  expect(thinkingMaxTokens("xhigh")).toBe(31999);
  expect(thinkingMaxTokens(undefined)).toBe(16000);
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
    expect(["anthropic", "openai", "gemini", "antigravity", "ollama", "lmstudio", "xai", "kimi", "tencent"]).toContain(m.provider);
    expect(m.contextTokens).toBeGreaterThan(0);
    expect(m.maxOutputTokens).toBeGreaterThan(0);
    for (const lvl of m.thinking) expect(THINK_LEVELS).toContain(lvl);
  }
});

test("findCatalogModel matches canonical and provider model id", () => {
  expect(findCatalogModel("gpt-4o")?.provider).toBe("openai");
  expect(findCatalogModel("claude-haiku-4-5-20251001")?.canonical).toBe("claude-haiku-4-5");
  expect(findCatalogModel("nope")).toBeUndefined();
});

test("fuzzyMatchCatalog does case-insensitive substring matching", () => {
  expect(fuzzyMatchCatalog("gpt").every(m => m.provider === "openai" || m.provider === "antigravity")).toBe(true);
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
test("companyLabel maps built-ins, respects overrides, and falls back with capitalization", () => {
  expect(companyLabel("anthropic")).toBe("Anthropic");
  expect(companyLabel("openai")).toBe("OpenAI");
  expect(companyLabel("gemini")).toBe("Google");
  expect(companyLabel("ollama")).toBe("Ollama");
  expect(companyLabel("antigravity")).toBe("Antigravity");
  // Override priority
  expect(companyLabel("anthropic", { company: "Custom Company" })).toBe("Custom Company");
  // Fallback with capitalization
  expect(companyLabel("someprovider")).toBe("Someprovider");
});

test("opus-4-8 is catalogued with full thinking (matches 4-5/4-6 siblings)", () => {
  const m = catalogMetadata("claude-opus-4-8");
  expect(m?.provider).toBe("anthropic");
  expect(m?.thinking).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
  expect(supportsThinking("claude-opus-4-8", "high")).toBe(true);
  // antigravity thinking variant registered alongside 4-6
  expect(catalogMetadata("antigravity/claude-opus-4-8-thinking")?.thinking.length).toBeGreaterThan(0);
});

test("inferCatalogMetadata: uncatalogued reasoning families surface thinking like siblings", () => {
  // Future revisions not yet in the static catalog still expose reasoning.
  expect(inferCatalogMetadata("claude-opus-4-9")?.thinking.length).toBeGreaterThan(0);
  expect(inferCatalogMetadata("claude-sonnet-4-7")?.provider).toBe("anthropic");
  expect(inferCatalogMetadata("o5-pro")?.thinking).toContain("high");
  expect(inferCatalogMetadata("gpt-5.6")?.contextTokens).toBe(400_000);
  expect(inferCatalogMetadata("gemini-3.2-pro")?.thinking.length).toBeGreaterThan(0);
  expect(inferCatalogMetadata("grok-5")?.thinking.length).toBeGreaterThan(0);
  // Digit-count agnostic: multi-digit majors must NOT silently lose reasoning the way
  // opus-4-8 did. gpt-10/o10/gemini-10 are still reasoning-capable.
  expect(inferCatalogMetadata("gpt-10")?.thinking.length).toBeGreaterThan(0);
  expect(inferCatalogMetadata("o10-pro")?.thinking).toContain("high");
  expect(inferCatalogMetadata("gemini-10-pro")?.thinking.length).toBeGreaterThan(0);
  // o-series single-digit majors below 3 are still reasoning models (o1/o2).
  expect(inferCatalogMetadata("o1")?.thinking.length).toBeGreaterThan(0);
});

test("inferCatalogMetadata: non-reasoning + unknown ids stay conservative", () => {
  // Pre-thinking families must NOT claim reasoning.
  expect(inferCatalogMetadata("claude-3-5-haiku-latest")).toBeUndefined();
  expect(inferCatalogMetadata("gemini-2.0-flash-exp")?.thinking).toEqual([]);
  expect(inferCatalogMetadata("grok-4-fast-non-reasoning")?.thinking).toEqual([]);
  // Genuinely unknown ids return undefined ("unknown caps"), not a fake reasoning model.
  expect(inferCatalogMetadata("totally-unknown-model")).toBeUndefined();
  expect(catalogMetadata("totally-unknown-model")).toBeUndefined();
});
test("4.6+ Anthropic models are catalogued as 1M/128k with full thinking", () => {
  for (const id of ["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-4-6", "claude-sonnet-5", "claude-fable-5", "claude-mythos-5"]) {
    const m = findCatalogModel(id);
    expect(m?.provider).toBe("anthropic");
    expect(m?.providerModel).toBe(id); // dateless pinned snapshot — canonical == wire id
    expect(m?.contextTokens).toBe(1_000_000);
    expect(m?.maxOutputTokens).toBe(128_000);
    expect(m?.thinking).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
  }
  // The retained sub-4.6 id (haiku) keeps the older 200k/64k shape.
  expect(findCatalogModel("claude-haiku-4-5")?.contextTokens).toBe(200_000);
});

test("inferCatalogMetadata: fable/mythos + single-digit 5th-gen ids infer Anthropic thinking", () => {
  for (const id of ["claude-fable-6", "claude-mythos-6", "claude-sonnet-6"]) {
    const m = inferCatalogMetadata(id);
    expect(m?.provider).toBe("anthropic");
    expect(m?.thinking.length).toBeGreaterThan(0);
    expect(m?.contextTokens).toBe(1_000_000);
    expect(m?.maxOutputTokens).toBe(128_000);
  }
});