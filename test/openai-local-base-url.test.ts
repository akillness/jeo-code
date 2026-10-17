import { afterEach, test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { credentialForCall, resolveCall } from "../src/ai/model-manager";
import { openAIOauthAccountScope } from "../src/ai/model-cache";
import { isLiveProviderModel, recordLiveCodexModels, recordLiveProviderModels, resetLiveCodexModels, resetLiveProviderModels } from "../src/ai/model-catalog";
import { CODEX_MODELS_URL } from "../src/ai/model-discovery";
import { CODEX_RESPONSES_URL } from "../src/ai/providers/openai-responses";
import type { Credential } from "../src/auth";

const oauth: Credential = { kind: "oauth", provider: "openai", token: "chatgpt-oauth-token" };
const base = "http://localhost:1234/v1";
test("credentialForCall: local OpenAI base URL + OAuth downgrades to keyless (avoids Codex)", () => {
  // OAuth would route to the hardcoded Codex backend and drop the base URL; downgrade to keyless
  // so the request actually hits the local server via /chat/completions.
  const out = credentialForCall("openai", oauth, { providers: {} }, base);
  expect(out.kind).toBe("none");
  expect(out.provider).toBe("openai");
});

test("credentialForCall: local OpenAI base URL prefers a configured api key over OAuth", () => {
  const out = credentialForCall("openai", oauth, { providers: { openai: "sk-local" } }, base);
  expect(out.kind).toBe("api_key");
  expect(out.kind === "api_key" && out.token).toBe("sk-local");
});

test("credentialForCall: OpenAI OAuth WITHOUT a base URL is preserved (Codex path)", () => {
  const out = credentialForCall("openai", oauth, { providers: {} }, undefined);
  expect(out).toBe(oauth); // unchanged → adapter routes via OAuth/Codex
});

test("credentialForCall: a non-openai provider is never downgraded by a base URL", () => {
  const anthropicOauth: Credential = { kind: "oauth", provider: "anthropic", token: "t" };
  expect(credentialForCall("anthropic", anthropicOauth, { providers: {} }, base)).toBe(anthropicOauth);
});

test("credentialForCall: a local api_key credential passes through unchanged", () => {
  const key: Credential = { kind: "api_key", provider: "openai", token: "sk-x" };
  expect(credentialForCall("openai", key, { providers: { openai: "sk-x" } }, base)).toBe(key);
});
const envKeys = ["JEO_CONFIG_DIR", "OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_OAUTH_TOKEN", "JEO_DEFAULT_MODEL"] as const;

function sseResponse(events: object[]): Response {
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function withConfigSandbox(config: Record<string, unknown>, run: () => Promise<void>): Promise<void> {
  const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  const dir = await mkdtemp(join(tmpdir(), "jeo-openai-local-"));
  try {
    for (const key of envKeys) delete process.env[key];
    process.env.JEO_CONFIG_DIR = dir;
    await writeFile(join(dir, "config.json"), JSON.stringify({ defaultModel: "gpt-5.5", ...config }), "utf8");
    resetLiveCodexModels();
    resetLiveProviderModels();
    await run();
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of envKeys) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetLiveCodexModels();
    resetLiveProviderModels();
    await rm(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  resetLiveCodexModels();
  resetLiveProviderModels();
});

test("resolveCall + OpenAI adapter: confirmed OAuth Codex models bypass configured proxy for call and stream", async () => {
  await withConfigSandbox({ providers: {}, oauth: { openai: { access: oauth.token } }, openaiBaseUrl: base }, async () => {
    const accountScope = await openAIOauthAccountScope(oauth);
    recordLiveCodexModels(["gpt-5.5", "gpt-6-codex"], accountScope);
    for (const kind of ["request", "stream"] as const) {
      for (const model of ["gpt-5.5", "gpt-6-codex"]) {
        const requests: { url: string; authorization: string | null; body: Record<string, unknown> }[] = [];
        globalThis.fetch = (async (input, init) => {
          const headers = new Headers(init?.headers);
          requests.push({ url: String(input), authorization: headers.get("authorization"), body: JSON.parse(String(init?.body)) });
          return sseResponse([{ type: "response.output_text.delta", delta: "codex-ok" }]);
        }) as typeof fetch;

        const resolved = await resolveCall({ model }, kind);
        expect(resolved.provider).toBe("openai");
        expect(resolved.credential).toEqual(oauth);
        expect(resolved.baseUrl).toBeUndefined();
        expect(resolved.callOptions.baseUrl).toBeUndefined();
        let text = "";
        if (kind === "request") text = await resolved.adapter.call([{ role: "user", content: "hi" }], resolved.callOptions, resolved.credential);
        else for await (const chunk of resolved.adapter.stream!([{ role: "user", content: "hi" }], resolved.callOptions, resolved.credential)) text += chunk;
        expect(text).toBe("codex-ok");
        expect(requests).toHaveLength(1);
        expect(requests[0]!.url).toBe(CODEX_RESPONSES_URL);
        expect(requests[0]!.url).not.toContain(base);
        expect(requests[0]!.authorization).toBe(`Bearer ${oauth.token}`);
        expect(requests[0]!.body.model).toBe(model);
      }
    }
  });
});

test("resolveCall cold-start discovery: configured proxy plus OAuth confirms a future Codex model before its Responses call", async () => {
  await withConfigSandbox({ providers: {}, oauth: { openai: { access: oauth.token } }, openaiBaseUrl: base }, async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      requests.push(url);
      if (url === CODEX_MODELS_URL) {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${oauth.token}`);
        expect(headers.get("chatgpt-account-id")).toBeNull();
        return new Response(JSON.stringify({ models: [{ slug: "gpt-7-codex" }] }), { status: 200 });
      }
      expect(url).toBe(CODEX_RESPONSES_URL);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${oauth.token}`);
      return sseResponse([{ type: "response.output_text.delta", delta: "future-ok" }]);
    }) as typeof fetch;

    const resolved = await resolveCall({ model: "gpt-7-codex" });
    expect(resolved.credential).toEqual(oauth);
    expect(resolved.baseUrl).toBeUndefined();
    const text = await resolved.adapter.call([{ role: "user", content: "hi" }], resolved.callOptions, resolved.credential);
    expect(text).toBe("future-ok");
    expect(requests).toEqual([CODEX_MODELS_URL, CODEX_RESPONSES_URL]);
  });
});
test("resolveCall discovery forwards a real JWT account id but never derives one from opaque tokens", async () => {
  const accountId = "acct-real-codex";
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
  const jwtOAuth: Credential = { kind: "oauth", provider: "openai", token: `header.${payload}.signature` };
  await withConfigSandbox({ providers: {}, oauth: { openai: { access: jwtOAuth.token } }, openaiBaseUrl: base }, async () => {
    const requests: { url: string; accountId: string | null }[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, accountId: headers.get("chatgpt-account-id") });
      if (url === CODEX_MODELS_URL) return new Response(JSON.stringify({ models: [{ slug: "gpt-8-codex" }] }), { status: 200 });
      expect(url).toBe(CODEX_RESPONSES_URL);
      return sseResponse([{ type: "response.output_text.delta", delta: "jwt-ok" }]);
    }) as typeof fetch;
    const resolved = await resolveCall({ model: "gpt-8-codex" });
    expect(resolved.credential).toEqual(jwtOAuth);
    expect(await resolved.adapter.call([{ role: "user", content: "hi" }], resolved.callOptions, resolved.credential)).toBe("jwt-ok");
    expect(requests[0]).toEqual({ url: CODEX_MODELS_URL, accountId });
    expect(requests[1]).toEqual({ url: CODEX_RESPONSES_URL, accountId });
  });
});
test("resolveCall fails closed when OAuth credentials switch during Codex discovery", async () => {
  const tokenA: Credential = { kind: "oauth", provider: "openai", token: "opaque-token-a" };
  const tokenB: Credential = { kind: "oauth", provider: "openai", token: "opaque-token-b" };
  await withConfigSandbox({ providers: {}, oauth: { openai: { access: tokenA.token } }, openaiBaseUrl: base }, async () => {
    let releaseDiscovery!: () => void;
    let markDiscoveryStarted!: () => void;
    const discoveryStarted = new Promise<void>(resolve => { markDiscoveryStarted = resolve; });
    const discoveryGate = new Promise<void>(resolve => { releaseDiscovery = resolve; });
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === CODEX_MODELS_URL) {
        markDiscoveryStarted();
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${tokenA.token}`);
        await discoveryGate;
        return new Response(JSON.stringify({ models: [{ slug: "gpt-account-switch-codex" }] }), { status: 200 });
      }
      throw new Error(`unexpected request before account-switch guard: ${url}`);
    }) as typeof fetch;
    const inFlight = resolveCall({ model: "gpt-account-switch-codex" });
    await discoveryStarted;
    await writeFile(join(process.env.JEO_CONFIG_DIR!, "config.json"), JSON.stringify({
      defaultModel: "gpt-5.5",
      providers: {},
      oauth: { openai: { access: tokenB.token } },
      openaiBaseUrl: base,
    }), "utf8");
    releaseDiscovery();
    await expect(inFlight).rejects.toThrow("OpenAI credential changed during model discovery; retry the request.");

    const requests: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      requests.push(url);
      if (url === CODEX_MODELS_URL) {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${tokenB.token}`);
        return new Response("unavailable", { status: 503 });
      }
      expect(url).toContain(base);
      return new Response(JSON.stringify({ choices: [{ message: { content: "account-b-proxy" }, finish_reason: "stop" }] }), { status: 200 });
    }) as typeof fetch;
    const currentB = await resolveCall({ model: "gpt-account-switch-codex" });
    expect(currentB.baseUrl).toBe(base);
    expect(currentB.callOptions.baseUrl).toBe(base);
    expect(await currentB.adapter.call([{ role: "user", content: "hi" }], currentB.callOptions, currentB.credential)).toBe("account-b-proxy");
    expect(requests).toContain(CODEX_MODELS_URL);
    expect(requests.at(-1)).toBe(`${base}/chat/completions`);
  });
});

