import { test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  discoveryRequest,
  parseModelsBody,
  listProviderModels,
  discoverModels,
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
