import { test, expect } from "bun:test";
import {
  anthropicAdapter,
  anthropicPayload,
  anthropicNativizable,
  buildAnthropicMessages,
} from "../src/ai/providers/anthropic";
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

const MODEL = "claude-3-5-sonnet";

// ── Capture ────────────────────────────────────────────────────────────────
test("anthropicAdapter.stream: captures thinking_delta + signature_delta as a replay artifact", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      sseStream([
        'data: {"type":"message_start","message":{}}\n\n',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"weigh "}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"options"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG=="}}\n\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hi"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    )) as typeof fetch;
  try {
    const artifacts: ReasoningArtifact[] = [];
    const opts: CallOptions = { model: MODEL, maxTokens: 50, onReasoningArtifact: a => artifacts.push(a) };
    const cred = { kind: "api_key", provider: "anthropic", token: "k" } as const;
    let text = "";
    for await (const d of anthropicAdapter.stream!([{ role: "user", content: "hi" }], opts, cred)) text += d;
    expect(text).toBe("hi");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toEqual({ provider: "anthropic", model: MODEL, text: "weigh options", signature: "SIG==" });
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("anthropicAdapter.stream: captures signature-only thinking block (opus-4-8 encrypted thought)", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      sseStream([
        'data: {"type":"message_start","message":{}}\n\n',
        // opus-4-8: thinking block starts, no thinking_delta text, only signature
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"ENCRYPTED_SIG=="}}\n\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    )) as typeof fetch;
  try {
    const artifacts: ReasoningArtifact[] = [];
    const opts: CallOptions = { model: MODEL, maxTokens: 50, onReasoningArtifact: a => artifacts.push(a) };
    const cred = { kind: "api_key", provider: "anthropic", token: "k" } as const;
    let text = "";
    for await (const d of anthropicAdapter.stream!([{ role: "user", content: "hi" }], opts, cred)) text += d;
    expect(text).toBe("ok");
    expect(artifacts).toHaveLength(1);
    // text is undefined (empty string → falsy → undefined), signature is preserved
    expect(artifacts[0]).toEqual({ provider: "anthropic", model: MODEL, text: undefined, signature: "ENCRYPTED_SIG==" });
  } finally {
    globalThis.fetch = prevFetch;
  }
});


