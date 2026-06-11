import { test, expect } from "bun:test";
import chalk from "chalk";
import {
  formatForgeBox,
  progressPercent,
  redactSecrets,
  renderJocStatus,
  summarizeForgeInvocation,
  summarizeForgeResult,
} from "../src/tui/components";
import { buildRalphSubagentPrompt, formatRalphStreamEvent, formatRalphTodoGuide } from "../src/commands/team";

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

test("forge boxes are width-bounded and redact secret-like values", () => {
  expect(redactSecrets("API_KEY=abcdef token: secret-value")).toContain("<redacted>");
  const summary = summarizeForgeResult("bash", false, "password=abc123\nline two");
  const box = formatForgeBox(summary, { width: 36, unicode: false, paint: s => s }).map(stripAnsi);
  // joc-ref anatomy: the title rides ON the top border instead of its own row.
  expect(box[0]!.startsWith("+--")).toBe(true);
  expect(box[0]!.endsWith("+")).toBe(true);
  expect(box[0]).toContain("bash result failed");
  expect(box.some(line => line.includes("<redacted>"))).toBe(true);
  expect(box.every(line => line.length <= 36)).toBe(true);
});

test("forge summaries never throw on an undefined/empty tool name (malformed model output)", () => {
  // A model can emit a tool call with no `tool` field; the TUI must not crash.
  const inv = summarizeForgeInvocation(undefined as unknown as string, { foo: 1 });
  expect(inv.title).toContain("(no tool)");
  const res = summarizeForgeResult(undefined as unknown as string, false, "boom");
  expect(res.title).toContain("(no tool)");
  expect(() => formatForgeBox(inv, { width: 40, unicode: false, paint: s => s })).not.toThrow();
});

test("renderJocStatus separates progress, insight status, and forge rows", () => {
  expect(progressPercent(3, 10)).toBe(30);
  const lines = renderJocStatus({
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
  expect(lines[0]).toContain("step 3/10");
  expect(lines[0]).not.toContain("Resolving type boundaries");
  expect(lines[1]).toContain("[STATUS]");
  expect(lines[1]).toContain("jeo status");
  expect(lines[1]).toContain("Resolving type boundaries");
  expect(lines[2]).toContain("jeo forge");
  expect(lines[2]).toContain("tools 4 (2 ok / 1 fail / 1 running)");
  expect(lines[2]).toContain("mutation locked");
});

test("renderJocStatus colorizes the forge count segments when color is on", () => {
  const prev = chalk.level;
  chalk.level = 3;
  try {
    const lines = renderJocStatus({
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

test("renderJocStatus: forge line exposes the evolution stage (double helix) when provided", () => {
  const lines = renderJocStatus({
    step: 4, maxSteps: 25, currentTool: "read",
    stage: "●●○○○ Double Helix (DNA) [2/5]",
    color: false, unicode: true,
  });
  const forgeLine = lines[2] ?? "";
  expect(forgeLine).toContain("jeo forge");
  expect(forgeLine).toContain("Double Helix (DNA)"); // stage identity exposed
  expect(forgeLine).toContain("forging read");        // current tool still shown
  // without a stage, the forge line omits it (no leading separator noise)
  const plain = renderJocStatus({ step: 1, maxSteps: 25, color: false });
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

  // 5. renderJocStatus with stepElapsedMs and avgStepMs
  const statusLines = renderJocStatus({
    step: 5,
    maxSteps: 10,
    elapsedMs: 5000,
    stepElapsedMs: 12300,
    avgStepMs: 8100,
    color: false,
  }).map(stripAnsi);
  expect(statusLines[0]).toContain("step 5/10");
  expect(statusLines[0]).toContain("step 12.3s");
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
  // joc-ref anatomy: the title rides ON the top border (`╭── ✓ bash … ──╮`)
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
