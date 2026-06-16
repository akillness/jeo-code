import { test, expect } from "bun:test";
import { CURSOR_COMBO_REWRITES, matchCursorCombo, rewriteCursorCombos } from "../src/commands/launch";


// The boxed prompt's line editor delegates ALL cursor/line state to Bun's readline. On a real
// TTY, Bun's readline performs full line editing (char/word movement via Ctrl+arrow, Home/End,
// Emacs control bytes) — but it does NOT act on the modifier-flagged cursor keys macOS users
// reach for most: Option+Left/Right (word jump) and Cmd+Left/Right (line start/end) are inert.
// The input filter rewrites each inert combo to the canonical control byte readline DOES act
// on, BEFORE readline sees it, so readline stays the single owner of the cursor and the box
// just repaints. These tests lock the rewrite table deterministically. The end-to-end edit
// (combo → readline cursor move) is verified on a real PTY, not here: Bun's readline does NOT
// perform editing when driven through a PassThrough (bun:test cannot supply a real TTY fd),
// so a live-readline assertion would test Bun's PassThrough quirk, not this rewrite.

test("rewriteCursorCombos maps every combo sequence to its canonical control byte", () => {
  expect(rewriteCursorCombos("\u001b[1;3D")).toBe("\u001bb"); // Option+Left  → word left
  expect(rewriteCursorCombos("\u001b[1;3C")).toBe("\u001bf"); // Option+Right → word right
  expect(rewriteCursorCombos("\u001b\u001b[D")).toBe("\u001bb"); // ESC-prefixed Option+Left
  expect(rewriteCursorCombos("\u001b\u001b[C")).toBe("\u001bf"); // ESC-prefixed Option+Right
  expect(rewriteCursorCombos("\u001b[1;9D")).toBe("\u0001"); // Cmd+Left  → line start
  expect(rewriteCursorCombos("\u001b[1;9C")).toBe("\u0005"); // Cmd+Right → line end
  expect(rewriteCursorCombos("\u001b[127;3u")).toBe("\u0017"); // Option+Backspace → del word left
  expect(rewriteCursorCombos("\u001b[127;9u")).toBe("\u0015"); // Cmd+Backspace → del to line start
  expect(rewriteCursorCombos("\u001b[3;3~")).toBe("\u001bd"); // Option+Delete → del word right
});

test("rewriteCursorCombos leaves plain text and already-canonical keys untouched", () => {
  expect(rewriteCursorCombos("hello world")).toBe("hello world");
  expect(rewriteCursorCombos("\u001b[D")).toBe("\u001b[D"); // bare Left — readline moves 1 char
  expect(rewriteCursorCombos("\u001b[1;5D")).toBe("\u001b[1;5D"); // Ctrl+Left already works
  expect(rewriteCursorCombos("\u001b[H")).toBe("\u001b[H"); // Home already works
});

test("rewriteCursorCombos rewrites a combo embedded in surrounding typed text", () => {
  // type "abc", Option+Left, type "X": the X lands at the word boundary readline computes.
  expect(rewriteCursorCombos("abc\u001b[1;3DX")).toBe("abc\u001bbX");
});

test("matchCursorCombo returns the pair only at a sequence start", () => {
  expect(matchCursorCombo("x\u001b[1;3D", 0)).toBeUndefined();
  expect(matchCursorCombo("x\u001b[1;3D", 1)).toEqual(["\u001b[1;3D", "\u001bb"]);
});

test("CURSOR_COMBO_REWRITES has no source sequence that is a prefix of another", () => {
  // First-match scanning is only unambiguous when no source prefixes another source.
  const sources = CURSOR_COMBO_REWRITES.map(p => p[0]);
  for (const a of sources) {
    for (const b of sources) {
      if (a !== b) expect(b.startsWith(a)).toBe(false);
    }
  }
});
