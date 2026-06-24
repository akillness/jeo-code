import { test, expect } from "bun:test";
import { anthropicAdapter } from "../src/ai/providers/anthropic";
import { openaiAdapter } from "../src/ai/providers/openai";
import { ollamaAdapter } from "../src/ai/providers/ollama";
import { parseResponsesEvent } from "../src/ai/providers/openai-responses";
import { discoverGoogleProjectId } from "../src/auth/flows/google-project";

// Round-5 #1 (architect ref 6-Round5Providers): a 200-with-no-text must THROW a
// descriptive cause instead of returning "" — an empty reply only bounces in the
// JSON loop (billed) until the step budget burns. gemini/antigravity already
// threw; anthropic/openai/codex/ollama now follow the same contract.
// Round-5 #2: Cloud Code Assist project discovery is deadline-bound.

function sse(events: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(e));
      c.close();
    },
  });
}

const anthropicCred = { kind: "api_key", provider: "anthropic", token: "k" } as const;
const openaiCred = { kind: "api_key", provider: "openai", token: "k" } as const;

test("anthropic.call: empty content + stop_reason=max_tokens throws the real cause", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ content: [], stop_reason: "max_tokens", usage: { input_tokens: 9, output_tokens: 0 } }), {
      status: 200, headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const err = await anthropicAdapter.call([{ role: "user", content: "x" }], { model: "claude-sonnet-4" }, anthropicCred).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("stop_reason=max_tokens");
    expect(err.message).toContain("raise maxTokens");
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("anthropic.stream: no text deltas throws with the captured stop_reason", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      sse([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0}}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":0}}\n\n',
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;
  try {
    const run = async () => {
      for await (const _ of anthropicAdapter.stream!([{ role: "user", content: "x" }], { model: "claude-sonnet-4" }, anthropicCred)) { /* none expected */ }
    };
    const err = await run().catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("stop_reason=max_tokens");
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("openai.call: empty content + finish_reason=length throws the real cause", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { prompt_tokens: 5, completion_tokens: 0 } }), {
      status: 200, headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const err = await openaiAdapter.call([{ role: "user", content: "x" }], { model: "gpt-4.1" }, openaiCred).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("finish_reason=length");
    expect(err.message).toContain("raise maxTokens");
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("openai.stream: no deltas throws with the captured finish_reason", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      sse(['data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n', "data: [DONE]\n\n"]),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;
  try {
    const run = async () => {
      for await (const _ of openaiAdapter.stream!([{ role: "user", content: "x" }], { model: "gpt-4.1" }, openaiCred)) { /* none */ }
    };
    const err = await run().catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("finish_reason=content_filter");
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("non-empty completions still pass through unchanged", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: '{"tool":"done"}' }], stop_reason: "end_turn" }), {
      status: 200, headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const text = await anthropicAdapter.call([{ role: "user", content: "x" }], { model: "claude-sonnet-4" }, anthropicCred);
    expect(text).toBe('{"tool":"done"}');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("ollama.call: empty content + done_reason=length throws the real cause", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: { content: "" }, done_reason: "length", prompt_eval_count: 4, eval_count: 0 }), {
      status: 200, headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const err = await ollamaAdapter.call([{ role: "user", content: "x" }], { model: "llama3" }, { kind: "none", provider: "ollama" } as any).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("done_reason=length");
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("codex parseResponsesEvent surfaces response.incomplete reason", () => {
  const ev = parseResponsesEvent(JSON.stringify({
    type: "response.incomplete",
    response: { usage: { input_tokens: 10, output_tokens: 0 }, incomplete_details: { reason: "max_output_tokens" } },
  }));
  expect(ev.usage).toEqual({ inputTokens: 10, outputTokens: 0 });
  expect(ev.incompleteReason).toBe("max_output_tokens");
  // completed events carry usage but no incompleteReason
  const done = parseResponsesEvent(JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 } } }));
  expect(done.incompleteReason).toBeUndefined();
});

// Round-5 #2: a stalled discovery fetch aborts within the bounded window instead
// of hanging the first gemini-OAuth/antigravity turn forever.
test("discoverGoogleProjectId: a never-settling fetch aborts within the deadline", async () => {
  const hangingFetch = ((_url: any, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason ?? new Error("aborted")));
    })) as unknown as typeof fetch;

  const started = Date.now();
  const err = await discoverGoogleProjectId("token", {
    fetchImpl: hangingFetch,
    env: {},
    requestTimeoutMs: 60,
  }).catch(e => e);
  expect(err).toBeInstanceOf(Error);
  expect(Date.now() - started).toBeLessThan(5_000); // bounded, not forever
});

test("discoverGoogleProjectId: outer turn abort cancels discovery immediately", async () => {
  const hangingFetch = ((_url: any, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason ?? new Error("aborted")));
    })) as unknown as typeof fetch;

  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("turn cancelled")), 20);
  const started = Date.now();
  const err = await discoverGoogleProjectId("token", {
    fetchImpl: hangingFetch,
    env: {},
    signal: controller.signal,
    requestTimeoutMs: 10_000, // the OUTER signal must win, not the timeout
  }).catch(e => e);
  expect(err).toBeInstanceOf(Error);
  expect(Date.now() - started).toBeLessThan(2_000);
});

