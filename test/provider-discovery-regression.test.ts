import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createModelManager } from "../src/ai/model-manager";
import { catalogOr, listProviderModels } from "../src/ai/model-discovery";
import { readGlobalConfig } from "../src/agent/state";
import { findLiveCatalogModel, isLiveProviderModel, liveProviderCatalogModels, resetLiveKimiCodeModels, resetLiveProviderModels } from "../src/ai/model-catalog";
import { clearCustomProviders } from "../src/ai/providers/custom-providers";
import { selectDiscordModel } from "../src/messenger/model-selection";
import { applyCachedModels } from "../src/ai/model-cache";

async function fixture(run: (writeConfig: (config: object) => Promise<void>) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-provider-regression-"));
  const previousFetch = globalThis.fetch;
  const keys = ["JEO_CONFIG_DIR", "KIMI_API_KEY", "KIMI_OAUTH_TOKEN", "LOCAL_GATEWAY_API_KEY", "GEMINI_API_KEY", "GEMINI_OAUTH_TOKEN"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.JEO_CONFIG_DIR = dir;
  for (const key of keys.slice(1)) delete process.env[key];
  resetLiveKimiCodeModels();
  resetLiveProviderModels();
  try {
    await run(async config => { await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ defaultModel: "gpt-5", ...config })); });
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    resetLiveKimiCodeModels();
    resetLiveProviderModels();
    clearCustomProviders();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const message = [{ role: "user" as const, content: "hello" }];

test("cold Kimi OAuth call discovers a new model before using the subscription endpoint", async () => {
  await fixture(async writeConfig => {
    await writeConfig({ providers: {}, oauth: { kimi: "oauth-a" } });
    const seen: { url: string; authorization: string | null; model?: string }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, authorization: new Headers(init?.headers).get("authorization"), model: init?.body ? JSON.parse(String(init.body)).model : undefined });
      return new Response(JSON.stringify(url.endsWith("/models")
        ? { data: [{ id: "kimi-new-subscription-model" }] }
        : { content: [{ type: "text", text: "subscription reply" }] }), { status: 200 });
    }) as typeof fetch;
    expect(await createModelManager().call(message, { model: "kimi/kimi-new-subscription-model" })).toBe("subscription reply");
    expect(seen).toEqual([
      { url: "https://api.kimi.com/coding/v1/models", authorization: "Bearer oauth-a", model: undefined },
      { url: "https://api.kimi.com/coding/v1/messages", authorization: "Bearer oauth-a", model: "kimi-new-subscription-model" },
    ]);
  });
});

test("Kimi OAuth discovery cannot authorize a model for a different account", async () => {
  await fixture(async writeConfig => {
    await writeConfig({ providers: {}, oauth: { kimi: "oauth-a" } });
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      requests.push(`${String(input)} ${authorization}`);
      return new Response(JSON.stringify(String(input).endsWith("/models")
        ? { data: authorization === "Bearer oauth-a" ? [{ id: "kimi-account-a-only" }] : [{ id: "kimi-account-b-only" }] }
        : { content: [{ type: "text", text: "account a reply" }] }), { status: 200 });
    }) as typeof fetch;
    const manager = createModelManager();
    expect(await manager.call(message, { model: "kimi/kimi-account-a-only" })).toBe("account a reply");
    await writeConfig({ providers: {}, oauth: { kimi: "oauth-b" } });
    await expect(manager.call(message, { model: "kimi/kimi-account-a-only" })).rejects.toThrow("Kimi OAuth");
    expect(requests).toEqual([
      "https://api.kimi.com/coding/v1/models Bearer oauth-a",
      "https://api.kimi.com/coding/v1/messages Bearer oauth-a",
      "https://api.kimi.com/coding/v1/models Bearer oauth-b",
    ]);
  });
});

