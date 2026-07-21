/**
 * ANSI + Unicode display-width helpers (consensus-seed P2.B9).
 *
 * Terminals render some code points two columns wide (CJK ideographs, Hangul,
 * fullwidth forms, most emoji) and some zero (combining marks, ZWJ, variation
 * selectors). Counting `string.length` — as the old ad-hoc `truncate` did —
 * overflows or under-fills any line containing them. These helpers count by
 * DISPLAY width, treat tabs as advancing to the next 8-col stop, and copy SGR
 * color escapes verbatim (never counting them) so colored/CJK lines truncate and
 * wrap without tearing an escape or miscounting a wide glyph.
 */
import { isImageEscapeLine } from "../terminal-image";

const TAB_STOP = 8;
// Sticky SGR matcher: scan a heavily color-escaped line in O(n) without slicing.
const SGR = /\x1b\[[0-9;]*m/y;

/**
 * Display columns for a single code point. 0 for combining/zero-width, 2 for
 * East-Asian Wide/Fullwidth and emoji, 1 otherwise. Ranges follow the common
 * wcwidth/East_Asian_Width tables (not exhaustive, but covers the cases a coding
 * TUI actually shows: Hangul, CJK, kana, fullwidth ASCII, emoji blocks).
 */
export function charWidth(cp: number): number {
  if (cp === 0) return 0;
  // C0/C1 control characters have no width here (callers strip/By handle them).
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // Zero-width: combining marks, ZWSP/ZWNJ/ZWJ, variation selectors, BOM.
  // Non-Latin combining-mark ranges (Hebrew points/cantillation, Arabic vowel signs,
  // Devanagari matras/virama, Thai vowels/tone marks) verified against the current
  // jquast/wcwidth zero-width table (github.com/termux/wcwidth, table_zero.py,
  // Unicode-aligned as of 2022-12-16) — a real, reproduced gap: e.g. Arabic "بّّ"َ
  // (base + shadda + fatha) previously counted visibleWidth 3 instead of 1.
  if (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritical marks
    (cp >= 0x200b && cp <= 0x200f) || // zero-width space..RLM
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0x1ab0 && cp <= 0x1aff) || // combining diacritical marks extended
    (cp >= 0x1dc0 && cp <= 0x1dff) || // combining diacritical marks supplement
    (cp >= 0x20d0 && cp <= 0x20ff) || // combining marks for symbols
    (cp >= 0x0591 && cp <= 0x05bd) || // Hebrew accents/points (Etnahta..Meteg)
    cp === 0x05bf || (cp >= 0x05c1 && cp <= 0x05c2) || (cp >= 0x05c4 && cp <= 0x05c5) || cp === 0x05c7 || // Hebrew points (Rafe, Shin/Sin Dot, upper/lower dot, Qamats Qatan)
    (cp >= 0x0610 && cp <= 0x061a) || // Arabic honorific/small signs
    (cp >= 0x064b && cp <= 0x065f) || cp === 0x0670 || // Arabic vowel signs/tanwin, superscript alef
    (cp >= 0x06d6 && cp <= 0x06dc) || (cp >= 0x06df && cp <= 0x06e4) || (cp >= 0x06e7 && cp <= 0x06e8) || (cp >= 0x06ea && cp <= 0x06ed) || // Arabic Quranic annotation signs
    (cp >= 0x0900 && cp <= 0x0902) || cp === 0x093a || cp === 0x093c || // Devanagari candrabindu/anusvara/vowel-sign-oe/nukta
    (cp >= 0x0941 && cp <= 0x0948) || cp === 0x094d || (cp >= 0x0951 && cp <= 0x0957) || (cp >= 0x0962 && cp <= 0x0963) || // Devanagari vowel signs/virama/stress/vocalic
    cp === 0x0e31 || (cp >= 0x0e34 && cp <= 0x0e3a) || (cp >= 0x0e47 && cp <= 0x0e4e) || // Thai vowels/tone marks
    cp === 0xfeff
  ) {
    return 0;
  }
  // Wide (2 columns).
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals .. Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, Katakana, CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji & pictographs (incl. supplemental/symbols-extended)
    (cp >= 0x1f000 && cp <= 0x1f0ff) || // mahjong/dominoes/playing cards
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+ (supplementary ideographic planes)
  ) {
    return 2;
  }
  return 1;
}
const ZWJ = 0x200d;
const VS15 = 0xfe0e; // variation selector: force TEXT (narrow) presentation
const VS16 = 0xfe0f; // variation selector: force EMOJI (wide) presentation
const FITZPATRICK_MIN = 0x1f3fb; // Emoji Modifier Fitzpatrick Type-1-2 .. Type-6
const FITZPATRICK_MAX = 0x1f3ff;
const KEYCAP_COMBINING = 0x20e3; // combining enclosing keycap (1️⃣, #️⃣, *️⃣)
const RI_MIN = 0x1f1e6; // Regional Indicator Symbol Letter A
const RI_MAX = 0x1f1ff; // Regional Indicator Symbol Letter Z

