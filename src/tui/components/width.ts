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
 * marks, and ZWJ-joined sequences into ONE atomic unit. This preserves Unicode
 * grapheme semantics for Korean tone marks, VS16 emoji presentation, ZWJ,
 * keycaps, and emoji modifiers.
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
function stripLoneSurrogatesFrame(s: string): string {
  let out = "";
  let last = 0;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) {
      if (code <= 0xdbff && i + 1 < n) {
        const next = s.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          i++;
          continue;
        }
      }
      if (i > last) out += s.slice(last, i);
      last = i + 1;
    }
  }
  if (last === 0) return s;
  if (last < n) out += s.slice(last);
  return out;
}

export function sanitizeForFrame(s: string): string {
  const len = s.length;
  let dirty = false;
  for (let i = 0; i < len; i++) {
    const code = s.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)) {
      dirty = true;
      break;
    }
    if (code >= 0xd800 && code <= 0xdfff) {
      if (code <= 0xdbff && i + 1 < len) {
        const next = s.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          i++;
          continue;
        }
      }
      dirty = true;
      break;
    }
  }
  if (!dirty) return s; // fast path
  const clean = s.isWellFormed() ? s : stripLoneSurrogatesFrame(s);
  let out = "";
  let last = 0;
  let i = 0;
  const n = clean.length;
  while (i < n) {
    const code = clean.charCodeAt(i);
    if (code === 0x1b) {
      if (i > last) out += clean.slice(last, i);
      const next = clean.charCodeAt(i + 1);
      if (next === 0x5b) {
        // CSI: ESC [ params/intermediate (0x20-0x3f) final (0x40-0x7e)
        // Only standard SGR parameters ([0-9:;], 0x30-0x3b) ending in 'm' are kept;
        // private/DEC prefixes (>/?/<=/intermediates) are stripped.
        let j = i + 2;
        let sgrParamsOnly = true;
        while (j < n) {
          const c = clean.charCodeAt(j);
          if (c < 0x20 || c > 0x3f) break;
          if (c < 0x30 || c > 0x3b) sgrParamsOnly = false;
          j++;
        }
        if (j < n) {
          const final = clean.charCodeAt(j);
          if (final >= 0x40 && final <= 0x7e) {
            if (final === 0x6d && sgrParamsOnly) out += clean.slice(i, j + 1);
            i = j + 1;
            last = i;
            continue;
          }
        }
        last = n;
        break; // incomplete CSI at the chunk tail → drop the rest
      }
      if (next === 0x5d) {
        // OSC: ESC ] … (BEL | ST = ESC \ | 0x9c)
        let j = i + 2;
        while (j < n) {
          const c = clean.charCodeAt(j);
          if (c === 0x07 || c === 0x9c || (c === 0x1b && clean.charCodeAt(j + 1) === 0x5c)) break;
          j++;
        }
        if (j >= n) {
          last = n;
          break; // incomplete OSC → drop
        }
        i = clean.charCodeAt(j) === 0x1b ? j + 2 : j + 1;
        last = i;
        continue;
      }
      i += i + 1 < n && next >= 0x20 && next <= 0x7e ? 2 : 1; // other ESC x → drop ESC (+ ASCII byte only)
      last = i;
      continue;
    }
    if (code === 0x9b) {
      // 8-bit C1 CSI: strip sequence + payload
      if (i > last) out += clean.slice(last, i);
      let j = i + 1;
      while (j < n) {
        const c = clean.charCodeAt(j);
        if (c < 0x20 || c > 0x3f) break;
        j++;
      }
      if (j < n) {
        const final = clean.charCodeAt(j);
        if (final >= 0x40 && final <= 0x7e) {
          i = j + 1;
          last = i;
          continue;
        }
      }
      last = n;
      break; // incomplete C1 CSI at tail → drop
    }
    if (code === 0x9d) {
      // 8-bit C1 OSC: strip sequence + payload
      if (i > last) out += clean.slice(last, i);
      let j = i + 1;
      while (j < n) {
        const c = clean.charCodeAt(j);
        if (c === 0x07 || c === 0x9c || (c === 0x1b && clean.charCodeAt(j + 1) === 0x5c)) break;
        j++;
      }
      if (j >= n) {
        last = n;
        break;
      }
      i = clean.charCodeAt(j) === 0x1b ? j + 2 : j + 1;
      last = i;
      continue;
    }
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)) {
      if (i > last) out += clean.slice(last, i);
      i++; // strip bare C0/DEL/C1 control bytes, keep tab + newline
      last = i;
      continue;
    }
    i++;
  }
  if (last < n) out += clean.slice(last);
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
 * Find the last word boundary (space outside ANSI SGR escapes) inside `line`
 * that fits strictly within `limit` display columns (`> 0`). Returns the string
 * index of the whitespace char and the exact consumed prefix up to it, or null
 * when no breakable word boundary fits.
 */