test("rejected Kimi discovery never authorizes an unknown model", async () => {
  await fixture(async writeConfig => {
    await writeConfig({ providers: {}, oauth: { kimi: "oauth-denied" } });
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response("unauthorized", { status: 401 });
    }) as typeof fetch;
    await expect(createModelManager().call(message, { model: "kimi/kimi-not-authorized" })).rejects.toThrow("Kimi OAuth");
    expect(requests).toEqual(["https://api.kimi.com/coding/v1/models"]);
  });
});

test("an empty Kimi subscription catalog revokes previously discovered models", async () => {
  await fixture(async writeConfig => {
    await writeConfig({ providers: {}, oauth: { kimi: "oauth-empty-test" } });
    let listing = 0;
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: listing++ === 0 ? [{ id: "kimi-revoked-model" }] : [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ content: [{ type: "text", text: "allowed" }] }), { status: 200 });
    }) as typeof fetch;
    const manager = createModelManager();
    expect(await manager.call(message, { model: "kimi/kimi-revoked-model" })).toBe("allowed");
    const refresh = await listProviderModels("kimi", { preferOAuth: true });
    expect(refresh).toMatchObject({ ok: true, source: "oauth", models: [] });
    await expect(manager.call(message, { model: "kimi/kimi-revoked-model" })).rejects.toThrow("Kimi OAuth");
    expect(requests.filter(url => url.endsWith("/messages"))).toEqual(["https://api.kimi.com/coding/v1/messages"]);
  });
});

test.each([401, 403])("Kimi OAuth discovery HTTP %i stays a failure without catalog fallback", async status => {
  await fixture(async writeConfig => {
    await writeConfig({ providers: {}, oauth: { kimi: `oauth-${status}` } });
    const result = await listProviderModels("kimi", { fetchImpl: (async () => new Response("denied", { status })) as typeof fetch });
    expect(catalogOr(result)).toMatchObject({ ok: false, source: "oauth", error: "auth rejected", models: [] });
  });
});

test("aborting one Kimi caller does not cancel another caller's shared discovery", async () => {
  await fixture(async writeConfig => {
    await writeConfig({ providers: {}, oauth: { kimi: "oauth-concurrent" } });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let listings = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/models")) {
        listings++;
        started.resolve();
        await release.promise;
        return new Response(JSON.stringify({ data: [{ id: "kimi-concurrent-model" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ content: [{ type: "text", text: "survived" }] }), { status: 200 });
    }) as typeof fetch;
    const manager = createModelManager();
    const controller = new AbortController();
    const first = manager.call(message, { model: "kimi/kimi-concurrent-model", signal: controller.signal });
    await started.promise;
    const second = manager.call(message, { model: "kimi/kimi-concurrent-model" });
    controller.abort(new Error("caller cancelled"));
    await expect(first).rejects.toThrow("caller cancelled");
    release.resolve();
    expect(await second).toBe("survived");
    expect(listings).toBe(1);
  });
});

test("unknown Kimi model uses the configured API key without probing the OAuth catalog", async () => {
  await fixture(async writeConfig => {
    await writeConfig({ providers: { kimi: "moonshot-key" }, oauth: { kimi: "oauth-private" } });
    const requests: { url: string; authorization: string | null; model: string }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization"), model: JSON.parse(String(init?.body)).model });
      return new Response(JSON.stringify({ choices: [{ message: { content: "key reply" }, finish_reason: "stop" }] }), { status: 200 });
    }) as typeof fetch;
    expect(await createModelManager().call(message, { model: "kimi/kimi-api-unknown" })).toBe("key reply");
    expect(requests).toEqual([{ url: "https://api.moonshot.ai/v1/chat/completions", authorization: "Bearer moonshot-key", model: "kimi-api-unknown" }]);
  });
});

