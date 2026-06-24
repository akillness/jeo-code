import { test, expect } from "bun:test";
import { openaiAdapter, reasoningDeltaOf, openaiRequest } from "../src/ai/providers/openai";

const cred = { kind: "api_key", provider: "openai", token: "k" } as const;

function sseResponse(chunks: object[]): Response {
  const body = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function drain(model: string, chunks: object[]): Promise<{ text: string; reasoning: string }> {
  const prev = globalThis.fetch;
  globalThis.fetch = (async () => sseResponse(chunks)) as typeof fetch;
  try {
    let text = "";
    let reasoning = "";
    for await (const d of openaiAdapter.stream!(
      [{ role: "user", content: "x" }],
      { model, onReasoning: r => { reasoning += r; } },
      cred,
    )) text += d;
    return { text, reasoning };
  } finally {
    globalThis.fetch = prev;
  }
}

// gjc parity: OpenAI-compatible reasoning models (xAI Grok, DeepSeek, llama.cpp, …)
// stream reasoning as a SEPARATE delta field, not in `content`. jeo must route it to
// the reasoning channel and keep `content` as the visible answer.

test("openai stream: reasoning_content delta routes to onReasoning, content stays visible", async () => {
  const { text, reasoning } = await drain("grok-4.3", [
    { choices: [{ delta: { reasoning_content: "step 1 " } }] },
    { choices: [{ delta: { reasoning_content: "step 2" } }] },
    { choices: [{ delta: { content: "the answer" } }] },
  ]);
  expect(text).toBe("the answer");
  expect(reasoning).toBe("step 1 step 2");
});

test("openai stream: `reasoning` and `reasoning_text` fields are also honored", async () => {
  const a = await drain("grok-4-fast-reasoning", [{ choices: [{ delta: { reasoning: "via reasoning" } }] }, { choices: [{ delta: { content: "A" } }] }]);
  expect(a.reasoning).toBe("via reasoning");
  const b = await drain("some-local", [{ choices: [{ delta: { reasoning_text: "via reasoning_text" } }] }, { choices: [{ delta: { content: "B" } }] }]);
  expect(b.reasoning).toBe("via reasoning_text");
});

test("openai stream: inline <think> in content is still split out (local models)", async () => {
  const { text, reasoning } = await drain("deepseek-r1", [
    { choices: [{ delta: { content: "<think>pondering</think>" } }] },
    { choices: [{ delta: { content: "final" } }] },
  ]);
  expect(text).toBe("final");
  expect(reasoning).toBe("pondering");
});

test("openai stream: object `reasoning` and `reasoning_details[]` shapes are honored", async () => {
  // Some OpenRouter models emit `reasoning` as an object, others only `reasoning_details[]`.
  const a = await drain("openrouter/x", [
    { choices: [{ delta: { reasoning: { text: "obj reasoning" } } }] },
    { choices: [{ delta: { content: "A" } }] },
  ]);
  expect(a.text).toBe("A");
  expect(a.reasoning).toBe("obj reasoning");

  const b = await drain("openrouter/y", [
    { choices: [{ delta: { reasoning_details: [{ text: "d1 " }, { text: "d2" }] } }] },
    { choices: [{ delta: { content: "B" } }] },
  ]);
  expect(b.reasoning).toBe("d1 d2");
});

test("reasoningDeltaOf: precedence + shape coverage", () => {
  expect(reasoningDeltaOf({ reasoning_content: "rc" })).toBe("rc");
  expect(reasoningDeltaOf({ reasoning_text: "rt" })).toBe("rt");
  expect(reasoningDeltaOf({ reasoning: "str" })).toBe("str");
  expect(reasoningDeltaOf({ reasoning: { content: "oc" } })).toBe("oc");
  expect(reasoningDeltaOf({ reasoning_details: [{ content: "a" }, { text: "b" }] })).toBe("ab");
  expect(reasoningDeltaOf({ content: "only visible" })).toBeUndefined();
  expect(reasoningDeltaOf(undefined)).toBeUndefined();
  // never forward a non-string reasoning object that has no text/content
  expect(reasoningDeltaOf({ reasoning: { foo: 1 } as unknown as Record<string, unknown> })).toBeUndefined();
});

// #1: OpenAI reasoning models (o-series/gpt-5) expose reasoning only via the Responses
// API. With a real-OpenAI api key (no baseUrl) jeo must route them to /v1/responses and
// surface reasoning_summary deltas; on /responses failure it falls back to chat.

function sse(lines: object[]): Response {
  const body = lines.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function drainRouted(model: string, opts: { baseUrl?: string; responsesStatus?: number }): Promise<{ text: string; reasoning: string; hitResponses: boolean; hitChat: boolean }> {
  const prev = globalThis.fetch;
  let hitResponses = false, hitChat = false;
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    if (u.includes("/responses")) {
      hitResponses = true;
      if (opts.responsesStatus && opts.responsesStatus >= 400) return new Response("nope", { status: opts.responsesStatus });
      return sse([
        { type: "response.reasoning_summary_text.delta", delta: "summarized thinking" },
        { type: "response.output_text.delta", delta: "the answer" },
        { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 5 } } },
      ]);
    }
    hitChat = true;
    return sse([{ choices: [{ delta: { content: "chat answer" } }] }]);
  }) as unknown as typeof fetch;
  try {
    let text = "", reasoning = "";
    for await (const d of openaiAdapter.stream!([{ role: "user", content: "x" }], { model, baseUrl: opts.baseUrl, reasoningEffort: "medium", onReasoning: r => { reasoning += r; } } as never, cred)) text += d;
    return { text, reasoning, hitResponses, hitChat };
  } finally {
    globalThis.fetch = prev;
  }
}

