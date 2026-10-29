import { test, expect } from "bun:test";
import { maybeCompact } from "../src/agent/compaction";
import type { Message } from "../src/agent/loop";

test("a late summary after cancellation cannot rewrite conversation history", async () => {
  const history: Message[] = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `Message ${i}`,
  }));
  const original = structuredClone(history);
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const summary = Promise.withResolvers<string>();
  const compacting = maybeCompact(history, { force: true, keepRecent: 4, signal: controller.signal }, async (_messages, options) => {
    expect(options?.signal).toBe(controller.signal);
    entered.resolve();
    return summary.promise;
  });
  await entered.promise;
  controller.abort();
  summary.resolve("late provider result");
  expect(await compacting).toEqual({ compacted: false, removed: 0 });
  expect(history).toEqual(original);
});
