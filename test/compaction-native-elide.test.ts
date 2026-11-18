import { expect, test } from "bun:test";
import {
  estimateMessageTokens,
  estimateTokens,
  historyTokens,
  maybeCompact,
  trimToolResultsInPlace,
} from "../src/agent/compaction";
import type { Message } from "../src/agent/loop";

test("trimToolResultsInPlace: elides short-content tool result carrying images, omits images, leaves original untouched", () => {
  const oldMsg: Message = {
    role: "user",
    content: "Tool [read] result (ok): screenshot attached",
    images: [{ mediaType: "image/png", data: "A".repeat(256) }],
  };
  const recentMsg: Message = {
    role: "user",
    content: "Tool [read] result (ok): recent",
  };
  const history: Message[] = [
    { role: "system", content: "sys" },
    oldMsg,
    recentMsg,
  ];

  const beforeMsgTokens = estimateMessageTokens(oldMsg);
  const res = trimToolResultsInPlace(history, { budgetTokens: 200, keepRecent: 1 });

  expect(res.trimmed).toBe(1);
  expect(history[1]).not.toBe(oldMsg);
  // Original message object is never mutated.
  expect(oldMsg.content).toBe("Tool [read] result (ok): screenshot attached");
  expect(oldMsg.images).toHaveLength(1);

  const elided = history[1]!;
  expect(elided.content).toBe(
    "Tool [read] result (ok): [elided mid-turn to free context — re-run the tool if this result is needed again]",
  );
  expect(elided.images).toBeUndefined();
  expect("images" in elided).toBe(false);
  expect(estimateMessageTokens(elided)).toBeLessThan(beforeMsgTokens);
  expect(res.tokens).toBe(historyTokens(history));
  expect(history[2]).toBe(recentMsg);
});

test("trimToolResultsInPlace: elides short-content tool result carrying toolResultExtra and omits toolResultExtra", () => {
  const extra = "diagnostic line\n".repeat(300);
  const oldMsg: Message = {
    role: "user",
    content: "Tool [bash] result (ok): done",
    toolResultExtra: extra,
  };
  const recentMsg: Message = {
    role: "user",
    content: "Tool [bash] result (ok): latest",
  };
  const history: Message[] = [
    { role: "system", content: "sys" },
    oldMsg,
    recentMsg,
  ];

  const beforeMsgTokens = estimateMessageTokens(oldMsg);
  const res = trimToolResultsInPlace(history, { budgetTokens: 200, keepRecent: 1 });

  expect(res.trimmed).toBe(1);
  expect(history[1]).not.toBe(oldMsg);
  expect(oldMsg.toolResultExtra).toBe(extra);

  const elided = history[1]!;
  expect(elided.content).toBe(
    "Tool [bash] result (ok): [elided mid-turn to free context — re-run the tool if this result is needed again]",
  );
  expect(elided.toolResultExtra).toBeUndefined();
  expect("toolResultExtra" in elided).toBe(false);
  expect(estimateMessageTokens(elided)).toBeLessThan(beforeMsgTokens);
  expect(res.tokens).toBe(historyTokens(history));
});

test("trimToolResultsInPlace: elides short/non-prefix message with large toolResults[].output while preserving id, isError, workspace, and small outputs", () => {
  const bigOutput = "X".repeat(2400);
  const smallOutput = "tiny ok";
  const oldMsg: Message = {
    role: "user",
    content: "ok",
    toolResults: [
      {
        id: "call_big",
        output: bigOutput,
        isError: true,
        workspace: { mutation: true, changed: ["src/a.ts"] },
      },
      {
        id: "call_small",
        output: smallOutput,
        isError: false,
        workspace: { mutation: false, skipped: "scratch" },
      },
    ],
  };
  const recentMsg: Message = {
    role: "user",
    content: "Tool [read] result (ok): latest",
  };
  const history: Message[] = [
    { role: "system", content: "sys" },
    oldMsg,
    recentMsg,
  ];

  const beforeMsgTokens = estimateMessageTokens(oldMsg);
  const res = trimToolResultsInPlace(history, { budgetTokens: 200, keepRecent: 1 });

  expect(res.trimmed).toBe(1);
  expect(history[1]).not.toBe(oldMsg);
  // Original message and its toolResults stay untouched.
  expect(oldMsg.content).toBe("ok");
  expect(oldMsg.toolResults![0]!.output).toBe(bigOutput);

  const elided = history[1]!;
  const expectedStub =
    "Tool result: [elided mid-turn to free context — re-run the tool if this result is needed again]";
  expect(elided.content).toBe(expectedStub);
  expect(elided.toolResults).toEqual([
    {
      id: "call_big",
      output: expectedStub,
      isError: true,
      workspace: { mutation: true, changed: ["src/a.ts"] },
    },
    {
      id: "call_small",
      output: smallOutput,
      isError: false,
      workspace: { mutation: false, skipped: "scratch" },
    },
  ]);
  expect(estimateMessageTokens(elided)).toBeLessThan(beforeMsgTokens);
  expect(res.tokens).toBe(historyTokens(history));
});

