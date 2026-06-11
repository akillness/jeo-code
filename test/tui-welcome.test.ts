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
  const W = Math.min(100, cols - 2); // 78
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

test("hero column: brand, tagline, grand DNA Claw symbol, centered", () => {
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
  // Grand symbol caption (spaced caption from the grand art block).
  expect(joined).toContain("D N A · C L A W");
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
  const W = Math.min(100, cols - 2);
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

test("narrow box falls back to the compact DNA Claw symbol", () => {
  const lines = renderWelcome({
    version: "1.2.3",
    model: "claude-3-5-sonnet",
    cols: 34, // inner 30 < grand art width
    unicode: true,
    color: false,
  });
  const joined = lines.map(stripAnsi).join("\n");
  expect(joined).toContain("[ DNA Claw ]");
  expect(joined).not.toContain("D N A · C L A W");
});

test("narrow cols (<30) -> single-line fallback", () => {
  const lines = renderWelcome({
    version: "1.2.3",
    model: "claude-3-5-sonnet",
    cols: 25,
    unicode: true,
    color: false,
  });

  expect(lines).toEqual(["jeo v1.2.3 · claude-3-5-sonnet"]);
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
