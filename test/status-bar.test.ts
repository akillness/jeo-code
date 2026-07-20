import { test, expect } from "bun:test";
import { renderStatusBar } from "../src/tui/components/status";
import { renderInputFrame } from "../src/tui/components/input-box";
import { visibleWidth } from "../src/tui/components/color";

const base = { model: "gpt-5.5", cols: 80, color: false, unicode: true } as const;

test("status bar: fills exactly cols with identity left and ctx stats right", () => {
  const line = renderStatusBar({
    ...base,
    thinking: "high",
    branch: "main",
    dirtyCount: 19,
    cwd: "/Users/x/projects/jeo-code",
    ctxPct: 12.6,
    ctxMaxTokens: 1_000_000,
  });
  expect(visibleWidth(line)).toBe(80);
  expect(line).toContain("⬢ gpt-5.5");
  expect(line).toContain("◔ high");
  expect(line).toContain("⑂ main ?19");
  expect(line).toContain("jeo-code");
  // Right stats sit at the right edge.
  expect(line.trimEnd().endsWith("13%/1M")).toBe(true);
});

test("status bar: routedTier renders the ⚡ marker right after the model, before thinking", () => {
  const line = renderStatusBar({ ...base, thinking: "high", routedTier: "trivial" });
  expect(line).toContain("⬢ gpt-5.5 ⚡trivial · ◔ high");
});

test("status bar: routedTier omitted entirely when routing didn't engage this turn", () => {
  const line = renderStatusBar({ ...base, thinking: "high" });
  expect(line).not.toContain("⚡");
});

test("status bar: routedTier ASCII fallback uses ~ instead of ⚡", () => {
  const line = renderStatusBar({ ...base, unicode: false, routedTier: "complex" });
  expect(line).toContain("* gpt-5.5 ~complex");
  expect(line).not.toContain("⚡");
});

test("status bar: each tier value renders verbatim (trivial/standard/complex)", () => {
  for (const tier of ["trivial", "standard", "complex"] as const) {
    const line = renderStatusBar({ ...base, routedTier: tier });
    expect(line).toContain(`⚡${tier}`);
  }
});

test("status bar: omits absent pieces and still fits", () => {
  const line = renderStatusBar({ ...base, cols: 40 });
  expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  expect(line).toContain("⬢ gpt-5.5");
  expect(line).not.toContain("◔");
  expect(line).not.toContain("⑂");
});

test("status bar: never overflows a terminal narrower than the old 24-col floor", () => {
  // Regression: `cols` used to be clamped UP to a minimum of 24 (Math.max(24, ...)),
  // silently overflowing any REAL terminal narrower than that (e.g. a resize down to
  // 20 cols still produced a 24-col-wide status line). A real terminal then hard-wraps
  // that overflow, which — live in tmux — desynced the idle-footer's own row
  // bookkeeping and produced a growing stack of duplicate status-bar lines on every
  // subsequent keystroke (reproduced deterministically via a byte-for-byte ANSI replay
  // outside jeo/tmux entirely, confirming the escape sequences themselves, not timing).
  for (const cols of [5, 10, 15, 19, 20, 23]) {
    const line = renderStatusBar({ model: "antigravity/claude-sonnet-4-6 (antigravity)", cols, color: false, unicode: true, thinking: "xhigh", branch: "main", dirtyCount: 3 });
    expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
  }
});

test("status bar: live rate renders with the ⤴ glyph", () => {
  const line = renderStatusBar({ ...base, rate: 12.14, ctxPct: 50, ctxMaxTokens: 200_000 });
  expect(line).toContain("⤴ 12.1/s");
  expect(line).toContain("50%/200k");
});

test("status bar: long cwd is tail-truncated instead of overflowing", () => {
  const line = renderStatusBar({
    ...base,
    cols: 60,
    cwd: "/very/long/path/that/keeps/going/and/going/projects/jeo-code",
    ctxPct: 5,
    ctxMaxTokens: 200_000,
  });
  expect(visibleWidth(line)).toBeLessThanOrEqual(60);
  expect(line).toContain("…");
});

test("status bar: color mode paints the left segment as a bg block", () => {
  const line = renderStatusBar({ ...base, color: true, ctxPct: 10, ctxMaxTokens: 200_000 });
  expect(line).toContain("\x1b[48;2;"); // truecolor background escapes
});

test("input box: attachmentLabel renders inside the box", () => {
  const frame = renderInputFrame("hello [image #1]", {
    cols: 60,
    color: false,
    unicode: true,
    attachmentLabel: "⧉ 1 image attached — sent with the next message",
  });
  const joined = frame.lines.join("\n");
  expect(joined).toContain("⧉ 1 image attached");
});
