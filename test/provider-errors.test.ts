import { test, expect } from "bun:test";
import { ProviderHttpError } from "../src/ai/providers/errors";
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
