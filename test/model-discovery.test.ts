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
  isLocalProviderReachable,
  CODEX_MODELS_URL,
} from "../src/ai/model-discovery";
import { PROVIDER_NAMES } from "../src/ai/provider-status";
import { isCodexModel, liveProviderCatalogModels, resetLiveCodexModels, resetLiveProviderModels } from "../src/ai/model-catalog";

let dir: string;
const prevCfgDir = process.env.JEO_CONFIG_DIR;
const prevOpenAiBase = process.env.OPENAI_BASE_URL;
const OAUTH_ENV = ["ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_OAUTH_TOKEN", "GEMINI_OAUTH_TOKEN"];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-disc-"));
  process.env.JEO_CONFIG_DIR = dir;
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
  if (prevCfgDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = prevCfgDir;
  if (prevOpenAiBase === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = prevOpenAiBase;
  for (const k of OAUTH_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await fs.rm(dir, { recursive: true, force: true });
  resetLiveCodexModels();
  resetLiveProviderModels();
});

const okFetch = (body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

function fakeJwt(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
  return `${header}.${payload}.sig`;
}

test("discoveryRequest: anthropic api-key uses x-api-key + version", () => {
  const { url, headers } = discoveryRequest("anthropic", { kind: "api_key", provider: "anthropic", token: "k" });
  expect(url).toBe("https://api.anthropic.com/v1/models");
  expect(headers["x-api-key"]).toBe("k");
  expect(headers["anthropic-version"]).toBe("2023-06-01");
});

test("discoveryRequest: anthropic oauth uses bearer (no beta for models endpoint)", () => {
  const { headers } = discoveryRequest("anthropic", { kind: "oauth", provider: "anthropic", token: "t" });
  expect(headers.authorization).toBe("Bearer t");
  expect(headers["anthropic-version"]).toBe("2023-06-01");
  // The oauth-2025-04-20 beta is for the messages endpoint, not the models endpoint
  expect(headers["anthropic-beta"]).toBeUndefined();
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

test("discoveryRequest: openai oauth uses the Codex models endpoint", () => {
  const { url, headers } = discoveryRequest("openai", { kind: "oauth", provider: "openai", token: fakeJwt("acct-1") });
  expect(url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=2.0.0");
  expect(headers.Authorization).toContain("Bearer ");
  expect(headers["chatgpt-account-id"]).toBe("acct-1");
  expect(headers["OpenAI-Beta"]).toBe("responses=experimental");
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

// isLocalProviderReachable (v0.9.0): the live probe backing the routing veto gate's
// "is this local provider actually up" check — `describeProvider` reports ollama/
// lmstudio as `ready: true` unconditionally (keyless ≠ reachable), so this is the
// only signal that catches a downed local server before routing commits to it.
test("isLocalProviderReachable: true when the server responds ok, false on a thrown connection error", async () => {
  expect(await isLocalProviderReachable("ollama", "http://localhost:11434", { fetchImpl: okFetch({ models: [{ name: "llama3" }] }) })).toBe(true);
  const fetchThrow = (async () => { throw Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" }); }) as unknown as typeof fetch;
  expect(await isLocalProviderReachable("ollama", "http://localhost:11434", { fetchImpl: fetchThrow })).toBe(false);
  expect(await isLocalProviderReachable("lmstudio", "http://localhost:1234/v1", { fetchImpl: fetchThrow })).toBe(false);
});

test("isLocalProviderReachable: a non-ok HTTP status is also unreachable", async () => {
  const fetch500 = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
  expect(await isLocalProviderReachable("ollama", "http://localhost:11434", { fetchImpl: fetch500 })).toBe(false);
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
test("listProviderModels: preferOAuth (post-login report) skips the API-key swap and sends the OAuth bearer to the Codex models endpoint even with providers.openai also configured", async () => {
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({
      providers: { openai: "sk-oai" },
      oauth: { openai: "oauth-oai" },
      defaultModel: "claude-3-5-sonnet",
    }),
  );
  let capturedUrl = "";
  let capturedAuth = "";
  const fetchSpy = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedAuth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    return new Response(JSON.stringify({ models: [{ slug: "gpt-5.5", supported_in_api: true }, { slug: "hidden", supported_in_api: false }] }), { status: 200 });
  }) as typeof fetch;
  const r = await listProviderModels("openai", { fetchImpl: fetchSpy, preferOAuth: true });
  expect(capturedUrl).toBe(CODEX_MODELS_URL);
  expect(capturedUrl).toBe("https://chatgpt.com/backend-api/codex/models?client_version=2.0.0");
  expect(capturedAuth).toBe("Bearer oauth-oai");
  expect(r.source).toBe("oauth");
  expect(r.ok).toBe(true);
  expect(r.models).toEqual(["gpt-5.5"]);
});

test("listProviderModels: preferOAuth is a no-op for an OAuth-only config (no API key to skip swapping to) — still fetches Codex with the bearer", async () => {
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({
      providers: {},
      oauth: { openai: "oauth-oai-only" },
      defaultModel: "claude-3-5-sonnet",
    }),
  );
  let capturedAuth = "";
  const fetchSpy = (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedAuth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    return new Response(JSON.stringify({ models: [{ slug: "gpt-5.4", supported_in_api: true }] }), { status: 200 });
  }) as typeof fetch;
  const r = await listProviderModels("openai", { fetchImpl: fetchSpy, preferOAuth: true });
  expect(r.source).toBe("oauth");
  expect(r.ok).toBe(true);
  expect(r.models).toEqual(["gpt-5.4"]);
  expect(capturedAuth).toBe("Bearer oauth-oai-only");
});

test("listProviderModels: without preferOAuth, an OAuth+API-key config still swaps to the API key — the TUI/default discovery path is unchanged by the new option", async () => {
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({
      providers: { openai: "sk-oai" },
      oauth: { openai: "oauth-oai" },
      defaultModel: "claude-3-5-sonnet",
    }),
  );
  let capturedAuth = "";
  const fetchSpy = (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedAuth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    return new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), { status: 200 });
  }) as typeof fetch;
  const r = await listProviderModels("openai", { fetchImpl: fetchSpy });
  expect(r.source).toBe("api_key");
  expect(capturedAuth).toBe("Bearer sk-oai");
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
  const fetchSpy = (async (_url: string | URL | Request, init?: RequestInit) => {
    called = true;
    const headers = init?.headers as Record<string, string>;
    expect(String(_url)).toBe("https://chatgpt.com/backend-api/codex/models?client_version=2.0.0");
    expect(headers.Authorization).toContain("Bearer ");
    return new Response(JSON.stringify({ models: [{ slug: "gpt-5.5", supported_in_api: true }, { slug: "hidden", supported_in_api: false }] }), { status: 200 });
  }) as typeof fetch;
  const r = await listProviderModels("openai", { fetchImpl: fetchSpy });
  expect(r.ok).toBe(true);
  expect(r.source).toBe("oauth");
  expect(r.models).toEqual(["gpt-5.5"]);
  expect(called).toBe(true);
});

test("listProviderModels: an OAuth-source OpenAI success widens isCodexModel with the observed ids — the actual root-cause fix", async () => {
  // Reproduces the "OAuth GPT connection doesn't work" bug: the live endpoint lists a
  // model the static CODEX_MODELS snapshot hasn't caught up to yet (OpenAI shipped it
  // between jeo releases). Before recordLiveCodexModels wiring, the picker would show
  // it (from this SAME endpoint) and the call-time gate would then hard-reject it.
  resetLiveCodexModels();
  expect(isCodexModel("gpt-5.3-codex-spark")).toBe(false); // static catalog does not grant Spark access
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({ providers: {}, oauth: { openai: "oauth-oai" }, defaultModel: "claude-3-5-sonnet" }),
  );
  expect(isCodexModel("gpt-9-hypothetical")).toBe(false); // not yet observed
  const fetchSpy = (async () =>
    new Response(JSON.stringify({ models: [
      { slug: "gpt-5.5", supported_in_api: true },
      { slug: "gpt-5.3-codex-spark", supported_in_api: true },
      { slug: "gpt-9-hypothetical", supported_in_api: true },
      { slug: "hidden", supported_in_api: false },
    ] }), { status: 200 })
  ) as typeof fetch;
  const r = await listProviderModels("openai", { fetchImpl: fetchSpy });
  expect(r.ok).toBe(true);
  expect(r.models).toEqual(["gpt-5.3-codex-spark", "gpt-5.5", "gpt-9-hypothetical"]);
  // The discovery call itself recorded it — no separate wiring step needed.
  expect(isCodexModel("gpt-9-hypothetical")).toBe(true);
  expect(isCodexModel("openai/gpt-9-hypothetical")).toBe(true);
  expect(isCodexModel("gpt-5.3-codex-spark")).toBe(true);
  resetLiveCodexModels();
});

test("listProviderModels: an api_key-source OpenAI result never widens the Codex gate (only oauth-sourced discovery is trustworthy for this)", async () => {
  resetLiveCodexModels();
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({ providers: { openai: "sk-oai" }, defaultModel: "claude-3-5-sonnet" }),
  );
  const fetchSpy = (async () =>
    new Response(JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }), { status: 200 })
  ) as typeof fetch;
  const r = await listProviderModels("openai", { fetchImpl: fetchSpy });
  expect(r.ok).toBe(true);
  expect(r.source).toBe("api_key");
  // An api_key result says nothing about what OAuth can serve — must not leak in.
  expect(isCodexModel("gpt-4o")).toBe(false);
  resetLiveCodexModels();
});

