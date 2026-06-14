import { test, expect } from "bun:test";
import {
  DNA_CLAW_ART,
  DNA_CLAW_FRAMES,
  DNA_CLAW_FRAMES_ASCII,
  DNA_FLOW_PALETTE,
  dnaClawBeat,
  dnaClawFrameCount,
  dnaClawHeight,
  renderDnaClaw,
} from "../src/tui/components/ascii-art";
import { ColorLevel } from "../src/tui/components/color";
import { formatForgeBox, type ForgeSummary } from "../src/tui/components/forge";
import { estimateMessageTokens, historyTokens } from "../src/agent/compaction";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("twist frames: frame 0 is the static symbol; all frames share dimensions", () => {
  expect(DNA_CLAW_FRAMES[0]).toBe(DNA_CLAW_ART);
  expect(dnaClawFrameCount()).toBeGreaterThanOrEqual(2);
  for (const frames of [DNA_CLAW_FRAMES, DNA_CLAW_FRAMES_ASCII]) {
    const height = frames[0]!.length;
    const width = Math.max(...frames[0]!.map(l => l.length));
    for (const frame of frames) {
      expect(frame.length).toBe(height);
      for (const line of frame) expect(line.length).toBeLessThanOrEqual(width);
    }
  }
  expect(dnaClawHeight()).toBe(DNA_CLAW_ART.length);
});

test("twist frames actually differ (the helix rotates) and wrap", () => {
  const f0 = renderDnaClaw({ color: false, frame: 0 }).join("\n");
  const f1 = renderDnaClaw({ color: false, frame: 1 }).join("\n");
  expect(f1).not.toBe(f0);
  // Wrapping: frame N === frame N % count.
  const wrapped = renderDnaClaw({ color: false, frame: dnaClawFrameCount() }).join("\n");
  expect(wrapped).toBe(f0);
});

test("gradient animates across phases at TrueColor; plain output is phase-stable", () => {
  const a = renderDnaClaw({ phase: 0, frame: 0, colorLevel: ColorLevel.TrueColor }).join("\n");
  const b = renderDnaClaw({ phase: 0.5, frame: 0, colorLevel: ColorLevel.TrueColor }).join("\n");
  expect(a).not.toBe(b); // flowing gradient
  expect(stripAnsi(a)).toBe(stripAnsi(b)); // same glyphs — only colors move
  const p0 = renderDnaClaw({ color: false, phase: 0 }).join("\n");
  const p1 = renderDnaClaw({ color: false, phase: 0.5 }).join("\n");
  expect(p0).toBe(p1);
});

test("renderDnaClaw memoizes identical frames (same args → cached ref; different args → recomputed)", () => {
  const args = { phase: 0.15, frame: 1, cols: 80, color: true, colorLevel: ColorLevel.TrueColor } as const;
  const a = renderDnaClaw({ ...args });
  const b = renderDnaClaw({ ...args });
  expect(b).toBe(a); // identical inputs return the cached array (no per-frame ANSI recompute)
  // Any input that changes the output is a distinct cache key.
  expect(renderDnaClaw({ ...args, phase: 0.2 })).not.toBe(a);
  expect(renderDnaClaw({ ...args, frame: 2 })).not.toBe(a);
  expect(renderDnaClaw({ ...args, cols: 40 })).not.toBe(a);
  // Content is still correct (memo is transparent).
  expect(stripAnsi(a.join("\n"))).toBe(stripAnsi(renderDnaClaw({ ...args, phase: 0.99 }).join("\n")));
});

test("grand variant ignores the twist frame (static welcome hero)", () => {
  const g0 = renderDnaClaw({ color: false, grand: true, frame: 0 }).join("\n");
  const g1 = renderDnaClaw({ color: false, grand: true, frame: 1 }).join("\n");
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

// ---- Forge DNA-flow border (live in-flight card animation) ------------------

const flowSummary: ForgeSummary = { title: "bash running", lines: ["$ bun test", "working…"] };

test("forge flow: gradient borders animate with phase; glyph geometry is unchanged", () => {
  const id = (s: string) => s;
  const base = formatForgeBox(flowSummary, { width: 40, unicode: false, paint: id, paintShadow: id, color: true });
  const f0 = formatForgeBox(flowSummary, {
    width: 40, unicode: false, paint: id, paintShadow: id, color: true,
    flow: { palette: DNA_FLOW_PALETTE, phase: 0, colorLevel: ColorLevel.TrueColor },
  });
  const f5 = formatForgeBox(flowSummary, {
    width: 40, unicode: false, paint: id, paintShadow: id, color: true,
    flow: { palette: DNA_FLOW_PALETTE, phase: 0.5, colorLevel: ColorLevel.TrueColor },
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
    flow: { palette: DNA_FLOW_PALETTE, phase: 0.3, colorLevel: ColorLevel.Ansi256 },
  });
  expect(lowColor).toEqual(base);
});

test("forge flow: color:false ignores flow entirely (plain pipelines stay plain)", () => {
  const plain = formatForgeBox(flowSummary, { width: 36, unicode: false, color: false });
  const plainFlow = formatForgeBox(flowSummary, {
    width: 36, unicode: false, color: false,
    flow: { palette: DNA_FLOW_PALETTE, phase: 0.7, colorLevel: ColorLevel.TrueColor },
  });
  expect(plainFlow).toEqual(plain);
});

test("forge titleMark: claw beat rides the border title without breaking width", () => {
  const id = (s: string) => s;
  const marked = formatForgeBox(flowSummary, { width: 40, unicode: false, paint: id, paintShadow: id, color: false, titleMark: dnaClawBeat(0, false) });
  expect(stripAnsi(marked[0]!)).toContain("* bash running");
  // Every row keeps the exact box width — the mark is absorbed by the title budget.
  for (const row of marked) expect(stripAnsi(row).length).toBe(40);
});

test("dnaClawBeat cycles width-1 claw motifs and wraps", () => {
  const seen = new Set([dnaClawBeat(0), dnaClawBeat(1), dnaClawBeat(2)]);
  expect(seen.size).toBe(3);
  expect(dnaClawBeat(3)).toBe(dnaClawBeat(0)); // wraps
  expect(dnaClawBeat(1, false)).toBe("X"); // ASCII fallback
  for (const beat of seen) expect(beat.length).toBe(1);
});