test("trimToolResultsInPlace: skips already-tiny tool-result messages with no images, extra, or large output", () => {
  const tiny: Message = {
    role: "user",
    content: "Tool [read] result (ok): tiny",
    toolResults: [{ id: "call_1", output: "tiny", isError: false }],
  };
  const bigRecent: Message = {
    role: "user",
    content: `Tool [read] result (ok): ${"R".repeat(1200)}`,
  };
  const history: Message[] = [
    { role: "system", content: "sys" },
    tiny,
    bigRecent,
  ];

  const res = trimToolResultsInPlace(history, { budgetTokens: 100, keepRecent: 1 });
  expect(res.trimmed).toBe(0);
  expect(history[1]).toBe(tiny);
});

test("maybeCompact degraded summary-failure path: clamps toolResults[].output and toolResultExtra proportionally, preserves metadata, and drops images when over budget", async () => {
  const recentMsg: Message = {
    role: "user",
    content: "Tool [bash] result (ok): see native results",
    images: [
      { mediaType: "image/png", data: "IMG1" },
      { mediaType: "image/jpeg", data: "IMG2" },
    ],
    toolResults: [
      {
        id: "r1",
        output: "A".repeat(3200),
        isError: false,
        workspace: { mutation: true, changed: ["src/alpha.ts"] },
      },
      {
        id: "r2",
        output: "B".repeat(1600),
        isError: true,
        workspace: { mutation: false, skipped: "scratch" },
      },
    ],
    toolResultExtra: "E".repeat(1600),
  };
  const history: Message[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "older 1" },
    { role: "assistant", content: "older 2" },
    recentMsg,
  ];

  const failingSummarize = async () => {
    throw new Error("summarizer unavailable");
  };

  const res = await maybeCompact(
    history,
    { maxMessages: 1, keepRecent: 1, maxTokens: 450 },
    failingSummarize,
  );

  expect(res.compacted).toBe(true);
  expect(res.summaryFailed).toBe(true);
  expect(res.removed).toBe(2);
  expect(history).toHaveLength(2);

  const kept = history[1]!;
  expect(kept.images).toBeUndefined();
  expect("images" in kept).toBe(false);
  expect(kept.toolResults).toHaveLength(2);

  const [k1, k2] = kept.toolResults!;
  expect(k1!.id).toBe("r1");
  expect(k1!.isError).toBe(false);
  expect(k1!.workspace).toEqual({ mutation: true, changed: ["src/alpha.ts"] });

  expect(k2!.id).toBe("r2");
  expect(k2!.isError).toBe(true);
  expect(k2!.workspace).toEqual({ mutation: false, skipped: "scratch" });

  expect(k1!.output.length).toBeLessThan(3200);
  expect(k2!.output.length).toBeLessThan(1600);
  // r1 started with 2x the tokens of r2, so proportional allocation gives r1 more budget.
  expect(estimateTokens(k1!.output)).toBeGreaterThan(estimateTokens(k2!.output));

  expect(kept.toolResultExtra).toBeDefined();
  expect(kept.toolResultExtra!.length).toBeLessThan(1600);
  expect(historyTokens(history)).toBeLessThanOrEqual(450);
});

test("maybeCompact degraded summary-failure path: caps images within perMessageBudget and clamps remaining toolResults into leftover text budget", async () => {
  const recentMsg: Message = {
    role: "user",
    content: "Tool [read] result (ok): three images",
    images: [
      { mediaType: "image/png", data: "IMG1" },
      { mediaType: "image/png", data: "IMG2" },
      { mediaType: "image/png", data: "IMG3" },
    ],
    toolResults: [
      {
        id: "r_img",
        output: "Z".repeat(2400),
        isError: false,
        workspace: { mutation: false },
      },
    ],
  };
  const history: Message[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "older 1" },
    { role: "assistant", content: "older 2" },
    recentMsg,
  ];

  const failingSummarize = async () => {
    throw new Error("summarizer down");
  };

  const res = await maybeCompact(
    history,
    { maxMessages: 1, keepRecent: 1, maxTokens: 2500 },
    failingSummarize,
  );

  expect(res.compacted).toBe(true);
  expect(res.summaryFailed).toBe(true);
  expect(history).toHaveLength(2);

  const kept = history[1]!;
  // 2500 budget fits 2 images (2200 tokens), dropping the 3rd, and clamps toolResults into the ~296 leftover tokens.
  expect(kept.images).toEqual([
    { mediaType: "image/png", data: "IMG1" },
    { mediaType: "image/png", data: "IMG2" },
  ]);
  expect(kept.toolResults).toHaveLength(1);
  expect(kept.toolResults![0]!.id).toBe("r_img");
  expect(kept.toolResults![0]!.workspace).toEqual({ mutation: false });
  expect(kept.toolResults![0]!.output.length).toBeLessThan(2400);
  expect(historyTokens(history)).toBeLessThanOrEqual(2500);
});
