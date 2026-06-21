import { test, expect } from "bun:test";
import { openaiRequest } from "../src/ai/providers/openai";
import { thinkingToReasoningEffort } from "../src/ai/model-manager";
import { retryableStream, resolveRetryOptions } from "../src/ai/model-manager";
import { nearestToolName } from "../src/agent/engine";
import { anthropicPayload, anthropicRequest, totalInputTokens } from "../src/ai/providers/anthropic";
import { defaultRetryable } from "../src/util/retry";

const apiKey = { kind: "api_key" as const, provider: "openai" as const, token: "k" };
const anthropicOauth = { kind: "oauth" as const, provider: "anthropic" as const, token: "tok" };

test("thinkingToReasoningEffort: maps levels to o-series-safe tiers", () => {
  // minimal is a genuine (lightest) reasoning effort — reasoning works at EVERY
  // level (gajae parity), no longer collapsed to low.
  expect(thinkingToReasoningEffort("minimal")).toBe("minimal");
  expect(thinkingToReasoningEffort("low")).toBe("low");
  expect(thinkingToReasoningEffort("medium")).toBe("medium");
  expect(thinkingToReasoningEffort("high")).toBe("high");
  expect(thinkingToReasoningEffort("xhigh")).toBe("high");
  expect(thinkingToReasoningEffort(undefined)).toBeUndefined();
});


test("openaiRequest: reasoning models get reasoning_effort + max_completion_tokens, no temperature", () => {
  const msgs = [{ role: "user" as const, content: "hi" }];
  for (const model of ["o3", "gpt-5.1"]) {
    const { body } = openaiRequest(msgs, { model, maxTokens: 500, reasoningEffort: "high" } as any, apiKey, false);
    const p = JSON.parse(body);
    expect(p.reasoning_effort).toBe("high");
    expect(p.max_completion_tokens).toBe(500);
    expect(p.temperature).toBeUndefined();
    expect(p.max_tokens).toBeUndefined();
  }
});

test("openaiRequest: classic chat models keep temperature + max_tokens, no reasoning_effort", () => {
  const { body } = openaiRequest([{ role: "user" as const, content: "hi" }], { model: "gpt-4o", maxTokens: 500, reasoningEffort: "high" } as any, apiKey, false);
  const p = JSON.parse(body);
  expect(p.max_tokens).toBe(500);
  expect(p.temperature).toBe(0.2);
  expect(p.reasoning_effort).toBeUndefined();
  expect(p.max_completion_tokens).toBeUndefined();
});

// --- 820: stream initial-connect retry ---

function iterFromChunks(chunks: string[]): AsyncIterator<string> {
  let i = 0;
  return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined as any, done: true }) };
}

test("retryableStream: retries the initial connection, then streams all chunks", async () => {
  let calls = 0;
  const makeIter = () => {
    calls++;
    if (calls === 1) return { next: async () => { throw { status: 429, message: "rate limit" }; } } as AsyncIterator<string>;
    return iterFromChunks(["a", "b", "c"]);
  };
  const out: string[] = [];
  for await (const chunk of retryableStream(makeIter, { retries: 1, rateLimitRetries: 3, baseDelayMs: 1, sleep: async () => {}, isRetryable: defaultRetryable })) {
    out.push(chunk);
  }
  expect(calls).toBe(2); // first connect failed (429), retried once
  expect(out).toEqual(["a", "b", "c"]);
});

test("retryableStream: first connect succeeds → no retry, makeIter called once", async () => {
  let calls = 0;
  const makeIter = () => { calls++; return iterFromChunks(["x", "y"]); };
  const out: string[] = [];
  for await (const c of retryableStream(makeIter, { retries: 3, baseDelayMs: 1, sleep: async () => {}, isRetryable: defaultRetryable })) out.push(c);
  expect(calls).toBe(1);
  expect(out).toEqual(["x", "y"]);
});

test("retryableStream: per-chunk idle timeout aborts a stalled stream (long-but-silent)", async () => {
  let idled = false;
  const makeIter = (): AsyncIterator<string> => {
    let i = 0;
    return {
      next: async () => {
        if (i++ === 0) return { value: "a", done: false };
        return new Promise<IteratorResult<string>>(() => {}); // hang forever on the 2nd chunk
      },
    };
  };
  const out: string[] = [];
  await expect((async () => {
    for await (const c of retryableStream(makeIter, { retries: 1, baseDelayMs: 1, sleep: async () => {}, isRetryable: defaultRetryable }, { idleMs: 20, onIdle: () => { idled = true; } })) out.push(c);
  })()).rejects.toThrow("stream idle");
  expect(out).toEqual(["a"]); // first chunk emitted, then stalled
  expect(idled).toBe(true);
});

