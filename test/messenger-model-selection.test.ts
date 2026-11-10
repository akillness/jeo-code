import { test, expect } from "bun:test";
import { selectDiscordModel } from "../src/messenger/model-selection";
import type { ProviderModelsResult } from "../src/ai/model-discovery";
import { parseModelsBody } from "../src/ai/model-discovery";
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

test("Discord accepts only models discovered at the configured keyless OpenAI endpoint", async () => {
  const cfg = { ...config("gpt-local"), openaiBaseUrl: "https://proxy.example/v1" };
  const list = async (provider: ProviderModelsResult["provider"]) => ({ provider, models: ["gpt-local"], ok: true, source: "keyless" as const, baseUrl: "https://proxy.example/v1" });
  expect(await selectDiscordModel("gpt-local", { config: cfg, list })).toBe("gpt-local");
  await expect(selectDiscordModel("gpt-missing", { config: cfg, list })).rejects.toThrow();
});

test("Discord discovers local models at each configured host", async () => {
  const previousFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response(JSON.stringify(String(input).includes("ollama")
      ? { models: [{ name: "local-ollama" }] }
      : { data: [{ id: "local-studio" }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const cfg = { ...config("gpt-5"), ollamaBaseUrl: "https://ollama.example", lmstudioBaseUrl: "https://studio.example/v1" };
    expect(await selectDiscordModel("ollama/local-ollama", { config: cfg })).toBe("ollama/local-ollama");
    expect(await selectDiscordModel("lmstudio/local-studio", { config: cfg })).toBe("lmstudio/local-studio");
    expect(requests).toEqual(["https://ollama.example/api/tags", "https://studio.example/v1/models"]);
  } finally {
    globalThis.fetch = previousFetch;
  }
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

test("Discord ranks versions before snapshot dates and excludes automatic variants", async () => {
  for (const [model, candidates, expected] of [
    ["gpt-5", ["gpt-5-terra-2026-01-01", "gpt-5.5-terra", "gpt-9-terra-mini", "gpt-9-terra-codex"], "gpt-5.5-terra"],
    ["gpt-5", ["gpt-5-terra-20260101", "gpt-5.5-terra"], "gpt-5.5-terra"],
    ["claude-sonnet-4-6", ["claude-sonnet-4-20260101", "claude-sonnet-4-5", "claude-sonnet-9-thinking"], "claude-sonnet-4-5"],
    ["antigravity/gemini-3-flash", ["antigravity/gemini-3-flash", "antigravity/gemini-9-flash-lite"], "antigravity/gemini-3-flash"],
  ] as const) {
    for (const models of [candidates, [...candidates].reverse()]) {
      const list = async (provider: ProviderModelsResult["provider"]) => ({ provider, models: [...models], displayNames: Object.fromEntries(models.map(id => [id, id])), ok: true, source: "oauth" as const });
      expect(await selectDiscordModel(undefined, { config: config(model), list })).toBe(expected);
    }
  }
});

test("Discord does not rank OpenAI snapshot suffixes as model versions", async () => {
  for (const older of ["gpt-5-terra-0409", "gpt-5-terra-2026-01", "gpt-5-terra-preview-0409"]) {
    for (const models of [[older, "gpt-5.5-terra"], ["gpt-5.5-terra", older]]) {
      const list = async (provider: ProviderModelsResult["provider"]) => ({ provider, models, ok: true, source: "oauth" as const });
      await expect(selectDiscordModel(undefined, { config: config("gpt-5"), list })).rejects.toThrow(/explicit model/i);
    }
  }
});

test("Discord fails closed when same-version Antigravity tier preference is ambiguous", async () => {
  for (const [first, second] of [["High", ""], ["Medium", ""], ["Low", ""]]) {
    for (const reverse of [false, true]) {
      const models = ["antigravity/gemini-3-flash-a", "antigravity/gemini-3-flash-b"];
      if (reverse) models.reverse();
      const list = async (provider: ProviderModelsResult["provider"]) => ({
        provider, models, ok: true, source: "oauth" as const,
        displayNames: { "antigravity/gemini-3-flash-a": `Gemini 3 Flash (${first})`, "antigravity/gemini-3-flash-b": `Gemini 3 Flash${second ? ` (${second})` : ""}` },
      });
      await expect(selectDiscordModel(undefined, { config: config("antigravity/gemini-3-flash"), list })).rejects.toThrow(/explicit model/i);
    }
  }
});

test("Discord ranks explicit Antigravity High, Medium and Low tiers", async () => {
  for (const [first, second] of [["High", "Medium"], ["High", "Low"], ["Medium", "Low"]]) {
    const models = ["antigravity/gemini-3-flash-a", "antigravity/gemini-3-flash-b"];
    for (const candidates of [models, [...models].reverse()]) {
      const list = async (provider: ProviderModelsResult["provider"]) => ({
        provider, models: candidates, ok: true, source: "oauth" as const,
        displayNames: { "antigravity/gemini-3-flash-a": `Gemini 3 Flash (${first})`, "antigravity/gemini-3-flash-b": `Gemini 3 Flash (${second})` },
      });
      expect(await selectDiscordModel(undefined, { config: config("antigravity/gemini-3-flash"), list })).toBe("antigravity/gemini-3-flash-a");
    }
  }
});

test("Antigravity refuses to rank a tiered Flash candidate without a display name", async () => {
  for (const reverse of [false, true]) {
    const entries = [
      ["gemini-3-flash", { displayName: "Gemini 3 Flash (High)" }],
      ["gemini-3-flash-agent", {}],
    ] as const;
    const body = {
      models: Object.fromEntries(reverse ? [...entries].reverse() : entries),
      tieredModelIds: { standard: ["gemini-3-flash", "gemini-3-flash-agent"] },
    };
    const list = async (provider: ProviderModelsResult["provider"]) => ({
      provider, ok: true, source: "oauth" as const,
      models: parseModelsBody(provider, body),
      displayNames: { "antigravity/gemini-3-flash": "Gemini 3 Flash (High)" },
    });
    await expect(selectDiscordModel(undefined, { config: config("antigravity/gemini-3-flash"), list })).rejects.toThrow("live catalog is missing display names; configure an explicit model from the live catalog");
    expect(await selectDiscordModel("antigravity/gemini-3-flash", { config: config("antigravity/gemini-3-flash"), list })).toBe("antigravity/gemini-3-flash");
  }
});
