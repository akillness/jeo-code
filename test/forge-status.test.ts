import { test, expect, spyOn } from "bun:test";
import chalk from "chalk";
import {
  editBlockDiffLines,
  formatForgeBox,
  progressPercent,
  redactSecrets,
  renderJeoStatus,
  summarizeForgeInvocation,
  summarizeForgeResult,
} from "../src/tui/components";
import { renderWelcome } from "../src/tui/components/welcome";
import { buildRalphSubagentPrompt, formatRalphStreamEvent, formatRalphTodoGuide } from "../src/commands/team";
import { visibleWidth } from "../src/tui/components/width";
import { stripInlineMarkdown } from "../src/tui/components/markdown-text";
import { renderStatusBox } from "../src/tui/components/status";
import { ColorLevel } from "../src/tui/components/color";
import { applyDimensionalGradient } from "../src/tui/components/evolution";
import { parseChangelogSections, changelogText } from "../src/util/whats-new";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("summarizeForgeInvocation renders bash, read, and write as code-box summaries", () => {
  const bash = summarizeForgeInvocation("bash", { command: "echo hello", timeoutMs: 5000 });
  expect(bash.title).toBe("Bash");
  expect(bash.language).toBe("bash");
  expect(bash.lines).toContain("$ echo hello");

  const read = summarizeForgeInvocation("read", { filePath: "src/app.ts", lineRange: "1-20" });
  expect(read.title).toBe("Read src/app.ts:1-20");
  expect(read.lines).toEqual(["path: src/app.ts"]);

  const write = summarizeForgeInvocation("write", { path: "out.txt", content: "a\nb" });
  expect(write.title).toBe("Write out.txt");
  expect(write.lines).toContain("wrote 2 lines, 3 bytes");
});

test("summarizeForgeInvocation: single-task form renders role/task/context (unchanged pre-existing shape)", () => {
  const single = summarizeForgeInvocation("task", { role: "architect", task: "review the auth module", context: "focus on token refresh" });
  expect(single.title).toBe("Task: architect");
  expect(single.lines).toContain("review the auth module");
  expect(single.lines).toContain("context:");
  expect(single.lines).toContain("focus on token refresh");
});

test("summarizeForgeInvocation: fan-out 'tasks' array form renders a numbered per-task preview, not '<missing task>'", () => {
  // Live-reproduced (v0.8.42): a real 3-item fan-out call previously rendered
  // nothing but a bare "<missing task>" placeholder — the preview only ever
  // read a single task/prompt/assignment string, never the batch array.
  const batch = summarizeForgeInvocation("task", {
    role: "executor",
    tasks: [
      "append a comment to src/a/index.ts",
      { task: "append a comment to src/b/index.ts" },
      { assignment: "append a comment to src/c/index.ts" },
    ],
  });
  expect(batch.title).toBe("Task: executor ×3");
  expect(batch.lines).toEqual([
    "1. append a comment to src/a/index.ts",
    "2. append a comment to src/b/index.ts",
    "3. append a comment to src/c/index.ts",
  ]);
  expect(batch.lines.join("\n")).not.toContain("<missing task>");
});

test("summarizeForgeInvocation: 'tasks' array entries truncate long/multiline text to a single preview line", () => {
  const longText = "x".repeat(200);
  const batch = summarizeForgeInvocation("task", { tasks: [longText, "line one\nline two"] });
  expect(batch.lines[0]).toBe(`1. ${"x".repeat(120)}…`);
  expect(batch.lines[1]).toBe("2. line one…");
});

test("summarizeForgeInvocation: an empty/malformed 'tasks' array shows a clear placeholder instead of a bare 0-title", () => {
  const empty = summarizeForgeInvocation("task", { tasks: [] });
  expect(empty.title).toBe("Task: executor ×0");
  expect(empty.lines).toEqual(["<missing tasks>"]);

  const allBlank = summarizeForgeInvocation("task", { tasks: ["", { task: "" }, 42] });
  expect(allBlank.lines).toEqual(["<missing tasks>"]);
});

test("summarizeForgeInvocation: a JSON-STRINGIFIED 'tasks' array (the exact live-reproduced model mistake createTaskTool's handler now also tolerates) previews correctly instead of falling to '<missing task>'", () => {
  const batch = summarizeForgeInvocation("task", { role: "executor", tasks: JSON.stringify(["append to a.ts", "append to b.ts"]) });
  expect(batch.title).toBe("Task: executor ×2");
  expect(batch.lines).toEqual(["1. append to a.ts", "2. append to b.ts"]);
  expect(batch.lines.join("\n")).not.toContain("<missing task>");
});

test("summarizeForgeInvocation: a 'tasks' string that is not valid JSON (or parses to a non-array) falls through to the single-task placeholder, never throws", () => {
  const notJson = summarizeForgeInvocation("task", { tasks: "append to a.ts, append to b.ts" });
  expect(notJson.title).toBe("Task: executor");
  expect(notJson.lines).toEqual(["<missing task>"]);

  const jsonButNotArray = summarizeForgeInvocation("task", { tasks: JSON.stringify({ not: "an array" }) });
  expect(jsonButNotArray.title).toBe("Task: executor");
  expect(jsonButNotArray.lines).toEqual(["<missing task>"]);
});

test("forge boxes are width-bounded and redact secret-like values", () => {
  expect(redactSecrets("API_KEY=abcdef token: secret-value")).toContain("<redacted>");
  const summary = summarizeForgeResult("bash", false, "password=abc123\nline two");
  const box = formatForgeBox(summary, { width: 36, unicode: false, paint: s => s }).map(stripAnsi);
  // jeo-ref anatomy: the title rides ON the top border instead of its own row.
  expect(box[0]!.startsWith("+--")).toBe(true);
  expect(box[0]!.endsWith("+")).toBe(true);
  expect(box[0]).toContain("bash result failed");
  expect(box.some(line => line.includes("<redacted>"))).toBe(true);
  expect(box.every(line => line.length <= 36)).toBe(true);
});

test("forge cards keep CJK/emoji content inside the border (display-width wrap)", () => {
  // Wide glyphs (Hangul, CJK, emoji) are 2 columns each. Wrapping by code-point
  // count let a Korean line render ~2× wide and tore the right edge — every row
  // must measure exactly the card width regardless of content script.
  const summary = summarizeForgeResult(
    "bash",
    true,
    "한국어 출력 라인입니다 이것은 매우 긴 한글 문자열이고 카드 너비를 초과합니다 정렬 테스트 emoji 🚀🔥 mixed ASCII",
  );
  for (const width of [32, 40, 60]) {
    const box = formatForgeBox(summary, { width, unicode: true, color: false, paint: s => s });
    for (const line of box) expect(visibleWidth(line)).toBe(width);
  }
});

