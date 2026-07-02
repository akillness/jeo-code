import { test, expect } from "bun:test";
import { resolveProvider, providerModelFor, effectiveCredentialForProvider } from "../src/ai/model-manager";
import { kimiAdapter, KIMI_BASE_URL, KIMI_ANTHROPIC_BASE_URL } from "../src/ai/providers/kimi";
import { anthropicRequest } from "../src/ai/providers/anthropic";
import { findCatalogModel, KIMI_CODE_MODELS } from "../src/ai/model-catalog";
import { catalogOr } from "../src/ai/model-discovery";
import { OAUTH_FLOW_REGISTRY } from "../src/auth/flows";
import { OAUTH_PROVIDERS, isOAuthProvider } from "../src/auth/storage";
import { getKimiCommonHeaders } from "../src/auth/flows/kimi";
import type { Credential } from "../src/auth";
import type { CallOptions } from "../src/ai/types";

// Kimi Code OAuth (device-code) — gjc parity: OAuth serves the Anthropic-compatible
// api.kimi.com/coding backend; an API key serves the OpenAI-compatible moonshot API.

const OAUTH_CRED: Credential = { kind: "oauth", provider: "kimi", token: "kimi-oauth-token" };
const KEY_CRED: Credential = { kind: "api_key", provider: "kimi", token: "kimi-api-key" };

test("kimi is a registered OAuth provider with a device-code flow", () => {
  expect(OAUTH_PROVIDERS).toContain("kimi");
  expect(isOAuthProvider("kimi")).toBe(true);
  const flow = OAUTH_FLOW_REGISTRY.kimi;
  expect(flow.provider).toBe("kimi");
  expect(flow.verifiedEndToEnd).toBe(true);
  expect(typeof flow.login).toBe("function");
  expect(typeof flow.refresh).toBe("function");
});

test("kimi code models are catalogued and route to the kimi provider", () => {
  expect(resolveProvider("kimi-for-coding")).toBe("kimi");
  expect(resolveProvider("kimi/kimi-k2.5")).toBe("kimi");
  const forCoding = findCatalogModel("kimi-for-coding");
  expect(forCoding?.provider).toBe("kimi");
  expect(forCoding?.contextTokens).toBe(262_144);
  expect(forCoding!.thinking.length).toBeGreaterThan(0);
  // canonical → provider-qualified wire id (adapter strips the prefix)
  expect(providerModelFor("kimi-for-coding")).toBe("kimi/kimi-for-coding");
  // tencent's kimi-k2.5 canonical stays tencent-routed; the kimi/ qualified one is kimi's
  expect(findCatalogModel("kimi-k2.5")?.provider).toBe("tencent");
  expect(findCatalogModel("kimi/kimi-k2.5")?.provider).toBe("kimi");
});

test("kimi OAuth request targets api.kimi.com/coding with Bearer + X-Msh headers (no Claude-Code cloaking)", () => {
  const options: CallOptions = {
    model: "kimi-for-coding",
    systemPrompt: "sys",
    maxTokens: 1000,
    baseUrl: KIMI_ANTHROPIC_BASE_URL,
    extraHeaders: getKimiCommonHeaders(),
  };
  const req = anthropicRequest([{ role: "user", content: "hi" }], options, OAUTH_CRED, false, true);
  expect(req.url).toBe("https://api.kimi.com/coding/v1/messages");
  expect(req.headers.authorization).toBe("Bearer kimi-oauth-token");
  // Kimi device identification headers ride along on API calls (gjc parity).
  expect(req.headers["X-Msh-Platform"]).toBe("kimi_cli");
  expect(req.headers["X-Msh-Device-Id"]).toBeTruthy();
  // NO Claude-Code OAuth cloaking against a non-Anthropic base:
  expect(req.headers["anthropic-beta"]).toBeUndefined();
  expect(req.headers["user-agent"]).toBeUndefined();
  const payload = JSON.parse(req.body) as { system?: { text: string }[]; metadata?: unknown };
  expect(payload.metadata).toBeUndefined(); // no cloaking user_id
  const sysTexts = (payload.system ?? []).map(b => b.text);
  expect(sysTexts.some(t => t.includes("Claude"))).toBe(false); // no Claude-Code system prelude
});

