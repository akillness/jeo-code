import { test, expect } from "bun:test";
import { openaiAdapter } from "../src/ai/providers/openai";

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
