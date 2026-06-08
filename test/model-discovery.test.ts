import { test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  discoveryRequest,
  parseModelsBody,
  listProviderModels,
  discoverModels,
  catalogOr,
} from "../src/ai/model-discovery";

let dir: string;
const prevCfgDir = process.env.JOC_CONFIG_DIR;
const prevOpenAiBase = process.env.OPENAI_BASE_URL;
const OAUTH_ENV = ["ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_OAUTH_TOKEN", "GEMINI_OAUTH_TOKEN"];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-disc-"));
  process.env.JOC_CONFIG_DIR = dir;
  delete process.env.OPENAI_BASE_URL;
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({
      providers: { anthropic: "sk-ant", openai: "sk-oai", gemini: "sk-gem" },
      defaultModel: "claude-3-5-sonnet",
    }),
  );
  for (const k of OAUTH_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterAll(async () => {
  if (prevCfgDir === undefined) delete process.env.JOC_CONFIG_DIR;
  else process.env.JOC_CONFIG_DIR = prevCfgDir;
  if (prevOpenAiBase === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = prevOpenAiBase;
  for (const k of OAUTH_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await fs.rm(dir, { recursive: true, force: true });
});

const okFetch = (body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

test("discoveryRequest: anthropic api-key uses x-api-key + version", () => {
  const { url, headers } = discoveryRequest("anthropic", { kind: "api_key", provider: "anthropic", token: "k" });
  expect(url).toBe("https://api.anthropic.com/v1/models");
  expect(headers["x-api-key"]).toBe("k");
  expect(headers["anthropic-version"]).toBe("2023-06-01");
});

test("discoveryRequest: anthropic oauth uses bearer + beta", () => {
  const { headers } = discoveryRequest("anthropic", { kind: "oauth", provider: "anthropic", token: "t" });
  expect(headers.authorization).toBe("Bearer t");
  expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
});

test("discoveryRequest: gemini oauth omits ?key=, api-key appends it", () => {
  const oauth = discoveryRequest("gemini", { kind: "oauth", provider: "gemini", token: "t" });
  expect(oauth.url).not.toContain("key=");
  expect(oauth.headers.authorization).toBe("Bearer t");
  const apiKey = discoveryRequest("gemini", { kind: "api_key", provider: "gemini", token: "k" });
  expect(apiKey.url).toContain("key=k");
});

test("discoveryRequest: openai honors a base URL override", () => {
  const { url } = discoveryRequest("openai", { kind: "api_key", provider: "openai", token: "k" }, "http://localhost:1234/v1");
  expect(url).toBe("http://localhost:1234/v1/models");
});

test("parseModelsBody normalizes each provider shape", () => {
  expect(parseModelsBody("openai", { data: [{ id: "gpt-4o" }, { id: "o3" }] })).toEqual(["gpt-4o", "o3"]);
  expect(parseModelsBody("anthropic", { data: [{ id: "claude-3-5-sonnet-20241022" }] })).toEqual(["claude-3-5-sonnet-20241022"]);
  expect(parseModelsBody("gemini", { models: [{ name: "models/gemini-1.5-pro" }] })).toEqual(["gemini-1.5-pro"]);
  expect(parseModelsBody("ollama", { models: [{ name: "qwen2.5:0.5b" }] })).toEqual(["ollama/qwen2.5:0.5b"]);
});

test("listProviderModels: success returns sorted, capped models", async () => {
  const r = await listProviderModels("openai", { fetchImpl: okFetch({ data: [{ id: "gpt-4o" }, { id: "aaa" }] }), limit: 10 });
  expect(r.ok).toBe(true);
  expect(r.source).toBe("api_key");
  expect(r.models).toEqual(["aaa", "gpt-4o"]); // sorted
});

test("listProviderModels: 401 → auth rejected", async () => {
  const fetch401 = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
  const r = await listProviderModels("anthropic", { fetchImpl: fetch401 });
  expect(r.ok).toBe(false);
  expect(r.error).toBe("auth rejected");
});

test("listProviderModels: network throw → unreachable", async () => {
  const fetchThrow = (async () => { throw new Error("boom"); }) as unknown as typeof fetch;
  const r = await listProviderModels("gemini", { fetchImpl: fetchThrow });
  expect(r.ok).toBe(false);
  expect(r.error).toBe("unreachable");
});

test("listProviderModels: ollama is keyless and never needs a credential", async () => {
  const r = await listProviderModels("ollama", { fetchImpl: okFetch({ models: [{ name: "llama3" }] }) });
  expect(r.ok).toBe(true);
  expect(r.source).toBe("keyless");
  expect(r.models).toEqual(["ollama/llama3"]);
});

test("listProviderModels: OAuth discovery uses the provider OAuth token directly", async () => {
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({
      providers: { openai: "sk-oai", gemini: "sk-gem" },
      oauth: { anthropic: "oauth-ant" },
      defaultModel: "claude-3-5-sonnet",
    }),
  );
  let auth = "";
  const fetchSpy = (async (_url: string | URL | Request, init?: RequestInit) => {
    auth = String((init?.headers as Record<string, string>)?.authorization ?? "");
    return new Response(JSON.stringify({ content: [] }), { status: 200 });
  }) as typeof fetch;
  const r = await listProviderModels("anthropic", { fetchImpl: fetchSpy });
  expect(r.ok).toBe(true);
  expect(r.source).toBe("oauth");
  expect(auth).toBe("Bearer oauth-ant");
});

test("listProviderModels: OpenAI OAuth + API Key swaps to API Key", async () => {
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({
      providers: { openai: "sk-oai" },
      oauth: { openai: "oauth-oai" },
      defaultModel: "claude-3-5-sonnet",
    }),
  );
  let auth = "";
  const fetchSpy = (async (_url: string | URL | Request, init?: RequestInit) => {
    auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    return new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), { status: 200 });
  }) as typeof fetch;
  const r = await listProviderModels("openai", { fetchImpl: fetchSpy });
  expect(r.ok).toBe(true);
  expect(r.source).toBe("api_key");
  expect(auth).toBe("Bearer sk-oai");
});

