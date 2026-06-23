import { test, expect } from "bun:test";
import { tailForWrap, liveBlockWrapKey, FRAME_WRAP_TAIL_CHARS } from "../src/tui/app";
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

// Regression: the live-block wrap MEMO KEY must also be bounded. It used to interpolate
// the full streamed buffer (`${wrapW}\u0000${text}`), so every 120ms tick and every delta
// allocated + compared a copy of the whole growing string — O(len) per frame, O(len²) over
// a long reasoning/tool stream (the streaming slowdown). liveBlockWrapKey keys on the tail.
test("liveBlockWrapKey stays bounded regardless of total stream length", () => {
  const wrapW = 78;
  const short = liveBlockWrapKey(wrapW, "hello\nworld");
  expect(short).toBe(`${wrapW}\u0000hello\nworld`);

  const huge = "x".repeat(FRAME_WRAP_TAIL_CHARS * 50); // ~800 KB stream
  const key = liveBlockWrapKey(wrapW, huge);
  // Key = "<wrapW>\u0000" + tail; tail is capped at FRAME_WRAP_TAIL_CHARS.
  expect(key.length).toBeLessThanOrEqual(FRAME_WRAP_TAIL_CHARS + 16);
  expect(key.length).toBeLessThan(huge.length); // proof it did NOT embed the whole buffer
  expect(key).toBe(`${wrapW}\u0000${tailForWrap(huge)}`);
});

test("liveBlockWrapKey collides only when the displayed tail is identical", () => {
  const wrapW = 40;
  const tailA = "y".repeat(FRAME_WRAP_TAIL_CHARS);
  // Two different full buffers that share the exact same trailing window render the same
  // rows, so they SHOULD share a cache key (a hit avoids a redundant re-wrap).
  expect(liveBlockWrapKey(wrapW, "AAAA" + tailA)).toBe(liveBlockWrapKey(wrapW, "BBBBBB" + tailA));
  // A changed tail (new delta) misses, forcing exactly one recompute.
  expect(liveBlockWrapKey(wrapW, tailA + "Z")).not.toBe(liveBlockWrapKey(wrapW, tailA));
  // Width changes also invalidate (different wrap).
  expect(liveBlockWrapKey(41, tailA)).not.toBe(liveBlockWrapKey(40, tailA));
});
