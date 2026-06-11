import { truncateToWidth } from "./components/width";

export const ESC = "\x1b[";

export function cursorUp(n: number): string {
  return n > 0 ? `${ESC}${n}A` : "";
}

export function cursorDown(n: number): string {
  return n > 0 ? `${ESC}${n}B` : "";
}

export function toColumn(col: number): string {
  return `${ESC}${col}G`;
}

export function clearLine(): string {
  return `${ESC}2K`;
}

export function clearToEnd(): string {
  return `${ESC}0J`;
}

export function hideCursor(): string {
  return `${ESC}?25l`;
}

export function showCursor(): string {
  return `${ESC}?25h`;
}

/** Enter the alternate screen buffer (xterm `?1049h`): a separate, scrollback-free
 *  screen. Used for the transient live-turn UI so terminal scroll (mouse wheel) can't
 *  fight the in-place repaint — and the main buffer / scrollback is left untouched.
 *  Also disables "alternate scroll" (`?1007l`): with it on, terminals (and tmux)
 *  translate mouse-wheel motion in the alt screen into Up/Down arrow key sequences,
 *  which would otherwise leak into readline's buffer and corrupt the next prompt. */
export function enterAltScreen(): string {
  return `${ESC}?1049h${ESC}?1007l`;
}

/** Leave the alternate screen buffer (`?1049l`), restoring the main buffer + scrollback.
 *  Re-enables alternate scroll (`?1007h`, the common terminal default) so other
 *  full-screen apps (vim/less) keep their wheel behavior after jeo exits the turn. */
export function leaveAltScreen(): string {
  return `${ESC}?1007h${ESC}?1049l`;
}

export function size(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };
}

export function isTTY(): boolean {
  return !!process.stdout.isTTY;
}

/**
 * Truncate a line to `cols` *visible* DISPLAY columns. Delegates to the
 * width-aware `truncateToWidth` (consensus-seed P2.B9): SGR escapes are copied
 * verbatim (counted 0), CJK/emoji glyphs count 2 so a wide-char line no longer
 * overflows the terminal width, tabs advance to the next stop, and a reset is
 * appended if the cut lands mid-color. The plain-ASCII fast path is preserved
 * inside `truncateToWidth`, so hot-path render cost is unchanged for ASCII frames.
 */
export function truncate(line: string, cols: number): string {
  return truncateToWidth(line, cols);
}
