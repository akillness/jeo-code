import { test, expect } from "bun:test";
import {
  FORGE_MARK_ART,
  FORGE_MARK_FRAMES,
  FORGE_MARK_FRAMES_ASCII,
  FORGE_FLOW_PALETTE,
  forgeBeat,
  forgeMarkFrameCount,
  forgeMarkHeight,
  renderForgeMark,
} from "../src/tui/components/ascii-art";
import { ColorLevel } from "../src/tui/components/color";
import { formatForgeBox, type ForgeSummary } from "../src/tui/components/forge";
import { estimateMessageTokens, historyTokens } from "../src/agent/compaction";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("blink frames: frame 0 is the static symbol; all frames share dimensions", () => {
  expect(FORGE_MARK_FRAMES[0]).toBe(FORGE_MARK_ART);
  expect(forgeMarkFrameCount()).toBeGreaterThanOrEqual(2);
  for (const frames of [FORGE_MARK_FRAMES, FORGE_MARK_FRAMES_ASCII]) {
    const height = frames[0]!.length;
    const width = Math.max(...frames[0]!.map(l => l.length));
    for (const frame of frames) {
      expect(frame.length).toBe(height);
      for (const line of frame) expect(line.length).toBeLessThanOrEqual(width);
    }
  }
  expect(forgeMarkHeight()).toBe(FORGE_MARK_ART.length);
});

test("blink frames actually differ (the cursor blinks) and wrap", () => {
  const f0 = renderForgeMark({ color: false, frame: 0 }).join("\n");
  const f1 = renderForgeMark({ color: false, frame: 1 }).join("\n");
  expect(f1).not.toBe(f0);
  // Wrapping: frame N === frame N % count.
  const wrapped = renderForgeMark({ color: false, frame: forgeMarkFrameCount() }).join("\n");
  expect(wrapped).toBe(f0);
});

test("gradient animates across phases at TrueColor; plain output is phase-stable", () => {
  const a = renderForgeMark({ phase: 0, frame: 0, colorLevel: ColorLevel.TrueColor }).join("\n");
  const b = renderForgeMark({ phase: 0.5, frame: 0, colorLevel: ColorLevel.TrueColor }).join("\n");
  expect(a).not.toBe(b); // flowing gradient
  expect(stripAnsi(a)).toBe(stripAnsi(b)); // same glyphs — only colors move
  const p0 = renderForgeMark({ color: false, phase: 0 }).join("\n");
  const p1 = renderForgeMark({ color: false, phase: 0.5 }).join("\n");
  expect(p0).toBe(p1);
});

test("renderForgeMark memoizes identical frames (same args → cached ref; different args → recomputed)", () => {
  const args = { phase: 0.15, frame: 1, cols: 80, color: true, colorLevel: ColorLevel.TrueColor } as const;
  const a = renderForgeMark({ ...args });
  const b = renderForgeMark({ ...args });
  expect(b).toBe(a); // identical inputs return the cached array (no per-frame ANSI recompute)
  // Any input that changes the output is a distinct cache key.
  expect(renderForgeMark({ ...args, phase: 0.2 })).not.toBe(a);
  expect(renderForgeMark({ ...args, frame: 0 })).not.toBe(a);
  expect(renderForgeMark({ ...args, cols: 40 })).not.toBe(a);
  // Content is still correct (memo is transparent).
  expect(stripAnsi(a.join("\n"))).toBe(stripAnsi(renderForgeMark({ ...args, phase: 0.99 }).join("\n")));
});

test("grand variant ignores the blink frame (static welcome hero)", () => {
  const g0 = renderForgeMark({ color: false, grand: true, frame: 0 }).join("\n");
  const g1 = renderForgeMark({ color: false, grand: true, frame: 1 }).join("\n");
  expect(g1).toBe(g0);
});

