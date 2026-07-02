import { test, expect } from "bun:test";
import { loginOpenAI, loginOpenAIDevice } from "../src/auth/flows/openai";
import type { OAuthController } from "../src/auth/types";

const USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const TOKEN_URL = "https://auth.openai.com/oauth/token";

/** Build a decodable (unsigned) JWT — decodeJwt only reads the base64 payload segment. */
function fakeJwt(payload: Record<string, unknown>): string {
  const seg = (o: Record<string, unknown>) => Buffer.from(JSON.stringify(o)).toString("base64");
  return `${seg({ alg: "none" })}.${seg(payload)}.sig`;
}

type FetchMock = (url: string, init?: RequestInit) => Promise<Response> | Response;

/** Mock the device flow endpoints. `interval: -3` cancels the 3s safety margin so polls run immediately. */
function deviceFetchMock(opts: { accessToken: string; pendingPolls?: number }): { fetch: FetchMock; calls: string[] } {
  const calls: string[] = [];
  let polls = 0;
  const fetchImpl: FetchMock = (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u === USERCODE_URL) {
      return new Response(
        JSON.stringify({ device_auth_id: "dev-auth-1", user_code: "ABCD-1234", interval: -3 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (u === DEVICE_TOKEN_URL) {
      polls++;
      if (polls <= (opts.pendingPolls ?? 0)) return new Response("pending", { status: 403 });
      const body = JSON.parse(String(init?.body));
      expect(body.device_auth_id).toBe("dev-auth-1");
      expect(body.user_code).toBe("ABCD-1234");
      return new Response(
        JSON.stringify({ authorization_code: "device-auth-code", code_verifier: "device-verifier" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (u === TOKEN_URL) {
      const params = new URLSearchParams(String(init?.body));
      expect(params.get("grant_type")).toBe("authorization_code");
      expect(params.get("code")).toBe("device-auth-code");
      expect(params.get("code_verifier")).toBe("device-verifier");
      expect(params.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
      return new Response(
        JSON.stringify({ access_token: opts.accessToken, refresh_token: "REFRESH-1", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return { fetch: fetchImpl, calls };
}

const ACCOUNT_JWT = fakeJwt({
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" },
  "https://api.openai.com/profile": { email: " User@Example.com " },
});
const NO_ACCOUNT_JWT = fakeJwt({ "https://api.openai.com/profile": { email: "u@example.com" } });

test("loginOpenAIDevice: polls through pending (403) and returns credentials with accountId", async () => {
  const prevFetch = globalThis.fetch;
  const mock = deviceFetchMock({ accessToken: ACCOUNT_JWT, pendingPolls: 1 });
  globalThis.fetch = mock.fetch as typeof fetch;
  const auths: { url: string; instructions?: string }[] = [];
  try {
    const creds = await loginOpenAIDevice({ onAuth: info => auths.push(info) });
    expect(creds.accountId).toBe("acct-123");
    expect(creds.email).toBe("user@example.com");
    expect(creds.refresh).toBe("REFRESH-1");
    // user_code + verification URL surfaced through the controller.
    expect(auths[0]?.url).toBe("https://auth.openai.com/codex/device");
    expect(auths[0]?.instructions).toContain("ABCD-1234");
    // 1 pending poll (403) + 1 successful poll.
    expect(mock.calls.filter(c => c === DEVICE_TOKEN_URL).length).toBe(2);
  } finally {
    globalThis.fetch = prevFetch;
  }
}, 15_000);

test("openai token exchange: missing accountId claim fails the login (gjc parity)", async () => {
  const prevFetch = globalThis.fetch;
  const mock = deviceFetchMock({ accessToken: NO_ACCOUNT_JWT });
  globalThis.fetch = mock.fetch as typeof fetch;
  try {
    await expect(loginOpenAIDevice({})).rejects.toThrow("Failed to extract accountId from token");
  } finally {
    globalThis.fetch = prevFetch;
  }
}, 15_000);

test("loginOpenAI: falls back to the device flow when callback port 1455 is busy", async () => {
  // OpenAI forbids a random-port fallback (fixed redirect URI), so a busy 1455 must
  // make the browser flow fail its bind and loginOpenAI fall back to device codes.
  // Bind failure is INJECTED (Bun.serve stub): a real pre-bind cannot simulate it —
  // Bun silently shares a port already owned by the same process.
  const realServe = Bun.serve;
  let bindAttempts = 0;
  (Bun as any).serve = (opts: any) => {
    if (opts?.port === 1455) {
      bindAttempts++;
      throw Object.assign(new Error("Failed to start server. Is port 1455 in use?"), { code: "EADDRINUSE" });
    }
    return realServe(opts);
  };

  const prevFetch = globalThis.fetch;
  const mock = deviceFetchMock({ accessToken: ACCOUNT_JWT });
  globalThis.fetch = mock.fetch as typeof fetch;
  const progress: string[] = [];
  const auths: { url: string; instructions?: string }[] = [];
  const ctrl: OAuthController = {
    onProgress: m => progress.push(m),
    onAuth: info => auths.push(info),
  };
  try {
    const creds = await loginOpenAI(ctrl);
    expect(bindAttempts).toBe(1); // the browser flow tried (and failed) the fixed port once
    expect(creds.accountId).toBe("acct-123");
    expect(creds.access).toBe(ACCOUNT_JWT);
    // The fallback was announced and the device flow (not the browser flow) ran:
    expect(progress.some(m => m.includes("device-code"))).toBe(true);
    expect(mock.calls[0]).toBe(USERCODE_URL); // no authorize-URL browser round-trip
    expect(auths[0]?.url).toBe("https://auth.openai.com/codex/device");
  } finally {
    globalThis.fetch = prevFetch;
    (Bun as any).serve = realServe;
  }
}, 20_000);
