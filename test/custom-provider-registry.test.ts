import { test, expect, afterEach } from "bun:test";
import {
  assertValidProviderId,
  clearCustomProviders,
  credentialSourceOf,
  customProviderDef,
  customProviderNames,
  defaultApiKeyEnv,
  isCustomProvider,
  normalizeCustomBaseUrl,
  normalizeProviderId,
  parseModelList,
  parseProviderCompatibility,
  redactSecret,
  resolveCustomApiKey,
  setCustomProviders,
  toCustomProviderDef,
} from "../src/ai/providers/custom-providers";
import {
  allCompatNames,
  isBuiltinCompatProvider,
  isOpenAICompatProvider,
  openaiCompatDef,
} from "../src/ai/providers/openai-compatible-catalog";
import { providerRegistry } from "../src/ai/provider-registry";
import { syncCustomProviderAdapters } from "../src/ai/register-providers";
import { discoveryRequest } from "../src/ai/model-discovery";
import { resolveProvider, qualifyModelId } from "../src/ai/model-manager";
import { describeProvider, allProviderNames, PROVIDER_NAMES } from "../src/ai/provider-status";

// The custom-provider store is module-global (it mirrors `config.customProviders`), so
// every test must leave it empty or the next file's provider lookups inherit it.
afterEach(() => clearCustomProviders());

// ---------------------------------------------------------------------------
// id / url / secret validation
// ---------------------------------------------------------------------------

test("provider ids normalize to lowercase and reject the shapes that would break routing", () => {
  expect(normalizeProviderId("  MyProxy ")).toBe("myproxy");
  expect(assertValidProviderId("My-Proxy.v2")).toBe("my-proxy.v2");

  // A `/` would collide with the `<provider>/<model>` routing separator.
  expect(() => assertValidProviderId("my/proxy")).toThrow(/Invalid provider id/);
  // Leading punctuation, spaces and empties are rejected before they reach config.
  expect(() => assertValidProviderId("-proxy")).toThrow(/Invalid provider id/);
  expect(() => assertValidProviderId("my proxy")).toThrow(/Invalid provider id/);
  expect(() => assertValidProviderId("   ")).toThrow(/required/);
  expect(() => assertValidProviderId("x".repeat(64))).toThrow(/too long/);
  // Built-ins are reserved so a user entry can never shadow a shipped provider.
  expect(() => assertValidProviderId("openai")).toThrow(/reserved/);
  expect(() => assertValidProviderId("anthropic")).toThrow(/reserved/);
});

