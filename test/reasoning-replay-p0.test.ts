import { test, expect } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateMessageTokens } from "../src/agent/compaction";
import { createSession, appendMessage, loadSession } from "../src/agent/session";
import type { Message, ReasoningArtifact, ToolUseRecord, ToolResultRecord } from "../src/ai/types";

test("estimateMessageTokens counts reasoningArtifacts (replayed as real input tokens)", () => {
  const base: Message = { role: "assistant", content: "ok" };
  const withArtifact: Message = {
    role: "assistant",
    content: "ok",
    reasoningArtifacts: [{
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      text: "weighing approaches",
      signature: "x".repeat(400), // opaque signature ~ real tokens once replayed
    }],
  };
  const baseN = estimateMessageTokens(base);
  const artN = estimateMessageTokens(withArtifact);
  expect(artN).toBeGreaterThan(baseN);
  // The signature alone (~400 chars) must move the estimate materially.
  expect(artN - baseN).toBeGreaterThan(50);
});

test("estimateMessageTokens does NOT double-count toolUse/toolResults (already in content)", () => {
  const plain: Message = { role: "assistant", content: '{"tool":"read","arguments":{"filePath":"x"}}' };
  const structured: Message = {
    role: "assistant",
    content: '{"tool":"read","arguments":{"filePath":"x"}}',
    toolUse: [{ id: "call_1_0", tool: "read", arguments: { filePath: "x" } }],
  };
  // toolUse mirrors content, so it must not inflate the estimate.
  expect(estimateMessageTokens(structured)).toBe(estimateMessageTokens(plain));
});

test("session round-trip preserves reasoningArtifacts / toolUse / toolResults", async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), "jeo-replay-"));
  try {
    const { id } = await createSession(cwd);

    const artifact: ReasoningArtifact = {
      provider: "openai",
      model: "gpt-5.5",
      itemId: "rs_abc123",
      encrypted: "ENCRYPTED_BLOB_DATA",
      text: "planning the edit",
    };
    const toolUse: ToolUseRecord[] = [{ id: "call_1_0", tool: "edit", arguments: { filePath: "a.ts" } }];
    const toolResults: ToolResultRecord[] = [{ id: "call_1_0", output: "patched", isError: false }];

    const assistant: Message = {
      role: "assistant",
      content: '{"tool":"edit","arguments":{"filePath":"a.ts"}}',
      reasoning: "planning the edit",
      reasoningArtifacts: [artifact],
      toolUse,
    };
    const user: Message = {
      role: "user",
      content: "Tool [edit] result (ok):\npatched",
      toolResults,
      toolResultExtra: "[post-turn hook \"tsc\" — exit 0]",
    };
    await appendMessage(id, assistant, cwd);
    await appendMessage(id, user, cwd);

    const { messages } = await loadSession(id, cwd);
    const a = messages.find(m => m.role === "assistant")!;
    const u = messages.find(m => m.role === "user")!;

    expect(a.reasoningArtifacts).toEqual([artifact]);
    expect(a.toolUse).toEqual(toolUse);
    expect(a.reasoning).toBe("planning the edit");
    expect(u.toolResults).toEqual(toolResults);
    expect(u.toolResultExtra).toBe("[post-turn hook \"tsc\" — exit 0]");
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("a Message without the new fields still loads (back-compat)", async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), "jeo-replay-bc-"));
  try {
    const { id } = await createSession(cwd);
    const legacy: Message = { role: "assistant", content: "plain reply" };
    await appendMessage(id, legacy, cwd);
    const { messages } = await loadSession(id, cwd);
    const a = messages.find(m => m.role === "assistant")!;
    expect(a.content).toBe("plain reply");
    expect(a.reasoningArtifacts).toBeUndefined();
    expect(a.toolUse).toBeUndefined();
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
