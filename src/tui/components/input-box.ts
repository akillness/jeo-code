import chalk from "chalk";
import { BOX_ASCII, BOX_UNICODE, boxBlock } from "./layout";
import { visibleWidth, truncateToWidth } from "./width";

export interface InputBoxOptions {
  cols?: number;
  color?: boolean;
  unicode?: boolean;
  cwdLabel?: string;
  /** Pending clipboard-image attachments hint (e.g. "⧉ 1 image attached — ctrl+v"). */
  attachmentLabel?: string;
  placeholder?: string;
  maxBodyRows?: number;
  /** Caret offset into `line` in UTF-16 CODE UNITS — exactly `rl.cursor`'s unit, so an
   *  emoji/astral character before the caret no longer shifts it. Defaults to end. */
  cursor?: number;
  /** Accent painter for the border + `>` prompt mark (theme accent); default red/blue. */
  accent?: (s: string) => string;
  /** Shadow painter for the bottom/right "shaded" edges; defaults to a dim accent.
   *  The lit-vs-shaded two-tone contrast gives the box visible depth. */
  accentShadow?: (s: string) => string;
  /** Paint contiguous CHARACTER ranges of the typed text (e.g. each active or
   *  committed `/command`/`$skill` trigger token) so the user sees every
   *  invocation recognized as it is typed — regardless of caret position or how
   *  many appear. Offsets index `Array.from(line)` code points ([start, end)).
   *  Accepts a single range or an array; ranges should not overlap. Ignored for
   *  the placeholder and when `color` is false. */
  highlight?: HighlightRange | readonly HighlightRange[];
}

/** A painted span of the input text: [start, end) code-point offsets + a painter. */
export interface HighlightRange {
  start: number;
  end: number;
  paint: (s: string) => string;
}

export interface InputFrame {
  lines: string[];
  /** Caret row relative to the box's FIRST line (0 = top border, 1 = first body row). */
  cursorRow: number;
  /** 1-based terminal column of the caret cell. */
  cursorCol: number;
}

/**
 * Wrap plain input text (readline lines carry no ANSI) by DISPLAY width and map the
 * caret's character offset to its (row, columnWidth) cell in the same pass — so the
 * box prompt can place the real terminal cursor exactly where the next glyph lands,
 * and arrow-key movement (readline updates rl.cursor) repositions it visibly.
 *
 * `cursor` is a UTF-16 CODE-UNIT offset — the same unit `rl.cursor` uses. Iteration is
 * per CODE POINT (so an astral char/emoji is one glyph of its own display width), and
 * the caret is matched against a parallel code-unit counter: without that, every
 * surrogate pair BEFORE the caret shifted the painted caret one column right of the
 * real insertion point (the "이모지가 있으면 입력 포인트가 밀려 보임" bug).
 * `highlights` ranges stay CODE-POINT indexed (see `triggerHighlight` in launch.ts).
 */
function wrapWithCursor(
  text: string,
  cursor: number,
  width: number,
  highlights?: readonly HighlightRange[],
): { rows: string[]; row: number; col: number } {
  const rows: string[] = [];
  let cur = "";
  let curW = 0;
  let row = 0;
  let col = 0;
  const src = text.replace(/\r/g, "");
  const chars = Array.from(src);
  const pos = Math.max(0, Math.min(cursor, src.length));
  let unit = 0; // UTF-16 offset of chars[i], matching `pos`
  let placed = false;
  for (let i = 0; i <= chars.length; i++) {
    const ch = i < chars.length ? chars[i]! : "";
    const rendered = ch === "\t" ? "  " : ch;
    const w = ch === "" || ch === "\n" ? 0 : ch === "\t" ? 2 : visibleWidth(ch);
    // Wrap BEFORE recording the caret so a caret on a wrapping char follows it down.
    if (w > 0 && curW + w > width && curW > 0) {
      rows.push(cur);
      cur = "";
      curW = 0;
    }
    // `>=` (not `===`) so a caret offset that lands INSIDE a surrogate pair — readline
    // never parks there, but a resized/derived offset can — still resolves to a cell.
    if (!placed && unit >= pos) {
      placed = true;
      row = rows.length;
      col = curW;
    }
    if (ch === "\n") {
      rows.push(cur);
      cur = "";
      curW = 0;
      unit += 1;
      continue;
    }
    if (ch !== "") {
      const hl = highlights?.find(r => i >= r.start && i < r.end);
      cur += hl ? hl.paint(rendered) : rendered;
      curW += w;
      unit += ch.length;
    }
  }
  if (!placed) {
    row = rows.length;
    col = curW;
  }
  rows.push(cur);
  return { rows, row, col };
}