test("base URLs must be absolute http(s); the path is preserved and the trailing slash dropped", () => {
  expect(normalizeCustomBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
  expect(normalizeCustomBaseUrl(" http://localhost:4000/openai/v1 ")).toBe("http://localhost:4000/openai/v1");
  // Origin-only URLs keep an empty path rather than gaining a stray "/".
  expect(normalizeCustomBaseUrl("https://api.example.com")).toBe("https://api.example.com");

  expect(() => normalizeCustomBaseUrl("localhost:1234/v1")).toThrow(/include the scheme/);
  expect(() => normalizeCustomBaseUrl("ftp://example.com")).toThrow(/http or https/);
  expect(() => normalizeCustomBaseUrl("")).toThrow(/required/);
});

test("secrets are redacted and never echoed in full", () => {
  expect(redactSecret("sk-proj-abcdefghijklmnop")).toBe("sk-p…mnop");
  expect(redactSecret("short")).toBe("***");
  expect(redactSecret("")).toBe("");
});

test("compat flag accepts the common spellings and rejects unsupported protocols", () => {
  expect(parseProviderCompatibility("OpenAI")).toBe("openai");
  expect(parseProviderCompatibility("oai")).toBe("openai");
  expect(parseProviderCompatibility("claude")).toBe("anthropic");
  expect(parseProviderCompatibility("anthropic-compatible")).toBe("anthropic");
  expect(() => parseProviderCompatibility("bedrock")).toThrow(/must be 'openai' or 'anthropic'/);
});

test("model lists flatten commas, trim, and dedupe while preserving order", () => {
  expect(parseModelList(["a, b", "b", " c "])).toEqual(["a", "b", "c"]);
  expect(parseModelList([])).toEqual([]);
});

test("default api key env is derived from the id with separators normalized", () => {
  expect(defaultApiKeyEnv("my-proxy")).toBe("MY_PROXY_API_KEY");
  expect(defaultApiKeyEnv("acme.gateway")).toBe("ACME_GATEWAY_API_KEY");
});

// ---------------------------------------------------------------------------
// def normalization
// ---------------------------------------------------------------------------

test("a custom entry normalizes into the SAME shape the built-in catalog uses", () => {
  const def = toCustomProviderDef("acme", {
    baseUrl: "https://api.acme.dev/v1/",
    models: ["acme/fast", "smart"],
    label: "ACME",
  });
  expect(def.custom).toBe(true);
  expect(def.name).toBe("acme");
  expect(def.label).toBe("ACME");
  expect(def.baseUrl).toBe("https://api.acme.dev/v1");
  expect(def.protocol).toBe("openai");
  expect(def.apiKeyEnv).toBe("ACME_API_KEY");
  // Model ids are stored BARE (the routing prefix is added by the catalog contract).
  expect(def.knownModels).toEqual(["fast", "smart"]);
  expect(def.defaultModel).toBe("acme/fast");
});

test("an explicit defaultModel wins and the anthropic protocol is preserved", () => {
  const def = toCustomProviderDef("corp-claude", {
    baseUrl: "https://claude.corp.internal",
    protocol: "anthropic",
    apiKeyEnv: "CORP_TOKEN",
    models: ["big", "small"],
    defaultModel: "small",
  });
  expect(def.protocol).toBe("anthropic");
  expect(def.apiKeyEnv).toBe("CORP_TOKEN");
  expect(def.defaultModel).toBe("corp-claude/small");
});

// ---------------------------------------------------------------------------
// registry behaviour
// ---------------------------------------------------------------------------

test("setCustomProviders skips bad rows instead of failing the whole config", () => {
  const { defs, errors } = setCustomProviders({
    good: { baseUrl: "https://ok.example.com/v1" },
    "bad id": { baseUrl: "https://ok.example.com/v1" },
    nourl: { baseUrl: "not-a-url" },
    openai: { baseUrl: "https://evil.example.com/v1" },
  });
  expect(defs.map(d => d.name)).toEqual(["good"]);
  expect(errors).toHaveLength(3);
  expect(errors.join("\n")).toMatch(/bad id/);
  expect(errors.join("\n")).toMatch(/reserved/);
  // One broken row never costs the user their working providers.
  expect(isCustomProvider("good")).toBe(true);
});

test("registered custom providers surface through the SAME lookup built-ins use", () => {
  setCustomProviders({ "my-proxy": { baseUrl: "https://gw.example.com/v1", models: ["m1"] } });

  expect(isOpenAICompatProvider("my-proxy")).toBe(true);
  // …but they are NOT compiled-in, which is what `isBuiltinCompatProvider` guards.
  expect(isBuiltinCompatProvider("my-proxy")).toBe(false);
  expect(isBuiltinCompatProvider("groq")).toBe(true);

  const def = openaiCompatDef("my-proxy");
  expect(def?.baseUrl).toBe("https://gw.example.com/v1");
  expect(allCompatNames()).toContain("my-proxy");
  expect(customProviderNames()).toEqual(["my-proxy"]);
});

test("a built-in id can never be shadowed by a stale custom row", () => {
  // `setCustomProviders` rejects reserved ids, but a catalog provider (e.g. groq) is not
  // in RESERVED_PROVIDER_IDS — the lookup itself must still prefer the built-in.
  setCustomProviders({ groq: { baseUrl: "https://impostor.example.com/v1" } });
  expect(openaiCompatDef("groq")?.baseUrl).toBe("https://api.groq.com/openai/v1");
});

test("model ids under a custom provider route and qualify like any other provider", () => {
  setCustomProviders({ acme: { baseUrl: "https://api.acme.dev/v1", models: ["fast"] } });
  expect(resolveProvider("acme/fast")).toBe("acme");
  expect(qualifyModelId("fast", "acme")).toBe("acme/fast");
  expect(qualifyModelId("acme/fast", "acme")).toBe("acme/fast");
});

test("discovery targets the custom endpoint with the right wire protocol", () => {
  setCustomProviders({
    oai: { baseUrl: "https://gw.example.com/v1" },
    ant: { baseUrl: "https://claude.example.com", protocol: "anthropic" },
  });

  const openai = discoveryRequest("oai", { kind: "api_key", provider: "openai", token: "tok" });
  expect(openai.url).toBe("https://gw.example.com/v1/models");
  expect(openai.headers.Authorization).toBe("Bearer tok");

  const anthropic = discoveryRequest("ant", { kind: "api_key", provider: "anthropic", token: "tok" });
  expect(anthropic.url).toBe("https://claude.example.com/v1/models");
  expect(anthropic.headers["x-api-key"]).toBe("tok");
  expect(anthropic.headers["anthropic-version"]).toBe("2023-06-01");
});

test("adapters are registered on change and unregistered on removal", () => {
  setCustomProviders({ tempo: { baseUrl: "https://tempo.example.com/v1" } });
  syncCustomProviderAdapters();
  expect(providerRegistry.has("tempo")).toBe(true);
  expect(providerRegistry.get("tempo")?.name).toBe("tempo");

  setCustomProviders({});
  syncCustomProviderAdapters();
  expect(providerRegistry.has("tempo")).toBe(false);
  // Removing a custom provider must never disturb the built-ins.
  expect(providerRegistry.has("anthropic")).toBe(true);
  expect(providerRegistry.has("groq")).toBe(true);
});

// ---------------------------------------------------------------------------
// credential resolution + status
// ---------------------------------------------------------------------------

test("env wins over a literal key so a rotated shell secret takes effect immediately", () => {
  const def = toCustomProviderDef("acme", { baseUrl: "https://api.acme.dev/v1", apiKey: "stored-key" });
  expect(resolveCustomApiKey(def, {})).toBe("stored-key");
  expect(credentialSourceOf(def, {})).toBe("literal");

  const env = { ACME_API_KEY: "env-key" } as unknown as NodeJS.ProcessEnv;
  expect(resolveCustomApiKey(def, env)).toBe("env-key");
  expect(credentialSourceOf(def, env)).toBe("env");

  const keyless = toCustomProviderDef("acme", { baseUrl: "https://api.acme.dev/v1" });
  expect(resolveCustomApiKey(keyless, {})).toBeUndefined();
  expect(credentialSourceOf(keyless, {})).toBe("none");
});

test("provider status reports a custom provider's own env var and readiness", async () => {
  setCustomProviders({ acme: { baseUrl: "https://api.acme.dev/v1", apiKey: "sk-abcdefghijkl" } });
  const cfg = { providers: {} } as never;

  const status = await describeProvider("acme", cfg);
  expect(status.custom).toBe(true);
  expect(status.baseUrl).toBe("https://api.acme.dev/v1");
  expect(status.envVar).toBe("ACME_API_KEY");
  expect(status.ready).toBe(true);
  expect(status.kind).toBe("api_key");
  // The stored key itself must never appear in a user-facing label.
  expect(status.label).not.toContain("sk-abcdefghijkl");

  setCustomProviders({ acme: { baseUrl: "https://api.acme.dev/v1" } });
  const missing = await describeProvider("acme", cfg);
  expect(missing.ready).toBe(false);
  expect(missing.label).toContain("ACME_API_KEY");
});

test("allProviderNames appends custom providers without mutating the built-in list", () => {
  const builtinCount = PROVIDER_NAMES.length;
  setCustomProviders({ acme: { baseUrl: "https://api.acme.dev/v1" } });
  const all = allProviderNames();
  expect(all).toContain("acme");
  expect(all.length).toBe(builtinCount + 1);
  // The exported built-in constant is untouched (other call sites rely on it).
  expect(PROVIDER_NAMES.length).toBe(builtinCount);
  expect(PROVIDER_NAMES).not.toContain("acme");
});

test("customProviderDef lookup is case-insensitive so /model MyProxy/x still routes", () => {
  setCustomProviders({ myproxy: { baseUrl: "https://gw.example.com/v1" } });
  expect(customProviderDef("MyProxy")?.name).toBe("myproxy");
  expect(customProviderDef("  myproxy  ")?.name).toBe("myproxy");
  expect(customProviderDef("nope")).toBeUndefined();
});
