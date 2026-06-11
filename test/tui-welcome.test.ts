import { test, expect } from "bun:test";
import os from "node:os";
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

  expect(topLine).toContain("joc v1.2.3");
  expect(topLine).toContain("evolution forge");
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

test("cwd rendered ~-shortened", () => {
  const home = process.env.HOME ?? os.homedir();
  const cwd = home + "/my-awesome-project";
  const lines = renderWelcome({
    version: "1.2.3",
    model: "claude-3-5-sonnet",
    cwd,
    cols: 80,
    unicode: true,
    color: false,
  });

  const joined = lines.map(stripAnsi).join("\n");
  expect(joined).toContain("~/my-awesome-project");
  expect(joined).not.toContain(home + "/my-awesome-project");
});

test("recent sessions listed and capped at 3", () => {
  const lines = renderWelcome({
    version: "1.2.3",
    model: "claude-3-5-sonnet",
    cols: 80,
    unicode: true,
    color: false,
    recentSessions: [
      { name: "s1", timeAgo: "1m ago" },
      { name: "s2", timeAgo: "2m ago" },
      { name: "s3", timeAgo: "3m ago" },
      { name: "s4", timeAgo: "4m ago" },
    ],
  });

  const joined = lines.map(stripAnsi).join("\n");
  expect(joined).toContain("• s1 (1m ago)");
  expect(joined).toContain("• s2 (2m ago)");
  expect(joined).toContain("• s3 (3m ago)");
  expect(joined).not.toContain("s4");
});

test("empty sessions -> No saved trails", () => {
  const lines = renderWelcome({
    version: "1.2.3",
    model: "claude-3-5-sonnet",
    cols: 80,
    unicode: true,
    color: false,
    recentSessions: [],
  });

  const joined = lines.map(stripAnsi).join("\n");
  expect(joined).toContain("No saved trails");
});

test("narrow cols (<30) -> single-line fallback", () => {
  const lines = renderWelcome({
    version: "1.2.3",
    model: "claude-3-5-sonnet",
    cols: 25,
    unicode: true,
    color: false,
  });

  expect(lines).toEqual(["joc v1.2.3 · claude-3-5-sonnet"]);
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

test("single column layout when W < 64", () => {
  const lines = renderWelcome({
    version: "1.2.3",
    model: "claude-3-5-sonnet",
    cols: 60,
    unicode: true,
    color: false,
  });

  const joined = lines.map(stripAnsi).join("\n");
  expect(joined).toContain("[ ◆ claude-3-5-sonnet ]");
  expect(joined).not.toContain("Flow keys");
});