/** Normalize the `highlight` option (single range, array, or absent) into a
 *  non-empty range array, or undefined when there is nothing to paint. */
function normalizeHighlights(
  h?: HighlightRange | readonly HighlightRange[],
): readonly HighlightRange[] | undefined {
  if (!h) return undefined;
  const arr = Array.isArray(h) ? h : [h as HighlightRange];
  return arr.length ? arr : undefined;
}

/**
 * Boxed input prompt (gjc-style): a `>` marker leads the first body row, the typed
 * text (or a dim placeholder) follows, and the caret cell is reported so the caller
 * can park the REAL terminal cursor right after `>` — moving with the arrow keys.
 */
export function renderInputFrame(line: string, opts: InputBoxOptions = {}): InputFrame {
  // Never clamp UP past what the caller reports as the real terminal width — a
  // fixed floor here (previously 24) silently overflowed any narrower terminal
  // (e.g. a resize down to 20 cols still drew a 24-col box), which real terminals
  // then hard-wrap/split at the boundary (the exact box-border corruption a real
  // resize-down reproduces live). Degrading to a very small, ugly-but-correctly-
  // sized box is strictly better than one that overflows and gets torn.
  const cols = Math.max(1, Math.trunc(opts.cols ?? 80));
  const useColor = opts.color !== false;
  const placeholder = opts.placeholder ?? "Type your message...";
  const bodyWidth = Math.max(1, cols - 4);
  const textWidth = Math.max(1, bodyWidth - 2); // "> " / "  " prefix columns

  let rows: string[];
  let crow = 0;
  let ccol = 0;
  let placeholderRow = false;
  if (line.length === 0) {
    rows = [placeholder];
    placeholderRow = true;
  } else {
    const hl = useColor ? normalizeHighlights(opts.highlight) : undefined;
    const wrapped = wrapWithCursor(line, opts.cursor ?? line.length, textWidth, hl);
    rows = wrapped.rows;
    crow = wrapped.row;
    ccol = wrapped.col;
  }

  // Scroll the visible window so the caret row stays in view — cursor movement reveals
  // every line (no content is unreachable). A count-bearing marker (not a bare `…`) flags
  // rows hidden above/below so a large paste's user isn't left guessing how much text is
  // off-screen — e.g. pasting a 20-line block previously showed a bare "…line sixteen"
  // with no indication 15 more lines existed above it.
  const maxBodyRows = Math.max(1, Math.trunc(opts.maxBodyRows ?? rows.length));
  const totalRows = rows.length;
  let hidden = 0;
  let topPrefixWidth = 0;
  if (totalRows > maxBodyRows) {
    hidden = Math.min(Math.max(0, crow - maxBodyRows + 1), totalRows - maxBodyRows);
    if (crow < hidden) hidden = crow; // caret above the window → scroll up to it
    rows = rows.slice(hidden, hidden + maxBodyRows);
    if (hidden > 0) {
      const topPrefix = `+${hidden}⋯`;
      topPrefixWidth = visibleWidth(topPrefix);
      rows[0] = truncateToWidth(`${topPrefix}${rows[0] ?? ""}`, textWidth);
    }
    const hiddenBelow = totalRows - hidden - maxBodyRows;
    if (hiddenBelow > 0) {
      const last = rows.length - 1;
      rows[last] = truncateToWidth(`${rows[last] ?? ""}⋯+${hiddenBelow}`, textWidth);
    }
  }
  let visRow = Math.max(0, Math.min(crow - hidden, rows.length - 1));
  if (hidden > 0 && crow - hidden === 0) ccol += topPrefixWidth; // shifted by the leading "+N⋯" marker
  if (crow - hidden < 0) { visRow = 0; ccol = 0; }

  const promptMark = "> ";
  const paintPrompt = useColor ? (opts.accent ?? chalk.blueBright) : (s: string) => s;
  const paintGhost = useColor ? chalk.dim : (s: string) => s;
  const body = rows.map((r, i) => {
    const content = placeholderRow ? paintGhost(r) : r;
    return i === 0 ? paintPrompt(promptMark) + content : "  " + r;
  });

  const content = [...body];
  // Label rows follow the active theme: the attachment hint uses the accent and
  // the cwd label a dimmed accent (shadow), so the whole box reads in one tone
  // instead of off-theme cyan/gray.
  const labelAccent = useColor ? (opts.accent ?? chalk.cyan) : (s: string) => s;
  const labelMuted = useColor ? (opts.accentShadow ?? chalk.gray) : (s: string) => s;
  if (opts.attachmentLabel) {
    content.push(labelAccent(opts.attachmentLabel));
  }
  if (opts.cwdLabel) {
    content.push(labelMuted(opts.cwdLabel));
  }
  const glyphs = opts.unicode === false ? BOX_ASCII : BOX_UNICODE;
  // Depth cue: lit top/left edge (bright accent) vs shaded bottom/right edge (dim).
  const paint = useColor ? (opts.accent ?? chalk.blueBright) : (s: string) => s;
  const paintShadow = useColor ? (opts.accentShadow ?? ((s: string) => chalk.blue.dim(s))) : (s: string) => s;
  const lines = boxBlock(content, cols, { glyphs, paint, paintShadow, align: "left" });

  // Terminal columns: border at col 1, content starts col 2, text after "> " at col 4.
  const cursorRow = 1 + visRow;
  const cursorCol = 4 + (placeholderRow ? 0 : ccol);
  return { lines, cursorRow, cursorCol };
}