function isRegionalIndicator(cp: number): boolean {
  return cp >= RI_MIN && cp <= RI_MAX;
}

function isFitzpatrick(cp: number): boolean {
  return cp >= FITZPATRICK_MIN && cp <= FITZPATRICK_MAX;
}

/** True for combining/zero-width marks that attach to a preceding base rather than
 *  starting a new cluster on their own (diacritics etc.) — the zero-width branch of
 *  `charWidth` MINUS variation selectors (VS15/VS16 are handled explicitly above,
 *  since they change the CLUSTER's width rather than merely contributing 0 to it). */
function isAttachableCombining(cp: number): boolean {
  return (cp >= 0x0300 && cp <= 0x036f)
    || (cp >= 0x1ab0 && cp <= 0x1aff)
    || (cp >= 0x1dc0 && cp <= 0x1dff)
    || (cp >= 0x20d0 && cp <= 0x20ff)
    || (cp >= 0x0591 && cp <= 0x05bd) || cp === 0x05bf || (cp >= 0x05c1 && cp <= 0x05c2) || (cp >= 0x05c4 && cp <= 0x05c5) || cp === 0x05c7 // Hebrew
    || (cp >= 0x0610 && cp <= 0x061a) || (cp >= 0x064b && cp <= 0x065f) || cp === 0x0670 || (cp >= 0x06d6 && cp <= 0x06dc) || (cp >= 0x06df && cp <= 0x06e4) || (cp >= 0x06e7 && cp <= 0x06e8) || (cp >= 0x06ea && cp <= 0x06ed) // Arabic
    || (cp >= 0x0900 && cp <= 0x0902) || cp === 0x093a || cp === 0x093c || (cp >= 0x0941 && cp <= 0x0948) || cp === 0x094d || (cp >= 0x0951 && cp <= 0x0957) || (cp >= 0x0962 && cp <= 0x0963) // Devanagari
    || cp === 0x0e31 || (cp >= 0x0e34 && cp <= 0x0e3a) || (cp >= 0x0e47 && cp <= 0x0e4e) // Thai
    || cp === 0xfeff;
}

function codePointAndLength(s: string, i: number): { cp: number; length: number } {
  const cp = s.codePointAt(i)!;
  return { cp, length: cp > 0xffff ? 2 : 1 };
}

/**
 * Resolve the visual CLUSTER starting at `s[i]` (not an SGR escape or tab — callers
 * handle those separately) into its total consumed UTF-16 length and DISPLAY width,
 * absorbing variation selectors, skin-tone modifiers, keycap combiners, combining
 * marks, and ZWJ-joined sequences into ONE atomic unit (gjc parity: "preserve …
 * Unicode grapheme semantics for … Korean tone marks, VS16 emoji presentation, ZWJ,
 * keycaps, and emoji modifiers").
 *
 * Per-code-point summing (the old behavior) over- or under-counts every one of these:
 * 👍🏽 (thumbs-up + Fitzpatrick modifier) summed to 4 columns where a terminal renders
 * ONE 2-wide glyph; ❤️ (heart + VS16) summed to 1 where a terminal renders 2; a 4-person
 * ZWJ family emoji summed to 8 where a terminal renders 2. Every one of those is a real,
 * visible box-border/wrap misalignment ("깨짐") the instant such a sequence appears in a
 * message — this collapses each sequence to the width a terminal ACTUALLY renders it at,
 * atomically, so `truncateToWidth`/`wrapTextWithAnsi` also never split one in half at a
 * boundary (this is a pragmatic subset of UAX #29 grapheme-cluster breaking scoped to
 * the sequences a chat/coding TUI actually sees — not a general script-shaping engine).
 */
