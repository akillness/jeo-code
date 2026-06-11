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

// cycle 11 (plan/gjc-inheritance.md): extend extraction to conservative bash
// mutation mentions, force a "Files touched:" header, surface touchedFiles.

test("extractTouchedFiles also captures conservative bash mutation mentions", () => {
  const messages = [
    { role: "user" as const, content: "Tool [bash] result (ok): created src/gen/out.ts and wrote dist/bundle.js" },
    { role: "user" as const, content: "Tool [bash] result (ok): wrote 1234 bytes to disk" }, // not path-shaped → ignored
    { role: "user" as const, content: "Tool [bash] result (ok): deleted tmp/old.log" },
    { role: "user" as const, content: "Tool [read] result (ok): file text mentions created not-a-real.ts" }, // not bash → ignored
  ];
  expect(extractTouchedFiles(messages)).toEqual(["src/gen/out.ts", "dist/bundle.js", "tmp/old.log"]);
});

test("maybeCompact surfaces touchedFiles and prepends a Files touched: header", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => "summary body only, no file list",
  }));
  const { maybeCompact } = await import("../src/agent/compaction");
  const history = [
    { role: "system" as const, content: "sys" },
    { role: "user" as const, content: "task" },
    { role: "assistant" as const, content: '{"tool":"write","arguments":{"filePath":"src/x.ts","content":"a"}}' },
    { role: "user" as const, content: "Tool [write] result (ok): ok" },
    { role: "assistant" as const, content: "did it" },
    { role: "user" as const, content: "next" },
    { role: "assistant" as const, content: "recent context here" },
  ];
  const res = await maybeCompact(history, { force: true, keepRecent: 2 });
  expect(res.compacted).toBe(true);
  expect(res.touchedFiles).toEqual(["src/x.ts"]);
  const summaryMsg = history.find(m => m.content.includes("[Earlier conversation summary]"));
  expect(summaryMsg?.content).toContain("Files touched: src/x.ts");
});
