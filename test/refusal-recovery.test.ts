import { test, expect, mock } from "bun:test";
import type { Message } from "../src/agent/loop";

const refusal = () => new Error("Anthropic returned no content (stop_reason=refusal).");

test("refusal ladder stage 3: project-context guidance is stripped from the system prompt, then the turn recovers", async () => {
  let calls = 0;
  let sawStrippedSystem = false;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (history: Message[]) => {
      calls++;
      // Refuse while the system prompt still carries the project-context block —
      // the field case where repo-authored guidance trips the classifier.
      if (history[0]!.content.includes("<project_context>")) throw refusal();
      sawStrippedSystem = true;
      return JSON.stringify({ tool: "done", arguments: { reason: "recovered without guidance" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history: Message[] = [
    { role: "system", content: "Core instructions.\n\n<project_context>\nspicy repo guidance\n</project_context>" },
    { role: "user", content: "init" },
  ];
  const result = await runAgentLoop(history, { cwd: process.cwd(), maxSteps: 10, budget: { maxExtensions: 0 }, tools: {} });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("recovered without guidance");
  expect(sawStrippedSystem).toBe(true);
  expect(history[0]!.content).toBe("Core instructions."); // block removed, core kept
  expect(calls).toBe(4); // refusal x3 (plain, reset, strip applied on 3rd) + success
});

test("refusal ladder: with no project-context block, a third refusal surfaces the friendly error (no extra billed call)", async () => {
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      calls++;
      throw refusal();
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history: Message[] = [
    { role: "system", content: "Core instructions only." },
    { role: "user", content: "init" },
  ];
  const result = await runAgentLoop(history, { cwd: process.cwd(), maxSteps: 10, budget: { maxExtensions: 0 }, tools: {} });
  expect(result.done).toBe(false);
  expect(result.doneReason).toContain("declined to answer");
  expect(calls).toBe(3); // plain resend + post-reset retry + final refusal — nothing left to strip
});