export function nextGraphemeCluster(s: string, i: number): { length: number; width: number } {
  const base = codePointAndLength(s, i);
  let width = charWidth(base.cp);
  let len = base.length;
  let j = i + base.length;
  const peek = (): number => s.codePointAt(j) ?? -1;
  // A pair of adjacent Regional Indicators forms ONE flag-emoji cluster (UAX #29's
  // RI-pairing rule) — e.g. 🇰🇷 = REGIONAL INDICATOR K + REGIONAL INDICATOR R. Each
  // RI alone is already width 1 (no dedicated charWidth range; falls through to the
  // default), so an unpaired scan already SUMS to the right total (2) even without
  // this — but without pairing, a wrap/truncate boundary can land BETWEEN the two,
  // rendering a lone indicator-letter square instead of a flag. No further
  // modifiers (VS16/ZWJ/Fitzpatrick) are defined for a flag pair, so return early.
  if (isRegionalIndicator(base.cp) && isRegionalIndicator(peek())) {
    const second = codePointAndLength(s, j);
    return { length: len + second.length, width: 2 };
  }

  if (peek() === VS15) { width = 1; len += 1; j += 1; }
  else if (peek() === VS16) { width = 2; len += 1; j += 1; }

  while (isFitzpatrick(peek())) {
    const mod = codePointAndLength(s, j);
    len += mod.length;
    j += mod.length;
    width = 2;
  }

  if (peek() === KEYCAP_COMBINING) { len += 1; j += 1; width = 2; }

  while (isAttachableCombining(peek())) {
    const mark = codePointAndLength(s, j);
    len += mark.length;
    j += mark.length;
  }

  if (peek() === ZWJ && j + 1 < s.length) {
    const joined = nextGraphemeCluster(s, j + 1);
    len += 1 + joined.length;
    width = 2;
  }

  return { length: len, width };
}

/**
 * Visible display width of a string: SGR escapes count 0, tabs advance to the
 * next 8-col stop, wide glyphs count 2. Iterates by code point (surrogate-safe).
 */
export function visibleWidth(s: string): number {
  if (!s) return 0;
  let w = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      SGR.lastIndex = i;
      const m = SGR.exec(s);
      if (m) {
        i += m[0].length;
        continue;
      }
    }
    if (s[i] === "\t") {
      w += TAB_STOP - (w % TAB_STOP);
      i += 1;
      continue;
    }
    const cluster = nextGraphemeCluster(s, i);
    w += cluster.width;
    i += cluster.length;
  }
  return w;
}

/**
 * Truncate a string to at most `cols` DISPLAY columns. SGR escapes are copied
 * verbatim (free); a wide glyph that would straddle the boundary is dropped
 * whole (never half-rendered). If a color was active at the cut, a reset is
 * appended so trailing frame content is not tinted.
 */