test("retryableStream: reasoning activity (lastActivityAt) keeps a silent-but-thinking stream alive", async () => {
  // The 2nd chunk takes 80ms — far beyond idleMs:20 — but reasoning deltas keep bumping
  // lastActivityAt every 5ms, so the watchdog re-arms instead of aborting.
  let idled = false;
  let lastActivityAt = Date.now();
  const ticker = setInterval(() => { lastActivityAt = Date.now(); }, 5);
  const makeIter = (): AsyncIterator<string> => {
    let i = 0;
    return {
      next: async () => {
        if (i++ === 0) return { value: "a", done: false };
        if (i === 2) { await new Promise(r => setTimeout(r, 80)); return { value: "b", done: false }; }
        return { value: undefined as any, done: true };
      },
    };
  };
  const out: string[] = [];
  try {
    for await (const c of retryableStream(makeIter, { retries: 1, baseDelayMs: 1, sleep: async () => {}, isRetryable: defaultRetryable }, { idleMs: 20, lastActivityAt: () => lastActivityAt, onIdle: () => { idled = true; } })) out.push(c);
  } finally {
    clearInterval(ticker);
  }
  expect(out).toEqual(["a", "b"]);
  expect(idled).toBe(false);
});

test("retryableStream: idle watchdog still fires once reasoning activity STOPS", async () => {
  // Activity stops 10ms in; with idleMs:20 the watchdog must abort the silent stream.
  let idled = false;
  const frozenActivity = Date.now();
  const makeIter = (): AsyncIterator<string> => {
    let i = 0;
    return {
      next: async () => {
        if (i++ === 0) return { value: "a", done: false };
        return new Promise<IteratorResult<string>>(() => {}); // hang forever
      },
    };
  };
  const out: string[] = [];
  await expect((async () => {
    for await (const c of retryableStream(makeIter, { retries: 1, baseDelayMs: 1, sleep: async () => {}, isRetryable: defaultRetryable }, { idleMs: 20, lastActivityAt: () => frozenActivity, onIdle: () => { idled = true; } })) out.push(c);
  })()).rejects.toThrow("stream idle");
  expect(idled).toBe(true);
});

test("retryableStream: idle timeout does NOT fire when chunks arrive promptly", async () => {
  const out: string[] = [];
  for await (const c of retryableStream(() => iterFromChunks(["a", "b"]), { retries: 1, baseDelayMs: 1, sleep: async () => {}, isRetryable: defaultRetryable }, { idleMs: 1000, onIdle: () => { throw new Error("should not idle"); } })) out.push(c);
  expect(out).toEqual(["a", "b"]);
});

test("retryableStream: empty iterator (first.done) yields nothing and completes", async () => {
  const makeIter = (): AsyncIterator<string> => ({ next: async () => ({ value: undefined as any, done: true }) });
  const out: string[] = [];
  for await (const c of retryableStream(makeIter, { retries: 3, baseDelayMs: 1, sleep: async () => {}, isRetryable: defaultRetryable })) out.push(c);
  expect(out).toEqual([]);
});

test("resolveRetryOptions: requestMaxRetries:0 also disables the 429 safety net", () => {
  expect(resolveRetryOptions({ requestMaxRetries: 0 }).rateLimitRetries).toBe(1);
});

test("anthropicPayload: no system prompt → no system field (avoids a 400)", () => {
  const payload = JSON.parse(anthropicPayload([{ role: "user" as const, content: "hi" }], { model: "claude-x", maxTokens: 50 } as any, false, true));
  expect(payload.system).toBeUndefined();
});

test("anthropicPayload: strips the anthropic/ prefix from the model id", () => {
  const payload = JSON.parse(anthropicPayload([{ role: "user" as const, content: "hi" }], { model: "anthropic/claude-sonnet-4-5", maxTokens: 50 } as any, false, true));
  expect(payload.model).toBe("claude-sonnet-4-5");
});

