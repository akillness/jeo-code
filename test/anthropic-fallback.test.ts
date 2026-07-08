import { test, expect, beforeEach, afterEach } from "bun:test";
import { anthropicAdapter, anthropicRequest } from "../src/ai/providers/anthropic";
import type { CallOptions, Message, ReasoningArtifact } from "../src/ai/types";
import type { Credential } from "../src/auth";
import { isRefusalError } from "../src/util/retry";
import { friendlyProviderError } from "../src/util/provider-error";

// Anthropic server-side fallback (docs.claude.com/en/docs/build-with-claude/refusals-and-fallback):
// scoped to claude-fable-* on a direct api.anthropic.com API-key call only. These tests cover
// the 5 contract points: request gating, served-model tagging on call()/stream(), the mid-stream
// fallback boundary, the 400-fallback-unsupported fail-safe, and the untouched refusal ladder for
// models that never qualify.

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(e));
      c.close();
    },
  });
}

const apiKeyCred: Credential = { kind: "api_key", provider: "anthropic", token: "k" };
const oauthCred: Credential = { kind: "oauth", provider: "anthropic", token: "oauth-tok" };
const messages: Message[] = [{ role: "user", content: "hi" }];

// JEO_ANTHROPIC_FALLBACK is a global env flag anthropicFallbackModels reads directly from
// process.env — guard every test in this file against ambient host state and against leaking
// into other test files that run in the same bun test process.
let prevFallbackEnv: string | undefined;
beforeEach(() => {
  prevFallbackEnv = process.env.JEO_ANTHROPIC_FALLBACK;
  delete process.env.JEO_ANTHROPIC_FALLBACK;
});
afterEach(() => {
  if (prevFallbackEnv === undefined) delete process.env.JEO_ANTHROPIC_FALLBACK;
  else process.env.JEO_ANTHROPIC_FALLBACK = prevFallbackEnv;
});

test("anthropicRequest: fallbacks body param + beta header appear ONLY for fable-5 + api_key + no baseUrl (and disableFallback suppresses even that case)", () => {
  const cases: { name: string; model: string; credential: Credential; baseUrl?: string; disableFallback?: boolean }[] = [
    { name: "fable-5 + api_key + no baseUrl qualifies", model: "claude-fable-5", credential: apiKeyCred },
    { name: "sonnet-5 (non-fable) never qualifies", model: "claude-sonnet-5", credential: apiKeyCred },
    { name: "mythos-5 (non-fable, NOT included) never qualifies", model: "claude-mythos-5", credential: apiKeyCred },
    { name: "fable-5 + oauth credential does not qualify", model: "claude-fable-5", credential: oauthCred },
    { name: "fable-5 + api_key + baseUrl set does not qualify", model: "claude-fable-5", credential: apiKeyCred, baseUrl: "https://z.ai" },
    { name: "fable-5 + api_key + explicit disableFallback:true suppresses an otherwise-qualifying call", model: "claude-fable-5", credential: apiKeyCred, disableFallback: true },
  ];
  const qualifies = (name: string) => name.startsWith("fable-5 + api_key + no baseUrl");

  for (const c of cases) {
    const options: CallOptions = { model: c.model, maxTokens: 4000, baseUrl: c.baseUrl };
    const req = anthropicRequest(messages, options, c.credential, false, true, false, c.disableFallback ?? false);
    const body = JSON.parse(req.body) as { fallbacks?: { model: string }[] };
    const beta = req.headers["anthropic-beta"] ?? "";
    if (qualifies(c.name)) {
      expect(body.fallbacks).toEqual([{ model: "claude-opus-4-8" }]);
      expect(beta).toContain("server-side-fallback-2026-06-01");
    } else {
      expect(body.fallbacks).toBeUndefined();
      expect(beta).not.toContain("server-side-fallback-2026-06-01");
    }
  }
});

test("anthropicRequest: JEO_ANTHROPIC_FALLBACK=0 suppresses fallback for an otherwise-qualifying fable-5 + api_key call", () => {
  process.env.JEO_ANTHROPIC_FALLBACK = "0";
  const options: CallOptions = { model: "claude-fable-5", maxTokens: 4000 };
  const req = anthropicRequest(messages, options, apiKeyCred, false, true);
  const body = JSON.parse(req.body) as { fallbacks?: { model: string }[] };
  expect(body.fallbacks).toBeUndefined();
  expect(req.headers["anthropic-beta"] ?? "").not.toContain("server-side-fallback-2026-06-01");
});

