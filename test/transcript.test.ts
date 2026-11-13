import { test, expect } from "bun:test";
import { formatTranscript } from "../src/tui/components/transcript";
import type { Message } from "../src/ai/types";
import chalk from "chalk";
import { CompactPasteStore } from "../src/commands/launch/input";

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

test("formatTranscript clips long assistant replies and handles empty history", () => {
  const long = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n");
  const messages: Message[] = [
    { role: "user", content: "inspect this report" },
    { role: "assistant", content: long },
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

test("formatTranscript renders persisted reasoning above the reply (think → answer)", () => {
  const messages: Message[] = [
    { role: "user", content: "what is 2+2" },
    {
      role: "assistant",
      content: JSON.stringify({ tool: "done", arguments: { reason: "It is 4." } }),
      reasoning: "Adding two and two gives four.",
    },
  ];
  const out = formatTranscript(messages, { color: false, unicode: true }).map(stripAnsi);
  const text = out.join("\n");
  expect(text).toContain("thinking");
  expect(text).toContain("Adding two and two gives four.");
  expect(text).toContain("It is 4.");
  // thinking comes BEFORE the answer
  expect(text.indexOf("Adding two and two")).toBeLessThan(text.indexOf("It is 4."));
});

test("formatTranscript: assistant turn without reasoning shows no thinking block", () => {
  const messages: Message[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: JSON.stringify({ tool: "done", arguments: { reason: "hello" } }) },
  ];
  const text = formatTranscript(messages, { color: false, unicode: true }).map(stripAnsi).join("\n");
  expect(text).not.toContain("thinking");
  expect(text).toContain("hello");
});

test("formatTranscript sanitizes tool paths and results without stripping its own colors", () => {
  const previousLevel = chalk.level;
  chalk.level = 1;
  try {
    const osc = "\x1b]52;c;Y2xpcGJvYXJk\x07";
    const cursor = "\x1b[2J";
    const messages: Message[] = [
      { role: "user", content: "Read the file" },
      { role: "assistant", content: JSON.stringify({ tool: "read", arguments: { filePath: `safe${osc}${cursor}name.txt` } }) },
      { role: "user", content: `Tool [read] result (ok):\nresult ${osc}${cursor}preserved` },
    ];
    const output = formatTranscript(messages, { color: true, unicode: true }).join("\n");
    expect(output).toMatch(/\x1b\[[0-9;]*m/);
    const plain = stripAnsi(output);
    expect(plain).toContain("safename.txt");
    expect(plain).toContain("result preserved");
    expect(plain).not.toContain("Y2xpcGJvYXJk");
    expect(plain).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  } finally {
    chalk.level = previousLevel;
  }
});

test("formatTranscript uses persisted compact display without replacing the canonical prompt", () => {
  const store = new CompactPasteStore();
  const display = `typed ${store.store("private-first\r\n한🙂\t$&")} after`;
  const content = store.expand(display);
  const message: Message = {
    role: "user", content,
    inputDisplay: store.snapshot(display, content),
  };
  const text = formatTranscript([message], { color: false }).join("\n");
  expect(text).toContain(display);
  expect(text).not.toContain("private-first");
  expect(message.content).toBe(content);
});

for (const { name, content, expected } of [
  { name: "ordinary typed line", content: "typed instruction", expected: "typed instruction" },
  { name: "1000-column boundary", content: "x".repeat(1000), expected: "x".repeat(1000) },
  { name: "1001-column large paste", content: "x".repeat(1001), expected: "[Paste #2, 1 lines, 1001 cols]" },
  { name: "legacy CRLF with Unicode", content: "한🙂\r\nwide", expected: "[Paste #2, 2 lines, 4 cols]" },
]) {
  test(`formatTranscript renders ${name} without exposing a legacy paste body`, () => {
    const text = formatTranscript([{ role: "user", content: "earlier" }, { role: "user", content }], { color: false }).join("\n");
    expect(text).toContain(`  ${expected}`);
    if (expected !== content) expect(text).not.toContain(content);
  });
}

test("formatTranscript classifies protocol feedback by canonical content before compact display", () => {
  const store = new CompactPasteStore();
  const display = store.store("real prompt");
  const messages: Message[] = [
    { role: "user", content: "real prompt", inputDisplay: store.snapshot(display, "real prompt") },
    { role: "assistant", content: JSON.stringify({ tool: "read", arguments: { path: "report.txt" } }) },
    { role: "user", content: "Tool [read] result (ok):\nread result", inputDisplay: { text: "not a new user prompt", pastes: [], textLength: 40 } },
    { role: "assistant", content: "answer" },
  ];
  const text = formatTranscript(messages, { color: false }).join("\n");
  expect(text).toContain("turn 1/1");
  expect(text).toContain(display);
  expect(text).toMatch(/✔ .*report\.txt/);
  expect(text).toContain("read result");
  expect(text).not.toContain("not a new user prompt");
});

test("formatTranscript image history keeps numbered references without image payload or terminal escapes", () => {
  const image = { mediaType: "image/png", data: Buffer.from("private-image-data").toString("base64") };
  const text = formatTranscript([{ role: "user", content: "compare screenshots", images: [image, image] }], { color: false }).join("\n");
  expect(text).toContain("#image01 #image02");
  expect(text).toContain("compare screenshots");
  expect(text).not.toContain(image.data);
  expect(text).not.toContain("\x1b_G");
  expect(text).not.toContain("\x1b]1337;File=");
});

for (const { name, inputDisplay } of [
  { name: "non-string display", inputDisplay: { text: 42, pastes: [], textLength: 4 } },
  { name: "inconsistent replacement", inputDisplay: { text: "DIFFERENT", pastes: [], textLength: 4 } },
  { name: "out-of-range hidden span", inputDisplay: { text: "[Paste #1, 1 lines, 4 cols]", pastes: [{ marker: "[Paste #1, 1 lines, 4 cols]", start: 0, end: 99 }], textLength: 4 } },
]) {
  test(`formatTranscript rejects ${name} metadata without losing canonical content`, () => {
    const messages = JSON.parse(JSON.stringify([{ role: "user", content: "SAFE", inputDisplay }]));
    const text = formatTranscript(messages, { color: false }).join("\n");
    expect(text).toContain("  SAFE");
    expect(text).not.toContain("DIFFERENT");
    expect(text).not.toContain("[Paste #1");
  });
}
