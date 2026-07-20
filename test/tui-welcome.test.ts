import { test, expect } from "bun:test";
import { renderWelcome } from "../src/tui/components/welcome";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("box has top/bottom borders and title with version", () => {
  const lines = renderWelcome({
    version: "1.2.3",
    model: "claude-3-5-sonnet",
    provider: "anthropic",
    cols: 80,
    unicode: true,
    color: false,
  });

  expect(lines.length).toBeGreaterThan(2);
  const topLine = lines[0]!;
  const bottomLine = lines[lines.length - 1]!;

  expect(topLine).toContain("jeo v1.2.3");
  expect(topLine).toContain("JEO forge");
  expect(topLine.startsWith("╭")).toBe(true);
  expect(topLine.endsWith("╮")).toBe(true);

  expect(bottomLine.startsWith("╰")).toBe(true);
  expect(bottomLine.endsWith("╯")).toBe(true);
});

test("box borders with unicode: false", () => {
  const lines = renderWelcome({
    version: "1.2.3",
    model: "claude-3-5-sonnet",
    provider: "anthropic",
    cols: 80,
    unicode: false,
    color: false,
  });

  const topLine = lines[0]!;
  const bottomLine = lines[lines.length - 1]!;
  expect(topLine.startsWith("+")).toBe(true);
  expect(topLine.endsWith("+")).toBe(true);
  expect(bottomLine.startsWith("+")).toBe(true);
  expect(bottomLine.endsWith("+")).toBe(true);
});

test("every line has equal visible width", () => {
  const cols = 80;
  const W = cols - 1; // banner fills the full terminal width (last column left free)
  const lines = renderWelcome({
    version: "1.2.3",
    model: "claude-3-5-sonnet",
    provider: "anthropic",
    cols,
    unicode: true,
    color: true,
    cwd: "/Users/jangyoung/project",
    thinking: "medium",
    sessionId: "abcdef1234567890",
    contextFiles: ["file1.txt", "file2.js"],
    recentSessions: [
      { name: "session1", timeAgo: "2h ago" },
      { name: "session2", timeAgo: "1d ago" },
    ],
  });

  for (let i = 0; i < lines.length; i++) {
    const vis = stripAnsi(lines[i]!).length;
    expect(vis).toBe(W);
  }
});

test("banner width tracks cols across a resize (re-render fits the new width, not the original)", () => {
  const base = {
    version: "1.2.3",
    model: "claude-3-5-sonnet",
    provider: "anthropic",
    unicode: true,
    color: false,
    cwd: "/Users/jangyoung/project",
    thinking: "medium" as const,
  };
  // Simulate: launch at 80, then the terminal is resized to 120 and the banner
  // re-renders (the /clear & /resume path). The fresh render must fill the NEW
  // width (cols-1), never snap back to the launch-time width.
  for (const cols of [80, 120, 60]) {
    const lines = renderWelcome({ ...base, cols });
    const W = cols - 1;
    expect(stripAnsi(lines[0]!).length).toBe(W);
    expect(stripAnsi(lines[lines.length - 1]!).length).toBe(W);
    // Every body row is padded to the same width — proves no row keeps an older geometry.
    for (const line of lines) expect(stripAnsi(line).length).toBe(W);
  }
});


test("hero column: brand, tagline, grand forge mark, centered", () => {
  const lines = renderWelcome({
    version: "1.2.3",
    model: "claude-3-5-sonnet",
    provider: "anthropic",
    cols: 80,
    unicode: true,
    color: false,
  });
  const joined = lines.map(stripAnsi).join("\n");
  expect(joined).toContain("Jeo forge");
  expect(joined).toContain("evolve · act · prove");
  // Grand symbol: the wide eyeglass-bridge bar is unique to the large line-board art block.
  expect(joined).toContain("╭──────────────╮");
});

test("model + provider pills present", () => {
  const lines = renderWelcome({
    version: "1.2.3",
    model: "claude-3-5-sonnet",
    provider: "anthropic",
    cols: 80,
    unicode: true,
    color: false,
  });
  const joined = lines.map(stripAnsi).join("\n");
  expect(joined).toContain("[ ◆ claude-3-5-sonnet ]");
  expect(joined).toContain("[ ◇ anthropic ]");
});

test("provider pill omitted when missing", () => {
  const lines = renderWelcome({
    version: "1.2.3",
    model: "claude-3-5-sonnet",
    cols: 80,
    unicode: true,
    color: false,
  });
  const joined = lines.map(stripAnsi).join("\n");
  expect(joined).toContain("[ ◆ claude-3-5-sonnet ]");
  expect(joined).not.toContain("[ ◇");
});

test("workspace / session details no longer render inside the hero box (gjc parity)", () => {
  const lines = renderWelcome({
    version: "1.2.3",
    model: "claude-3-5-sonnet",
    cols: 80,
    unicode: true,
    color: false,
    cwd: "/Users/jangyoung/my-awesome-project",
    recentSessions: [{ name: "s1", timeAgo: "1m ago" }],
  });
  const joined = lines.map(stripAnsi).join("\n");
  expect(joined).not.toContain("Flow keys");
  expect(joined).not.toContain("Workspace");
  expect(joined).not.toContain("Session trail");
  expect(joined).not.toContain("my-awesome-project");
});

