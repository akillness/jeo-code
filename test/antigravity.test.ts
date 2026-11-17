import { test, expect } from "bun:test";
import { retryableStream } from "../src/ai/model-manager";
import { antigravityRequest, getAntigravityUserAgent, antigravityAdapter, SKIP_THOUGHT_SIGNATURE } from "../src/ai/providers/antigravity";
import type { CallOptions, Message, ReasoningArtifact } from "../src/ai/types";
import { nativeToolSchemasFor } from "../src/agent/tool-schemas";
import { isRefusalError, isProviderStreamError, isRateLimitError, isMalformedFunctionCallError, defaultRetryable, withRetry } from "../src/util/retry";

const cred = { kind: "oauth" as const, provider: "gemini" as const, token: "tok", projectId: "proj-1" };

test("antigravityRequest: builds Cloud Code Assist internal request with project and model", () => {
  const { url, headers, body } = antigravityRequest(
    [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "hello" },
    ],
    { model: "antigravity/gemini-3-pro-low", maxTokens: 1234 } as any,
    cred,
  );
  expect(url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
  expect(headers.authorization).toBe("Bearer tok");
  expect(headers["User-Agent"].startsWith("antigravity/")).toBe(true);
  const payload = JSON.parse(body);
  expect(payload.project).toBe("proj-1");
  expect(payload.model).toBe("gemini-3-pro-low");
  expect(payload.requestType).toBe("agent");
  expect(payload.userAgent).toBe("antigravity");
  expect(payload.request.systemInstruction.parts[0].text).toBe("sys");
  expect(payload.request.contents[0].parts[0].text).toBe("hello");
  // Upstream Antigravity removes maxOutputTokens for non-Claude models.
  expect(payload.request.generationConfig?.maxOutputTokens).toBeUndefined();
  // gemini-3 thinking rides the thinkingLevel enum (the in-name -low marker), never a budget.
  expect(payload.request.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "LOW" });
});

test("antigravityRequest: keeps maxOutputTokens for Claude models", () => {
  const payload = JSON.parse(antigravityRequest(
    [{ role: "user" as const, content: "hello" }],
    { model: "antigravity/claude-sonnet-4-5", maxTokens: 2048 } as any,
    cred,
  ).body);
  expect(payload.model).toBe("claude-sonnet-4-5");
  expect(payload.request.generationConfig.maxOutputTokens).toBe(2048);
});

test("antigravityRequest: gemini-3 + effort sends thinkingLevel with NO thinkingBudget", () => {
  const payload = JSON.parse(antigravityRequest(
    [{ role: "user" as const, content: "hi" }],
    { model: "antigravity/gemini-3-pro", maxTokens: 4000, reasoningEffort: "high" } as any,
    cred,
  ).body);
  expect(payload.request.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
  expect(payload.request.generationConfig.thinkingConfig.thinkingBudget).toBeUndefined();
  // Non-Claude models still get no maxOutputTokens (upstream Antigravity strips it).
  expect(payload.request.generationConfig.maxOutputTokens).toBeUndefined();
});

test("antigravityRequest: gemini-2.5 + effort keeps the numeric budget (gjc GOOGLE_THINKING tiers)", () => {
  const payload = JSON.parse(antigravityRequest(
    [{ role: "user" as const, content: "hi" }],
    { model: "antigravity/gemini-2.5-flash", reasoningEffort: "medium" } as any,
    cred,
  ).body);
  expect(payload.request.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 8192 });
});

test("getAntigravityUserAgent follows Antigravity hub platform/arch shape", () => {
  expect(getAntigravityUserAgent()).toMatch(/^antigravity\/hub\/\d+\.\d+\.\d+ .+\/.+$/);
});

test("antigravityRequest: gemini-4-argon-medium honors in-name -medium effort when reasoningEffort is unset", () => {
  const payload = JSON.parse(antigravityRequest(
    [{ role: "user" as const, content: "hi" }],
    { model: "antigravity/gemini-4-argon-medium" } as any,
    cred,
  ).body);
  expect(payload.model).toBe("gemini-4-argon-medium");
  expect(payload.request.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 8192 });
});

test("antigravityRequest: Claude + reasoning enables thinking (includeThoughts) and the interleaved-thinking beta header", () => {
  const { headers, body } = antigravityRequest(
    [{ role: "user" as const, content: "hi" }],
    { model: "antigravity/claude-opus-4-6", maxTokens: 4000, reasoningEffort: "high" } as any,
    cred,
  );
  const payload = JSON.parse(body);
  // CCA only emits `thought` parts when includeThoughts is set; budget scales with effort.
  expect(payload.request.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 24000 });
  // Claude reasoning over CCA requires the Anthropic interleaved-thinking beta.
  expect(headers["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14");
  // CCA enforces max_tokens > thinking.budget_tokens (HTTP 400 otherwise) — bumped above the budget.
  expect(payload.request.generationConfig.maxOutputTokens).toBeGreaterThan(24000);
});

