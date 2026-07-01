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

/** Full reset of the visible screen: erase the screen (2J), erase the scrollback
 *  buffer (3J), and home the cursor (H). This is the gjc-style "fresh start" clear —
 *  use it at launch and for `/clear`, NEVER mid-turn (it would flood tmux scrollback). */
export function clearScreen(): string {
  return `${ESC}2J${ESC}3J${ESC}H`;
}

/** Erase the VISIBLE screen (2J) and home the cursor (H), but PRESERVE the scrollback
 *  buffer (no 3J). This is the readline/shell "Ctrl-L redraw" clear: the on-screen
 *  transcript is wiped and the prompt is repainted from the top, yet scrolling up still
 *  reveals prior output. Use it to RE-ANCHOR a prompt whose in-place footer drifted after
 *  the terminal scrolled — recovering a "typing does not show in the box" state without
 *  destroying history (unlike `clearScreen`, which also drops scrollback). */
export function clearVisible(): string {
  return `${ESC}2J${ESC}H`;
}

export function hideCursor(): string {
  return `${ESC}?25l`;
}

export function showCursor(): string {
  return `${ESC}?25h`;
}

/**
 * Defensively DISABLE every xterm mouse-tracking mode + coordinate encoding.
 * jeo never enables these itself, but a previous program that crashed (or a
 * stale tmux pane) can leave them ON — the terminal then reports clicks/motion
 * as escape sequences from the very first prompt, which reads as "the mouse
 * starts out clicked/held" and sprays `[<0;…M`-style garbage into input.
 * Emitting the `l` (reset) forms is harmless when the modes are already off.
 *   ?9 X10 · ?1000 normal · ?1002 button-motion · ?1003 any-motion
 *   ?1005 UTF-8 · ?1006 SGR · ?1015 urxvt · ?1016 SGR-pixel
 */
export function resetMouseTracking(): string {
  return `${ESC}?9l${ESC}?1000l${ESC}?1002l${ESC}?1003l${ESC}?1005l${ESC}?1006l${ESC}?1015l${ESC}?1016l`;
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
/** Request xterm's `modifyOtherKeys` mode 2 (`CSI > 4 ; 2 m`): the terminal starts
 *  encoding "inert" combos — Shift+Enter among them — as a full `CSI 27;<mod>;<code>~`
 *  sequence instead of sending a byte indistinguishable from plain Enter (or nothing at
 *  all). Without this, jeo's Shift+Enter → newline handling (`SHIFT_ENTER_SEQS` in
 *  `commands/launch/input.ts`) never actually fires on most terminals — the terminal
 *  never emits a sequence to match because nothing asked it to. Terminals that don't
 *  implement the mode (Windows Terminal's legacy conpty path, some minimal emulators)
 *  silently ignore the unrecognized private-mode sequence — safe to send unconditionally. */
export function enableModifyOtherKeys(): string {
  return `${ESC}>4;2m`;
}

/** Restore `modifyOtherKeys` to its default (mode 0 — "no special encoding") on exit,
 *  the counterpart to {@link enableModifyOtherKeys}. */
export function disableModifyOtherKeys(): string {
  return `${ESC}>4;0m`;
}

/** Enable the kitty keyboard protocol's "disambiguate escape codes" flag (bit 1 of
 *  `CSI > flags u`): the modern, more widely supported (kitty, wezterm, foot, contour,
 *  ghostty, iTerm2, and increasingly Windows Terminal) alternative delivery mechanism
 *  for the same Shift+Enter sequence jeo already recognizes (`CSI 13;2u`,
 *  `SHIFT_ENTER_SEQS`). Terminals without kitty-protocol support ignore the private-mode
 *  `u`-suffixed CSI sequence — safe to send unconditionally alongside
 *  {@link enableModifyOtherKeys} so whichever protocol the terminal supports (if either)
 *  makes Shift+Enter distinguishable from plain Enter. */
export function enableKittyKeyboard(): string {
  return `${ESC}>1u`;
}

/** Reset the kitty keyboard protocol flags to 0 (disabled) on exit, the counterpart to
 *  {@link enableKittyKeyboard}. */
export function disableKittyKeyboard(): string {
  return `${ESC}>0u`;
}
