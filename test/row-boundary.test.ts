import { test, expect } from "bun:test";
import { rowBoundaryOffset } from "../src/tui/components/input-box";

// rowBoundaryOffset is the row-aware counterpart to Home/End (and macOS Cmd+Left/Right):
// it jumps to the start/end of the VISUAL ROW containing the cursor, not the whole buffer —
// correct on a multi-row draft (Shift+Enter breaks or box soft-wrap), degenerating to plain
// whole-buffer 0/length on a single-row draft.

test("rowBoundaryOffset degenerates to whole-buffer start/end on a single-row draft", () => {
  const t = "hello world";
  expect(rowBoundaryOffset(t, 5, 80, "start")).toBe(0);
  expect(rowBoundaryOffset(t, 5, 80, "end")).toBe(t.length);
});

test("rowBoundaryOffset stops at the current row's boundary on a multi-line (\\n) draft", () => {
  const t = "abc\ndefgh\nij"; // row0: abc (0..3), row1: defgh (4..9), row2: ij (10..12)
  // Cursor inside row1 (col 2 of "defgh", offset 6) → row1 start/end, not row0/row2.
  expect(rowBoundaryOffset(t, 6, 80, "start")).toBe(4);
  expect(rowBoundaryOffset(t, 6, 80, "end")).toBe(9);
  // Cursor on row0 stays within row0.
  expect(rowBoundaryOffset(t, 1, 80, "start")).toBe(0);
  expect(rowBoundaryOffset(t, 1, 80, "end")).toBe(3);
  // Cursor on the last row (no trailing "\n") still resolves within that row.
  expect(rowBoundaryOffset(t, 11, 80, "start")).toBe(10);
  expect(rowBoundaryOffset(t, 11, 80, "end")).toBe(12);
});

test("rowBoundaryOffset stops at the current row's boundary on a SOFT-WRAPPED single line", () => {
  // No "\n": "aaaa bbbb" wraps at width 4 into rows "aaaa" (idx 0-3) / " bbb" (idx 4-7) / "b" (idx 8-9).
  const t = "aaaa bbbb";
  // Cursor at offset 7 (inside the second visual row " bbb", covering positions 4..7).
  expect(rowBoundaryOffset(t, 7, 4, "start")).toBe(4);
  expect(rowBoundaryOffset(t, 7, 4, "end")).toBe(7);
  // Cursor on the first visual row.
  expect(rowBoundaryOffset(t, 2, 4, "start")).toBe(0);
  expect(rowBoundaryOffset(t, 2, 4, "end")).toBe(3);
  // Cursor on the last (trailing) visual row "b" (idx 8..9, the 4th "b" plus end-of-text caret).
  expect(rowBoundaryOffset(t, 9, 4, "start")).toBe(8);
  expect(rowBoundaryOffset(t, 9, 4, "end")).toBe(9);
});

test("rowBoundaryOffset clamps an out-of-range cursor and handles empty text", () => {
  expect(rowBoundaryOffset("", 0, 80, "start")).toBe(0);
  expect(rowBoundaryOffset("", 0, 80, "end")).toBe(0);
  const t = "abc";
  // Cursor past the end clamps to the last caret position (index length).
  expect(rowBoundaryOffset(t, 999, 80, "start")).toBe(0);
  expect(rowBoundaryOffset(t, 999, 80, "end")).toBe(3);
  // Negative cursor clamps to 0.
  expect(rowBoundaryOffset(t, -5, 80, "start")).toBe(0);
  expect(rowBoundaryOffset(t, -5, 80, "end")).toBe(3);
});
