import { test, expect } from "bun:test";
import { geminiRequest, geminiThinkingBudget } from "../src/ai/providers/gemini";

const cred = { kind: "api_key" as const, provider: "gemini" as const, token: "k" };

test("geminiRequest: coalesces consecutive same-role turns (Gemini strict alternation)", () => {
  const messages = [
    { role: "system" as const, content: "sys" },
    { role: "user" as const, content: "u1" },
    { role: "user" as const, content: "u2" }, // consecutive user (e.g. compaction summary + tool-result)
    { role: "assistant" as const, content: "a1" },
    { role: "user" as const, content: "u3" },
  ];
  const { body } = geminiRequest(messages, { model: "gemini-2.5-flash" } as any, cred, "generateContent");
  const payload = JSON.parse(body);
  // system is lifted out; the two consecutive users merge into one content with two parts.
  expect(payload.contents.map((c: any) => c.role)).toEqual(["user", "model", "user"]);
  expect(payload.contents[0].parts.map((p: any) => p.text)).toEqual(["u1", "u2"]);
  expect(payload.systemInstruction.parts[0].text).toBe("sys");
});

test("geminiRequest: single turns map through unchanged (no spurious merging)", () => {
  const messages = [
    { role: "user" as const, content: "hi" },
    { role: "assistant" as const, content: "yo" },
    { role: "user" as const, content: "bye" },
  ];
  const { body } = geminiRequest(messages, { model: "gemini-2.5-flash" } as any, cred, "generateContent");
  const payload = JSON.parse(body);
  expect(payload.contents.map((c: any) => c.role)).toEqual(["user", "model", "user"]);
  expect(payload.contents.every((c: any) => c.parts.length === 1)).toBe(true);
});

test("geminiRequest: URL-encodes the model name and api key", () => {
  const evilCred = { kind: "api_key" as const, provider: "gemini" as const, token: "k&y=1" };
  const { url } = geminiRequest(
    [{ role: "user" as const, content: "hi" }],
    { model: "gemini-2.5-flash/../evil?x=1" } as any,
    evilCred,
    "generateContent",
  );
  expect(url).toContain("models/gemini-2.5-flash%2F..%2Fevil%3Fx%3D1:generateContent");
  expect(url).toContain("key=k%26y%3D1");
  expect(url).not.toContain("key=k&y=1");
});

test("geminiThinkingBudget: off by default on flash-class, floored on pro, omitted on pre-2.5", () => {
  // No effort requested → thinking disabled on flash-class thinking models.
  expect(geminiThinkingBudget("gemini-2.5-flash")).toBe(0);
  expect(geminiThinkingBudget("gemini-flash-latest")).toBe(0);
  // Pro-class cannot disable thinking — keeps the API floor.
  expect(geminiThinkingBudget("gemini-2.5-pro")).toBe(128);
  expect(geminiThinkingBudget("gemini-pro-latest")).toBe(128);
  // Pre-2.5 models reject thinkingConfig → omit entirely.
  expect(geminiThinkingBudget("gemini-2.0-flash")).toBeUndefined();
  expect(geminiThinkingBudget("gemini-1.5-pro")).toBeUndefined();
  // Digit-count agnostic: multi-digit majors must NOT silently lose thinking the way
  // opus-4-8 did. gemini-10+ stays reasoning-capable; 2.6–2.9 minors too.
  expect(geminiThinkingBudget("gemini-10-pro")).toBe(128);
  expect(geminiThinkingBudget("gemini-2.7-flash")).toBe(0);
});

test("geminiThinkingBudget: effort maps to budget and clamps below maxTokens", () => {
  expect(geminiThinkingBudget("gemini-2.5-flash", "low")).toBe(4000);
  expect(geminiThinkingBudget("gemini-2.5-flash", "medium")).toBe(10000);
  expect(geminiThinkingBudget("gemini-2.5-flash", "high")).toBe(24000);
  // minimal is now a genuine light tier (gajae parity: reasoning at every level), not 0.
  expect(geminiThinkingBudget("gemini-2.5-flash", "minimal")).toBe(2000);
  // Clamp: medium (10000) against a 4000-token output cap leaves ~1K for text.
  expect(geminiThinkingBudget("gemini-2.5-flash", "medium", 4000)).toBe(2976);
  // Tiny output budgets kill thinking entirely (the live empty-reply repro).
  expect(geminiThinkingBudget("gemini-flash-latest", "medium", 16)).toBe(0);
  // Pro never clamps below its floor.
  expect(geminiThinkingBudget("gemini-2.5-pro", "medium", 16)).toBe(128);
});

test("geminiRequest: wires thinkingConfig for thinking models only", () => {
  const messages = [{ role: "user" as const, content: "hi" }];
  const thinking = JSON.parse(
    geminiRequest(messages, { model: "gemini-flash-latest", maxTokens: 16 } as any, cred, "generateContent").body,
  );
  expect(thinking.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 0 });
  const legacy = JSON.parse(
    geminiRequest(messages, { model: "gemini-2.0-flash" } as any, cred, "generateContent").body,
  );
  expect(legacy.generationConfig.thinkingConfig).toBeUndefined();
});

import { geminiCliRequest, geminiAdapter, getGeminiCliHeaders, geminiThinkingActive } from "../src/ai/providers/gemini";

