import { test, expect } from "bun:test";
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
  expect(bash.title).toBe("bash command");
  expect(bash.language).toBe("bash");
  expect(bash.lines).toContain("echo hello");

  const read = summarizeForgeInvocation("read", { filePath: "src/app.ts", lineRange: "1-20" });
  expect(read.title).toBe("read src/app.ts");
  expect(read.lines).toEqual(["path: src/app.ts", "range: 1-20"]);

  const write = summarizeForgeInvocation("write", { path: "out.txt", content: "a\nb" });
  expect(write.title).toBe("write out.txt");
  expect(write.lines[0]).toContain("2 line(s) -> out.txt");
});

test("forge boxes are width-bounded and redact secret-like values", () => {
  expect(redactSecrets("API_KEY=abcdef token: secret-value")).toContain("<redacted>");
  const summary = summarizeForgeResult("bash", false, "password=abc123\nline two");
  const box = formatForgeBox(summary, { width: 36, unicode: false, paint: s => s }).map(stripAnsi);
  expect(box[0]).toBe("+----------------------------------+");
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

test("renderJocStatus exposes progress status, joc thinking, and joc forge", () => {
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
  expect(lines[0]).toContain("joc thinking");
  expect(lines[0]).toContain("step 3/10");
  expect(lines[1]).toContain("joc forge");
  expect(lines[1]).toContain("tools 4 (2 ok / 1 fail / 1 running)");
  expect(lines[1]).toContain("mutation locked");
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
