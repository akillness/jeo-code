import { test, expect } from "bun:test";
import { openaiAdapter } from "../src/ai/providers/openai";
import { anthropicAdapter } from "../src/ai/providers/anthropic";
import { geminiAdapter } from "../src/ai/providers/gemini";
import { parseResponsesEvent } from "../src/ai/providers/openai-responses";
import { codexResponsesCall, codexResponsesStream } from "../src/ai/providers/openai-responses";
import { ollamaAdapter } from "../src/ai/providers/ollama";
import { ProviderStreamError } from "../src/ai/providers/errors";
import { antigravityAdapter } from "../src/ai/providers/antigravity";

const messages = [{ role: "user", content: "x" }] as const;
const openaiCred = { kind: "api_key", provider: "openai", token: "k" } as const;
const anthropicCred = { kind: "api_key", provider: "anthropic", token: "k" } as const;

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } });
}

test("openai call rejects abnormal finish even when it contains partial text", async () => {
  const previous = globalThis.fetch;
  try {
    for (const reason of ["length", "content_filter"]) {
      globalThis.fetch = (async () => Response.json({ choices: [{ message: { content: "partial" }, finish_reason: reason }] })) as typeof fetch;
      await expect(openaiAdapter.call([...messages], { model: "gpt-4.1" }, openaiCred)).rejects.toThrow(reason);
    }
    globalThis.fetch = (async () => Response.json({ choices: [{ message: { content: "complete" }, finish_reason: "stop" }] })) as typeof fetch;
    expect(await openaiAdapter.call([...messages], { model: "gpt-4.1" }, openaiCred)).toBe("complete");
  } finally { globalThis.fetch = previous; }
});

test("anthropic call rejects abnormal stop even when it contains partial text", async () => {
  const previous = globalThis.fetch;
  try {
    for (const reason of ["max_tokens", "refusal"]) {
      globalThis.fetch = (async () => Response.json({ content: [{ type: "text", text: "partial" }], stop_reason: reason })) as typeof fetch;
      await expect(anthropicAdapter.call([...messages], { model: "claude-sonnet-4" }, anthropicCred)).rejects.toThrow(reason);
    }
    globalThis.fetch = (async () => Response.json({ content: [{ type: "text", text: "complete" }], stop_reason: "end_turn" })) as typeof fetch;
    expect(await anthropicAdapter.call([...messages], { model: "claude-sonnet-4" }, anthropicCred)).toBe("complete");
  } finally { globalThis.fetch = previous; }
});

test("openai stream parses split SSE events and rejects abnormal termination after text", async () => {
  const previous = globalThis.fetch;
  try {
    for (const reason of ["stop", "length", "content_filter"]) {
      const event = `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" }, finish_reason: reason }] })}\n\n`;
      globalThis.fetch = (async () => new Response(stream([event.slice(0, 13), event.slice(13), "data: [DONE]\n\n"]))) as typeof fetch;
      let text = "";
      const run = async () => { for await (const part of openaiAdapter.stream!([...messages], { model: "gpt-4.1" }, openaiCred)) text += part; };
      if (reason === "stop") { await run(); expect(text).toBe("hello"); }
      else await expect(run()).rejects.toThrow(reason);
    }
  } finally { globalThis.fetch = previous; }
});

test("anthropic stream parses split events and rejects abnormal termination after text", async () => {
  const previous = globalThis.fetch;
  try {
    for (const reason of ["end_turn", "max_tokens", "refusal"]) {
      const data = `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hello" } })}\n\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: reason } })}\n\n`;
      globalThis.fetch = (async () => new Response(stream([data.slice(0, 11), data.slice(11)]))) as typeof fetch;
      let text = "";
      const run = async () => { for await (const part of anthropicAdapter.stream!([...messages], { model: "claude-sonnet-4" }, anthropicCred)) text += part; };
      if (reason === "end_turn") { await run(); expect(text).toBe("hello"); }
      else await expect(run()).rejects.toThrow(reason);
    }
  } finally { globalThis.fetch = previous; }
});