test("an overlong model pill truncates instead of breaking the border", () => {
  const model = "antigravity/gemini-3.1-pro-extremely-long-model-identifier-overflowing";
  const cols = 60;
  const W = cols - 1; // full-width banner
  const lines = renderWelcome({
    version: "1.2.3",
    model,
    provider: "antigravity",
    cols,
    unicode: true,
    color: false,
  });
  for (const line of lines) {
    expect(stripAnsi(line).length).toBe(W);
  }
});

test("narrow box falls back to the compact forge mark", () => {
  const lines = renderWelcome({
    version: "1.2.3",
    model: "claude-3-5-sonnet",
    cols: 30, // inner 28 < grand art width (40), >= compact width (27)
    unicode: true,
    color: false,
  });
  const joined = lines.map(stripAnsi).join("\n");
  expect(joined).toContain("╭─────────╮"); // compact line-board bridge (9-wide)
  expect(joined).not.toContain("╭──────────────╮"); // not the grand bridge (14-wide)
});

test("narrow cols (<30) -> single-line fallback, width-capped", () => {
  const lines = renderWelcome({
    version: "1.2.3",
    model: "claude-3-5-sonnet",
    cols: 25,
    unicode: true,
    color: false,
  });

  // The fallback line is now width-capped to `cols - 1` (same "leave the last column
  // free" convention as the boxed banner below — a line filled to EXACTLY `cols`
  // followed by its own trailing newline is ambiguous to real terminals: a full-width
  // row + explicit LF can double-advance a row via the pending-autowrap/explicit-LF
  // ambiguity, reproduced live as a duplicated line on every subsequent repaint).
  // Unbounded concatenation ("jeo v1.2.3 · claude-3-5-sonnet", 30 chars) overflowed a
  // 25-col terminal by 5 columns; a longer, provider-qualified model id like
  // "antigravity/claude-sonnet-4-6 (antigravity)" overflowed by up to 47 columns.
  expect(lines).toEqual(["jeo v1.2.3 · claude-3-5-"]);
  expect(lines[0]!.length).toBe(24);
});

test("narrow cols (<30) fallback never overflows, even with a long provider-qualified model id", () => {
  for (const cols of [1, 5, 10, 15, 20, 25, 29]) {
    for (const model of ["m", "gpt-4o-mini", "antigravity/claude-sonnet-4-6 (antigravity)"]) {
      const lines = renderWelcome({ version: "1.2.3", model, cols, unicode: true, color: false });
      expect(lines.length).toBe(1);
      // Strictly LESS than cols, never equal — a fallback line filled to exactly `cols`
      // is the same pending-autowrap/explicit-LF ambiguity the fix closes.
      expect(lines[0]!.length).toBeLessThan(cols || 1);
    }
  }
});

test("banner fills the full terminal width on wide and narrow terminals; never wraps", () => {
  const stripW = (cols: number) =>
    stripAnsi(renderWelcome({ version: "1.2.3", model: "m", cols, unicode: true, color: false })[0]!).length;
  // The box spans the full width (last column left free so a full-width row never wraps),
  // and it tracks the terminal — wide stays wide, narrow shrinks, no 100/120-col cap.
  expect(stripW(200)).toBe(199);
  expect(stripW(120)).toBe(119);
  expect(stripW(80)).toBe(79);
  expect(stripW(44)).toBe(43);
  expect(stripW(200)).toBeGreaterThan(stripW(80));
  // Flush-left (no centering): the box starts at column 0.
  const lines = renderWelcome({ version: "1.2.3", model: "m", cols: 200, unicode: true, color: false });
  for (const line of lines) expect(line.startsWith(" ")).toBe(false);
});

test("color:false emits no ANSI", () => {
  const lines = renderWelcome({
    version: "1.2.3",
    model: "claude-3-5-sonnet",
    provider: "anthropic",
    cols: 80,
    unicode: true,
    color: false,
    cwd: "/Users/jangyoung/project",
    thinking: "medium",
    sessionId: "abcdef1234567890",
    contextFiles: ["file1.txt"],
    recentSessions: [{ name: "s1", timeAgo: "1m ago" }],
  });

  const ansiRe = /\x1b\[/;
  for (const line of lines) {
    expect(ansiRe.test(line)).toBe(false);
  }
});

test("two-tone depth: lit top/left edges vs shaded bottom/right edges", () => {
  const lit = (s: string) => `<L>${s}</L>`;
  const shadow = (s: string) => `<S>${s}</S>`;
  const lines = renderWelcome({
    version: "1.2.3",
    model: "claude-3-5-sonnet",
    provider: "anthropic",
    cols: 80,
    unicode: true,
    color: true,
    accent: lit,
    accentShadow: shadow,
  });
  // Top border is lit; bottom border is shaded.
  expect(lines[0]!).toContain("<L>");
  expect(lines[0]!).not.toContain("<S>");
  expect(lines[lines.length - 1]!).toContain("<S>");
  expect(lines[lines.length - 1]!).not.toContain("<L>");
  // Every content row: left edge lit, right edge shaded.
  for (const row of lines.slice(1, -1)) {
    expect(row.startsWith("<L>│</L>")).toBe(true);
    expect(row.endsWith("<S>│</S>")).toBe(true);
  }
});