test("welcome forge uses right-side metadata table only on wide terminals", () => {
  const data = {
    version: "0.7.27",
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    cwd: "/Users/jangyoung/.superset/projects/jeo-code",
    thinking: "medium",
    sessionId: "abcdef123456",
    contextFiles: ["AGENTS.md", "src/tui/components/welcome.ts", "package.json", "README.md"],
    unicode: true,
    color: false,
  };

  const wide = renderWelcome({ ...data, cols: 120 });
  expect(wide.some(line => line.includes("What's New"))).toBe(true);
  // Release-agnostic: the panel mirrors the NEWEST changelog section (welcome.ts's
  // `getLatestChangelogItems`), so assert against that source of truth instead of one
  // release's headline text — the pinned string broke on every version bump.
  const newestSection = parseChangelogSections(changelogText).find(s => s.groups.some(g => g.items.length > 0));
  const headline = stripInlineMarkdown(newestSection?.groups.flatMap(g => g.items)[0] ?? "");
  expect(headline.length).toBeGreaterThan(20);
  expect(wide.join("\n")).toContain(headline.slice(0, 20));
  expect(wide.join("\n")).not.toContain("• **");
  expect(wide.some(line => line.includes("Flow keys"))).toBe(true);
  expect(wide.some(line => line.includes("Project pulse"))).toBe(true);
  for (const line of wide) expect(visibleWidth(line)).toBeLessThanOrEqual(119);

  const narrow = renderWelcome({ ...data, cols: 80 });
  expect(narrow.some(line => line.includes("What's New"))).toBe(false);
  for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(79);
});

test("forge summaries never throw on an undefined/empty tool name (malformed model output)", () => {
  // A model can emit a tool call with no `tool` field; the TUI must not crash.
  const inv = summarizeForgeInvocation(undefined as unknown as string, { foo: 1 });
  expect(inv.title).toContain("(no tool)");
  const res = summarizeForgeResult(undefined as unknown as string, false, "boom");
  expect(res.title).toContain("(no tool)");
  expect(() => formatForgeBox(inv, { width: 40, unicode: false, paint: s => s })).not.toThrow();
});

test("renderJeoStatus separates progress, insight status, and forge rows", () => {
  expect(progressPercent(3, 10)).toBe(30);
  const lines = renderJeoStatus({
    step: 3,
    maxSteps: 10,
    elapsedMs: 2400,
    message: "Resolving type boundaries...",
    currentTool: "bash",
    okCount: 2,
    failCount: 1,
    runningCount: 1,
    totalCount: 4,
    mutationGuarded: true,
    unicode: false,
  }).map(stripAnsi);
  expect(lines[0]).toContain("[STEP]");
  expect(lines[0]).toContain("elapsed 2s");
  expect(lines[0]).not.toContain("Resolving type boundaries");
  expect(lines[1]).toContain("[STATUS]");
  expect(lines[1]).toContain("jeo status");
  expect(lines[1]).toContain("Resolving type boundaries");
  expect(lines[2]).toContain("jeo forge");
  expect(lines[2]).toContain("tools 4 (2 ok / 1 fail / 1 running)");
  expect(lines[2]).toContain("mutation locked");
});

test("renderJeoStatus colorizes the forge count segments when color is on", () => {
  const prev = chalk.level;
  chalk.level = 3;
  try {
    const lines = renderJeoStatus({
      step: 3,
      maxSteps: 10,
      elapsedMs: 2400,
      message: "Resolving type boundaries...",
      currentTool: "bash",
      okCount: 2,
      failCount: 1,
      runningCount: 1,
      totalCount: 4,
      mutationGuarded: true,
      unicode: false,
      color: true,
    });
    expect(lines[2]).toContain("\x1b[");
    expect(stripAnsi(lines[2]!)).toContain("tools 4 (2 ok / 1 fail / 1 running)");
  } finally {
    chalk.level = prev;
  }
});

test("ralph guide renders ordered todos and streaming complete/error events", () => {
  const guide = formatRalphTodoGuide(["Plan", "Implement", "Verify"], 1, ["Plan"]);
  expect(guide).toEqual([
    "[RALPH] Subagent guidance: follow todos in order; stream every step, complete, and error event.",
    "[TODO] 1/3 [x] Plan",
    "[TODO] 2/3 [>] Implement",
    "[TODO] 3/3 [ ] Verify",
  ]);
  expect(formatRalphStreamEvent("step", "Executor thinking 1/15")).toBe("  └─ stream:step Executor thinking 1/15");
  expect(formatRalphStreamEvent("complete", "tool bash")).toBe("  └─ stream:complete tool bash");
  expect(formatRalphStreamEvent("error", "tool write")).toBe("  └─ stream:error tool write");
});

test("ralph render helpers can colorize subagent guidance and stream events", () => {
  const prev = chalk.level;
  chalk.level = 3;
  try {
    const guide = formatRalphTodoGuide(["Plan", "Implement"], 1, ["Plan"], { color: true, indexed: true });
    expect(guide[0]).toContain("\x1b[");
    expect(stripAnsi(guide[0]!)).toContain("[AGENT] Subagent guidance:");
    expect(formatRalphStreamEvent("error", "tool write", { color: true, indexed: true })).toContain("\x1b[");
  } finally {
    chalk.level = prev;
  }
});

test("ralph subagent prompt carries full todo order and streaming contract", () => {
  const prompt = buildRalphSubagentPrompt({
    task: "Implement",
    tasks: ["Plan", "Implement", "Verify"],
    activeIndex: 1,
    completed: ["Plan"],
  });
  expect(prompt).toContain("ooo ralph subagent");
  expect(prompt).toContain("[TODO] 1/3 [x] Plan");
  expect(prompt).toContain("[TODO] 2/3 [>] Implement");
  expect(prompt).toContain("[TODO] 3/3 [ ] Verify");
  expect(prompt).toContain("Execute ONLY the current [>] todo");
  expect(prompt).toContain("stream:step, stream:complete, and stream:error");
});
import { fitForgeBoxes } from "../src/tui/components/forge";

