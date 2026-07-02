import { test, expect } from "bun:test";
import { codexResponsesRequest, parseResponsesEvent, normalizePromptCacheKey } from "../src/ai/providers/openai-responses";
import type { CallOptions } from "../src/ai/types";

const oauth = { kind: "oauth" as const, provider: "openai" as const, token: "x.y.z" };

test("codexResponsesRequest: forwards reasoningEffort as reasoning.effort", () => {
  const withEffort = JSON.parse(
    codexResponsesRequest([{ role: "user", content: "hi" }], { model: "gpt-5.5", reasoningEffort: "high" } as any, oauth).body,
  );
  expect(withEffort.reasoning).toEqual({ effort: "high", summary: "auto" });

  const without = JSON.parse(
    codexResponsesRequest([{ role: "user", content: "hi" }], { model: "gpt-5.5" } as any, oauth).body,
  );
  expect(without.reasoning).toBeUndefined();
});

test("codexResponsesRequest: drops out-of-enum reasoningEffort instead of forwarding it", () => {
  const invalid = JSON.parse(
    codexResponsesRequest([{ role: "user", content: "hi" }], { model: "gpt-5.5", reasoningEffort: "max" } as any, oauth).body,
  );
  expect(invalid.reasoning).toBeUndefined();
});

test("parseResponsesEvent: captures usage on response.incomplete (not just completed)", () => {
  const incomplete = parseResponsesEvent(
    JSON.stringify({ type: "response.incomplete", response: { usage: { input_tokens: 12, output_tokens: 3 } } }),
  );
  expect(incomplete.usage).toEqual({ inputTokens: 12, outputTokens: 3 });

  const completed = parseResponsesEvent(
    JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 7 } } }),
  );
  expect(completed.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
});

test("parseResponsesEvent: delta + error events still parse", () => {
  expect(parseResponsesEvent(JSON.stringify({ type: "response.output_text.delta", delta: "hello" }))).toEqual({ delta: "hello" });
  expect(parseResponsesEvent(JSON.stringify({ type: "response.failed", response: { error: { message: "boom" } } })).error).toBe("boom");
});

test("codexResponsesRequest: forwards options.maxTokens as max_output_tokens (absent when unset)", () => {
  const withBudget = JSON.parse(
    codexResponsesRequest([{ role: "user", content: "hi" }], { model: "gpt-5.5", maxTokens: 12000 } as any, oauth).body,
  );
  expect(withBudget.max_output_tokens).toBe(12000);

  const without = JSON.parse(
    codexResponsesRequest([{ role: "user", content: "hi" }], { model: "gpt-5.5" } as any, oauth).body,
  );
  expect(without.max_output_tokens).toBeUndefined();
});

test("codexResponsesRequest: sends a Codex-CLI-shaped User-Agent on OAuth and api-key paths", () => {
  // originator/version (platform release; arch) — without it Bun's default UA leaks to the backend.
  const uaShape = /^codex_cli_rs\/\d+\.\d+\.\d+\S* \(\S+ \S+; \S+\)$/;

  const oauthReq = codexResponsesRequest([{ role: "user", content: "hi" }], { model: "gpt-5.5" } as any, oauth);
  expect(oauthReq.headers["user-agent"]).toMatch(uaShape);

  const apiKey = { kind: "api_key" as const, provider: "openai" as const, token: "sk-1" };
  const apiKeyReq = codexResponsesRequest([{ role: "user", content: "hi" }], { model: "gpt-5.5" } as any, apiKey);
  expect(apiKeyReq.headers["user-agent"]).toMatch(uaShape);
  // max_output_tokens rides the shared payload — present on the api-key path too.
  const apiKeyBody = JSON.parse(
    codexResponsesRequest([{ role: "user", content: "hi" }], { model: "gpt-5.5", maxTokens: 8000 } as any, apiKey).body,
  );
  expect(apiKeyBody.max_output_tokens).toBe(8000);
});

test("codexResponsesRequest: sessionKey stamps prompt_cache_key + Codex correlation headers (gjc parity)", () => {
  const options: CallOptions = { model: "gpt-5.5", sessionKey: "sess-1234" };
  const req = codexResponsesRequest([{ role: "user", content: "hi" }], options, oauth);
  const body = JSON.parse(req.body) as { prompt_cache_key?: string };
  expect(body.prompt_cache_key).toBe("sess-1234");
  expect(req.headers.session_id).toBe("sess-1234");
  expect(req.headers.conversation_id).toBe("sess-1234");
  expect(req.headers["x-client-request-id"]).toBe("sess-1234");

  // Without a sessionKey: no cache key, no correlation headers (unchanged behavior).
  const bare = codexResponsesRequest([{ role: "user", content: "hi" }], { model: "gpt-5.5" }, oauth);
  const bareBody = JSON.parse(bare.body) as { prompt_cache_key?: string };
  expect(bareBody.prompt_cache_key).toBeUndefined();
  expect(bare.headers.session_id).toBeUndefined();
  expect(bare.headers.conversation_id).toBeUndefined();
});

test("codexResponsesRequest: api-key path stamps prompt_cache_key in the body (no Codex headers)", () => {
  const apiKeyCred = { kind: "api_key" as const, provider: "openai" as const, token: "sk-1" };
  const options: CallOptions = { model: "gpt-5.5", sessionKey: "sess-xyz" };
  const req = codexResponsesRequest([{ role: "user", content: "hi" }], options, apiKeyCred);
  const body = JSON.parse(req.body) as { prompt_cache_key?: string };
  expect(body.prompt_cache_key).toBe("sess-xyz");
  // Codex correlation headers are the OAuth backend's shape — not sent to api.openai.com.
  expect(req.headers.session_id).toBeUndefined();
});

test("normalizePromptCacheKey: ≤64 chars verbatim; longer keys hash to a stable pc_ form", () => {
  expect(normalizePromptCacheKey(undefined)).toBeUndefined();
  expect(normalizePromptCacheKey("")).toBeUndefined();
  expect(normalizePromptCacheKey("short-key")).toBe("short-key");
  const long = "k".repeat(100);
  const hashed = normalizePromptCacheKey(long)!;
  expect(hashed.startsWith("pc_")).toBe(true);
  expect(hashed.length).toBeLessThanOrEqual(64);
  expect(normalizePromptCacheKey(long)).toBe(hashed); // stable
});
