import { test, expect } from "bun:test";
import { pollForToken, refreshKimiToken, requestDeviceAuthorization, loginKimi } from "../src/auth/flows/kimi";

// Kimi Code device-code OAuth (RFC 8628) — gjc parity: authorization_pending → poll,
// slow_down → widen interval, access_denied/expired_token → terminal, refresh keeps
// the old refresh token when the response omits one.

type FetchStep = { status?: number; body: unknown };

function mockFetchQueue(steps: FetchStep[]): { calls: { url: string; body: URLSearchParams }[]; restore: () => void } {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const prevFetch = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: new URLSearchParams(String(init?.body ?? "")) });
    const step = steps[Math.min(i++, steps.length - 1)];
    return new Response(JSON.stringify(step.body), { status: step.status ?? 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = prevFetch; } };
}

test("requestDeviceAuthorization: parses codes and normalizes expiry/interval to ms", async () => {
  const { calls, restore } = mockFetchQueue([
    { body: { user_code: "ABCD-1234", device_code: "dev-1", verification_uri: "https://auth.kimi.com/verify", verification_uri_complete: "https://auth.kimi.com/verify?code=ABCD-1234", expires_in: 900, interval: 5 } },
  ]);
  try {
    const device = await requestDeviceAuthorization();
    expect(device.userCode).toBe("ABCD-1234");
    expect(device.deviceCode).toBe("dev-1");
    expect(device.verificationUriComplete).toBe("https://auth.kimi.com/verify?code=ABCD-1234");
    expect(device.expiresInMs).toBe(900_000);
    expect(device.intervalMs).toBe(5_000);
    expect(calls[0].url).toBe("https://auth.kimi.com/api/oauth/device_authorization");
    expect(calls[0].body.get("client_id")).toBeTruthy();
  } finally {
    restore();
  }
});

test("pollForToken: authorization_pending polls until approval; grant is RFC 8628 device_code", async () => {
  const { calls, restore } = mockFetchQueue([
    { status: 400, body: { error: "authorization_pending" } },
    { status: 400, body: { error: "authorization_pending" } },
    { body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 } },
  ]);
  const sleeps: number[] = [];
  try {
    const creds = await pollForToken("dev-1", 5000, 60_000, undefined, async ms => { sleeps.push(ms); });
    expect(creds.access).toBe("at-1");
    expect(creds.refresh).toBe("rt-1");
    expect(creds.expires).toBeGreaterThan(Date.now());
    expect(sleeps).toEqual([5000, 5000]);
    expect(calls[0].body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(calls[0].body.get("device_code")).toBe("dev-1");
  } finally {
    restore();
  }
});

test("pollForToken: slow_down widens the poll interval (+5s, honoring a server interval)", async () => {
  const { restore } = mockFetchQueue([
    { status: 400, body: { error: "slow_down", interval: 15 } },
    { body: { access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 } },
  ]);
  const sleeps: number[] = [];
  try {
    await pollForToken("dev-1", 5000, 60_000, undefined, async ms => { sleeps.push(ms); });
    // 5000 + 5000 = 10_000, then the server's interval=15s wins because it is larger.
    expect(sleeps).toEqual([15_000]);
  } finally {
    restore();
  }
});

test("pollForToken: access_denied and expired_token are terminal", async () => {
  const denied = mockFetchQueue([{ status: 400, body: { error: "access_denied" } }]);
  try {
    await expect(pollForToken("d", 10, 60_000, undefined, async () => {})).rejects.toThrow("denied");
  } finally {
    denied.restore();
  }
  const expired = mockFetchQueue([{ status: 400, body: { error: "expired_token" } }]);
  try {
    await expect(pollForToken("d", 10, 60_000, undefined, async () => {})).rejects.toThrow("expired");
  } finally {
    expired.restore();
  }
});

test("pollForToken: an aborted signal cancels the login", async () => {
  const { restore } = mockFetchQueue([{ status: 400, body: { error: "authorization_pending" } }]);
  const ctrl = new AbortController();
  ctrl.abort();
  try {
    await expect(pollForToken("d", 10, 60_000, ctrl.signal, async () => {})).rejects.toThrow("cancelled");
  } finally {
    restore();
  }
});

test("refreshKimiToken: keeps the prior refresh token when the response omits one", async () => {
  const { calls, restore } = mockFetchQueue([
    { body: { access_token: "at-3", expires_in: 3600 } }, // no refresh_token in response
  ]);
  try {
    const creds = await refreshKimiToken("rt-old");
    expect(creds.access).toBe("at-3");
    expect(creds.refresh).toBe("rt-old"); // fallback preserved
    expect(calls[0].body.get("grant_type")).toBe("refresh_token");
    expect(calls[0].body.get("refresh_token")).toBe("rt-old");
  } finally {
    restore();
  }
});

test("loginKimi: surfaces the verification URL + user code through the controller", async () => {
  const { restore } = mockFetchQueue([
    { body: { user_code: "WXYZ-9876", device_code: "dev-9", verification_uri: "https://auth.kimi.com/verify", verification_uri_complete: "https://auth.kimi.com/verify?code=WXYZ-9876", expires_in: 900, interval: 0 } },
    { body: { access_token: "at-9", refresh_token: "rt-9", expires_in: 3600 } },
  ]);
  const seen: { url?: string; instructions?: string } = {};
  try {
    const creds = await loginKimi({
      onAuth: info => { seen.url = info.url; seen.instructions = info.instructions; },
    });
    expect(creds.access).toBe("at-9");
    expect(seen.url).toBe("https://auth.kimi.com/verify?code=WXYZ-9876");
    expect(seen.instructions).toContain("WXYZ-9876");
  } finally {
    restore();
  }
});