test("geminiCliRequest: wraps the payload in a Cloud Code Assist envelope", () => {
  const messages = [
    { role: "system" as const, content: "sys" },
    { role: "user" as const, content: "hi" },
  ];
  const { url, headers, body } = geminiCliRequest(messages, { model: "google/gemini-2.5-flash", maxTokens: 100 } as any, "tok-1", "proj-1");
  expect(url).toBe("https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
  expect(headers.authorization).toBe("Bearer tok-1");
  expect(headers["User-Agent"]).toContain("GeminiCLI/");
  expect(headers["Client-Metadata"]).toContain("pluginType=GEMINI");
  const payload = JSON.parse(body);
  expect(payload.project).toBe("proj-1");
  expect(payload.model).toBe("gemini-2.5-flash"); // provider prefix stripped
  expect(payload.request.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  expect(payload.request.systemInstruction).toEqual({ parts: [{ text: "sys" }] });
  expect(payload.request.generationConfig.maxOutputTokens).toBe(100);
});

test("getGeminiCliHeaders: includes the requested model in the user agent", () => {
  expect(getGeminiCliHeaders("gemini-2.0-flash")["User-Agent"]).toContain("/gemini-2.0-flash ");
});

test("geminiAdapter: OAuth credential routes to Cloud Code Assist and unwraps response chunks", async () => {
  const prevFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const body = sse({ response: { candidates: [{ content: { parts: [{ text: "hel" }] } }] } }) +
      sse({ response: { candidates: [{ content: { parts: [{ text: "lo" }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, thoughtsTokenCount: 3 } } });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as any;
  try {
    const usage: any[] = [];
    const out = await geminiAdapter.call(
      [{ role: "user", content: "hi" }],
      { model: "gemini-2.5-flash", onUsage: (u: any) => usage.push(u) } as any,
      { kind: "oauth", provider: "gemini", token: "tok-2", projectId: "proj-2" } as any,
    );
    expect(out).toBe("hello");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("cloudcode-pa.googleapis.com/v1internal:streamGenerateContent");
    const sent = JSON.parse(String(calls[0]!.init?.body));
    expect(sent.project).toBe("proj-2"); // stored projectId short-circuits discovery (no extra fetch)
    // Thought tokens count as output (gjc parity).
    expect(usage).toEqual([{ inputTokens: 7, outputTokens: 5 }]);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("geminiAdapter: api_key credential keeps using the public generativelanguage API", async () => {
  const prevFetch = globalThis.fetch;
  let calledUrl = "";
  globalThis.fetch = (async (url: any) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200 });
  }) as any;
  try {
    const out = await geminiAdapter.call(
      [{ role: "user", content: "hi" }],
      { model: "gemini-2.5-flash" } as any,
      { kind: "api_key", provider: "gemini", token: "AIza-x" } as any,
    );
    expect(out).toBe("ok");
    expect(calledUrl).toContain("generativelanguage.googleapis.com");
    expect(calledUrl).toContain("key=AIza-x");
  } finally {
    globalThis.fetch = prevFetch;
  }
});
test("geminiThinkingBudget: in-name depth marker (-high/-low/-thinking) overrides the unset floor", () => {
  // An explicit `-thinking` variant must NOT fall to the silent flash floor of 0.
  expect(geminiThinkingBudget("gemini-2.5-flash-thinking")).toBe(10000);
  // `-high`/`-low` (e.g. antigravity gemini-3-pro-high/low) select depth even with no effort —
  // the variant choice IS the thinking opt-in, so it beats the bare pro floor of 128.
  expect(geminiThinkingBudget("gemini-3-pro-high")).toBe(24000);
  expect(geminiThinkingBudget("gemini-3-pro-low")).toBe(4000);
  expect(geminiThinkingBudget("gemini-3.1-pro-high")).toBe(24000);
  // An explicit caller effort still wins over the in-name marker.
  expect(geminiThinkingBudget("gemini-3-pro-high", "low")).toBe(4000);
  // Unmarked thinking-capable ids keep the off-by-default floor (cross-provider parity).
  expect(geminiThinkingBudget("gemini-3-flash")).toBe(0);
  expect(geminiThinkingBudget("gemini-2.5-flash")).toBe(0);
});

test("geminiThinkingActive: true only when a positive budget is requested", () => {
  // Effort set on a flash-class model → budget > 0 → active.
  expect(geminiThinkingActive({ model: "gemini-2.5-flash", reasoningEffort: "medium" } as any)).toBe(true);
  // No effort + unmarked flash → budget 0 → not active (so no spurious thinking indicator).
  expect(geminiThinkingActive({ model: "gemini-2.5-flash" } as any)).toBe(false);
  // In-name depth marker activates it even without an effort.
  expect(geminiThinkingActive({ model: "google/gemini-3-pro-high" } as any)).toBe(true);
  // Pre-2.5 models can't think → never active.
  expect(geminiThinkingActive({ model: "gemini-2.0-flash", reasoningEffort: "high" } as any)).toBe(false);
});

test("geminiAdapter (OAuth/CCA): fires onReasoningStart up front only when thinking is requested", async () => {
  const prevFetch = globalThis.fetch;
  const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  globalThis.fetch = (async () =>
    new Response(sse({ response: { candidates: [{ content: { parts: [{ text: "hi" }] } }] } }), {
      status: 200, headers: { "content-type": "text/event-stream" },
    })) as any;
  const oauth = { kind: "oauth", provider: "gemini", token: "t", projectId: "p" } as any;
  try {
    let started = 0;
    await geminiAdapter.call(
      [{ role: "user", content: "hi" }],
      { model: "gemini-2.5-flash", reasoningEffort: "medium", onReasoningStart: () => { started++; } } as any,
      oauth,
    );
    expect(started).toBe(1); // thinking requested → indicator signalled even before any thought part

    let startedOff = 0;
    await geminiAdapter.call(
      [{ role: "user", content: "hi" }],
      { model: "gemini-2.5-flash", onReasoningStart: () => { startedOff++; } } as any,
      oauth,
    );
    expect(startedOff).toBe(0); // no effort + flash floor 0 → thinking off → no signal
  } finally {
    globalThis.fetch = prevFetch;
  }
});