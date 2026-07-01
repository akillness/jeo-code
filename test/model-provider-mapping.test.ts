import { beforeAll, afterAll } from "bun:test";
import { createModelManager } from "../src/ai/model-manager";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { test, expect } from "bun:test";
import { MODEL_CATALOG, findCatalogModel } from "../src/ai/model-catalog";
import { providerModelFor, resolveProvider } from "../src/ai/model-manager";
import { expandAlias } from "../src/ai/model-registry";

test("catalog keeps haiku + the 4.6-generation entries and drops sub-4.6 Anthropic ids", () => {
  const haiku45 = findCatalogModel("claude-haiku-4-5");
  expect(haiku45).toBeDefined();
  expect(haiku45!.providerModel).toBe("claude-haiku-4-5-20251001");
  expect(haiku45!.provider).toBe("anthropic");
  expect(haiku45!.contextTokens).toBe(200_000);
  expect(haiku45!.maxOutputTokens).toBe(64_000);
  expect(haiku45!.thinking).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
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
  expect(resolveProvider("antigravity/gemini-3-pro-low")).toBe("antigravity");
  expect(resolveProvider("antigravity/claude-sonnet-4-5")).toBe("antigravity");
  expect(providerModelFor("antigravity/gemini-3-pro-low")).toBe("antigravity/gemini-3-pro-low");
  expect(findCatalogModel("antigravity/gemini-3-pro-low")?.provider).toBe("antigravity");
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
      "OpenAI OAuth 자격증명은 Codex 모델(gpt-5.5/gpt-5.4)만 지원. OPENAI_API_KEY를 설정하거나 모델을 변경하세요"
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
