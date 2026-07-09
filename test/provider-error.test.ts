import { test, expect } from "bun:test";
import { friendlyProviderError } from "../src/util/provider-error";
import { ProviderHttpError, ProviderStreamError, relabelProviderError } from "../src/ai/providers/errors";


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

test("friendlyProviderError maps 402 (billing/payment) to an actionable billing hint (no raw JSON)", () => {
  const err = new ProviderHttpError("Tencent", 402, '{"error":{"message":"The free trial quota for the service has been exhausted and postpaid billing is not enabled, so the service cannot be accessed.","type":"api_error"}}');
  const out = friendlyProviderError(err);
  expect(out).toContain("Tencent");
  expect(out).toContain("billing/payment");
  expect(out).toContain("402");
  expect(out).toContain("/model");
  expect(out).not.toContain("api_error"); // raw JSON body is dropped
});

test("friendlyProviderError detects 402 from the message when status is absent", () => {
  const out = friendlyProviderError(new Error("Anthropic request failed (HTTP 402): free trial quota exhausted"));
  expect(out).toContain("billing/payment");
  expect(out).toContain("402");
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

test("relabelProviderError reconstructs ProviderHttpError with new provider label", () => {
  const orig = new ProviderHttpError("Anthropic", 401, "unauthorized");
  const relabeled = relabelProviderError(orig, "Groq");
  expect(relabeled).toBeInstanceOf(ProviderHttpError);
  const err = relabeled as ProviderHttpError;
  expect(err.provider).toBe("Groq");
  expect(err.message).toContain("Groq");
  expect(err.message).not.toContain("Anthropic");
  expect(err.status).toBe(401);
  expect(err.detail).toBe("unauthorized");
});

test("relabelProviderError preserves retryAfterMs on ProviderHttpError", () => {
  const orig = new ProviderHttpError("OpenAI", 429, "rate limited", undefined, 5000);
  const relabeled = relabelProviderError(orig, "DeepSeek") as ProviderHttpError;
  expect(relabeled.retryAfterMs).toBe(5000);
  expect(relabeled.provider).toBe("DeepSeek");
});

test("relabelProviderError reconstructs ProviderStreamError with new provider label", () => {
  const orig = new ProviderStreamError("OpenAI", "server error", "server_error", 500);
  const relabeled = relabelProviderError(orig, "Groq") as ProviderStreamError;
  expect(relabeled).toBeInstanceOf(ProviderStreamError);
  expect(relabeled.provider).toBe("Groq");
  expect(relabeled.message).toContain("Groq");
  expect(relabeled.message).not.toContain("OpenAI");
  expect(relabeled.status).toBe(500);
  expect(relabeled.code).toBe("server_error");
});

test("relabelProviderError passes through non-provider errors unchanged", () => {
  const orig = new Error("generic error");
  const relabeled = relabelProviderError(orig, "Groq");
  expect(relabeled).toBe(orig);
  expect(relabeled).toBeInstanceOf(Error);
});