test("antigravityRequest: Claude without reasoning effort sends no thinking + no beta header", () => {
  const { headers, body } = antigravityRequest(
    [{ role: "user" as const, content: "hi" }],
    { model: "antigravity/claude-opus-4-6", maxTokens: 4000 } as any,
    cred,
  );
  const payload = JSON.parse(body);
  expect(payload.request.generationConfig?.thinkingConfig).toBeUndefined();
  expect(headers["anthropic-beta"]).toBeUndefined();
});

test("antigravityRequest: Gemini reasoning does NOT get the Claude beta header", () => {
  const { headers } = antigravityRequest(
    [{ role: "user" as const, content: "hi" }],
    { model: "antigravity/gemini-3-pro-high", maxTokens: 4000, reasoningEffort: "high" } as any,
    cred,
  );
  expect(headers["anthropic-beta"]).toBeUndefined();
});
async function drainStream(model: string, reasoningEffort: string | undefined): Promise<number> {
  const prevFetch = globalThis.fetch;
  const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  globalThis.fetch = (async () =>
    new Response(sse({ response: { candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] } }), {
      status: 200, headers: { "content-type": "text/event-stream" },
    })) as any;
  let started = 0;
  try {
    const opts: any = { model, onReasoningStart: () => { started++; } };
    if (reasoningEffort) opts.reasoningEffort = reasoningEffort;
    for await (const _ of antigravityAdapter.stream([{ role: "user", content: "hi" }], opts, cred)) { /* drain */ }
  } finally {
    globalThis.fetch = prevFetch;
  }
  return started;
}

test("antigravityAdapter.stream: fires onReasoningStart up front only when thinking is requested", async () => {
  // Effort set on a Gemini model → budget > 0 → thinking phase signalled (was silent before).
  expect(await drainStream("antigravity/gemini-3-flash", "medium")).toBe(1);
  // No effort + unmarked flash → budget 0 → no signal (parity with off-by-default).
  expect(await drainStream("antigravity/gemini-3-flash", undefined)).toBe(0);
  // In-name depth marker (-low) means thinking even with no effort → still signalled.
  expect(await drainStream("antigravity/gemini-3-pro-low", undefined)).toBe(1);
  // Claude without effort stays non-thinking → no signal.
  expect(await drainStream("antigravity/claude-opus-4-6", undefined)).toBe(0);
});

