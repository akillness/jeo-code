import { test, expect } from "bun:test";
import { accurateHistoryTokens, accurateMessageTokens } from "../src/agent/compaction";
import { countTokensAccurate, encodingFamilyForModel, resetTokenizer } from "../src/agent/tokenizer";
import type { Message } from "../src/agent/loop";

// Ralph-subagent latency regression guard: `maybeCompact` runs on EVERY step of
// the team/ralph loop, so `accurateHistoryTokens` must be O(new messages), not a
// full-history BPE re-encode. These tests pin the cache contract (identity-keyed,
// encoder-family-partitioned, replacement-safe) that makes that true.

test("accurateMessageTokens matches the direct per-message computation", () => {
  const msg: Message = { role: "user", content: "작업내용 확인해줘 — verify the work and report" };
  const expected =
    countTokensAccurate("user", "claude-sonnet-4-5") +
    countTokensAccurate(msg.content, "claude-sonnet-4-5") +
    1;
  expect(accurateMessageTokens(msg, "claude-sonnet-4-5")).toBe(expected);
  // Cached second call returns the identical value.
  expect(accurateMessageTokens(msg, "claude-sonnet-4-5")).toBe(expected);
});

test("accurate cache is partitioned by tokenizer family (no cross-model bleed)", () => {
  expect(encodingFamilyForModel("gpt-4o")).toBe("o200k_base");
  expect(encodingFamilyForModel("claude-sonnet-4-5")).toBe("cl100k_base");
  const msg: Message = { role: "user", content: "한국어와 English가 섞인 메시지입니다 — token counts differ per encoder." };
  const claude = accurateMessageTokens(msg, "claude-sonnet-4-5");
  const gpt = accurateMessageTokens(msg, "gpt-4o");
  // Each family's cached value must equal its own direct computation, even after
  // the other family populated the same message's cache slot.
  expect(claude).toBe(countTokensAccurate("user", "claude-sonnet-4-5") + countTokensAccurate(msg.content, "claude-sonnet-4-5") + 1);
  expect(gpt).toBe(countTokensAccurate("user", "gpt-4o") + countTokensAccurate(msg.content, "gpt-4o") + 1);
});

test("accurateHistoryTokens: repeated calls over a growing history stay consistent", () => {
  const history: Message[] = [{ role: "system", content: "You are an executor subagent." }];
  let prev = accurateHistoryTokens(history, "claude-sonnet-4-5");
  for (let step = 0; step < 5; step++) {
    history.push({ role: "assistant", content: `{"tool":"read","arguments":{"filePath":"src/f${step}.ts"}}` });
    history.push({ role: "user", content: `Tool [read] result (ok):\n${"line of output ".repeat(40)}` });
    const next = accurateHistoryTokens(history, "claude-sonnet-4-5");
    expect(next).toBeGreaterThan(prev); // strictly grows as messages append
    expect(accurateHistoryTokens(history, "claude-sonnet-4-5")).toBe(next); // pure cache pass
    prev = next;
  }
});

test("images add the per-image estimate on top of the text count", () => {
  const noImg: Message = { role: "user", content: "see attached" };
  const withImg: Message = { role: "user", content: "see attached", images: [{ mediaType: "image/png", data: "aGk=" }] };
  expect(accurateMessageTokens(withImg, "claude-sonnet-4-5")).toBe(accurateMessageTokens(noImg, "claude-sonnet-4-5") + 1100);
});

test("countTokensAccurate stays consistent for huge texts (memo-skip path)", () => {
  resetTokenizer();
  // > MEMO_MAX_TEXT (16KB): not memoized — must still return a stable exact count.
  const huge = "const x = 1; // 누적 메모리 누수 금지\n".repeat(1500);
  expect(huge.length).toBeGreaterThan(16_384);
  const a = countTokensAccurate(huge, "claude-sonnet-4-5");
  const b = countTokensAccurate(huge, "claude-sonnet-4-5");
  expect(a).toBeGreaterThan(0);
  expect(b).toBe(a);
});
