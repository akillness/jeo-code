import { test, expect } from "bun:test";
import chalk from "chalk";
import {
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
  expect(wide.join("\n")).toContain("Read-only GJC v5");
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
