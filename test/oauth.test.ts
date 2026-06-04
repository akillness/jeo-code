import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { generatePKCE, generateState } from "../src/auth/pkce";
import { OAuthCallbackFlow, parseCallbackInput } from "../src/auth/callback-server";
import type { OAuthController, OAuthCredentials } from "../src/auth/types";

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
  expect(await res.text()).toContain("Login complete");

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
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("State mismatch");
  expect(String(await caught)).toContain("State mismatch");
});

test("resolveCredential: auto-refreshes an expired anthropic OAuth token", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "joc-oauth-"));
  const prevConfigDir = process.env.JOC_CONFIG_DIR;
  const prevFetch = globalThis.fetch;
  const configDir = path.join(home, ".joc");
  process.env.JOC_CONFIG_DIR = configDir;
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
    if (prevConfigDir === undefined) delete process.env.JOC_CONFIG_DIR;
    else process.env.JOC_CONFIG_DIR = prevConfigDir;
    for (const [k, v] of clearedEnv) if (v !== undefined) process.env[k] = v;
    await fs.rm(home, { recursive: true, force: true });
  }
});
