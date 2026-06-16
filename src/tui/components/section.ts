/**
 * Section layout primitives — a small shadcn/ui-inspired design-token layer for the
 * terminal TUI. shadcn's discipline is *consistent vertical rhythm* (`space-y-*`) and
 * *card grouping* with a muted header (`CardHeader` + `text-muted-foreground`). The
 * gjc reference TUI does the same with `├─ Output ─┤` style dividers between a tool
 * block and its output.
 *
 * These helpers give the live frame one shared spacing token (`SECTION_GAP`) and a
 * muted card-header divider (`sectionLabel`) so the in-frame stages (plan / activity /
 * output) read as distinct, evenly-spaced cards instead of one cramped wall of lines.
 */
import chalk from "chalk";
import { visibleWidth } from "./color";

/** Vertical rhythm: blank lines inserted between adjacent sections (shadcn `space-y`). */
export const SECTION_GAP = 1;

export interface SectionLabelOpts {
  color?: boolean;
  unicode?: boolean;
}

/**
 * A muted card-header divider spanning `width` columns: `── Plan ─────────────`.
 * Mirrors shadcn's `CardHeader` (a muted title) and gjc's `├─ Output ─┤` separators,
 * so each stage block is announced by a low-contrast label rather than running into
 * the previous block.
 */
export function sectionLabel(title: string, width: number, opts: SectionLabelOpts = {}): string {
  const unicode = opts.unicode !== false;
  const dash = unicode ? "─" : "-";
  // A 3-dash lead-in makes the card header read as a distinct boundary (stronger than a
  // single rule) without becoming loud.
  const startDash = unicode ? "───" : "---";
  const head = `${startDash} ${title.trim()} `;
  const headW = visibleWidth(head);
  const fill = Math.max(0, Math.trunc(width) - headW);
  const line = head + dash.repeat(fill);
  return opts.color !== false ? chalk.dim(line) : line;
}

export interface Section {
  /** Optional muted card header. Omit for self-headed blocks (plan/forge already label themselves). */
  title?: string;
  lines: string[];
}

export interface StackOptions {
  width: number;
  gap?: number;
  color?: boolean;
  unicode?: boolean;
}

/**
 * Stack sections with a consistent blank-line rhythm. Empty sections are dropped, a
 * titled section is prefixed with its muted `sectionLabel`, and exactly `gap` blank
 * lines separate adjacent (non-empty) sections. Returns a flat line array ready to
 * drop into the frame.
 */
export function stackSections(sections: Section[], opts: StackOptions): string[] {
  const gap = Math.max(0, opts.gap ?? SECTION_GAP);
  const out: string[] = [];
  for (const section of sections) {
    const lines = [...section.lines];
    while (lines.length && lines[0] === "") {
      lines.shift();
    }
    while (lines.length && lines[lines.length - 1] === "") {
      lines.pop();
    }
    if (!lines.length) continue;
    if (out.length) {
      for (let i = 0; i < gap; i++) out.push("");
    }
    if (section.title) {
      out.push(sectionLabel(section.title, opts.width, { color: opts.color, unicode: opts.unicode }));
    }
    for (const line of lines) {
      out.push(line);
    }
  }
  return out;
}
