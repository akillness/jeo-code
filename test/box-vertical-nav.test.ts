import { test, expect } from "bun:test";
import {
  MULTILINE_SENTINEL,
  isGenuineMultilineDraft,
  shouldBoxVerticalNav,
} from "../src/commands/launch";

// The boxed prompt's Up/Down keys either move the caret between the box's VISUAL rows
// (textarea feel) or fall through to readline's input-history recall. The deciding rule:
// only a GENUINELY multi-line draft — one carrying an explicit Shift+Enter / pasted break,
// stored as the private-use MULTILINE_SENTINEL — gets in-box vertical nav. A long single
// line that merely SOFT-WRAPS to several rows is NOT multi-line, so ↑ recalls the previous
// prompt instead of dragging the wrapped tail up a visual row (the reported bug). These
// lock that gate independently of the live readline/PTY wiring.

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

test("shouldBoxVerticalNav gates in-box vertical nav on a genuine multi-line draft", () => {
  const multi = `top${MULTILINE_SENTINEL}bottom`;
  const wrapped = "word ".repeat(80); // soft-wraps but is one logical line
  // Multi-line draft, nothing else owning the arrows → in-box vertical nav.
  expect(shouldBoxVerticalNav(multi, { slashMatchCount: 0, historyPanelOpen: false })).toBe(true);
  // Soft-wrapped single line → fall through to history recall.
  expect(shouldBoxVerticalNav(wrapped, { slashMatchCount: 0, historyPanelOpen: false })).toBe(false);
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
