import { test, expect } from "bun:test";
import {
  MULTILINE_SENTINEL,
  isGenuineMultilineDraft,
  shouldBoxVerticalNav,
} from "../src/commands/launch";
import { caretCells, verticalCursorOffset } from "../src/tui/components/input-box";
import { boxVerticalNavAction } from "../src/commands/launch";

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

// boxVerticalNavAction folds the boundary decision into one verdict the input filter acts on:
// "move" repositions the caret, "swallow" keeps a GENUINE multi-line draft intact at the
// edge (the ↓-cuts-the-lower-text fix), and "history" lets a soft-wrapped one-liner recall
// input history at the edge. expandedLine has explicit breaks as "\n"; rawLine keeps sentinels.
const expand = (raw: string) => raw.split(MULTILINE_SENTINEL).join("\n");

test("boxVerticalNavAction moves the caret when a visual row exists in the direction", () => {
  const raw = `line one${MULTILINE_SENTINEL}line two${MULTILINE_SENTINEL}line three`;
  const exp = expand(raw);
  // Caret on the TOP row, ↓ → there is a row below → move (not history, not swallow).
  const down = boxVerticalNavAction(exp, raw, 0, 40, "down");
  expect(down.kind).toBe("move");
  if (down.kind === "move") expect(down.cursor).toBeGreaterThan(0);
  // Caret on the BOTTOM row, ↑ → there is a row above → move.
  expect(boxVerticalNavAction(exp, raw, exp.length, 40, "up").kind).toBe("move");
});

test("boxVerticalNavAction SWALLOWS the edge keystroke on a genuine multi-line draft (no history wipe)", () => {
  const raw = `line one${MULTILINE_SENTINEL}line two${MULTILINE_SENTINEL}line three`;
  const exp = expand(raw);
  // ↓ on the BOTTOM row of a deliberate multi-line message must NOT fall through to
  // readline history recall (which would erase the draft) — it is swallowed instead.
  expect(boxVerticalNavAction(exp, raw, exp.length, 40, "down").kind).toBe("swallow");
  // ↑ on the TOP row of the same draft is likewise swallowed, keeping the content.
  expect(boxVerticalNavAction(exp, raw, 0, 40, "up").kind).toBe("swallow");
});

test("boxVerticalNavAction yields HISTORY at the edges of a soft-wrapped single line", () => {
  // One logical line (no sentinel) that the box wraps onto several visual rows.
  const raw = "abcde fghij klmno pqrst";
  const exp = raw; // no sentinel → expanded form is identical
  // ↓ on the bottom row / ↑ on the top row recall input history (the one-liner REPL default).
  expect(boxVerticalNavAction(exp, raw, raw.length, 10, "down").kind).toBe("history");
  expect(boxVerticalNavAction(exp, raw, 0, 10, "up").kind).toBe("history");
  // Interior move still wins over history.
  expect(boxVerticalNavAction(exp, raw, 0, 10, "down").kind).toBe("move");
});

test("boxVerticalNavAction yields HISTORY for a single-visual-row draft in both directions", () => {
  // Short line that fits one visual row → no in-box move either way → history recall.
  expect(boxVerticalNavAction("hi there", "hi there", 4, 40, "up").kind).toBe("history");
  expect(boxVerticalNavAction("hi there", "hi there", 4, 40, "down").kind).toBe("history");
});