test("fitForgeBoxes: includes whole most-recent boxes within budget, never a half-box", () => {
  // two 4-line boxes separated by a blank line (9 lines total)
  const box = (n: number) => [`+---${n}---+`, `|head ${n}|`, `|body ${n}|`, `+-------+`];
  const lines = [...box(1), "", ...box(2)];
  expect(lines.length).toBe(9);

  // ample budget → everything
  expect(fitForgeBoxes(lines, 99)).toEqual(lines);

  // budget fits exactly one box (4) but not two (4+1+4=9) → keep the MOST RECENT (box 2), whole
  const one = fitForgeBoxes(lines, 5);
  expect(one).toEqual(box(2));
  expect(one).not.toContain(""); // no dangling separator

  // budget below a single box → nothing (better than a broken half-box)
  expect(fitForgeBoxes(lines, 3)).toEqual([]);
  expect(fitForgeBoxes(lines, 0)).toEqual([]);

  // both fit exactly → both, in display order with the separator
  expect(fitForgeBoxes(lines, 9)).toEqual(lines);
});

test("renderJeoStatus: forge line exposes the evolution stage (double helix) when provided", () => {
  const lines = renderJeoStatus({
    step: 4, maxSteps: 25, currentTool: "read",
    stage: "●●○○○ Double Helix (DNA) [2/5]",
    color: false, unicode: true,
  });
  const forgeLine = lines[2] ?? "";
  expect(forgeLine).toContain("jeo forge");
  expect(forgeLine).toContain("Double Helix (DNA)"); // stage identity exposed
  expect(forgeLine).toContain("forging read");        // current tool still shown
  // without a stage, the forge line omits it (no leading separator noise)
  const plain = renderJeoStatus({ step: 1, maxSteps: 25, color: false });
  expect(plain[2] ?? "").not.toContain("Double Helix");
});

test("summarizeForgeInvocation and summarizeForgeResult polish and status step stats", () => {
  // 1. bash cwd-relative note and line budget
  const bashInv = summarizeForgeInvocation("bash", { command: "echo line1\necho line2", cwd: "my-subdir" });
  expect(bashInv.lines).toContain("# cwd-relative: my-subdir");
  expect(bashInv.lines.filter(l => !l.startsWith("#"))).toHaveLength(2);

  // Check no cwd-relative when absent
  const bashNoCwd = summarizeForgeInvocation("bash", { command: "echo hello" });
  expect(bashNoCwd.lines.some(l => l.includes("cwd-relative"))).toBe(false);

  // 2. write language tag from extension
  const writeTs = summarizeForgeInvocation("write", { path: "src/main.ts", content: "const a = 1;" });
  expect(writeTs.language).toBe("typescript");
  expect(writeTs.lines.find(l => l.includes("wrote 1 lines, 12 bytes · typescript"))).toBeDefined();

  const writeUnknown = summarizeForgeInvocation("write", { path: "foo.unknown", content: "hello" });
  expect(writeUnknown.lines.find(l => l.includes("wrote 1 lines, 5 bytes"))).toBeDefined();
  expect(writeUnknown.language).toBe("text");

  // 3. read with absent lineRange has # preview marker
  const readNoRange = summarizeForgeInvocation("read", { filePath: "src/app.ts" });
  expect(readNoRange.lines).toEqual(["path: src/app.ts"]);

  // Regression check: read with present lineRange does not have # preview, and contains range: 1-20
  const readWithRange = summarizeForgeInvocation("read", { filePath: "src/app.ts", lineRange: "1-20" });
  expect(readWithRange.lines).toEqual(["path: src/app.ts"]);

  // 4. bash result: trailing exit note only on failure, redaction regression
  const bashResultOk = summarizeForgeResult("bash", true, "success api-key=abc12345");
  expect(bashResultOk.lines[0]).toContain("fdiv:Output");
  expect(bashResultOk.lines[1]).toContain("<redacted>");
  expect(bashResultOk.lines.some(l => l.includes("Command"))).toBe(false);

  const bashResultFail = summarizeForgeResult("bash", false, "Exit code 1\nerror token: mysecret");
  expect(bashResultFail.lines[1]).toContain("<redacted>");
  expect(bashResultFail.lines[bashResultFail.lines.length - 1]).toBe("Command exited with code 1");

  // 5. renderJeoStatus with stepElapsedMs and avgStepMs
  const statusLines = renderJeoStatus({
    step: 5,
    maxSteps: 10,
    elapsedMs: 5000,
    stepElapsedMs: 12300,
    avgStepMs: 8100,
    color: false,
  }).map(stripAnsi);
  expect(statusLines[0]).toContain("elapsed 5s");
  expect(statusLines[0]).toContain("now 12.3s");
  expect(statusLines[0]).toContain("avg 8.1s");
});
test("bash invocation card echoes `$ <command>` and a unicode ⟦Timeout⟧ annotation", () => {
  const inv = summarizeForgeInvocation("bash", { command: "echo hi", timeoutMs: 5000 });
  expect(inv.lines[0]).toBe("$ echo hi");
  expect(inv.lines.some(l => l === "⟦Timeout: 5s⟧")).toBe(true);

  // No timeout → no annotation; non-integer seconds keep one decimal.
  const noTimeout = summarizeForgeInvocation("bash", { command: "ls" });
  expect(noTimeout.lines.some(l => l.includes("Timeout"))).toBe(false);
  const odd = summarizeForgeInvocation("bash", { command: "ls", timeoutMs: 1500 });
  expect(odd.lines.some(l => l === "⟦Timeout: 1.5s⟧")).toBe(true);
});

test("bash invocation card falls back to ASCII [Timeout: …] when unicode is off", () => {
  const inv = summarizeForgeInvocation("bash", { command: "echo hi", timeoutMs: 300000 }, { unicode: false });
  expect(inv.lines[0]).toBe("$ echo hi");
  expect(inv.lines.some(l => l === "[Timeout: 300s]")).toBe(true);
  expect(inv.lines.some(l => l.includes("⟦"))).toBe(false);
});

