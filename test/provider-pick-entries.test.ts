import { test, expect } from "bun:test";
import { providerPickEntries } from "../src/commands/launch";
import type { ProviderModelsResult } from "../src/ai";
import { catalogByProvider } from "../src/ai";

test("providerPickEntries returns live ids when the provider has live models", () => {
  const live: ProviderModelsResult[] = [
    { provider: "anthropic", models: ["claude-opus-4-6", "claude-sonnet-4-5-20250929"], ok: true, source: "oauth" },
    { provider: "openai", models: ["gpt-5.5"], ok: true, source: "api_key" },
  ];
  const entries = providerPickEntries(live, "anthropic");
  expect(entries.map(e => e.model)).toEqual(["claude-opus-4-6", "claude-sonnet-4-5-20250929"]);
  expect(entries.every(e => e.provider === "anthropic")).toBe(true);
});

test("providerPickEntries falls back to the static catalog when live discovery is empty", () => {
  // The reported bug: a provider that is not logged in (source: none) yields no
  // live models, so the per-role provider picker showed an EMPTY list. The
  // catalog fallback must surface that provider's known models instead.
  const live: ProviderModelsResult[] = [
    { provider: "openai", models: [], ok: false, source: "none", error: "not logged in" },
  ];
  const entries = providerPickEntries(live, "openai");
  expect(entries.length).toBe(catalogByProvider("openai").length);
  expect(entries.length).toBeGreaterThan(0);
  // Every entry is openai-qualified and 1-based indexed.
  expect(entries.every(e => e.provider === "openai")).toBe(true);
  expect(entries[0]!.index).toBe(1);
});

test("providerPickEntries falls back when a DIFFERENT provider is the only live one", () => {
  // gemini is live, but the user pins a role to anthropic — anthropic has no live
  // entry, so its catalog must back the list.
  const live: ProviderModelsResult[] = [
    { provider: "gemini", models: ["gemini-3-pro"], ok: true, source: "api_key" },
  ];
  const entries = providerPickEntries(live, "anthropic");
  expect(entries.length).toBe(catalogByProvider("anthropic").length);
  expect(entries.every(e => e.provider === "anthropic")).toBe(true);
});

test("providerPickEntries falls back to the provider's default model when neither live nor catalog has it", () => {
  // lmstudio carries no capability-catalog entries, but it still has a known
  // default model — the list must surface that single id rather than be empty,
  // so the role picker never silently pins a bare default with nothing shown.
  const live: ProviderModelsResult[] = [
    { provider: "lmstudio", models: [], ok: false, source: "keyless", error: "unreachable" },
  ];
  const entries = providerPickEntries(live, "lmstudio");
  expect(catalogByProvider("lmstudio").length).toBe(0);
  expect(entries.length).toBe(1);
  expect(entries[0]!.provider).toBe("lmstudio");
  expect(entries[0]!.index).toBe(1);
});

test("providerPickEntries surfaces the default model for an unauthenticated OpenAI-compat provider", () => {
  // The reported bug in the field: API-key providers like groq/deepseek/openrouter
  // have no capability-catalog rows, so before the default-model rung their role
  // picker showed an empty list. Each must now surface its one known default id.
  for (const want of ["groq", "deepseek", "openrouter"] as const) {
    const entries = providerPickEntries([], want);
    expect(catalogByProvider(want).length).toBe(0);
    expect(entries.length).toBe(1);
    expect(entries[0]!.provider).toBe(want);
    expect(entries[0]!.model.startsWith(`${want}/`)).toBe(true);
  }
});
