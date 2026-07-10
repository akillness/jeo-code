import { beforeAll, afterAll } from "bun:test";
import { createModelManager } from "../src/ai/model-manager";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { test, expect } from "bun:test";
import { MODEL_CATALOG, findCatalogModel, recordLiveProviderModels, resetLiveProviderModels } from "../src/ai/model-catalog";
import { providerModelFor, resolveProvider } from "../src/ai/model-manager";
import { expandAlias } from "../src/ai/model-registry";

test("catalog keeps haiku + the 4.6-generation entries and drops sub-4.6 Anthropic ids", () => {
  const haiku45 = findCatalogModel("claude-haiku-4-5");
  expect(haiku45).toBeDefined();
  expect(haiku45!.providerModel).toBe("claude-haiku-4-5-20251001");
  expect(haiku45!.provider).toBe("anthropic");
  expect(haiku45!.contextTokens).toBe(200_000);
  expect(haiku45!.maxOutputTokens).toBe(64_000);
  expect(haiku45!.thinking).toEqual(["low", "medium", "high", "xhigh"]);
  expect(haiku45!.images).toBe(true);

  const sonnet46 = findCatalogModel("claude-sonnet-4-6");
  expect(sonnet46).toBeDefined();
  expect(sonnet46!.contextTokens).toBe(1_000_000);
  expect(sonnet46!.maxOutputTokens).toBe(128_000);

  const opus46 = findCatalogModel("claude-opus-4-6");
  expect(opus46).toBeDefined();
  expect(opus46!.contextTokens).toBe(1_000_000);

  // sub-4.6 Anthropic ids (except haiku) are no longer curated in the catalog.
  expect(findCatalogModel("claude-3-5-sonnet")).toBeUndefined();
  expect(findCatalogModel("claude-sonnet-4-5")).toBeUndefined();
  expect(findCatalogModel("claude-opus-4-1")).toBeUndefined();
  expect(findCatalogModel("claude-opus-4-5")).toBeUndefined();
});

test("providerModelFor maps correctly", () => {
  expect(providerModelFor("claude-haiku-4-5")).toBe("claude-haiku-4-5-20251001");
  expect(providerModelFor("claude-opus-4-6")).toBe("claude-opus-4-6");
  expect(providerModelFor("ollama/qwen2.5:0.5b")).toBe("ollama/qwen2.5:0.5b");
  expect(providerModelFor("unknown-model-id-123")).toBe("unknown-model-id-123");
});

test("Antigravity models stay provider-qualified and route to the Antigravity adapter", () => {
  expect(resolveProvider("antigravity/gemini-3.1-pro-low")).toBe("antigravity");
  expect(resolveProvider("antigravity/claude-sonnet-4-5")).toBe("antigravity");
  expect(providerModelFor("antigravity/gemini-3.1-pro-low")).toBe("antigravity/gemini-3.1-pro-low");
  expect(findCatalogModel("antigravity/gemini-3.1-pro-low")?.provider).toBe("antigravity");
});

// --- resolveProvider must consult the live-discovered-model index (v0.9.x fix):
// substring heuristics (grok->xai, kimi/moonshot->kimi, gpt/o\d->openai, gemini->gemini)
// only recognize TODAY's brand-carrying ids. A live-discovered row from
// `recordLiveProviderModels` already carries the CORRECT `.provider` tag set by the
// caller at discovery time — that must win over the lossy heuristic fallthrough
// (which otherwise silently defaults an unrecognized id to "anthropic"). Closes the
// gap for xAI/Kimi/Gemini future renames AND brand-neutral aggregator ids (Groq,
// OpenRouter, Together, …) that never match any brand substring at all. ---

test("resolveProvider: a live-discovered model with no recognizable brand substring resolves via the live catalog, not the anthropic fallthrough", () => {
  resetLiveProviderModels();
  try {
    recordLiveProviderModels("xai", ["aurora-2"], { source: "api_key" });
    expect(resolveProvider("aurora-2")).toBe("xai");
  } finally {
    resetLiveProviderModels();
  }
});

