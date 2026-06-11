import { test, expect } from "bun:test";
import { renderInputBox } from "../src/tui/components/input-box";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("renderInputBox draws a boxed input area containing only the body and cwdLabel if provided", () => {
  const outWithCwd = renderInputBox("inspect @src/commands", { cols: 36, color: false, unicode: false, cwdLabel: "@ src" }).map(stripAnsi);
  
  // Top border is the first line
  expect(outWithCwd[0]).toBe("+----------------------------------+");
  
  // No rendered line contains "CMD" or "input" as a title
  for (const line of outWithCwd) {
    expect(line.includes("CMD")).toBe(false);
    expect(line.includes("input")).toBe(false);
  }
  
  // Body shows the typed line
  expect(outWithCwd.join("\n")).toContain("inspect @src/commands");
  
  // cwdLabel renders as its own row when provided
  const rowWithCwd = outWithCwd.find(line => line.includes("@ src"));
  expect(rowWithCwd).toBeDefined();
  
  const outWithoutCwd = renderInputBox("inspect @src/commands", { cols: 36, color: false, unicode: false }).map(stripAnsi);
  // cwdLabel is absent otherwise
  const rowWithoutCwd = outWithoutCwd.find(line => line.includes("@ src"));
  expect(rowWithoutCwd).toBeUndefined();
});

test("renderInputBox wraps long input across multiple rows", () => {
  const out = renderInputBox("x".repeat(80), { cols: 24, color: false, unicode: false }).map(stripAnsi);
  expect(out.length).toBeGreaterThan(5);
  expect(out.every(line => line.length <= 24)).toBe(true);
});

test("renderInputFrame: empty line shows `>` + dim placeholder with the caret right after `>`", () => {
  const { renderInputFrame } = require("../src/tui/components/input-box");
  const frame = renderInputFrame("", { cols: 40, color: false, unicode: false });
  const body = frame.lines.map(stripAnsi);
  expect(body[1]).toContain("> Type your message");
  expect(frame.cursorRow).toBe(1); // first body row (0 = top border)
  expect(frame.cursorCol).toBe(4); // border(1) + content(2) + "> "(2) → col 4
});

test("renderInputFrame: caret column follows the cursor offset (arrow-key movement)", () => {
  const { renderInputFrame } = require("../src/tui/components/input-box");
  const atEnd = renderInputFrame("hello", { cols: 40, color: false, unicode: false, cursor: 5 });
  expect(atEnd.cursorCol).toBe(4 + 5);
  const mid = renderInputFrame("hello", { cols: 40, color: false, unicode: false, cursor: 2 });
  expect(mid.cursorCol).toBe(4 + 2);
  const home = renderInputFrame("hello", { cols: 40, color: false, unicode: false, cursor: 0 });
  expect(home.cursorCol).toBe(4);
  // CJK is 2 columns wide
  const cjk = renderInputFrame("한글", { cols: 40, color: false, unicode: true, cursor: 1 });
  expect(cjk.cursorCol).toBe(4 + 2);
});

test("renderInputFrame: caret wraps to continuation rows on long input", () => {
  const { renderInputFrame } = require("../src/tui/components/input-box");
  const frame = renderInputFrame("x".repeat(50), { cols: 24, color: false, unicode: false, cursor: 50 });
  expect(frame.cursorRow).toBeGreaterThan(1);
  const body = frame.lines.map(stripAnsi);
  expect(body[1]!.startsWith("|> x")).toBe(true);  // first row carries the prompt
  expect(body[2]!.startsWith("|  x")).toBe(true);  // continuation rows align under it
});
