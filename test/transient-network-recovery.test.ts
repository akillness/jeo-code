import { test, expect, mock } from "bun:test";
import type { Message } from "../src/agent/loop";

// Field bug: OpenAI Codex OAuth SSE streams through chatgpt.com's backend die mid-stream
// after ~20-30min of active traffic with Bun's "The socket connection was closed
// unexpectedly …" (undici ConnectionClosed). `retryableStream` (model-manager.ts)
// deliberately only auto-retries losing the FIRST chunk — once any chunk has streamed to
// the caller it stops, so a drop mid-stream used to propagate straight out of the engine's
// model call and end the turn with a raw "Error: …", even though nothing was committed to
// history (a plain resend is exactly as safe as a fresh call). This suite exercises the
// engine-level transient-network ladder that now recovers from that class of error.
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
  expect(notices.some(n => /connection dropped mid-response/.test(n) && /auto-retry #1/.test(n))).toBe(true);
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
  expect(notices.some(n => /connection dropped mid-response/.test(n))).toBe(false);
  expect(calls).toBeGreaterThanOrEqual(1);
});
