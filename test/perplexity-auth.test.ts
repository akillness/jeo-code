import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { parseConfig } from "../src/agent/config-schema.ts";
import { clearConfigReadCache, readGlobalConfig } from "../src/agent/state.ts";
import {
  OAUTH_PROVIDERS,
  clearAuthCooldown,
  isOAuthProvider,
  resetAuthPoolState,
  resolveCredential,
  setApiKey,
  setOauthCredential,
} from "../src/auth/storage.ts";
import { OAUTH_FLOWS } from "../src/auth/oauth.ts";
import { OAUTH_FLOW_REGISTRY } from "../src/auth/flows/index.ts";
import {
  PERPLEXITY_NEVER_EXPIRES,
  extractPerplexityMacAppToken,
  loginPerplexity,
  perplexityJwtExpiryMs,
  refreshPerplexityToken,
} from "../src/auth/flows/perplexity.ts";
import { canonicalSharedProvider, syncOAuthFromJeopi } from "../src/auth/shared-pool-bridge.ts";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("perplexity auth, config, flow & sync", () => {
  const dirs: string[] = [];
  const prevEnv = { ...process.env };
  const prevFetch = globalThis.fetch;

  function makeIsolatedEnv(): string {
    const dir = mkdtempSync(join(tmpdir(), "jeo-perplexity-auth-"));
    dirs.push(dir);
    process.env.JEO_CONFIG_DIR = join(dir, "jeo-cfg");
    process.env.JEO_SHARED_AUTH_POOL_PATH = join(dir, "pool", "cooldowns.json");
    mkdirSync(process.env.JEO_CONFIG_DIR, { recursive: true });
    delete process.env.PERPLEXITY_OAUTH_TOKEN;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.PPLX_API_KEY;
    clearConfigReadCache();
    return dir;
  }

  afterEach(async () => {
    globalThis.fetch = prevFetch;
    await clearAuthCooldown().catch(() => {});
    await resetAuthPoolState().catch(() => {});
    for (const k of Object.keys(process.env)) {
      if (!(k in prevEnv)) delete process.env[k];
    }
    Object.assign(process.env, prevEnv);
    clearConfigReadCache();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("registers perplexity in OAUTH_PROVIDERS, OAUTH_FLOW_REGISTRY, and OAUTH_FLOWS", () => {
    expect(OAUTH_PROVIDERS).toContain("perplexity");
    expect(isOAuthProvider("perplexity")).toBe(true);
    expect(OAUTH_FLOW_REGISTRY.perplexity.provider).toBe("perplexity");
    expect(OAUTH_FLOW_REGISTRY.perplexity.verifiedEndToEnd).toBe(true);
    expect(typeof OAUTH_FLOW_REGISTRY.perplexity.login).toBe("function");
    expect(typeof OAUTH_FLOW_REGISTRY.perplexity.refresh).toBe("function");
    expect(OAUTH_FLOWS.perplexity.instructions.length).toBeGreaterThan(0);
  });

  it("validates perplexity providers and oauth entries in ConfigSchema", () => {
    const parsed = parseConfig({
      defaultModel: "claude-sonnet-4-6",
      providers: { perplexity: "pplx-test-key" },
      oauth: {
        perplexity: {
          access: "jwt-token",
          refresh: "jwt-token",
          expires: PERPLEXITY_NEVER_EXPIRES,
          email: "user@example.com",
        },
      },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.providers.perplexity).toBe("pplx-test-key");
      expect(parsed.config.oauth?.perplexity).toEqual({
        access: "jwt-token",
        refresh: "jwt-token",
        expires: PERPLEXITY_NEVER_EXPIRES,
        email: "user@example.com",
      });
    }
  });

  it("overlays PERPLEXITY_OAUTH_TOKEN, PERPLEXITY_API_KEY, and PPLX_API_KEY and resolves credentials", async () => {
    makeIsolatedEnv();

    expect(await resolveCredential("perplexity")).toEqual({ kind: "none", provider: "perplexity" });

    process.env.PPLX_API_KEY = "pplx-fallback";
    clearConfigReadCache();
    expect(await resolveCredential("perplexity")).toEqual({
      kind: "api_key",
      provider: "perplexity",
      token: "pplx-fallback",
    });

    process.env.PERPLEXITY_API_KEY = "pplx-primary";
    clearConfigReadCache();
    expect(await resolveCredential("perplexity")).toEqual({
      kind: "api_key",
      provider: "perplexity",
      token: "pplx-primary",
    });

    process.env.PERPLEXITY_OAUTH_TOKEN = "pplx-oauth-env";
    clearConfigReadCache();
    expect(await resolveCredential("perplexity")).toEqual({
      kind: "oauth",
      provider: "perplexity",
      token: "pplx-oauth-env",
    });
    expect(await resolveCredential("perplexity", { preferKind: "api_key" })).toEqual({
      kind: "api_key",
      provider: "perplexity",
      token: "pplx-primary",
    });

    // Stored config values win over env gaps
    delete process.env.PERPLEXITY_OAUTH_TOKEN;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.PPLX_API_KEY;
    await setApiKey("perplexity", "stored-key");
    await setOauthCredential("perplexity", {
      access: "stored-jwt",
      refresh: "stored-jwt",
      expires: PERPLEXITY_NEVER_EXPIRES,
      email: "stored@example.com",
    });
    const cfg = await readGlobalConfig();
    expect(cfg.providers.perplexity).toBe("stored-key");
    expect(await resolveCredential("perplexity")).toEqual({
      kind: "oauth",
      provider: "perplexity",
      token: "stored-jwt",
    });
    expect(await resolveCredential("perplexity", { preferKind: "api_key" })).toEqual({
      kind: "api_key",
      provider: "perplexity",
      token: "stored-key",
    });
  });

  it("computes perplexityJwtExpiryMs with 5m skew or 8.64e15 when exp is absent", () => {
    const expSec = 2_000_000_000;
    const withExp = makeJwt({ sub: "u1", exp: expSec });
    expect(perplexityJwtExpiryMs(withExp)).toBe(expSec * 1000 - 5 * 60_000);

    const withoutExp = makeJwt({ sub: "u1" });
    expect(perplexityJwtExpiryMs(withoutExp)).toBe(PERPLEXITY_NEVER_EXPIRES);
    expect(perplexityJwtExpiryMs("not-a-jwt")).toBe(PERPLEXITY_NEVER_EXPIRES);
  });

  it("extractPerplexityMacAppToken stays hermetic under test / JEO_CONFIG_DIR / JEO_AUTH_NO_BORROW", async () => {
    makeIsolatedEnv();
    process.env.JEO_AUTH_NO_BORROW = "1";
    expect(await extractPerplexityMacAppToken()).toBeNull();
    delete process.env.JEO_AUTH_NO_BORROW;
    expect(await extractPerplexityMacAppToken()).toBeNull();
  });

  it("loginPerplexity performs HTTP email OTP flow via onManualCodeInput", async () => {
    makeIsolatedEnv();
    const returnedJwt = makeJwt({ sub: "user-123" });
    const calls: { url: string; method: string; headers: Record<string, string>; body?: unknown }[] = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method: init?.method ?? "GET", headers, body });

      if (url.endsWith("/csrf")) {
        return Response.json({ csrfToken: "csrf-123" });
      }
      if (url.endsWith("/signin-email")) {
        return Response.json({ ok: true });
      }
      if (url.endsWith("/signin-otp")) {
        return Response.json({ token: returnedJwt });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const answers = ["user@example.com", "654321"];
    const progress: string[] = [];
    const creds = await loginPerplexity({
      onProgress: msg => progress.push(msg),
      onManualCodeInput: async () => answers.shift() ?? "",
    });

    expect(creds).toEqual({
      access: returnedJwt,
      refresh: returnedJwt,
      expires: PERPLEXITY_NEVER_EXPIRES,
      email: "user@example.com",
    });
    expect(progress.some(p => p.toLowerCase().includes("email"))).toBe(true);
    expect(progress.some(p => p.toLowerCase().includes("code"))).toBe(true);

    expect(calls.map(c => c.url)).toEqual([
      "https://www.perplexity.ai/api/auth/csrf",
      "https://www.perplexity.ai/api/auth/signin-email",
      "https://www.perplexity.ai/api/auth/signin-otp",
    ]);
    for (const call of calls) {
      expect(call.headers["user-agent"]).toBe("Perplexity/641 CFNetwork/1568 Darwin/25.2.0");
      expect(call.headers["x-app-apiversion"]).toBe("2.18");
    }
    expect(calls[1]?.body).toEqual({ email: "user@example.com", csrfToken: "csrf-123" });
    expect(calls[2]?.body).toEqual({ email: "user@example.com", otp: "654321", csrfToken: "csrf-123" });
  });

  it("loginPerplexity rejects missing onManualCodeInput or invalid OTP responses", async () => {
    makeIsolatedEnv();
    await expect(loginPerplexity({})).rejects.toThrow("onManualCodeInput");

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/csrf")) return Response.json({ csrfToken: "csrf-abc" });
      if (url.endsWith("/signin-email")) return Response.json({ ok: true });
      if (url.endsWith("/signin-otp")) return Response.json({ error_code: "invalid_otp" }, { status: 401 });
      return new Response("bad", { status: 500 });
    }) as typeof fetch;

    const answers = ["user@example.com", "000000"];
    await expect(
      loginPerplexity({ onManualCodeInput: async () => answers.shift() ?? "" }),
    ).rejects.toThrow("invalid_otp");
  });

  it("refreshPerplexityToken validates non-expiring and unexpired JWTs and rejects expired JWTs", async () => {
    makeIsolatedEnv();
    const nonExpiring = makeJwt({ sub: "no-exp" });
    expect(await refreshPerplexityToken(nonExpiring)).toEqual({
      access: nonExpiring,
      refresh: nonExpiring,
      expires: PERPLEXITY_NEVER_EXPIRES,
    });

    const futureSec = Math.floor(Date.now() / 1000) + 3600;
    const unexpired = makeJwt({ exp: futureSec });
    expect(await refreshPerplexityToken(unexpired)).toEqual({
      access: unexpired,
      refresh: unexpired,
      expires: futureSec * 1000 - 5 * 60_000,
    });

    const expired = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    await expect(refreshPerplexityToken(expired)).rejects.toThrow("invalid_token");
    await expect(refreshPerplexityToken("   ")).rejects.toThrow("invalid_token");
  });

  it("syncs perplexity OAuth rows from jeopi SQLite store idempotently", async () => {
    const dir = makeIsolatedEnv();
    expect(canonicalSharedProvider("perplexity")).toBe("perplexity");

    const dbPath = join(dir, "agent.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE auth_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      credential_type TEXT NOT NULL,
      data TEXT NOT NULL,
      disabled_cause TEXT DEFAULT NULL,
      identity_key TEXT DEFAULT NULL
    );`);
    const pplxJwt = makeJwt({ sub: "p1" });
    db.prepare("INSERT INTO auth_credentials(provider, credential_type, data, disabled_cause) VALUES (?,?,?,?)").run(
      "perplexity",
      "oauth",
      JSON.stringify({ access: pplxJwt, refresh: pplxJwt, expires: PERPLEXITY_NEVER_EXPIRES, email: "pplx@example.com" }),
      null,
    );
    db.close();

    const sync1 = await syncOAuthFromJeopi({ agentDbPath: dbPath });
    expect(sync1.imported).toBe(1);
    expect(sync1.byProvider.perplexity).toBe(1);

    const sync2 = await syncOAuthFromJeopi({ agentDbPath: dbPath });
    expect(sync2.imported).toBe(0);

    expect(await resolveCredential("perplexity")).toEqual({
      kind: "oauth",
      provider: "perplexity",
      token: pplxJwt,
    });
  });
});
