import { test, expect } from "bun:test";
import { formatTranscript } from "../src/tui/components/transcript";
import type { Message } from "../src/ai/types";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const turn = (prompt: string, tool: string, args: Record<string, unknown>, ok: boolean, reply: string): Message[] => [
  { role: "user", content: prompt },
  { role: "assistant", content: JSON.stringify({ tool, arguments: args }) },
  { role: "user", content: `Tool [${tool}] result (${ok ? "ok" : "fail"}):\nsome output` },
  { role: "assistant", content: JSON.stringify({ tool: "done", arguments: { reason: reply } }) },
];

test("formatTranscript folds engine history into user/tool/jeo blocks", () => {
  const messages: Message[] = [
    { role: "system", content: "system prompt" },
    ...turn("read package.json", "read", { filePath: "package.json" }, true, "name is jeo-code"),
  ];
  const out = formatTranscript(messages, { color: false, unicode: true }).map(stripAnsi);
  const text = out.join("\n");
  expect(text).toContain("─ turn 1/1");
  expect(text).toContain("user ▸");
  expect(text).toContain("  read package.json"); // prompt body, indented
  expect(text).toMatch(/✔ .*package\.json/);      // compact tool ledger line
  expect(text).toContain("some output");        // first result line is folded into the activity row
  expect(text).toContain("jeo ◂");
  expect(text).toContain("  name is jeo-code");
  expect(text).not.toContain("system prompt");     // system never shown
  expect(text).not.toContain("Tool [read] result"); // raw feedback folded away
});

test("formatTranscript marks failing tools and skips protocol bounces", () => {
  const messages: Message[] = [
    { role: "user", content: "run it" },
    { role: "assistant", content: JSON.stringify({ tool: "bash", arguments: { command: "false" } }) },
    { role: "user", content: "Tool [bash] result (fail):\nexit 1" },
    { role: "assistant", content: "not json at all" },
    { role: "user", content: "Your last reply was not a valid tool call (oops). Do NOT apologize." },
  ];
  const out = formatTranscript(messages, { color: false, unicode: true }).map(stripAnsi).join("\n");
  expect(out).toMatch(/✗ .*bash/i);                // failure glyph from the result verdict
  expect(out).toContain("  not json at all");      // prose reply shown as jeo block
  expect(out).not.toContain("Your last reply");    // correction bounce hidden
});

test("formatTranscript maxTurns keeps only the last n exchanges with a hidden marker", () => {
  const messages: Message[] = [
    ...turn("first request", "read", { filePath: "a.ts" }, true, "did first"),
    ...turn("second request", "read", { filePath: "b.ts" }, true, "did second"),
    ...turn("third request", "read", { filePath: "c.ts" }, true, "did third"),
  ];
  const out = formatTranscript(messages, { color: false, maxTurns: 1 }).map(stripAnsi).join("\n");
  expect(out).toContain("2 earlier turn(s) hidden");
  expect(out).toContain("third request");
  expect(out).not.toContain("first request");
  expect(out).not.toContain("second request");
  const all = formatTranscript(messages, { color: false }).map(stripAnsi).join("\n");
  expect(all).toContain("first request");
  expect(all).not.toContain("hidden");
});

test("formatTranscript clips long bodies and handles empty history", () => {
  const long = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n");
  const messages: Message[] = [
    { role: "user", content: long },
    { role: "assistant", content: "short answer" },
  ];
  const out = formatTranscript(messages, { color: false, bodyLines: 4 }).map(stripAnsi).join("\n");
  expect(out).toContain("line-3");
  expect(out).not.toContain("line-4\n");
  expect(out).toContain("(+16 more lines)");
  expect(formatTranscript([{ role: "system", content: "s" }], { color: false }).join("\n")).toContain("no worked history yet");
});

test("formatTranscript renders BATCHED tool calls as ledger lines, not raw JSON (/resume fix)", () => {
  const batch = JSON.stringify({
    reasoning: "look at both",
    tools: [
      { tool: "read", arguments: { filePath: "a.ts" } },
      { tool: "search", arguments: { pattern: "foo" } },
    ],
  });
  const messages: Message[] = [
    { role: "user", content: "inspect a.ts and find foo" },
    { role: "assistant", content: batch },
    { role: "user", content: "Tool [read] result (ok):\nfile a.ts contents\n\nTool [search] result (fail):\nno matches" },
    { role: "assistant", content: JSON.stringify({ tool: "done", arguments: { reason: "done looking" } }) },
  ];
  const out = formatTranscript(messages, { color: false, unicode: true }).map(stripAnsi).join("\n");
  // One compact ledger line PER batched call, with the right per-call verdict glyph.
  const ledgerLines = out.split("\n").filter(l => /^\s+[✔✗]\s/.test(l));
  expect(ledgerLines.length).toBe(2);
  expect(out).toMatch(/✔ .*a\.ts/); // read ok
  expect(out).toContain("✗");        // search fail verdict from the second result block
  // The raw batch JSON must NEVER leak into the transcript (the bug being fixed).
  expect(out).not.toContain('"tools"');
  expect(out).not.toContain('"reasoning"');
  expect(out).not.toContain("[{");
  expect(out).toContain("  done looking");
});
test("formatTranscript renders a ```json-FENCED tool call as a card, not raw JSON (/resume fix)", () => {
  const fenced = "```json\n" + JSON.stringify({
    reasoning: "run echo",
    tool: "bash",
    arguments: { command: "echo v0514_ok" },
  }, null, 2) + "\n```";
  const messages: Message[] = [
    { role: "user", content: "echo v0514_ok 를 bash로 실행" },
    { role: "assistant", content: fenced },
    { role: "user", content: "Tool [bash] result (ok):\nv0514_ok" },
    { role: "assistant", content: JSON.stringify({ tool: "done", arguments: { reason: "ran it" } }) },
  ];
  const out = formatTranscript(messages, { color: false, unicode: true }).map(stripAnsi).join("\n");
  expect(out).toMatch(/✔ .*[Bb]ash/);       // rendered as a tool card
  expect(out).not.toContain("```json");      // the fence is gone
  expect(out).not.toContain('"reasoning"');  // raw JSON never leaks
  expect(out).not.toContain('"arguments"');
  expect(out).toContain("ran it");
});

test("formatTranscript keeps a prose reply that merely CONTAINS a JSON snippet", () => {
  const prose = 'You can call it like {"tool":"bash"} — here is what that means in practice.';
  const messages: Message[] = [
    { role: "user", content: "how do tool calls look?" },
    { role: "assistant", content: prose },
  ];
  const out = formatTranscript(messages, { color: false, unicode: true }).map(stripAnsi).join("\n");
  expect(out).toContain("here is what that means"); // prose preserved, not dropped/misrendered
});
