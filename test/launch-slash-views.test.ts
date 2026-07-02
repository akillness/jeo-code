import { test, expect } from "bun:test";
import type { Message } from "../src/agent/loop";
import { hotkeysLines, contextUsageLines, historyViewLines } from "../src/commands/launch/slash-views";


test("hotkeysLines: stable static reference, header first and every row indented", () => {
  const out = hotkeysLines();
  expect(out[0]).toBe("Keyboard shortcuts:");
  expect(out.length).toBe(21);
  for (const row of out.slice(1)) expect(row.startsWith("  ")).toBe(true);
  // Spot-check a couple of well-known bindings survive verbatim.
  expect(out.some(l => l.includes("Ctrl-D") && l.includes("exit the REPL"))).toBe(true);
  expect(out.some(l => l.includes("Ctrl-L") && l.includes("redraw"))).toBe(true);
  expect(out.some(l => l.includes("@path") && l.includes("mention a file"))).toBe(true);
  expect(out.some(l => l.includes("Ctrl-V") && l.includes("clipboard"))).toBe(true);
  expect(out.some(l => l.includes("drag-drop") && l.includes("attach"))).toBe(true);
  expect(out.some(l => l.includes("drag") && l.includes("cmd/ctrl+c"))).toBe(true);
  expect(out.some(l => l.includes("Shift-drag") && l.includes("Option-drag"))).toBe(true);
  expect(out.some(l => l.includes("Shift-Enter") && l.includes("line break"))).toBe(true);
  expect(out.some(l => l.includes("Cmd-←") && l.includes("current row"))).toBe(true);
  expect(out.some(l => l.includes("Ctrl-Home") && l.includes("whole draft"))).toBe(true);
});

test("contextUsageLines: per-role tallies, ~4 chars/token, total + footer", () => {
  const history: Message[] = [
    { role: "system", content: "x".repeat(40) }, // 10 tokens
    { role: "user", content: "y".repeat(20) },   // 5 tokens
    { role: "assistant", content: "z".repeat(8) }, // 2 tokens
  ];
  const out = contextUsageLines(history, "claude-sonnet-4-5", 1000);
  expect(out[0]).toBe("Context usage (estimated, ~4 chars/token):");
  expect(out.some(l => l.includes("system") && l.includes("~10 tokens"))).toBe(true);
  expect(out.some(l => l.includes("user") && l.includes("~5 tokens"))).toBe(true);
  expect(out.some(l => l.includes("assistant") && l.includes("~2 tokens"))).toBe(true);
  // total row: 3 msgs, 17 tokens, window percentage present
  const totalRow = out.find(l => l.trim().startsWith("total"));
  expect(totalRow).toContain("~17 tokens");
  expect(totalRow).toContain("2% of claude-sonnet-4-5's 1000-token window");
  expect(out[out.length - 1]).toBe("  Free context with /compact or /clear.");
});

test("contextUsageLines: singular 'msg ' spacing for a single message and no window suffix", () => {
  const history: Message[] = [{ role: "system", content: "abcd" }]; // 1 token
  const out = contextUsageLines(history, "some-model", undefined);
  const sysRow = out.find(l => l.includes("system"));
  expect(sysRow).toContain("1 msg "); // singular: trailing space, no 's'
  const totalRow = out.find(l => l.trim().startsWith("total"));
  expect(totalRow).not.toContain("% of"); // no window → no percentage suffix
});

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

test("historyViewLines: default 5-turn banner, separators frame the transcript", () => {
  const history: Message[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ];
  const out = historyViewLines(history, "", 80);
  const sep = "─".repeat(79); // min(48, max(20, 80-1)) = 48 → wait, capped at 48
  expect(out[0]).toBe(out[2]); // top + bottom-of-banner separators identical
  expect(out[out.length - 1]).toBe(out[0]); // closing separator matches
  expect(out[1]).toBe("history · last 5 turn(s) (/history all for everything)");
  // separator honors the 48-column cap, not the raw width
  expect(out[0]).toBe("─".repeat(48));
  void sep;
});

test("historyViewLines: 'all' drops the turn cap and labels it 'all'", () => {
  const out = historyViewLines([], "all", 80);
  expect(out[1]).toBe("history · last all turn(s) (/history all for everything)");
});

test("historyViewLines: numeric arg parses the turn count; width clamps to >=20", () => {
  const out = historyViewLines([], " 12 ", 5);
  expect(out[1]).toBe("history · last 12 turn(s) (/history all for everything)");
  expect(stripAnsi(out[0]).length).toBe(20); // max(20, 5-1) = 20
});

test("historyViewLines: non-numeric junk falls back to 5 turns", () => {
  const out = historyViewLines([], "garbage", 80);
  expect(out[1]).toContain("last 5 turn(s)");
});

