/**
 * Rich, gjc-style session picker for `/resume`.
 *
 * Mirrors Gajae-Code's session selector UX: a search/filter line at the top, a
 * scrolling window of multi-line entries (title + dimmed first-message preview +
 * a "relative time · size · N msgs" metadata line), a position indicator, and a
 * footer with Del-to-delete / Enter-to-resume / Esc-to-cancel hints.
 *
 * Pure rendering — no I/O. The owning REPL drives navigation/deletion via the
 * `SessionPicker` model and feeds the rendered lines to its picker loop.
 */
import chalk from "chalk";
import { truncateToWidth } from "./width";
import type { SessionSummary } from "../../agent/session";

/** Human-readable byte size (e.g. "0 B", "12.3 KB", "4.2 MB"). */
export function formatBytes(n: number | undefined): string {
  const v = typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
  if (v < 1024) return `${v} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = v / 1024;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[i]}`;
}

/** Relative "X ago" timestamp, matching gjc's session-selector phrasing. */
export function formatRelativeTime(fromMs: number | undefined, nowMs: number = Date.now()): string {
  if (typeof fromMs !== "number" || !Number.isFinite(fromMs) || fromMs <= 0) return "unknown";
  const diff = Math.max(0, nowMs - fromMs);
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins !== 1 ? "s" : ""} ago`;
  if (hours < 24) return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
  if (days === 1) return "1 day ago";
  if (days < 7) return `${days} days ago`;
  return new Date(fromMs).toLocaleDateString();
}

/**
 * Navigable model for the resume picker: an ordered session list with a
 * case-insensitive AND-of-terms filter across id/title/preview/cwd, a cursor
 * into the *filtered* view, and in-place removal for delete.
 */
export class SessionPicker {
  private readonly all: SessionSummary[];
  private query = "";
  private cursor = 0;

  constructor(sessions: readonly SessionSummary[]) {
    this.all = sessions.slice();
  }

  /** Sessions matching the current filter (every whitespace term must match). */
  visible(): SessionSummary[] {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.all;
    const terms = q.split(/\s+/);
    return this.all.filter(s => {
      const hay = [s.id, s.title ?? "", s.preview ?? "", s.cwd ?? ""].join(" ").toLowerCase();
      return terms.every(t => hay.includes(t));
    });
  }

  cursorIndex(): number {
    const n = this.visible().length;
    if (n === 0) return 0;
    return Math.max(0, Math.min(this.cursor, n - 1));
  }

  selected(): SessionSummary | undefined {
    return this.visible()[this.cursorIndex()];
  }

  isEmpty(): boolean {
    return this.visible().length === 0;
  }

  filter(): string {
    return this.query;
  }

  setFilter(query: string): void {
    this.query = query;
    this.cursor = 0;
  }

  typeChar(ch: string): void {
    this.setFilter(this.query + ch);
  }

  backspace(): void {
    this.setFilter(this.query.slice(0, -1));
  }

  up(): void {
    const n = this.visible().length;
    if (n === 0) return;
    this.cursor = (this.cursorIndex() - 1 + n) % n;
  }

  down(): void {
    const n = this.visible().length;
    if (n === 0) return;
    this.cursor = (this.cursorIndex() + 1) % n;
  }

  /** Move by a window without wrapping (PageUp/PageDown). */
  page(dir: 1 | -1, size = 3): void {
    const n = this.visible().length;
    if (n === 0) return;
    this.cursor = Math.max(0, Math.min(n - 1, this.cursorIndex() + dir * Math.max(1, size)));
  }

  /** Remove the highlighted session from the model; returns it (or undefined). */
  removeSelected(): SessionSummary | undefined {
    const sel = this.selected();
    if (!sel) return undefined;
    const idx = this.all.findIndex(s => s.id === sel.id);
    if (idx >= 0) this.all.splice(idx, 1);
    const n = this.visible().length;
    if (this.cursor >= n) this.cursor = Math.max(0, n - 1);
    return sel;
  }
}

export interface RenderSessionPickerOptions {
  /** Title line(s) shown above the search line. */
  title?: string;
  /** Total width to fit each line to (default 80). */
  cols?: number;
  /** Total body rows available; the visible window is derived from this (default 24). */
  rows?: number;
  /** Use unicode glyphs (default true). */
  unicode?: boolean;
  /** Apply chalk color (default true). */
  color?: boolean;
  /** Clock override for relative-time formatting (tests). */
  nowMs?: number;
  /** When set, the matching session shows a "press Del again to delete" prompt. */
  confirmDeleteId?: string;
}

/** Render a `SessionPicker` to lines (gjc-style multi-line entries). Pure. */
export function renderSessionPicker(picker: SessionPicker, opts: RenderSessionPickerOptions = {}): string[] {
  const unicode = opts.unicode !== false;
  const color = opts.color !== false;
  const cols = Math.max(20, opts.cols ?? 80);
  const nowMs = opts.nowMs ?? Date.now();
  const tint = (s: string, fn: (x: string) => string): string => (color ? fn(s) : s);
  const fit = (s: string): string => truncateToWidth(s, cols);
  const pointer = unicode ? "\u276f" : ">"; // ❯
  const dot = unicode ? "\u00b7" : "-"; // ·
  const arrow = unicode ? "\u203a" : ">"; // ›

  const out: string[] = [];
  const titleLines = opts.title ? opts.title.split("\n") : [];
  for (const t of titleLines) out.push(fit(t ? tint(t, chalk.bold) : ""));

  // Search/filter line (gjc places an input box at the top).
  const q = picker.filter();
  const searchValue = q ? q : tint("type to filter", chalk.gray);
  out.push(fit(`${tint("search", chalk.gray)} ${tint(arrow, chalk.cyan)} ${searchValue}`));
  out.push("");

  const items = picker.visible();
  const footerKeys = unicode
    ? `\u2191/\u2193 move \u00b7 enter resume \u00b7 del delete \u00b7 esc cancel`
    : `up/down move - enter resume - del delete - esc cancel`;

  if (items.length === 0) {
    out.push(fit(tint("  no sessions match", chalk.gray)));
    out.push("");
    out.push(fit(tint(`  [${footerKeys}]`, chalk.gray)));
    return out;
  }

  // Each entry occupies up to 3 content lines + 1 blank; derive the window from
  // available rows, leaving room for title/search/footer chrome.
  const linesPerItem = 4;
  const chrome = titleLines.length + 2 /* search + blank */ + 2 /* position + footer */;
  const avail = Math.max(linesPerItem, (opts.rows ?? 24) - chrome);
  const maxVisible = Math.max(1, Math.min(items.length, Math.floor(avail / linesPerItem)));

  const cur = picker.cursorIndex();
  let start = Math.max(0, cur - Math.floor(maxVisible / 2));
  start = Math.min(start, Math.max(0, items.length - maxVisible));
  const end = Math.min(items.length, start + maxVisible);

  for (let i = start; i < end; i++) {
    const s = items[i]!;
    const isCur = i === cur;
    const isConfirm = !!opts.confirmDeleteId && s.id === opts.confirmDeleteId;
    const cursorStr = isCur ? tint(`${pointer} `, chalk.cyan) : "  ";
    const maxw = Math.max(1, cols - 2); // cursor/indent prefix is 2 columns
    const firstMsg = (s.preview || "(no preview)").replace(/\s+/g, " ").trim();

    if (s.title) {
      const titleTxt = truncateToWidth(s.title, maxw);
      out.push(fit(cursorStr + (isCur ? tint(titleTxt, (x: string) => chalk.cyan.bold(x)) : titleTxt)));
      out.push(fit("  " + tint(truncateToWidth(firstMsg, maxw), chalk.dim)));
    } else {
      const msg = truncateToWidth(firstMsg, maxw);
      out.push(fit(cursorStr + (isCur ? tint(msg, (x: string) => chalk.cyan.bold(x)) : msg)));
    }

    if (isConfirm) {
      out.push(fit(tint(`  press Del again to delete ${dot} any other key cancels`, chalk.yellow)));
    } else {
      const meta = `  ${formatRelativeTime(s.mtimeMs, nowMs)} ${dot} ${formatBytes(s.sizeBytes)} ${dot} ${s.messageCount} msg${s.messageCount !== 1 ? "s" : ""}`;
      out.push(fit(tint(truncateToWidth(meta, cols), chalk.dim)));
    }
    out.push("");
  }

  if (start > 0 || end < items.length) {
    out.push(fit(tint(`  (${cur + 1}/${items.length})`, chalk.gray)));
  }
  out.push(fit(tint(`  [${footerKeys}]`, chalk.gray)));
  return out;
}