test("totalInputTokens: sums uncached + cache-read + cache-creation input tokens", () => {
  expect(totalInputTokens({ input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5 })).toBe(105);
  expect(totalInputTokens({ input_tokens: 7 })).toBe(7);
  expect(totalInputTokens({})).toBe(0);
});
test("retryableStream: a failure AFTER the first chunk propagates (no duplicate output)", async () => {
  const makeIter = (): AsyncIterator<string> => {
    let i = 0;
    return { next: async () => { if (i++ === 0) return { value: "a", done: false }; throw new Error("mid-stream boom"); } };
  };
  const out: string[] = [];
  await expect((async () => {
    for await (const chunk of retryableStream(makeIter, { retries: 3, baseDelayMs: 1, sleep: async () => {}, isRetryable: defaultRetryable })) {
      out.push(chunk);
    }
  })()).rejects.toThrow("mid-stream boom");
  expect(out).toEqual(["a"]); // first chunk emitted exactly once, not retried
});

// --- 822: nearest tool name ("did you mean") ---

test("nearestToolName: suggests the closest tool within edit distance 2", () => {
  const tools = ["read", "write", "edit", "bash", "find", "search", "ls"];
  expect(nearestToolName("reat", tools)).toBe("read");
  expect(nearestToolName("serch", tools)).toBe("search");
  expect(nearestToolName("read", tools)).toBe("read"); // exact
  expect(nearestToolName("grep", tools)).toBeUndefined(); // too far
  expect(nearestToolName("", tools)).toBeUndefined();
});

// --- 821: anthropic prompt caching ---

test("anthropicPayload: marks the system prompt cache_control:ephemeral and drops the system message", () => {
  const messages = [
    { role: "system" as const, content: "SYS" },
    { role: "user" as const, content: "hi" },
  ];
  const payload = JSON.parse(anthropicPayload(messages, { model: "claude-sonnet-4-5", maxTokens: 100, temperature: 0.2 } as any, false, true));
  expect(Array.isArray(payload.system)).toBe(true);
  expect(payload.system[0].cache_control).toEqual({ type: "ephemeral" });
  expect(payload.system[0].text).toBe("SYS");
  // system role is not duplicated into messages
  // system role is not duplicated into messages; the LAST message carries the
  // conversation prompt-cache breakpoint (block form).
  expect(payload.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
  ]);
});