test("antigravityAdapter.call: empty completion with a SAFETY finishReason surfaces the reason and is detected as a refusal", async () => {
  const prevFetch = globalThis.fetch;
  const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  globalThis.fetch = (async () =>
    new Response(sse({ response: { candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] } }), {
      status: 200, headers: { "content-type": "text/event-stream" },
    })) as any;
  try {
    let caught: Error | undefined;
    try {
      await antigravityAdapter.call([{ role: "user", content: "hi" }], { model: "antigravity/gemini-3-flash" } as any, cred);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    // "returned no content" (not "returned an empty response") so defaultRetryable's
    // transient-empty-200 substring match still applies consistently with gemini.ts.
    expect(caught!.message).toBe("Antigravity Cloud Code Assist returned no content (finishReason=SAFETY).");
    expect(isRefusalError(caught!)).toBe(true);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("antigravityAdapter.stream: empty completion with a finishReason surfaces it in the thrown error", async () => {
  const prevFetch = globalThis.fetch;
  const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  globalThis.fetch = (async () =>
    new Response(sse({ response: { candidates: [{ content: { parts: [] }, finishReason: "RECITATION" }] } }), {
      status: 200, headers: { "content-type": "text/event-stream" },
    })) as any;
  try {
    let caught: Error | undefined;
    try {
      for await (const _ of antigravityAdapter.stream([{ role: "user", content: "hi" }], { model: "antigravity/gemini-3-flash" } as any, cred)) {
        // drain
      }
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toBe("Antigravity Cloud Code Assist returned no content (finishReason=RECITATION).");
    expect(isRefusalError(caught!)).toBe(true);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("antigravityAdapter.call: empty completion with NO finishReason keeps the reason-free message (STOP / absent)", async () => {
  const prevFetch = globalThis.fetch;
  const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  globalThis.fetch = (async () =>
    new Response(sse({ response: { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] } }), {
      status: 200, headers: { "content-type": "text/event-stream" },
    })) as any;
  try {
    let caught: Error | undefined;
    try {
      await antigravityAdapter.call([{ role: "user", content: "hi" }], { model: "antigravity/gemini-3-flash" } as any, cred);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toBe("Antigravity Cloud Code Assist returned no content.");
    expect(isRefusalError(caught!)).toBe(false);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

// Structural fix for "안티그라비티 모델이 중간에 멈추는 현상": Cloud Code Assist can emit a
// `google.rpc.Status`-shaped in-band error LINE (sibling of `response`, not nested inside it)
// on an otherwise-live 200 SSE connection. Previously silently ignored — it matches neither
// `response.candidates` nor any other check, so a turn that had already streamed some text
// just ended early with NO error at all (a silent truncation, not a visible failure).
test("antigravityAdapter.stream: an in-band error line throws ProviderStreamError mid-stream (not silently swallowed)", async () => {
  const prevFetch = globalThis.fetch;
  const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  const events = [
    sse({ response: { candidates: [{ content: { parts: [{ text: "partial " }] } }] } }),
    sse({ error: { code: 500, message: "internal error", status: "INTERNAL" } }),
    sse({ response: { candidates: [{ content: { parts: [{ text: "never reached" }] } }] } }),
  ].join("");
  globalThis.fetch = (async () =>
    new Response(events, { status: 200, headers: { "content-type": "text/event-stream" } })) as any;
  try {
    let text = "";
    let caught: Error | undefined;
    try {
      for await (const d of antigravityAdapter.stream([{ role: "user", content: "hi" }], { model: "antigravity/gemini-3-flash" } as any, cred)) {
        text += d;
      }
    } catch (err) {
      caught = err as Error;
    }
    // The pre-error delta streamed (proves this is a MID-stream fault, not a first-chunk one).
    expect(text).toBe("partial ");
    expect(caught).toBeDefined();
    expect(isProviderStreamError(caught)).toBe(true);
    expect(caught!.message).toContain("Antigravity stream failed (INTERNAL): internal error");
    expect((caught as any).status).toBe(500);
    expect(defaultRetryable(caught)).toBe(true);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("antigravityAdapter.call: an in-band RESOURCE_EXHAUSTED error line classifies as a rate limit (status 429)", async () => {
  const prevFetch = globalThis.fetch;
  const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  globalThis.fetch = (async () =>
    new Response(sse({ error: { code: 429, message: "quota exceeded", status: "RESOURCE_EXHAUSTED" } }), {
      status: 200, headers: { "content-type": "text/event-stream" },
    })) as any;
  try {
    let caught: Error | undefined;
    try {
      await antigravityAdapter.call([{ role: "user", content: "hi" }], { model: "antigravity/gemini-3-flash" } as any, cred);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect((caught as any).status).toBe(429);
    expect(isRateLimitError(caught)).toBe(true);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

const retryMessages = [{ role: "user" as const, content: "hi" }];
const retryOptions = { model: "antigravity/gemini-3-flash" };
const immediateRetry = { retries: 3, sleep: async () => {}, random: () => 0 };
const responseEvents = (...events: unknown[]) => new Response(
  events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
  { status: 200, headers: { "content-type": "text/event-stream" } },
);
const candidate = (parts: unknown[], finishReason?: string) => ({
  response: { candidates: [{ content: { parts }, ...(finishReason ? { finishReason } : {}) }] },
});

test("antigravity buffered call retries a malformed function call without returning its partial tool", async () => {
  const prevFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts++;
    return attempts === 1
      ? responseEvents(candidate([{ functionCall: { name: "dangerous", args: { path: "partial" } } }]), candidate([], "MALFORMED_FUNCTION_CALL"))
      : responseEvents(candidate([{ functionCall: { name: "safe", args: { path: "complete" } } }], "STOP"));
  }) as typeof fetch;
  try {
    const result = await withRetry(() => antigravityAdapter.call(retryMessages, retryOptions, cred), immediateRetry);
    expect(JSON.parse(result)).toEqual({ tool: "safe", arguments: { path: "complete" } });
    expect(attempts).toBe(2);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("antigravity buffered call exhausts its retry budget on malformed function calls", async () => {
  const prevFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts++;
    return responseEvents(candidate([{ functionCall: { name: "dangerous", args: { path: "partial" } } }], "MALFORMED_FUNCTION_CALL"));
  }) as typeof fetch;
  try {
    await expect(withRetry(() => antigravityAdapter.call(retryMessages, retryOptions, cred), immediateRetry))
      .rejects.toThrow("MALFORMED_FUNCTION_CALL");
    expect(attempts).toBe(3);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("antigravity buffered call does not retry an unrelated nonretryable error", async () => {
  const prevFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts++;
    return responseEvents(candidate([{ text: "partial" }], "SAFETY"));
  }) as typeof fetch;
  try {
    await expect(withRetry(() => antigravityAdapter.call(retryMessages, retryOptions, cred), immediateRetry))
      .rejects.toThrow("SAFETY");
    expect(attempts).toBe(1);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

for (const { name, finishReason, error } of [
  { name: "output limit", finishReason: "MAX_TOKENS", error: "finishReason=MAX_TOKENS" },
  { name: "missing finish reason", finishReason: undefined, error: "missing finishReason" },
]) {
  test(`antigravity buffered call does not retry ${name}`, async () => {
    const prevFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      return responseEvents(candidate([{ text: "partial" }], finishReason));
    }) as typeof fetch;
    try {
      await expect(withRetry(() => antigravityAdapter.call(retryMessages, retryOptions, cred), immediateRetry))
        .rejects.toThrow(error);
      expect(attempts).toBe(1);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
}

test("antigravity stream retries malformed buffered tool calls before the first yielded chunk", async () => {
  const prevFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts++;
    return attempts === 1
      ? responseEvents(candidate([{ functionCall: { name: "dangerous", args: {} } }], "MALFORMED_FUNCTION_CALL"))
      : responseEvents(candidate([{ functionCall: { name: "safe", args: { value: 42 } } }], "STOP"));
  }) as typeof fetch;
  try {
    const chunks: string[] = [];
    for await (const chunk of retryableStream(() => antigravityAdapter.stream!(retryMessages, retryOptions, cred)[Symbol.asyncIterator](), immediateRetry)) {
      chunks.push(chunk);
    }
    expect(chunks.map(chunk => JSON.parse(chunk))).toEqual([{ tool: "safe", arguments: { value: 42 } }]);
    expect(attempts).toBe(2);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("antigravity stream does not replay after emitting text before a malformed function call", async () => {
  const prevFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts++;
    return responseEvents(candidate([{ text: "partial " }]), candidate([{ functionCall: { name: "dangerous", args: {} } }], "MALFORMED_FUNCTION_CALL"));
  }) as typeof fetch;
  try {
    const chunks: string[] = [];
    let caught: unknown;
    try {
      for await (const chunk of retryableStream(() => antigravityAdapter.stream!(retryMessages, retryOptions, cred)[Symbol.asyncIterator](), immediateRetry)) {
        chunks.push(chunk);
      }
    } catch (err) {
      caught = err;
    }
    expect(chunks).toEqual(["partial "]);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("MALFORMED_FUNCTION_CALL");
    expect(attempts).toBe(1);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("isMalformedFunctionCallError matches finishReason=MALFORMED_FUNCTION_CALL", () => {
  expect(isMalformedFunctionCallError(new Error("Antigravity Cloud Code Assist response incomplete (finishReason=MALFORMED_FUNCTION_CALL)."))).toBe(true);
  expect(isMalformedFunctionCallError(new Error("Gemini response incomplete (finishReason=MALFORMED_FUNCTION_CALL)."))).toBe(true);
  expect(isMalformedFunctionCallError(new Error("Some malformed function call error"))).toBe(true);
  expect(isMalformedFunctionCallError(new Error("finishReason=MAX_TOKENS"))).toBe(false);
  expect(isMalformedFunctionCallError(new Error("network timeout"))).toBe(false);
});

test("antigravityRequest sanitizes tool schema parameters for Gemini", () => {
  const { body } = antigravityRequest(
    [{ role: "user" as const, content: "hi" }],
    {
      model: "antigravity/gemini-3.8-flash-high",
      tools: [
        {
          name: "test_tool",
          description: "desc",
          parameters: {
            type: "object",
            properties: {
              bare_obj: { type: "object" },
            },
            required: [],
          },
        },
      ],
    } as any,
    cred,
  );
  const payload = JSON.parse(body);
  const fnDecl = payload.request.tools[0].functionDeclarations[0];
  expect(fnDecl.parameters.required).toBeUndefined();
  expect(fnDecl.parameters.properties.bare_obj).toEqual({ type: "object", properties: {} });
});

test("antigravityRequest serializes multi-turn toolUse and toolResults to native parts", () => {
  const messages = [
    { role: "user" as const, content: "read file" },
    {
      role: "assistant" as const,
      content: '{"tool":"read","arguments":{"filePath":"test.txt"}}',
      toolUse: [{ id: "call_1", tool: "read", arguments: { filePath: "test.txt" } }],
    },
    {
      role: "user" as const,
      content: "file content here",
      toolResults: [{ id: "call_1", output: "file content here" }],
    },
  ];
  const { body } = antigravityRequest(
    messages,
    { model: "antigravity/gemini-3.8-flash-high" } as any,
    cred,
  );
  const payload = JSON.parse(body);
  const contents = payload.request.contents;
  expect(contents).toHaveLength(3);
  expect(contents[0].role).toBe("user");
  expect(contents[0].parts[0].text).toBe("read file");

  expect(contents[1].role).toBe("model");
  expect(contents[1].parts[0].functionCall).toEqual({ id: "call_1", name: "read", args: { filePath: "test.txt" } });

  expect(contents[2].role).toBe("user");
  expect(contents[2].parts[0].functionResponse).toEqual({ id: "call_1", name: "read", response: { output: "file content here" } });
});

test("antigravityRequest: attaches SKIP_THOUGHT_SIGNATURE to first functionCall when no artifact exists", () => {
  const messages: Message[] = [
    { role: "user", content: "read file" },
    {
      role: "assistant",
      content: '{"tool":"read","arguments":{"filePath":"test.txt"}}',
      toolUse: [
        { id: "call_1", tool: "read", arguments: { filePath: "test.txt" } },
        { id: "call_2", tool: "done", arguments: {} },
      ],
    },
  ];
  const opts: CallOptions = { model: "antigravity/gemini-3.8-flash-high" };
  const { body } = antigravityRequest(messages, opts, cred);
  const payload = JSON.parse(body);
  const parts = payload.request.contents[1].parts;
  // First functionCall MUST have the sentinel signature to satisfy Google's validator.
  expect(parts[0].functionCall.name).toBe("read");
  expect(parts[0].thoughtSignature).toBe(SKIP_THOUGHT_SIGNATURE);
  // Parallel call in the same turn does NOT have thoughtSignature per Gemini spec.
  expect(parts[1].functionCall.name).toBe("done");
  expect(parts[1].thoughtSignature).toBeUndefined();
});

test("antigravityRequest: replays authentic thoughtSignature when present in reasoningArtifacts", () => {
  const authentic = "authentic_signature_bytes_base64==";
  const messages: Message[] = [
    { role: "user", content: "read file" },
    {
      role: "assistant",
      content: '{"tool":"read","arguments":{"filePath":"test.txt"}}',
      toolUse: [{ id: "call_1", tool: "read", arguments: { filePath: "test.txt" } }],
      reasoningArtifacts: [
        { provider: "antigravity", model: "antigravity/gemini-3.8-flash-high", thoughtSignature: authentic },
      ],
    },
  ];
  const opts: CallOptions = { model: "antigravity/gemini-3.8-flash-high" };
  const { body } = antigravityRequest(messages, opts, cred);
  const payload = JSON.parse(body);
  const parts = payload.request.contents[1].parts;
  expect(parts[0].thoughtSignature).toBe(authentic);
});

test("antigravityAdapter.stream: captures thoughtSignature from SSE chunk into onReasoningArtifact", async () => {
  const prevFetch = globalThis.fetch;
  const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  const sig = "sig_from_stream_12345";
  globalThis.fetch = (async () =>
    new Response(
      sse({
        response: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { name: "default_api:read", args: { filePath: "test.txt" } },
                    thoughtSignature: sig,
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;
  try {
    const artifacts: ReasoningArtifact[] = [];
    const opts: CallOptions = {
      model: "antigravity/gemini-3.8-flash-high",
      onReasoningArtifact: a => artifacts.push(a),
    };
    let out = "";
    for await (const chunk of antigravityAdapter.stream!([{ role: "user", content: "read" }], opts, cred)) {
      out += chunk;
    }
    expect(JSON.parse(out)).toEqual({ tool: "read", arguments: { filePath: "test.txt" } });
    expect(artifacts).toEqual([
      { provider: "antigravity", model: "antigravity/gemini-3.8-flash-high", thoughtSignature: sig },
    ]);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("antigravityAdapter.call: captures thoughtSignature from SSE chunk into onReasoningArtifact", async () => {
  const prevFetch = globalThis.fetch;
  const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  const sig = "sig_from_call_67890";
  globalThis.fetch = (async () =>
    new Response(
      sse({
        response: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { name: "default_api:read", args: { filePath: "test.txt" } },
                    thought_signature: sig,
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;
  try {
    const artifacts: ReasoningArtifact[] = [];
    const opts: CallOptions = {
      model: "antigravity/gemini-3.8-flash-high",
      onReasoningArtifact: a => artifacts.push(a),
    };
    const out = await antigravityAdapter.call([{ role: "user", content: "read" }], opts, cred);
    expect(JSON.parse(out)).toEqual({ tool: "read", arguments: { filePath: "test.txt" } });
    expect(artifacts).toEqual([
      { provider: "antigravity", model: "antigravity/gemini-3.8-flash-high", thoughtSignature: sig },
    ]);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("antigravity failsafe retries with stripArtifacts (SKIP_THOUGHT_SIGNATURE) on 400 thought_signature error", async () => {
  const prevFetch = globalThis.fetch;
  const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  let callCount = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    callCount++;
    const reqBody = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const contents = reqBody.request?.contents ?? [];
    const firstPart = contents[1]?.parts?.[0];
    if (callCount === 1) {
      // First call has the expired/invalid signature, backend returns 400.
      expect(firstPart?.thoughtSignature).toBe("invalid_signature");
      return new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: "Function call is missing a thought_signature in functionCall parts.",
            status: "INVALID_ARGUMENT",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    // Retry call should have stripped artifacts and used SKIP_THOUGHT_SIGNATURE.
    expect(firstPart?.thoughtSignature).toBe(SKIP_THOUGHT_SIGNATURE);
    return new Response(
      sse({
        response: {
          candidates: [{ content: { parts: [{ text: "recovered successfully" }] }, finishReason: "STOP" }],
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
  try {
    const messages: Message[] = [
      { role: "user", content: "read file" },
      {
        role: "assistant",
        content: '{"tool":"read","arguments":{}}',
        toolUse: [{ id: "c1", tool: "read", arguments: {} }],
        reasoningArtifacts: [
          { provider: "antigravity", model: "antigravity/gemini-3.8-flash-high", thoughtSignature: "invalid_signature" },
        ],
      },
      { role: "user", content: "result", toolResults: [{ id: "c1", output: "ok" }] },
    ];
    const opts: CallOptions = { model: "antigravity/gemini-3.8-flash-high" };
    const out = await antigravityAdapter.call(messages, opts, cred);
    expect(out).toBe("recovered successfully");
    expect(callCount).toBe(2);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("antigravityRequest: Claude models preserve matching tool_use/tool_result ids, forward toolResult images, and skip empty text parts", () => {
  const messages: Message[] = [
    {
      role: "user",
      content: "",
      images: [{ mediaType: "image/png", data: "aW1nMQ==" }],
    },
    {
      role: "assistant",
      content: '{"tool":"read","arguments":{"filePath":"a.png"}}',
      toolUse: [{ id: "call_1_0", tool: "read", arguments: { filePath: "a.png" } }],
      // A Gemini signature from an earlier turn must NOT be replayed into Claude.
      reasoningArtifacts: [
        { provider: "antigravity", model: "antigravity/gemini-3-flash", thoughtSignature: "gemini_sig==" },
      ],
    },
    {
      role: "user",
      content: "Tool [read] result (ok):",
      toolResults: [{ id: "call_1_0", output: "Image read", isError: false }],
      images: [{ mediaType: "image/png", data: "aW1nMg==" }],
    },
  ];
  const { body } = antigravityRequest(
    messages,
    { model: "antigravity/claude-opus-4-6-thinking", reasoningEffort: "xhigh" as any } as any,
    cred,
  );
  const payload = JSON.parse(body);
  expect(payload.request.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 24000 });
  const contents = payload.request.contents;
  // Image-only user turn omits { text: "" } so Anthropic/CCA does not reject with text.text Field required.
  expect(contents[0].parts).toEqual([{ inlineData: { mimeType: "image/png", data: "aW1nMQ==" } }]);
  // Matching functionCall.id + cross-model signature dropped in favor of SKIP_THOUGHT_SIGNATURE.
  expect(contents[1].parts[0].functionCall).toEqual({ id: "call_1_0", name: "read", args: { filePath: "a.png" } });
  expect(contents[1].parts[0].thoughtSignature).toBe(SKIP_THOUGHT_SIGNATURE);
  // Matching functionResponse.id + inlineData image attachment.
  expect(contents[2].parts).toEqual([
    { functionResponse: { id: "call_1_0", name: "read", response: { output: "Image read" } } },
    { inlineData: { mimeType: "image/png", data: "aW1nMg==" } },
  ]);
});

test("antigravityRequest: replays same-model signature even when prefix differs (claude-sonnet-4-6)", () => {
  const sig = "Y2xhdWRlX3NpZ192YWxpZA==";
  const messages: Message[] = [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: '{"tool":"read","arguments":{"filePath":"x"}}',
      toolUse: [{ id: "call_2_0", tool: "read", arguments: { filePath: "x" } }],
      reasoningArtifacts: [
        { provider: "antigravity", model: "claude-sonnet-4-6", thoughtSignature: sig },
      ],
    },
  ];
  const { body } = antigravityRequest(
    messages,
    { model: "antigravity/claude-sonnet-4-6", reasoningEffort: "medium" } as any,
    cred,
  );
  const payload = JSON.parse(body);
  expect(payload.request.contents[1].parts[0].thoughtSignature).toBe(sig);
  expect(payload.request.contents[1].parts[0].functionCall.id).toBe("call_2_0");
});

function hasKeyDeep(node: unknown, targetKey: string): boolean {
  if (Array.isArray(node)) return node.some(item => hasKeyDeep(item, targetKey));
  if (typeof node === "object" && node !== null) {
    for (const [k, v] of Object.entries(node)) {
      if (k === targetKey || hasKeyDeep(v, targetKey)) return true;
    }
  }
  return false;
}

test("antigravityRequest: claude-opus-4-6-thinking strips anyOf across all default+delegation schemas", () => {
  const tools = nativeToolSchemasFor([
    "read", "write", "edit", "bash", "find", "search", "ls", "mkdir", "delete",
    "web_search", "computer", "calc", "jeox", "task", "subagent", "monitor",
    "sandbox_request", "done",
  ]);
  const messages: Message[] = [{ role: "user", content: "hi" }];
  const claudeReq = antigravityRequest(
    messages,
    { model: "antigravity/claude-opus-4-6-thinking", tools },
    cred,
  );
  const claudePayload = JSON.parse(claudeReq.body) as {
    request: { tools: [{ functionDeclarations: Array<{ name: string; parameters: Record<string, unknown> }> }] };
  };
  expect(hasKeyDeep(claudePayload.request.tools, "anyOf")).toBe(false);
  const taskDecl = claudePayload.request.tools[0].functionDeclarations.find(d => d.name === "task")!;
  expect((taskDecl.parameters.properties as Record<string, unknown>).tasks).toEqual({
    type: "array",
    items: {
      type: "object",
      properties: {
        task: { type: "string" },
        context: { type: "string" },
      },
      required: ["task"],
    },
  });

  // Gemini models preserve anyOf on SCHEMAS.task.
  const geminiReq = antigravityRequest(
    messages,
    { model: "antigravity/gemini-3-flash", tools },
    cred,
  );
  const geminiPayload = JSON.parse(geminiReq.body) as {
    request: { tools: unknown };
  };
  expect(hasKeyDeep(geminiPayload.request.tools, "anyOf")).toBe(true);
});

test("antigravityAdapter.call and .stream surface a bounded text snippet when finishReason is missing", async () => {
  const prevFetch = globalThis.fetch;
  const messages: Message[] = [{ role: "user", content: "hi" }];
  const opts: CallOptions = { model: "antigravity/gemini-3.5-flash" };
  try {
    const retirementMsg = "  Gemini 3.5 Flash is no longer available. Please migrate to a newer model.  ";
    globalThis.fetch = (async () => responseEvents(candidate([{ text: retirementMsg }]))) as typeof fetch;

    await expect(antigravityAdapter.call(messages, opts, cred)).rejects.toThrow(
      "Antigravity Cloud Code Assist response incomplete (missing finishReason): Gemini 3.5 Flash is no longer available. Please migrate to a newer model.",
    );

    const streamed: string[] = [];
    let streamErr: Error | undefined;
    try {
      for await (const chunk of antigravityAdapter.stream!(messages, opts, cred)) {
        streamed.push(chunk);
      }
    } catch (err) {
      streamErr = err as Error;
    }
    expect(streamed.join("")).toBe(retirementMsg);
    expect(streamErr).toBeDefined();
    expect(streamErr!.message).toBe(
      "Antigravity Cloud Code Assist response incomplete (missing finishReason): Gemini 3.5 Flash is no longer available. Please migrate to a newer model.",
    );

    // Bounded to 200 chars when text exceeds 200 characters.
    const longMsg = "a".repeat(250);
    globalThis.fetch = (async () => responseEvents(candidate([{ text: longMsg }]))) as typeof fetch;
    await expect(antigravityAdapter.call(messages, opts, cred)).rejects.toThrow(
      `Antigravity Cloud Code Assist response incomplete (missing finishReason): ${"a".repeat(200)}`,
    );

    // Empty text with functionCall keeps the period-terminated message.
    globalThis.fetch = (async () => responseEvents(candidate([{ functionCall: { name: "read", args: { filePath: "x" } } }]))) as typeof fetch;
    await expect(antigravityAdapter.call(messages, opts, cred)).rejects.toThrow(
      "Antigravity Cloud Code Assist response incomplete (missing finishReason).",
    );
    await expect((async () => {
      for await (const _ of antigravityAdapter.stream!(messages, opts, cred)) { /* drain */ }
    })()).rejects.toThrow(
      "Antigravity Cloud Code Assist response incomplete (missing finishReason).",
    );
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("antigravityAdapter.call and .stream preserve complete tool-call JSON text when CCA terminates with MALFORMED_FUNCTION_CALL and no functionCall parts", async () => {
  const prevFetch = globalThis.fetch;
  const jsonText = '{ "reasoning": "Read lines 1-3", "tool": "read", "arguments": { "filePath": "package.json", "lineRange": "1-3" } }';
  try {
    globalThis.fetch = (async () => responseEvents(candidate([{ text: jsonText }]), candidate([], "MALFORMED_FUNCTION_CALL"))) as typeof fetch;
    const callOut = await antigravityAdapter.call(retryMessages, retryOptions, cred);
    expect(JSON.parse(callOut)).toMatchObject({ tool: "read", arguments: { filePath: "package.json", lineRange: "1-3" } });

    let streamOut = "";
    for await (const chunk of antigravityAdapter.stream!(retryMessages, retryOptions, cred)) {
      streamOut += chunk;
    }
    expect(JSON.parse(streamOut)).toMatchObject({ tool: "read", arguments: { filePath: "package.json", lineRange: "1-3" } });
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("antigravityAdapter.call and .stream preserve complete tool-call JSON text when finishReason is omitted and no functionCall parts exist", async () => {
  const prevFetch = globalThis.fetch;
  const jsonText = '{ "reasoning": "Read lines 1-3", "tool": "read", "arguments": { "filePath": "package.json", "lineRange": "1-3" } }';
  try {
    globalThis.fetch = (async () => responseEvents(candidate([{ text: jsonText }]))) as typeof fetch;
    const callOut = await antigravityAdapter.call(retryMessages, retryOptions, cred);
    expect(JSON.parse(callOut)).toMatchObject({ tool: "read", arguments: { filePath: "package.json", lineRange: "1-3" } });

    let streamOut = "";
    for await (const chunk of antigravityAdapter.stream!(retryMessages, retryOptions, cred)) {
      streamOut += chunk;
    }
    expect(JSON.parse(streamOut)).toMatchObject({ tool: "read", arguments: { filePath: "package.json", lineRange: "1-3" } });
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("antigravityAdapter.call and .stream reject truncated mid-batch tool JSON when finishReason is omitted or MALFORMED_FUNCTION_CALL", async () => {
  const prevFetch = globalThis.fetch;
  const truncated = '{ "tools": [{ "tool": "read", "arguments": { "filePath": "a" } }, { "tool": "edit", ';
  try {
    globalThis.fetch = (async () => responseEvents(candidate([{ text: truncated }]))) as typeof fetch;
    await expect(antigravityAdapter.call(retryMessages, retryOptions, cred)).rejects.toThrow("missing finishReason");
    await expect((async () => {
      for await (const _ of antigravityAdapter.stream!(retryMessages, retryOptions, cred)) { /* drain */ }
    })()).rejects.toThrow("missing finishReason");

    globalThis.fetch = (async () => responseEvents(candidate([{ text: truncated }], "MALFORMED_FUNCTION_CALL"))) as typeof fetch;
    await expect(antigravityAdapter.call(retryMessages, retryOptions, cred)).rejects.toThrow("MALFORMED_FUNCTION_CALL");

    const proseWithExample = 'Here is an example: {"tool":"read","arguments":{"filePath":"a"}} and more text...';
    globalThis.fetch = (async () => responseEvents(candidate([{ text: proseWithExample }]))) as typeof fetch;
    await expect(antigravityAdapter.call(retryMessages, retryOptions, cred)).rejects.toThrow("missing finishReason");
  } finally {
    globalThis.fetch = prevFetch;
  }
});