export function truncateToWidth(s: string, cols: number): string {
  const limit = Math.max(0, cols);
  if (limit === 0) return "";
  // An inline terminal-image escape (Kitty APC / iTerm2 OSC 1337, see
  // `../terminal-image.ts#isImageEscapeLine`) is not text: its "width" by a naive
  // column count is the base64 payload length (thousands of columns), and slicing
  // into the payload corrupts the image or leaves an unterminated escape that
  // hangs the terminal waiting for its `ESC \\`/BEL terminator. The image was
  // already fit to the caller's column budget when the sequence was BUILT, so the
  // correct "truncation" here is always a no-op.
  if (isImageEscapeLine(s)) return s;
  // Fast path: no escapes, no wide chars, no tabs → plain slice by length.
  if (!s.includes("\x1b") && !/[\t\u0300-\uffff]/.test(s) && !/[\u{10000}-\u{10ffff}]/u.test(s)) {
    return s.length <= limit ? s : s.slice(0, limit);
  }
  let out = "";
  let w = 0;
  let sawEscape = false;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      SGR.lastIndex = i;
      const m = SGR.exec(s);
      if (m) {
        out += m[0];
        sawEscape = true;
        i += m[0].length;
        continue;
      }
    }
    let cw: number;
    let chunk: string;
    if (s[i] === "\t") {
      cw = TAB_STOP - (w % TAB_STOP);
      chunk = "\t";
    } else {
      const cluster = nextGraphemeCluster(s, i);
      cw = cluster.width;
      chunk = s.slice(i, i + cluster.length);
    }
    if (w + cw > limit) break;
    out += chunk;
    w += cw;
    i += chunk.length;
  }
  if (i < s.length && sawEscape && !out.endsWith("\x1b[0m")) out += "\x1b[0m";
  return out;
}

/**
 * Strip control bytes that would corrupt the live differential frame. KEEPS SGR color
 * escapes (`\x1b[…m`); DROPS every other CSI (cursor moves, EL/ED erase, etc.), OSC
 * sequences, other escapes, and bare C0/C1 control bytes except tab/newline; and DROPS
 * an INCOMPLETE trailing escape (a chunk that ends mid-sequence) so it can never eat the
 * next line's `\x1b[2K`. Used to sanitize raw child stdout (e.g. a streaming `bun test`
 * with `\r\x1b[2K` progress lines) before it enters the frame — the torn-escape /
 * cursor-hijack class of screen corruption.
 */
export function sanitizeForFrame(s: string): string {
  if (!s.includes("\x1b") && !/[\x00-\x08\x0b-\x1f\x7f]/.test(s)) return s; // fast path
  let out = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i]!;
    if (ch === "\x1b") {
      if (s[i + 1] === "[") {
        // CSI: ESC [ params (0-9;:?<>= space) final (@-~)
        let j = i + 2;
        while (j < n && /[0-9;:?<>= ]/.test(s[j]!)) j++;
        if (j < n && /[@-~]/.test(s[j]!)) {
          const seq = s.slice(i, j + 1);
          if (seq.endsWith("m")) out += seq; // keep SGR color, drop all other CSI
          i = j + 1;
          continue;
        }
        break; // incomplete CSI at the chunk tail → drop the rest
      }
      if (s[i + 1] === "]") {
        // OSC: ESC ] … (BEL | ST = ESC \)
        let j = i + 2;
        while (j < n && s[j] !== "\x07" && !(s[j] === "\x1b" && s[j + 1] === "\\")) j++;
        if (j >= n) break; // incomplete OSC → drop
        i = s[j] === "\x07" ? j + 1 : j + 2;
        continue;
      }
      i += i + 1 < n ? 2 : 1; // other ESC x → drop ESC (+ its single byte)
      continue;
    }
    const code = ch.charCodeAt(0);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f) {
      i++; // strip bare control bytes (CR/BS/…), keep tab + newline
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Active SGR state after applying every SGR escape in `segment` to `prior`.
 *  Pragmatic model (matches wrap-ansi): a full reset (`\x1b[0m` / `\x1b[m`) clears
 *  the open set; any other SGR is appended. Good enough for the fg/bg/bold coloring
 *  a TUI box actually uses; it does not model selective resets (e.g. `\x1b[22m`). */
function sgrStateAfter(prior: string, segment: string): string {
  if (!segment.includes("\x1b")) return prior;
  let state = prior;
  const re = /\x1b\[[0-9;]*m/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment))) {
    state = m[0] === "\x1b[0m" || m[0] === "\x1b[m" ? "" : state + m[0];
  }
  return state;
}

