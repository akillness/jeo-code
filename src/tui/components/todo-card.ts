import chalk from "chalk";
import { padLineTo } from "./layout";
import { visibleWidth } from "./color";

export interface TodoCardItem {
  title: string;
  status: "pending" | "in_progress" | "done";
}

export interface TodoCardOptions {
  unicode?: boolean;
  color?: boolean;
  /** Faint card background tint painter — gives the card a panel look so it reads
   *  as a distinct block. Identity when absent (or colorless). */
  fill?: (s: string) => string;
  /** Muted foreground painter for secondary text (done/pending labels, count,
   *  tree connectors). Replaces `chalk.dim`, which washes out on dark terminals. */
  muted?: (s: string) => string;
  /** Accent painter for the in_progress (active) item — the theme's highlight hue,
   *  applied bold. Defaults to cyan so the active row matches the rest of the theme
   *  instead of a hardcoded color that clashes on warm/green/red palettes. */
  accent?: (s: string) => string;
  /** Panel width: lines pad to this so the fill spans a clean rectangle. Clamped
   *  to [20,120]; defaults to the longest content row + 2. */
  width?: number;
}

/**
 * jeo-ref "Todo Write" scrollback card: a ✓-led header with a tree-connector
 * checklist — done items get ☑ + strikethrough, the active item highlights,
 * pending stays muted. A faint background tint (when a `fill` painter is given)
 * makes the whole block read as a panel; secondary text uses a real muted hue
 * instead of ANSI dim so completed rows stay legible. Pure `string[]`; the caller
 * flushes it into the ledger so the plan's evolution reads as transcript history.
 */
export function formatTodoWriteCard(items: TodoCardItem[], opts: TodoCardOptions = {}): string[] {
  if (items.length === 0) return [];
  const unicode = opts.unicode !== false;
  const color = opts.color !== false;
  const fill = opts.fill ?? ((s: string) => s);
  const muted = color ? (opts.muted ?? chalk.dim) : (s: string) => s;
  const active = color ? (opts.accent ? (s: string) => chalk.bold(opts.accent!(s)) : chalk.cyan.bold) : (s: string) => s;
  const check = unicode ? "✓" : "v";
  const boxDone = unicode ? "☑" : "[x]";
  const boxOpen = unicode ? "☐" : "[ ]";
  const tee = unicode ? "├─" : "|-";
  const ell = unicode ? "└─" : "`-";
  const count = `${items.length} task${items.length === 1 ? "" : "s"}`;

  const rows: string[] = [];
  rows.push(
    color
      ? `${chalk.green(check)} ${chalk.bold("Todo Write")} ${muted(count)}`
      : `${check} Todo Write ${count}`,
  );
  items.forEach((item, i) => {
    const conn = color ? muted(i === items.length - 1 ? ell : tee) : i === items.length - 1 ? ell : tee;
    if (item.status === "done") {
      const box = color ? chalk.green(boxDone) : boxDone;
      const label = color ? chalk.strikethrough(muted(item.title)) : item.title;
      rows.push(`  ${conn} ${box} ${label}`);
    } else if (item.status === "in_progress") {
      rows.push(`  ${conn} ${boxOpen} ${active(item.title)}`);
    } else {
      rows.push(`  ${conn} ${boxOpen} ${color ? muted(item.title) : item.title}`);
    }
  });

  // Panel: pad each row (with a 1-col left gutter) to a common width and tint the
  // whole rectangle — only when the caller opts in via `fill`/`width`; otherwise the
  // bare tree-checklist rows return unchanged (back-compat). visibleWidth ignores
  // ANSI, and every painter above closes with a TARGETED reset (never `\x1b[0m`), so
  // the background spans the full row.
  if (!opts.fill && opts.width === undefined) return rows;
  const contentWidth = rows.reduce((m, r) => Math.max(m, visibleWidth(r)), 0) + 2;
  const panelWidth = Math.max(20, Math.min(120, opts.width ?? contentWidth));
  return rows.map(r => fill(padLineTo(` ${r}`, panelWidth, "left")));
}
