import { test, expect } from "bun:test";
import {
  PROVIDER_PRESETS,
  PROVIDER_PRESET_IDS,
  expandProviderPreset,
  findProviderPreset,
  formatProviderPresetList,
} from "../src/ai/providers/provider-presets";
import { toCustomProviderDef } from "../src/ai/providers/custom-providers";
import {
  FAMOUS_PROVIDER_ORDER,
  PROVIDER_RANK_TIER,
  authStateFor,
  compareRankedProviders,
  famousProviderIndex,
  providerRankTier,
  sortRankedProviders,
  type RankableProvider,
} from "../src/ai/provider-ranking";

// ---------------------------------------------------------------------------
// presets
// ---------------------------------------------------------------------------

test("every preset is internally consistent and expands into a valid provider def", () => {
  expect(PROVIDER_PRESETS.length).toBeGreaterThan(0);
  const ids = new Set<string>();
  for (const preset of PROVIDER_PRESETS) {
    // No duplicate ids or aliases across the whole table — the lookup map is flat.
    expect(ids.has(preset.id)).toBe(false);
    ids.add(preset.id);
    for (const alias of preset.aliases) {
      expect(ids.has(alias)).toBe(false);
      ids.add(alias);
    }
    // A preset either pins a base URL or declares itself parameterized. Never neither.
    expect(Boolean(preset.baseUrl) !== Boolean(preset.parameterized)).toBe(true);
    expect(preset.apiKeyEnv).toMatch(/^[A-Z][A-Z0-9_]*$/);

    // The expansion must survive the same validation a hand-typed provider goes through.
    const expanded = expandProviderPreset({
      preset: preset.id,
      baseUrl: preset.parameterized ? "https://gw.example.com/v1" : undefined,
    });
    const def = toCustomProviderDef(expanded.id, expanded.config);
    expect(def.protocol).toBe(preset.protocol);
    expect(def.preset).toBe(preset.id);
  }
});

test("presets resolve by id and by every declared alias, case-insensitively", () => {
  expect(findProviderPreset("litellm")?.id).toBe("litellm");
  expect(findProviderPreset("LiteLLM-Proxy")?.id).toBe("litellm");
  expect(findProviderPreset("  proxy ")?.id).toBe("openai-compatible-proxy");
  expect(findProviderPreset("nope")).toBeUndefined();
  expect(findProviderPreset(undefined)).toBeUndefined();
  expect(PROVIDER_PRESET_IDS).toContain("vllm");
});

test("a parameterized preset demands --base-url; a fixed preset refuses one", () => {
  expect(() => expandProviderPreset({ preset: "litellm" })).toThrow(/--base-url/);

  const ok = expandProviderPreset({ preset: "litellm", baseUrl: "http://localhost:4000/v1" });
  expect(ok.id).toBe("litellm-proxy");
  expect(ok.config.baseUrl).toBe("http://localhost:4000/v1");
  expect(ok.config.apiKeyEnv).toBe("LITELLM_API_KEY");

  expect(() => expandProviderPreset({ preset: "glm", baseUrl: "https://elsewhere.example.com/v1" })).toThrow(/pins/);
  // Passing the preset's OWN url is tolerated (idempotent re-run of a saved command).
  const same = expandProviderPreset({ preset: "glm", baseUrl: "https://api.z.ai/api/paas/v4" });
  expect(same.config.baseUrl).toBe("https://api.z.ai/api/paas/v4");
});

test("an unknown preset lists the available ones instead of failing silently", () => {
  expect(() => expandProviderPreset({ preset: "made-up" })).toThrow(/Unknown provider preset/);
  try {
    expandProviderPreset({ preset: "made-up" });
  } catch (err) {
    expect((err as Error).message).toContain("litellm");
  }
  expect(formatProviderPresetList().join("\n")).toContain("[needs --base-url]");
});

test("caller overrides win over preset defaults", () => {
  const expanded = expandProviderPreset({
    preset: "vllm",
    id: "gpu-box",
    baseUrl: "http://10.0.0.5:8000/v1",
    apiKeyEnv: "GPU_BOX_TOKEN",
    models: ["qwen3-coder", "llama-3.3-70b"],
  });
  expect(expanded.id).toBe("gpu-box");
  expect(expanded.config.apiKeyEnv).toBe("GPU_BOX_TOKEN");
  expect(expanded.config.models).toEqual(["qwen3-coder", "llama-3.3-70b"]);
  expect(expanded.config.defaultModel).toBe("qwen3-coder");
});

