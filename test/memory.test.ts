import { test, expect, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// hermes-style local experience memory (plan/gjc-inheritance.md B6):
// session end distills durable learnings into .joc/memory/MEMORY.md (one model
// call, merge-with-existing, atomic write, best-effort); the next session
// injects the doc back under a hard char cap. JOC_NO_MEMORY=1 disables both.

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "jeo-memory-"));
}

const HISTORY = [
  { role: "system" as const, content: "sys" },
  { role: "user" as const, content: "fix the parser" },
  { role: "assistant" as const, content: '{"tool":"bash","arguments":{"command":"bun test"}}' },
  { role: "user" as const, content: "Tool [bash] result (ok):\n3 pass" },
  { role: "assistant" as const, content: "done — parser fixed" },
];

test("distillSessionMemory writes the model's doc atomically and merges existing", async () => {
  const dir = await tmp();
  let seenPrompt = "";
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (messages: { content: string }[]) => {
      seenPrompt = messages.map(m => m.content).join("\n");
      return "## Commands that work\n- bun test\n";
    },
  }));
  const { distillSessionMemory, memoryFilePath, loadMemory } = await import("../src/agent/memory");
  await fs.mkdir(path.dirname(memoryFilePath(dir)), { recursive: true });
  await fs.writeFile(memoryFilePath(dir), "## Repo facts\n- Bun runtime\n");

  const res = await distillSessionMemory(HISTORY, dir);
  expect(res.updated).toBe(true);
  expect(await loadMemory(dir)).toContain("bun test");
  expect(seenPrompt).toContain("Bun runtime");   // existing doc fed into the merge
  expect(seenPrompt).toContain("fix the parser"); // transcript fed in
  await fs.rm(dir, { recursive: true, force: true });
});

test("distillSessionMemory skips short sessions and never throws on model failure", async () => {
  const dir = await tmp();
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => { throw new Error("provider down"); },
  }));
  const { distillSessionMemory, loadMemory } = await import("../src/agent/memory");
  const short = await distillSessionMemory(HISTORY.slice(0, 2), dir);
  expect(short.updated).toBe(false);
  expect(short.skipped).toContain("too short");

  const failed = await distillSessionMemory(HISTORY, dir);
  expect(failed.updated).toBe(false);
  expect(failed.skipped).toContain("provider down");
  expect(await loadMemory(dir)).toBe(""); // nothing written on failure
  await fs.rm(dir, { recursive: true, force: true });
});

test("memoryPromptSection injects capped doc; empty/disabled yields nothing", async () => {
  const dir = await tmp();
  const { memoryPromptSection, memoryFilePath, MEMORY_INJECT_MAX_CHARS } = await import("../src/agent/memory");
  expect(await memoryPromptSection(dir)).toBe(""); // no file yet

  await fs.mkdir(path.dirname(memoryFilePath(dir)), { recursive: true });
  await fs.writeFile(memoryFilePath(dir), "## Gotchas\n- " + "x".repeat(MEMORY_INJECT_MAX_CHARS + 500));
  const block = await memoryPromptSection(dir);
  expect(block).toContain("<project_memory>");
  expect(block).toContain("…(memory truncated");
  expect(block.length).toBeLessThan(MEMORY_INJECT_MAX_CHARS + 400); // hard cap holds

  process.env.JOC_NO_MEMORY = "1";
  try {
    expect(await memoryPromptSection(dir)).toBe("");
  } finally {
    delete process.env.JOC_NO_MEMORY;
  }
  await fs.rm(dir, { recursive: true, force: true });
});
