/**
 * Render GFM markdown tables in assistant text as box-drawn tables (consensus-seed
 * P2.B8). Pure-TS, width-aware (uses ./width so CJK/emoji/ANSI columns align).
 * Non-table text and fenced code blocks pass through untouched; a block is treated
 * as a table when it has a header row, a `|---|---|` delimiter row, and at least
 * one body row.
 */
import { visibleWidth, truncateToWidth, wrapTextWordAware } from "./width";
import { stripInlineMarkdown } from "./markdown-text";

export interface TableRenderOptions {
  unicode?: boolean;
  /** Hard cap on a column's display width before truncation/wrapping; keeps wide tables on screen. */
  maxColWidth?: number;
  /** Optional total table display width budget (terminal columns). Fits columns
   *  proportionally via water-filling so box borders never overflow terminal width. */
  maxWidth?: number;
  /** Wrap cell contents onto multiple rows inside each cell instead of truncating.
   *  Defaults to true when `maxWidth` is provided, false otherwise. */
  wrapCells?: boolean;
  /** Format each cell (inline Markdown -> ANSI/plain) BEFORE measuring column
   *  widths and padding, so bold/code/italic/links align `│` borders accurately.
   *  Defaults to `stripInlineMarkdown`. */
  formatCell?: (cell: string) => string;
}

interface FenceState {
  char: "`" | "~";
  len: number;
}

function matchOpenFence(trimmed: string): FenceState | null {
  const bt = trimmed.match(/^(`{3,})([^`]*)$/);
  if (bt) return { char: "`", len: bt[1]!.length };
  const tl = trimmed.match(/^(~{3,})(.*)$/);
  if (tl) return { char: "~", len: tl[1]!.length };
  return null;
}

function isCloseFence(trimmed: string, fence: FenceState): boolean {
  const ch = fence.char;
  if (!trimmed.startsWith(ch.repeat(fence.len))) return false;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== ch) return false;
  }
  return true;
}

/** A line carries an *unescaped* `|` — a real cell separator, not a literal `\|`. */
function hasUnescapedPipe(line: string): boolean {
  return /(?:^|[^\\])\|/.test(line);
}

/** A line is a table row when it has at least one unescaped `|`. */
function isTableRow(line: string): boolean {
  return hasUnescapedPipe(line.trim());
}

/** Split a markdown table row into trimmed cell strings, honoring escaped `\|`. */
function splitCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  // Only strip a trailing pipe that actually closes the row (not an escaped `\|`).
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  return cells.map(c => c.trim());
}

/** A line is the GFM delimiter row, e.g. `| --- | :--: | ---: |`. */
function isDelimiterRow(line: string): boolean {
  if (!isTableRow(line)) return false;
  const cells = splitCells(line);
  return cells.length > 0 && cells.every(cell => /^:?-{1,}:?$/.test(cell));
}

type Align = "left" | "center" | "right";