test("named keyless provider discovers and serves models without leaking OAuth credentials", async () => {
  await fixture(async writeConfig => {
    await writeConfig({ providers: {}, oauth: { openai: "private-oauth" }, customProviders: { "local-gateway": { baseUrl: "https://gateway.example/v1" } } });
    const requests: { url: string; authorization: string | null; model?: string }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, authorization: new Headers(init?.headers).get("authorization"), model: init?.body ? JSON.parse(String(init.body)).model : undefined });
      return new Response(JSON.stringify(url.endsWith("/models")
        ? { data: [{ id: "local-model" }] }
        : { choices: [{ message: { content: "local reply" }, finish_reason: "stop" }] }), { status: 200 });
    }) as typeof fetch;
    await readGlobalConfig();
    const discovered = await listProviderModels("local-gateway");
    expect(discovered).toMatchObject({ ok: true, source: "keyless", models: ["local-gateway/local-model"] });
    expect(await createModelManager().call(message, { model: "local-gateway/local-model" })).toBe("local reply");
    expect(requests).toEqual([
      { url: "https://gateway.example/v1/models", authorization: null, model: undefined },
      { url: "https://gateway.example/v1/chat/completions", authorization: null, model: "local-model" },
    ]);
  });
});

test("named keyless Anthropic gateway discovers and serves without credentials", async () => {
  await fixture(async writeConfig => {
    await writeConfig({ providers: {}, oauth: { anthropic: "private-anthropic-oauth" }, customProviders: { "local-gateway": { baseUrl: "https://gateway.example", protocol: "anthropic" } } });
    const requests: { url: string; authorization: string | null; apiKey: string | null; model?: string }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, authorization: headers.get("authorization"), apiKey: headers.get("x-api-key"), model: init?.body ? JSON.parse(String(init.body)).model : undefined });
      return new Response(JSON.stringify(url.endsWith("/models")
        ? { data: [{ id: "local-claude" }] }
        : { content: [{ type: "text", text: "gateway reply" }] }), { status: 200 });
    }) as typeof fetch;
    await readGlobalConfig();
    expect(await listProviderModels("local-gateway")).toMatchObject({ ok: true, source: "keyless", models: ["local-gateway/local-claude"] });
    expect(await createModelManager().call(message, { model: "local-gateway/local-claude" })).toBe("gateway reply");
    expect(requests).toEqual([
      { url: "https://gateway.example/v1/models", authorization: null, apiKey: null, model: undefined },
      { url: "https://gateway.example/v1/messages", authorization: null, apiKey: null, model: "local-claude" },
    ]);
  });
});

test("Discord discovers Gemini models with the runtime API key even when OAuth is configured", async () => {
  await fixture(async writeConfig => {
    await writeConfig({ providers: { gemini: "gemini-key" }, oauth: { gemini: "gemini-oauth" } });
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ models: [{ name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] }] }), { status: 200 });
    }) as typeof fetch;
    const cfg = await readGlobalConfig();
    expect(await selectDiscordModel("gemini-2.5-pro", { config: cfg })).toBe("gemini-2.5-pro");
    expect(requests).toEqual(["https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=gemini-key"]);
  });
});

test("Discord selects a named keyless gateway model only when discovery lists it", async () => {
  await fixture(async writeConfig => {
    await writeConfig({ providers: {}, customProviders: { "local-gateway": { baseUrl: "https://gateway.example/v1" } } });
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ data: [{ id: "local-model" }] }), { status: 200 });
    }) as typeof fetch;
    const cfg = await readGlobalConfig();
    expect(await selectDiscordModel("local-gateway/local-model", { config: cfg })).toBe("local-gateway/local-model");
    await expect(selectDiscordModel("local-gateway/missing", { config: cfg })).rejects.toThrow();
    expect(requests).toEqual(["https://gateway.example/v1/models", "https://gateway.example/v1/models"]);
  });
});

