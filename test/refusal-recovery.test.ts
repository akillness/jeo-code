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
  expect(isRefusalError(new Error("Gemini blocked the response (SAFETY)."))).toBe(true);
  expect(isRefusalError(new Error("Gemini blocked the response (PROHIBITED_CONTENT)."))).toBe(true);
  expect(isRefusalError(new Error("Gemini blocked the response (BLOCKLIST)."))).toBe(true);
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