test("bash result card draws an `Output` divider between exit note and body, framing intact", () => {
  const summary = summarizeForgeResult("bash", true, "build complete");
  const box = formatForgeBox(summary, { width: 40, unicode: true, paint: s => s, color: false }).map(stripAnsi);
  // matched unicode borders
  expect(box[0]!.startsWith("╭")).toBe(true);
  expect(box[0]!.endsWith("╮")).toBe(true);
  expect(box[box.length - 1]!.startsWith("╰")).toBe(true);
  expect(box[box.length - 1]!.endsWith("╯")).toBe(true);
  // jeo-ref anatomy: the title rides ON the top border (`╭── ✓ bash … ──╮`)
  expect(box[0]).toContain("bash result ok");
  // a labeled divider rule appears, carrying the Output label, and no raw sentinel leaks
  const divider = box.find(l => l.includes(" Output ") && l.includes("─"));
  expect(divider).toBeDefined();
  expect(box.some(l => l.includes("fdiv:"))).toBe(false);
  // content rows carry a 1-column gutter so text never touches the frame
  const contentRow = box.find(l => l.includes("build complete"));
  expect(contentRow).toBeDefined();
  expect(contentRow!.startsWith("│ ")).toBe(true);
  // every row is exactly the box width (column-correct framing)
  expect(box.every(l => l.length === 40)).toBe(true);
});

test("bash result divider uses ASCII rules under unicode:false and stays width-bounded", () => {
  const summary = summarizeForgeResult("bash", false, "boom\nmore");
  const box = formatForgeBox(summary, { width: 32, unicode: false, paint: s => s, color: false }).map(stripAnsi);
  // title-in-border: leading rule, label, trailing rule — full width preserved
  expect(box[0]!.startsWith("+--")).toBe(true);
  expect(box[0]!.endsWith("+")).toBe(true);
  expect(box[0]).toContain("bash result failed");
  expect(box[box.length - 1]).toBe("+" + "-".repeat(30) + "+");
  const divider = box.find(l => l.includes(" Output ") && l.includes("-"));
  expect(divider).toBeDefined();
  expect(divider!.startsWith("|") && divider!.endsWith("|")).toBe(true);
  expect(box.every(l => l.length <= 32)).toBe(true);
});

test("forge box two-tone depth: bottom border + right edge use the shadow painter", () => {
  const lit = (s: string) => `<L>${s}</L>`;
  const shadow = (s: string) => `<S>${s}</S>`;
  const summary = summarizeForgeResult("bash", true, "hello world");
  const box = formatForgeBox(summary, { width: 36, unicode: false, paint: lit, paintShadow: shadow });
  // Top border lit, bottom border shaded.
  expect(box[0]!).toContain("<L>");
  expect(box[0]!).not.toContain("<S>");
  expect(box[box.length - 1]!).toContain("<S>");
  expect(box[box.length - 1]!).not.toContain("<L>");
  // Interior rows end on the shaded right edge.
  for (const row of box.slice(1, -1)) {
    expect(row.endsWith("<S>|</S>")).toBe(true);
  }
});

test("forge box color:false keeps single-tone borders byte-stable", () => {
  const summary = summarizeForgeResult("bash", true, "hello");
  const box = formatForgeBox(summary, { width: 30, unicode: false, color: false, paint: s => s });
  for (const row of box) {
    expect(row).not.toContain("\x1b[");
  }
});

test("edit card renders SEARCH/REPLACE hunks as -/+ diff lines with a hunk summary", () => {
  const block = "<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 2;\nconst b = 3;\n>>>>>>>";
  const card = summarizeForgeInvocation("edit", { filePath: "src/x.ts", editBlock: block });
  expect(card.title).toBe("Edit : src/x.ts");
  expect(card.lines).toContain("- const a = 1;");
  expect(card.lines).toContain("+ const a = 2;");
  expect(card.lines).toContain("+ const b = 3;");
  expect(card.lines[card.lines.length - 1]).toBe("~1 hunk(s) · +2 −1 line(s)");
});

test("edit card renders ≔ directives as +added lines; unknown formats fall back to raw preview", () => {
  const card = summarizeForgeInvocation("edit", { filePath: "a.ts", editBlock: "≔3..4\nnew line one\nnew line two" });
  expect(card.lines[0]).toBe("≔3..4");
  expect(card.lines).toContain("+ new line one");
  expect(card.lines).toContain("+ new line two");
  expect(card.lines[card.lines.length - 1]).toContain("+2 line(s)");
  // Malformed hunk (no divider) → raw preview fallback, never a throw.
  const raw = summarizeForgeInvocation("edit", { filePath: "a.ts", editBlock: "<<<<<<< SEARCH\noops" });
  expect(raw.lines.join("\n")).toContain("oops");
});

test("clipped cards show the gjc-style ⟦Ctrl+O for more⟧ hint", () => {
  const summary = { title: "Bash", language: "bash", lines: Array.from({ length: 20 }, (_, i) => `line ${i}`) };
  const uni = formatForgeBox(summary, { width: 60, maxLines: 4, paint: s => s, color: false }).map(stripAnsi);
  expect(uni.some(l => l.includes("… 16 more lines ⟦Ctrl+O for more⟧"))).toBe(true);
  const ascii = formatForgeBox(summary, { width: 60, maxLines: 4, unicode: false, paint: s => s, color: false }).map(stripAnsi);
  expect(ascii.some(l => l.includes("[Ctrl+O for more]"))).toBe(true);
});

test("code cards get a light highlight when color is on; color:false stays byte-stable", () => {
  // bun test runs without a TTY → chalk auto-disables; force truecolor so the
  // highlight path is observable, then restore.
  const prevLevel = chalk.level;
  chalk.level = 3;
  try {
    const summary = { title: "Bash", language: "bash", lines: ['const ed = await tab.waitFor("div.editor");'] };
    const colored = formatForgeBox(summary, { width: 70, paint: s => s, color: true }).join("\n");
    expect(colored).toContain("\x1b["); // string literal / keyword coloring applied
    const plain = formatForgeBox(summary, { width: 70, paint: s => s, color: false }).join("\n");
    expect(plain).not.toContain("\x1b[");
    expect(plain).toContain('const ed = await tab.waitFor("div.editor");');
  } finally {
    chalk.level = prevLevel;
  }
});

test("summarize-stage clip markers (previewLines '… N more line(s)') also gain the Ctrl+O hint", () => {
  // A bash result clipped by previewLines BEFORE the box ever sees it — the
  // field case where '… 36 more line(s)' rendered without a reachable path.
  const summary = summarizeForgeResult("bash", true, Array.from({ length: 40 }, (_, i) => String(i + 1)).join("\n"));
  const box = formatForgeBox(summary, { width: 60, maxLines: 12, paint: s => s, color: false }).map(stripAnsi).join("\n");
  expect(box).toMatch(/… \d+ more line\(s\) ⟦Ctrl\+O for more⟧/);
});

