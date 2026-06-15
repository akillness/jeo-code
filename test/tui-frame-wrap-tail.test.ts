import { test, expect } from "bun:test";
import { tailForWrap, FRAME_WRAP_TAIL_CHARS } from "../src/tui/app";
import { wrapTextWithAnsi } from "../src/tui/components/width";

// Per-frame guard: the live thinking/tool-output blocks re-wrap their source string on
// EVERY 120ms tick but only ever display the last few wrapped rows. tailForWrap bounds the
// re-wrapped input to a fixed trailing window so per-frame cost stays O(window) instead of
// growing with how much has streamed — WITHOUT changing any on-screen row.

test("tailForWrap leaves a short string untouched", () => {
  expect(tailForWrap("hello\nworld")).toBe("hello\nworld");
  expect(tailForWrap("")).toBe("");
});

test("tailForWrap slices a long string to its last maxChars", () => {
  const big = "x".repeat(FRAME_WRAP_TAIL_CHARS + 5000);
  const out = tailForWrap(big);
  expect(out.length).toBe(FRAME_WRAP_TAIL_CHARS);
  expect(out).toBe(big.slice(big.length - FRAME_WRAP_TAIL_CHARS));
});

test("custom cap is honored", () => {
  expect(tailForWrap("abcdef", 4)).toBe("cdef");
  expect(tailForWrap("ab", 4)).toBe("ab");
});

test("visible tail is byte-identical: last N wrapped rows match the full-wrap result", () => {
  // A huge multi-line trace (hundreds of KB) like a long reasoning/tool stream.
  const huge = Array.from({ length: 40000 }, (_, i) => `line ${i} ${"y".repeat(30)}`).join("\n");
  const cols = 78;
  const ROWS = 8;
  const full = huge.split("\n").flatMap(l => wrapTextWithAnsi(l, cols)).filter(l => l.length > 0);
  const bounded = tailForWrap(huge).split("\n").flatMap(l => wrapTextWithAnsi(l, cols)).filter(l => l.length > 0);
  // The displayed tail (last ROWS wrapped rows) is identical, even though `bounded`
  // wrapped only the last 16 KiB instead of the whole ~1.5 MB string.
  expect(bounded.slice(-ROWS)).toEqual(full.slice(-ROWS));
  expect(bounded.length).toBeLessThan(full.length); // proof the input really was bounded
});

test("a single very long line still shows the genuine END of the content, bounded", () => {
  // No newlines (e.g. a minified blob): the char-window cut can land mid-wrap, so the
  // exact row alignment may differ from a full wrap — but the displayed tail is still a
  // true suffix of the streamed content, and the work is capped to the window.
  const oneHugeLine = "z".repeat(FRAME_WRAP_TAIL_CHARS * 3) + "END-OF-STREAM";
  const cols = 80;
  const ROWS = 8;
  const bounded = wrapTextWithAnsi(tailForWrap(oneHugeLine), cols);
  expect(oneHugeLine.endsWith(bounded.slice(-ROWS).join(""))).toBe(true);
  expect(bounded[bounded.length - 1]!.endsWith("END-OF-STREAM")).toBe(true);
  expect(bounded.length).toBeLessThanOrEqual(Math.ceil(FRAME_WRAP_TAIL_CHARS / cols) + 1);
});