test("listProviderModels: OpenAI api_key discovery records live provider models without widening the Codex allow-list", async () => {
  resetLiveCodexModels();
  resetLiveProviderModels();
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({ providers: { openai: "sk-oai" }, defaultModel: "claude-3-5-sonnet" }),
  );
  const apiOnlyModel = "gpt-9-api-only";
  expect(isCodexModel(apiOnlyModel)).toBe(false);
  const fetchSpy = (async () =>
    new Response(JSON.stringify({ data: [{ id: apiOnlyModel }] }), { status: 200 })
  ) as typeof fetch;
  const r = await listProviderModels("openai", { fetchImpl: fetchSpy });
  expect(r.ok).toBe(true);
  expect(r.source).toBe("api_key");
  expect(r.models).toEqual([apiOnlyModel]);
  expect(isCodexModel(apiOnlyModel)).toBe(false);
  const live = liveProviderCatalogModels().find(row => row.canonical === apiOnlyModel);
  expect(live?.provider).toBe("openai");
  expect(live?.providerModel).toBe(apiOnlyModel);
  resetLiveCodexModels();
  resetLiveProviderModels();
});

test("listProviderModels: credential-less cloud short-circuits without fetching", async () => {
  // Fresh config dir with no keys → anthropic credential is "none".
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-disc-empty-"));
  const prev = process.env.JEO_CONFIG_DIR;
  process.env.JEO_CONFIG_DIR = empty;
  await fs.writeFile(path.join(empty, "config.json"), JSON.stringify({ providers: {}, defaultModel: "claude-3-5-sonnet" }));
  let called = false;
  const spy = (async () => { called = true; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
  try {
    const r = await listProviderModels("anthropic", { fetchImpl: spy });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not logged in");
    expect(called).toBe(false);
  } finally {
    process.env.JEO_CONFIG_DIR = prev;
    await fs.rm(empty, { recursive: true, force: true });
  }
});

test("discoverModels runs all providers in parallel", async () => {
  const results = await discoverModels({ fetchImpl: okFetch({ data: [{ id: "x" }], models: [{ name: "y" }] }) });
  expect(results.map(r => r.provider).sort()).toEqual([...PROVIDER_NAMES].sort());
});

test("listProviderModels: Antigravity queries the LIVE fetchAvailableModels endpoint (no hard-coded list)", async () => {
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({
      providers: { gemini: "sk-gem" },
      oauth: { gemini: { access: "oauth-gem", projectId: "proj-1" } },
      defaultModel: "antigravity/gemini-3-pro-low",
    }),
  );
  let calledUrl = "";
  let calledMethod = "";
  const live = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calledUrl = String(url);
    calledMethod = init?.method ?? "GET";
    return new Response(JSON.stringify({
      models: {
        "gemini-3-pro-high": { displayName: "Gemini 3 Pro High" },
        "internal-secret": { isInternal: true },
        "gemini-2.5-pro": {}, // denylisted upstream id
      },
    }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await listProviderModels("antigravity", { fetchImpl: live });
  expect(calledUrl).toContain("v1internal:fetchAvailableModels");
  expect(calledMethod).toBe("POST");
  expect(r.ok).toBe(true);
  expect(r.source).toBe("oauth");
  expect(r.fallback).toBeUndefined();
  expect(r.models).toEqual(["antigravity/gemini-3-pro-high"]); // internal + denylisted dropped
});

test("listProviderModels: Antigravity prefers the API's own agentModelSorts as the positive chat set", async () => {
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({
      providers: {},
      oauth: { gemini: { access: "oauth-gem", projectId: "proj-1" } },
      defaultModel: "antigravity/gemini-3-flash",
    }),
  );
  const live = (async () => new Response(JSON.stringify({
    models: {
      "gemini-3-flash": { displayName: "Gemini 3 Flash", model: "MODEL_PLACEHOLDER_M18" },
      "claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6", model: "MODEL_PLACEHOLDER_M35" },
      "tab_flash_lite_preview": { model: "MODEL_PLACEHOLDER_M28" }, // not in agent groups
      "gemini-3.1-flash-image": { displayName: "Image" },           // image-gen role
      "chat_20706": { isInternal: true },
    },
    agentModelSorts: [{ groups: [{ modelIds: ["gemini-3-flash", "claude-sonnet-4-6"] }] }],
    imageGenerationModelIds: ["gemini-3.1-flash-image"],
    // Real payload shape regression: deprecatedModelIds is an OBJECT keyed by id.
    deprecatedModelIds: { "gemini-3.1-pro-high": { newModelId: "gemini-pro-agent" } },
  }), { status: 200 })) as unknown as typeof fetch;
  const r = await listProviderModels("antigravity", { fetchImpl: live });
  expect(r.ok).toBe(true);
  // Positive selection: only the API-declared agent models, keyed by callable id —
  // the internal MODEL_PLACEHOLDER_* enum never leaks.
  expect(r.models).toEqual(["antigravity/claude-sonnet-4-6", "antigravity/gemini-3-flash"]);
});

test("listProviderModels: Antigravity list failure is surfaced, never papered over with catalog rows", async () => {
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({
      providers: {},
      oauth: { gemini: { access: "oauth-gem", projectId: "proj-1" } },
      defaultModel: "antigravity/gemini-3-pro-low",
    }),
  );
  const denied = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
  const r = await listProviderModels("antigravity", { fetchImpl: denied });
  expect(r.ok).toBe(false);
  expect(r.error).toBe("auth rejected");
  expect(r.models).toEqual([]);
});