test.each(["local-gateway", "ollama", "lmstudio"] as const)("%s endpoint changes exclude prior host models from the live and restored catalog", async provider => {
  await fixture(async writeConfig => {
    const configFor = (baseUrl: string) => provider === "local-gateway"
      ? { providers: {}, customProviders: { "local-gateway": { baseUrl } } }
      : { providers: {}, [provider === "ollama" ? "ollamaBaseUrl" : "lmstudioBaseUrl"]: baseUrl };
    const oldBase = "https://old-host.example/v1";
    const newBase = "https://new-host.example/v1";
    globalThis.fetch = (async (input: string | URL | Request) => {
      const id = String(input).startsWith(oldBase) ? "host-a-model" : "host-b-model";
      return new Response(JSON.stringify(provider === "ollama" ? { models: [{ name: id }] } : { data: [{ id }] }), { status: 200 });
    }) as typeof fetch;
    await writeConfig(configFor(oldBase));
    const oldConfig = await readGlobalConfig();
    const oldResult = await listProviderModels(provider, { config: oldConfig });
    expect(oldResult).toMatchObject({ ok: true, baseUrl: oldBase, models: [`${provider}/host-a-model`] });
    expect(liveProviderCatalogModels().some(row => row.canonical === `${provider}/host-a-model`)).toBe(true);

    await writeConfig(configFor(newBase));
    const newConfig = await readGlobalConfig();
    expect(liveProviderCatalogModels().some(row => row.canonical === `${provider}/host-a-model`)).toBe(false);
    expect(findLiveCatalogModel(`${provider}/host-a-model`)).toBeUndefined();
    applyCachedModels({ version: 3, updatedAt: Date.now(), providers: [{ provider, source: "keyless", baseUrl: oldBase, models: [`${provider}/host-a-model`] }] });
    expect(liveProviderCatalogModels().some(row => row.canonical === `${provider}/host-a-model`)).toBe(false);
    expect(findLiveCatalogModel(`${provider}/host-a-model`)).toBeUndefined();

    const newResult = await listProviderModels(provider, { config: newConfig });
    expect(newResult).toMatchObject({ ok: true, models: [`${provider}/host-b-model`] });
    expect(liveProviderCatalogModels().some(row => row.canonical === `${provider}/host-b-model`)).toBe(true);
  });
});

test.each(["api_key", "keyless"] as const)("Kimi %s proxy models remain scoped to their endpoint and never appear in cloud catalog", async source => {
  await fixture(async writeConfig => {
    await writeConfig({ providers: source === "api_key" ? { kimi: "kimi-api-key" } : {} });
    const oldBase = "https://old-kimi.example/v1";
    const newBase = "https://new-kimi.example/v1";
    const requests: { url: string; authorization: string | null }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      const id = url.startsWith(oldBase) ? "kimi-proxy-old" : url.startsWith(newBase) ? "kimi-proxy-new" : "kimi-cloud-only";
      return new Response(JSON.stringify({ data: [{ id }] }), { status: 200 });
    }) as typeof fetch;
    const config = await readGlobalConfig();
    expect(await listProviderModels("kimi", { config, baseUrl: oldBase, fetchImpl })).toMatchObject({ ok: true, source, models: ["kimi-proxy-old"], baseUrl: oldBase });
    expect(await listProviderModels("kimi", { config, baseUrl: newBase, fetchImpl })).toMatchObject({ ok: true, source, models: ["kimi-proxy-new"], baseUrl: newBase });
    expect(isLiveProviderModel("kimi", "kimi-proxy-old", { kimiBaseUrl: oldBase })).toBe(true);
    expect(isLiveProviderModel("kimi", "kimi-proxy-old", { kimiBaseUrl: newBase })).toBe(false);
    expect(isLiveProviderModel("kimi", "kimi-proxy-new", { kimiBaseUrl: newBase })).toBe(true);
    expect(liveProviderCatalogModels().some(row => row.canonical === "kimi-proxy-old" || row.canonical === "kimi-proxy-new")).toBe(false);
    if (source === "api_key") {
      expect(await listProviderModels("kimi", { config, fetchImpl })).toMatchObject({ ok: true, models: ["kimi-cloud-only"] });
      expect(isLiveProviderModel("kimi", "kimi-cloud-only")).toBe(true);
    }
    expect(requests[0]).toEqual({ url: `${oldBase}/models`, authorization: source === "api_key" ? "Bearer kimi-api-key" : null });
    expect(requests[1]).toEqual({ url: `${newBase}/models`, authorization: source === "api_key" ? "Bearer kimi-api-key" : null });
  });
});