test("gemini stream rejects unsafe and truncated finishes after partial text", async () => {
  const previous = globalThis.fetch;
  const cred = { kind: "api_key", provider: "gemini", token: "k" } as const;
  try {
    for (const reason of ["STOP", "MAX_TOKENS", "SAFETY"]) {
      const data = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "hello" }] }, finishReason: reason }] })}\n\n`;
      globalThis.fetch = (async () => new Response(stream([data.slice(0, 7), data.slice(7)]))) as typeof fetch;
      let text = "";
      const run = async () => { for await (const part of geminiAdapter.stream!([...messages], { model: "gemini-2.5-flash" }, cred)) text += part; };
      if (reason === "STOP") { await run(); expect(text).toBe("hello"); }
      else await expect(run()).rejects.toThrow(reason);
    }
  } finally { globalThis.fetch = previous; }
});

test("Responses incomplete reason is retained even without usage", () => {
  const event = parseResponsesEvent(JSON.stringify({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }));
  expect(event.incompleteReason).toBe("max_output_tokens");
});

test("ollama call and chunked stream distinguish stop from truncated output", async () => {
  const previous = globalThis.fetch;
  try {
    for (const reason of ["stop", "length"]) {
      globalThis.fetch = (async () => Response.json({ message: { content: "hello" }, done: true, done_reason: reason })) as typeof fetch;
      const call = () => ollamaAdapter.call([...messages], { model: "ollama/test" });
      if (reason === "stop") expect(await call()).toBe("hello");
      else await expect(call()).rejects.toThrow(reason);

      const data = `${JSON.stringify({ message: { content: "hello" }, done: false })}\n${JSON.stringify({ done: true, done_reason: reason })}\n`;
      globalThis.fetch = (async () => new Response(stream([data.slice(0, 9), data.slice(9)]))) as typeof fetch;
      let text = "";
      const run = async () => { for await (const part of ollamaAdapter.stream!([...messages], { model: "ollama/test" })) text += part; };
      if (reason === "stop") { await run(); expect(text).toBe("hello"); }
      else await expect(run()).rejects.toThrow(reason);
    }
  } finally { globalThis.fetch = previous; }
});

test("openai clean EOF without finish reason rejects partial text and native tool fragments", async () => {
  const previous = globalThis.fetch;
  try {
    for (const delta of [
      { content: "partial" },
      { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"filePath":"x"}' } }] },
    ]) {
      const data = `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`;
      globalThis.fetch = (async () => new Response(stream([data.slice(0, 8), data.slice(8)]))) as typeof fetch;
      let text = "";
      const run = async () => { for await (const part of openaiAdapter.stream!([...messages], { model: "gpt-4.1" }, openaiCred)) text += part; };
      await expect(run()).rejects.toThrow();
      if ("tool_calls" in delta) expect(text).not.toContain('"tool"');
    }
  } finally { globalThis.fetch = previous; }
});

test("anthropic clean EOF without stop reason rejects partial text and native tool fragments", async () => {
  const previous = globalThis.fetch;
  try {
    for (const event of [
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name: "read", input: { filePath: "x" } } },
    ]) {
      const data = `data: ${JSON.stringify(event)}\n\n`;
      globalThis.fetch = (async () => new Response(stream([data.slice(0, 8), data.slice(8)]))) as typeof fetch;
      let text = "";
      const run = async () => { for await (const part of anthropicAdapter.stream!([...messages], { model: "claude-sonnet-4" }, anthropicCred)) text += part; };
      await expect(run()).rejects.toThrow();
      if (event.type === "content_block_start") expect(text).not.toContain('"tool"');
    }
  } finally { globalThis.fetch = previous; }
});

test("anthropic in-band overloaded error is propagated", async () => {
  const previous = globalThis.fetch;
  try {
    const event = { type: "error", error: { type: "overloaded_error", message: "overloaded" } };
    globalThis.fetch = (async () => new Response(stream([`data: ${JSON.stringify(event)}\n\n`]))) as typeof fetch;
    const run = async () => { for await (const _ of anthropicAdapter.stream!([...messages], { model: "claude-sonnet-4" }, anthropicCred)) {} };
    await expect(run()).rejects.toBeInstanceOf(ProviderStreamError);
  } finally { globalThis.fetch = previous; }
});

test("OpenAI reasoning Responses in-band error does not fall back to chat", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls++;
      const event = { type: "response.failed", response: { error: { code: "server_error", message: "server error" } } };
      return new Response(stream([`data: ${JSON.stringify(event)}\n\n`]));
    }) as typeof fetch;
    const run = async () => { for await (const _ of openaiAdapter.stream!([...messages], { model: "gpt-5" }, openaiCred)) {} };
    await expect(run()).rejects.toBeInstanceOf(ProviderStreamError);
    expect(calls).toBe(1);
  } finally { globalThis.fetch = previous; }
});

test("Gemini API and Cloud Code streams require STOP after partial content", async () => {
  const previous = globalThis.fetch;
  try {
    for (const cred of [{ kind: "api_key", provider: "gemini", token: "k" }, { kind: "oauth", provider: "gemini", token: "k", projectId: "p" }] as const) {
      for (const complete of [false, true]) {
        const candidate = { content: { parts: [{ text: "hello" }] }, ...(complete ? { finishReason: "STOP" } : {}) };
        const payload = cred.kind === "oauth" ? { response: { candidates: [candidate] } } : { candidates: [candidate] };
        globalThis.fetch = (async () => new Response(stream([`data: ${JSON.stringify(payload)}\n\n`]))) as typeof fetch;
        let text = "";
        const run = async () => { for await (const part of geminiAdapter.stream!([...messages], { model: "gemini-2.5-flash" }, cred)) text += part; };
        if (complete) { await run(); expect(text).toBe("hello"); }
        else await expect(run()).rejects.toThrow();
      }
    }
  } finally { globalThis.fetch = previous; }
});

test("Antigravity call and stream require STOP after partial content", async () => {
  const previous = globalThis.fetch;
  const cred = { kind: "oauth", provider: "gemini", token: "k", projectId: "p" } as const;
  try {
    for (const complete of [false, true]) {
      const payload = { response: { candidates: [{ content: { parts: [{ text: "hello" }] }, ...(complete ? { finishReason: "STOP" } : {}) }] } };
      globalThis.fetch = (async () => new Response(stream([`data: ${JSON.stringify(payload)}\n\n`]))) as typeof fetch;
      const call = () => antigravityAdapter.call([...messages], { model: "antigravity/gemini-3-flash" }, cred);
      if (complete) expect(await call()).toBe("hello");
      else await expect(call()).rejects.toThrow();
      let text = "";
      const run = async () => { for await (const part of antigravityAdapter.stream!([...messages], { model: "antigravity/gemini-3-flash" }, cred)) text += part; };
      if (complete) { await run(); expect(text).toBe("hello"); }
      else await expect(run()).rejects.toThrow();
    }
  } finally { globalThis.fetch = previous; }
});

test("Ollama stream requires done after partial content", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(stream([`${JSON.stringify({ message: { content: "hello" }, done: false })}\n`]))) as typeof fetch;
    const run = async () => { for await (const _ of ollamaAdapter.stream!([...messages], { model: "ollama/test" })) {} };
    await expect(run()).rejects.toThrow();
  } finally { globalThis.fetch = previous; }
});

test("Responses call and stream require completed event before accepting text or native tool calls", async () => {
  const previous = globalThis.fetch;
  try {
    for (const event of [
      { type: "response.output_text.delta", delta: "hello" },
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", name: "read" } },
    ]) {
      for (const complete of [false, true]) {
        const data = `data: ${JSON.stringify(event)}\n\n${complete ? 'data: {"type":"response.completed"}\n\n' : ""}`;
        globalThis.fetch = (async () => new Response(stream([data]))) as typeof fetch;
        const runCall = () => codexResponsesCall([...messages], { model: "gpt-5" }, openaiCred);
        if (complete) expect(await runCall()).not.toBe("");
        else await expect(runCall()).rejects.toThrow();
        let text = "";
        const runStream = async () => { for await (const part of codexResponsesStream([...messages], { model: "gpt-5" }, openaiCred)) text += part; };
        if (complete) { await runStream(); expect(text).not.toBe(""); }
        else { await expect(runStream()).rejects.toThrow(); if (event.type === "response.output_item.added") expect(text).not.toContain('"tool"'); }
      }
    }
  } finally { globalThis.fetch = previous; }
});
