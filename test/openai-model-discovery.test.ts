import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogOr, discoverModels, discoveryRequest, listProviderModels, parseModelsBody } from "../src/ai/model-discovery";
import { flattenModels } from "../src/ai/model-picker";
import { isCodexModel, resetLiveCodexModels, resetLiveProviderModels } from "../src/ai/model-catalog";
import { setOauthCredentialNoLock } from "../src/auth/storage";
import { readGlobalConfig } from "../src/agent/state";

const envKeys = ["JEO_CONFIG_DIR", "OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_OAUTH_TOKEN"];
let saved: Record<string, string | undefined>;
let dir: string;

beforeEach(async () => {
  saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  dir = await mkdtemp(join(tmpdir(), "jeo-openai-discovery-"));
  process.env.JEO_CONFIG_DIR = dir;
  await writeFile(join(dir, "config.json"), JSON.stringify({ providers: { openai: "sk-test" }, defaultModel: "gpt-5.5" }));
  resetLiveCodexModels();
  resetLiveProviderModels();
});

afterEach(async () => {
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(dir, { recursive: true, force: true });
  resetLiveCodexModels();
  resetLiveProviderModels();
});

const response = (body: unknown) => new Response(JSON.stringify(body));

test("API discovery retains GPT Codex coding models and excludes non-text families", () => {
  expect(parseModelsBody("openai", { data: [
    { id: "gpt-5.3-codex" }, { id: "gpt-5.3-codex-spark" },
    { id: "codex-mini-latest" }, { id: "gpt-image-1" }, { id: "text-embedding-3-small" },
  ] })).toEqual(["gpt-5.3-codex", "gpt-5.3-codex-spark"]);
});

test("OpenAI default discovery keeps every returned model; explicit limits still cap the picker", async () => {
  const body = { data: Array.from({ length: 125 }, (_, i) => ({ id: `gpt-live-${String(i).padStart(3, "0")}` })) };
  const fetchImpl = (async () => response(body)) as typeof fetch;
  expect((await listProviderModels("openai", { fetchImpl })).models).toHaveLength(125);
  expect((await listProviderModels("openai", { fetchImpl, limit: 2 })).models).toHaveLength(2);
});

test("OpenAI empty and unavailable catalogs remain honest across fallback handling", () => {
  for (const source of ["oauth", "api_key"] as const) {
    for (const result of [
      { provider: "openai" as const, models: [], ok: true, source },
      { provider: "openai" as const, models: [], ok: false, source, error: "HTTP 404" },
    ]) expect(catalogOr(result)).toEqual(result);
  }
});

test("malformed OpenAI responses cannot erase a previously confirmed catalog", async () => {
  await setOauthCredentialNoLock("openai", { access: "opaque-token", accountId: "test-account" });
  await listProviderModels("openai", { preferOAuth: true, fetchImpl: (async () => response({ models: [{ slug: "gpt-previous" }] })) as typeof fetch });
  for (const body of [{}, null, { models: [null] }, { models: [{}] }, { data: "invalid" }]) {
    const result = await listProviderModels("openai", { preferOAuth: true, fetchImpl: (async () => response(body)) as typeof fetch });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid models response");
    expect(isCodexModel("gpt-previous")).toBe(true);
  }
});

test("opaque OAuth credentials send the stored account header to Codex", async () => {
  await setOauthCredentialNoLock("openai", { access: "opaque-token", accountId: "test-account" });
  let accountHeader: string | undefined;
  const fetchImpl = (async (_url, init) => {
    accountHeader = (init?.headers as Record<string, string>)["chatgpt-account-id"];
    return response({ models: [{ slug: "gpt-subscription", visibility: "list", supported_in_api: false }] });
  }) as typeof fetch;
  const result = await listProviderModels("openai", { fetchImpl, preferOAuth: true });
  expect(accountHeader).toBe("test-account");
  expect(result.accountId).toBe("test-account");
  expect(result.models).toEqual(["gpt-subscription"]);
  expect(isCodexModel("gpt-subscription")).toBe(true);
});

test("custom endpoints use their own key, retain arbitrary deployment names and never authorize Codex", async () => {
  await setOauthCredentialNoLock("openai", { access: "opaque-token", accountId: "test-account" });
  let url = "";
  let authorization: string | undefined;
  const fetchImpl = (async (input, init) => {
    url = String(input);
    authorization = (init?.headers as Record<string, string>).Authorization;
    return response({ data: [{ id: "image-coder-private" }] });
  }) as typeof fetch;
  const result = await listProviderModels("openai", {
    fetchImpl, preferOAuth: true,
    config: { ...(await readGlobalConfig()), providers: { openai: "proxy-key" }, openaiBaseUrl: "http://localhost:1234/v1/" },
  });
  expect(url).toBe("http://localhost:1234/v1/models");
  expect(authorization).toBe("Bearer proxy-key");
  expect(result.baseUrl).toBe("http://localhost:1234/v1");
  expect(result.source).toBe("api_key");
  expect(result.models).toEqual(["image-coder-private"]);
  expect(isCodexModel("image-coder-private")).toBe(false);
});

test("dual credentials discover both account catalogs without duplicate picker rows", async () => {
  await setOauthCredentialNoLock("openai", { access: "opaque-token", accountId: "test-account" });
  const fetchImpl = (async input => String(input).includes("chatgpt.com")
    ? response({ models: [{ slug: "gpt-shared", visibility: "list" }, { slug: "gpt-subscription", visibility: "list", supported_in_api: false }] })
    : response({ data: [{ id: "gpt-shared" }, { id: "gpt-api" }] })) as typeof fetch;
  const results = await discoverModels({ providers: ["openai"], fetchImpl });
  expect(results.map(row => row.source)).toEqual(["api_key", "oauth"]);
  expect(flattenModels(results).map(row => row.model)).toEqual(["gpt-api", "gpt-shared", "gpt-subscription"]);
  expect(isCodexModel("gpt-subscription")).toBe(true);
  expect(isCodexModel("gpt-api")).toBe(false);
});

test("discoveryRequest accepts stored account identity when token has no JWT claims", () => {
  expect(discoveryRequest("openai", { kind: "oauth", provider: "openai", token: "opaque" }, undefined, "test-account")
    .headers["chatgpt-account-id"]).toBe("test-account");
});
