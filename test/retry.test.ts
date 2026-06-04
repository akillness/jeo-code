import { test, expect } from "bun:test";
import { withRetry, defaultRetryable } from "../src/util/retry";

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
