import chalk from "chalk";

export interface TodoCardItem {
  title: string;
  status: "pending" | "in_progress" | "done";
}

export interface TodoCardOptions {
  unicode?: boolean;
  color?: boolean;
}

/**
 * jeo-ref "Todo Write" scrollback card: a ✓-led header with a tree-connector
 * checklist — done items get ☑ + strikethrough, the active item highlights,
 * pending stays dim. Pure `string[]`; the caller flushes it into the ledger so
 * the plan's evolution (items checking off turn by turn) reads as transcript
 * history, exactly like the reference TUI.
 */
export function formatTodoWriteCard(items: TodoCardItem[], opts: TodoCardOptions = {}): string[] {
  if (items.length === 0) return [];
  const unicode = opts.unicode !== false;
  const color = opts.color !== false;
  const check = unicode ? "✓" : "v";
  const boxDone = unicode ? "☑" : "[x]";
  const boxOpen = unicode ? "☐" : "[ ]";
  const tee = unicode ? "├─" : "|-";
  const ell = unicode ? "└─" : "`-";
  const count = `${items.length} task${items.length === 1 ? "" : "s"}`;
  const head = color
    ? `${chalk.green(check)} ${chalk.bold("Todo Write")} ${chalk.dim(count)}`
    : `${check} Todo Write ${count}`;
  const lines = [head];
  items.forEach((item, i) => {
    const conn = i === items.length - 1 ? ell : tee;
    if (item.status === "done") {
      const box = color ? chalk.green(boxDone) : boxDone;
      const label = color ? chalk.dim.strikethrough(item.title) : item.title;
      lines.push(`  ${conn} ${box} ${label}`);
    } else if (item.status === "in_progress") {
      lines.push(`  ${conn} ${boxOpen} ${color ? chalk.cyan.bold(item.title) : item.title}`);
    } else {
      lines.push(`  ${conn} ${boxOpen} ${color ? chalk.dim(item.title) : item.title}`);
    }
  });
  return lines;
}
