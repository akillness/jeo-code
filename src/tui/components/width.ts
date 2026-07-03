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
  if (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritical marks
    (cp >= 0x200b && cp <= 0x200f) || // zero-width space..RLM
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0x1ab0 && cp <= 0x1aff) || // combining diacritical marks extended
    (cp >= 0x1dc0 && cp <= 0x1dff) || // combining diacritical marks supplement
    (cp >= 0x20d0 && cp <= 0x20ff) || // combining marks for symbols
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
    const cp = s.codePointAt(i)!;
    w += charWidth(cp);
    i += cp > 0xffff ? 2 : 1;
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
      const cp = s.codePointAt(i)!;
      cw = charWidth(cp);
      chunk = cp > 0xffff ? s.slice(i, i + 2) : s[i]!;
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
