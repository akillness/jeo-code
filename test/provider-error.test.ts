import { test, expect } from "bun:test";
import { friendlyProviderError } from "../src/util/provider-error";
import { ProviderHttpError } from "../src/ai/providers/errors";

test("friendlyProviderError maps a 429 to an actionable rate-limit line (no raw JSON)", () => {
  const err = new ProviderHttpError("Anthropic", 429, '{"type":"error","error":{"type":"rate_limit_error"}}');
  const out = friendlyProviderError(err);
  expect(out).toContain("Rate limited by Anthropic");
  expect(out).toContain("/model");
  expect(out).not.toContain("rate_limit_error"); // raw JSON body is dropped
});

test("friendlyProviderError includes Retry-After reset hints for long 429 windows", () => {
  const err = new ProviderHttpError("Anthropic", 429, "slow down", undefined, 57 * 60 * 1000);
  const out = friendlyProviderError(err);
  expect(out).toContain("Rate limited by Anthropic");
  expect(out).toContain("~57m");
  expect(out).not.toContain("slow down");
});

test("friendlyProviderError detects 429 from the message when status is absent", () => {
  const out = friendlyProviderError(new Error("OpenAI request failed (HTTP 429): rate limit"));
  expect(out).toContain("Rate limited by OpenAI");
});

test("friendlyProviderError maps 401/403 to a credential-check hint", () => {
  const out = friendlyProviderError(new ProviderHttpError("Gemini", 401, "unauthorized"));
  expect(out).toContain("Gemini");
  expect(out).toContain("jeo auth status");
});

test("friendlyProviderError passes through unrelated errors unchanged", () => {
  expect(friendlyProviderError(new Error("boom"))).toBe("boom");
});

test("friendlyProviderError maps a bare AbortSignal.timeout() DOMException to a call-timeout hint", () => {
  // Root cause: GPT-5.5/o3-class HIGH/XHIGH-reasoning completions on the non-streaming
  // call() path legitimately exceed the wall-clock cap; the raw error was an opaque
  // "TimeoutError: The operation timed out." with no guidance on how to raise the cap.
  const err = new DOMException("The operation timed out.", "TimeoutError");
  const out = friendlyProviderError(err);
  expect(out).toContain("JEO_CALL_TIMEOUT_MS");
  expect(out).toContain("30min");
  expect(out).not.toContain("The operation timed out"); // raw DOMException text is replaced
});

test("friendlyProviderError maps the stream overall-deadline message to a JEO_STREAM_MAX_MS hint", () => {
  const err = new Error("stream exceeded the overall deadline (JEO_STREAM_MAX_MS) — slow-drip stream aborted");
  const out = friendlyProviderError(err);
  expect(out).toContain("JEO_STREAM_MAX_MS");
  expect(out).toContain("30min");
  expect(out).toContain("0 to disable");
});
