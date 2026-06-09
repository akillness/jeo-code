import { test, expect } from "bun:test";
import { geminiAdapter } from "../src/ai/providers/gemini";
import type { CallOptions, Usage } from "../src/ai/types";

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
