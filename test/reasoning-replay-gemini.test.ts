import { test, expect } from "bun:test";
import { geminiAdapter, buildGeminiPayload, geminiNativizable } from "../src/ai/providers/gemini";
import type { CallOptions, Message, ReasoningArtifact } from "../src/ai/types";

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(e));
      c.close();
    },
  });
}

const MODEL = "gemini-3-pro";
const opts = (): CallOptions => ({ model: MODEL, maxTokens: 20000, reasoningEffort: "medium" });

test("geminiNativizable: needs thinking on + toolUse + same-model thoughtSignature", () => {
  const m: Message = {
    role: "assistant",
    content: "{}",
    toolUse: [{ id: "call_1_0", tool: "read", arguments: {} }],
    reasoningArtifacts: [{ provider: "gemini", model: MODEL, thoughtSignature: "SIG" }],
  };
  expect(geminiNativizable(m, MODEL, true)).toBe(true);
  expect(geminiNativizable(m, MODEL, false)).toBe(false);
  expect(geminiNativizable(m, "other", true)).toBe(false);
  expect(geminiNativizable({ ...m, reasoningArtifacts: [{ provider: "gemini", model: MODEL }] }, MODEL, true)).toBe(false);
});

test("geminiAdapter.stream: captures a part's thoughtSignature as an artifact", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      sseStream([
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read","args":{"filePath":"x"}},"thoughtSignature":"SIG=="}]}}]}\n\n',
        'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}\n\n',
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    )) as typeof fetch;
  try {
    const artifacts: ReasoningArtifact[] = [];
    const o: CallOptions = { ...opts(), onReasoningArtifact: a => artifacts.push(a) };
    const cred = { kind: "api_key", provider: "gemini", token: "k" } as const;
    let out = "";
    for await (const d of geminiAdapter.stream!([{ role: "user", content: "hi" }], o, cred)) out += d;
    expect(out).toContain('"tool":"read"'); // canonical envelope from the functionCall
    expect(artifacts).toEqual([{ provider: "gemini", model: MODEL, thoughtSignature: "SIG==" }]);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("buildGeminiPayload: reconstructs functionCall (+thoughtSignature) and functionResponse", () => {
  const history: Message[] = [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: '{"tool":"read","arguments":{"filePath":"x"}}',
      toolUse: [{ id: "call_1_0", tool: "read", arguments: { filePath: "x" } }],
      reasoningArtifacts: [{ provider: "gemini", model: MODEL, thoughtSignature: "SIG" }],
    },
    { role: "user", content: "Tool [read] result (ok):\nbody", toolResults: [{ id: "call_1_0", output: "body", isError: false }] },
  ];
  const { payload } = buildGeminiPayload(history, opts());
  const contents = payload.contents as any[];
  expect(contents[0]).toEqual({ role: "user", parts: [{ text: "go" }] });
  expect(contents[1]).toEqual({ role: "model", parts: [{ functionCall: { name: "read", args: { filePath: "x" } }, thoughtSignature: "SIG" }] });
  expect(contents[2]).toEqual({ role: "user", parts: [{ functionResponse: { name: "read", response: { output: "body" } } }] });
});

test("buildGeminiPayload: stripArtifacts / cross-model fall back to plain text parts", () => {
  const history: Message[] = [
    {
      role: "assistant",
      content: "envelope",
      toolUse: [{ id: "call_1_0", tool: "read", arguments: {} }],
      reasoningArtifacts: [{ provider: "gemini", model: MODEL, thoughtSignature: "SIG" }],
    },
  ];
  const stripped = buildGeminiPayload(history, opts(), true).payload.contents as any[];
  expect(stripped[0]).toEqual({ role: "model", parts: [{ text: "envelope" }] });
  const cross = buildGeminiPayload(history, { ...opts(), model: "gemini-2.5-flash" }).payload.contents as any[];
  expect(cross[0]).toEqual({ role: "model", parts: [{ text: "envelope" }] });
});

test("buildGeminiPayload: adjacent same-role plain turns still coalesce (no regression)", () => {
  const history: Message[] = [
    { role: "user", content: "a" },
    { role: "user", content: "b" },
  ];
  const contents = buildGeminiPayload(history, opts()).payload.contents as any[];
  expect(contents).toHaveLength(1);
  expect(contents[0]).toEqual({ role: "user", parts: [{ text: "a" }, { text: "b" }] });
});
