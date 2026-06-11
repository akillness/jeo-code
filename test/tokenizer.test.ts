import { test, expect, beforeEach } from "bun:test";
import { countTokensAccurate, resetTokenizer } from "../src/agent/tokenizer";
import { accurateHistoryTokens } from "../src/agent/compaction";
import type { Message } from "../src/agent/loop";

beforeEach(() => {
  resetTokenizer();
});

// cl100k_base count for this ASCII fixture is exactly 14 (verified with the
// js-tiktoken encoder). ±5% (≈±0.7) means we still expect 14.
const FIXTURE = "The quick brown fox jumps over the lazy dog. Hello, world!";
const EXPECTED_CL100K = 14;

test("countTokensAccurate: within ±5% of known cl100k token count", () => {
  const count = countTokensAccurate(FIXTURE);
  const tolerance = EXPECTED_CL100K * 0.05;
  expect(Math.abs(count - EXPECTED_CL100K)).toBeLessThanOrEqual(tolerance);
});

test("countTokensAccurate: memoization returns identical value on repeat", () => {
  const first = countTokensAccurate(FIXTURE);
  const second = countTokensAccurate(FIXTURE);
  expect(second).toBe(first);
});

test("countTokensAccurate: unknown/garbage model falls back to a positive number", () => {
  const count = countTokensAccurate(FIXTURE, "totally-not-a-real-model-xyz");
  expect(count).toBeGreaterThan(0);
});

test("countTokensAccurate: empty string is zero", () => {
  expect(countTokensAccurate("")).toBe(0);
});

test("accurateHistoryTokens: sums per-message counts", () => {
  const history: Message[] = [
    { role: "user", content: "Hello, world!" },
    { role: "assistant", content: "The quick brown fox jumps over the lazy dog." },
  ];
  const total = accurateHistoryTokens(history);
  const manual = history.reduce(
    (sum, m) => sum + countTokensAccurate(m.role) + countTokensAccurate(m.content) + 1,
    0
  );
  expect(total).toBe(manual);
  // Strictly greater than any single message's content count → genuine sum.
  expect(total).toBeGreaterThan(countTokensAccurate(history[0].content));
});
