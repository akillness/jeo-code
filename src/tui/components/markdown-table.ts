/**
 * Render GFM markdown tables in assistant text as box-drawn tables (consensus-seed
 * P2.B8). Pure-TS, width-aware (uses ./width so CJK/emoji columns align). Non-table
 * text passes through untouched; a block is only treated as a table when it has a
 * header row, a `|---|---|` delimiter row, and at least one body row.
 */
import { visibleWidth, truncateToWidth } from "./width";

export interface TableRenderOptions {
  unicode?: boolean;
  /** Hard cap on a column's display width before truncation; keeps wide tables on screen. */
  maxColWidth?: number;
}

/** A line is a table row when it has at least one unescaped `|` and trims to start/contain cells. */
function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.includes("|") && /\|/.test(t);
}

/** A line is the GFM delimiter row, e.g. `| --- | :--: | ---: |`. */
function isDelimiterRow(line: string): boolean {
  const t = line.trim().replace(/^\||\|$/g, "");
  if (!t.includes("-")) return false;
  return t.split("|").every(cell => /^\s*:?-{1,}:?\s*$/.test(cell));
}

/** Split a markdown table row into trimmed cell strings (drop the outer pipes). */
function splitCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map(c => c.trim());
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

/** Render one parsed table (header + rows) to box-drawn lines. */
function drawTable(header: string[], rows: string[][], aligns: Align[], opts: TableRenderOptions): string[] {
  const g = opts.unicode === false ? TABLE_ASCII : TABLE_UNICODE;
  const cap = Math.max(4, opts.maxColWidth ?? 40);
  const cols = Math.max(header.length, ...rows.map(r => r.length));
  const norm = (r: string[]): string[] => Array.from({ length: cols }, (_, i) => truncateToWidth(r[i] ?? "", cap));
  const h = norm(header);
  const body = rows.map(norm);
  const aligned = Array.from({ length: cols }, (_, i) => aligns[i] ?? "left");
  // Column width = max display width of header + body cells in that column.
  const widths = Array.from({ length: cols }, (_, i) =>
    Math.max(visibleWidth(h[i]!), ...body.map(r => visibleWidth(r[i]!)), 1),
  );
  const rule = (l: string, mid: string, r: string): string =>
    l + widths.map(w => g.h.repeat(w + 2)).join(mid) + r;
  const rowLine = (cells: string[]): string =>
    g.v + cells.map((c, i) => " " + padCell(c, widths[i]!, aligned[i]!) + " ").join(g.v) + g.v;
  return [
    rule(g.tl, g.tt, g.tr),
    rowLine(h),
    rule(g.ml, g.mm, g.mr),
    ...body.map(rowLine),
    rule(g.bl, g.bt, g.br),
  ];
}

/**
 * Replace every GFM table block in `text` with a box-drawn table. Returns the text
 * with tables rendered; all non-table lines are preserved verbatim.
 */
export function renderMarkdownTables(text: string, opts: TableRenderOptions = {}): string {
  if (!text.includes("|")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    // A table needs: header row, delimiter row, ≥1 body row.
    if (
      i + 1 < lines.length &&
      isTableRow(lines[i]!) &&
      isDelimiterRow(lines[i + 1]!) &&
      i + 2 < lines.length &&
      isTableRow(lines[i + 2]!)
    ) {
      const header = splitCells(lines[i]!);
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
    out.push(lines[i]!);
    i++;
  }
  return out.join("\n");
}