test("formatForgeBox: fill painter tints every row (panel) without changing visible width", () => {
  const summary = summarizeForgeResult("bash", true, "build complete");
  const fill = (s: string) => `«bg»${s}«/bg»`;
  const width = 40;
  const box = formatForgeBox(summary, { width, unicode: false, color: false, paint: s => s, fill });
  // Every box row — top border, content, bottom border — is wrapped by the fill.
  expect(box.every(l => l.startsWith("«bg»") && l.endsWith("«/bg»"))).toBe(true);
  // The tint is zero-width chrome: the box keeps its exact column width.
  for (const line of box) {
    expect(visibleWidth(line.replace(/«\/?bg»/g, ""))).toBe(width);
  }
  // No fill painter → rows are returned untinted (back-compat).
  const bare = formatForgeBox(summary, { width, unicode: false, color: false, paint: s => s });
  expect(bare.some(l => l.includes("«bg»"))).toBe(false);
});

test("redactSecrets redacts Authorization Bearer and standalone Bearer tokens completely", () => {
  const auth = redactSecrets("Authorization: Bearer sk-secret-123");
  expect(auth).not.toContain("sk-secret-123");
  expect(auth).toContain("<redacted>");

  const standalone = redactSecrets("Bearer sk-secret-123");
  expect(standalone).not.toContain("sk-secret-123");
  expect(standalone).toContain("<redacted>");

  const embedded = redactSecrets("curl -H 'Authorization: Bearer sk-secret-123' https://api.example.com");
  expect(embedded).not.toContain("sk-secret-123");
  expect(embedded).toContain("https://api.example.com");
});

test("summarizeForgeInvocation('task'): sanitizes escapes and redacts secrets in role, task, context, and tasks[]", () => {
  const single = summarizeForgeInvocation("task", {
    role: "exec\x1b[2Jutor Bearer sk-secret-123",
    task: "fetch \u009b2J with Authorization: Bearer sk-secret-123",
    context: "header \x1b]0;evil\x07 api_key=topsecret99",
  });
  const singleText = [single.title, ...single.lines].join("\n");
  expect(singleText).not.toContain("\x1b");
  expect(singleText).not.toContain("\u009b");
  expect(singleText).not.toContain("\x07");
  expect(singleText).not.toContain("sk-secret-123");
  expect(singleText).not.toContain("topsecret99");
  expect(singleText).toContain("<redacted>");

  const batch = summarizeForgeInvocation("task", {
    role: "rev\x1b[2Jiewer token=secret-role-tok",
    tasks: [
      "scan \x1b[2Jfile with Bearer sk-secret-123",
      { task: "check \u009d0;evil\u0007 Authorization: Bearer sk-secret-123" },
    ],
  });
  const batchText = [batch.title, ...batch.lines].join("\n");
  expect(batchText).not.toContain("\x1b");
  expect(batchText).not.toContain("\u009d");
  expect(batchText).not.toContain("\x07");
  expect(batchText).not.toContain("sk-secret-123");
  expect(batchText).not.toContain("secret-role-tok");
  expect(batchText).toContain("<redacted>");
});

test("summarizeForgeInvocation('task'): caps tasks[] batches >6 items with an omission marker while keeping 1-6 contracts", () => {
  const tasks = Array.from({ length: 9 }, (_, i) => `task item ${i + 1}`);
  const batch = summarizeForgeInvocation("task", { role: "executor", tasks });
  expect(batch.title).toBe("Task: executor ×9");
  expect(batch.lines.slice(0, 6)).toEqual([
    "1. task item 1",
    "2. task item 2",
    "3. task item 3",
    "4. task item 4",
    "5. task item 5",
    "6. task item 6",
  ]);
  expect(batch.lines.length).toBe(7);
  expect(batch.lines[6]).toContain("…");
  expect(batch.lines[6]).toContain("3");
  expect(batch.lines.join("\n")).not.toContain("task item 7");
  expect(batch.lines.join("\n")).not.toContain("task item 9");

  const exactSix = summarizeForgeInvocation("task", {
    role: "executor",
    tasks: Array.from({ length: 6 }, (_, i) => `item ${i + 1}`),
  });
  expect(exactSix.lines.length).toBe(6);
  expect(exactSix.lines[5]).toBe("6. item 6");
});

test("redactSecrets handles prefixed JSON keys, quoted secrets with spaces, escaped JSON quotes, and skips hyphenated prose", () => {
  const jsonPrefixed = redactSecrets('{"access_token":"tok-111","openai_api_key":"sk-222","db_password":"pw-333"}');
  expect(jsonPrefixed).not.toContain("tok-111");
  expect(jsonPrefixed).not.toContain("sk-222");
  expect(jsonPrefixed).not.toContain("pw-333");
  expect(jsonPrefixed).toContain('"access_token"');
  expect(jsonPrefixed).toContain('"openai_api_key"');
  expect(jsonPrefixed).toContain('"db_password"');

  const quotedSpaces = redactSecrets('password="my secret pass" token=\'other secret val\'');
  expect(quotedSpaces).not.toContain("my secret pass");
  expect(quotedSpaces).not.toContain("secret pass");
  expect(quotedSpaces).not.toContain("other secret val");
  expect(quotedSpaces).not.toContain("secret val");
  expect(quotedSpaces).toContain("<redacted>");

  const escapedQuote = redactSecrets('{"token":"abc\\"def"}');
  expect(escapedQuote).not.toContain("abc");
  expect(escapedQuote).not.toContain("def");
  expect(escapedQuote).toContain('"<redacted>"');

  expect(redactSecrets("the bearer non-refundable")).toBe("the bearer non-refundable");
  expect(redactSecrets("bearer non-transferable ticket")).toBe("bearer non-transferable ticket");
});

