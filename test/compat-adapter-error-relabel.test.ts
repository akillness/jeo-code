import { test, expect } from "bun:test";
import { makeAnthropicCompatibleAdapter } from "../src/ai/providers/anthropic-compatible";
import { makeOpenAICompatibleAdapter } from "../src/ai/providers/openai-compatible";
import { relabelProviderError } from "../src/ai/providers/errors";
import { ProviderHttpError, ProviderStreamError } from "../src/ai/providers/errors";
import { friendlyProviderError } from "../src/util/provider-error";
import type { CallOptions, Message } from "../src/ai/types";
import type { Credential } from "../src/auth";

// Regression: `makeAnthropicCompatibleAdapter`/`makeOpenAICompatibleAdapter` delegate
// straight to `anthropicAdapter`/`openaiAdapter`, which hardcode "Anthropic"/"OpenAI" at
// their `ProviderHttpError`/`ProviderStreamError` construction sites. Without relabeling,
// a Tencent/groq/zai/deepseek/… failure surfaced as "Anthropic rejected the credential"
// or "OpenAI requires billing" — sending the user to fix the WRONG account. This file
// proves the compat factories relabel every thrown error to the REAL backend end to end
// (not just the isolated `relabelProviderError` helper in isolation).

const apiKeyCred: Credential = { kind: "api_key", provider: "tencent", token: "k" };
const messages: Message[] = [{ role: "user", content: "hi" }];

test("relabelProviderError: rebuilds a ProviderHttpError under a new provider, preserving status/detail/context/retryAfterMs", () => {
  const original = new ProviderHttpError("Anthropic", 402, '{"error":{"message":"quota exhausted"}}', "(stream)", 5000);
  const relabeled = relabelProviderError(original, "Tencent");
  expect(relabeled).toBeInstanceOf(ProviderHttpError);
  const err = relabeled as ProviderHttpError;
  expect(err.provider).toBe("Tencent");
  expect(err.status).toBe(402);
  expect(err.detail).toBe('{"error":{"message":"quota exhausted"}}');
  expect(err.context).toBe("(stream)");
  expect(err.retryAfterMs).toBe(5000);
  expect(err.message).toContain("Tencent request failed (HTTP 402)");
  expect(err.message).not.toContain("Anthropic");
});

test("relabelProviderError: rebuilds a ProviderStreamError under a new provider, preserving status/code/rawMessage", () => {
  const original = new ProviderStreamError("OpenAI", "server exploded", "server_error", 500);
  const relabeled = relabelProviderError(original, "Groq");
  expect(relabeled).toBeInstanceOf(ProviderStreamError);
  const err = relabeled as ProviderStreamError;
  expect(err.provider).toBe("Groq");
  expect(err.status).toBe(500);
  expect(err.code).toBe("server_error");
  expect(err.rawMessage).toBe("server exploded");
  expect(err.message).toContain("Groq stream failed");
  expect(err.message).not.toContain("OpenAI");
});

test("relabelProviderError: passes through non-ProviderHttpError/ProviderStreamError errors unchanged", () => {
  const bare = new Error("boom");
  expect(relabelProviderError(bare, "Tencent")).toBe(bare);
});

test("makeAnthropicCompatibleAdapter (Tencent, 402 billing failure): call() throws with the REAL provider label, not Anthropic", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ error: { message: "The free trial quota for the service has been exhausted and postpaid billing is not enabled.", type: "api_error" } }),
      { status: 402, headers: { "content-type": "application/json" } },
    )
  ) as typeof fetch;
  try {
    const adapter = makeAnthropicCompatibleAdapter({ name: "tencent", baseUrl: "https://tokenhub-intl.tencentcloudmaas.com" });
    const opts: CallOptions = { model: "tencent/deepseek-v4-pro", maxTokens: 16 };
    let caught: unknown;
    try {
      await adapter.call(messages, opts, apiKeyCred);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderHttpError);
    const httpErr = caught as ProviderHttpError;
    expect(httpErr.provider).toBe("Tencent");
    expect(httpErr.status).toBe(402);
    expect(httpErr.message).toContain("Tencent request failed (HTTP 402)");
    expect(httpErr.message).not.toContain("Anthropic");
    // The full user-facing path: friendlyProviderError must also say Tencent, and give
    // the 402 billing hint — this is what the user actually sees when fallback exhausts.
    const friendly = friendlyProviderError(caught);
    expect(friendly).toContain("Tencent");
    expect(friendly).toContain("billing/payment");
    expect(friendly).not.toContain("Anthropic");
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("makeOpenAICompatibleAdapter (Groq, 429 rate limit): call() throws with the REAL provider label, not OpenAI", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ error: { message: "rate limit exceeded" } }),
      { status: 429, headers: { "content-type": "application/json" } },
    )
  ) as typeof fetch;
  try {
    const adapter = makeOpenAICompatibleAdapter({ name: "groq", baseUrl: "https://api.groq.com/openai/v1" });
    const groqCred: Credential = { kind: "api_key", provider: "groq", token: "k" };
    const opts: CallOptions = { model: "groq/llama-3.3-70b-versatile", maxTokens: 16 };
    let caught: unknown;
    try {
      await adapter.call(messages, opts, groqCred);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderHttpError);
    const httpErr = caught as ProviderHttpError;
    expect(httpErr.provider).toBe("Groq");
    expect(httpErr.status).toBe(429);
    expect(httpErr.message).not.toContain("OpenAI");
    const friendly = friendlyProviderError(caught);
    expect(friendly).toContain("Rate limited by Groq");
    expect(friendly).not.toContain("OpenAI");
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("makeAnthropicCompatibleAdapter (z.ai, 401 auth failure): stream() throws with the REAL provider label, not Anthropic", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ error: { message: "invalid api key" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    )
  ) as typeof fetch;
  try {
    const adapter = makeAnthropicCompatibleAdapter({ name: "zai", baseUrl: "https://api.z.ai/api/anthropic" });
    const zaiCred: Credential = { kind: "api_key", provider: "zai", token: "bad-key" };
    const opts: CallOptions = { model: "zai/glm-5.2", maxTokens: 16 };
    let caught: unknown;
    try {
      for await (const _chunk of adapter.stream!(messages, opts, zaiCred)) { /* drain */ }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderHttpError);
    const httpErr = caught as ProviderHttpError;
    expect(httpErr.provider).toBe("z.ai");
    expect(httpErr.status).toBe(401);
    expect(httpErr.message).not.toContain("Anthropic");
    const friendly = friendlyProviderError(caught);
    expect(friendly).toContain("z.ai");
    expect(friendly).toContain("jeo auth status");
    expect(friendly).not.toContain("Anthropic");
  } finally {
    globalThis.fetch = prevFetch;
  }
});
