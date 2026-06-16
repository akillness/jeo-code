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

  // maxDelayMs passes through
  const opts = resolveRetryOptions({ maxDelayMs: 1000 });
  expect(opts.maxDelayMs).toBe(1000);

  // streamMaxRetries is consumed by the stream kind
  const streamOpts = resolveRetryOptions({ streamMaxRetries: 100 }, "stream");
  expect(streamOpts.retries).toBe(101);

  const requestOpts = resolveRetryOptions({ streamMaxRetries: 100 }, "request");
  expect(requestOpts.retries).toBeUndefined();

  // maxRetries fallback works for both request and stream if they are unset
  const fallbackRequestOpts = resolveRetryOptions({ maxRetries: 3 }, "request");
  expect(fallbackRequestOpts.retries).toBe(4);

  const fallbackStreamOpts = resolveRetryOptions({ maxRetries: 3 }, "stream");
  expect(fallbackStreamOpts.retries).toBe(4);

  // requestMaxRetries and streamMaxRetries take precedence over maxRetries
  const precRequestOpts = resolveRetryOptions({ requestMaxRetries: 5, maxRetries: 3 }, "request");
  expect(precRequestOpts.retries).toBe(6);

  const precStreamOpts = resolveRetryOptions({ streamMaxRetries: 10, maxRetries: 3 }, "stream");
  expect(precStreamOpts.retries).toBe(11);
});

