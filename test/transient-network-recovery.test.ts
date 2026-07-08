import { test, expect, mock } from "bun:test";
import type { Message } from "../src/agent/loop";
import { ProviderStreamError } from "../src/ai/providers/errors";

// Field bug: OpenAI Codex OAuth SSE streams through chatgpt.com's backend die mid-stream
// after ~20-30min of active traffic with Bun's "The socket connection was closed
// unexpectedly …" (undici ConnectionClosed). `retryableStream` (model-manager.ts)
// deliberately only auto-retries losing the FIRST chunk — once any chunk has streamed to
// the caller it stops, so a drop mid-stream used to propagate straight out of the engine's
// model call and end the turn with a raw "Error: …", even though nothing was committed to
// history (a plain resend is exactly as safe as a fresh call). This suite exercises the
// engine-level transient-network ladder that now recovers from that class of error, AND
// (round: in-band SSE error retry fix) a structurally identical class — the OpenAI
// Responses backend emitting an in-band `response.failed`/`error` SSE EVENT (HTTP 200,
// `ProviderStreamError` from ai/providers/errors.ts) instead of a socket death. Both share
// the same recovery: `retryableStream` cannot retry past the first streamed chunk, so a
// fault surfacing here never got a model-manager retry and needs this ladder.
const socketDrop = () => new Error("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()");

