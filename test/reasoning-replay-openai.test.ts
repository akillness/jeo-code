import { test, expect } from "bun:test";
import {
  parseResponsesEvent,
  buildResponsesInput,
  responsesNativizable,
  codexResponsesCall,
} from "../src/ai/providers/openai-responses";
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

const MODEL = "gpt-5.5";

test("parseResponsesEvent: captures a completed reasoning item (id + encrypted_content)", () => {
  const ev = parseResponsesEvent(JSON.stringify({
    type: "response.output_item.done",
    item: { type: "reasoning", id: "rs_42", encrypted_content: "ENC_BLOB" },
  }));
  expect(ev.reasoningItem).toEqual({ id: "rs_42", encrypted: "ENC_BLOB" });
});

test("responsesNativizable: needs toolUse + same-model reasoning item with id+encrypted", () => {
  const m: Message = {
    role: "assistant",
    content: "{}",
    toolUse: [{ id: "call_1_0", tool: "read", arguments: {} }],
    reasoningArtifacts: [{ provider: "openai", model: MODEL, itemId: "rs_1", encrypted: "E" }],
  };
  expect(responsesNativizable(m, MODEL)).toBe(true);
  expect(responsesNativizable(m, "other")).toBe(false);
  expect(responsesNativizable({ ...m, reasoningArtifacts: [{ provider: "openai", model: MODEL, itemId: "rs_1" }] }, MODEL)).toBe(false); // no encrypted
  expect(responsesNativizable({ ...m, toolUse: [] }, MODEL)).toBe(false);
});

test("buildResponsesInput: reconstructs reasoning + function_call + function_call_output", () => {
  const history: Message[] = [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: '{"tool":"read","arguments":{"filePath":"x"}}',
      toolUse: [{ id: "call_1_0", tool: "read", arguments: { filePath: "x" } }],
      reasoningArtifacts: [{ provider: "openai", model: MODEL, itemId: "rs_1", encrypted: "ENC" }],
    },
    { role: "user", content: "Tool [read] result (ok):\nbody", toolResults: [{ id: "call_1_0", output: "body", isError: false }] },
  ];
  const input = buildResponsesInput(history, MODEL);
  expect(input[0]).toEqual({ role: "user", content: [{ type: "input_text", text: "go" }] });
  expect(input[1]).toEqual({ type: "reasoning", id: "rs_1", encrypted_content: "ENC", summary: [] });
  expect(input[2]).toEqual({ type: "function_call", call_id: "call_1_0", name: "read", arguments: JSON.stringify({ filePath: "x" }) });
  expect(input[3]).toEqual({ type: "function_call_output", call_id: "call_1_0", output: "body" });
});

test("buildResponsesInput: stripArtifacts / cross-model fall back to plain output_text", () => {
  const history: Message[] = [
    {
      role: "assistant",
      content: "envelope",
      toolUse: [{ id: "call_1_0", tool: "read", arguments: {} }],
      reasoningArtifacts: [{ provider: "openai", model: MODEL, itemId: "rs_1", encrypted: "E" }],
    },
  ];
  expect(buildResponsesInput(history, MODEL, true)[0]).toEqual({ role: "assistant", content: [{ type: "output_text", text: "envelope" }] });
  expect(buildResponsesInput(history, "other-model")[0]).toEqual({ role: "assistant", content: [{ type: "output_text", text: "envelope" }] });
});

test("codexResponsesCall: captures a streamed reasoning item as an artifact + requests include", async () => {
  const prevFetch = globalThis.fetch;
  let sentBody: any;
  globalThis.fetch = (async (_url: string, init: any) => {
    sentBody = JSON.parse(init.body);
    return new Response(
      sseStream([
        'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_9","encrypted_content":"ENCDATA"}}\n\n',
        'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  }) as typeof fetch;
  try {
    const artifacts: ReasoningArtifact[] = [];
    const opts: CallOptions = { model: MODEL, maxTokens: 100, reasoningEffort: "medium", onReasoningArtifact: a => artifacts.push(a) };
    const cred = { kind: "api_key", provider: "openai", token: "k" } as const;
    const out = await codexResponsesCall([{ role: "user", content: "hi" }], opts, cred);
    expect(out).toBe("hello");
    expect(artifacts).toEqual([{ provider: "openai", model: MODEL, itemId: "rs_9", encrypted: "ENCDATA" }]);
    // api_key path requests encrypted reasoning content for stateless replay.
    expect(sentBody.include).toEqual(["reasoning.encrypted_content"]);
  } finally {
    globalThis.fetch = prevFetch;
  }
});