test("concurrent cold OAuth Codex resolves share one catalog GET", async () => {
  await withConfigSandbox({ providers: {}, oauth: { openai: { access: oauth.token } }, openaiBaseUrl: base }, async () => {
    let discoveryCalls = 0;
    let releaseDiscovery!: () => void;
    let markDiscoveryStarted!: () => void;
    const discoveryStarted = new Promise<void>(resolve => { markDiscoveryStarted = resolve; });
    const discoveryGate = new Promise<void>(resolve => { releaseDiscovery = resolve; });
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === CODEX_MODELS_URL) {
        discoveryCalls += 1;
        markDiscoveryStarted();
        await discoveryGate;
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${oauth.token}`);
        return new Response(JSON.stringify({ models: [{ slug: "gpt-concurrent-codex" }] }), { status: 200 });
      }
      expect(url).toBe(CODEX_RESPONSES_URL);
      return sseResponse([{ type: "response.output_text.delta", delta: "concurrent-ok" }]);
    }) as typeof fetch;
    const first = resolveCall({ model: "gpt-concurrent-codex" });
    const second = resolveCall({ model: "gpt-concurrent-codex" });
    await discoveryStarted;
    await Promise.resolve();
    releaseDiscovery();
    const [resolvedFirst, resolvedSecond] = await Promise.all([first, second]);
    expect(discoveryCalls).toBe(1);
    expect(resolvedFirst.baseUrl).toBeUndefined();
    expect(resolvedSecond.baseUrl).toBeUndefined();
  });
});
test("canceling one concurrent Codex resolver does not cancel the shared discovery for another waiter", async () => {
  await withConfigSandbox({ providers: {}, oauth: { openai: { access: oauth.token } }, openaiBaseUrl: base }, async () => {
    let releaseDiscovery!: () => void;
    let markDiscoveryStarted!: () => void;
    const discoveryStarted = new Promise<void>(resolve => { markDiscoveryStarted = resolve; });
    const discoveryGate = new Promise<void>(resolve => { releaseDiscovery = resolve; });
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === CODEX_MODELS_URL) {
        markDiscoveryStarted();
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${oauth.token}`);
        await discoveryGate;
        return new Response(JSON.stringify({ models: [{ slug: "gpt-cancel-waiter-codex" }] }), { status: 200 });
      }
      expect(url).toBe(CODEX_RESPONSES_URL);
      return sseResponse([{ type: "response.output_text.delta", delta: "waiter-ok" }]);
    }) as typeof fetch;
    const controller = new AbortController();
    const canceled = resolveCall({ model: "gpt-cancel-waiter-codex", signal: controller.signal });
    const retained = resolveCall({ model: "gpt-cancel-waiter-codex" });
    await discoveryStarted;
    controller.abort();
    releaseDiscovery();
    await expect(canceled).rejects.toMatchObject({ name: "AbortError" });
    const resolved = await retained;
    expect(resolved.baseUrl).toBeUndefined();
    expect(await resolved.adapter.call([{ role: "user", content: "hi" }], resolved.callOptions, resolved.credential)).toBe("waiter-ok");
  });
});

