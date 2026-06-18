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

test("anthropicAdapter.stream: reports usage ONCE at message_delta (no double-count)", async () => {
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
    // Round-5 #3: message_start only CACHES input; the single report happens at
    // message_delta — an accumulating sink must see exactly one event.
    expect(usages).toEqual([{ inputTokens: 12, outputTokens: 5 }]);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("anthropicAdapter.call: retries once without temperature when the model deprecates it", async () => {
  const prevFetch = globalThis.fetch;
  const bodies: string[] = [];
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    bodies.push(String(init?.body ?? ""));
    calls++;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "`temperature` is deprecated for this model." },
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
    const cred = { kind: "api_key", provider: "anthropic", token: "k" } as const;
    const usages: any[] = [];
    const text = await anthropicAdapter.call(
      [{ role: "user", content: "hi" }],
      { model: "claude-sonnet-4", temperature: 0.2, onUsage: u => usages.push(u) },
      cred,
    );
    expect(text).toBe("ok");
    expect(calls).toBe(2);
    expect(bodies[0]).toContain("\"temperature\":0.2");
    expect(bodies[1]).not.toContain("\"temperature\":0.2");
    expect(usages).toContainEqual({ inputTokens: 3, outputTokens: 2 });
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("anthropicAdapter.stream: retries once without temperature for deprecated models", async () => {
  const prevFetch = globalThis.fetch;
  const bodies: string[] = [];
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    bodies.push(String(init?.body ?? ""));
    calls++;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "`temperature` is deprecated for this model." },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      sseStream(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n']),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;

  try {
    const cred = { kind: "api_key", provider: "anthropic", token: "k" } as const;
    let text = "";
    for await (const d of anthropicAdapter.stream!([{ role: "user", content: "x" }], { model: "claude-sonnet-4", temperature: 0.2 }, cred)) {
      text += d;
    }
    expect(text).toBe("hi");
    expect(calls).toBe(2);
    expect(bodies[0]).toContain("\"temperature\":0.2");
    expect(bodies[1]).not.toContain("\"temperature\":0.2");
  } finally {
    globalThis.fetch = prevFetch;
  }
});
import { anthropicPayload } from "../src/ai/providers/anthropic";

test("anthropicPayload: low effort enables extended thinking (cross-provider parity)", () => {
  const messages = [{ role: "user" as const, content: "hi" }];
  const cred = { kind: "api_key", provider: "anthropic", token: "k" } as const;
  const at = (effort: CallOptions["reasoningEffort"]) =>
    JSON.parse(anthropicPayload(messages, { model: "claude-3-5-sonnet", maxTokens: 32000, reasoningEffort: effort }, false, true, cred));

  // Parity with Gemini's tiers: minimal/low/medium/high ALL think (gajae parity:
  // reasoning at every level) — only an UNSET effort stays off.
  expect(at("low").thinking).toEqual({ type: "enabled", budget_tokens: 4000 });
  expect(at("medium").thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
  expect(at("high").thinking).toEqual({ type: "enabled", budget_tokens: 24000 });
  expect(at("minimal").thinking).toEqual({ type: "enabled", budget_tokens: 2000 });
  expect(at(undefined).thinking).toBeUndefined();
});