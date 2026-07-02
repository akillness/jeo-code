import { test, expect } from "bun:test";
import { geminiRequest, geminiThinkingBudget, geminiThinkingConfig, geminiUsesThinkingLevel } from "../src/ai/providers/gemini";

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

test("geminiThinkingBudget: effort maps to budget (gjc GOOGLE_THINKING tiers) and clamps below maxTokens", () => {
  expect(geminiThinkingBudget("gemini-2.5-flash", "low")).toBe(4096);
  expect(geminiThinkingBudget("gemini-2.5-flash", "medium")).toBe(8192);
  expect(geminiThinkingBudget("gemini-2.5-flash", "high")).toBe(16384);
  expect(geminiThinkingBudget("gemini-2.5-flash", "xhigh")).toBe(24575);
  // minimal is a genuine light tier (gajae parity: reasoning at every level), not 0.
  expect(geminiThinkingBudget("gemini-2.5-flash", "minimal")).toBe(1024);
  // Clamp: medium (8192) against a 4000-token output cap leaves ~1K for text.
  expect(geminiThinkingBudget("gemini-2.5-flash", "medium", 4000)).toBe(2976);
  // Tiny output budgets kill thinking entirely (the live empty-reply repro).
  expect(geminiThinkingBudget("gemini-flash-latest", "medium", 16)).toBe(0);
  // Pro never clamps below its floor.
  expect(geminiThinkingBudget("gemini-2.5-pro", "medium", 16)).toBe(128);
});

test("geminiThinkingConfig: gemini-3.x carries the thinkingLevel enum, never a numeric budget", () => {
  expect(geminiUsesThinkingLevel("gemini-3-pro")).toBe(true);
  expect(geminiUsesThinkingLevel("gemini-3.1-pro-preview")).toBe(true);
  expect(geminiUsesThinkingLevel("gemini-2.5-flash")).toBe(false);
  expect(geminiUsesThinkingLevel("gemini-10-pro")).toBe(false); // major 10 ≠ 3 → budget mode

  // gjc mapEffortToGoogleThinkingLevel: minimal→MINIMAL, low→LOW, medium→MEDIUM, high→HIGH.
  expect(geminiThinkingConfig("gemini-3-pro", "minimal")).toEqual({ includeThoughts: true, thinkingLevel: "MINIMAL" });
  expect(geminiThinkingConfig("gemini-3-flash", "low")).toEqual({ includeThoughts: true, thinkingLevel: "LOW" });
  expect(geminiThinkingConfig("gemini-3.1-pro", "medium")).toEqual({ includeThoughts: true, thinkingLevel: "MEDIUM" });
  expect(geminiThinkingConfig("gemini-3-pro", "high")).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
  // In-name depth markers still select the level with no caller effort…
  expect(geminiThinkingConfig("gemini-3-pro-high")).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
  expect(geminiThinkingConfig("gemini-3-pro-low")).toEqual({ includeThoughts: true, thinkingLevel: "LOW" });
  // …but an explicit caller effort wins.
  expect(geminiThinkingConfig("gemini-3-pro-high", "low")).toEqual({ includeThoughts: true, thinkingLevel: "LOW" });
  // No effort + unmarked gemini-3 → omit thinkingConfig (model default; gjc parity).
  expect(geminiThinkingConfig("gemini-3-flash")).toBeUndefined();
  // Non-3 majors keep the numeric budget path; pre-2.5 stays omitted.
  expect(geminiThinkingConfig("gemini-10-pro", "medium")).toEqual({ includeThoughts: true, thinkingBudget: 8192 });
  expect(geminiThinkingConfig("gemini-2.5-flash", "medium")).toEqual({ includeThoughts: true, thinkingBudget: 8192 });
  expect(geminiThinkingConfig("gemini-2.0-flash", "high")).toBeUndefined();
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
  expect(geminiThinkingBudget("gemini-2.5-flash-thinking")).toBe(8192);
  // `-high`/`-low` select depth even with no effort — the variant choice IS the thinking
  // opt-in, so it beats the bare pro floor of 128 (budget path; gemini-3 uses levels).
  expect(geminiThinkingBudget("gemini-2.5-pro-high")).toBe(16384);
  expect(geminiThinkingBudget("gemini-2.5-pro-low")).toBe(4096);
  // An explicit caller effort still wins over the in-name marker.
  expect(geminiThinkingBudget("gemini-2.5-pro-high", "low")).toBe(4096);
  // Unmarked thinking-capable ids keep the off-by-default floor (cross-provider parity).
  expect(geminiThinkingBudget("gemini-2.5-flash")).toBe(0);
});

test("geminiRequest: gemini-3 thinking sends thinkingLevel with NO thinkingBudget and no additive bump", () => {
  const messages = [{ role: "user" as const, content: "hi" }];
  const payload = JSON.parse(
    geminiRequest(messages, { model: "gemini-3-pro", reasoningEffort: "high", maxTokens: 4000 } as any, cred, "generateContent").body,
  );
  expect(payload.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
  expect(payload.generationConfig.thinkingConfig.thinkingBudget).toBeUndefined();
  // The additive output bump applies ONLY on the numeric-budget path (gjc parity).
  expect(payload.generationConfig.maxOutputTokens).toBe(4000);
});

test("geminiRequest: a positive numeric budget rides on top of maxOutputTokens (capped at 65536)", () => {
  const messages = [{ role: "user" as const, content: "hi" }];
  const payload = JSON.parse(
    geminiRequest(messages, { model: "gemini-2.5-flash", reasoningEffort: "medium", maxTokens: 4000 } as any, cred, "generateContent").body,
  );
  // medium (8192) clamps to 4000-1024=2976; the output cap grows by the budget so
  // thinking can't eat the visible answer (gjc stream.ts additive behavior).
  expect(payload.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 2976 });
  expect(payload.generationConfig.maxOutputTokens).toBe(4000 + 2976);
  const capped = JSON.parse(
    geminiRequest(messages, { model: "gemini-2.5-pro", reasoningEffort: "high", maxTokens: 60000 } as any, cred, "generateContent").body,
  );
  expect(capped.generationConfig.maxOutputTokens).toBe(65536); // 60000+16384 hits the cap
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

import { discoverGeminiProjectId } from "../src/auth/flows/google";

test("discoverGeminiProjectId: login-time discovery carries the gemini-cli identity headers", async () => {
  const prevFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    return Response.json({ currentTier: { id: "free-tier" }, cloudaicompanionProject: "gem-proj" });
  }) as any;
  try {
    const id = await discoverGeminiProjectId("tok-gem");
    expect(id).toBe("gem-proj");
    expect(calls[0]!.url).toContain(":loadCodeAssist");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok-gem");
    // gjc google-gemini-cli parity: discovery identifies as gemini-cli.
    expect(headers["User-Agent"]).toContain("GeminiCLI/");
    expect(headers["Client-Metadata"]).toBe("ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI");
  } finally {
    globalThis.fetch = prevFetch;
  }
});