/**
 * Renders a boxed input box enclosing either the current typed text or a placeholder.
 * If opts.cwdLabel is provided, a dim gray label line is appended after the text inside the box.
 */
export function renderInputBox(line: string, opts: InputBoxOptions = {}): string[] {
  return renderInputFrame(line, opts).lines;
}
/** Visual (row, display-col) of every caret position 0..N of `text` wrapped at `width`,
 *  using the SAME wrapping rule as the input box (`wrapWithCursor`). Indexing is by
 *  UTF-16 CODE UNIT — the unit `rl.cursor` uses — so `cells[rl.cursor]` is always the
 *  cell readline's caret actually sits on, even in text containing astral characters
 *  (emoji). A surrogate PAIR contributes two entries with the SAME cell: the pair's
 *  start, plus the (never-parked-on) mid-pair offset, so every later index stays aligned
 *  with the string's own offsets. */
export interface CaretCell {
  row: number;
  col: number;
}
export function caretCells(text: string, width: number): CaretCell[] {
  const cells: CaretCell[] = [];
  let curW = 0;
  let row = 0;
  const chars = Array.from(text.replace(/\r/g, ""));
  for (let i = 0; i <= chars.length; i++) {
    const ch = i < chars.length ? chars[i]! : "";
    const w = ch === "" || ch === "\n" ? 0 : ch === "\t" ? 2 : visibleWidth(ch);
    // Wrap BEFORE recording the caret so a caret on a wrapping char follows it down — the
    // exact order wrapWithCursor uses, so cell rows match the rendered box rows.
    if (w > 0 && curW + w > width && curW > 0) { row += 1; curW = 0; }
    cells.push({ row, col: curW });
    // Keep one entry PER CODE UNIT: the extra entry for a surrogate pair's low half
    // repeats the pair's own cell, so it can never render (or return) a half-character
    // caret position while keeping `cells[i]` addressable by a raw string offset.
    for (let extra = 1; extra < ch.length; extra++) cells.push({ row, col: curW });
    if (ch === "\n") { row += 1; curW = 0; continue; }
    if (ch !== "") curW += w;
  }
  return cells;
}