test("resolveCall keeps explicit and configured endpoint behavior for OAuth, endpoint-discovered shared Codex, unknown local ids, failed bundled Codex discovery, empty account catalog, and empty keyless setup", async () => {
  const cases = [
    { name: "per-call base URL override", config: { providers: {}, oauth: { openai: { access: oauth.token } }, openaiBaseUrl: base }, model: "gpt-5.5", options: { baseUrl: `${base}/override` }, expectedBase: `${base}/override`, expectedAuth: "Bearer no-key" },
    { name: "configured proxy API key", config: { providers: { openai: "proxy-key" }, oauth: { openai: { access: oauth.token } }, openaiBaseUrl: base }, model: "gpt-5.5", options: {}, expectedBase: base, expectedAuth: "Bearer proxy-key" },
    { name: "endpoint-discovered shared Codex", config: { providers: {}, oauth: { openai: { access: oauth.token } }, openaiBaseUrl: base }, model: "gpt-5.5", options: {}, expectedBase: base, expectedAuth: "Bearer no-key", discovered: true },
    { name: "unknown non-Codex local id", config: { providers: {}, oauth: { openai: { access: oauth.token } }, openaiBaseUrl: base }, model: "openai/local-coder", options: {}, expectedBase: base, expectedAuth: "Bearer no-key", discoveryFailure: true },
    { name: "failed bundled Codex discovery", config: { providers: {}, oauth: { openai: { access: oauth.token } }, openaiBaseUrl: base }, model: "gpt-5.5", options: {}, expectedBase: base, expectedAuth: "Bearer no-key", discoveryFailure: true },
    { name: "empty OAuth account catalog", config: { providers: {}, oauth: { openai: { access: oauth.token } }, openaiBaseUrl: base }, model: "gpt-5.5", options: {}, expectedBase: base, expectedAuth: "Bearer no-key", emptyCatalog: true },
    { name: "empty keyless local config", config: { providers: {}, oauth: {}, openaiBaseUrl: base }, model: "openai/local-coder", options: {}, expectedBase: base, expectedAuth: "Bearer no-key", discoveryFailure: true },
  ] as const;

  for (const c of cases) {
    await withConfigSandbox(c.config, async () => {
      if (c.discovered) {
        recordLiveProviderModels("openai", [c.model], { source: "keyless", baseUrl: base });
        expect(isLiveProviderModel("openai", c.model, { openaiBaseUrl: base })).toBe(true);
      }
      const requests: { url: string; authorization: string | null }[] = [];
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        const authorization = new Headers(init?.headers).get("authorization");
        requests.push({ url, authorization });
        if (c.discoveryFailure && (url === CODEX_MODELS_URL || url === `${base}/models`)) return new Response("unavailable", { status: 503 });
        if (c.emptyCatalog && url === CODEX_MODELS_URL) return new Response(JSON.stringify({ models: [] }), { status: 200 });
        expect(url).toContain(c.expectedBase);
        return new Response(JSON.stringify({ choices: [{ message: { content: "proxy-ok" }, finish_reason: "stop" }] }), { status: 200 });
      }) as typeof fetch;
      const resolved = await resolveCall({ model: c.model, ...c.options });
      expect(resolved.baseUrl).toBe(c.expectedBase);
      expect(resolved.callOptions.baseUrl).toBe(c.expectedBase);
      expect(resolved.credential.kind).toBe(c.expectedAuth === "Bearer no-key" ? "none" : "api_key");
      const text = await resolved.adapter.call([{ role: "user", content: "hi" }], resolved.callOptions, resolved.credential);
      expect(text).toBe("proxy-ok");
      expect(requests.at(-1)?.url).toBe(`${c.expectedBase}/chat/completions`);
      expect(requests.at(-1)?.authorization).toBe(c.expectedAuth);
    });
  }
});

