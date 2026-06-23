import { test, expect, mock } from "bun:test";

// Prose-salvage behavior in runAgentLoop: a pure-prose LLM reply (no JSON at all)
// is the model's final chat-style answer — it must become done.reason instead of
// being bounced back (which made the model apologize, and the apology surfaced
// as the visible reply).

test("runAgentLoop: pure prose reply is salvaged as the final answer", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => "이 프로젝트는 Bun 기반 TypeScript 코딩 에이전트입니다.",
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "user" as const, content: "explain the project" }];
  const result = await runAgentLoop(history, { cwd: process.cwd(), maxSteps: 5, tools: {} });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("이 프로젝트는 Bun 기반 TypeScript 코딩 에이전트입니다.");
  // The salvaged reply is recorded in history as the assistant turn.
  expect(history[history.length - 1]?.role).toBe("assistant");
});

test("runAgentLoop: salvaged prose strips leaked reasoning/tool-call tags from the answer", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => "</parameter></think> ㅇㅇㅇㅇ </parameter>",
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "user" as const, content: "explain" }];
  const result = await runAgentLoop(history, { cwd: process.cwd(), maxSteps: 5, tools: {} });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("ㅇㅇㅇㅇ");
});

test("runAgentLoop: malformed JSON-ish reply gets a no-apology correction, then recovers", async () => {
  const userCorrections: string[] = [];
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (history: { role: string; content: string }[]) => {
      turn++;
      if (turn === 1) return '{"tool": "done", "arguments": {broken';
      // Capture the correction the engine injected after the malformed reply.
      const last = history[history.length - 1];
      if (last?.role === "user") userCorrections.push(last.content);
      return JSON.stringify({ tool: "done", arguments: { reason: "fixed" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "user" as const, content: "go" }];
  const result = await runAgentLoop(history, { cwd: process.cwd(), maxSteps: 5, tools: {} });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("fixed");
  expect(userCorrections.length).toBe(1);
  // The correction must forbid apologies and offer the done-resend path.
  expect(userCorrections[0]).toContain("Do NOT apologize");
  expect(userCorrections[0]).toContain('{"tool":"done"');
});

test("runAgentLoop: repeated malformed-JSON bounces salvage the last text instead of burning steps", async () => {
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    // Always malformed-but-brace-containing: bounce, bounce, then salvage.
    callLlm: async () => {
      turn++;
      return `answer attempt ${turn} {broken`;
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "user" as const, content: "go" }];
  const result = await runAgentLoop(history, { cwd: process.cwd(), maxSteps: 10, tools: {} });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("answer attempt 3 {broken");
  expect(turn).toBe(3); // 2 bounces + 1 salvage, never the full 10 steps
});

test("runAgentLoop: onUsage event reports cumulative tokens after each call", async () => {
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (_h: unknown, opts: { onUsage?: (u: { inputTokens: number; outputTokens: number }) => void }) => {
      turn++;
      opts.onUsage?.({ inputTokens: 100, outputTokens: 10 });
      if (turn === 1) return JSON.stringify({ tool: "noop", arguments: {} });
      return JSON.stringify({ tool: "done", arguments: { reason: "ok" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const seen: { inputTokens: number; outputTokens: number }[] = [];
  const result = await runAgentLoop([{ role: "user" as const, content: "go" }], {
    cwd: process.cwd(),
    maxSteps: 5,
    tools: { noop: async () => ({ success: true, output: "ok" }) },
    events: { onUsage: u => seen.push(u) },
  });
  expect(result.done).toBe(true);
  expect(seen.length).toBe(2);
  expect(seen[0]).toEqual({ inputTokens: 100, outputTokens: 10 });
  expect(seen[1]).toEqual({ inputTokens: 200, outputTokens: 20 });
  expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 20 });
});
