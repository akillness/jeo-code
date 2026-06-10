import { test, expect, mock } from "bun:test";
import type { Message } from "../src/agent/loop";

let mockCallLlm = async (messages: Message[], opts?: any): Promise<string> => {
  return "SUMMARY-TEXT";
};

await mock.module("../src/agent/loop", () => ({
  callLlm: (messages: Message[], opts?: any) => mockCallLlm(messages, opts),
}));

const { maybeCompact } = await import("../src/agent/compaction");

function makeHistory(n: number, withSystem = false): Message[] {
  const history: Message[] = [];
  if (withSystem) {
    history.push({ role: "system", content: "system instruction" });
  }
  for (let i = 0; i < n; i++) {
    history.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}`,
    });
  }
  return history;
}

test("maybeCompact: below threshold with default opts", async () => {
  // Defaults: maxMessages = 40, keepRecent = 12
  // Let's create history with 30 messages (no system)
  const history = makeHistory(30);
  const originalHistory = [...history];

  const result = await maybeCompact(history);

  expect(result).toEqual({ compacted: false, removed: 0 });
  expect(history).toEqual(originalHistory);
});

test("maybeCompact: below threshold with system message", async () => {
  // Total 41 messages: 1 system + 40 body
  const history = makeHistory(40, true);
  const originalHistory = [...history];

  const result = await maybeCompact(history);

  expect(result).toEqual({ compacted: false, removed: 0 });
  expect(history).toEqual(originalHistory);
});

test("maybeCompact: above threshold with system message", async () => {
  // Let's use custom opts: maxMessages = 10, keepRecent = 4
  // 1 system message, 14 body messages. Total 15 messages.
  const history = makeHistory(14, true);
  const originalHistory = [...history];

  // Expect older to be body.slice(0, 14 - 4 = 10) -> messages 0 to 9
  // Expect recent to be body.slice(10) -> messages 10 to 13
  mockCallLlm = async (messages, opts) => {
    expect(opts.model).toBe("test-model");
    expect(opts.systemPrompt).toContain("Summarize the following coding-agent conversation");
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("user");
    // Verify formatted user message contains first and last of older
    expect(messages[0].content).toContain("[user] Message 0");
    expect(messages[0].content).toContain("[assistant] Message 9");
    expect(messages[0].content).not.toContain("[user] Message 10");
    return "MOCK-SUMMARY";
  };

  const result = await maybeCompact(history, {
    maxMessages: 10,
    keepRecent: 4,
    model: "test-model",
  });

  expect(result).toEqual({
    compacted: true,
    removed: 10,
    summary: "MOCK-SUMMARY",
    error: undefined,
    replacesThrough: 10,
  });

  // Verify history mutation
  expect(history.length).toBe(6); // 1 system + 1 summary + 4 recent
  expect(history[0]).toEqual(originalHistory[0]); // system prompt preserved
  expect(history[1]).toEqual({
    role: "user",
    content: "[Earlier conversation summary]\nMOCK-SUMMARY",
  });
  // Check recent messages are preserved in order
  expect(history[2].content).toBe("Message 10");
  expect(history[5].content).toBe("Message 13");
});

test("maybeCompact: above threshold without system message", async () => {
  // Custom opts: maxMessages = 5, keepRecent = 2
  // No system, 8 messages.
  const history = makeHistory(8, false);
  const originalHistory = [...history];

  mockCallLlm = async () => "MOCK-SUMMARY-NOSYS";

  const result = await maybeCompact(history, {
    maxMessages: 5,
    keepRecent: 2,
  });

  expect(result).toEqual({
    compacted: true,
    removed: 6,
    summary: "MOCK-SUMMARY-NOSYS",
    error: undefined,
    replacesThrough: 5,
  });

  expect(history.length).toBe(3); // 1 summary + 2 recent
  expect(history[0]).toEqual({
    role: "user",
    content: "[Earlier conversation summary]\nMOCK-SUMMARY-NOSYS",
  });
  expect(history[1].content).toBe("Message 6");
  expect(history[2].content).toBe("Message 7");
});

test("maybeCompact: callLlm failure still bounds history with a deterministic placeholder", async () => {
  const history = makeHistory(15, true);
  const originalHistory = [...history];

  mockCallLlm = async () => {
    throw new Error("LLM failed");
  };

  const result = await maybeCompact(history, {
    maxMessages: 10,
    keepRecent: 4,
  });

  // Old behavior swallowed the error and left history unbounded. Now it must still
  // trim so a persistently-failing summarizer can't grow memory across a session.
  expect(result.compacted).toBe(true);
  expect(result.summaryFailed).toBe(true);
  expect(result.removed).toBe(11); // body 15 - keepRecent 4
  expect(history.length).toBe(6); // system + placeholder + 4 recent
  expect(history[0]).toEqual(originalHistory[0]); // system preserved
  expect(history[1].content).toContain("Earlier conversation omitted");
});

test("maybeCompact: force lowers the trigger floor for a small history", async () => {
  mockCallLlm = async () => "FORCED-SUMMARY";
  // 1 system + 10 body. Default opts would NOT compact (body 10 <= maxMessages 40).
  const noForce = await maybeCompact(makeHistory(10, true));
  expect(noForce.compacted).toBe(false);

  const history = makeHistory(10, true);
  const result = await maybeCompact(history, { force: true });
  expect(result.compacted).toBe(true);
  expect(result.removed).toBe(6); // body 10 - keepRecent 4
  expect(history.length).toBe(6); // system + summary + 4 recent
  expect(history[1].content).toContain("FORCED-SUMMARY");
});

test("maybeCompact: compacts short histories when pasted content exceeds the char budget", async () => {
  mockCallLlm = async (messages) => {
    expect(messages[0].content).toContain("[user] " + "X".repeat(50));
    return "CHAR-SUMMARY";
  };
  const history: Message[] = [
    { role: "system", content: "system instruction" },
    { role: "user", content: "X".repeat(200) },
    { role: "assistant", content: "small reply" },
  ];

  const result = await maybeCompact(history, { maxMessages: 40, maxChars: 100, keepRecent: 1 });

  expect(result.compacted).toBe(true);
  expect(result.removed).toBe(1);
  expect(history.length).toBe(3); // system + summary + 1 recent
  expect(history[1].content).toContain("CHAR-SUMMARY");
  expect(history[2].content).toBe("small reply");
});

test("maybeCompact: caps the summarizer input so compaction cannot create a huge prompt", async () => {
  mockCallLlm = async (messages) => {
    expect(messages[0].content.length).toBeLessThanOrEqual(260);
    expect(messages[0].content).toContain("omitted from summary input");
    return "BOUNDED-SUMMARY";
  };
  const history: Message[] = [
    { role: "user", content: "A".repeat(300) },
    { role: "assistant", content: "B".repeat(300) },
    { role: "user", content: "recent" },
  ];

  const result = await maybeCompact(history, {
    maxMessages: 40,
    maxChars: 100,
    keepRecent: 1,
    maxSummaryInputChars: 120,
  });

  expect(result.compacted).toBe(true);
  expect(result.removed).toBe(2);
  expect(history[0].content).toContain("BOUNDED-SUMMARY");
  expect(history[1].content).toBe("recent");
});

test("maybeCompact: truncates oversized generated summaries before reinserting", async () => {
  mockCallLlm = async () => "S".repeat(500);
  const history: Message[] = [
    { role: "user", content: "older".repeat(40) },
    { role: "assistant", content: "middle".repeat(40) },
    { role: "user", content: "recent" },
  ];

  const result = await maybeCompact(history, {
    maxMessages: 40,
    maxChars: 120,
    keepRecent: 1,
    maxSummaryInputChars: 80,
  });

  expect(result.compacted).toBe(true);
  expect(history.length).toBe(2);
  expect(history[0].content.length).toBeLessThanOrEqual(120);
  expect(history[0].content.endsWith("…") || history[0].content.includes("truncated")).toBe(true);
  expect(history[1].content).toBe("recent");
});

test("maybeCompact: force does NOT shred recent message content (regression for force-floor bug)", async () => {
  mockCallLlm = async () => "FORCED-SUMMARY";
  const recentContent = "This is real user content that must survive force compaction.";
  const history: Message[] = [
    { role: "system", content: "system instruction" },
    ...Array.from({ length: 6 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `older ${i}` } as Message)),
    { role: "user", content: recentContent },
    { role: "assistant", content: "ack" },
    { role: "user", content: "final" },
  ];

  const result = await maybeCompact(history, { force: true });
  expect(result.compacted).toBe(true);
  // Recent messages must remain readable — the previous bug clamped them to ~1 char.
  const recents = history.slice(2).map(m => m.content);
  expect(recents).toContain(recentContent);
  expect(recents).toContain("final");
  // None of the surviving recent messages should be a single-char truncation artifact.
  for (const r of recents) expect(r.length).toBeGreaterThan(2);
});

test("maybeCompact: repeated force-compact on already-compacted history is a no-op", async () => {
  let calls = 0;
  mockCallLlm = async () => {
    calls++;
    return "FIRST-SUMMARY";
  };
  const history: Message[] = [
    { role: "system", content: "system instruction" },
    ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` } as Message)),
  ];

  const first = await maybeCompact(history, { force: true });
  expect(first.compacted).toBe(true);
  expect(calls).toBe(1);
  const afterFirst = history.map(m => m.content);

  // Second force call on already-compacted history must not re-summarize and must not lose content.
  const second = await maybeCompact(history, { force: true });
  expect(second.compacted).toBe(false);
  expect(calls).toBe(1);
  expect(history.map(m => m.content)).toEqual(afterFirst);
});