test("summarizeForgeInvocation('task'): resists escape-glued Bearer, handles huge inputs quickly, and never splits surrogates", () => {
  const gluedSingle = summarizeForgeInvocation("task", {
    role: "det\x1b[31mBearer sk-secret-role",
    task: "run det\x1b[31mBearer sk-secret-task",
    context: "ctx\u009b2JBearer sk-secret-ctx",
  });
  const gluedSingleText = [gluedSingle.title, ...gluedSingle.lines].join("\n").toLowerCase();
  expect(gluedSingleText).not.toContain("sk-secret");
  expect(gluedSingleText).not.toContain("\x1b");
  expect(gluedSingleText).not.toContain("\u009b");

  const gluedBatch = summarizeForgeInvocation("task", {
    role: "det\x1b[31mBearer sk-secret-role",
    tasks: ["item det\x1b[31mBearer sk-secret-item"],
  });
  const gluedBatchText = [gluedBatch.title, ...gluedBatch.lines].join("\n").toLowerCase();
  expect(gluedBatchText).not.toContain("sk-secret");
  expect(gluedBatchText).not.toContain("\x1b");
  expect(gluedBatchText).not.toContain("\u009b");

  const t0 = performance.now();
  const hugeTasks = Array.from({ length: 20000 }, (_, i) => `item ${i} ${"x".repeat(200)}`);
  const hugeBatch = summarizeForgeInvocation("task", { role: "executor", tasks: hugeTasks });
  const hugeSingle = summarizeForgeInvocation("task", {
    role: "executor",
    task: "a".repeat(200000),
    context: "b".repeat(200000),
  });
  const elapsedMs = performance.now() - t0;
  expect(hugeBatch.lines.length).toBe(7);
  expect(hugeSingle.lines.length).toBeGreaterThan(0);
  expect(elapsedMs).toBeLessThan(100);

  const splitSingle = summarizeForgeInvocation("task", {
    role: "executor",
    task: `${"a".repeat(498)}🚀tail`,
    context: `${"b".repeat(298)}🚀tail`,
  });
  for (const line of splitSingle.lines) {
    expect(line.isWellFormed()).toBe(true);
  }

  const splitBatch = summarizeForgeInvocation("task", {
    role: "executor",
    tasks: [`${"a".repeat(119)}🚀tail`],
  });
  expect(splitBatch.lines[0]!.isWellFormed()).toBe(true);
});

test("redactSecrets finishes in linear time (<50ms) on repeated token-/api_key ReDoS-shaped inputs", () => {
  const tokInput = "token-".repeat(8000);
  const t0 = performance.now();
  const tokOut = redactSecrets(tokInput);
  const tokMs = performance.now() - t0;
  expect(tokOut).toBe(tokInput);
  expect(tokMs).toBeLessThan(50);

  const apiInput = '"' + "api_key".repeat(4000);
  const t1 = performance.now();
  const apiOut = redactSecrets(apiInput);
  const apiMs = performance.now() - t1;
  expect(apiOut).toBe(apiInput);
  expect(apiMs).toBeLessThan(50);
});

test("redactSecrets redacts key names with suffixes (api_key_v2, token_id, secret_key)", () => {
  const out = redactSecrets("api_key_v2=sk-secret-123 token_id=tok-secret-456 secret_key=sec-789");
  expect(out).not.toContain("sk-secret-123");
  expect(out).not.toContain("tok-secret-456");
  expect(out).not.toContain("sec-789");
  expect(out).toContain("api_key_v2=<redacted>");
  expect(out).toContain("token_id=<redacted>");
  expect(out).toContain("secret_key=<redacted>");
});

test("summarizeForgeInvocation('task'): redacts Bearer secrets split by embedded ANSI/CSI escapes", () => {
  const batch = summarizeForgeInvocation("task", {
    role: "Be\x1b[31marer sk-secret-role",
    tasks: ["Be\x1b[31marer sk-secret-item"],
  });
  const text = [batch.title, ...batch.lines].join("\n");
  expect(text.toLowerCase()).not.toContain("sk-secret-role");
  expect(text.toLowerCase()).not.toContain("sk-secret-item");
  expect(text).not.toContain("\x1b");
  expect(batch.title).toContain("<redacted>");
  expect(batch.lines[0]).toContain("<redacted>");
});

test("redactSecrets redacts Bearer tokens preceded by long (>64 byte) CSI sequences", () => {
  const out = redactSecrets("det\x1b[" + "0;".repeat(40) + "31mBearer sk-secret-123");
  expect(out).not.toContain("sk-secret-123");
  expect(out).toContain("<redacted>");
});

test("redactSecrets redacts unclosed and clipped quoted secrets completely", () => {
  const dq = redactSecrets('token="sk-live-secret-999999');
  expect(dq).not.toContain("sk-live-secret-999999");
  expect(dq).not.toContain("999999");
  expect(dq).toContain("token=");
  expect(dq).toContain("<redacted>");

  const sq = redactSecrets("token='sk-live-secret-999999");
  expect(sq).not.toContain("sk-live-secret-999999");
  expect(sq).not.toContain("999999");
  expect(sq).toContain("token=");
  expect(sq).toContain("<redacted>");

  const jsonClipped = redactSecrets('{"api_key":"sk-live-secret-999999');
  expect(jsonClipped).not.toContain("sk-live-secret-999999");
  expect(jsonClipped).not.toContain("999999");
  expect(jsonClipped).toContain('"api_key"');
  expect(jsonClipped).toContain("<redacted>");
});

test("redactSecrets and summarizeForgeResult preserve LLM token metrics while still redacting real secret keys", () => {
  const usageSummary = summarizeForgeResult(
    "bash",
    true,
    "usage: input_tokens=1200 output_tokens=340 max_tokens=4096",
  );
  const usageText = usageSummary.lines.join("\n");
  expect(usageText).toContain("1200");
  expect(usageText).toContain("340");
  expect(usageText).toContain("4096");
  expect(usageText).not.toContain("<redacted>");

  expect(redactSecrets('{"max_tokens": "4096"}')).toBe('{"max_tokens": "4096"}');
  expect(redactSecrets("token_count: 55 tokenizer=cl100k_base")).toBe(
    "token_count: 55 tokenizer=cl100k_base",
  );

  const secrets = redactSecrets(
    [
      "access_token=tok-access-111",
      "accessToken=tok-camel-222",
      "apiKey=sk-camel-333",
      "api_key_v2=sk-v2-444",
      "token_id=tok-id-555",
      "secret_key=sec-key-666",
      "db_password=pw-db-777",
      "x-api-key: sk-hdr-888",
    ].join(" "),
  );
  for (const leaked of [
    "tok-access-111",
    "tok-camel-222",
    "sk-camel-333",
    "sk-v2-444",
    "tok-id-555",
    "sec-key-666",
    "pw-db-777",
    "sk-hdr-888",
  ]) {
    expect(secrets).not.toContain(leaked);
  }
  expect(secrets).toContain("access_token=<redacted>");
  expect(secrets).toContain("accessToken=<redacted>");
  expect(secrets).toContain("apiKey=<redacted>");
  expect(secrets).toContain("api_key_v2=<redacted>");
  expect(secrets).toContain("token_id=<redacted>");
  expect(secrets).toContain("secret_key=<redacted>");
  expect(secrets).toContain("db_password=<redacted>");
  expect(secrets).toContain("x-api-key: <redacted>");
});