test("anthropicPayload: OAuth calls include Claude Code prelude before the real system prompt", () => {
  const payload = JSON.parse(anthropicPayload(
    [
      { role: "system" as const, content: "SYS" },
      { role: "user" as const, content: "hi" },
    ],
    { model: "claude-sonnet-4-5", maxTokens: 100 } as any,
    false,
    true,
    anthropicOauth,
  ));
  expect(payload.system).toHaveLength(3);
  expect(payload.system[0].text).toStartWith("x-anthropic-billing-header: cc_version=2.1.63.");
  expect(payload.system[0].cache_control).toBeUndefined();
  expect(payload.system[1]).toEqual({ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." });
  expect(payload.system[2]).toEqual({ type: "text", text: "SYS", cache_control: { type: "ephemeral" } });
  expect(payload.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
  ]);
  expect(payload.metadata?.user_id).toMatch(/^user_[0-9a-f]{64}_account_[0-9a-f-]{36}_session_[0-9a-f-]{36}$/);
});

test("anthropicPayload: OAuth calls without a user system prompt still include the Claude Code prelude", () => {
  const payload = JSON.parse(anthropicPayload(
    [{ role: "user" as const, content: "hi" }],
    { model: "claude-sonnet-4-5", maxTokens: 100 } as any,
    false,
    true,
    anthropicOauth,
  ));
  expect(payload.system).toHaveLength(2);
  expect(payload.system[0].text).toStartWith("x-anthropic-billing-header:");
  expect(payload.system[1]).toEqual({
    type: "text",
    text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    cache_control: { type: "ephemeral" },
  });
  expect(payload.metadata?.user_id).toMatch(/^user_[0-9a-f]{64}_account_[0-9a-f-]{36}_session_[0-9a-f-]{36}$/);
});

test("anthropicRequest: OAuth headers use Claude Code-compatible Anthropic beta set", () => {
  const { headers } = anthropicRequest(
    [{ role: "user" as const, content: "hi" }],
    { model: "claude-sonnet-4-5", maxTokens: 100 } as any,
    anthropicOauth,
    true,
    true,
  );
  expect(headers.authorization).toBe("Bearer tok");
  expect(headers.accept).toBe("text/event-stream");
  expect(headers["anthropic-beta"]).toContain("claude-code-20250219");
  expect(headers["anthropic-beta"]).toContain("oauth-2025-04-20");
  expect(headers["anthropic-beta"]).toContain("prompt-caching-scope-2026-01-05");
  expect(headers["user-agent"]).toBe("claude-cli/2.1.63 (external, cli)");
  expect(headers["x-stainless-runtime"]).toBe("node");
});

// --- 823: configurable 429 budget ---

test("resolveRetryOptions: explicit rate-limit overrides win", () => {
  const o = resolveRetryOptions({ rateLimitRetries: 9, rateLimitMinDelayMs: 500 });
  expect(o.rateLimitRetries).toBe(10); // retries + 1 = attempts
  expect(o.rateLimitMinDelayMs).toBe(500);
});

test("resolveRetryOptions: defaults still engage when unset (regression guard)", () => {
  const o = resolveRetryOptions(undefined);
  expect(o.rateLimitRetries).toBe(6);
  expect(o.rateLimitMinDelayMs).toBe(2000);
  expect(o.rateLimitMaxServerDelayMs).toBe(5 * 60 * 1000);
  expect(o.retries).toBeUndefined();
});

test("retryableStream: overall deadline aborts a slow-drip stream the idle cap never catches (round-14)", async () => {
  // One chunk every ~5ms — always inside a generous idleMs, so per-chunk idle
  // alone would run this forever. The OVERALL deadline must end it.
  let aborted = false;
  const makeIter = (): AsyncIterator<string> => ({
    next: () => new Promise(resolve => setTimeout(() => resolve({ value: "tok", done: false }), 5)),
  });
  const out: string[] = [];
  await expect((async () => {
    for await (const c of retryableStream(
      makeIter,
      { retries: 1, baseDelayMs: 1, sleep: async () => {}, isRetryable: defaultRetryable },
      { idleMs: 1000, deadlineAt: Date.now() + 40, onIdle: () => { aborted = true; } },
    )) out.push(c);
  })()).rejects.toThrow("overall deadline");
  expect(out.length).toBeGreaterThan(0); // it WAS dripping
  expect(aborted).toBe(true);
});

test("retryableStream: a generous deadline does not disturb a healthy stream", async () => {
  const out: string[] = [];
  for await (const c of retryableStream(
    () => iterFromChunks(["a", "b", "c"]),
    { retries: 1, baseDelayMs: 1, sleep: async () => {}, isRetryable: defaultRetryable },
    { idleMs: 1000, deadlineAt: Date.now() + 60_000 },
  )) out.push(c);
  expect(out).toEqual(["a", "b", "c"]);
});

test("streamMaxMs: env opt-in parsing — off by default, positive ints only", async () => {
  const { streamMaxMs } = await import("../src/ai/model-manager");
  expect(streamMaxMs({})).toBeUndefined(); // default OFF
  expect(streamMaxMs({ JEO_STREAM_MAX_MS: "30000" })).toBe(30000);
  expect(streamMaxMs({ JEO_STREAM_MAX_MS: "5000" })).toBe(5000); // legacy prefix
  expect(streamMaxMs({ JEO_STREAM_MAX_MS: "0" })).toBeUndefined();
  expect(streamMaxMs({ JEO_STREAM_MAX_MS: "nope" })).toBeUndefined();
});

test("streamIdleMs: env opt-in parsing — built-in default, positive int override only", async () => {
  const { streamIdleMs } = await import("../src/ai/model-manager");
  expect(streamIdleMs({})).toBe(120_000); // built-in default
  expect(streamIdleMs({ JEO_STREAM_IDLE_MS: "300000" })).toBe(300000);
  expect(streamIdleMs({ JEO_STREAM_IDLE_MS: "0" })).toBe(120_000); // non-positive → default
  expect(streamIdleMs({ JEO_STREAM_IDLE_MS: "nope" })).toBe(120_000);
});

test("defaultRetryable: a per-chunk stream-idle stall is retryable, the overall deadline is not", () => {
  // The idle watchdog's message must be classified retryable so a transient stall
  // on the INITIAL connection auto-reconnects instead of hard-failing the turn.
  expect(defaultRetryable(new Error("stream idle for 120000ms (no chunk) — provider sent no token"))).toBe(true);
  expect(defaultRetryable(new Error("stream exceeded the overall deadline (JEO_STREAM_MAX_MS) — slow-drip stream aborted"))).toBe(false);
});
