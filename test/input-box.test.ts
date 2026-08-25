import { test, expect } from "bun:test";
import { renderInputBox, renderInputFrame } from "../src/tui/components/input-box";

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

test("renderInputBox never overflows a terminal narrower than the old 24-col floor", () => {
  // Regression: `cols` used to be clamped UP to a minimum of 24 (Math.max(24, ...)),
  // silently overflowing any REAL terminal narrower than that (a resize down to 20
  // cols still drew a 24-col box). A real terminal then hard-wraps/splits that
  // overflowing border across two rows — reproduced live via tmux.
  for (const cols of [5, 10, 15, 19, 20, 23]) {
    const out = renderInputBox("hello", { cols, color: false, unicode: false }).map(stripAnsi);
    for (const line of out) expect(line.length).toBeLessThanOrEqual(cols);
  }
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

test("renderInputFrame: paints multiple highlight ranges (each token its own color)", () => {
  const { renderInputFrame } = require("../src/tui/components/input-box");
  const green = (s: string) => `\x1b[38;2;57;255;20m${s}\x1b[39m`;
  const pink = (s: string) => `\x1b[38;2;255;107;129m${s}\x1b[39m`;
  // "/model x $nope" — /model (0..6) valid green, $nope (9..14) unknown pink.
  const line = "/model x $nope";
  const frame = renderInputFrame(line, {
    cols: 60, color: true, unicode: false,
    highlight: [
      { start: 0, end: 6, paint: green },
      { start: 9, end: 14, paint: pink },
    ],
  });
  const raw = frame.lines.join("\n");
  expect(raw).toContain("\x1b[38;2;57;255;20m"); // green on /model
  expect(raw).toContain("\x1b[38;2;255;107;129m"); // pink on $nope
  expect(stripAnsi(raw)).toContain("/model x $nope");
  // Order is preserved: the green token is painted before the pink one.
  expect(raw.indexOf("\x1b[38;2;57;255;20m")).toBeLessThan(raw.indexOf("\x1b[38;2;255;107;129m"));
});
test("renderInputFrame: caret lands right after the [image #N] tag from insertImageTag (not pushed)", () => {
  const { renderInputFrame } = require("../src/tui/components/input-box");
  const { insertImageTag } = require("../src/util/file-attachment");
  // Empty box + Ctrl+V image attach → "[image #1] " with the caret on col 15 (the
  // cell right after the tag's single trailing space), NOT several columns past it.
  const { text, cursor } = insertImageTag("", 0, 1);
  expect(text).toBe("[image #1] ");
  const frame = renderInputFrame(text, { cols: 60, color: false, unicode: false, cursor });
  // Visible body shows "> [image #1]"; "> " ends at col 3, the tag occupies cols 4..13,
  // its trailing space is col 14, so the caret sits on col 15 — exactly text length + 4.
  expect(frame.cursorCol).toBe(4 + text.length);
  const body = frame.lines.map(stripAnsi);
  expect(body[1]).toContain("> [image #1]");
});

// UX follow-up (pasting a large multi-line block): a bare "…" scroll marker gave no
// indication of HOW MUCH content was hidden — pasting a 20-line block previously showed
// "…line sixteen" with no count. A count-bearing marker fixes this without touching the
// bracketed-paste parsing state machine at all (this is a pure rendering-layer change).
test("renderInputFrame: a scrolled-above window shows a count-bearing '+N⋯' marker, not a bare ellipsis", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const text = lines.join("\n");
  const frame = renderInputFrame(text, { cols: 40, maxBodyRows: 5, cursor: text.length, unicode: true, color: false });
  const body = frame.lines.map(stripAnsi);
  // Caret at the very end (a paste naturally lands here) pins the window to the last
  // 5 lines; 15 lines (1..15) are hidden above.
  expect(body.some(l => l.includes("+15⋯line 16"))).toBe(true);
  expect(body.some(l => l.includes("…"))).toBe(false); // no bare ellipsis anywhere
  // No lines hidden BELOW (caret is on the last real line) — no "text⋯+N" trailing marker
  // anywhere (only the "+15⋯" LEADING marker on row 0, checked above).
  expect(body.some(l => /line 20⋯\+\d/.test(l))).toBe(false);
});

test("renderInputFrame: no scroll marker at all when every line fits within maxBodyRows", () => {
  const text = "one\ntwo\nthree";
  const frame = renderInputFrame(text, { cols: 40, maxBodyRows: 5, cursor: text.length, unicode: true, color: false });
  const body = frame.lines.map(stripAnsi);
  expect(body.some(l => l.includes("⋯"))).toBe(false);
  expect(body.some(l => l.includes("…"))).toBe(false);
});

// ── Caret offsets are UTF-16 code units (rl.cursor's unit) ──────────────────────
// Reported live: with an emoji in the draft the painted caret sat one column right of
// the real insertion point (pressing ← after "…테스트😀😀" left the caret parked at the
// end). readline counts UTF-16 units; the box used to count CODE POINTS, so every
// surrogate pair before the caret shifted it.
test("renderInputFrame: caret column follows readline's UTF-16 offset across surrogate pairs", () => {
  const text = "ab😀cd"; // widths: a=1 b=1 😀=2 c=1 d=1
  // Caret AFTER the emoji: readline reports 4 code units (a,b + the pair), not 3.
  const afterEmoji = renderInputFrame(text, { cols: 40, cursor: 4, color: false, unicode: false });
  expect(afterEmoji.cursorCol).toBe(4 + 4); // "> " prompt starts col 4; "ab😀" is 4 columns
  // Caret BEFORE the emoji.
  const beforeEmoji = renderInputFrame(text, { cols: 40, cursor: 2, color: false, unicode: false });
  expect(beforeEmoji.cursorCol).toBe(4 + 2);
  // End of the draft: 6 code units → all 6 display columns.
  const atEnd = renderInputFrame(text, { cols: 40, cursor: text.length, color: false, unicode: false });
  expect(atEnd.cursorCol).toBe(4 + 6);
});

test("renderInputFrame: caret column stays exact for wide CJK text (one code unit, two columns)", () => {
  const text = "한글 test";
  const frame = renderInputFrame(text, { cols: 40, cursor: 2, color: false, unicode: false });
  expect(frame.cursorCol).toBe(4 + 4); // two CJK glyphs = 4 columns
});

test("renderInputFrame: an emoji before a wrap boundary does not desync the caret row", () => {
  // textWidth = cols - 6 = 6 columns per row. "😀😀😀😀" = 8 columns → wraps after 3.
  const text = "😀😀😀😀";
  const frame = renderInputFrame(text, { cols: 12, cursor: text.length, color: false, unicode: false });
  expect(frame.cursorRow).toBe(2); // top border + second body row
  expect(frame.cursorCol).toBe(4 + 2); // the 4th emoji sits alone on row 2
});