function findWordWrapBreak(line: string, limit: number): { head: string; skipSpaceLen: number } | null {
  let w = 0;
  let i = 0;
  let sawNonSpace = false;
  let lastSpaceIdx = -1;
  let lastSpaceWidth = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      SGR.lastIndex = i;
      const m = SGR.exec(line);
      if (m) {
        i += m[0].length;
        continue;
      }
    }
    let cw: number;
    let len: number;
    if (line[i] === "\t") {
      cw = TAB_STOP - (w % TAB_STOP);
      len = 1;
    } else {
      const cluster = nextGraphemeCluster(line, i);
      cw = cluster.width;
      len = cluster.length;
    }
    if (w + cw > limit) break;
    if (line[i] === " ") {
      if (sawNonSpace) {
        lastSpaceIdx = i;
        lastSpaceWidth = w;
      }
    } else if (cw > 0) {
      sawNonSpace = true;
    }
    w += cw;
    i += len;
  }
  if (lastSpaceIdx <= 0 || lastSpaceWidth <= 0) return null;
  let skipSpaceLen = 0;
  while (lastSpaceIdx + skipSpaceLen < line.length && line[lastSpaceIdx + skipSpaceLen] === " ") {
    skipSpaceLen++;
  }
  return { head: line.slice(0, lastSpaceIdx), skipSpaceLen };
}

/**
 * Word-aware ANSI-preserving wrap to `cols` display columns. Prefers breaking
 * at ASCII spaces when the remainder overflows `cols`, preserves active SGR
 * colors across wrapped lines, and falls back to `wrapTextWithAnsi` only for
 * indivisible space-free tokens (long URLs, paths, CJK runs without spaces).
 */
export function wrapTextWordAware(
  text: string,
  cols: number,
  opts: { continuationIndent?: string } = {},
): string[] {
  const width = Math.max(1, cols);
  const RESET = "\x1b[0m";
  const contIndent = opts.continuationIndent ?? "";
  const contIndentWidth = visibleWidth(contIndent);
  const effectiveContIndent = contIndentWidth < width ? contIndent : "";
  const effectiveContWidth = contIndentWidth < width ? contIndentWidth : 0;
  const out: string[] = [];

  for (const rawLine of text.split("\n")) {
    if (visibleWidth(rawLine) <= width) {
      out.push(rawLine);
      continue;
    }
    let rest = rawLine;
    let active = "";
    let firstChunk = true;
    while (rest.length > 0) {
      const prefix = firstChunk ? "" : effectiveContIndent;
      const avail = Math.max(1, width - (firstChunk ? 0 : effectiveContWidth));
      if (visibleWidth(rest) <= avail) {
        let line = prefix + active + rest;
        if (active && !line.endsWith(RESET)) line += RESET;
        out.push(line);
        break;
      }
      const wordBreak = findWordWrapBreak(rest, avail);
      if (wordBreak) {
        let line = prefix + active + wordBreak.head;
        const nextActive = sgrStateAfter(active, wordBreak.head);
        if ((active || nextActive) && !line.endsWith(RESET)) line += RESET;
        out.push(line);
        const tailStart = wordBreak.head.length + wordBreak.skipSpaceLen;
        active = sgrStateAfter(nextActive, rest.slice(wordBreak.head.length, tailStart));
        rest = rest.slice(tailStart);
        firstChunk = false;
        if (rest.length === 0) break;
        continue;
      }
      // Single token wider than `avail` — wrap one `avail` slice via grapheme-safe
      // truncation and keep iterating so subsequent words wrap word-aware again.
      const sliceHead = truncateToWidth(rest, avail);
      const consumed = rest.startsWith(sliceHead)
        ? sliceHead
        : sliceHead.endsWith(RESET) && rest.startsWith(sliceHead.slice(0, -RESET.length))
          ? sliceHead.slice(0, -RESET.length)
          : sliceHead;
      if (consumed.length === 0) {
        const forced = nextGraphemeCluster(rest, 0);
        const forcedText = rest.slice(0, forced.length);
        let forcedLine = prefix + active + forcedText;
        const nextActive = sgrStateAfter(active, forcedText);
        if ((active || nextActive) && !forcedLine.endsWith(RESET)) forcedLine += RESET;
        out.push(forcedLine);
        active = nextActive;
        rest = rest.slice(forced.length);
        firstChunk = false;
        continue;
      }
      let line = prefix + active + (consumed.length === sliceHead.length ? sliceHead : consumed);
      const nextActive = sgrStateAfter(active, consumed);
      if ((active || nextActive) && !line.endsWith(RESET)) line += RESET;
      out.push(line);
      active = nextActive;
      rest = rest.slice(consumed.length).replace(/^ +/, "");
      firstChunk = false;
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
