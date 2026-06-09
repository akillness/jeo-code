import { test, expect } from "bun:test";
import { withRetry, defaultRetryable, isRateLimitError } from "../src/util/retry";
import { resolveRetryOptions } from "../src/ai/model-manager";

test("resolveRetryOptions maps a gjc retry budget to withRetry options", () => {
  // Unset → withRetry defaults apply (no explicit retries/maxDelayMs), predicate wired.
  const base = resolveRetryOptions(undefined);
  expect(base.retries).toBeUndefined();
  expect(base.maxDelayMs).toBeUndefined();
  expect(typeof base.isRetryable).toBe("function");

  // requestMaxRetries counts retries; total attempts = requestMaxRetries + 1.
  expect(resolveRetryOptions({ requestMaxRetries: 4 }).retries).toBe(5);
  expect(resolveRetryOptions({ requestMaxRetries: 0 }).retries).toBe(1);

  // maxDelayMs passes through; unrelated gjc fields are ignored.
  const opts = resolveRetryOptions({ maxDelayMs: 1000, streamMaxRetries: 100, maxRetries: 3 });
  expect(opts.maxDelayMs).toBe(1000);
  expect(opts.retries).toBeUndefined();
});

test("resolveRetryOptions: rate-limit defaults engage only when not explicitly configured", () => {
  // Unset → generous 429 budget + a backoff floor so the first 429 doesn't instantly exhaust.
  const base = resolveRetryOptions(undefined);
  expect(base.rateLimitRetries).toBe(5);
  expect(base.rateLimitMinDelayMs).toBe(2000);

  // Explicit requestMaxRetries wins: rate-limit gets no bonus beyond the budget.
  const explicit = resolveRetryOptions({ requestMaxRetries: 2 });
  expect(explicit.retries).toBe(3);
  expect(explicit.rateLimitRetries).toBe(3);

  // Explicit maxDelayMs wins: no rate-limit floor is injected.
  const capped = resolveRetryOptions({ maxDelayMs: 500 });
  expect(capped.maxDelayMs).toBe(500);
  expect(capped.rateLimitMinDelayMs).toBeUndefined();
});

test("isRateLimitError: detects 429 by status and by message", () => {
  expect(isRateLimitError({ status: 429 })).toBe(true);
  expect(isRateLimitError({ status: "429" })).toBe(true);
  expect(isRateLimitError(new Error("Rate limited (HTTP 429)"))).toBe(true);
  expect(isRateLimitError(new Error("rate_limit exceeded"))).toBe(true);
  expect(isRateLimitError({ status: 503 })).toBe(false);
  expect(isRateLimitError(new Error("HTTP 500"))).toBe(false);
});

test("withRetry: rate-limit errors get extra attempts beyond the base retries budget", async () => {
  let attempts = 0;
  await expect(
    withRetry(
      async () => {
        attempts++;
        throw { status: 429, message: "slow down" };
      },
      { retries: 2, rateLimitRetries: 5, baseDelayMs: 1, sleep: async () => {} },
    ),
  ).rejects.toBeDefined();
  // retries=2 would stop at 2, but rateLimitRetries=5 lifts the cap for 429s.
  expect(attempts).toBe(5);
});

test("withRetry: a 429 without Retry-After waits at least rateLimitMinDelayMs", async () => {
  const sleeps: number[] = [];
  await withRetry(
    async () => {
      throw { status: 429, message: "slow down" };
    },
    {
      retries: 1,
      rateLimitRetries: 3,
      rateLimitMinDelayMs: 2000,
      baseDelayMs: 100, // jitter would be ≤100ms; the 429 floor must dominate
      maxDelayMs: 100,
      random: () => 1,
      sleep: async ms => { sleeps.push(ms); },
    },
  ).catch(() => {});
  // Two retries before exhausting the rateLimitRetries=3 cap; each waited ≥ the floor.
  expect(sleeps.length).toBe(2);
  for (const ms of sleeps) expect(ms).toBeGreaterThanOrEqual(2000);
});

test("withRetry: a non-rate-limit error is NOT floored by rateLimitMinDelayMs", async () => {
  const sleeps: number[] = [];
  await withRetry(
    async () => { throw new Error("HTTP 503: overloaded"); },
    {
      retries: 2,
      rateLimitMinDelayMs: 2000,
      baseDelayMs: 100,
      maxDelayMs: 100,
      random: () => 1,
      sleep: async ms => { sleeps.push(ms); },
    },
  ).catch(() => {});
  expect(sleeps).toEqual([100]); // jitter only, no 429 floor
});

test("withRetry honors a resolved requestMaxRetries budget (attempt count)", async () => {
  let attempts = 0;
  const opts = resolveRetryOptions({ requestMaxRetries: 2, maxDelayMs: 0 });
  await expect(
    withRetry(async () => {
      attempts++;
      throw new Error("HTTP 503: overloaded");
    }, { ...opts, sleep: async () => {} }),
  ).rejects.toThrow("503");
  // requestMaxRetries=2 → 3 total attempts (1 initial + 2 retries).
  expect(attempts).toBe(3);
});