test("estimateMessageTokens: identity-cached, replacement-keyed (no stale, no growth)", () => {
  const msg = { role: "user" as const, content: "hello ".repeat(1000) };
  const first = estimateMessageTokens(msg);
  expect(estimateMessageTokens(msg)).toBe(first); // cached hit, same value
  // Replacement object with different content computes a DIFFERENT count —
  // the cache keys by identity, and the codebase replaces (never mutates) messages.
  const replacement = { role: "user" as const, content: "hi" };
  expect(estimateMessageTokens(replacement)).not.toBe(first);
  // historyTokens over a long history is consistent across repeated calls.
  const history = Array.from({ length: 500 }, (_, i) => ({ role: "user" as const, content: `msg ${i} ${"x".repeat(50)}` }));
  const t1 = historyTokens(history);
  const t2 = historyTokens(history); // second pass: all cache hits
  expect(t2).toBe(t1);
});

// ---- Forge flow border (live in-flight card animation) ------------------

const flowSummary: ForgeSummary = { title: "bash running", lines: ["$ bun test", "working…"] };

test("forge flow: gradient borders animate with phase; glyph geometry is unchanged", () => {
  const id = (s: string) => s;
  const base = formatForgeBox(flowSummary, { width: 40, unicode: false, paint: id, paintShadow: id, color: true });
  const f0 = formatForgeBox(flowSummary, {
    width: 40, unicode: false, paint: id, paintShadow: id, color: true,
    flow: { palette: FORGE_FLOW_PALETTE, phase: 0, colorLevel: ColorLevel.TrueColor },
  });
  const f5 = formatForgeBox(flowSummary, {
    width: 40, unicode: false, paint: id, paintShadow: id, color: true,
    flow: { palette: FORGE_FLOW_PALETTE, phase: 0.5, colorLevel: ColorLevel.TrueColor },
  });
  // Animation: borders carry truecolor codes and MOVE between phases.
  expect(f0[0]).toContain("38;2;");
  expect(f0[f0.length - 1]).toContain("38;2;");
  expect(f0[0]).not.toBe(f5[0]);
  // Accuracy: stripped glyphs are byte-identical to the static render — the flow
  // changes colors only, never geometry (no width drift, no row growth).
  expect(f0.map(stripAnsi)).toEqual(base.map(stripAnsi));
  expect(f5.map(stripAnsi)).toEqual(base.map(stripAnsi));
  // Content rows stay un-animated (only the border runs are painted per tick).
  expect(stripAnsi(f0[1]!)).toBe(stripAnsi(base[1]!));
});

test("forge flow: below TrueColor the static paint path is used byte-identically", () => {
  const id = (s: string) => s;
  const base = formatForgeBox(flowSummary, { width: 36, unicode: false, paint: id, paintShadow: id, color: true });
  const lowColor = formatForgeBox(flowSummary, {
    width: 36, unicode: false, paint: id, paintShadow: id, color: true,
    flow: { palette: FORGE_FLOW_PALETTE, phase: 0.3, colorLevel: ColorLevel.Ansi256 },
  });
  expect(lowColor).toEqual(base);
});

test("forge flow: color:false ignores flow entirely (plain pipelines stay plain)", () => {
  const plain = formatForgeBox(flowSummary, { width: 36, unicode: false, color: false });
  const plainFlow = formatForgeBox(flowSummary, {
    width: 36, unicode: false, color: false,
    flow: { palette: FORGE_FLOW_PALETTE, phase: 0.7, colorLevel: ColorLevel.TrueColor },
  });
  expect(plainFlow).toEqual(plain);
});

test("forge titleMark: prompt beat rides the border title without breaking width", () => {
  const id = (s: string) => s;
  const marked = formatForgeBox(flowSummary, { width: 40, unicode: false, paint: id, paintShadow: id, color: false, titleMark: forgeBeat(0, false) });
  expect(stripAnsi(marked[0]!)).toContain("> bash running");
  // Every row keeps the exact box width — the mark is absorbed by the title budget.
  for (const row of marked) expect(stripAnsi(row).length).toBe(40);
});

test("forgeBeat cycles width-1 jeo-prompt motifs and wraps", () => {
  const seen = new Set([forgeBeat(0), forgeBeat(1), forgeBeat(2)]);
  expect(seen.size).toBe(3);
  expect(forgeBeat(3)).toBe(forgeBeat(0)); // wraps
  expect(forgeBeat(1, false)).toBe("#"); // ASCII fallback
  for (const beat of seen) expect(beat.length).toBe(1);
});