test("resolveRetryOptions: rate-limit defaults engage only when not explicitly configured", () => {
  // Unset → generous 429 budget + a backoff floor so the first 429 doesn't instantly exhaust.
  const base = resolveRetryOptions(undefined);
  expect(base.rateLimitRetries).toBe(6);
  expect(base.rateLimitMinDelayMs).toBe(2000);
  expect(base.rateLimitMaxServerDelayMs).toBe(5 * 60 * 1000);

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

test("withRetry: a 429 Retry-After:0 is still floored, and the floor escalates per attempt", async () => {
  const sleeps: number[] = [];
  await withRetry(
    async () => { throw { status: 429, message: "slow", retryAfterMs: 0 }; },
    { retries: 1, rateLimitRetries: 3, rateLimitMinDelayMs: 2000, baseDelayMs: 1, sleep: async ms => { sleeps.push(ms); } },
  ).catch(() => {});
  // Without the floor a Retry-After:0 would sleep 0 and burn the budget instantly.
  // The floor doubles each retry so the total wait spans a realistic 429 window.
  expect(sleeps).toEqual([2000, 4000]);
});

test("withRetry: a 429 Retry-After beyond the configured budget fails fast", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  await withRetry(
    async () => {
      attempts++;
      throw { status: 429, message: "slow", retryAfterMs: 10 * 60 * 1000 };
    },
    {
      retries: 5,
      rateLimitRetries: 6,
      rateLimitMaxServerDelayMs: 5 * 60 * 1000,
      sleep: async ms => { sleeps.push(ms); },
    },
  ).catch(() => {});
  expect(attempts).toBe(1);
  expect(sleeps).toEqual([]);
});

test("withRetry: the escalating 429 floor is capped at 30s and spans ~a minute over the default budget", async () => {
  const sleeps: number[] = [];
  await withRetry(
    async () => { throw { status: 429, message: "slow down" }; },
    {
      retries: 1,
      rateLimitRetries: 6, // the resolveRetryOptions default budget
      rateLimitMinDelayMs: 2000,
      baseDelayMs: 100,
      maxDelayMs: 100,
      random: () => 1,
      sleep: async ms => { sleeps.push(ms); },
    },
  ).catch(() => {});
  // 2s → 4s → 8s → 16s → 30s (32s capped): ≈60s total, covering a per-minute window.
  expect(sleeps).toEqual([2000, 4000, 8000, 16000, 30000]);
});

test("withRetry: onRetry receives the actually-applied delay", async () => {
  const seen: Array<{ attempt: number; delayMs: number }> = [];
  await withRetry(
    async () => { throw { status: 429, message: "slow" }; },
    {
      retries: 1,
      rateLimitRetries: 2,
      rateLimitMinDelayMs: 2000,
      baseDelayMs: 1,
      sleep: async () => {},
      onRetry: (attempt, _err, delayMs) => { seen.push({ attempt, delayMs }); },
    },
  ).catch(() => {});
  expect(seen).toEqual([{ attempt: 1, delayMs: 2000 }]);
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

test("defaultRetryable: transient empty 200s retry, deterministic budget empties fail fast", () => {
  // Transient empty content (no reason or a non-budget stop) is a known intermittent
  // failure — retry it instead of dropping the turn.
  expect(defaultRetryable(new Error("Anthropic returned no content."))).toBe(true);
  expect(defaultRetryable(new Error("Anthropic returned no content (stop_reason=end_turn)."))).toBe(true);
  expect(defaultRetryable(new Error("Gemini returned no content (SAFETY)."))).toBe(true);
  expect(defaultRetryable(new Error("OpenAI returned no content."))).toBe(true);
  // Deterministic budget exhaustion re-empties on every retry → fail fast (surface the hint).
  expect(defaultRetryable(new Error("Anthropic returned no content (stop_reason=max_tokens) — output budget exhausted before any text; raise maxTokens or lower the thinking level."))).toBe(false);
  expect(defaultRetryable(new Error("OpenAI returned no content (finish_reason=length) — output budget exhausted before any text; raise maxTokens or lower reasoning effort."))).toBe(false);
  expect(defaultRetryable(new Error("OpenAI Codex returned no content (max_output_tokens) — output budget exhausted."))).toBe(false);
  expect(defaultRetryable(new Error("Ollama returned no content (done_reason=length) — output budget exhausted before any text; raise maxTokens."))).toBe(false);
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

test("resolveRetryOptions: failFastStatuses forces a normally-retried status non-retryable", () => {
  // Baseline: 503 is in the default retryable set, so it would normally retry.
  expect(defaultRetryable({ status: 503 })).toBe(true);
  expect(resolveRetryOptions({}).isRetryable!({ status: 503 }, 1)).toBe(true);
  // Pinned: 503 now fails fast, but other transient statuses still retry.
  const opts = resolveRetryOptions({ failFastStatuses: [503] });
  expect(opts.isRetryable!({ status: 503 }, 1)).toBe(false);
  expect(opts.isRetryable!({ status: 500 }, 1)).toBe(true);
  // failFastStatuses keys off the STRUCTURED `.status` field only, so a 503 embedded
  // only in the message text is NOT failed fast — it still retries via defaultRetryable.
  expect(opts.isRetryable!(new Error("upstream returned HTTP 503"), 1)).toBe(true);
});

test("resolveRetryOptions: failFastPatterns makes a matching message non-retryable (case-insensitive)", () => {
  // Baseline: an "overloaded" message is retryable by default.
  expect(defaultRetryable(new Error("server Overloaded"))).toBe(true);
  const opts = resolveRetryOptions({ failFastPatterns: ["overloaded"] });
  expect(opts.isRetryable!(new Error("server Overloaded"), 1)).toBe(false);
  // A non-matching but otherwise-retryable error still retries.
  expect(opts.isRetryable!(new Error("network timeout"), 1)).toBe(true);
});

test("resolveRetryOptions: unset fail-fast overrides leave isRetryable unchanged (defaultRetryable)", () => {
  expect(resolveRetryOptions({}).isRetryable).toBe(defaultRetryable);
  expect(resolveRetryOptions({ requestMaxRetries: 2 }).isRetryable).toBe(defaultRetryable);
  // Empty arrays are a no-op too.
  expect(resolveRetryOptions({ failFastStatuses: [], failFastPatterns: [] }).isRetryable).toBe(defaultRetryable);
});
