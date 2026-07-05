import { test, expect } from "bun:test";
import { antigravityRequest, getAntigravityUserAgent, antigravityAdapter } from "../src/ai/providers/antigravity";
import { isRefusalError } from "../src/util/retry";

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

test("getAntigravityUserAgent follows Antigravity platform/arch shape", () => {
  expect(getAntigravityUserAgent()).toMatch(/^antigravity\/\d+\.\d+\.\d+ .+\/.+$/);
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
    new Response(sse({ response: { candidates: [{ content: { parts: [{ text: "hi" }] } }] } }), {
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