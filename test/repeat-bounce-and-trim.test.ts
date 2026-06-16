import { test, expect, mock } from "bun:test";
import { trimToolResultsInPlace, historyTokens } from "../src/agent/compaction";
import type { Message } from "../src/agent/loop";

test("repeat bounce: a 2nd identical write is SKIPPED with a corrective prompt; done after correction succeeds", async () => {
  let llmCalls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (history: Message[]) => {
      llmCalls++;
      // Steps 1+2: the model stubbornly repeats the same write. Step 3 runs only
      // if the engine bounced a correction instead of killing the turn.
      if (llmCalls <= 2) return JSON.stringify({ tool: "write", arguments: { filePath: "a.txt", content: "x" } });
      const corrected = history.some(m => m.role === "user" && m.content.includes("repeated the EXACT same"));
      return JSON.stringify({ tool: "done", arguments: { reason: corrected ? "finished after correction" : "no correction seen" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  let writeRuns = 0;
  const history: Message[] = [{ role: "system", content: "sys" }];
  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 10,
    budget: { maxExtensions: 0 },
    tools: { write: async () => { writeRuns++; return { success: true, output: "ok" }; } },
  });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("finished after correction");
  expect(writeRuns).toBe(1); // the duplicate was skipped, not re-executed
});

test("repeat bounce: repeating THROUGH both corrections still stops the turn (anti-spin)", async () => {
  await mock.module("../src/agent/loop", () => ({
    // jsonMode:false is the consolidation salvage call — return a plain wrap-up so the
    // stop carries a useful answer; every tool-call step repeats the same write.
    callLlm: async (_h: Message[], options: { jsonMode?: boolean } = {}) =>
      options.jsonMode === false
        ? "wrap-up: I kept retrying the same write."
        : JSON.stringify({ tool: "write", arguments: { filePath: "a.txt", content: "x" } }),
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  let writeRuns = 0;
  const result = await runAgentLoop([{ role: "system", content: "sys" }], {
    cwd: process.cwd(),
    maxSteps: 10,
    budget: { maxExtensions: 0 },
    tools: { write: async () => { writeRuns++; return { success: true, output: "ok" }; } },
  });
  expect(result.done).toBe(false);
  expect(result.doneReason).toContain("repeated the same 'write' call");
  expect(result.doneReason).toContain("even after explicit corrections");
  expect(result.doneReason).toContain("wrap-up:"); // consolidated salvage answer, not a cold stop
  expect(writeRuns).toBe(1); // executed once; both bounces and the stop never re-ran it
});

test("repeat spin: two escalating result-aware corrections, then a consolidated salvage answer", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (_h: Message[], options: { jsonMode?: boolean } = {}) =>
      options.jsonMode === false
        ? "What I found: nothing matched 'zzz' — the symbol likely does not exist in this repo."
        : JSON.stringify({ tool: "search", arguments: { pattern: "zzz", paths: ["."] } }),
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history: Message[] = [{ role: "system", content: "sys" }];
  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 20,
    budget: { maxExtensions: 0 },
    tools: { search: async () => ({ success: true, output: "no matches" }) },
  });
  expect(result.done).toBe(false);
  // C — consolidated salvage answer is returned instead of a bare stop.
  expect(result.doneReason).toContain("What I found:");
  expect(result.doneReason).toContain("repeated the same 'search' call");
  // B — exactly two escalating corrections were pushed before the stop.
  const corrections = history.filter(m => m.role === "user" && m.content.includes("repeated the EXACT same"));
  expect(corrections.length).toBe(2);
  // A — result-aware hint tells the model to broaden an empty search.
  expect(corrections[0]!.content).toContain("BROADEN");
  // B — the second correction warns it is the last attempt.
  expect(corrections[1]!.content).toContain("LAST attempt");
});

test("trimToolResultsInPlace: elides OLDEST tool results down to budget, keeps recent + non-tool messages", () => {
  const big = "line ".repeat(2000); // ~2.5k estimated tokens each
  const history: Message[] = [{ role: "system", content: "sys" }, { role: "user", content: "real prompt" }];
  for (let i = 0; i < 20; i++) {
    history.push({ role: "assistant", content: `{"tool":"read","arguments":{"i":${i}}}` });
    history.push({ role: "user", content: `Tool [read] result (ok):\n${big} #${i}` });
  }
  const before = historyTokens(history);
  const budget = Math.round(before / 3);
  const res = trimToolResultsInPlace(history, { budgetTokens: budget, keepRecent: 4 });
  expect(res.trimmed).toBeGreaterThan(0);
  expect(historyTokens(history)).toBeLessThanOrEqual(budget);
  // Newest 4 tool results intact; the oldest are stubs; everything else untouched.
  const toolResults = history.filter(m => m.role === "user" && m.content.startsWith("Tool ["));
  for (const recent of toolResults.slice(-4)) expect(recent.content).toContain("line line");
  expect(toolResults[0]!.content).toContain("[elided mid-turn");
  expect(history[0]!.content).toBe("sys");
  expect(history[1]!.content).toBe("real prompt");
  expect(history.filter(m => m.role === "assistant").every(m => m.content.includes('"tool"'))).toBe(true);
  // Under budget already → no-op.
  expect(trimToolResultsInPlace(history, { budgetTokens: before }).trimmed).toBe(0);
});
