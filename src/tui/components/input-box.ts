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
  /** Caret offset in CHARACTERS into `line` (readline's rl.cursor). Defaults to end. */
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
  const chars = Array.from(text.replace(/\r/g, ""));
  const pos = Math.max(0, Math.min(cursor, chars.length));
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
    if (i === pos) {
      row = rows.length;
      col = curW;
    }
    if (ch === "\n") {
      rows.push(cur);
      cur = "";
      curW = 0;
      continue;
    }
    if (ch !== "") {
      const hl = highlights?.find(r => i >= r.start && i < r.end);
      cur += hl ? hl.paint(rendered) : rendered;
      curW += w;
    }
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
  const cols = Math.max(24, Math.trunc(opts.cols ?? 80));
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
  // every line (no content is unreachable). `…` markers flag rows hidden above/below.
  const maxBodyRows = Math.max(1, Math.trunc(opts.maxBodyRows ?? rows.length));
  const totalRows = rows.length;
  let hidden = 0;
  if (totalRows > maxBodyRows) {
    hidden = Math.min(Math.max(0, crow - maxBodyRows + 1), totalRows - maxBodyRows);
    if (crow < hidden) hidden = crow; // caret above the window → scroll up to it
    rows = rows.slice(hidden, hidden + maxBodyRows);
    if (hidden > 0) rows[0] = truncateToWidth(`…${rows[0] ?? ""}`, textWidth);
    if (hidden + maxBodyRows < totalRows) {
      const last = rows.length - 1;
      rows[last] = truncateToWidth(`${rows[last] ?? ""}…`, textWidth);
    }
  }
  let visRow = Math.max(0, Math.min(crow - hidden, rows.length - 1));
  if (hidden > 0 && crow - hidden === 0) ccol += 1; // shifted by the leading `…`
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
 *  using the SAME wrapping rule as the input box (`wrapWithCursor`). Index i is the caret
 *  sitting BEFORE char i (N = end of text); `cursor` offsets are code points, matching how
 *  `renderInputFrame` clamps `opts.cursor` against `Array.from(text)`. */
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
    if (ch === "\n") { row += 1; curW = 0; continue; }
    if (ch !== "") curW += w;
  }
  return cells;
}

/** New caret offset after an Up/Down move within the wrapped input box, keeping the
 *  display column (textarea convention: snap to the nearest column ≤ the current one on the
 *  target row). Returns null when already on the top row (Up) or bottom row (Down), so the
 *  caller can fall through to readline's input-history recall. */
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
  return best !== -1 ? best : firstOnRow;
}
