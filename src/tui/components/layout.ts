/**
 * Responsive layout helpers — fit content to the terminal's width and height.
 *
 * Every alignment/padding decision is based on the *visible* width (ANSI escapes
 * ignored) so colored / gradient art is centered and boxed correctly. These are
 * pure functions over `string[]` blocks, injectable `cols`/`rows` for tests.
 */
import { visibleWidth } from "./color";
import { truncate } from "../terminal";

export type HAlign = "left" | "center" | "right";
export type VAlign = "top" | "center" | "bottom";

/** Pad a single line to `width` visible columns with the given horizontal alignment. */
export function padLineTo(line: string, width: number, align: HAlign = "left"): string {
  const vis = visibleWidth(line);
  if (width <= 0 || vis >= width) return line;
  const total = width - vis;
  if (align === "right") return " ".repeat(total) + line;
  if (align === "center") {
    const left = Math.floor(total / 2);
    return " ".repeat(left) + line + " ".repeat(total - left);
  }
  return line + " ".repeat(total);
}

/** Align every line of a block to `width` columns (default centered). */
export function alignBlock(lines: string[], width: number, align: HAlign = "center"): string[] {
  return lines.map(l => padLineTo(l, width, align));
}

/** Center a block horizontally within `cols` by left-padding to its center (no right pad). */
export function centerBlock(lines: string[], cols: number): string[] {
  const blockWidth = Math.max(0, ...lines.map(visibleWidth));
  if (cols <= blockWidth) return lines;
  const left = Math.floor((cols - blockWidth) / 2);
  const pad = " ".repeat(left);
  return lines.map(l => pad + l);
}

/**
 * Grow a block to exactly `rows` lines by inserting blank lines, vertically
 * aligned. Never truncates: a block already at/over `rows` is returned as-is.
 * `fillWidth` (visible cols) makes inserted blanks span the width for a stable
 * background; default empty strings.
 */
export function padBlockToHeight(lines: string[], rows: number, align: VAlign = "top", fillWidth = 0): string[] {
  if (rows <= 0 || lines.length >= rows) return lines;
  const blank = fillWidth > 0 ? " ".repeat(fillWidth) : "";
  const missing = rows - lines.length;
  if (align === "top") return [...lines, ...Array(missing).fill(blank)];
  if (align === "bottom") return [...Array(missing).fill(blank), ...lines];
  const top = Math.floor(missing / 2);
  return [...Array(top).fill(blank), ...lines, ...Array(missing - top).fill(blank)];
}

/**
 * Compose a full-screen frame that fills `rows`: `header` sits at the top,
 * `body` follows, and `footer` is pinned to the bottom, with blank filler
 * between body and footer. If content already exceeds `rows`, nothing is
 * clipped (the terminal scrolls) — the footer simply follows the body.
 */
export function fillScreen(header: string[], body: string[], footer: string[], rows: number): string[] {
  const content = [...header, ...body];
  const used = content.length + footer.length;
  const filler = Math.max(0, rows - used);
  return [...content, ...Array(filler).fill(""), ...footer];
}

/**
 * Draw a single-line border box around `lines`, sized to `width` visible columns
 * (inner content centered). `glyphs` selects unicode vs ASCII corners/edges.
 */
export interface BoxGlyphs {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
}

export const BOX_UNICODE: BoxGlyphs = { tl: "\u256d", tr: "\u256e", bl: "\u2570", br: "\u256f", h: "\u2500", v: "\u2502" };
export const BOX_ASCII: BoxGlyphs = { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };

export function boxBlock(
  lines: string[],
  width: number,
  opts: { glyphs?: BoxGlyphs; paint?: (s: string) => string; align?: HAlign } = {},
): string[] {
  const g = opts.glyphs ?? BOX_UNICODE;
  const paint = opts.paint ?? ((s: string) => s);
  const inner = Math.max(0, width - 2);
  const top = paint(g.tl + g.h.repeat(inner) + g.tr);
  const bottom = paint(g.bl + g.h.repeat(inner) + g.br);
  const mid = lines.map(l => {
    if (l === "DIVIDER") {
      const leftChar = g.tl === "+" ? "+" : "├";
      const rightChar = g.tr === "+" ? "+" : "┤";
      return paint(leftChar + g.h.repeat(inner) + rightChar);
    }
    const truncated = truncate(l, inner);
    const align = opts.align ?? "left";
    return paint(g.v) + padLineTo(truncated, inner, align) + paint(g.v);
  });
  return [top, ...mid, bottom];
}