// Round-5 #5 follow-up: OpenAI-compatible backends that reject the optional
// `stream_options` field get ONE retry without it instead of a dead turn.
test("openai.stream: 400-on-stream_options retries once without the field", async () => {
  const prevFetch = globalThis.fetch;
  const bodies: string[] = [];
  let calls = 0;
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    calls++;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: "Unknown field: stream_options" } }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      sse(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "data: [DONE]\n\n"]),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
  try {
    let text = "";
    for await (const d of openaiAdapter.stream!([{ role: "user", content: "x" }], { model: "local-model", baseUrl: "http://localhost:8080/v1" }, openaiCred)) text += d;
    expect(text).toBe("hi");
    expect(calls).toBe(2);
    expect(bodies[0]).toContain("stream_options");
    expect(bodies[1]).not.toContain("stream_options"); // stripped on the retry
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("openai.stream: unrelated 400s still throw without a retry", async () => {
  const prevFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: "invalid request" } }), { status: 400 });
  }) as typeof fetch;
  try {
    const run = async () => {
      for await (const _ of openaiAdapter.stream!([{ role: "user", content: "x" }], { model: "gpt-4.1" }, openaiCred)) { /* none */ }
    };
    const err = await run().catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(calls).toBe(1); // no blind retry on arbitrary 400s
  } finally {
    globalThis.fetch = prevFetch;
  }
});
// LM Studio / local reasoning-model recovery: when `content` comes back empty but the
// model routed its whole reply (JSON tool call included) into the reasoning channel —
// inline <think> or a structured reasoning_content delta — recover that text instead of
// dying with "OpenAI returned no content". A length/content_filter finish stays a hard error.

test("openai.stream: empty content + JSON inside <think> recovers the tool call", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      sse([
        'data: {"choices":[{"delta":{"content":"<think>"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"{\\"tool\\":\\"done\\",\\"arguments\\":{\\"reason\\":\\"ok\\"}}"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"</think>"},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;
  try {
    let text = "";
    for await (const d of openaiAdapter.stream!([{ role: "user", content: "x" }], { model: "local-model", baseUrl: "http://localhost:1234/v1" }, openaiCred)) text += d;
    expect(text).toContain('"tool":"done"');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("openai.stream: empty content + structured reasoning_content recovers it", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      sse([
        'data: {"choices":[{"delta":{"reasoning_content":"the answer is 42"},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;
  try {
    let text = "";
    for await (const d of openaiAdapter.stream!([{ role: "user", content: "x" }], { model: "local-model", baseUrl: "http://localhost:1234/v1" }, openaiCred)) text += d;
    expect(text).toBe("the answer is 42");
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("openai.stream: empty content + finish_reason=length still throws (reasoning is truncated, not an answer)", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      sse([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking but cut off"},"finish_reason":"length"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;
  try {
    const run = async () => {
      for await (const _ of openaiAdapter.stream!([{ role: "user", content: "x" }], { model: "local-model", baseUrl: "http://localhost:1234/v1" }, openaiCred)) { /* none */ }
    };
    const err = await run().catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("finish_reason=length");
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("openai.stream: finish_reason=length but a COMPLETE tool envelope in reasoning is salvaged", async () => {
  // A local thinking model that finished the actionable JSON before its token budget ran
  // out: the trailing prose is truncated, but the `{"tool":…}` object is complete and valid,
  // so we recover it rather than burning the turn on "no content".
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      sse([
        'data: {"choices":[{"delta":{"reasoning_content":"Let me think. I will run the test. {\\"tool\\":\\"bash\\",\\"arguments\\":{\\"command\\":\\"bun test\\"}} then I sho"},"finish_reason":"length"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;
  try {
    let out = "";
    for await (const d of openaiAdapter.stream!([{ role: "user", content: "x" }], { model: "local-model", baseUrl: "http://localhost:1234/v1" }, openaiCred)) out += d;
    expect(out).toBe('{"tool":"bash","arguments":{"command":"bun test"}}');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("openai.stream: finish_reason=length with only an INCOMPLETE JSON fragment still throws", async () => {
  // The JSON envelope was cut mid-object — nothing safe to salvage, so surface the
  // actionable budget error instead of yielding a broken fragment that just bounces.
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      sse([
        'data: {"choices":[{"delta":{"reasoning_content":"ok here goes {\\"tool\\":\\"bash\\",\\"argum"},"finish_reason":"length"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;
  try {
    const run = async () => {
      for await (const _ of openaiAdapter.stream!([{ role: "user", content: "x" }], { model: "local-model", baseUrl: "http://localhost:1234/v1" }, openaiCred)) { /* none */ }
    };
    const err = await run().catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("finish_reason=length");
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("openai.call: empty content + reasoning_content recovers the reply", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "", reasoning_content: '{"tool":"done","arguments":{"reason":"hi"}}' }, finish_reason: "stop" }] }), {
      status: 200, headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const text = await openaiAdapter.call([{ role: "user", content: "x" }], { model: "local-model", baseUrl: "http://localhost:1234/v1" }, openaiCred);
    expect(text).toContain('"tool":"done"');
  } finally {
    globalThis.fetch = prevFetch;
  }
});
