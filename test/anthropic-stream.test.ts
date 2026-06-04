import { test, expect } from "bun:test";
import { anthropicAdapter } from "../src/ai/providers/anthropic";
import type { CallOptions } from "../src/ai/types";

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(e));
      c.close();
    },
  });
}

test("anthropicAdapter.stream: yields text_delta content, ignores other events", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      sseStream([
        'event: message_start\ndata: {"type":"message_start"}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    )) as typeof fetch;

  try {
    const opts: CallOptions = { model: "claude-3-5-sonnet", maxTokens: 50 };
    const cred = { kind: "api_key", provider: "anthropic", token: "k" } as const;
    let text = "";
    let chunks = 0;
    for await (const d of anthropicAdapter.stream!([{ role: "user", content: "hi" }], opts, cred)) {
      text += d;
      chunks++;
    }
    expect(text).toBe("Hello");
    expect(chunks).toBe(2); // only the two text_delta events
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("anthropicAdapter.stream: reports usage from message_start/message_delta", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      sseStream([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":0}}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
        'data: {"type":"message_delta","usage":{"output_tokens":5}}\n\n',
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    )) as typeof fetch;
  try {
    const usages: any[] = [];
    const cred = { kind: "api_key", provider: "anthropic", token: "k" } as const;
    let text = "";
    for await (const d of anthropicAdapter.stream!([{ role: "user", content: "x" }], { model: "claude-3-5-sonnet", onUsage: u => usages.push(u) }, cred)) text += d;
    expect(text).toBe("hi");
    expect(usages).toContainEqual({ inputTokens: 12, outputTokens: 0 });
    expect(usages).toContainEqual({ outputTokens: 5 });
  } finally {
    globalThis.fetch = prevFetch;
  }
});