// `groq` (and every other OpenAI-compatible aggregator provider — deepseek, mistral,
// openrouter, together, …) is deliberately NOT used for this second case: model-catalog's
// `liveCanonicalId` auto-prefixes EVERY OpenAI-compatible provider's bare id with
// `${provider}/` at record time (`recordLiveProviderModels("groq", ["x"])` actually
// stores canonical `"groq/x"`), so `resolveProvider("groq/x")` already resolves
// correctly via the PRE-EXISTING `OPENAI_COMPAT_NAMES` prefix loop — that path was never
// broken and wouldn't exercise this fix. `kimi` (like `xai`) is one of the few providers
// `liveCanonicalId` leaves BARE (see model-catalog.ts's `liveCanonicalId`), so a
// brand-neutral live-discovered `kimi` id reproduces the exact same landmine class the
// problem statement describes for a future/third-party provider whose ids stay bare.
test("resolveProvider: a brand-neutral live-discovered id from a provider with no brand substring resolves to ITS provider, not anthropic", () => {
  resetLiveProviderModels();
  try {
    recordLiveProviderModels("kimi", ["nova-flash-x1"], { source: "api_key" });
    expect(resolveProvider("nova-flash-x1")).toBe("kimi");
  } finally {
    resetLiveProviderModels();
  }
});

test("resolveProvider: static catalog + substring heuristics still win when no live row shadows them (regression guard)", () => {
  resetLiveProviderModels();
  // Static catalog entry — unaffected by the live-catalog check (it returns before
  // findLiveCatalogModel is ever consulted).
  expect(resolveProvider("claude-sonnet-4-6")).toBe("anthropic");
  // Uncatalogued + never live-discovered — falls through to the substring heuristics
  // exactly as before.
  expect(resolveProvider("grok-99-nonexistent")).toBe("xai");
  expect(resolveProvider("totally-unknown-id")).toBe("anthropic");
});

test("alias sonnet/opus resolve to the 4.6 generation", () => {
  expect(expandAlias("sonnet")).toBe("claude-sonnet-4-6");
  expect(expandAlias("haiku")).toBe("claude-haiku-4-5");
  expect(expandAlias("opus")).toBe("claude-opus-4-6");
});

