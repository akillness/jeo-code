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
test("renderInputFrame: highlight paints only the trigger token's character range", () => {
  const { renderInputFrame } = require("../src/tui/components/input-box");
  const paint = (s: string) => `\x1b[38;2;57;255;20m${s}\x1b[39m`;
  // "go /model" — highlight the "/model" token (chars 3..9)
  const line = "go /model";
  const frame = renderInputFrame(line, {
    cols: 60, color: true, unicode: false,
    highlight: { start: 3, end: line.length, paint },
  });
  const raw = frame.lines.join("\n");
  // The trigger token is wrapped in the green SGR; the leading "go " is not.
  expect(raw).toContain("\x1b[38;2;57;255;20m");
  expect(stripAnsi(raw)).toContain("go /model");
  // The painter wraps each highlighted char — "go " precedes the first paint code.
  const idxPaint = raw.indexOf("\x1b[38;2;57;255;20m");
  const idxGo = raw.indexOf("go ");
  expect(idxGo).toBeGreaterThanOrEqual(0);
  expect(idxPaint).toBeGreaterThan(idxGo);
});

test("renderInputFrame: highlight is ignored when color is disabled", () => {
  const { renderInputFrame } = require("../src/tui/components/input-box");
  const paint = (s: string) => `\x1b[31m${s}\x1b[39m`;
  const frame = renderInputFrame("/model", {
    cols: 40, color: false, unicode: false,
    highlight: { start: 0, end: 6, paint },
  });
  // No SGR introduced by the highlight (color:false path skips it).
  expect(frame.lines.join("\n")).not.toContain("\x1b[31m");
});

test("renderInputFrame: highlight does not paint the placeholder", () => {
  const { renderInputFrame } = require("../src/tui/components/input-box");
  const paint = (s: string) => `\x1b[31m${s}\x1b[39m`;
  const frame = renderInputFrame("", {
    cols: 40, color: true, unicode: false,
    highlight: { start: 0, end: 3, paint },
  });
  expect(frame.lines.join("\n")).not.toContain("\x1b[31m");
});
