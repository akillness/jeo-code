/**
 * Generic keyboard-navigable selection list for the TUI (model/provider pickers).
 *
 * Split into a pure state machine (`SelectList`) and a pure renderer
 * (`renderSelectList`) so the picker logic is fully unit-testable without a real
 * TTY. The renderer is viewport-aware: it shows a scrolling window of `rows`
 * around the cursor and fits each line to `cols`, so long lists never overflow
 * the terminal height/width.
 */
import chalk from "chalk";
import { padLineTo } from "./layout";
import { visibleWidth } from "./color";

export interface SelectItem<T> {
  value: T;
  label: string;
  /** Optional group header shown above the first item of each group. */
  group?: string;
  /** Disabled items are shown dimmed and skipped by cursor navigation. */
  disabled?: boolean;
  /** Optional right-aligned hint/badge (e.g. "✓ ready · 200k"). */
  hint?: string;
}

export class SelectList<T> {
  private readonly items: SelectItem<T>[];
  private query = "";
  private cursor = 0; // index into the *visible* list

  constructor(items: SelectItem<T>[]) {
    this.items = items;
    this.cursor = this.firstEnabled(this.computeVisible());
  }

  /** Items matching the current filter (case-insensitive substring on label). */
  visible(): SelectItem<T>[] {
    return this.computeVisible();
  }

  private computeVisible(): SelectItem<T>[] {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.items;
    return this.items.filter(i => i.label.toLowerCase().includes(q) || (i.group ?? "").toLowerCase().includes(q));
  }

  private firstEnabled(list: SelectItem<T>[]): number {
    const i = list.findIndex(it => !it.disabled);
    return i < 0 ? 0 : i;
  }

  /** Current cursor index within the visible list (clamped). */
  cursorIndex(): number {
    const n = this.computeVisible().length;
    if (n === 0) return 0;
    return Math.max(0, Math.min(this.cursor, n - 1));
  }

  isEmpty(): boolean {
    return this.computeVisible().length === 0;
  }

  /** The currently selected item (skips when empty / all disabled). */
  selected(): SelectItem<T> | undefined {
    const list = this.computeVisible();
    const item = list[this.cursorIndex()];
    return item && !item.disabled ? item : undefined;
  }

  /** Set the filter query; cursor jumps to the first enabled match. */
  setFilter(query: string): void {
    this.query = query;
    this.cursor = this.firstEnabled(this.computeVisible());
  }

  filter(): string {
    return this.query;
  }

  /** Append a character to the filter (typing). */
  typeChar(ch: string): void {
    this.setFilter(this.query + ch);
  }

  /** Remove the last filter character (backspace). */
  backspace(): void {
    this.setFilter(this.query.slice(0, -1));
  }

  private step(dir: 1 | -1): void {
    const list = this.computeVisible();
    const n = list.length;
    if (n === 0) return;
    let i = this.cursorIndex();
    for (let tries = 0; tries < n; tries++) {
      i = (i + dir + n) % n;
      if (!list[i]!.disabled) break;
    }
    this.cursor = i;
  }

  up(): void {
    this.step(-1);
  }
  down(): void {
    this.step(1);
  }

  /** Move by a page (clamped, no wrap), landing on an enabled item. */
  page(dir: 1 | -1, size = 5): void {
    const list = this.computeVisible();
    const n = list.length;
    if (n === 0) return;
    let i = Math.max(0, Math.min(n - 1, this.cursorIndex() + dir * Math.max(1, size)));
    // settle onto the nearest enabled item in the travel direction
    while (i >= 0 && i < n && list[i]!.disabled) i += dir;
    if (i < 0 || i >= n) i = this.firstEnabled(list);
    this.cursor = i;
  }
}

export interface RenderSelectOptions {
  /** Title line shown above the list. */
  title?: string;
  /** Max body rows for the scrolling window (default 10). */
  rows?: number;
  /** Total width to fit each line to (default: natural). */
  cols?: number;
  /** Use unicode glyphs for the cursor/markers (default true). */
  unicode?: boolean;
  /** Apply chalk color (default true). */
  color?: boolean;
}

/**
 * Render a `SelectList` to lines: optional title, a scrolling window of items
 * with the cursor highlighted, group headers, right-aligned hints, and a footer
 * with the active filter + key hints. Pure — no I/O.
 */
export function renderSelectList<T>(list: SelectList<T>, opts: RenderSelectOptions = {}): string[] {
  const unicode = opts.unicode !== false;
  const color = opts.color !== false;
  const rows = Math.max(1, opts.rows ?? 10);
  const cols = opts.cols;
  const pointer = unicode ? "\u276f" : ">"; // ❯ / >
  const tint = (s: string, fn: (x: string) => string) => (color ? fn(s) : s);

  const out: string[] = [];
  if (opts.title) out.push(tint(opts.title, chalk.bold));

  const items = list.visible();
  if (items.length === 0) {
    out.push(tint("  (no matches)", chalk.gray));
  } else {
    const cur = list.cursorIndex();
    // Scrolling window centered-ish on the cursor.
    let start = Math.max(0, cur - Math.floor(rows / 2));
    start = Math.min(start, Math.max(0, items.length - rows));
    const end = Math.min(items.length, start + rows);

    if (start > 0) out.push(tint(`  \u2191 ${start} more`, chalk.gray));
    let lastGroup: string | undefined;
    for (let i = start; i < end; i++) {
      const it = items[i]!;
      if (it.group && it.group !== lastGroup) {
        out.push(tint(`  ${it.group}`, chalk.gray));
        lastGroup = it.group;
      }
      const isCur = i === cur;
      const marker = isCur ? tint(pointer, chalk.cyan) : " ";
      let label = it.disabled ? tint(it.label, chalk.gray) : isCur ? tint(it.label, chalk.cyan.bold) : it.label;
      let line = `${marker} ${label}`;
      if (it.hint) {
        const hint = tint(it.hint, chalk.gray);
        if (cols) {
          // right-align the hint within cols
          const used = visibleWidth(line) + visibleWidth(hint) + 1;
          const gap = Math.max(1, cols - used);
          line = `${line}${" ".repeat(gap)}${hint}`;
        } else {
          line = `${line}  ${hint}`;
        }
      }
      out.push(cols ? clampToCols(line, cols) : line);
    }
    if (end < items.length) out.push(tint(`  \u2193 ${items.length - end} more`, chalk.gray));
  }

  const q = list.filter();
  const filterPart = q ? `filter: ${q}` : "type to filter";
  const keys = unicode ? "\u2191/\u2193 move \u00b7 enter select \u00b7 esc cancel" : "up/down move . enter select . esc cancel";
  out.push(tint(`  ${filterPart}  \u2014  ${keys}`, chalk.gray));
  return out;
}

/** Fit a (possibly colored) line to cols by visible width, preserving the right hint. */
function clampToCols(line: string, cols: number): string {
  if (visibleWidth(line) <= cols) return padLineTo(line, cols, "left");
  return line; // caller-built hint lines are already gap-fitted; leave longer plain lines to the renderer truncate
}
