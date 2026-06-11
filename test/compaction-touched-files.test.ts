import { test, expect, mock } from "bun:test";
import { extractTouchedFiles } from "../src/agent/compaction";

// gjc-style file-operation preservation in compaction (plan/gjc-inheritance.md B8):
// the files mutated in the summarized span are extracted mechanically and pinned
// into the summary prompt so post-compaction turns keep their file context.

test("extractTouchedFiles parses write/edit tool calls, dedupes, ignores reads", () => {
  const messages = [
    { role: "assistant" as const, content: '{"tool":"edit","arguments":{"filePath":"src/a.ts","editBlock":"x"}}' },
    { role: "assistant" as const, content: '{"reasoning":"w","tool":"write","arguments":{"filePath":"src/b.ts","content":"y"}}' },
    { role: "assistant" as const, content: '{"tool":"read","arguments":{"filePath":"src/ignored.ts"}}' },
    { role: "assistant" as const, content: '{"tools":[{"tool":"edit","arguments":{"filePath":"src/a.ts","editBlock":"z"}},{"tool":"edit","arguments":{"filePath":"src/c.ts","editBlock":"w"}}]}' },
    { role: "user" as const, content: 'Tool [edit] result (ok): {"tool":"edit","arguments":{"filePath":"src/not-assistant.ts"}}' },
  ];
  expect(extractTouchedFiles(messages)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
});

test("maybeCompact pins the touched-file list into the summary prompt", async () => {
  let seenSystemPrompt = "";
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (_m: unknown, opts: { systemPrompt?: string }) => {
      seenSystemPrompt = opts.systemPrompt ?? "";
      return "summary text";
    },
  }));
  const { maybeCompact } = await import("../src/agent/compaction");
  const history = [
    { role: "system" as const, content: "sys" },
    { role: "user" as const, content: "task" },
    { role: "assistant" as const, content: '{"tool":"edit","arguments":{"filePath":"src/agent/engine.ts","editBlock":"x"}}' },
    { role: "user" as const, content: "Tool [edit] result (ok): updated" },
    { role: "assistant" as const, content: "progress" },
    { role: "user" as const, content: "keep going" },
    { role: "assistant" as const, content: "more recent context" },
  ];
  const res = await maybeCompact(history, { force: true, keepRecent: 2 });
  expect(res.compacted).toBe(true);
  expect(seenSystemPrompt).toContain("Files touched in the summarized span");
  expect(seenSystemPrompt).toContain("src/agent/engine.ts");
});