test("an anthropic-protocol preset produces an anthropic-protocol provider", () => {
  const expanded = expandProviderPreset({
    preset: "anthropic-compatible-proxy",
    baseUrl: "https://claude.corp.internal",
  });
  expect(expanded.config.protocol).toBe("anthropic");
  expect(toCustomProviderDef(expanded.id, expanded.config).protocol).toBe("anthropic");
});

// ---------------------------------------------------------------------------
// ranking
// ---------------------------------------------------------------------------

const p = (id: string, authState: RankableProvider["authState"], custom?: boolean): RankableProvider => ({
  id,
  label: id,
  authState,
  custom,
});

test("providers you can actually use rank above famous-but-unconfigured ones", () => {
  expect(providerRankTier("valid", "groq")).toBe(PROVIDER_RANK_TIER.existing);
  expect(providerRankTier("checking", "groq")).toBe(PROVIDER_RANK_TIER.existing);
  expect(providerRankTier("configured", "some-proxy")).toBe(PROVIDER_RANK_TIER.existing);
  expect(providerRankTier("invalid", "anthropic")).toBe(PROVIDER_RANK_TIER.problematic);
  expect(providerRankTier("none", "anthropic")).toBe(PROVIDER_RANK_TIER.famous);
  expect(providerRankTier("none", "who-dis")).toBe(PROVIDER_RANK_TIER.other);
  // A user-registered custom provider outranks a cloud they never mentioned.
  expect(providerRankTier("none", "my-proxy", true)).toBe(PROVIDER_RANK_TIER.famous);
});

test("a broken login sorts above untouched providers so it gets fixed first", () => {
  const sorted = sortRankedProviders([
    p("zenmux", "none"),
    p("anthropic", "invalid"),
    p("groq", "valid"),
  ]).map(x => x.id);
  expect(sorted).toEqual(["groq", "anthropic", "zenmux"]);
});

test("the famous tier follows the curated order, not the alphabet", () => {
  const sorted = sortRankedProviders([
    p("zai", "none"),
    p("anthropic", "none"),
    p("openai", "none"),
  ]).map(x => x.id);
  expect(sorted).toEqual(["anthropic", "openai", "zai"]);
  expect(famousProviderIndex("anthropic")).toBeLessThan(famousProviderIndex("openai")!);
  expect(famousProviderIndex("not-listed")).toBeUndefined();
});

test("unknown providers fall to the end, ordered by label then id (total order, no ties)", () => {
  const sorted = sortRankedProviders([
    { id: "b-corp", label: "Beta", authState: "none" },
    { id: "a-corp", label: "Alpha", authState: "none" },
    { id: "c-corp", label: "Alpha", authState: "none" },
  ]).map(x => x.id);
  expect(sorted).toEqual(["a-corp", "c-corp", "b-corp"]);
  // The comparator is antisymmetric for distinct inputs.
  const left = p("a", "none");
  const right = p("b", "none");
  expect(Math.sign(compareRankedProviders(left, right))).toBe(-Math.sign(compareRankedProviders(right, left)));
  expect(compareRankedProviders(left, left)).toBe(0);
});

test("sortRankedProviders never mutates its input", () => {
  const input = [p("zai", "none"), p("anthropic", "none")];
  const before = input.map(x => x.id);
  sortRankedProviders(input);
  expect(input.map(x => x.id)).toEqual(before);
});

test("authStateFor maps jeo's ProviderStatus vocabulary onto ranking tiers", () => {
  expect(authStateFor({ ready: true, kind: "oauth" })).toBe("valid");
  expect(authStateFor({ ready: true, kind: "api_key" })).toBe("configured");
  expect(authStateFor({ ready: true, kind: "keyless" })).toBe("configured");
  // A stored login that cannot serve a call needs attention more than an untouched one.
  expect(authStateFor({ ready: false, kind: "oauth", loggedIn: true })).toBe("invalid");
  expect(authStateFor({ ready: false, kind: "none" })).toBe("none");
});

test("the famous list has no duplicates (a dupe would make ordering non-deterministic)", () => {
  expect(new Set(FAMOUS_PROVIDER_ORDER).size).toBe(FAMOUS_PROVIDER_ORDER.length);
});