test("openai api-key reasoning model (o3) routes to /responses and surfaces reasoning", async () => {
  const r = await drainRouted("o3", {});
  expect(r.hitResponses).toBe(true);
  expect(r.hitChat).toBe(false);
  expect(r.text).toBe("the answer");
  expect(r.reasoning).toBe("summarized thinking");
});

test("openai /responses failure falls back to chat completions (no regression)", async () => {
  const r = await drainRouted("o3", { responsesStatus: 400 });
  expect(r.hitResponses).toBe(true);
  expect(r.hitChat).toBe(true);
  expect(r.text).toBe("chat answer");
});

test("non-reasoning model and custom baseUrl stay on chat completions", async () => {
  const a = await drainRouted("gpt-4o", {});
  expect(a.hitResponses).toBe(false);
  expect(a.hitChat).toBe(true);
  // o3 via an OpenAI-compatible server (baseUrl set) must NOT use /responses
  const b = await drainRouted("o3", { baseUrl: "http://localhost:1234/v1" });
  expect(b.hitResponses).toBe(false);
  expect(b.hitChat).toBe(true);
});

// gjc parity: native reasoning must be ENABLED per the backend's thinkingFormat, or the
// model never emits reasoning to surface. openaiRequest writes the right request param.
function bodyOf(model: string, reasoningFormat?: "openai" | "openrouter" | "qwen" | "zai"): Record<string, unknown> {
  const req = openaiRequest([{ role: "user", content: "x" }], { model, reasoningEffort: "medium", reasoningFormat } as never, cred, true);
  return JSON.parse(req.body);
}

test("thinkingFormat: openrouter sends `reasoning:{effort}`, qwen sends enable_thinking, zai sends thinking", () => {
  expect(bodyOf("anthropic/claude", "openrouter").reasoning).toEqual({ effort: "medium" });
  expect(bodyOf("qwen3-coder", "qwen").enable_thinking).toBe(true);
  expect(bodyOf("glm-4.6", "zai").thinking).toEqual({ type: "enabled" });
  // default (no format) on a non-reasoning model adds no thinking param
  const plain = bodyOf("llama-3.3-70b");
  expect(plain.reasoning).toBeUndefined();
  expect(plain.enable_thinking).toBeUndefined();
  // real OpenAI reasoning model keeps reasoning_effort (not the compat params)
  const o3 = bodyOf("o3", "openai");
  expect(o3.reasoning_effort).toBe("medium");
  expect(o3.reasoning).toBeUndefined();
});

test("thinkingFormat: thinking OFF (no effort) sends no enablement param", () => {
  const req = openaiRequest([{ role: "user", content: "x" }], { model: "x", reasoningFormat: "openrouter" } as never, cred, true);
  const body = JSON.parse(req.body);
  expect(body.reasoning).toBeUndefined();
});

// Local thinking models burn thousands of tokens inside <think> before answering, so the
// cloud 4000 default truncates them at finish_reason=length with EMPTY content. A custom
// baseUrl (LM Studio, llama.cpp, …) costs nothing per token, so give it real headroom.
test("maxTokens default: a custom baseUrl gets a larger budget than cloud OpenAI", () => {
  const cloud = JSON.parse(openaiRequest([{ role: "user", content: "x" }], { model: "gpt-4o" } as never, cred, false).body);
  expect(cloud.max_tokens).toBe(4000);

  const local = JSON.parse(openaiRequest([{ role: "user", content: "x" }], { model: "qwen3", baseUrl: "http://localhost:1234/v1" } as never, cred, false).body);
  expect(local.max_tokens).toBe(16000);

  // an explicit caller value always wins over either default
  const explicit = JSON.parse(openaiRequest([{ role: "user", content: "x" }], { model: "qwen3", baseUrl: "http://localhost:1234/v1", maxTokens: 512 } as never, cred, false).body);
  expect(explicit.max_tokens).toBe(512);
});
