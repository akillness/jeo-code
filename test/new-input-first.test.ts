import { test, expect } from "bun:test";
import { restoreQueuedLinesToPrefill, queuePromptInputChunk, type PromptInputQueue } from "../src/commands/launch";

test("restoreQueuedLinesToPrefill: queued lines become editable prefill, never auto-executed", () => {
  const q: PromptInputQueue = { pendingLines: ["fix the build", "  also run tests  "], partial: "", pastedLines: [], inPaste: false };
  const folded = restoreQueuedLinesToPrefill(q);
  expect(folded).toBe(2);
  expect(q.pendingLines).toEqual([]); // queue fully drained — nothing left to auto-serve
  expect(q.partial).toBe("fix the build also run tests");
});

test("restoreQueuedLinesToPrefill: queued lines lead, in-flight partial follows; blanks dropped; empty is a no-op", () => {
  const q: PromptInputQueue = { pendingLines: ["earlier command", "", "   "], partial: "half-typed", pastedLines: [], inPaste: false };
  expect(restoreQueuedLinesToPrefill(q)).toBe(1);
  expect(q.partial).toBe("earlier command half-typed");
  const empty: PromptInputQueue = { pendingLines: [], partial: "keep me", pastedLines: [], inPaste: false };
  expect(restoreQueuedLinesToPrefill(empty)).toBe(0);
  expect(empty.partial).toBe("keep me"); // untouched
});

test("end-to-end queue shape: chunk with newline queues a LINE, restore folds it into prefill", () => {
  const q: PromptInputQueue = { pendingLines: [], partial: "", pastedLines: [], inPaste: false };
  queuePromptInputChunk(q, "old request\nnew par");
  expect(q.pendingLines).toEqual(["old request"]);
  expect(q.partial).toBe("new par");
  restoreQueuedLinesToPrefill(q);
  expect(q.partial).toBe("old request new par"); // visible + editable, not executed
});

test("restoreQueuedLinesToPrefill never touches pasted batch commands", () => {
  const q: PromptInputQueue = { pendingLines: ["typed line"], partial: "", pastedLines: ["/help", "/config"], inPaste: false };
  restoreQueuedLinesToPrefill(q);
  expect(q.partial).toBe("typed line"); // typed lines fold into the prefill…
  expect(q.pastedLines).toEqual(["/help", "/config"]); // …pasted commands stay an ordered batch
});
