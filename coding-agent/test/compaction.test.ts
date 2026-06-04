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
  });

  expect(history.length).toBe(3); // 1 summary + 2 recent
  expect(history[0]).toEqual({
    role: "user",
    content: "[Earlier conversation summary]\nMOCK-SUMMARY-NOSYS",
  });
  expect(history[1].content).toBe("Message 6");
  expect(history[2].content).toBe("Message 7");
});

test("maybeCompact: callLlm throws/rejects", async () => {
  const history = makeHistory(15, true);
  const originalHistory = [...history];

  mockCallLlm = async () => {
    throw new Error("LLM failed");
  };

  const result = await maybeCompact(history, {
    maxMessages: 10,
    keepRecent: 4,
  });

  expect(result).toEqual({ compacted: false, removed: 0 });
  expect(history).toEqual(originalHistory);
});