test("defaultRetryable classification", () => {
  // Network errors
  expect(defaultRetryable(new Error("fetch failed"))).toBe(true);
  expect(defaultRetryable(new Error("Network connection closed"))).toBe(true);
  expect(defaultRetryable(new Error("ECONNREFUSED"))).toBe(true);
  expect(defaultRetryable(new Error("request timeout"))).toBe(true);

  // Case insensitivity
  expect(defaultRetryable(new Error("FETCH failed"))).toBe(true);
  expect(defaultRetryable(new Error("econnreset"))).toBe(true);

  // Non-error/string object containing keywords
  expect(defaultRetryable("fetch")).toBe(true);
  expect(defaultRetryable({ message: "failed network request" })).toBe(true);

  // Status codes
  expect(defaultRetryable({ status: 429 })).toBe(true);
  expect(defaultRetryable({ status: "500" })).toBe(true);
  expect(defaultRetryable({ status: 503 })).toBe(true);
  expect(defaultRetryable({ status: 408 })).toBe(true);
  expect(defaultRetryable({ status: 425 })).toBe(true);
  expect(defaultRetryable({ status: 502 })).toBe(true);
  expect(defaultRetryable({ status: 504 })).toBe(true);
  
  // Non-retryable status codes / messages
  expect(defaultRetryable(new Error("Invalid API key"))).toBe(false);
  expect(defaultRetryable({ status: 400 })).toBe(false);
  expect(defaultRetryable({ status: 404 })).toBe(false);
  expect(defaultRetryable({ status: "404" })).toBe(false);
  expect(defaultRetryable(null)).toBe(false);
  expect(defaultRetryable(undefined)).toBe(false);
  expect(defaultRetryable({})).toBe(false);
});

test("succeeds first try (fn called once, no sleep)", async () => {
  let calls = 0;
  const sleepCalls: number[] = [];

  const result = await withRetry(
    async () => {
      calls++;
      return "success";
    },
    {
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    }
  );

  expect(result).toBe("success");
  expect(calls).toBe(1);
  expect(sleepCalls).toEqual([]);
});

test("retries a retryable error then succeeds (fn called twice, sleep called once)", async () => {
  let calls = 0;
  const sleepCalls: number[] = [];
  const retryAttempts: number[] = [];

  const result = await withRetry(
    async () => {
      calls++;
      if (calls === 1) {
        throw new Error("fetch failed");
      }
      return "success";
    },
    {
      retries: 3,
      baseDelayMs: 100,
      random: () => 1, // equal jitter at max → deterministic schedule
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      onRetry: (attempt) => {
        retryAttempts.push(attempt);
      },
    }
  );

  expect(result).toBe("success");
  expect(calls).toBe(2);
  expect(sleepCalls).toEqual([100]); // 100 * 2^0
  expect(retryAttempts).toEqual([1]);
});

test("exhausts after retries attempts and rethrows (fn called retries times)", async () => {
  let calls = 0;
  const sleepCalls: number[] = [];
  const retryAttempts: number[] = [];
  const testError = new Error("fetch failed");

  let thrownErr: any = null;
  try {
    await withRetry(
      async () => {
        calls++;
        throw testError;
      },
      {
        retries: 3,
        baseDelayMs: 100,
        random: () => 1,
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
        onRetry: (attempt) => {
          retryAttempts.push(attempt);
        },
      }
    );
  } catch (err) {
    thrownErr = err;
  }

  expect(thrownErr).toBe(testError);
  expect(calls).toBe(3);
  expect(sleepCalls).toEqual([100, 200]); // attempt 1: 100, attempt 2: 200, attempt 3 fails & throws
  expect(retryAttempts).toEqual([1, 2]);
});

test("a non-retryable error throws immediately (fn called once)", async () => {
  let calls = 0;
  const sleepCalls: number[] = [];
  const testError = new Error("fatal syntax error");

  let thrownErr: any = null;
  try {
    await withRetry(
      async () => {
        calls++;
        throw testError;
      },
      {
        retries: 3,
        baseDelayMs: 100,
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
      }
    );
  } catch (err) {
    thrownErr = err;
  }

  expect(thrownErr).toBe(testError);
  expect(calls).toBe(1);
  expect(sleepCalls).toEqual([]);
});

test("exponential backoff with cap", async () => {
  let calls = 0;
  const sleepCalls: number[] = [];

  try {
    await withRetry(
      async () => {
        calls++;
        throw new Error("timeout");
      },
      {
        retries: 5,
        baseDelayMs: 100,
        random: () => 1,
        maxDelayMs: 350,
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
      }
    );
  } catch (err) {
    // expected
  }

  expect(calls).toBe(5);
  // expected delays:
  // attempt 1: 100 * 2^0 = 100
  // attempt 2: 100 * 2^1 = 200
  // attempt 3: 100 * 2^2 = 400 -> capped at 350
  // attempt 4: 100 * 2^3 = 800 -> capped at 350
  expect(sleepCalls).toEqual([100, 200, 350, 350]);
});