test("anthropicAdapter.call: reasoning artifact is tagged with the ACTUAL served model (response.model), not the requested model", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        model: "claude-opus-4-8", // served model differs from the requested claude-fable-5
        content: [
          { type: "thinking", thinking: "reasoning...", signature: "sig-abc" },
          { type: "text", text: "answer" },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    const arts: ReasoningArtifact[] = [];
    const opts: CallOptions = {
      model: "claude-fable-5",
      maxTokens: 50,
      reasoningEffort: "high",
      onReasoningArtifact: a => { arts.push(a); },
    };
    const text = await anthropicAdapter.call([{ role: "user", content: "hi" }], opts, apiKeyCred);
    expect(text).toBe("answer");
    expect(arts).toEqual([{ provider: "anthropic", model: "claude-opus-4-8", text: "reasoning...", signature: "sig-abc" }]);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("anthropicAdapter.stream: reasoning artifact is tagged from message_start.message.model (served model), not the requested model", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      sseStream([
        'data: {"type":"message_start","message":{"model":"claude-opus-4-8"}}\n\n',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"pondering"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-xyz"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"answer"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;
  try {
    const arts: ReasoningArtifact[] = [];
    const opts: CallOptions = { model: "claude-fable-5", reasoningEffort: "high", onReasoningArtifact: a => { arts.push(a); } };
    let text = "";
    for await (const d of anthropicAdapter.stream!([{ role: "user", content: "x" }], opts, apiKeyCred)) text += d;
    expect(text).toBe("answer");
    expect(arts).toEqual([{ provider: "anthropic", model: "claude-opus-4-8", text: "pondering", signature: "sig-xyz" }]);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("anthropicAdapter.stream: a mid-stream content_block_start(type:'fallback') does not crash the parser and updates to.model for subsequent artifact tagging", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      sseStream([
        'data: {"type":"message_start","message":{"model":"claude-fable-5"}}\n\n',
        // The declining model starts thinking before the safety classifier hands off.
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"declining thought"}}\n\n',
        // Mid-stream fallback boundary: no index, names the model the turn handed off to.
        'data: {"type":"content_block_start","content_block":{"type":"fallback","to":{"model":"claude-opus-4-8"}}}\n\n',
        // The fallback model resumes with its own thinking block at the same index.
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"fallback thought"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-fb"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"answer"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;
  try {
    const arts: ReasoningArtifact[] = [];
    const opts: CallOptions = { model: "claude-fable-5", reasoningEffort: "high", onReasoningArtifact: a => { arts.push(a); } };
    let text = "";
    let threw = false;
    try {
      for await (const d of anthropicAdapter.stream!([{ role: "user", content: "x" }], opts, apiKeyCred)) text += d;
    } catch {
      threw = true;
    }
    expect(threw).toBe(false); // the fallback boundary must not crash the SSE parser
    expect(text).toBe("answer");
    // The pre-fallback thought (declining model) was dropped at the fallback boundary; only
    // the post-fallback thought survives, tagged with the fallback's `to.model`.
    expect(arts).toEqual([{ provider: "anthropic", model: "claude-opus-4-8", text: "fallback thought", signature: "sig-fb" }]);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("anthropicAdapter.call: a 400 naming 'fallback' retries ONCE with disableFallback and succeeds transparently (exactly 2 fetch calls, caller never sees the 400)", async () => {
  const prevFetch = globalThis.fetch;
  let calls = 0;
  const bodies: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const body = String(init?.body ?? "");
    bodies.push(body);
    calls++;
    const parsed = JSON.parse(body) as { fallbacks?: unknown };
    if (parsed.fallbacks) {
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "This account is not enrolled in the server-side fallback beta." },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 3, output_tokens: 2 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const opts: CallOptions = { model: "claude-fable-5", maxTokens: 50 };
    const text = await anthropicAdapter.call([{ role: "user", content: "hi" }], opts, apiKeyCred);
    expect(text).toBe("ok"); // never throws — the caller never sees the intermediate 400
    expect(calls).toBe(2);
    expect((JSON.parse(bodies[0]!) as { fallbacks?: unknown }).fallbacks).toEqual([{ model: "claude-opus-4-8" }]);
    expect((JSON.parse(bodies[1]!) as { fallbacks?: unknown }).fallbacks).toBeUndefined();
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("regression: a refusal on a non-fable model (never fallback-eligible) still throws, and isRefusalError/friendlyProviderError classify it exactly as before this change", async () => {
  const prevFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(
      JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "Refusal (reasoning_extraction): This request was blocked as it seems to violate Anthropic's Terms of Service." },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const opts: CallOptions = { model: "claude-sonnet-5", maxTokens: 50 };
    let caught: Error | undefined;
    try {
      await anthropicAdapter.call([{ role: "user", content: "hi" }], opts, apiKeyCred);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    // claude-sonnet-5 never qualifies for a fallback (non-fable) — no fallbacks param was ever
    // sent, so the 400-fallback-unsupported fail-safe never engages either. Exactly one call.
    expect(calls).toBe(1);
    expect(isRefusalError(caught!)).toBe(true);
    const friendly = friendlyProviderError(caught!);
    expect(friendly).toContain("declined to answer (safety refusal — no content returned)");
    expect(friendly).toContain("reasoning_extraction");
    expect(friendly).toContain("not an actual violation");
  } finally {
    globalThis.fetch = prevFetch;
  }
});
