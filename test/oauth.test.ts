import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { generatePKCE, generateState } from "../src/auth/pkce";
import { OAuthCallbackFlow, parseCallbackInput } from "../src/auth/callback-server";
import type { OAuthController, OAuthCredentials } from "../src/auth/types";
import { googleClientSecret } from "../src/auth/flows/google";

test("generatePKCE: challenge is base64url(SHA-256(verifier))", async () => {
  const { verifier, challenge } = await generatePKCE();
  expect(verifier.length).toBeGreaterThan(80);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const expected = Buffer.from(digest).toString("base64url");
  expect(challenge).toBe(expected);
  // base64url: no +, /, or = padding
  expect(challenge).not.toMatch(/[+/=]/);
});

test("generateState: 32-char hex, unique per call", () => {
  const a = generateState();
  const b = generateState();
  expect(a).toMatch(/^[0-9a-f]{32}$/);
  expect(a).not.toBe(b);
});

test("parseCallbackInput: URL, query string, and raw code#state forms", () => {
  expect(parseCallbackInput("http://localhost:54545/callback?code=abc&state=xyz")).toEqual({
    code: "abc",
    state: "xyz",
  });
  expect(parseCallbackInput("?code=abc&state=xyz")).toEqual({ code: "abc", state: "xyz" });
  expect(parseCallbackInput("rawcode#rawstate")).toEqual({ code: "rawcode", state: "rawstate" });
  expect(parseCallbackInput("  ")).toEqual({});
});

class TestFlow extends OAuthCallbackFlow {
  capturedState = "";
  capturedRedirect = "";
  exchanged: { code: string; state: string; redirectUri: string } | null = null;
  constructor(ctrl: OAuthController) {
    super(ctrl, { preferredPort: 0, callbackPath: "/callback" });
  }
  async generateAuthUrl(state: string, redirectUri: string) {
    this.capturedState = state;
    this.capturedRedirect = redirectUri;
    return { url: "http://auth.example/login" };
  }
  async exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials> {
    this.exchanged = { code, state, redirectUri };
    return { access: `acc-${code}`, refresh: "refresh-1", expires: Date.now() + 3_600_000, email: "u@example.com" };
  }
}

test("OAuthCallbackFlow: browser callback delivers code, state validated, token exchanged", async () => {
  let ready: () => void;
  const readyPromise = new Promise<void>(r => (ready = r));
  const ctrl: OAuthController = { onAuth: () => ready() };
  const flow = new TestFlow(ctrl);

  const loginPromise = flow.login();
  await readyPromise; // generateAuthUrl ran; redirect URI + state captured

  // Simulate the browser hitting the local callback with the real state.
  const res = await fetch(`${flow.capturedRedirect}?code=mycode&state=${flow.capturedState}`);
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("Login complete");
  expect(body).toContain("Authentication succeeded");
  // Success page auto-closes: countdown element + window.close() on a timer,
  // plus a manual Close button that closes immediately regardless of the countdown.
  expect(body).toContain('id="jeo-countdown"');
  expect(body).toContain('id="jeo-close"');
  expect(body).toContain("window.close()");


  const creds = await loginPromise;
  expect(creds.access).toBe("acc-mycode");
  expect(flow.exchanged?.code).toBe("mycode");
  expect(flow.exchanged?.state).toBe(flow.capturedState);
});

test("OAuthCallbackFlow: state mismatch is rejected (CSRF guard)", async () => {
  let ready: () => void;
  const readyPromise = new Promise<void>(r => (ready = r));
  const flow = new TestFlow({ onAuth: () => ready() });
  const loginPromise = flow.login();
  const caught = loginPromise.catch((e: unknown) => e); // attach handler before triggering rejection
  await readyPromise;

  const res = await fetch(`${flow.capturedRedirect}?code=x&state=WRONG`);
  expect(res.status).toBe(500); // gjc parity: callback failures respond 500, not 400
  const failBody = await res.text();
  expect(failBody).toContain("State mismatch");
  // Failure page now also auto-closes after the countdown (both success and
  // failure are "final" pages that should not linger); a Close button lets
  // the user dismiss it immediately instead of waiting out the timer.
  expect(failBody).toContain('id="jeo-countdown"');
  expect(failBody).toContain('id="jeo-close"');
  expect(failBody).toContain("window.close()");

  expect(String(await caught)).toContain("State mismatch");
});

