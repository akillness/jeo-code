import { test, expect } from "bun:test";
import { geminiAdapter } from "../src/ai/providers/gemini";
import type { CallOptions, Usage } from "../src/ai/types";
import { isProviderStreamError, isRateLimitError, defaultRetryable } from "../src/util/retry";

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (const e of events) c.enqueue(enc.encode(e)); c.close(); } });
}

test("geminiAdapter.stream: concatenates SSE text deltas + reports usage", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      sseStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2}}\n\n',
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    )) as typeof fetch;
  try {
    let usage: Usage | undefined;
    const opts: CallOptions = { model: "gemini-2.5-flash", onUsage: u => { usage = u; } };
    const cred = { kind: "api_key", provider: "gemini", token: "k" } as const;
    let text = "";
    for await (const d of geminiAdapter.stream!([{ role: "user", content: "hi" }], opts, cred)) text += d;
    expect(text).toBe("Hello");
    expect(usage).toEqual({ inputTokens: 4, outputTokens: 2 });
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("geminiAdapter.stream: throws on blocked empty SSE response", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      sseStream([
        'data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n',
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    )) as typeof fetch;
  try {
    const opts: CallOptions = { model: "gemini-2.5-flash" };
    const cred = { kind: "api_key", provider: "gemini", token: "k" } as const;
    const run = async () => {
      for await (const _ of geminiAdapter.stream!([{ role: "user", content: "hi" }], opts, cred)) {
        // consume stream
      }
    };
    await expect(run()).rejects.toThrow("Gemini returned no content (blockReason=SAFETY).");
  } finally {
    globalThis.fetch = prevFetch;
  }
});

// Structural fix for "안티그라비티/코덱스 모델이 중간에 멈추는 현상": Google's streaming
// endpoints can emit a `google.rpc.Status`-shaped in-band error LINE on an otherwise-live
// 200 SSE connection (mirrors OpenAI Responses' `response.failed`/`error` events, already
// fixed in openai-responses.ts). Previously this line matched neither `candidates` nor
// `promptFeedback` and was silently ignored — if some text had already streamed, the turn
// just ended early with a truncated reply and NO error at all.
test("geminiAdapter.stream: an in-band error line throws ProviderStreamError mid-stream (not silently swallowed)", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      sseStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"partial "}]}}]}\n\n',
        'data: {"error":{"code":500,"message":"internal error","status":"INTERNAL"}}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"never reached"}]}}]}\n\n',
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    )) as typeof fetch;
  try {
    const opts: CallOptions = { model: "gemini-2.5-flash" };
    const cred = { kind: "api_key", provider: "gemini", token: "k" } as const;
    let text = "";
    let caught: Error | undefined;
    try {
      for await (const d of geminiAdapter.stream!([{ role: "user", content: "hi" }], opts, cred)) text += d;
    } catch (err) {
      caught = err as Error;
    }
    // The pre-error delta streamed (proves this is a MID-stream fault, not a first-chunk one).
    expect(text).toBe("partial ");
    expect(caught).toBeDefined();
    expect(isProviderStreamError(caught)).toBe(true);
    expect(caught!.message).toContain("Gemini stream failed (INTERNAL): internal error");
    expect((caught as any).status).toBe(500);
    expect(defaultRetryable(caught)).toBe(true);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("geminiAdapter.stream: an in-band RESOURCE_EXHAUSTED error line classifies as a rate limit (status 429)", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      sseStream(['data: {"error":{"code":429,"message":"quota exceeded","status":"RESOURCE_EXHAUSTED"}}\n\n']),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    )) as typeof fetch;
  try {
    const opts: CallOptions = { model: "gemini-2.5-flash" };
    const cred = { kind: "api_key", provider: "gemini", token: "k" } as const;
    let caught: Error | undefined;
    try {
      for await (const _ of geminiAdapter.stream!([{ role: "user", content: "hi" }], opts, cred)) { /* drain */ }
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect((caught as any).status).toBe(429);
    expect(isRateLimitError(caught)).toBe(true);
  } finally {
    globalThis.fetch = prevFetch;
  }
});
