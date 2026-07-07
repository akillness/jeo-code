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

test("anthropicAdapter.stream: signature-only thinking block fires onReasoningStart (opus-4-8) even with no thinking text", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      sseStream([
        // opus-4-8 opens a thinking block and streams ONLY a signature — no thinking_delta text.
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig123"}}\n\n',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    )) as typeof fetch;
  try {
    let starts = 0;
    let reasoningText = "";
    const arts: any[] = [];
    const opts: CallOptions = {
      model: "claude-opus-4-8",
      reasoningEffort: "high",
      onReasoningStart: () => { starts++; },
      onReasoning: d => { reasoningText += d; },
      onReasoningArtifact: a => { arts.push(a); },
    };
    const cred = { kind: "api_key", provider: "anthropic", token: "k" } as const;
    let text = "";
    for await (const d of anthropicAdapter.stream!([{ role: "user", content: "x" }], opts, cred)) text += d;
    expect(text).toBe("answer");
    expect(starts).toBe(1);           // thinking phase signalled despite no thought text
    expect(reasoningText).toBe("");   // signature-only model streams no visible thought
    // The signed thought is still captured for cross-turn replay.
    expect(arts).toEqual([{ provider: "anthropic", model: "claude-opus-4-8", text: undefined, signature: "sig123" }]);
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
import { anthropicPayload, anthropicRequest } from "../src/ai/providers/anthropic";

test("anthropicPayload: low effort enables extended thinking (cross-provider parity)", () => {
  const messages = [{ role: "user" as const, content: "hi" }];
  const cred = { kind: "api_key", provider: "anthropic", token: "k" } as const;
  const at = (effort: CallOptions["reasoningEffort"]) =>
    JSON.parse(anthropicPayload(messages, { model: "claude-3-5-sonnet", maxTokens: 32000, reasoningEffort: effort }, false, true, cred));

  // gjc ANTHROPIC_THINKING tiers: low/medium/high ALL think (gajae parity:
  // reasoning at every level) — only an UNSET effort stays off.
  expect(at("low").thinking).toEqual({ type: "enabled", budget_tokens: 4096, display: "summarized" });
  expect(at("medium").thinking).toEqual({ type: "enabled", budget_tokens: 8192, display: "summarized" });
  expect(at("high").thinking).toEqual({ type: "enabled", budget_tokens: 16384, display: "summarized" });
  expect(at(undefined).thinking).toBeUndefined();
});

test("anthropicPayload: opus 4.7/4.8 use ADAPTIVE thinking with display:summarized + output_config (the empty-thought fix)", () => {
  const messages = [{ role: "user" as const, content: "hi" }];
  const cred = { kind: "api_key", provider: "anthropic", token: "k" } as const;
  const payload = (model: string, effort: CallOptions["reasoningEffort"]) =>
    JSON.parse(anthropicPayload(messages, { model, maxTokens: 32000, reasoningEffort: effort }, false, true, cred));

  // Opus 4.8: adaptive transport, display REQUIRED (else thinking content is omitted), no budget_tokens.
  const opus48 = payload("claude-opus-4-8", "high");
  expect(opus48.thinking).toEqual({ type: "adaptive", display: "summarized" });
  expect(opus48.output_config).toEqual({ effort: "high" });
  expect(opus48.thinking.budget_tokens).toBeUndefined();
  // max_tokens stays the plain budget (no thinkingBudget+1024 bump on the adaptive path).
  expect(opus48.max_tokens).toBe(32000);

  // Opus 4.7 medium → effort medium.
  expect(payload("claude-opus-4-7", "medium").thinking).toEqual({ type: "adaptive", display: "summarized" });
  expect(payload("claude-opus-4-7", "medium").output_config).toEqual({ effort: "medium" });

  // Opus 4.6 / Sonnet 4.6: adaptive transport but display is REJECTED → omitted.
  expect(payload("claude-opus-4-6", "high").thinking).toEqual({ type: "adaptive" });
  expect(payload("claude-opus-4-6", "high").output_config).toEqual({ effort: "high" });
  expect(payload("claude-sonnet-4-6", "low").thinking).toEqual({ type: "adaptive" });
  expect(payload("claude-sonnet-4-6", "low").output_config).toEqual({ effort: "low" });

  // Sonnet 4.5: budget-effort transport (budget_tokens + output_config effort + display).
  const sonnet45 = payload("claude-sonnet-4-5", "medium");
  expect(sonnet45.thinking).toEqual({ type: "enabled", budget_tokens: 8192, display: "summarized" });
  expect(sonnet45.output_config).toEqual({ effort: "medium" });

  // Haiku 4.5: plain budget transport. Unlike its sonnet/opus 4.5 siblings it REJECTS
  // output_config.effort ("This model does not support the effort parameter"), so thinking
  // rides budget_tokens alone with NO output_config.
  const haiku45 = payload("claude-haiku-4-5", "medium");
  expect(haiku45.thinking).toEqual({ type: "enabled", budget_tokens: 8192, display: "summarized" });
  expect(haiku45.output_config).toBeUndefined();
});
test("anthropicRequest: interleaved-thinking beta is dropped for adaptive-display models (opus 4.7+)", () => {
  const messages = [{ role: "user" as const, content: "hi" }];
  const cred = { kind: "api_key", provider: "anthropic", token: "k" } as const;
  const beta = (model: string) =>
    anthropicRequest(messages, { model, maxTokens: 32000, reasoningEffort: "high" }, cred, false, true)
      .headers["anthropic-beta"] ?? "";

  // Opus 4.7/4.8 use adaptive thinking — the legacy interleaved-thinking beta is omitted.
  expect(beta("claude-opus-4-8")).not.toContain("interleaved-thinking");
  expect(beta("claude-opus-4-7")).not.toContain("interleaved-thinking");
  // Older models keep it (budget / pre-4.7 adaptive thinking still relies on the beta).
  expect(beta("claude-opus-4-6")).toContain("interleaved-thinking");
  expect(beta("claude-sonnet-4-5")).toContain("interleaved-thinking");
});
test("anthropicRequest: api-key beta list carries context-management (gjc default-beta parity)", () => {
  const messages = [{ role: "user" as const, content: "hi" }];
  const cred = { kind: "api_key", provider: "anthropic", token: "k" } as const;
  const beta = anthropicRequest(messages, { model: "claude-sonnet-4-5", maxTokens: 32000 }, cred, false, true)
    .headers["anthropic-beta"] ?? "";
  expect(beta).toContain("context-management-2025-06-27");
  expect(beta).toContain("prompt-caching-scope-2026-01-05");
  // ponytail upgrade path (JSON repair pass) not implemented — the beta must stay off.
  expect(beta).not.toContain("fine-grained-tool-streaming");
});
test("anthropicPayload: 5th-gen ids (Sonnet 5, Fable 5, Mythos 5) use adaptive thinking WITH display:summarized", () => {
  const messages = [{ role: "user" as const, content: "hi" }];
  const cred = { kind: "api_key", provider: "anthropic", token: "k" } as const;
  const payload = (model: string, effort: CallOptions["reasoningEffort"]) =>
    JSON.parse(anthropicPayload(messages, { model, maxTokens: 32000, reasoningEffort: effort }, false, true, cred));

  // Single-digit `-5` ids parse to major 5 → adaptive transport (NOT the legacy budget
  // transport a 5th-gen adaptive model rejects), and display is carried forward from Opus 4.7.
  for (const model of ["claude-sonnet-5", "claude-fable-5", "claude-mythos-5"]) {
    const p = payload(model, "high");
    expect(p.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(p.output_config).toEqual({ effort: "high" });
    expect(p.thinking.budget_tokens).toBeUndefined();
    expect(p.max_tokens).toBe(32000);
  }
});

test("anthropicRequest: 5th-gen adaptive-display ids drop the interleaved-thinking beta", () => {
  const messages = [{ role: "user" as const, content: "hi" }];
  const cred = { kind: "api_key", provider: "anthropic", token: "k" } as const;
  const beta = (model: string) =>
    anthropicRequest(messages, { model, maxTokens: 32000, reasoningEffort: "high" }, cred, false, true)
      .headers["anthropic-beta"] ?? "";
  expect(beta("claude-sonnet-5")).not.toContain("interleaved-thinking");
  expect(beta("claude-fable-5")).not.toContain("interleaved-thinking");
  expect(beta("claude-mythos-5")).not.toContain("interleaved-thinking");
});

test("anthropicPayload: non-stream requests clamp max_tokens to 32k; stream carries the full budget", () => {
  const messages = [{ role: "user" as const, content: "hi" }];
  const cred = { kind: "api_key", provider: "anthropic", token: "k" } as const;
  const p = (stream: boolean, maxTokens: number) =>
    JSON.parse(anthropicPayload(messages, { model: "claude-fable-5", maxTokens, reasoningEffort: "high" }, stream, true, cred));

  // 64k catalog-derived budget: stream passes through; non-stream clamps to the
  // proven 32k ceiling (Anthropic's ~10-minute non-streaming HTTP window).
  expect(p(true, 64000).max_tokens).toBe(64000);
  expect(p(false, 64000).max_tokens).toBe(32000);
  // Budgets at/below the ceiling are untouched on both paths.
  expect(p(false, 24000).max_tokens).toBe(24000);
  expect(p(true, 24000).max_tokens).toBe(24000);
});

test("anthropicAdapter.call: empty completion with stop_details.category folds it into the error message", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ content: [], stop_reason: "refusal", stop_details: { category: "reasoning_extraction" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    const opts: CallOptions = { model: "claude-fable-5", maxTokens: 50 };
    const cred = { kind: "api_key", provider: "anthropic", token: "k" } as const;
    let caught: Error | undefined;
    try {
      await anthropicAdapter.call!([{ role: "user", content: "hi" }], opts, cred);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toBe("Anthropic returned no content (stop_reason=refusal, category=reasoning_extraction).");
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("anthropicAdapter.call: empty completion with NO stop_details keeps the existing plain shape", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ content: [], stop_reason: "refusal" }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    const opts: CallOptions = { model: "claude-fable-5", maxTokens: 50 };
    const cred = { kind: "api_key", provider: "anthropic", token: "k" } as const;
    let caught: Error | undefined;
    try {
      await anthropicAdapter.call!([{ role: "user", content: "hi" }], opts, cred);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toBe("Anthropic returned no content (stop_reason=refusal).");
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("anthropicAdapter.stream: empty completion with stop_details.category (message_delta) folds it into the error message", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      sseStream([
        'data: {"type":"message_start","message":{"stop_reason":null}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"category":"reasoning_extraction"}}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;
  try {
    const opts: CallOptions = { model: "claude-fable-5", maxTokens: 50 };
    const cred = { kind: "api_key", provider: "anthropic", token: "k" } as const;
    let caught: Error | undefined;
    try {
      for await (const _ of anthropicAdapter.stream!([{ role: "user", content: "hi" }], opts, cred)) {
        // drain
      }
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toBe("Anthropic returned no content (stop_reason=refusal, category=reasoning_extraction).");
  } finally {
    globalThis.fetch = prevFetch;
  }
});