test("editBlockDiffLines sanitizes terminal escapes and redacts split-escape Bearer secrets inside diff hunks", () => {
  const searchBlock = [
    "<<<<<<< SEARCH",
    "const a = 'Be\x1b[31marer sk-secret-remove'; \x1b[2J\x1b]0;evil\x07",
    "=======",
    "const b = 'Be\x1b[31marer sk-secret-add'; \u009b2J",
    ">>>>>>>",
  ].join("\n");
  const rows = editBlockDiffLines(searchBlock);
  expect(rows).not.toBeNull();
  const clean = rows!.map(stripAnsi).join("\n");
  expect(clean).not.toContain("\x1b");
  expect(clean).not.toContain("\u009b");
  expect(clean).not.toContain("\x07");
  expect(clean).not.toContain("sk-secret-remove");
  expect(clean).not.toContain("sk-secret-add");
  expect(clean).toContain("<redacted>");

  const directiveBlock = "≔1..2\nauth='Be\x1b[31marer sk-secret-dir' \x1b[2J\x1b]0;evil\x07";
  const dirRows = editBlockDiffLines(directiveBlock);
  expect(dirRows).not.toBeNull();
  const dirClean = dirRows!.map(stripAnsi).join("\n");
  expect(dirClean).not.toContain("\x1b");
  expect(dirClean).not.toContain("\x07");
  expect(dirClean).not.toContain("sk-secret-dir");
  expect(dirClean).toContain("<redacted>");
});

test("editBlockDiffLines, summarizeForgeInvocation, and summarizeForgeResult completely redact split-escape Authorization and OSC-split token=val while preserving glued-escape Bearer redaction", () => {
  const diffRows = editBlockDiffLines(
    "<<<<<<< SEARCH\nAuthorization: Be\x1b[31marer sk-live-999\n=======\nAuthorization: Ba\x1b[31msic dXNlcjpwYXNz\n>>>>>>>",
  );
  expect(diffRows).not.toBeNull();
  const diffClean = diffRows!.map(stripAnsi).join("\n");
  expect(diffClean).not.toContain("sk-live-999");
  expect(diffClean).not.toContain("dXNlcjpwYXNz");
  expect(diffClean).not.toContain("\x1b");
  expect(diffClean).toContain("<redacted>");

  const bashInv = summarizeForgeInvocation("bash", {
    command: "curl -H Authorization: Be\x1b[31marer sk-live-999",
  });
  const bashInvText = bashInv.lines.join("\n");
  expect(bashInvText).not.toContain("sk-live-999");
  expect(bashInvText).not.toContain("\x1b");
  expect(bashInvText).toContain("<redacted>");

  const bashResBearer = summarizeForgeResult("bash", false, "Authorization: Be\x1b[31marer sk-live-999");
  const bashResBearerText = bashResBearer.lines.join("\n");
  expect(bashResBearerText).not.toContain("sk-live-999");
  expect(bashResBearerText).not.toContain("\x1b");
  expect(bashResBearerText).toContain("<redacted>");

  const bashResBasic = summarizeForgeResult("bash", false, "Authorization: Ba\x1b[31msic dXNlcjpwYXNz");
  const bashResBasicText = bashResBasic.lines.join("\n");
  expect(bashResBasicText).not.toContain("dXNlcjpwYXNz");
  expect(bashResBasicText).not.toContain("\x1b");
  expect(bashResBasicText).toContain("<redacted>");

  const bashResOsc = summarizeForgeResult("bash", false, "token=sec\x1b]0;a b\x07ret");
  const bashResOscText = bashResOsc.lines.join("\n");
  expect(bashResOscText).not.toContain("bret");
  expect(bashResOscText).not.toContain("sec");
  expect(bashResOscText).not.toContain("ret");
  expect(bashResOscText).not.toContain("\x1b");
  expect(bashResOscText).not.toContain("\x07");
  expect(bashResOscText).toContain("<redacted>");

  const gluedBearer = summarizeForgeResult("bash", false, "det\x1b[31mBearer sk-secret-123");
  const gluedBearerText = gluedBearer.lines.join("\n");
  expect(gluedBearerText).not.toContain("sk-secret-123");
  expect(gluedBearerText).not.toContain("\x1b");
  expect(gluedBearerText).toContain("<redacted>");
});

test("summarizeForgeInvocation and summarizeForgeResult sanitize ESC/OSC sequences from timeout and tool names", () => {
  const bashTimeout = summarizeForgeInvocation("bash", {
    command: "echo ok",
    timeout: "10\x1b]2;evil\x07",
  });
  expect(bashTimeout.title).toBe("Bash");
  const bashTimeoutText = bashTimeout.lines.join("\n");
  expect(bashTimeoutText).not.toContain("\x1b");
  expect(bashTimeoutText).not.toContain("\x07");
  expect(bashTimeoutText).not.toContain("evil");
  expect(bashTimeoutText).toContain("Timeout:");

  const customInv = summarizeForgeInvocation("custom\x1b]2;pwned\x07", { a: 1 });
  expect(customInv.title).not.toContain("\x1b");
  expect(customInv.title).not.toContain("\x07");
  expect(customInv.title).not.toContain("pwned");
  expect(customInv.title).toContain("custom");
  const customInvText = customInv.lines.join("\n");
  expect(customInvText).not.toContain("\x1b");
  expect(customInvText).not.toContain("\x07");

  const customRes = summarizeForgeResult("custom\x1b]2;pwned\x07", true, "ok\x1b]2;evil\x07");
  expect(customRes.title).not.toContain("\x1b");
  expect(customRes.title).not.toContain("\x07");
  expect(customRes.title).not.toContain("pwned");
  expect(customRes.title).toContain("custom");
  const customResText = customRes.lines.join("\n");
  expect(customResText).not.toContain("\x1b");
  expect(customResText).not.toContain("\x07");
  expect(customResText).not.toContain("evil");
});