test("parseModelsBody: Antigravity model rows are provider-qualified", () => {
  expect(parseModelsBody("antigravity", { models: [{ slug: "gemini-3-pro-low" }, { id: "claude-sonnet-4-5" }] }))
    .toEqual(["antigravity/gemini-3-pro-low", "antigravity/claude-sonnet-4-5"]);
});

test("catalogOr: OpenAI OAuth (Codex) falls back to the Codex-served model set, not the full catalog", () => {
  // Simulates ChatGPT/Codex OAuth: /v1/models returns 401, but the user IS logged in.
  const r = catalogOr({ provider: "openai", models: [], ok: false, source: "oauth", error: "auth rejected" });
  expect(r.ok).toBe(true);
  expect(r.fallback).toBe(true);
  expect(r.models).toContain("gpt-5.5"); // Codex actually serves this
  expect(r.models).not.toContain("gpt-4o"); // Codex rejects standard API ids
});

test("catalogOr: non-OpenAI OAuth provider falls back to its full static catalog", () => {
  const r = catalogOr({ provider: "anthropic", models: [], ok: false, source: "oauth", error: "auth rejected" });
  expect(r.ok).toBe(true);
  expect(r.fallback).toBe(true);
  expect(r.models.length).toBeGreaterThan(0);
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

test("parseModelsBody: openai parses Codex model endpoint shape and skips unsupported rows", () => {
  expect(parseModelsBody("openai", { models: [{ slug: "gpt-5.5" }, { id: "gpt-5.4" }, { slug: "hidden", supported_in_api: false }] })).toEqual(["gpt-5.5", "gpt-5.4"]);
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
      // generateContent-capable but non-chat families (research/computer-use/antigravity) → excluded
      { name: "models/deep-research-pro-preview-12-2025", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-2.5-computer-use-preview-10-2025", supportedGenerationMethods: ["generateContent"] },
      { name: "models/antigravity-preview-05-2026", supportedGenerationMethods: ["generateContent"] },
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

test("catalogOr: api_key provider with NO models endpoint (HTTP 404) falls back to its static catalog", () => {
  // Tencent MaaS speaks Anthropic Messages but has no /v1/models route → 404.
  // The key is valid; the models must still surface from the static catalog.
  const r = catalogOr({ provider: "tencent", models: [], ok: false, source: "api_key", error: "HTTP 404" });
  expect(r.ok).toBe(true);
  expect(r.fallback).toBe(true);
  expect(r.models).toContain("deepseek-v4-pro");
  expect(r.models).toContain("deepseek-v4-flash");
  expect(r.models).toContain("minimax-m3");
});

test("catalogOr: api_key '404 page not found' body text also triggers catalog fallback", () => {
  const r = catalogOr({ provider: "tencent", models: [], ok: false, source: "api_key", error: "HTTP 404: 404 page not found" });
  expect(r.ok).toBe(true);
  expect(r.fallback).toBe(true);
});

test("catalogOr: api_key provider for a catalog-less provider stays a failure even on 404", () => {
  // No static catalog rows → nothing safe to surface → honest failure preserved.
  const r = catalogOr({ provider: "lmstudio", models: [], ok: false, source: "api_key", error: "HTTP 404" });
  expect(r.ok).toBe(false);
  expect(r.models).toEqual([]);
  expect(r.fallback).toBeUndefined();
});

// Round-15: live-verified endpoint structure fixes.

test("discoveryRequest: codex URL carries client_version (400 without; old versions get [])", () => {
  const { url } = discoveryRequest("openai", { kind: "oauth", provider: "openai", token: fakeJwt("a") });
  expect(url).toContain("client_version=");
});

test("discoveryRequest: gemini URLs request pageSize=1000 (default page drops models)", () => {
  const apiKey = discoveryRequest("gemini", { kind: "api_key", provider: "gemini", token: "k" });
  expect(apiKey.url).toContain("pageSize=1000");
  expect(apiKey.url).toContain("key=k");
  const oauth = discoveryRequest("gemini", { kind: "oauth", provider: "gemini", token: "t" });
  expect(oauth.url).toContain("pageSize=1000");
});

test("parseModelsBody: codex review-only models are excluded", () => {
  const ids = parseModelsBody("openai", {
    models: [
      { slug: "gpt-5.5", supported_in_api: true },
      { slug: "codex-auto-review", supported_in_api: true },
    ],
  });
  expect(ids).toEqual(["gpt-5.5"]);
});

test("listProviderModels: gemini follows nextPageToken so the available list is complete", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-disc-page-"));
  const prev = process.env.JEO_CONFIG_DIR;
  process.env.JEO_CONFIG_DIR = dir;
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ providers: { gemini: "sk-gem" }, defaultModel: "claude-3-5-sonnet" }));
  const prevKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const pages: string[] = [];
  const fetchSpy = (async (url: string | URL | Request) => {
    const u = String(url);
    pages.push(u);
    if (!u.includes("pageToken=")) {
      return new Response(JSON.stringify({
        models: [{ name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] }],
        nextPageToken: "tok-2",
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      models: [{ name: "models/gemini-3-pro-preview", supportedGenerationMethods: ["generateContent"] }],
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const r = await listProviderModels("gemini", { fetchImpl: fetchSpy });
    expect(r.ok).toBe(true);
    expect(r.models).toEqual(["gemini-2.5-pro", "gemini-3-pro-preview"]); // BOTH pages
    expect(pages.length).toBe(2);
    expect(pages[1]).toContain("pageToken=tok-2");
  } finally {
    process.env.JEO_CONFIG_DIR = prev;
    if (prevKey !== undefined) process.env.GEMINI_API_KEY = prevKey;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
// --- Gemini OAuth gate (v0.8.2): OAuth alone can LIST gemini models but can no
// longer SERVE them (Cloud Code Assist masquerade removed), so discovery must
// refuse WITHOUT fetching — surfacing models every call would reject sells a
// broken picker. catalogOr must keep that refusal a failure, never resurrect
// catalog rows for it. ---

test("listProviderModels: gemini OAuth-only refuses with a GEMINI_API_KEY hint WITHOUT fetching, and catalogOr keeps it a failure", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-disc-gem-oauth-"));
  const prev = process.env.JEO_CONFIG_DIR;
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.JEO_CONFIG_DIR = dir;
  delete process.env.GEMINI_API_KEY; // env key would fill config.providers.gemini and defeat the OAuth-only setup
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({
    providers: {},
    oauth: { gemini: "oauth-gem" },
    defaultModel: "claude-3-5-sonnet",
  }));
  let called = false;
  const spy = (async () => { called = true; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
  try {
    const r = await listProviderModels("gemini", { fetchImpl: spy });
    expect(r.ok).toBe(false);
    expect(r.source).toBe("oauth");
    expect(r.error).toMatch(/GEMINI_API_KEY/);
    expect(called).toBe(false); // short-circuits BEFORE any network probe
    // catalogOr's gemini+oauth carve-out: the failure stays honest — no fabricated models.
    const withCatalog = catalogOr(r);
    expect(withCatalog.ok).toBe(false);
    expect(withCatalog.models).toEqual([]);
  } finally {
    process.env.JEO_CONFIG_DIR = prev;
    if (prevKey !== undefined) process.env.GEMINI_API_KEY = prevKey;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("listProviderModels: gemini OAuth + API key swaps to the key and still lists LIVE models (gate only fires key-less)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-disc-gem-key-"));
  const prev = process.env.JEO_CONFIG_DIR;
  process.env.JEO_CONFIG_DIR = dir;
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({
    providers: { gemini: "sk-gem" },
    oauth: { gemini: "oauth-gem" },
    defaultModel: "claude-3-5-sonnet",
  }));
  const urls: string[] = [];
  const fetchSpy = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify({
      models: [{ name: "models/gemini-3-flash", supportedGenerationMethods: ["generateContent"] }],
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const r = await listProviderModels("gemini", { fetchImpl: fetchSpy });
    expect(r.ok).toBe(true);
    expect(r.source).toBe("api_key"); // swapped off the OAuth token
    expect(r.models).toEqual(["gemini-3-flash"]);
    expect(urls.length).toBe(1);
    expect(urls[0]).toContain("key=sk-gem"); // the live list ran under the API key
  } finally {
    process.env.JEO_CONFIG_DIR = prev;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
