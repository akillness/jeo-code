import { test, expect } from "bun:test";
import { charWidth, visibleWidth, truncateToWidth, wrapTextWithAnsi, sanitizeForFrame } from "../src/tui/components/width";

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

test("wrapTextWithAnsi: carries the active color across wrap boundaries (no tint loss / no bleed)", () => {
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  // Red span wider than the wrap width: EVERY continuation row must re-open red and
  // close it, not just the first row (the reported "color breaks when the line wraps").
  const lines = wrapTextWithAnsi("\x1b[31mabcdefgh\x1b[0m", 3);
  expect(lines.map(strip)).toEqual(["abc", "def", "gh"]);
  for (const l of lines) {
    expect(l).toContain("\x1b[31m");        // red re-applied on every row
    expect(l.endsWith("\x1b[0m")).toBe(true); // and closed so it can't tint padding/border
    expect(visibleWidth(l)).toBeLessThanOrEqual(3);
  }
  // Plain (uncolored) text is untouched — no stray escapes introduced.
  expect(wrapTextWithAnsi("abcdef", 3)).toEqual(["abc", "def"]);
});

test("sanitizeForFrame: keeps SGR color, strips control bytes and non-SGR escapes", () => {
  // SGR color is preserved.
  expect(sanitizeForFrame("\x1b[31mred\x1b[0m")).toBe("\x1b[31mred\x1b[0m");
  // EL (\x1b[2K) and CR are stripped (the torn-escape / cursor-reset source).
  expect(sanitizeForFrame("\r\x1b[2K50%")).toBe("50%");
  // Cursor moves are stripped.
  expect(sanitizeForFrame("a\x1b[3Ab\x1b[2Bc")).toBe("abc");
  // OSC (title) is stripped, terminated by BEL.
  expect(sanitizeForFrame("\x1b]0;title\x07keep")).toBe("keep");
  // Plain text + newline/tab untouched.
  expect(sanitizeForFrame("a\tb\nc")).toBe("a\tb\nc");
  // Fast path: nothing to strip returns the input.
  expect(sanitizeForFrame("plain text")).toBe("plain text");
});

test("sanitizeForFrame: an INCOMPLETE trailing escape is dropped (cannot eat the next \\x1b[2K)", () => {
  // A chunk that ends mid-CSI: the dangling escape must be dropped entirely so it
  // never swallows the renderer's following \x1b[2K (which printed literal "2K").
  expect(sanitizeForFrame("done\x1b[3")).toBe("done");
  expect(sanitizeForFrame("x\x1b[")).toBe("x");
  expect(sanitizeForFrame("y\x1b")).toBe("y");
  // Incomplete OSC tail dropped too.
  expect(sanitizeForFrame("z\x1b]0;partial")).toBe("z");
});
