import { test, expect } from "bun:test";
import { retryableStream, resolveRetryOptions } from "../src/ai/model-manager";
import { nearestToolName } from "../src/agent/engine";
import { anthropicPayload } from "../src/ai/providers/anthropic";
import { defaultRetryable } from "../src/util/retry";

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
  expect(payload.messages).toEqual([{ role: "user", content: "hi" }]);
});

// --- 823: configurable 429 budget ---

test("resolveRetryOptions: explicit rate-limit overrides win", () => {
  const o = resolveRetryOptions({ rateLimitRetries: 9, rateLimitMinDelayMs: 500 });
  expect(o.rateLimitRetries).toBe(10); // retries + 1 = attempts
  expect(o.rateLimitMinDelayMs).toBe(500);
});

test("resolveRetryOptions: defaults still engage when unset (regression guard)", () => {
  const o = resolveRetryOptions(undefined);
  expect(o.rateLimitRetries).toBe(5);
  expect(o.rateLimitMinDelayMs).toBe(2000);
  expect(o.retries).toBeUndefined();
});
