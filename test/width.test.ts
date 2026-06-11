import { test, expect } from "bun:test";
import { charWidth, visibleWidth, truncateToWidth, wrapTextWithAnsi } from "../src/tui/components/width";

test("charWidth: wide / narrow / zero-width classes", () => {
  expect(charWidth("a".codePointAt(0)!)).toBe(1);
  expect(charWidth("한".codePointAt(0)!)).toBe(2);   // Hangul syllable
  expect(charWidth("中".codePointAt(0)!)).toBe(2);   // CJK ideograph
  expect(charWidth("あ".codePointAt(0)!)).toBe(2);   // Hiragana
  expect(charWidth("🚀".codePointAt(0)!)).toBe(2);  // emoji (astral)
  expect(charWidth(0x0301)).toBe(0);                  // combining acute
  expect(charWidth(0xfe0f)).toBe(0);                  // variation selector
});

test("visibleWidth: CJK counts 2, ANSI counts 0, tabs advance to 8-stop", () => {
  expect(visibleWidth("abc")).toBe(3);
  expect(visibleWidth("한글")).toBe(4);
  expect(visibleWidth("a한b")).toBe(4);
  expect(visibleWidth("\x1b[31mred\x1b[0m")).toBe(3); // escapes free
  expect(visibleWidth("\t")).toBe(8);
  expect(visibleWidth("ab\t")).toBe(8); // 2 + 6 to next stop
  expect(visibleWidth("🚀x")).toBe(3);
});

test("truncateToWidth: wide glyph straddling the boundary is dropped whole", () => {
  // "한글" is 4 cols; truncate to 3 must drop the 2nd wide char entirely (not half).
  expect(truncateToWidth("한글", 3)).toBe("한");
  expect(truncateToWidth("한글", 4)).toBe("한글");
  expect(truncateToWidth("한글", 2)).toBe("한");
  expect(truncateToWidth("한글", 1)).toBe(""); // can't fit a 2-col char in 1
  expect(truncateToWidth("abcd", 2)).toBe("ab"); // ASCII fast path
});

test("truncateToWidth: SGR preserved and reset appended on mid-color cut", () => {
  const out = truncateToWidth("\x1b[31mhello\x1b[0m world", 3);
  expect(out).toContain("\x1b[31m");
  expect(out).toContain("hel");
  expect(out.endsWith("\x1b[0m")).toBe(true);
  expect(out).not.toContain("world");
});

test("wrapTextWithAnsi: hard-wraps by display width, keeps newlines", () => {
  expect(wrapTextWithAnsi("abcdef", 3)).toEqual(["abc", "def"]);
  expect(wrapTextWithAnsi("a\nbcdef", 3)).toEqual(["a", "bcd", "ef"]);
  // CJK: each char is 2 cols, so width-4 wrap fits 2 per line.
  expect(wrapTextWithAnsi("한글한글", 4)).toEqual(["한글", "한글"]);
});
