import { test, expect } from "bun:test";
import chalk from "chalk";
import {
  detectLanguage,
  languageLabel,
  parseLineRange,
  sliceLines,
  lightHighlightLine,
  formatCodeBlock,
  formatDiff,
  sanitizeForTerminal,
} from "../src/tui/components/code-view";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const hasAnsi = (s: string) => /\x1b\[/.test(s);

test("detectLanguage maps extensions; unknown → ''", () => {
  expect(detectLanguage("src/cli.ts")).toBe("ts");
  expect(detectLanguage("a.JSX")).toBe("js");
  expect(detectLanguage("x.py")).toBe("py");
  expect(detectLanguage("data.json")).toBe("json");
  expect(detectLanguage("README")).toBe("");
  expect(languageLabel("")).toBe("text");
});

test("parseLineRange handles start-end / start- / start / invalid", () => {
  expect(parseLineRange("10-20")).toEqual({ start: 10, end: 20 });
  expect(parseLineRange("10-")).toEqual({ start: 10 });
  expect(parseLineRange("7")).toEqual({ start: 7, end: 7 });
  expect(parseLineRange("20-10")).toBeNull(); // end < start
  expect(parseLineRange("abc")).toBeNull();
});

test("sliceLines slices by 1-based range and clamps", () => {
  const content = "a\nb\nc\nd\ne";
  expect(sliceLines(content, { start: 2, end: 4 })).toEqual({ lines: ["b", "c", "d"], startLine: 2 });
  expect(sliceLines(content, { start: 4 })).toEqual({ lines: ["d", "e"], startLine: 4 });
  expect(sliceLines(content)).toEqual({ lines: ["a", "b", "c", "d", "e"], startLine: 1 });
  // out-of-bounds start clamps to last line
  expect(sliceLines(content, { start: 99 }).startLine).toBe(5);
});

test("formatCodeBlock renders a numbered gutter with the right start line", () => {
  const out = formatCodeBlock("foo\nbar", { startLine: 10, color: false });
  expect(strip(out[0])).toContain("10");
  expect(strip(out[0])).toContain("foo");
  expect(strip(out[1])).toContain("11");
  expect(strip(out[1])).toContain("bar");
});

test("formatCodeBlock caps at maxLines with an overflow marker", () => {
  const content = Array.from({ length: 10 }, (_, i) => `L${i}`).join("\n");
  const out = formatCodeBlock(content, { maxLines: 3, color: false });
  expect(out.length).toBe(4); // 3 lines + overflow marker
  expect(out[3]).toContain("+7 more lines");
});

test("formatCodeBlock marks highlighted lines and truncates to cols", () => {
  const out = formatCodeBlock("alpha\nbeta", { startLine: 1, highlight: [2], color: false, cols: 80 });
  expect(out[1].startsWith(">")).toBe(true); // marker for highlighted line (ascii when color off)
  const wide = formatCodeBlock("x".repeat(200), { cols: 20, color: false });
  expect(strip(wide[0]).length).toBeLessThanOrEqual(20);
});

test("lightHighlightLine dims comments, colors strings, then keywords", () => {
  const prev = chalk.level;
  chalk.level = 3; // force color so the highlight escapes are emitted in a non-TTY test env
  try {
    expect(hasAnsi(lightHighlightLine("// a comment", "ts"))).toBe(true);
    expect(hasAnsi(lightHighlightLine('const x = "hi"', "ts"))).toBe(true);
    expect(hasAnsi(lightHighlightLine("return value", "ts"))).toBe(true); // 'return' keyword
    expect(hasAnsi(lightHighlightLine("plain text here", "ts"))).toBe(false);
    expect(hasAnsi(lightHighlightLine("# py comment", "py"))).toBe(true);
    // highlighting never changes the visible text
    expect(strip(lightHighlightLine('const x = "hi"', "ts"))).toBe('const x = "hi"');
  } finally {
    chalk.level = prev;
  }
});

test("formatDiff colors +/-/@@ and is plain when color:false", () => {
  const diff = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n ctx";
  const prev = chalk.level;
  chalk.level = 3;
  try {
    expect(hasAnsi(formatDiff(diff).join(""))).toBe(true);
  } finally {
    chalk.level = prev;
  }
  const plain = formatDiff(diff, { color: false });
  expect(hasAnsi(plain.join(""))).toBe(false);
  expect(strip(plain[3])).toBe("-old");
  expect(strip(plain[4])).toBe("+new");
});

test("formatDiff caps long diffs", () => {
  const big = Array.from({ length: 20 }, (_, i) => `+line${i}`).join("\n");
  const out = formatDiff(big, { maxLines: 5, color: false });
  expect(out[out.length - 1]).toContain("+15 more");
});

test("sanitizeForTerminal strips ANSI/C0 controls, CR, and expands tabs", () => {
  expect(sanitizeForTerminal("a\tb")).toBe("a  b");
  expect(sanitizeForTerminal("done\r")).toBe("done");
  expect(sanitizeForTerminal("clear\x1b[2Jhere")).toBe("clearhere");
  expect(sanitizeForTerminal("\x1b[31mred\x1b[0m")).toBe("red");
  expect(sanitizeForTerminal("\x1b]0;evil title\x07ok")).toBe("ok");
  expect(sanitizeForTerminal("nul\x00byte")).toBe("nulbyte");
  // 8-bit C1 controls (xterm in UTF-8 mode interprets these the same as ESC forms).
  expect(sanitizeForTerminal("clear\u009b2Jhere")).toBe("clearhere"); // 8-bit CSI + payload
  expect(sanitizeForTerminal("\u009d0;evil\u0007ok")).toBe("ok"); // 8-bit OSC + payload
  expect(sanitizeForTerminal("a\u0090b\u009fc")).toBe("abc"); // stray C1 introducers
});

test("formatCodeBlock neutralizes file-origin escape sequences (no raw ESC leaks)", () => {
  const malicious = "safe line\nevil\x1b[2J\x1b[H line\nx\ty";
  const out = formatCodeBlock(malicious, { color: false });
  for (const l of out) expect(l).not.toContain("\x1b");
  expect(out.join("\n")).toContain("evil line"); // CSI removed, text kept
  expect(out.join("\n")).toContain("x  y"); // tab expanded
});

test("formatDiff neutralizes file-origin escape sequences", () => {
  const out = formatDiff("+added\x1b[2J\n-\x1b]0;t\x07removed", { color: false });
  for (const l of out) expect(l).not.toContain("\x1b");
});