/** Snap a derived caret offset off the low half of a surrogate pair (a full character is
 *  the smallest unit the caret may sit on) — `caretCells` deliberately keeps those
 *  offsets addressable, so every offset RETURNED to readline passes through here. */
function snapToCharBoundary(text: string, offset: number): number {
  const code = text.charCodeAt(offset);
  return offset > 0 && code >= 0xdc00 && code <= 0xdfff ? offset - 1 : offset;
}

/** New caret offset after an Up/Down move within the wrapped input box, keeping the
 *  display column (textarea convention: snap to the nearest column ≤ the current one on the
 *  target row). Returns null when already on the top row (Up) or bottom row (Down), so the
 *  caller can fall through to readline's input-history recall. `cursor` and the returned
 *  offset are UTF-16 code units (`rl.cursor`'s unit), never split a surrogate pair. */
export function verticalCursorOffset(
  text: string,
  cursor: number,
  width: number,
  dir: "up" | "down",
): number | null {
  const cells = caretCells(text, Math.max(1, width));
  if (cells.length === 0) return null;
  const pos = Math.max(0, Math.min(cursor, cells.length - 1));
  const curRow = cells[pos]!.row;
  const targetRow = dir === "up" ? curRow - 1 : curRow + 1;
  const maxRow = cells[cells.length - 1]!.row;
  if (targetRow < 0 || targetRow > maxRow) return null;
  const curCol = cells[pos]!.col;
  let best = -1;
  let bestCol = -1;
  let firstOnRow = -1;
  for (let p = 0; p < cells.length; p++) {
    if (cells[p]!.row !== targetRow) continue;
    if (firstOnRow === -1) firstOnRow = p;
    const c = cells[p]!.col;
    // Largest column not past the current one — the standard column-preserving snap.
    if (c <= curCol && c > bestCol) { best = p; bestCol = c; }
  }
  const target = best !== -1 ? best : firstOnRow;
  return snapToCharBoundary(text, target);
}
/** Caret offset at the START or END of the VISUAL ROW containing `cursor`, using the
 *  SAME wrapping rule as the input box (`caretCells`/`wrapWithCursor`). This is the
 *  row-aware counterpart to Home/End (and macOS Cmd+Left/Right): on a single-row draft
 *  it degenerates to the whole buffer's start/end (0 / length), but on a multi-row draft
 *  (Shift+Enter hard breaks OR a long line the box soft-wraps) it stops at the CURRENT
 *  row's boundary instead of jumping past other rows — matching the platform convention
 *  (macOS Cmd+←/→, editors' Home/End) of "start/end of THIS line", not "start/end of the
 *  whole document". */
export function rowBoundaryOffset(
  text: string,
  cursor: number,
  width: number,
  edge: "start" | "end",
): number {
  const cells = caretCells(text, Math.max(1, width));
  if (cells.length === 0) return 0;
  const pos = Math.max(0, Math.min(cursor, cells.length - 1));
  const row = cells[pos]!.row;
  let start = pos;
  let end = pos;
  for (let p = 0; p < cells.length; p++) {
    if (cells[p]!.row !== row) continue;
    if (p < start) start = p;
    if (p > end) end = p;
  }
  return snapToCharBoundary(text, edge === "start" ? start : end);
}
