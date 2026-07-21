import { test, expect } from "bun:test";
import { charWidth, visibleWidth, truncateToWidth, wrapTextWithAnsi, sanitizeForFrame, lastValueCache, nextGraphemeCluster } from "../src/tui/components/width";

test("charWidth: wide / narrow / zero-width classes", () => {
  expect(charWidth("a".codePointAt(0)!)).toBe(1);
  expect(charWidth("한".codePointAt(0)!)).toBe(2);   // Hangul syllable
  expect(charWidth("中".codePointAt(0)!)).toBe(2);   // CJK ideograph
  expect(charWidth("あ".codePointAt(0)!)).toBe(2);   // Hiragana
  expect(charWidth("🚀".codePointAt(0)!)).toBe(2);  // emoji (astral)
  expect(charWidth(0x0301)).toBe(0);                  // combining acute
  expect(charWidth(0xfe0f)).toBe(0);                  // variation selector
});
test("nextGraphemeCluster: absorbs VS16/VS15, Fitzpatrick modifiers, keycaps, and ZWJ chains into ONE atomic cluster (gjc parity)", () => {
  // ❤️ = U+2764 (narrow=1 on its own) + VS16 → emoji presentation, width 2 (NOT 1+0=1).
  const heart = "\u2764\ufe0f";
  expect(nextGraphemeCluster(heart, 0)).toEqual({ length: heart.length, width: 2 });
  expect(visibleWidth(heart)).toBe(2);

  // VS15 forces TEXT presentation — narrow, width 1.
  const heartText = "\u2764\ufe0e";
  expect(nextGraphemeCluster(heartText, 0)).toEqual({ length: heartText.length, width: 1 });

  // 👍🏽 = thumbs-up (already wide=2) + Fitzpatrick Type-4 modifier → ONE 2-wide glyph
  // (NOT 2+2=4, which is what naive per-code-point summing produced before this fix).
  const thumbsUp = "\u{1f44d}\u{1f3fd}";
  expect(nextGraphemeCluster(thumbsUp, 0)).toEqual({ length: [...thumbsUp].join("").length, width: 2 });
  expect(visibleWidth(thumbsUp)).toBe(2);

  // Keycap sequence: digit + VS16 + combining enclosing keycap → ONE 2-wide glyph.
  const keycap1 = "1\ufe0f\u20e3";
  expect(nextGraphemeCluster(keycap1, 0)).toEqual({ length: keycap1.length, width: 2 });
  expect(visibleWidth(keycap1)).toBe(2);

  // 4-person ZWJ family emoji: naive summing would count 4 wide code points = 8 cols;
  // a terminal renders the WHOLE joined sequence as ONE 2-wide glyph.
  const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}";
  expect(nextGraphemeCluster(family, 0)).toEqual({ length: family.length, width: 2 });
  expect(visibleWidth(family)).toBe(2);
  expect(visibleWidth(`${family}!`)).toBe(3); // trailing plain char still counts normally

  // A plain (non-modified) astral emoji is unaffected — still counts 2, consumes its
  // own surrogate pair only (no over-absorption of unrelated following text).
  const rocket = "\u{1f680}x";
  expect(nextGraphemeCluster(rocket, 0)).toEqual({ length: 2, width: 2 });
});

// Architect-review follow-up (independent read-only audit after v0.8.29-v0.8.37):
// non-Latin combining marks were NOT in the zero-width tables (Hebrew/Arabic/
// Devanagari/Thai all over-counted), wrapTextWithAnsi could hang forever at a
// narrow width with a leading wide cluster, and paired regional-indicator flag
// emoji weren't atomic. All three reproduced live before fixing.
test("charWidth/nextGraphemeCluster: non-Latin combining marks are zero-width (Hebrew, Arabic, Devanagari, Thai)", () => {
  // Arabic: ب (base) + ّ (shadda, U+0651) + َ (fatha, U+064E) — naive summing
  // counted 3 (each combining mark as width 1); real terminals render 1 column.
  expect(visibleWidth("\u0628\u0651\u064E")).toBe(1);
  // Hebrew: א (base) + ָ (qamats, U+05B8).
  expect(visibleWidth("\u05D0\u05B8")).toBe(1);
  // Thai: ก (base) + ิ (sara i, U+0E34).
  expect(visibleWidth("\u0E01\u0E34")).toBe(1);
  // Devanagari: क (Ka) + ् (virama, U+094D) + ष (Ssa) — matches the unicode-width
  // crate's own documented example ("क्ष".width() == 2), verified against its README.
  expect(visibleWidth("\u0915\u094D\u0937")).toBe(2);
  // Standalone combining marks (verified against jquast/wcwidth's zero-width table).
  expect(charWidth(0x064e)).toBe(0); // Arabic fatha
  expect(charWidth(0x05b8)).toBe(0); // Hebrew qamats
  expect(charWidth(0x094d)).toBe(0); // Devanagari virama
  expect(charWidth(0x0e34)).toBe(0); // Thai sara i
});

