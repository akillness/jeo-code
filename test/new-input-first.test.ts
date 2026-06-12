import { test, expect } from "bun:test";
import { restoreQueuedLinesToPrefill, queuePromptInputChunk, type PromptInputQueue } from "../src/commands/launch";

test("restoreQueuedLinesToPrefill: queued lines become editable prefill, never auto-executed", () => {
  const q: PromptInputQueue = { pendingLines: ["fix the build", "  also run tests  "], partial: "" };
  const folded = restoreQueuedLinesToPrefill(q);
  expect(folded).toBe(2);
  expect(q.pendingLines).toEqual([]); // queue fully drained — nothing left to auto-serve
  expect(q.partial).toBe("fix the build also run tests");
});

test("restoreQueuedLinesToPrefill: queued lines lead, in-flight partial follows; blanks dropped; empty is a no-op", () => {
  const q: PromptInputQueue = { pendingLines: ["earlier command", "", "   "], partial: "half-typed" };
  expect(restoreQueuedLinesToPrefill(q)).toBe(1);
  expect(q.partial).toBe("earlier command half-typed");
  const empty: PromptInputQueue = { pendingLines: [], partial: "keep me" };
  expect(restoreQueuedLinesToPrefill(empty)).toBe(0);
  expect(empty.partial).toBe("keep me"); // untouched
});

test("end-to-end queue shape: chunk with newline queues a LINE, restore folds it into prefill", () => {
  const q: PromptInputQueue = { pendingLines: [], partial: "" };
  queuePromptInputChunk(q, "old request\nnew par");
  expect(q.pendingLines).toEqual(["old request"]);
  expect(q.partial).toBe("new par");
  restoreQueuedLinesToPrefill(q);
  expect(q.partial).toBe("old request new par"); // visible + editable, not executed
});