function alignmentsFrom(delim: string): Align[] {
  return splitCells(delim).map(cell => {
    const c = cell.trim();
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

function padCell(text: string, width: number, align: Align): string {
  const w = visibleWidth(text);
  const pad = Math.max(0, width - w);
  if (align === "right") return " ".repeat(pad) + text;
  if (align === "center") {
    const l = Math.floor(pad / 2);
    return " ".repeat(l) + text + " ".repeat(pad - l);
  }
  return text + " ".repeat(pad);
}

/** Full box glyph set incl. T-junctions for grid rules (layout.BoxGlyphs has corners only). */
interface TableGlyphs {
  h: string; v: string;
  tl: string; tt: string; tr: string;
  ml: string; mm: string; mr: string;
  bl: string; bt: string; br: string;
}
const TABLE_UNICODE: TableGlyphs = {
  h: "─", v: "│",
  tl: "┌", tt: "┬", tr: "┐",
  ml: "├", mm: "┼", mr: "┤",
  bl: "└", bt: "┴", br: "┘",
};
const TABLE_ASCII: TableGlyphs = {
  h: "-", v: "|",
  tl: "+", tt: "+", tr: "+",
  ml: "+", mm: "+", mr: "+",
  bl: "+", bt: "+", br: "+",
};

/** Proportionally fit column widths to stay within `contentBudget` via ascending
 *  water-filling: narrow columns keep their natural width first, and only wider
 *  columns share the remaining width budget evenly. */
function fitWidthsWaterFill(natural: number[], contentBudget: number): number[] {
  const cols = natural.length;
  const total = natural.reduce((sum, w) => sum + w, 0);
  if (total <= contentBudget) return [...natural];
  const budget = Math.max(cols, contentBudget);
  const fitted = new Array<number>(cols).fill(1);
  const order = natural.map((w, idx) => ({ w, idx })).sort((a, b) => a.w - b.w);
  let remBudget = budget;
  for (let i = 0; i < order.length; i++) {
    const remCols = order.length - i;
    const fair = Math.floor(remBudget / remCols);
    if (order[i]!.w <= fair) {
      fitted[order[i]!.idx] = Math.max(1, order[i]!.w);
      remBudget -= fitted[order[i]!.idx]!;
    } else {
      const base = Math.max(1, fair);
      const extra = Math.max(0, remBudget - base * remCols);
      for (let j = i; j < order.length; j++) {
        fitted[order[j]!.idx] = base + (j - i < extra ? 1 : 0);
      }
      break;
    }
  }
  return fitted;
}

/** Split `<br>` tags inside a table cell only outside backtick code spans, so
 *  literal `` `<br>` `` documentation inside inline code stays intact. */
function splitBrOutsideCode(raw: string): string[] {
  if (!/<br\s*\/?>/i.test(raw)) return [raw];
  const parts: string[] = [];
  let cur = "";
  let i = 0;
  let tickLen = 0;
  while (i < raw.length) {
    if (raw[i] === "`") {
      let n = 0;
      while (i + n < raw.length && raw[i + n] === "`") n++;
      if (tickLen === 0) tickLen = n;
      else if (n === tickLen) tickLen = 0;
      cur += raw.slice(i, i + n);
      i += n;
      continue;
    }
    if (tickLen === 0 && raw[i] === "<") {
      const m = raw.slice(i).match(/^<br\s*\/?>/i);
      if (m) {
        parts.push(cur);
        cur = "";
        i += m[0].length;
        continue;
      }
    }
    cur += raw[i]!;
    i++;
  }
  parts.push(cur);
  return parts;
}

/** Render one parsed table (header + rows) to box-drawn lines. */
function drawTable(header: string[], rows: string[][], aligns: Align[], opts: TableRenderOptions): string[] {
  const g = opts.unicode === false ? TABLE_ASCII : TABLE_UNICODE;
  const fmt = opts.formatCell ?? stripInlineMarkdown;
  const wrapCells = opts.wrapCells ?? (opts.maxWidth !== undefined);
  const cols = Math.max(header.length, ...rows.map(r => r.length));
  const aligned = Array.from({ length: cols }, (_, i) => aligns[i] ?? "left");

  // Format each cell (handling optional `<br>` breaks) BEFORE measuring widths
  // so inline markers like `**`, `` ` ``, and `[label](url)` never skew padding.
  const formatCellLines = (raw: string): string[] => {
    return splitBrOutsideCode(raw).map(p => fmt(p.trim()));
  };
  const hCells = Array.from({ length: cols }, (_, i) => formatCellLines(header[i] ?? ""));
  const bodyCells = rows.map(r => Array.from({ length: cols }, (_, i) => formatCellLines(r[i] ?? "")));

  const cellWidth = (lines: string[]) =>
    lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);

  const explicitCap = opts.maxColWidth !== undefined ? Math.max(4, opts.maxColWidth) : undefined;
  const defaultCap = explicitCap ?? (opts.maxWidth !== undefined ? Math.max(12, opts.maxWidth) : 40);
  const natural = Array.from({ length: cols }, (_, i) => {
    const maxNatural = Math.max(cellWidth(hCells[i]!), ...bodyCells.map(r => cellWidth(r[i]!)), 1);
    return explicitCap !== undefined ? Math.min(defaultCap, maxNatural) : Math.min(defaultCap, maxNatural);
  });

  const overhead = 3 * cols + 1;
  const widths = opts.maxWidth !== undefined
    ? fitWidthsWaterFill(natural, opts.maxWidth - overhead)
    : natural;

  const renderCellSubLines = (lines: string[], width: number): string[] => {
    if (!wrapCells) {
      const joined = lines.join(" ");
      return [visibleWidth(joined) > width ? truncateToWidth(joined, width) : joined];
    }
    const wrapped: string[] = [];
    for (const part of lines) {
      if (visibleWidth(part) <= width) {
        wrapped.push(part);
      } else {
        wrapped.push(...wrapTextWordAware(part, width));
      }
    }
    return wrapped.length ? wrapped : [""];
  };

  const rule = (l: string, mid: string, r: string): string =>
    l + widths.map(w => g.h.repeat(w + 2)).join(mid) + r;

  const emitRow = (cells: string[][]): string[] => {
    const wrappedCols = cells.map((c, i) => renderCellSubLines(c, widths[i]!));
    const height = Math.max(1, ...wrappedCols.map(c => c.length));
    const out: string[] = [];
    for (let r = 0; r < height; r++) {
      out.push(
        g.v +
          wrappedCols
            .map((colLines, i) => " " + padCell(colLines[r] ?? "", widths[i]!, aligned[i]!) + " ")
            .join(g.v) +
          g.v,
      );
    }
    return out;
  };

  return [
    rule(g.tl, g.tt, g.tr),
    ...emitRow(hCells),
    rule(g.ml, g.mm, g.mr),
    ...bodyCells.flatMap(emitRow),
    rule(g.bl, g.bt, g.br),
  ];
}

/**
 * Replace every GFM table block in `text` with a box-drawn table. Returns the text
 * with tables rendered; fenced code blocks and all non-table lines are preserved verbatim.
 */
export function renderMarkdownTables(text: string, opts: TableRenderOptions = {}): string {
  if (!text.includes("|")) return text;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let fence: FenceState | null = null;
  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i]!;
    const trimmed = rawLine.trim();
    if (fence) {
      if (isCloseFence(trimmed, fence)) fence = null;
      out.push(rawLine);
      i++;
      continue;
    }
    const opened = matchOpenFence(trimmed);
    if (opened) {
      fence = opened;
      out.push(rawLine);
      i++;
      continue;
    }
    // A table needs: header row, delimiter row, ≥1 body row.
    if (
      i + 1 < lines.length &&
      isTableRow(rawLine) &&
      isDelimiterRow(lines[i + 1]!) &&
      i + 2 < lines.length &&
      isTableRow(lines[i + 2]!)
    ) {
      const header = splitCells(rawLine);
      const aligns = alignmentsFrom(lines[i + 1]!);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j]!) && !isDelimiterRow(lines[j]!)) {
        rows.push(splitCells(lines[j]!));
        j++;
      }
      for (const line of drawTable(header, rows, aligns, opts)) out.push(line);
      i = j;
      continue;
    }
    out.push(rawLine);
    i++;
  }
  return out.join("\n");
}