/**
 * Hard-wrap text to `cols` display columns, breaking long words and preserving
 * existing newlines. SGR-aware (escapes don't consume width) AND SGR-stateful:
 * a color opened before a wrap point is RE-APPLIED at the start of each continuation
 * line and CLOSED at its end, so a wrapped colored span stays colored on every row
 * instead of losing its tint after the first line (and never bleeds into the padding
 * or box border). Returns the wrapped lines.
 */
export function wrapTextWithAnsi(text: string, cols: number): string[] {
  const width = Math.max(1, cols);
  const RESET = "\x1b[0m";
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (visibleWidth(rawLine) <= width) {
      out.push(rawLine);
      continue;
    }
    if (!rawLine.includes("\x1b") && !/[\t\u0300-\uffff]/.test(rawLine) && !/[\u{10000}-\u{10ffff}]/u.test(rawLine)) {
      for (let i = 0; i < rawLine.length; i += width) out.push(rawLine.slice(i, i + width));
      continue;
    }
    let rest = rawLine;
    let active = ""; // SGR open at the wrap boundary, carried to the next line
    while (true) {
      const head = truncateToWidth(rest, width);
      // Advance past exactly the consumed substring. truncateToWidth may append a
      // SYNTHETIC trailing reset (frame safety) that is NOT in `rest` — including it
      // would over-advance and drop real chars. `rest.startsWith(head)` means the
      // reset is genuinely part of the source; otherwise strip the synthetic one.
      const consumed = rest.startsWith(head)
        ? head
        : head.endsWith(RESET) && rest.startsWith(head.slice(0, -RESET.length))
          ? head.slice(0, -RESET.length)
          : head;
      if (consumed.length === 0) {
        // `truncateToWidth` couldn't fit even ONE whole cluster in `width` — a wide
        // grapheme cluster (CJK/emoji/ZWJ sequence) wider than the available column
        // budget, e.g. a 2-wide cluster at cols=1. Left alone, `rest` never shrinks
        // and this loop spins forever — a REAL, reproduced infinite loop (hangs the
        // whole TUI; confirmed live via a 5s timeout kill before this fix). Force
        // forward progress: emit that one cluster on its own, deliberately
        // over-width, line — an unavoidable overflow beats a hung process. `rest[0]`
        // is guaranteed to be real content here, never an escape sequence (those are
        // always consumed into `head` regardless of the width budget, so an empty
        // `head` can only mean the first REAL cluster itself didn't fit).
        const forced = nextGraphemeCluster(rest, 0);
        const forcedText = rest.slice(0, forced.length);
        let forcedLine = active + forcedText;
        const forcedActive = sgrStateAfter(active, forcedText);
        if (forcedActive && !forcedLine.endsWith(RESET)) forcedLine += RESET;
        out.push(forcedLine);
        active = forcedActive;
        rest = rest.slice(forced.length);
        if (rest.length === 0) break;
        continue;
      }
      if (consumed.length === rest.length) {
        let line = active + rest;
        if (active && !line.endsWith(RESET)) line += RESET;
        out.push(line);
        break;
      }
      let line = active + head;
      const next = sgrStateAfter(active, consumed);
      // Close any color still open at the line end so it cannot tint the padding/border.
      if (next && !line.endsWith(RESET)) line += RESET;
      out.push(line);
      active = next;
      rest = rest.slice(consumed.length);
    }
  }
  return out;
}

/**
 * Single-slot memo for the live-frame wrap. The TUI's 120ms spinner tick re-renders
 * the whole frame ~8×/s, but the reasoning / tool-output stream text only changes when
 * a new delta arrives — so re-wrapping (grapheme-segmenting the up-to-16KB tail through
 * `wrapTextWithAnsi`) on every idle tick is the hottest avoidable per-tick cost. This
 * caches the most recent `key → value`: an unchanged frame reuses the prior wrap instead
 * of recomputing it. One slot suffices — between two consecutive ticks the key (wrap
 * width + text) is identical on the common path; a real change recomputes once.
 */
export function lastValueCache<T>(): (key: string, compute: () => T) => T {
  let lastKey: string | undefined;
  let lastValue: T;
  return (key, compute) => {
    if (key !== lastKey) {
      lastKey = key;
      lastValue = compute();
    }
    return lastValue;
  };
}
