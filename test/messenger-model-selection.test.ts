import { test, expect } from "bun:test";
import { selectDiscordModel } from "../src/messenger/model-selection";
import type { ProviderModelsResult } from "../src/ai/model-discovery";
import type { Config } from "../src/agent/state";

const config = (defaultModel: string): Config => ({ providers: {}, defaultModel, thinkingLevel: "medium" });

test("Discord selects newest live model in provider family by numeric version", async () => {
  for (const [model, provider, candidates, expected] of [
    ["claude-sonnet-4-6", "anthropic", ["claude-sonnet-4-9", "claude-sonnet-4-10", "claude-opus-9"], "claude-sonnet-4-10"],
    ["gpt-5", "openai", ["gpt-6.9-terra", "gpt-6.10-terra", "gpt-9-other"], "gpt-6.10-terra"],
    ["antigravity/gemini-3-flash", "antigravity", ["antigravity/gemini-3-flash", "antigravity/gemini-10-flash"], "antigravity/gemini-10-flash"],
  ] as const) {
    const seen: string[] = [];
    const list = async (actual: ProviderModelsResult["provider"]) => { seen.push(actual); return { provider: actual, models: [...candidates], displayNames: Object.fromEntries(candidates.map(id => [id, id])), ok: true, source: "oauth" as const }; };
    expect(await selectDiscordModel(undefined, { config: config(model), list })).toBe(expected);
    expect(seen).toEqual([provider]);
  }
});

test("Discord ranks Sonnet versions before snapshot dates regardless of catalog order", async () => {
  for (const [candidates, expected] of [
    [["claude-sonnet-4-20250514", "claude-sonnet-4-5"], "claude-sonnet-4-5"],
    [["claude-sonnet-4-5-20250929", "claude-sonnet-4-6"], "claude-sonnet-4-6"],
    [["claude-sonnet-4-5-20250929", "claude-sonnet-4-5-7"], "claude-sonnet-4-5-7"],
    [["claude-sonnet-4-5-1234567", "claude-sonnet-4-5-1234568"], "claude-sonnet-4-5-1234568"],
    [["claude-3-5-sonnet-20241022", "claude-sonnet-4-6"], "claude-sonnet-4-6"],
    [["claude-sonnet-4-5-20250101", "claude-sonnet-4-5-20250929"], "claude-sonnet-4-5-20250929"],
    [["claude-sonnet-4-5", "claude-sonnet-4-5-20250929"], "claude-sonnet-4-5-20250929"],
  ] as const) {
    for (const models of [candidates, [...candidates].reverse()]) {
      const list = async (provider: ProviderModelsResult["provider"]) => ({ provider, models: [...models], ok: true, source: "oauth" as const });
      expect(await selectDiscordModel(undefined, { config: config("claude-sonnet-4-6"), list })).toBe(expected);
    }
  }
});

test("Discord rejects ambiguous Sonnet versions instead of guessing by catalog order", async () => {
  for (const candidates of [
    ["claude-sonnet-4-5", "claude-sonnet-4-5-0"],
    ["claude-sonnet-4-5-20250929", "claude-sonnet-4-5-0-20250929"],
    ["claude-sonnet-latest", "claude-sonnet-4-5"],
  ]) {
    for (const models of [candidates, [...candidates].reverse()]) {
      const list = async (provider: ProviderModelsResult["provider"]) => ({ provider, models, ok: true, source: "oauth" as const });
      await expect(selectDiscordModel(undefined, { config: config("claude-sonnet-4-6"), list })).rejects.toThrow();
    }
  }
});

test("explicit Discord model must be present in authenticated live list", async () => {
  const list = async (provider: ProviderModelsResult["provider"]) => ({ provider, models: ["gpt-6-terra"], ok: true, source: "oauth" as const });
  expect(await selectDiscordModel("gpt-6-terra", { config: config("gpt-5"), list })).toBe("gpt-6-terra");
  await expect(selectDiscordModel("gpt-7-terra", { config: config("gpt-5"), list })).rejects.toThrow();
});