test("formatForgeBox({ dim: true }) produces plain dimmed lines without embedded color SGR", () => {
  const prevLevel = chalk.level;
  chalk.level = 3;
  try {
    const summary = {
      title: "\x1b[32m✓ Bash\x1b[0m",
      language: "bash",
      lines: [
        '\x1b[31mconst msg = "secret";\x1b[0m',
        "\x1b[36m+ added line\x1b[0m",
        "\x1b[33m- removed line\x1b[0m",
      ],
    };
    const box = formatForgeBox(summary, {
      width: 48,
      unicode: true,
      color: true,
      dim: true,
      paint: chalk.cyan,
      paintShadow: chalk.blue,
      fill: chalk.bgRed,
      titleMark: "\x1b[35m▸\x1b[0m",
      flow: { palette: ["#ff0000", "#00ff00"], phase: 0.3, colorLevel: 3 },
    });
    for (const row of box) {
      expect(row.startsWith("\x1b[2m")).toBe(true);
      expect(row.endsWith("\x1b[22m")).toBe(true);
      const inner = row.slice("\x1b[2m".length, -"\x1b[22m".length);
      // No embedded color, bold, background, or nested reset SGR inside the dimmed wrapper.
      expect(inner).not.toContain("\x1b[");
      expect(visibleWidth(row)).toBe(48);
    }

    // Patch cards with diffPaint must also suppress diff background SGR under dim: true.
    const patchBox = formatForgeBox(
      { title: "\x1b[32mEdit src/a.ts\x1b[0m", language: "patch", lines: ["+ new", "- old"] },
      {
        width: 40,
        color: true,
        dim: true,
        diffPaint: { add: chalk.bgGreen, del: chalk.bgRed },
      },
    );
    for (const row of patchBox) {
      expect(row.startsWith("\x1b[2m")).toBe(true);
      expect(row.endsWith("\x1b[22m")).toBe(true);
      expect(row.slice("\x1b[2m".length, -"\x1b[22m".length)).not.toContain("\x1b[");
    }

    // color: false + dim: true stays completely ANSI-free.
    const plainDim = formatForgeBox(summary, { width: 48, color: false, dim: true });
    for (const row of plainDim) {
      expect(row).not.toContain("\x1b[");
      expect(visibleWidth(row)).toBe(48);
    }
  } finally {
    chalk.level = prevLevel;
  }
});

test("paintGradientLabel / renderStatusBox preserves gradient memoization across 0.1s elapsed ticks", () => {
  const prevLevel = chalk.level;
  chalk.level = 3;
  let fakeNow = 9000; // exact 225ms bucket boundary (9000 % 225 === 0)
  const nowSpy = spyOn(Date, "now").mockImplementation(() => fakeNow);
  try {
    const baseData = {
      cols: 80,
      phaseLabel: "thinking",
      spinner: "⠋",
      escHint: true,
      unicode: true,
      color: true,
      colorLevel: ColorLevel.TrueColor,
      palette: ["#0a3d62", "#48dbfb"] as const,
      isThinking: true,
    };

    fakeNow = 9000;
    const tick0 = renderStatusBox({ ...baseData, activity: "calling model (m1) (1.0s)…" });
    fakeNow = 9100; // +0.1s inside the same 225ms bucket [9000, 9225)
    const tick1 = renderStatusBox({ ...baseData, activity: "calling model (m1) (1.1s)…" });

    const row0 = tick0[0]!;
    const row1 = tick1[0]!;
    expect(row0).toContain("\x1b[38;2;");
    // Split right before the dimmed elapsed suffix so the entire gradient-painted prefix is compared.
    const marker0 = row0.indexOf(" (1.0s)…");
    const marker1 = row1.indexOf(" (1.1s)…");
    expect(marker0).toBeGreaterThan(0);
    expect(marker1).toBe(marker0);
    expect(row0.slice(0, marker0)).toBe(row1.slice(0, marker1));
    // The elapsed suffix itself is dimmed, not painted with per-character gradient escapes.
    const suffix0 = row0.slice(marker0, row0.indexOf("\x1b[22m", marker0) + 5);
    expect(suffix0).toBe(" (1.0s)…\x1b[22m");

    // ASCII "..." suffix must preserve the exact same gradient prefix memoization.
    fakeNow = 9000;
    const ascii0 = renderStatusBox({ ...baseData, unicode: false, activity: "calling model (m1) (1.0s)..." })[0]!;
    fakeNow = 9100;
    const ascii1 = renderStatusBox({ ...baseData, unicode: false, activity: "calling model (m1) (1.1s)..." })[0]!;
    const aIdx0 = ascii0.indexOf(" (1.0s)...");
    const aIdx1 = ascii1.indexOf(" (1.1s)...");
    expect(aIdx0).toBeGreaterThan(0);
    expect(ascii0.slice(0, aIdx0)).toBe(ascii1.slice(0, aIdx1));

    // Crossing the 225ms bucket boundary advances the shimmer phase, changing the gradient prefix.
    fakeNow = 9225;
    const tick2 = renderStatusBox({ ...baseData, activity: "calling model (m1) (1.2s)…" })[0]!;
    const marker2 = tick2.indexOf(" (1.2s)…");
    expect(tick2.slice(0, marker2)).not.toBe(row0.slice(0, marker0));

    // Labels without an elapsed suffix stay byte-for-byte identical within a 225ms bucket.
    fakeNow = 9000;
    const steady0 = renderStatusBox({ ...baseData, activity: "thinking through the next tool call" })[0]!;
    fakeNow = 9100;
    const steady1 = renderStatusBox({ ...baseData, activity: "thinking through the next tool call" })[0]!;
    expect(steady1).toBe(steady0);

    // Direct check on applyDimensionalGradient memoization across 0.1s ticks vs bucket boundary.
    const g0 = applyDimensionalGradient("calling model (m1)", 9000, "#0a3d62", "#48dbfb", ColorLevel.TrueColor, false);
    const g1 = applyDimensionalGradient("calling model (m1)", 9100, "#0a3d62", "#48dbfb", ColorLevel.TrueColor, false);
    const g2 = applyDimensionalGradient("calling model (m1)", 9225, "#0a3d62", "#48dbfb", ColorLevel.TrueColor, false);
    expect(g1).toBe(g0);
    expect(g2).not.toBe(g0);
  } finally {
    nowSpy.mockRestore();
    chalk.level = prevLevel;
  }
});