test("transient-network ladder: a mid-stream socket drop resends the same step and recovers", async () => {
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      calls++;
      if (calls === 1) throw socketDrop();
      return JSON.stringify({ tool: "done", arguments: { reason: "recovered after socket drop" } });
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
  expect(result.doneReason).toBe("recovered after socket drop");
  expect(calls).toBe(2); // drop + free resend
  expect(notices.some(n => /mid-response provider fault/.test(n) && /auto-retry #1/.test(n))).toBe(true);
});

test("transient-network ladder: exhausting the bounded retry budget surfaces a terminal error, not an infinite spin", async () => {
  process.env.JEO_TRANSIENT_NETWORK_BACKOFF_BASE_MS = "1"; // keep the test fast
  try {
    let calls = 0;
    await mock.module("../src/agent/loop", () => ({
      callLlm: async () => {
        calls++;
        throw socketDrop(); // never clears
      },
    }));
    const { runAgentLoop } = await import("../src/agent/engine");
    const history: Message[] = [
      { role: "system", content: "Core instructions only." },
      { role: "user", content: "init" },
    ];
    const result = await runAgentLoop(history, { cwd: process.cwd(), maxSteps: 20, budget: { maxExtensions: 0 }, tools: {} });
    expect(result.done).toBe(false);
    expect(result.doneReason).toContain("Error:");
    expect(calls).toBe(6); // MAX_TRANSIENT_NETWORK_RETRIES (5) + the final failing attempt
  } finally {
    delete process.env.JEO_TRANSIENT_NETWORK_BACKOFF_BASE_MS;
  }
});

test("transient-network ladder: Esc/cancel aborts the backoff wait and the turn ends as Cancelled", async () => {
  process.env.JEO_TRANSIENT_NETWORK_BACKOFF_BASE_MS = "60000"; // a wait the test must be able to escape
  try {
    let calls = 0;
    await mock.module("../src/agent/loop", () => ({
      callLlm: async () => {
        calls++;
        throw socketDrop();
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
      events: { onNotice: m => { if (/auto-retry #1/.test(m)) controller.abort(); } },
    });
    expect(result.done).toBe(false);
    expect(result.doneReason).toBe("Cancelled.");
    expect(calls).toBe(1); // the wait was aborted before a 2nd call
  } finally {
    delete process.env.JEO_TRANSIENT_NETWORK_BACKOFF_BASE_MS;
  }
});

test("transient-network ladder: does not swallow a deterministic refusal (refusal ladder still owns that class)", async () => {
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      calls++;
      throw new Error("Anthropic returned no content (stop_reason=refusal).");
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const controller = new AbortController();
  const notices: string[] = [];
  const history: Message[] = [
    { role: "system", content: "Core instructions only." },
    { role: "user", content: "init" },
  ];
  // The refusal never clears, so rung 4's backoff would otherwise spin — abort on the
  // first refusal-ladder notice (mirrors the refusal-recovery.test.ts cancel pattern).
  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 10,
    budget: { maxExtensions: 0 },
    tools: {},
    signal: controller.signal,
    events: { onNotice: m => { notices.push(m); if (/provider refused/.test(m)) controller.abort(); } },
  });
  expect(result.done).toBe(false);
  expect(result.doneReason).toBe("Cancelled.");
  // Only the refusal-specific notices fire ("provider refused…"); the transient-network
  // ladder's notice never fires — `defaultRetryable` fails fast on a refusal shape.
  expect(notices.some(n => /provider refused/.test(n))).toBe(true);
  expect(notices.some(n => /mid-response provider fault/.test(n))).toBe(false);
  expect(calls).toBeGreaterThanOrEqual(1);
});

// Round: in-band SSE error retry fix. OpenAI's Responses backend can emit a
// `response.failed`/`error` SSE EVENT on an otherwise-200 stream (documented codes:
// `server_error`, `rate_limit_exceeded` — OpenAI's own guidance is "retry with
// exponential backoff"). `openai-responses.ts` now throws `ProviderStreamError` for
// this (carrying a synthetic .status so `defaultRetryable` catches the pre-first-chunk
// case), but a fault AFTER the first streamed chunk bypasses that entirely and used to
// propagate straight out as a terminal "Error: …", exactly like the socket-drop case
// above. This test exercises the SAME engine-level ladder recovering from it.
test("mid-stream ladder: an in-band ProviderStreamError (OpenAI response.failed) resends the same step and recovers", async () => {
  let calls = 0;
  // mock.module MUST run before engine.ts (and its transitive `./loop` import) is
  // loaded, so `runAgentLoop` is imported dynamically below — a genuine module-loading-
  // order requirement, not a stylistic choice (Bun's mock registry only intercepts
  // modules not yet resolved).
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      calls++;
      if (calls === 1) throw new ProviderStreamError("OpenAI Codex", "the server had an error processing your request", "server_error");
      return JSON.stringify({ tool: "done", arguments: { reason: "recovered after provider stream error" } });
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
  expect(result.doneReason).toBe("recovered after provider stream error");
  expect(calls).toBe(2); // fault + free resend
  expect(notices.some(n => /mid-response provider fault/.test(n) && /auto-retry #1/.test(n))).toBe(true);
});

test("mid-stream ladder: socket drops and ProviderStreamErrors share ONE bounded retry budget, not two", async () => {
  process.env.JEO_TRANSIENT_NETWORK_BACKOFF_BASE_MS = "1"; // keep the test fast (5 real backoff waits otherwise)
  try {
    let calls = 0;
    await mock.module("../src/agent/loop", () => ({
      callLlm: async () => {
        calls++;
        // Alternate failure class every call — both must draw from the SAME counter.
        if (calls % 2 === 1) throw new ProviderStreamError("OpenAI Codex", "the server had an error processing your request", "server_error");
        if (calls <= 5) throw new Error("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()");
        return JSON.stringify({ tool: "done", arguments: { reason: "recovered after mixed faults" } });
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
    expect(result.doneReason).toBe("recovered after mixed faults");
    expect(calls).toBe(6); // 5 alternating faults (within MAX_TRANSIENT_NETWORK_RETRIES=5) + the recovering call
    const retryNumbers = notices
      .map(n => /auto-retry #(\d+)/.exec(n)?.[1])
      .filter((s): s is string => s !== undefined)
      .map(Number);
    expect(retryNumbers).toEqual([1, 2, 3, 4, 5]); // one monotonic counter across both classes
  } finally {
    delete process.env.JEO_TRANSIENT_NETWORK_BACKOFF_BASE_MS;
  }
});

// Round: budget-sharing verification (not just monotonic labeling). A counter that is
// SHARED for the notice label but capped PER-CLASS underneath would still print
// "auto-retry #1..#5" (passing the test above) while secretly giving each failure class
// its OWN budget of MAX_TRANSIENT_NETWORK_RETRIES. This scenario is the one that catches
// that: 3 ProviderStreamErrors + 3 socket drops (6 total, neither class alone reaching 5)
// must still exhaust the SHARED cap of 5 and terminate at the 6th failure — a 7th
// (recovering) call must never be reached.
test("mid-stream ladder: the shared retry budget caps the TOTAL across classes, not each class independently", async () => {
  process.env.JEO_TRANSIENT_NETWORK_BACKOFF_BASE_MS = "1"; // keep the test fast
  try {
    let calls = 0;
    // mock.module MUST run before engine.ts (and its transitive `./loop` import) is
    // loaded, so `runAgentLoop` is imported dynamically below (see the module-loading
    // note on the prior test in this file — same genuine ordering requirement).
    await mock.module("../src/agent/loop", () => ({
      callLlm: async () => {
        calls++;
        // 3 PSE (odd calls 1,3,5) + 3 socket drops (even calls 2,4,6) — 6 failures
        // total, but neither class individually reaches MAX_TRANSIENT_NETWORK_RETRIES
        // (5) on its own. A per-class cap would wrongly retry all 6 and reach call 7;
        // the correct SHARED cap must stop at call 6.
        if (calls <= 6) {
          if (calls % 2 === 1) throw new ProviderStreamError("OpenAI Codex", "the server had an error processing your request", "server_error");
          throw new Error("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()");
        }
        return JSON.stringify({ tool: "done", arguments: { reason: "should never reach a 7th call" } });
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
    // A shared budget of 5 exhausts on the 6th failure — terminal error, never a 7th call.
    expect(result.done).toBe(false);
    expect(result.doneReason).toContain("Error:");
    expect(calls).toBe(6); // exactly MAX_TRANSIENT_NETWORK_RETRIES(5) + the 6th (final, unretried) failure
    const retryNumbers = notices
      .map(n => /auto-retry #(\d+)/.exec(n)?.[1])
      .filter((s): s is string => s !== undefined)
      .map(Number);
    expect(retryNumbers).toEqual([1, 2, 3, 4, 5]); // 5 retries total, shared across both classes
  } finally {
    delete process.env.JEO_TRANSIENT_NETWORK_BACKOFF_BASE_MS;
  }
});