test("listProviderModels: OAuth-only discovery still probes the provider list", async () => {
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({
      providers: { anthropic: "sk-ant", gemini: "sk-gem" },
      oauth: { openai: "oauth-oai" },
      defaultModel: "claude-3-5-sonnet",
    }),
  );
  let called = false;
  const fetchSpy = (async () => {
    called = true;
    return new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), { status: 200 });
  }) as typeof fetch;
  const r = await listProviderModels("openai", { fetchImpl: fetchSpy });
  expect(r.ok).toBe(true);
  expect(r.source).toBe("oauth");
  expect(r.models).toEqual(["gpt-4o"]);
  expect(called).toBe(true);
});

test("listProviderModels: credential-less cloud short-circuits without fetching", async () => {
  // Fresh config dir with no keys → anthropic credential is "none".
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "joc-disc-empty-"));
  const prev = process.env.JOC_CONFIG_DIR;
  process.env.JOC_CONFIG_DIR = empty;
  await fs.writeFile(path.join(empty, "config.json"), JSON.stringify({ providers: {}, defaultModel: "claude-3-5-sonnet" }));
  let called = false;
  const spy = (async () => { called = true; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
  try {
    const r = await listProviderModels("anthropic", { fetchImpl: spy });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not logged in");
    expect(called).toBe(false);
  } finally {
    process.env.JOC_CONFIG_DIR = prev;
    await fs.rm(empty, { recursive: true, force: true });
  }
});

test("discoverModels runs all providers in parallel", async () => {
  const results = await discoverModels({ fetchImpl: okFetch({ data: [{ id: "x" }], models: [{ name: "y" }] }) });
  expect(results.map(r => r.provider).sort()).toEqual(["anthropic", "gemini", "ollama", "openai"]);
});

test("catalogOr: OAuth provider with rejected live endpoint falls back to catalog ids", () => {
  // Simulates ChatGPT/Codex OAuth: /v1/models returns 401, but the user IS logged in.
  const r = catalogOr({ provider: "openai", models: [], ok: false, source: "oauth", error: "auth rejected" });
  expect(r.ok).toBe(true);
  expect(r.fallback).toBe(true);
  expect(r.models.length).toBeGreaterThan(0);
  expect(r.models).toContain("gpt-4o");
});

test("catalogOr: keyless/not-logged-in results are returned unchanged (no fabricated models)", () => {
  const none = catalogOr({ provider: "openai", models: [], ok: false, source: "none", error: "not logged in" });
  expect(none.ok).toBe(false);
  expect(none.models).toEqual([]);
  expect(none.fallback).toBeUndefined();
});

test("catalogOr: a successful live result is never overwritten by the catalog", () => {
  const live = catalogOr({ provider: "openai", models: ["gpt-live-1"], ok: true, source: "oauth" });
  expect(live.models).toEqual(["gpt-live-1"]);
  expect(live.fallback).toBeUndefined();
});

test("parseModelsBody: openai drops non-chat families (embeddings/tts/image/moderation)", () => {
  const ids = parseModelsBody("openai", {
    data: [
      { id: "gpt-4o" }, { id: "o3" }, { id: "text-embedding-3-small" },
      { id: "tts-1" }, { id: "dall-e-3" }, { id: "whisper-1" },
      { id: "omni-moderation-latest" }, { id: "gpt-4o-audio-preview" },
      { id: "gpt-4o-search-preview" }, { id: "gpt-3.5-turbo-instruct" },
    ],
  });
  expect(ids).toContain("gpt-4o");
  expect(ids).toContain("o3");
  expect(ids).toContain("gpt-4o-search-preview");
  expect(ids).not.toContain("gpt-3.5-turbo-instruct");
  expect(ids).not.toContain("text-embedding-3-small");
  expect(ids).not.toContain("tts-1");
  expect(ids).not.toContain("dall-e-3");
  expect(ids).not.toContain("whisper-1");
  expect(ids).not.toContain("omni-moderation-latest");
  expect(ids).not.toContain("gpt-4o-audio-preview");
});

test("parseModelsBody: gemini keeps only generateContent-capable models", () => {
  const ids = parseModelsBody("gemini", {
    models: [
      { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent", "countTokens"] },
      { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
      { name: "models/gemini-2.5-flash-tts", supportedGenerationMethods: ["bidiGenerateContent"] },
      // generateContent-capable but emits images/audio → still excluded by family name
      { name: "models/gemini-2.5-flash-image", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-2.5-pro-preview-tts", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-legacy" }, // no methods → permissive keep
      { name: "models/learnlm-1.5-pro-experimental" },
    ],
  });
  expect(ids).toEqual(["gemini-2.5-pro", "gemini-legacy", "learnlm-1.5-pro-experimental"]);
});

test("catalogOr: an api_key rejection does NOT fabricate catalog rows (bad key stays a failure)", () => {
  const r = catalogOr({ provider: "openai", models: [], ok: false, source: "api_key", error: "auth rejected" });
  expect(r.ok).toBe(false);
  expect(r.models).toEqual([]);
  expect(r.fallback).toBeUndefined();
});