test("Discord rejects failed, fallback, empty or family-missing discovery", async () => {
  for (const variant of [
    { ok: false, models: ["gpt-6-terra"], source: "oauth" as const },
    { ok: true, models: ["gpt-6-terra"], source: "oauth" as const, fallback: true },
    { ok: true, models: [], source: "oauth" as const },
    { ok: true, models: ["gpt-6-other"], source: "oauth" as const },
    { ok: true, models: ["gpt-6-terra"], source: "keyless" as const },
  ]) {
    const list = async (provider: ProviderModelsResult["provider"]) => ({ provider, ...variant });
    await expect(selectDiscordModel(undefined, { config: config("gpt-5"), list })).rejects.toThrow();
  }
});

test("mixed OAuth and API key discovery matches the credential used at runtime", async () => {
  const mixed = { ...config("claude-sonnet-4-6"), providers: { anthropic: "api-key" } };
  const credential = async () => ({ kind: "oauth" as const, provider: "anthropic" as const, token: "oauth-token" });
  let preferOAuth: boolean | undefined;
  const oauthList = async (provider: ProviderModelsResult["provider"], options?: { preferOAuth?: boolean }) => {
    preferOAuth = options?.preferOAuth;
    return { provider, models: ["claude-sonnet-4-6"], ok: true, source: "oauth" as const };
  };
  expect(await selectDiscordModel(undefined, { config: mixed, credential, list: oauthList })).toBe("claude-sonnet-4-6");
  expect(preferOAuth).toBe(true);
  const apiList = async (provider: ProviderModelsResult["provider"]) => ({ provider, models: ["claude-sonnet-4-6"], ok: true, source: "api_key" as const });
  await expect(selectDiscordModel(undefined, { config: mixed, credential, list: apiList })).rejects.toThrow("credential");
});

test("Antigravity ranks callable aliases using live display version", async () => {
  const list = async (provider: ProviderModelsResult["provider"]) => ({
    provider, ok: true, source: "oauth" as const,
    models: ["antigravity/gemini-3-flash-agent", "antigravity/gemini-3-flash"],
    displayNames: { "antigravity/gemini-3-flash-agent": "Gemini 3.5 Flash (High)", "antigravity/gemini-3-flash": "Gemini 3 Flash" },
  });
  expect(await selectDiscordModel(undefined, { config: config("antigravity/gemini-3-flash"), list })).toBe("antigravity/gemini-3-flash-agent");
});

test("explicit local model accepts a matching keyless live catalog", async () => {
  const list = async (provider: ProviderModelsResult["provider"]) => ({ provider, models: ["ollama/llama3"], ok: true, source: "keyless" as const });
  expect(await selectDiscordModel("ollama/llama3", { config: config("gpt-5"), list })).toBe("ollama/llama3");
  await expect(selectDiscordModel("ollama/missing", { config: config("gpt-5"), list })).rejects.toThrow();
});

test("Discord resolves user aliases before provider routing and validates explicit aliases live", async () => {
  const cfg = { ...config("my-fast"), modelAliases: { "my-fast": "gpt-6.1-terra", missing: "gpt-7-terra" } };
  const seen: string[] = [];
  const list = async (provider: ProviderModelsResult["provider"]) => { seen.push(provider); return { provider, ok: true, source: "oauth" as const, models: ["gpt-6.1-terra"] }; };
  expect(await selectDiscordModel(undefined, { config: cfg, list })).toBe("gpt-6.1-terra");
  expect(await selectDiscordModel("my-fast", { config: cfg, list })).toBe("gpt-6.1-terra");
  await expect(selectDiscordModel("missing", { config: cfg, list })).rejects.toThrow();
  expect(seen).toEqual(["openai", "openai", "openai"]);
});

test("Discord expands built-in alias and rejects it when absent from live catalog", async () => {
  const seen: string[] = [];
  const list = async (provider: ProviderModelsResult["provider"]) => { seen.push(provider); return { provider, ok: true, source: "oauth" as const, models: ["claude-sonnet-4-6"] }; };
  await expect(selectDiscordModel("sonnet", { config: config("gpt-5"), list })).rejects.toThrow();
  expect(seen).toEqual(["anthropic"]);
});
