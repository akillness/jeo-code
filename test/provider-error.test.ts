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

// Antigravity/Gemini's `google.rpc.Status` shape (an explicit numeric `error.code`
// passed straight through as `explicitStatus`) and OpenAI Codex's `response.failed`/
// `error` SSE event shape (no `explicitStatus` — defaults to 500 for any non-
// rate_limit_exceeded code) both carry a STRING status code in the composed message
// ("… (INTERNAL): …", "… (server_error): …") with no digits anywhere — before this
// fix these fell through every branch to the bare `return msg;`, so launch.ts's
// `/\b(?:500|502|503|504|529)\b/` post-call reroute regex never matched and the
// equivalent-pool fallback never fired for a fully credentialed same-tier fallback.
test("friendlyProviderError maps a persistent 5xx ProviderStreamError (Antigravity/Gemini google.rpc.Status shape, explicit numeric status) to a message embedding the numeric HTTP code", () => {
  const err = new ProviderStreamError("Antigravity", "internal error", "INTERNAL", 500);
  const out = friendlyProviderError(err);
  expect(out).toContain("500");
  expect(out).toContain("HTTP 500");
  expect(out).toContain("Antigravity");
  expect(out).toContain("persistent server-side error");
  expect(out).toContain("/model");
});

test("friendlyProviderError maps a persistent 5xx ProviderStreamError (OpenAI Codex response.failed shape, no explicitStatus — defaults to 500) to a message embedding the numeric HTTP code", () => {
  const err = new ProviderStreamError("OpenAI Codex", "the server had an error processing your request", "server_error");
  expect(err.status).toBe(500); // confirms the documented explicitStatus ?? 500 default fires
  const out = friendlyProviderError(err);
  expect(out).toContain("500");
  expect(out).toContain("HTTP 500");
  expect(out).toContain("OpenAI Codex");
  expect(out).toContain("persistent server-side error");
});

test("friendlyProviderError maps a persistent 5xx ProviderStreamError (Gemini google.rpc.Status shape, 503 UNAVAILABLE) to a message embedding the numeric HTTP code", () => {
  const err = new ProviderStreamError("Gemini", "model overloaded", "UNAVAILABLE", 503);
  const out = friendlyProviderError(err);
  expect(out).toContain("503");
  expect(out).toContain("HTTP 503");
  expect(out).not.toBe(err.message); // not the bare "Gemini stream failed (UNAVAILABLE): model overloaded"
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

test("friendlyProviderError: OpenAI and Codex auth failures name real OpenAI recovery commands and omit unrelated Google guidance", () => {
  for (const provider of ["OpenAI", "OpenAI Codex"]) {
    const out = friendlyProviderError(new ProviderHttpError(provider, 401, "super-secret-provider-response"));
    expect(out).toContain("jeo auth login openai");
    expect(out).toContain("/provider login openai");
    expect(out).not.toMatch(/antigravity|google|gemini/i);
    expect(out).not.toContain("super-secret-provider-response");
  }
});

test("friendlyProviderError: Gemini API and Antigravity auth failures retain provider-specific recovery guidance", () => {
  const gemini = friendlyProviderError(new ProviderHttpError("Gemini", 403, "unauthorized"));
  expect(gemini).toContain("GEMINI_API_KEY");
  expect(gemini).toContain("antigravity/*");
  expect(gemini).toContain("jeo auth login antigravity");
  expect(gemini).toContain("/provider login antigravity");

  const antigravity = friendlyProviderError(new ProviderHttpError("Antigravity", 403, "unauthorized"));
  expect(antigravity).toContain("jeo auth login antigravity");
  expect(antigravity).toContain("/provider login antigravity");
});

test("friendlyProviderError: raw HTTP 401 and 403 messages preserve their exact status", () => {
  const unauthorized = friendlyProviderError(new Error("OpenAI request failed (HTTP 401): unauthorized"));
  const forbidden = friendlyProviderError(new Error("OpenAI request failed (HTTP 403): forbidden"));
  expect(unauthorized).toContain("HTTP 401");
  expect(unauthorized).not.toContain("HTTP 401/403");
  expect(forbidden).toContain("HTTP 403");
  expect(forbidden).not.toContain("HTTP 401/403");
});

test("friendlyProviderError: a structured non-auth status is not classified from a 401 in its body", () => {
  const out = friendlyProviderError(new ProviderHttpError("OpenAI", 400, "upstream trace contains HTTP 401"));
  expect(out).not.toContain("rejected the credential");
  expect(out).not.toContain("jeo auth login openai");
});

test("friendlyProviderError: provider-specific auth formatting is idempotent across registered and unknown labels", () => {
  for (const provider of ["OpenAI", "OpenAI Codex", "Gemini", "Antigravity", "xAI", "Groq", "DeepSeek", "Mistral", "OpenRouter", "Together", "Cerebras", "Fireworks", "NVIDIA", "Hugging Face", "NanoGPT", "Synthetic", "Venice", "ZenMux", "Qianfan", "Xiaomi", "MiniMax", "Tencent", "DeepInfra", "LiteLLM", "Moonshot", "Registered API Cloud"]) {
    const first = friendlyProviderError(new ProviderHttpError(provider, 401, "unauthorized"));
    expect(friendlyProviderError(new Error(first))).toBe(first);
  }
});

test("friendlyProviderError: API-only provider labels give key commands instead of OAuth login", () => {
  const cases = [
    { label: "Groq", id: "groq", env: "GROQ_API_KEY" },
    { label: "DeepSeek", id: "deepseek", env: "DEEPSEEK_API_KEY" },
    { label: "xAI", id: "xai", env: "XAI_API_KEY" },
  ] as const;
  for (const c of cases) {
    const out = friendlyProviderError(new ProviderHttpError(c.label, 401, "opaque-provider-secret"));
    expect(out).toContain(`/provider key ${c.id}`);
    expect(out).toContain(c.env);
    expect(out).toContain("--token");
    expect(out).not.toContain(`/provider login ${c.id}`);
    expect(out).not.toContain("opaque-provider-secret");
  }
});
test("friendlyProviderError: Kimi/Moonshot auth explains both API-key and subscription paths", () => {
  const out = friendlyProviderError(new ProviderHttpError("Moonshot", 401, "opaque-provider-secret"));
  expect(out).toContain("KIMI_API_KEY");
  expect(out).toContain("/provider key kimi");
  expect(out).toContain("jeo auth login kimi");
  expect(out).not.toContain("/provider login kimi");
  expect(out).not.toContain("opaque-provider-secret");
});

test("friendlyProviderError: unknown auth labels do not echo credential-looking prefixes", () => {
  const out = friendlyProviderError(new Error("sk-secret request failed (HTTP 401): unauthorized"));
  expect(out).toContain("the provider rejected the credential (HTTP 401)");
  expect(out).not.toContain("sk-secret");
  expect(out).not.toContain("/provider login");
});
