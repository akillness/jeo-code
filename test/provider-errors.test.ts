import { test, expect } from "bun:test";
import { ProviderHttpError, parseRetryAfter, parseRetryFromBody, providerHttpError } from "../src/ai/providers/errors";
import { defaultRetryable, withRetry } from "../src/util/retry";

test("ProviderHttpError carries a numeric status and a descriptive message", () => {
  const e = new ProviderHttpError("Anthropic", 529, "overloaded", "(stream)");
  expect(e.status).toBe(529);
  expect(e.provider).toBe("Anthropic");
  expect(e.message).toContain("HTTP 529");
  expect(e.message).toContain("(stream)");
  expect(e instanceof Error).toBe(true);
});

test("provider HTTP errors are now retryable (regression: 429/5xx/529 were dropped)", () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504, 529]) {
    expect(defaultRetryable(new ProviderHttpError("OpenAI", status, "boom"))).toBe(true);
  }
  // Client errors must NOT be retried.
  for (const status of [400, 401, 403, 404, 422]) {
    expect(defaultRetryable(new ProviderHttpError("OpenAI", status, "boom"))).toBe(false);
  }
});

test("defaultRetryable parses an HTTP status embedded in a bare error message", () => {
  expect(defaultRetryable(new Error("Gemini request failed (HTTP 503): overloaded"))).toBe(true);
  expect(defaultRetryable(new Error("OpenAI request failed (HTTP 429): rate limited"))).toBe(true);
  expect(defaultRetryable(new Error("Anthropic request failed (HTTP 400): bad request"))).toBe(false);
  expect(defaultRetryable(new Error("overloaded_error"))).toBe(true);
});

test("withRetry actually retries a 503 ProviderHttpError then succeeds", async () => {
  let calls = 0;
  const sleepCalls: number[] = [];
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new ProviderHttpError("Ollama", 503, "service unavailable");
      return "ok";
    },
    { retries: 4, baseDelayMs: 1, sleep: async ms => { sleepCalls.push(ms); } }
  );
  expect(result).toBe("ok");
  expect(calls).toBe(3);
  expect(sleepCalls.length).toBe(2);
});

test("parseRetryAfter: delta-seconds and HTTP-date forms", () => {
  expect(parseRetryAfter("5")).toBe(5000);
  expect(parseRetryAfter("0")).toBe(0);
  expect(parseRetryAfter(null)).toBeUndefined();
  expect(parseRetryAfter("garbage")).toBeUndefined();
  const future = new Date(Date.now() + 10_000).toUTCString();
  const ms = parseRetryAfter(future)!;
  expect(ms).toBeGreaterThan(8_000);
  expect(ms).toBeLessThanOrEqual(10_000);
});

test("withRetry: equal jitter lands the wait in [0.5x, 1x] of the capped backoff", async () => {
  const sleeps: number[] = [];
  // random()=0 → minimum (0.5x); random()=1 → maximum (1x).
  await withRetry(async () => { throw new Error("timeout"); }, {
    retries: 2, baseDelayMs: 100, random: () => 0,
    sleep: async ms => { sleeps.push(ms); },
  }).catch(() => {});
  expect(sleeps).toEqual([50]); // 100/2 + 0*(100/2)
});

test("withRetry: a Retry-After error overrides backoff (capped at 30s)", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  await withRetry(
    async () => {
      calls++;
      if (calls === 1) throw new ProviderHttpError("OpenAI", 429, "slow down", undefined, 2000);
      if (calls === 2) throw new ProviderHttpError("OpenAI", 429, "still", undefined, 99_000); // > cap
      return "ok";
    },
    { retries: 5, baseDelayMs: 100, random: () => 1, sleep: async ms => { sleeps.push(ms); } }
  );
  expect(sleeps).toEqual([2000, 30000]); // honored, then capped at 30s
});

test("parseRetryFromBody extracts Google/Gemini retry hints (header absent)", () => {
  // Gemini free-tier 429 message form.
  expect(parseRetryFromBody("...Please retry in 8.640764186s. ")).toBeCloseTo(8640, -2);
  // Google structured retryDelay form.
  expect(parseRetryFromBody('{"error":{"details":[{"retryDelay":"8s"}]}}')).toBe(8000);
  expect(parseRetryFromBody("no hint here")).toBeUndefined();
  expect(parseRetryFromBody("")).toBeUndefined();
});

test("providerHttpError honors a body retry hint when no Retry-After header is present", async () => {
  const res = new Response('{"error":{"message":"Please retry in 5s","status":"RESOURCE_EXHAUSTED"}}', { status: 429 });
  const err = await providerHttpError("Gemini", res);
  expect(err.status).toBe(429);
  expect(err.retryAfterMs).toBe(5000);
});
