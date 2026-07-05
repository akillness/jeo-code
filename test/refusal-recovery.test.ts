import { test, expect, mock } from "bun:test";
import { isRefusalError } from "../src/util/retry";
import { friendlyProviderError } from "../src/util/provider-error";
import type { Message } from "../src/agent/loop";

const refusal = () => new Error("Anthropic returned no content (stop_reason=refusal).");

test("refusal ladder stage 3: project-context guidance is stripped from the system prompt, then the turn recovers", async () => {
  let calls = 0;
  let sawStrippedSystem = false;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (history: Message[]) => {
      calls++;
      // Refuse while the system prompt still carries the project-context block —
      // the field case where repo-authored guidance trips the classifier.
      if (history[0]!.content.includes("<project_context>")) throw refusal();
      sawStrippedSystem = true;
      return JSON.stringify({ tool: "done", arguments: { reason: "recovered without guidance" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history: Message[] = [
    { role: "system", content: "Core instructions.\n\n<project_context>\nspicy repo guidance\n</project_context>" },
    { role: "user", content: "init" },
  ];
  const result = await runAgentLoop(history, { cwd: process.cwd(), maxSteps: 10, budget: { maxExtensions: 0 }, tools: {} });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("recovered without guidance");
  expect(sawStrippedSystem).toBe(true);
  expect(history[0]!.content).toBe("Core instructions."); // block removed, core kept
  expect(calls).toBe(4); // refusal x3 (plain, reset, strip applied on 3rd) + success
});

test("refusal ladder stage 2: reasoning artifacts + native tool-use replay are stripped, then the turn recovers", async () => {
  let calls = 0;
  let sawArtifactFreeHistory = false;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (history: Message[]) => {
      calls++;
      // Refuse while ANY assistant turn still carries the native replay channel —
      // the field case (fable-5): replayed thinking blocks re-trip the classifier
      // on every resend, so tool-result eliding alone can never recover.
      const hasArtifacts = history.some(
        m => m.role === "assistant" && ((m.reasoningArtifacts?.length ?? 0) > 0 || (m.toolUse?.length ?? 0) > 0),
      );
      if (hasArtifacts) throw refusal();
      sawArtifactFreeHistory = true;
      return JSON.stringify({ tool: "done", arguments: { reason: "recovered without thinking replay" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history: Message[] = [
    { role: "system", content: "Core instructions only." },
    { role: "user", content: "init" },
    {
      role: "assistant",
      content: '{"tool":"read","arguments":{"filePath":"x"}}',
      reasoning: "displayed thought",
      reasoningArtifacts: [{ provider: "anthropic", model: "claude-fable-5", text: "flagged thought", signature: "sig" }],
      toolUse: [{ id: "tu_1", tool: "read", arguments: { filePath: "x" } }],
    },
    { role: "user", content: "Tool [read] result (ok): file body" },
  ];
  const result = await runAgentLoop(history, { cwd: process.cwd(), maxSteps: 10, budget: { maxExtensions: 0 }, tools: {} });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("recovered without thinking replay");
  expect(sawArtifactFreeHistory).toBe(true);
  // Stage 2 (the 2nd refusal) strips the replay channel → the 3rd call succeeds.
  expect(calls).toBe(3);
  const assistant = history.find(m => m.role === "assistant")!;
  expect(assistant.reasoningArtifacts).toBeUndefined();
  expect(assistant.toolUse).toBeUndefined();
  expect(assistant.reasoning).toBe("displayed thought"); // display channel survives
});

test("refusal rung 4: with nothing left to strip, the loop backoff-resends instead of surfacing an error, then recovers", async () => {
  // gjc parity: a refusal is never a terminal turn error — after the context-mutating
  // ladder is exhausted the loop keeps resending with capped exponential backoff.
  process.env.JEO_REFUSAL_BACKOFF_BASE_MS = "1"; // keep the test fast
  try {
    let calls = 0;
    await mock.module("../src/agent/loop", () => ({
      callLlm: async () => {
        calls++;
        // Refuse through the whole ladder (plain resend, context reset, no
        // project-context to strip) AND two backoff attempts before clearing.
        if (calls <= 5) throw refusal();
        return JSON.stringify({ tool: "done", arguments: { reason: "recovered after backoff" } });
      },
    }));
    const { runAgentLoop } = await import("../src/agent/engine");
    const history: Message[] = [
      { role: "system", content: "Core instructions only." },
      { role: "user", content: "init" },
    ];
    const result = await runAgentLoop(history, { cwd: process.cwd(), maxSteps: 10, budget: { maxExtensions: 0 }, tools: {} });
    expect(result.done).toBe(true);
    expect(result.doneReason).toBe("recovered after backoff");
    expect(calls).toBe(6); // plain resend + post-reset retry + 3 backoff resends + success
  } finally {
    delete process.env.JEO_REFUSAL_BACKOFF_BASE_MS;
  }
});

test("refusal rung 4: Esc/cancel aborts the backoff wait and the turn ends as Cancelled, not as a refusal error", async () => {
  process.env.JEO_REFUSAL_BACKOFF_BASE_MS = "60000"; // a wait the test must be able to escape
  try {
    let calls = 0;
    await mock.module("../src/agent/loop", () => ({
      callLlm: async () => {
        calls++;
        throw refusal();
      },
    }));
    const { runAgentLoop } = await import("../src/agent/engine");
    const controller = new AbortController();
    const history: Message[] = [
      { role: "system", content: "Core instructions only." },
      { role: "user", content: "init" },
    ];
    const result = await runAgentLoop(history, {
      cwd: process.cwd(),
      maxSteps: 10,
      budget: { maxExtensions: 0 },
      tools: {},
      signal: controller.signal,
      // The backoff notice fires right before the wait — aborting there proves the
      // wait resolves early and the loop-top cancellation check owns the exit.
      events: { onNotice: m => { if (/auto-retry #1/.test(m)) controller.abort(); } },
    });
    expect(result.done).toBe(false);
    expect(result.doneReason).toBe("Cancelled.");
    expect(result.doneReason).not.toContain("declined to answer");
    expect(calls).toBe(3); // ladder burned (resend + reset), backoff wait aborted before a 4th call
  } finally {
    delete process.env.JEO_REFUSAL_BACKOFF_BASE_MS;
  }
});
test("isRefusalError recognizes the new 'Refusal (<category>)' shape (Claude Fable 5 reasoning_extraction, and future categories)", () => {
  expect(isRefusalError(new Error("Refusal (reasoning_extraction): This request was blocked as it seems to violate Anthropic's Terms of Service."))).toBe(true);
  expect(isRefusalError(new Error("Refusal (some_future_category): blocked for an unrelated reason."))).toBe(true);
});

test("isRefusalError regression guard: still matches every pre-existing refusal shape", () => {
  expect(isRefusalError(new Error("Anthropic returned no content (stop_reason=refusal)."))).toBe(true);
  expect(isRefusalError(new Error("OpenAI stopped early (finish_reason=content_filter)."))).toBe(true);
  // Real production shape (gemini.ts's blockedReason()): the enum is always prefixed
  // with blockReason=/finishReason=, never bare "(SAFETY)" — these fixtures used to be
  // hand-written literals that never matched blockedReason()'s actual output, masking
  // the fact that the bare-parenthesized regex could never match production Gemini errors.
  expect(isRefusalError(new Error("Gemini returned no content (finishReason=SAFETY)."))).toBe(true);
  expect(isRefusalError(new Error("Gemini returned no content (blockReason=SAFETY)."))).toBe(true);
  expect(isRefusalError(new Error("Gemini returned no content (finishReason=PROHIBITED_CONTENT)."))).toBe(true);
  expect(isRefusalError(new Error("Gemini returned no content (finishReason=BLOCKLIST)."))).toBe(true);
  expect(isRefusalError(new Error("Gemini returned no content (finishReason=RECITATION)."))).toBe(true);
  expect(isRefusalError(new Error("Gemini returned no content (finishReason=SPII)."))).toBe(true);
  expect(isRefusalError(new Error("Gemini (Cloud Code Assist) returned no content (blockReason=PROHIBITED_CONTENT)."))).toBe(true);
});

test("isRefusalError: no false positive on an unrelated error message", () => {
  expect(isRefusalError(new Error("connect ECONNRESET 127.0.0.1:443"))).toBe(false);
});

test("friendlyProviderError: reasoning_extraction gets the base refusal message plus a clarifying note; other categories do not", () => {
  const reasoningExtraction = friendlyProviderError(
    new Error("Refusal (reasoning_extraction): This request was blocked as it seems to violate Anthropic's Terms of Service."),
  );
  expect(reasoningExtraction).toContain("declined to answer (safety refusal — no content returned)");
  expect(reasoningExtraction).toContain("reasoning_extraction");
  expect(reasoningExtraction).toContain("not an actual violation");

  const plainRefusal = friendlyProviderError(new Error("Anthropic returned no content (stop_reason=refusal)."));
  expect(plainRefusal).toContain("declined to answer (safety refusal — no content returned)");
  expect(plainRefusal).not.toContain("reasoning_extraction");

  // Defensive: a category delivered via `category=<X>` (Finding 5 — Anthropic's
  // stop_details.category folded into a 200-body/stream empty-completion message)
  // gets the same category-aware clarifying note as the `Refusal (<X>)` HTTP-error shape.
  const categoryForm = friendlyProviderError(
    new Error("Anthropic returned no content (stop_reason=refusal, category=reasoning_extraction)."),
  );
  expect(categoryForm).toContain("declined to answer (safety refusal — no content returned)");
  expect(categoryForm).toContain("reasoning_extraction");
  expect(categoryForm).toContain("not an actual violation");
});

test("refusal ladder engages for the new reasoning_extraction category: free resend recovers on first occurrence", async () => {
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      calls++;
      if (calls === 1) throw new Error("Refusal (reasoning_extraction): This request was blocked as it seems to violate Anthropic's Terms of Service.");
      return JSON.stringify({ tool: "done", arguments: { reason: "recovered from reasoning_extraction refusal" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history: Message[] = [
    { role: "system", content: "Core instructions only." },
    { role: "user", content: "init" },
  ];
  const result = await runAgentLoop(history, { cwd: process.cwd(), maxSteps: 10, budget: { maxExtensions: 0 }, tools: {} });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("recovered from reasoning_extraction refusal");
  expect(calls).toBe(2); // free resend on first occurrence + success
});

test("refusal rung 4: a category-shaped 'Refusal (<category>)' error fails fast with the friendly message instead of entering backoff", async () => {
  // Deterministic ToS-category refusal (Anthropic's own doc: a classification of the
  // REQUEST CONTENT ITSELF) — by rung 4 context is already minimized, so backoff-resending
  // it forever cannot help. It should fail the turn immediately with the category-aware
  // friendlyProviderError message instead of spinning the unbounded backoff.
  let calls = 0;
  const categoryRefusal = () =>
    new Error("Refusal (reasoning_extraction): This request was blocked as it seems to violate Anthropic's Terms of Service.");
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      calls++;
      throw categoryRefusal();
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const notices: string[] = [];
  const history: Message[] = [
    { role: "system", content: "Core instructions only." }, // no <project_context> — rung 3 is a no-op
    { role: "user", content: "init" },
  ];
  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 10,
    budget: { maxExtensions: 0 },
    tools: {},
    events: { onNotice: m => notices.push(m) },
  });
  expect(result.done).toBe(false);
  expect(result.doneReason).toContain("declined to answer (safety refusal — no content returned)");
  expect(result.doneReason).toContain("reasoning_extraction");
  expect(result.doneReason).toContain("not an actual violation");
  // Rung 1 (free resend) + rung 2 (context reset) + rung 3/4 catch (fails fast, no backoff resend).
  expect(calls).toBe(3);
  expect(notices.some(n => /auto-retry/.test(n))).toBe(false); // never entered the backoff loop
});

test("refusal rung 4 regression guard: a plain (non-category) refusal still enters the unbounded backoff loop, not the fast-fail path", async () => {
  process.env.JEO_REFUSAL_BACKOFF_BASE_MS = "1"; // keep the test fast
  try {
    let calls = 0;
    await mock.module("../src/agent/loop", () => ({
      callLlm: async () => {
        calls++;
        // Gemini's real production shape (Finding 1) — no "Refusal (<category>)" structural
        // marker, so the rolling-classifier-clears-eventually rationale still applies.
        if (calls <= 4) throw new Error("Gemini returned no content (finishReason=SAFETY).");
        return JSON.stringify({ tool: "done", arguments: { reason: "recovered after backoff" } });
      },
    }));
    const { runAgentLoop } = await import("../src/agent/engine");
    const notices: string[] = [];
    const history: Message[] = [
      { role: "system", content: "Core instructions only." },
      { role: "user", content: "init" },
    ];
    const result = await runAgentLoop(history, {
      cwd: process.cwd(),
      maxSteps: 10,
      budget: { maxExtensions: 0 },
      tools: {},
      events: { onNotice: m => notices.push(m) },
    });
    expect(result.done).toBe(true);
    expect(result.doneReason).toBe("recovered after backoff");
    expect(calls).toBe(5); // plain resend + post-reset retry + 2 backoff resends + success
    expect(notices.some(n => /auto-retry/.test(n))).toBe(true); // DID enter the backoff loop
  } finally {
    delete process.env.JEO_REFUSAL_BACKOFF_BASE_MS;
  }
});

test("refusal rung 4: the backoff notice omits '(Esc to cancel)' for a non-interactive caller (no onModelStream attached)", async () => {
  process.env.JEO_REFUSAL_BACKOFF_BASE_MS = "1";
  try {
    let calls = 0;
    await mock.module("../src/agent/loop", () => ({
      callLlm: async () => {
        calls++;
        if (calls <= 4) throw new Error("Gemini returned no content (finishReason=SAFETY).");
        return JSON.stringify({ tool: "done", arguments: { reason: "recovered after backoff" } });
      },
    }));
    const { runAgentLoop } = await import("../src/agent/engine");
    const notices: string[] = [];
    const history: Message[] = [
      { role: "system", content: "Core instructions only." },
      { role: "user", content: "init" },
    ];
    // No onModelStream (== non-interactive, e.g. `jeo team`) — only onNotice attached.
    await runAgentLoop(history, {
      cwd: process.cwd(),
      maxSteps: 10,
      budget: { maxExtensions: 0 },
      tools: {},
      events: { onNotice: m => notices.push(m) },
    });
    const backoffNotices = notices.filter(n => /auto-retry/.test(n));
    expect(backoffNotices.length).toBeGreaterThan(0);
    expect(backoffNotices.every(n => !n.includes("Esc to cancel"))).toBe(true);
  } finally {
    delete process.env.JEO_REFUSAL_BACKOFF_BASE_MS;
  }
});

test("refusal rung 4: the backoff notice keeps '(Esc to cancel)' for an interactive caller (onModelStream attached)", async () => {
  process.env.JEO_REFUSAL_BACKOFF_BASE_MS = "1";
  try {
    let calls = 0;
    await mock.module("../src/agent/loop", () => ({
      callLlm: async () => {
        calls++;
        if (calls <= 4) throw new Error("Gemini returned no content (finishReason=SAFETY).");
        return JSON.stringify({ tool: "done", arguments: { reason: "recovered after backoff" } });
      },
    }));
    const { runAgentLoop } = await import("../src/agent/engine");
    const notices: string[] = [];
    const history: Message[] = [
      { role: "system", content: "Core instructions only." },
      { role: "user", content: "init" },
    ];
    await runAgentLoop(history, {
      cwd: process.cwd(),
      maxSteps: 10,
      budget: { maxExtensions: 0 },
      tools: {},
      events: { onNotice: m => notices.push(m), onModelStream: () => {} },
    });
    const backoffNotices = notices.filter(n => /auto-retry/.test(n));
    expect(backoffNotices.length).toBeGreaterThan(0);
    expect(backoffNotices.every(n => n.includes("Esc to cancel"))).toBe(true);
  } finally {
    delete process.env.JEO_REFUSAL_BACKOFF_BASE_MS;
  }
});