test("kimiAdapter dispatches by credential kind: OAuth → kimi.com Anthropic; api_key → moonshot OpenAI", async () => {
  const seen: { url: string; auth?: string; body: Record<string, unknown> }[] = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({
      url: String(url),
      auth: headers.authorization ?? headers.Authorization,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    // Minimal valid non-stream bodies for each protocol:
    if (String(url).includes("kimi.com")) {
      return new Response(JSON.stringify({ content: [{ type: "text", text: "kimi-code-reply" }] }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "moonshot-reply" }, finish_reason: "stop" }] }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const oauthReply = await kimiAdapter.call(
      [{ role: "user", content: "hi" }],
      { model: "kimi/kimi-for-coding", maxTokens: 100 },
      OAUTH_CRED,
    );
    expect(oauthReply).toBe("kimi-code-reply");
    expect(seen[0].url).toBe("https://api.kimi.com/coding/v1/messages");
    expect(seen[0].auth).toBe("Bearer kimi-oauth-token");
    expect(seen[0].body.model).toBe("kimi-for-coding"); // kimi/ prefix stripped on the wire

    const keyReply = await kimiAdapter.call(
      [{ role: "user", content: "hi" }],
      { model: "kimi/kimi-latest", maxTokens: 100 },
      KEY_CRED,
    );
    expect(keyReply).toBe("moonshot-reply");
    expect(seen[1].url).toBe(`${KIMI_BASE_URL}/chat/completions`);
    expect(seen[1].auth).toBe("Bearer kimi-api-key");
    expect(seen[1].body.model).toBe("kimi-latest");
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("effectiveCredentialForProvider: kimi OAuth serves Kimi Code models; falls back to API key for moonshot ids", () => {
  // Kimi Code model → OAuth wins even when an API key is also configured.
  const oauthWins = effectiveCredentialForProvider("kimi", OAUTH_CRED, { providers: { kimi: "mk" } }, "kimi-for-coding");
  expect(oauthWins.kind).toBe("oauth");

  // Moonshot API id → OAuth cannot serve it; the configured API key takes over.
  const keyFallback = effectiveCredentialForProvider("kimi", OAUTH_CRED, { providers: { kimi: "mk" } }, "kimi-latest");
  expect(keyFallback).toEqual({ kind: "api_key", provider: "kimi", token: "mk" });

  // Provider-qualified wire id resolves the same as its bare form.
  const qualified = effectiveCredentialForProvider("kimi", OAUTH_CRED, { providers: {} }, "kimi/kimi-k2.5");
  expect(qualified.kind).toBe("oauth");
});

test("catalogOr: kimi OAuth fallback lists ONLY Kimi Code models (no moonshot ids)", () => {
  const result = catalogOr({ provider: "kimi", models: [], ok: false, source: "oauth", error: "auth rejected" });
  expect(result.ok).toBe(true);
  expect(result.fallback).toBe(true);
  expect(result.models).toEqual(KIMI_CODE_MODELS.map(id => `kimi/${id}`));
  expect(result.models.some(m => m.includes("moonshot"))).toBe(false);
  expect(result.models.some(m => m.includes("kimi-latest"))).toBe(false);
});

test("kimi API-key discovery fallback (404 route) still lists the full kimi catalog", () => {
  const result = catalogOr({ provider: "kimi", models: [], ok: false, source: "api_key", error: "HTTP 404" });
  expect(result.ok).toBe(true);
  // API key serves the moonshot catalog; Kimi Code entries are also present as catalog rows.
  expect(result.models).toContain("kimi-latest");
});
