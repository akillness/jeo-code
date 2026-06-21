import { test, expect } from "bun:test";
import {
  MULTILINE_SENTINEL,
  isGenuineMultilineDraft,
  shouldBoxVerticalNav,
} from "../src/commands/launch";
import { caretCells, verticalCursorOffset } from "../src/tui/components/input-box";

// The boxed prompt's Up/Down keys either move the caret between the box's VISUAL rows
// (textarea feel) or fall through to readline's input-history recall. The split is now
// BOUNDARY-AWARE: shouldBoxVerticalNav is a coarse gate (arrows not owned by a slash list
// or the Ctrl+O history panel, draft non-empty), and verticalCursorOffset makes the real
// per-keystroke decision — it yields a target offset only when a visual row exists to move
// to, so ↑ on the top row / ↓ on the bottom row (and any single-row draft) return null and
// recall history instead. This lets ↑/↓ edit BOTH an explicit multi-line draft AND a long
// soft-wrapped line, while keeping "↑ recalls the previous prompt" at the edges.

test("isGenuineMultilineDraft is true only with an explicit line break, not on soft-wrap", () => {
  // Explicit break (Shift+Enter / pasted newline) → sentinel present → multi-line.
  expect(isGenuineMultilineDraft(`first${MULTILINE_SENTINEL}second`)).toBe(true);
  // A long single line the box would soft-wrap carries NO sentinel → not multi-line.
  const longWrapping = "a".repeat(400);
  expect(isGenuineMultilineDraft(longWrapping)).toBe(false);
  // Korean text long enough to wrap is still a single logical line → not multi-line.
  expect(isGenuineMultilineDraft("가".repeat(200))).toBe(false);
  expect(isGenuineMultilineDraft("")).toBe(false);
});

test("shouldBoxVerticalNav gates in-box vertical nav for any non-empty draft", () => {
  const multi = `top${MULTILINE_SENTINEL}bottom`;
  const wrapped = "word ".repeat(80); // soft-wraps but is one logical line
  // Both an explicit multi-line draft AND a soft-wrapped single line are eligible: the
  // boundary check (verticalCursorOffset) decides the actual move vs history fall-through.
  expect(shouldBoxVerticalNav(multi, { slashMatchCount: 0, historyPanelOpen: false })).toBe(true);
  expect(shouldBoxVerticalNav(wrapped, { slashMatchCount: 0, historyPanelOpen: false })).toBe(true);
  // An empty draft has nothing to move within → ↑/↓ go straight to history.
  expect(shouldBoxVerticalNav("", { slashMatchCount: 0, historyPanelOpen: false })).toBe(false);
});

test("shouldBoxVerticalNav yields the arrows to an open slash list or history panel", () => {
  const multi = `top${MULTILINE_SENTINEL}bottom`;
  // A slash dropdown owns ↑/↓ for its selection, even on a multi-line draft.
  expect(shouldBoxVerticalNav(multi, { slashMatchCount: 3, historyPanelOpen: false })).toBe(false);
  // The Ctrl+O history panel owns ↑/↓ for scrolling.
  expect(shouldBoxVerticalNav(multi, { slashMatchCount: 0, historyPanelOpen: true })).toBe(false);
  // Both overlays closed → vertical nav is allowed again.
  expect(shouldBoxVerticalNav(multi, { slashMatchCount: 0, historyPanelOpen: false })).toBe(true);
});

test("verticalCursorOffset moves the caret within a SOFT-WRAPPED single line, history at edges", () => {
  // A long single logical line (no sentinel) the box wraps onto multiple visual rows.
  const width = 10;
  const line = "abcde fghij klmno pqrst"; // wraps every ~10 display cols
  const cells = caretCells(line, width);
  const maxRow = cells[cells.length - 1]!.row;
  expect(maxRow).toBeGreaterThan(0); // genuinely multi-row when wrapped

  // Caret at the END (bottom visual row): ↑ has a row above → moves there (non-null).
  const up = verticalCursorOffset(line, line.length, width, "up");
  expect(up).not.toBeNull();
  expect(cells[up!]!.row).toBe(maxRow - 1);

  // ↓ from the bottom row has no row below → null → readline recalls history.
  expect(verticalCursorOffset(line, line.length, width, "down")).toBeNull();

  // Caret at the very START (top visual row): ↑ has no row above → null → history.
  expect(verticalCursorOffset(line, 0, width, "up")).toBeNull();
  // ↓ from the top row moves down a visual row (non-null).
  const down = verticalCursorOffset(line, 0, width, "down");
  expect(down).not.toBeNull();
  expect(cells[down!]!.row).toBe(1);
});

test("verticalCursorOffset returns null for a single-visual-row draft (always history)", () => {
  // Short line that fits one visual row → ↑/↓ both yield null → history recall, unchanged.
  expect(verticalCursorOffset("hi there", 4, 40, "up")).toBeNull();
  expect(verticalCursorOffset("hi there", 4, 40, "down")).toBeNull();
});