test("OpenAI OAuth-only + non-Codex model fails fast", async () => {
  const originalConfigDir = process.env.JEO_CONFIG_DIR;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalOpenAiToken = process.env.OPENAI_OAUTH_TOKEN;
  const originalDefaultModel = process.env.JEO_DEFAULT_MODEL;
  const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL;
  
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_OAUTH_TOKEN;
  delete process.env.JEO_DEFAULT_MODEL;
  delete process.env.OPENAI_BASE_URL;

  const tempConfigDir = path.join(os.tmpdir(), `jeo-test-config-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(tempConfigDir, { recursive: true });
  process.env.JEO_CONFIG_DIR = tempConfigDir;

  const config = {
    defaultModel: "gpt-4o",
    oauth: {
      openai: "mock-oauth-token"
    },
    providers: {}
  };
  await fs.writeFile(path.join(tempConfigDir, "config.json"), JSON.stringify(config));

  try {
    const manager = createModelManager();
    await expect(manager.call([{ role: "user", content: "hello" }])).rejects.toThrow(
      "OpenAI OAuth 자격증명은 Codex 모델(gpt-5.5/gpt-5.4/gpt-5.4-mini)만 지원. OPENAI_API_KEY를 설정하거나 모델을 변경하세요"
    );
  } finally {
    if (originalConfigDir) {
      process.env.JEO_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.JEO_CONFIG_DIR;
    }
    if (originalOpenAiApiKey) process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    if (originalOpenAiToken) process.env.OPENAI_OAUTH_TOKEN = originalOpenAiToken;
    if (originalDefaultModel) process.env.JEO_DEFAULT_MODEL = originalDefaultModel;
    else delete process.env.JEO_DEFAULT_MODEL;
    if (originalOpenAiBaseUrl) process.env.OPENAI_BASE_URL = originalOpenAiBaseUrl;
    else delete process.env.OPENAI_BASE_URL;
    await fs.rm(tempConfigDir, { recursive: true, force: true });
  }
});

test("OpenAI OAuth-only + non-Codex model does NOT fail fast when base URL is configured", async () => {
  const originalConfigDir = process.env.JEO_CONFIG_DIR;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalOpenAiToken = process.env.OPENAI_OAUTH_TOKEN;
  const originalDefaultModel = process.env.JEO_DEFAULT_MODEL;
  const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL;

  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_OAUTH_TOKEN;
  delete process.env.JEO_DEFAULT_MODEL;
  delete process.env.OPENAI_BASE_URL;

  const tempConfigDir = path.join(os.tmpdir(), `jeo-test-config-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(tempConfigDir, { recursive: true });
  process.env.JEO_CONFIG_DIR = tempConfigDir;

  const config = {
    defaultModel: "gpt-4o",
    oauth: {
      openai: "mock-oauth-token"
    },
    openaiBaseUrl: "http://127.0.0.1:9999",
    providers: {}
  };
  await fs.writeFile(path.join(tempConfigDir, "config.json"), JSON.stringify(config));

  try {
    const manager = createModelManager();
    await manager.call([{ role: "user", content: "hello" }]);
    expect(true).toBe(false); // should not reach here
  } catch (err: any) {
    expect(err.message).not.toContain("OpenAI OAuth 자격증명은 Codex 모델");
  } finally {
    if (originalConfigDir) {
      process.env.JEO_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.JEO_CONFIG_DIR;
    }
    if (originalOpenAiApiKey) process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    if (originalOpenAiToken) process.env.OPENAI_OAUTH_TOKEN = originalOpenAiToken;
    if (originalDefaultModel) process.env.JEO_DEFAULT_MODEL = originalDefaultModel;
    else delete process.env.JEO_DEFAULT_MODEL;
    if (originalOpenAiBaseUrl) process.env.OPENAI_BASE_URL = originalOpenAiBaseUrl;
    else delete process.env.OPENAI_BASE_URL;
    await fs.rm(tempConfigDir, { recursive: true, force: true });
  }
});

// --- ConnectionContextError integration (v0.9.0): model-manager's call()/stream()
// wrap a raw pre-response connection failure with provider + baseUrl context so
// friendlyProviderError can turn Bun's bare "Unable to connect. Is the computer
// able to access the url?" into an actionable message naming what was unreachable. ---

async function withTempConfig<T>(config: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const originalConfigDir = process.env.JEO_CONFIG_DIR;
  const tempConfigDir = path.join(os.tmpdir(), `jeo-test-config-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(tempConfigDir, { recursive: true });
  process.env.JEO_CONFIG_DIR = tempConfigDir;
  await fs.writeFile(path.join(tempConfigDir, "config.json"), JSON.stringify(config));
  try {
    return await run();
  } finally {
    if (originalConfigDir) process.env.JEO_CONFIG_DIR = originalConfigDir;
    else delete process.env.JEO_CONFIG_DIR;
    await fs.rm(tempConfigDir, { recursive: true, force: true });
  }
}

test("model-manager.call: a raw connection failure to ollama is re-thrown as ConnectionContextError naming the provider + base URL", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" });
  }) as unknown as typeof fetch;
  try {
    await withTempConfig(
      { defaultModel: "ollama/llama3.1", ollamaBaseUrl: "http://localhost:11434", retry: { requestMaxRetries: 0 } },
      async () => {
        const manager = createModelManager();
        let caught: unknown;
        try {
          await manager.call([{ role: "user", content: "hi" }]);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeDefined();
        expect((caught as { name?: string }).name).toBe("ConnectionContextError");
        expect((caught as { provider?: string }).provider).toBe("ollama");
        expect((caught as { baseUrl?: string }).baseUrl).toBe("http://localhost:11434");
      },
    );
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("model-manager.stream: a raw connection failure to lmstudio is re-thrown as ConnectionContextError naming the provider + base URL", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" });
  }) as unknown as typeof fetch;
  try {
    await withTempConfig(
      { defaultModel: "lmstudio/qwen2.5-coder", lmstudioBaseUrl: "http://localhost:1234/v1", retry: { streamMaxRetries: 0 } },
      async () => {
        const manager = createModelManager();
        let caught: unknown;
        try {
          for await (const _chunk of manager.stream([{ role: "user", content: "hi" }])) { /* drain */ }
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeDefined();
        expect((caught as { name?: string }).name).toBe("ConnectionContextError");
        expect((caught as { provider?: string }).provider).toBe("lmstudio");
        expect((caught as { baseUrl?: string }).baseUrl).toBe("http://localhost:1234/v1");
      },
    );
  } finally {
    globalThis.fetch = prevFetch;
  }
});