test("maybeCompact: truncates oversized recent messages so char-budget compaction converges", async () => {
  mockCallLlm = async () => "RECENT-SUMMARY";
  const history: Message[] = [
    { role: "system", content: "system instruction" },
    { role: "assistant", content: "older small" },
    { role: "user", content: "Z".repeat(400) },
  ];

  const first = await maybeCompact(history, { maxMessages: 40, maxChars: 120, keepRecent: 1 });
  expect(first.compacted).toBe(true);
  expect(history.length).toBe(3);
  expect(history[2].content.length).toBeLessThan(400);
  expect(history[2].content.endsWith("…") || history[2].content.includes("truncated")).toBe(true);

  const second = await maybeCompact(history, { maxMessages: 40, maxChars: 120, keepRecent: 1 });
  expect(second.compacted).toBe(false);
});

test("maybeCompact: CJK heavy history triggers compaction earlier than ASCII (token estimator check)", async () => {
  mockCallLlm = async () => "CJK-SUMMARY";

  // Case 1: CJK history. 250 characters of CJK.
  // 250 characters * 0.67 tokens/char = ~167 tokens. (Plus structure overhead)
  // With maxTokens: 120, this should trigger compaction.
  const cjkHistory: Message[] = [
    { role: "user", content: "한글".repeat(125) }, // 250 characters
    { role: "assistant", content: "ack" },
  ];
  const cjkRes = await maybeCompact(cjkHistory, { maxMessages: 40, maxTokens: 120, keepRecent: 1 });
  expect(cjkRes.compacted).toBe(true);

  // Case 2: ASCII history. 250 characters of ASCII.
  // 250 characters * 0.25 tokens/char = ~62 tokens. (Plus structure overhead)
  // With maxTokens: 120, this should NOT trigger compaction.
  const asciiHistory: Message[] = [
    { role: "user", content: "a".repeat(250) },
    { role: "assistant", content: "ack" },
  ];
  const asciiRes = await maybeCompact(asciiHistory, { maxMessages: 40, maxTokens: 120, keepRecent: 1 });
  expect(asciiRes.compacted).toBe(false);
});

test("maybeCompact: system prompt size is included in token budget", async () => {
  mockCallLlm = async () => "SYS-SUMMARY";

  // maxTokens: 150.
  // User message has 60 tokens (240 ASCII chars).
  // Without system prompt: total ~62 tokens. Below 150 -> no compaction.
  const noSysHistory: Message[] = [
    { role: "user", content: "a".repeat(240) },
    { role: "assistant", content: "ack" },
  ];
  const noSysRes = await maybeCompact(noSysHistory, { maxMessages: 40, maxTokens: 150, keepRecent: 1 });
  expect(noSysRes.compacted).toBe(false);

  // With a large system prompt: 150 tokens (600 ASCII chars).
  // Total ~210 tokens. Above 150 -> compaction triggers.
  const sysHistory: Message[] = [
    { role: "system", content: "s".repeat(600) },
    { role: "user", content: "a".repeat(240) },
    { role: "assistant", content: "ack" },
  ];
  const sysRes = await maybeCompact(sysHistory, { maxMessages: 40, maxTokens: 150, keepRecent: 1 });
  expect(sysRes.compacted).toBe(true);
});