test("nextGraphemeCluster: a pair of adjacent Regional Indicators is ONE atomic flag-emoji cluster", () => {
  const flagKR = "\u{1F1F0}\u{1F1F7}"; // REGIONAL INDICATOR K + R
  expect(nextGraphemeCluster(flagKR, 0)).toEqual({ length: flagKR.length, width: 2 });
  expect(visibleWidth(flagKR)).toBe(2);
  // Atomicity: truncateToWidth must never split a flag mid-sequence (a lone
  // regional-indicator letter square instead of a flag).
  expect(truncateToWidth(flagKR, 1)).toBe("");
  expect(truncateToWidth(flagKR, 2)).toBe(flagKR);
  expect(truncateToWidth(`${flagKR}x`, 3)).toBe(`${flagKR}x`);
  // A LONE, unpaired regional indicator (no second RI following) is NOT force-paired.
  const lone = "\u{1F1F0}x";
  expect(nextGraphemeCluster(lone, 0)).toEqual({ length: 2, width: 1 });
});

test("wrapTextWithAnsi: never hangs at cols<=1 with a leading wide cluster (reproduced live via a 5s timeout kill before this fix)", () => {
  // Each Korean syllable is width 2 — none can fit in a 1-column budget, so the
  // OLD code made zero forward progress and looped forever. Now each wide
  // cluster is forced onto its own (deliberately overflowing) line instead.
  const lines = wrapTextWithAnsi("\uD55C\uAE00\uD14C\uC2A4\uD2B8", 1); // 한글테스트
  expect(lines).toEqual(["한", "글", "테", "스", "트"]);
  // Mixed content: a wide cluster forces its own line; subsequent narrow content
  // still wraps normally against the requested width once it fits.
  const mixed = wrapTextWithAnsi("a한b", 1);
  expect(mixed).toEqual(["a", "한", "b"]);
  // A single already-too-wide emoji at cols=1 terminates too (not just CJK).
  expect(wrapTextWithAnsi("\u{1F680}", 1)).toEqual(["\u{1F680}"]);
});

test("truncateToWidth: never splits a VS16/ZWJ/modifier cluster at the boundary", () => {
  const heart = "\u2764\ufe0f"; // width 2
  // A 1-col budget can't fit the 2-col cluster — dropped whole, not half (no VS16 leaking
  // out with a lone, unrendered heart glyph left dangling).
  expect(truncateToWidth(heart, 1)).toBe("");
  expect(truncateToWidth(heart, 2)).toBe(heart);
  const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}"; // width 2, one atomic ZWJ chain
  expect(truncateToWidth(family, 1)).toBe("");
  expect(truncateToWidth(family, 2)).toBe(family);
  expect(truncateToWidth(`${family}ab`, 3)).toBe(`${family}a`);
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

test("lastValueCache: recomputes only when the key changes (live-frame wrap memo)", () => {
  const cache = lastValueCache<string[]>();
  let calls = 0;
  const compute = () => { calls++; return ["wrapped"]; };

  const a = cache("k1", compute);
  const b = cache("k1", compute); // same key -> cache hit, no recompute
  expect(calls).toBe(1);
  expect(b).toBe(a); // identical reference reused (no re-wrap allocation)

  cache("k2", compute); // key changed -> recompute once
  expect(calls).toBe(2);

  cache("k1", compute); // single-slot: returning to an old key misses again
  expect(calls).toBe(3);
});
