import { test, expect } from "bun:test";
import { caretCells, verticalCursorOffset } from "../src/tui/components/input-box";

// Up/Down inside the boxed prompt move the caret between the input box's VISUAL rows
// (textarea feel), keeping the display column. The same wrapping rule the box renders with
// drives the row layout, so a cursor that moves down lands where the next row visibly is —
// whether rows come from explicit "\n" line breaks or from a long line wrapping at the box
// width. At the top/bottom row the move returns null so ↑/↓ falls through to readline's
// input-history recall (the shell convention). These tests lock that pure geometry.

test("caretCells reports (row,col) for every caret position using the box wrap rule", () => {
  // "abc\ndef": two logical lines, no wrapping at a wide width.
  const cells = caretCells("abc\ndef", 80);
  expect(cells).toEqual([
    { row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }, { row: 0, col: 3 },
    { row: 1, col: 0 }, { row: 1, col: 1 }, { row: 1, col: 2 }, { row: 1, col: 3 },
  ]);
});

test("verticalCursorOffset moves between logical lines keeping the column", () => {
  const t = "abc\ndef"; // line1 = abc (cols 0..3), line2 = def (cols 0..3)
  // Down from inside line 1 lands at the same column on line 2.
  expect(verticalCursorOffset(t, 2, 80, "down")).toBe(6); // col2 on row0 → col2 on row1
  expect(verticalCursorOffset(t, 0, 80, "down")).toBe(4); // col0 → col0
  // Up from inside line 2 lands at the same column on line 1.
  expect(verticalCursorOffset(t, 7, 80, "up")).toBe(3); // end of line2 → end of line1
  expect(verticalCursorOffset(t, 5, 80, "up")).toBe(1); // col1 → col1
});

test("verticalCursorOffset returns null at the top/bottom edge so history recall fires", () => {
  const t = "abc\ndef";
  expect(verticalCursorOffset(t, 0, 80, "up")).toBeNull();   // already on the top row
  expect(verticalCursorOffset(t, 7, 80, "down")).toBeNull(); // already on the bottom row
  // A single short line has only one row: both directions hit the edge.
  expect(verticalCursorOffset("hello", 3, 80, "up")).toBeNull();
  expect(verticalCursorOffset("hello", 3, 80, "down")).toBeNull();
  // Empty text has no rows to move within.
  expect(verticalCursorOffset("", 0, 80, "up")).toBeNull();
});

test("verticalCursorOffset snaps to the line end when the target row is shorter", () => {
  const t = "abcdef\ngh"; // line1 cols 0..6, line2 cols 0..2
  // Down from col4 on the long line → clamp to the end (col2) of the short line.
  expect(verticalCursorOffset(t, 4, 80, "down")).toBe(9); // pos 9 = end of "gh"
  // Up from the end of the short line keeps the column on the long line.
  expect(verticalCursorOffset(t, 9, 80, "up")).toBe(2); // col2 on line1
});

test("verticalCursorOffset moves between WRAPPED visual rows of one long line", () => {
  // No "\n": "aaaa bbbb" wraps at width 4 into rows aaaa / [space]bbb / b.
  const t = "aaaa bbbb";
  // From the last visual row (the trailing "b") Up lands one row up at the same column.
  expect(verticalCursorOffset(t, 9, 4, "up")).toBe(5);
  // The very first visual row has nothing above it.
  expect(verticalCursorOffset(t, 0, 4, "up")).toBeNull();
});