test("resolveCredential: auto-refreshes an expired anthropic OAuth token", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-oauth-"));
  const prevConfigDir = process.env.JEO_CONFIG_DIR;
  const prevFetch = globalThis.fetch;
  const configDir = path.join(home, ".jeo");
  process.env.JEO_CONFIG_DIR = configDir;
  // Ensure no env OAuth bleed-through.
  const clearedEnv = ["ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"].map(k => {
    const v = process.env[k];
    delete process.env[k];
    return [k, v] as const;
  });

  try {
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        providers: {},
        oauth: { anthropic: { access: "OLD", refresh: "REFRESH-OLD", expires: Date.now() - 60_000 } },
        defaultModel: "claude-3-5-sonnet",
      }),
      "utf-8"
    );

    let refreshHit = false;
    globalThis.fetch = (async (url: any, init: any) => {
      const u = String(url);
      if (u === "https://api.anthropic.com/v1/oauth/token") {
        refreshHit = true;
        const body = JSON.parse(init.body);
        expect(body.grant_type).toBe("refresh_token");
        expect(body.refresh_token).toBe("REFRESH-OLD");
        return new Response(
          JSON.stringify({ access_token: "NEW", refresh_token: "REFRESH-NEW", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch;

    const { resolveCredential, getStoredOAuth } = await import("../src/auth/storage");
    const cred = await resolveCredential("anthropic");
    expect(refreshHit).toBe(true);
    expect(cred.kind).toBe("oauth");
    expect(cred.kind === "oauth" && cred.token).toBe("NEW");

    // Persisted to disk with the rotated refresh token.
    const stored = await getStoredOAuth("anthropic");
    expect(stored?.access).toBe("NEW");
    expect(stored?.refresh).toBe("REFRESH-NEW");
    expect(stored?.expires).toBeGreaterThan(Date.now());
  } finally {
    globalThis.fetch = prevFetch;
    if (prevConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = prevConfigDir;
    for (const [k, v] of clearedEnv) if (v !== undefined) process.env[k] = v;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("googleClientSecret: env override wins, blank/missing env falls back to bundled default", () => {
  // explicit override
  expect(googleClientSecret({ GEMINI_OAUTH_CLIENT_SECRET: "custom-secret" })).toBe("custom-secret");
  // blank env must not mask the bundled default (login works out of the box)
  const fallback = googleClientSecret({ GEMINI_OAUTH_CLIENT_SECRET: "" });
  expect(fallback).toBe(googleClientSecret({}));
  expect(fallback.startsWith("GOCSPX-")).toBe(true);
  expect(fallback.length).toBeGreaterThan(10);
});
test("refreshOAuthToken: concurrent refreshes acquire lock sequentially and reuse already refreshed token without double-refresh", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-oauth-lock-test-"));
  const prevConfigDir = process.env.JEO_CONFIG_DIR;
  process.env.JEO_CONFIG_DIR = home;

  const configPath = path.join(home, "config.json");
  const initialConfig = {
    oauth: {
      anthropic: {
        access: "OLD-ACCESS",
        refresh: "REFRESH-TOKEN",
        expires: Date.now() - 10000,
        email: "test@example.com",
      },
    },
    defaultModel: "claude-sonnet-4-5",
    thinkingLevel: "medium",
  };
  await fs.writeFile(configPath, JSON.stringify(initialConfig, null, 2), "utf-8");

  const prevFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (input, init) => {
    callCount++;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return new Response(
      JSON.stringify({
        access_token: `NEW-ACCESS-${callCount}`,
        refresh_token: "REFRESH-TOKEN-NEW",
        expires_in: 3600,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    const { refreshOAuthToken } = await import("../src/auth/refresh");
    const { getStoredOAuth } = await import("../src/auth/storage");

    const [res1, res2] = await Promise.all([
      refreshOAuthToken("anthropic"),
      refreshOAuthToken("anthropic"),
    ]);

    expect(callCount).toBe(1);

    expect(res1.refreshed).toBe(true);
    expect(res2.refreshed).toBe(true);

    const result1New = res1.reason === "refreshed";
    const result2New = res2.reason === "refreshed";

    expect(result1New !== result2New).toBe(true);

    const refreshedRes = result1New ? res1 : res2;
    const alreadyRefreshedRes = result1New ? res2 : res1;

    expect(refreshedRes.reason).toBe("refreshed");
    expect((refreshedRes.credential as any).token).toBe("NEW-ACCESS-1");

    expect(alreadyRefreshedRes.reason).toBe("already_refreshed");
    expect((alreadyRefreshedRes.credential as any).token).toBe("NEW-ACCESS-1");

    const stored = await getStoredOAuth("anthropic");
    expect(stored?.access).toBe("NEW-ACCESS-1");
    expect(stored?.refresh).toBe("REFRESH-TOKEN-NEW");
    expect(stored?.expires).toBeGreaterThan(Date.now());
  } finally {
    globalThis.fetch = prevFetch;
    if (prevConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = prevConfigDir;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("OAuthCallbackFlow: aborted ctrl signal stops the manual re-prompt loop", async () => {
  let ready: () => void;
  const readyPromise = new Promise<void>(r => (ready = r));
  const ac = new AbortController();
  let asks = 0;
  // Mimics the production wiring: rl.question(query, { signal }) — pending until
  // the signal aborts, then rejects (AbortError), and rejects immediately when
  // called with an already-aborted signal.
  const ctrl: OAuthController = {
    signal: ac.signal,
    onAuth: () => ready(),
    onManualCodeInput: () => {
      asks++;
      if (ac.signal.aborted) return Promise.reject(new Error("AbortError"));
      return new Promise<string>((_, reject) =>
        ac.signal.addEventListener("abort", () => reject(new Error("AbortError")), { once: true }),
      );
    },
  };
  const flow = new TestFlow(ctrl);
  const loginPromise = flow.login();
  await readyPromise;

  // Browser callback completes the login while the paste prompt is still pending.
  await fetch(`${flow.capturedRedirect}?code=ok&state=${flow.capturedState}`);
  const creds = await loginPromise;
  expect(creds.access).toBe("acc-ok");

  // Production callers abort in finally once the flow settles. Without the
  // loop guard this spun forever: the aborted ask() rejects instantly, maps to
  // null, and the while(true) re-asks in a hot microtask loop.
  const asksAtSettle = asks;
  ac.abort();
  await new Promise(r => setTimeout(r, 30));
  expect(asks).toBe(asksAtSettle);
});
test("classifyRefreshFailure: dead-token signals are definitive, network blips are transient", async () => {
  const { classifyRefreshFailure } = await import("../src/auth/refresh");
  // Definitive: the refresh token itself is permanently dead.
  expect(classifyRefreshFailure(new Error('Anthropic OAuth request failed (HTTP 400): {"error":"invalid_grant"}'))).toBe("definitive");
  expect(classifyRefreshFailure(new Error("token has been revoked"))).toBe("definitive");
  expect(classifyRefreshFailure(new Error("OpenAI OAuth request failed (HTTP 401): unauthorized"))).toBe("definitive");
  expect(classifyRefreshFailure(new Error("Google OAuth request failed (HTTP 403)"))).toBe("definitive");
  // Transient: retryable infrastructure errors must NOT nuke the credential.
  expect(classifyRefreshFailure(new Error("fetch failed"))).toBe("transient");
  expect(classifyRefreshFailure(new Error("connect ECONNREFUSED 127.0.0.1:443"))).toBe("transient");
  expect(classifyRefreshFailure(new Error("request timeout after 30s"))).toBe("transient");
  // A 401 that is itself a network description stays transient (gjc parity).
  expect(classifyRefreshFailure(new Error("fetch failed (was 401 earlier)"))).toBe("transient");
});

test("resolveCredential: a definitive refresh failure clears the dead OAuth and falls back to the API key", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-oauth-def-"));
  const prevConfigDir = process.env.JEO_CONFIG_DIR;
  const prevFetch = globalThis.fetch;
  const configDir = path.join(home, ".jeo");
  process.env.JEO_CONFIG_DIR = configDir;
  const clearedEnv = ["ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"].map(k => {
    const v = process.env[k];
    delete process.env[k];
    return [k, v] as const;
  });
  try {
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        providers: { anthropic: "sk-fallback-key" },
        oauth: { anthropic: { access: "OLD", refresh: "DEAD-REFRESH", expires: Date.now() - 60_000 } },
        defaultModel: "claude-3-5-sonnet",
      }),
      "utf-8",
    );
    let refreshHit = false;
    globalThis.fetch = (async (url: any) => {
      if (String(url) === "https://api.anthropic.com/v1/oauth/token") {
        refreshHit = true;
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const { resolveCredential, getStoredOAuth } = await import("../src/auth/storage");
    const cred = await resolveCredential("anthropic");
    expect(refreshHit).toBe(true);
    // Dead OAuth is gone; resolution degraded cleanly to the configured API key.
    expect(cred.kind).toBe("api_key");
    expect(cred.kind === "api_key" && cred.token).toBe("sk-fallback-key");
    expect(await getStoredOAuth("anthropic")).toBeUndefined();
  } finally {
    globalThis.fetch = prevFetch;
    if (prevConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = prevConfigDir;
    for (const [k, v] of clearedEnv) if (v !== undefined) process.env[k] = v;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("resolveCredential: a transient refresh failure keeps the OAuth credential and reuses the stale token", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-oauth-trans-"));
  const prevConfigDir = process.env.JEO_CONFIG_DIR;
  const prevFetch = globalThis.fetch;
  const configDir = path.join(home, ".jeo");
  process.env.JEO_CONFIG_DIR = configDir;
  const clearedEnv = ["ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"].map(k => {
    const v = process.env[k];
    delete process.env[k];
    return [k, v] as const;
  });
  try {
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        providers: {},
        oauth: { anthropic: { access: "STALE", refresh: "GOOD-REFRESH", expires: Date.now() - 60_000 } },
        defaultModel: "claude-3-5-sonnet",
      }),
      "utf-8",
    );
    globalThis.fetch = (async (url: any) => {
      if (String(url) === "https://api.anthropic.com/v1/oauth/token") {
        throw new Error("fetch failed");
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const { resolveCredential, getStoredOAuth } = await import("../src/auth/storage");
    const cred = await resolveCredential("anthropic");
    // Network blip → keep the credential, hand back the stale access token so the
    // in-flight provider call can try once more; the next sweep retries the refresh.
    expect(cred.kind).toBe("oauth");
    expect(cred.kind === "oauth" && cred.token).toBe("STALE");
    const stored = await getStoredOAuth("anthropic");
    expect(stored?.refresh).toBe("GOOD-REFRESH");
  } finally {
    globalThis.fetch = prevFetch;
    if (prevConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = prevConfigDir;
    for (const [k, v] of clearedEnv) if (v !== undefined) process.env[k] = v;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("OAuthCallbackFlow: manual paste of a bare code (no state) is accepted (gjc parity)", async () => {
  let ready: () => void;
  const readyPromise = new Promise<void>(r => (ready = r));
  // Provider stripped the state from the redirect; the user pastes just the code.
  // Only an explicitly MISMATCHED state must be rejected.
  const ctrl: OAuthController = {
    onAuth: () => ready(),
    onManualCodeInput: () => Promise.resolve("bare-pasted-code"),
  };
  const flow = new TestFlow(ctrl);
  const creds = await flow.login();
  await readyPromise;
  expect(creds.access).toBe("acc-bare-pasted-code");
  expect(flow.exchanged?.code).toBe("bare-pasted-code");
  // No returned state → the flow falls back to the expected state for the exchange.
  expect(flow.exchanged?.state).toBe(flow.capturedState);
});

test("OAuthCallbackFlow: manual paste with a MISMATCHED state is still rejected", async () => {
  let ready: () => void;
  const readyPromise = new Promise<void>(r => (ready = r));
  let asks = 0;
  const ctrl: OAuthController = {
    onAuth: () => ready(),
    onManualCodeInput: () => {
      asks++;
      // First paste carries a wrong state → must be rejected (loop re-asks);
      // second paste is bare → accepted.
      return Promise.resolve(asks === 1 ? "evil-code#WRONG-STATE" : "good-code");
    },
  };
  const flow = new TestFlow(ctrl);
  const creds = await flow.login();
  await readyPromise;
  expect(asks).toBeGreaterThanOrEqual(2);
  expect(creds.access).toBe("acc-good-code");
});

test("refreshOAuthToken: refreshes ahead of expiry when the token dies within the 60s skew window", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-oauth-skew-"));
  const prevConfigDir = process.env.JEO_CONFIG_DIR;
  const prevFetch = globalThis.fetch;
  process.env.JEO_CONFIG_DIR = home;
  try {
    // Expires in 30s — inside the 60s refresh-ahead window → must refresh NOW.
    await fs.writeFile(
      path.join(home, "config.json"),
      JSON.stringify({
        providers: {},
        oauth: { anthropic: { access: "SOON-STALE", refresh: "R1", expires: Date.now() + 30_000 } },
        defaultModel: "claude-3-5-sonnet",
      }),
      "utf-8"
    );
    let refreshHit = false;
    globalThis.fetch = (async (url: any) => {
      if (String(url) === "https://api.anthropic.com/v1/oauth/token") {
        refreshHit = true;
        return new Response(
          JSON.stringify({ access_token: "AHEAD", refresh_token: "R2", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const { refreshOAuthToken, OAUTH_REFRESH_SKEW_MS } = await import("../src/auth/refresh");
    expect(OAUTH_REFRESH_SKEW_MS).toBe(60_000); // gjc auth-storage.ts parity
    const res = await refreshOAuthToken("anthropic");
    expect(refreshHit).toBe(true);
    expect(res.reason).toBe("refreshed");
    expect((res.credential as any).token).toBe("AHEAD");
  } finally {
    globalThis.fetch = prevFetch;
    if (prevConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = prevConfigDir;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("refreshOAuthToken: a token with more than 60s left is NOT refreshed", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-oauth-fresh-"));
  const prevConfigDir = process.env.JEO_CONFIG_DIR;
  const prevFetch = globalThis.fetch;
  process.env.JEO_CONFIG_DIR = home;
  try {
    await fs.writeFile(
      path.join(home, "config.json"),
      JSON.stringify({
        providers: {},
        oauth: { anthropic: { access: "STILL-FRESH", refresh: "R1", expires: Date.now() + 120_000 } },
        defaultModel: "claude-3-5-sonnet",
      }),
      "utf-8"
    );
    globalThis.fetch = (async (url: any) => {
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const { refreshOAuthToken } = await import("../src/auth/refresh");
    const res = await refreshOAuthToken("anthropic");
    expect(res.reason).toBe("already_refreshed");
    expect((res.credential as any).token).toBe("STILL-FRESH");
  } finally {
    globalThis.fetch = prevFetch;
    if (prevConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = prevConfigDir;
    await fs.rm(home, { recursive: true, force: true });
  }
});