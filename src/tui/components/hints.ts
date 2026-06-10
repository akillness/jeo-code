/**
 * Key-hint bar — a compact, colored row of keybinding/command hints for the TUI
 * (e.g. "^C cancel · Tab complete · /help · /model · /exit"). Keys are
 * highlighted, labels dimmed, the row is clamped to the terminal width, and an
 * ASCII fallback drops fancy separators. Pure functions over a hint list (color
 * via chalk), so they unit-test with an ANSI-stripping helper.
 */
import chalk from "chalk";
import { truncate } from "../terminal";

export interface KeyHint {
  /** The key/command token, e.g. "^C", "Tab", "/help". */
  key: string;
  /** What it does, e.g. "cancel", "complete". */
  label: string;
}

/** The default interactive hint set. */
export const DEFAULT_HINTS: readonly KeyHint[] = [
  { key: "^C", label: "cancel" },
  { key: "Tab", label: "complete" },
  { key: "/help", label: "commands" },
  { key: "/model", label: "switch" },
  { key: "/exit", label: "quit" },
];

export interface HintBarOptions {
  unicode?: boolean;
  color?: boolean;
  /** Clamp the rendered row to this many visible columns. */
  cols?: number;
  /** Indent prefix (default two spaces). */
  indent?: string;
}

/** Render one hint as "<key> <label>" with the key highlighted. */
export function formatHint(hint: KeyHint, color = true): string {
  const key = color ? chalk.cyan.bold(hint.key) : hint.key;
  const label = color ? chalk.gray(hint.label) : hint.label;
  return `${key} ${label}`;
}

/** Render the hint bar; clamps to `cols` and falls back to ASCII separators. */
export function formatHintBar(hints: readonly KeyHint[] = DEFAULT_HINTS, opts: HintBarOptions = {}): string {
  if (hints.length === 0) return "";
  const unicode = opts.unicode !== false;
  const color = opts.color !== false;
  const indent = opts.indent ?? "  ";
  const sepRaw = unicode ? " · " : " | ";
  const sep = color ? chalk.gray(sepRaw) : sepRaw;
  const row = indent + hints.map(h => formatHint(h, color)).join(sep);
  return opts.cols ? truncate(row, opts.cols) : row;
}
