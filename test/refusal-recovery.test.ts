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

test("refusal ladder stage 2: reasoning artifacts + native tool-use replay are stripped, then the turn recovers", async () => {
  let calls = 0;
  let sawArtifactFreeHistory = false;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (history: Message[]) => {
      calls++;
      // Refuse while ANY assistant turn still carries the native replay channel —
      // the field case (fable-5): replayed thinking blocks re-trip the classifier
      // on every resend, so tool-result eliding alone can never recover.
      const hasArtifacts = history.some(
        m => m.role === "assistant" && ((m.reasoningArtifacts?.length ?? 0) > 0 || (m.toolUse?.length ?? 0) > 0),
      );
      if (hasArtifacts) throw refusal();
      sawArtifactFreeHistory = true;
      return JSON.stringify({ tool: "done", arguments: { reason: "recovered without thinking replay" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history: Message[] = [
    { role: "system", content: "Core instructions only." },
    { role: "user", content: "init" },
    {
      role: "assistant",
      content: '{"tool":"read","arguments":{"filePath":"x"}}',
      reasoning: "displayed thought",
      reasoningArtifacts: [{ provider: "anthropic", model: "claude-fable-5", text: "flagged thought", signature: "sig" }],
      toolUse: [{ id: "tu_1", tool: "read", arguments: { filePath: "x" } }],
    },
    { role: "user", content: "Tool [read] result (ok): file body" },
  ];
  const result = await runAgentLoop(history, { cwd: process.cwd(), maxSteps: 10, budget: { maxExtensions: 0 }, tools: {} });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("recovered without thinking replay");
  expect(sawArtifactFreeHistory).toBe(true);
  // Stage 2 (the 2nd refusal) strips the replay channel → the 3rd call succeeds.
  expect(calls).toBe(3);
  const assistant = history.find(m => m.role === "assistant")!;
  expect(assistant.reasoningArtifacts).toBeUndefined();
  expect(assistant.toolUse).toBeUndefined();
  expect(assistant.reasoning).toBe("displayed thought"); // display channel survives
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
