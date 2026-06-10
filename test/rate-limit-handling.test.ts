import { test, expect } from "bun:test";
import { defaultRetryable, isUsageLimitError, withRetry } from "../src/util/retry";
import { ProviderHttpError } from "../src/ai/providers/errors";
import { friendlyProviderError } from "../src/util/provider-error";
import { renderJocStatus } from "../src/tui/components/status";
import { renderFooter } from "../src/tui/components/footer";
import { LaunchTui } from "../src/tui/app";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("isUsageLimitError: quota/usage phrasings yes, per-minute rate limit no", () => {
  expect(isUsageLimitError(new Error('Anthropic request failed (HTTP 429): {"error":{"message":"You have exceeded your usage limit."}}'))).toBe(true);
  expect(isUsageLimitError(new Error("usage_limit_reached"))).toBe(true);
  expect(isUsageLimitError(new Error("Quota exceeded for this billing period"))).toBe(true);
  // Per-minute window — transient, must stay retryable.
  expect(isUsageLimitError(new Error("Rate limit exceeded: too many requests per minute"))).toBe(false);
  // Gemini RESOURCE_EXHAUSTED is deliberately NOT classified as a persistent usage limit.
  expect(isUsageLimitError(new Error("HTTP 429: RESOURCE_EXHAUSTED"))).toBe(false);
});

test("defaultRetryable: usage-limit 429 fails fast, per-minute 429 stays retryable", () => {
  const usage = new ProviderHttpError("Anthropic", 429, "You have exceeded your usage limit.");
  expect(defaultRetryable(usage)).toBe(false);
  const perMinute = new ProviderHttpError("Anthropic", 429, "rate limited, slow down");
  expect(defaultRetryable(perMinute)).toBe(true);
});

test("withRetry does not burn budget on a usage-limit 429", async () => {
  let calls = 0;
  await expect(
    withRetry(
      async () => {
        calls++;
        throw new ProviderHttpError("Anthropic", 429, "usage limit reached for this window");
      },
      { retries: 5, rateLimitRetries: 6, baseDelayMs: 1, sleep: async () => {} },
    ),
  ).rejects.toThrow("usage limit");
  expect(calls).toBe(1); // no retries — the window will not clear in seconds
});

test("friendlyProviderError: usage-limit gets a switch-model message, not the generic 429 line", () => {
  const usage = new ProviderHttpError("Anthropic", 429, "You have exceeded your usage limit.");
  const msg = friendlyProviderError(usage);
  expect(msg).toContain("usage/quota limit reached");
  expect(msg).toContain("/model");
  expect(msg).not.toContain("Auto-retry was exhausted");
  const perMinute = new ProviderHttpError("Anthropic", 429, "too many requests");
  expect(friendlyProviderError(perMinute)).toContain("Rate limited by Anthropic");
});

test("[STEP] row shows the meter percent exactly once", () => {
  const [stepRow] = renderJocStatus({ step: 1, maxSteps: 25, elapsedMs: 18_000, unicode: false, color: false });
  const percents = stripAnsi(stepRow!).match(/\d+%/g) ?? [];
  expect(percents.length).toBe(1); // was "4% [..........] 4%" — duplicated
});

test("footer ETA needs at least one completed step (no eta at step 1)", () => {
  const atStep1 = stripAnsi(renderFooter({ model: "m", step: 1, maxSteps: 25, elapsedMs: 18_000, showEta: true }));
  expect(atStep1).not.toContain("eta");
  const atStep2 = stripAnsi(renderFooter({ model: "m", step: 2, maxSteps: 10, elapsedMs: 4000, showEta: true }));
  expect(atStep2).toContain("eta 16s");
});

test("LaunchTui pins rate-limit retry notice in status without appending log spam", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", write: s => out.push(s) });
  tui.start();
  const ev = tui.events();
  ev.onStep!(1);
  ev.onNotice!("rate limited (HTTP 429) — auto-retry #2 in 4s");
  const text = stripAnsi(out.join(""));
  expect(text).toContain("auto-retry #2 in 4s");
  expect((text.match(/auto-retry #2 in 4s/g) ?? []).length).toBe(1);
  // The model reply clears the pinned notice.
  ev.onAssistant!("", { tool: "read" });
  out.length = 0;
  ev.onToolResult!("read", true, "ok");
  expect(stripAnsi(out.join(""))).not.toContain("auto-retry #2");
  tui.finish("done");
});
