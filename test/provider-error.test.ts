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

test("friendlyProviderError detects 429 from the message when status is absent", () => {
  const out = friendlyProviderError(new Error("OpenAI request failed (HTTP 429): rate limit"));
  expect(out).toContain("Rate limited by OpenAI");
});

test("friendlyProviderError maps 401/403 to a credential-check hint", () => {
  const out = friendlyProviderError(new ProviderHttpError("Gemini", 401, "unauthorized"));
  expect(out).toContain("Gemini");
  expect(out).toContain("joc auth status");
});

test("friendlyProviderError passes through unrelated errors unchanged", () => {
  expect(friendlyProviderError(new Error("boom"))).toBe("boom");
});