test("anthropicAdapter.stream: captures redacted_thinking immediately", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      sseStream([
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"REDACTED_BLOB"}}\n\n',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    )) as typeof fetch;
  try {
    const artifacts: ReasoningArtifact[] = [];
    const opts: CallOptions = { model: MODEL, maxTokens: 50, onReasoningArtifact: a => artifacts.push(a) };
    const cred = { kind: "api_key", provider: "anthropic", token: "k" } as const;
    for await (const _ of anthropicAdapter.stream!([{ role: "user", content: "hi" }], opts, cred)) { /* drain */ }
    expect(artifacts).toEqual([{ provider: "anthropic", model: MODEL, redacted: "REDACTED_BLOB" }]);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

// ── Nativization gate ────────────────────────────────────────────────────────
test("anthropicNativizable: requires thinking enabled + toolUse + matching signed artifact", () => {
  const m: Message = {
    role: "assistant",
    content: "{}",
    toolUse: [{ id: "call_1_0", tool: "read", arguments: {} }],
    reasoningArtifacts: [{ provider: "anthropic", model: MODEL, text: "t", signature: "S" }],
  };
  expect(anthropicNativizable(m, MODEL, true)).toBe(true);
  expect(anthropicNativizable(m, MODEL, false)).toBe(false); // thinking off
  expect(anthropicNativizable(m, "other-model", true)).toBe(false); // model mismatch
  expect(anthropicNativizable({ ...m, toolUse: [] }, MODEL, true)).toBe(false); // no toolUse
  // Signature-only artifacts (opus-4-8 pattern: thinking tokens used but text encrypted)
  // are still nativizable — the empty text + valid signature replays correctly for cross-turn continuity.
  expect(anthropicNativizable({ ...m, reasoningArtifacts: [{ provider: "anthropic", model: MODEL, signature: "S" }] }, MODEL, true)).toBe(true);
});

// ── Replay reconstruction ────────────────────────────────────────────────────
test("buildAnthropicMessages: reconstructs thinking + tool_use, and matching tool_result", () => {
  const history: Message[] = [
    { role: "user", content: "do it" },
    {
      role: "assistant",
      content: '{"tool":"read","arguments":{"filePath":"x"}}',
      toolUse: [{ id: "call_1_0", tool: "read", arguments: { filePath: "x" } }],
      reasoningArtifacts: [{ provider: "anthropic", model: MODEL, text: "think", signature: "SIG" }],
    },
    { role: "user", content: "Tool [read] result (ok):\nfile body", toolResults: [{ id: "call_1_0", output: "file body", isError: false }] },
  ];
  const built = buildAnthropicMessages(history, MODEL, true);
  expect(built[0].content).toBe("do it"); // plain user prompt
  expect(built[1].content).toEqual([
    { type: "thinking", thinking: "think", signature: "SIG" },
    { type: "tool_use", id: "call_1_0", name: "read", input: { filePath: "x" } },
  ]);
  expect(built[2].content).toEqual([
    { type: "tool_result", tool_use_id: "call_1_0", content: "file body", is_error: false },
  ]);
});

test("buildAnthropicMessages: replays signature-only thinking blocks (opus-4-8 encrypted thought)", () => {
  const history: Message[] = [
    { role: "user", content: "do it" },
    {
      role: "assistant",
      content: '{"tool":"read","arguments":{"filePath":"x"}}',
      toolUse: [{ id: "call_1_0", tool: "read", arguments: { filePath: "x" } }],
      // opus-4-8 pattern: signature present, text absent (encrypted thinking)
      reasoningArtifacts: [{ provider: "anthropic", model: MODEL, signature: "ENCRYPTED_SIG" }],
    },
    { role: "user", content: "Tool [read] result (ok):\nfile body", toolResults: [{ id: "call_1_0", output: "file body", isError: false }] },
  ];
  const built = buildAnthropicMessages(history, MODEL, true);
  // Signature-only thinking block should be replayed with empty text + signature for continuity
  expect(built[1].content).toEqual([
    { type: "thinking", thinking: "", signature: "ENCRYPTED_SIG" },
    { type: "tool_use", id: "call_1_0", name: "read", input: { filePath: "x" } },
  ]);
  // Tool result is also nativized since preceding assistant was nativizable
  expect(built[2].content).toEqual([
    { type: "tool_result", tool_use_id: "call_1_0", content: "file body", is_error: false },
  ]);
});

test("buildAnthropicMessages: cross-model + thinking-off fall back to plain string (no native blocks)", () => {
  const history: Message[] = [
    {
      role: "assistant",
      content: "envelope",
      toolUse: [{ id: "call_1_0", tool: "read", arguments: {} }],
      reasoningArtifacts: [{ provider: "anthropic", model: MODEL, text: "think", signature: "SIG" }],
    },
    { role: "user", content: "Tool [read] result (ok):\nbody", toolResults: [{ id: "call_1_0", output: "body", isError: false }] },
  ];
  // model mismatch → plain
  const other = buildAnthropicMessages(history, "different-model", true);
  expect(other[0].content).toBe("envelope");
  expect(other[1].content).toBe("Tool [read] result (ok):\nbody");
  // thinking disabled → plain
  const noThink = buildAnthropicMessages(history, MODEL, false);
  expect(noThink[0].content).toBe("envelope");
  expect(noThink[1].content).toBe("Tool [read] result (ok):\nbody");
});

test("anthropicPayload: stripArtifacts forces plain string replay (fail-safe shape)", () => {
  const history: Message[] = [
    {
      role: "assistant",
      content: "envelope",
      toolUse: [{ id: "call_1_0", tool: "read", arguments: {} }],
      reasoningArtifacts: [{ provider: "anthropic", model: MODEL, text: "think", signature: "SIG" }],
    },
    { role: "user", content: "result body", toolResults: [{ id: "call_1_0", output: "result body", isError: false }] },
  ];
  const opts: CallOptions = { model: MODEL, maxTokens: 20000, reasoningEffort: "medium" };
  const withArtifacts = JSON.parse(anthropicPayload(history, opts, false, false));
  // thinking enabled + match → first assistant message uses native blocks
  expect(Array.isArray(withArtifacts.messages[0].content)).toBe(true);
  expect(withArtifacts.messages[0].content[0].type).toBe("thinking");

  const stripped = JSON.parse(anthropicPayload(history, opts, false, false, undefined, true));
  // stripArtifacts → assistant content is the plain string envelope again
  expect(stripped.messages[0].content).toBe("envelope");
});
