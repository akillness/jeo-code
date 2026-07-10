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
/** True live geometry via `getWindowSize()` — a real `TIOCGWINSZ` ioctl through libuv,
 *  bypassing `process.stdout.columns`/`.rows` entirely. Node/Bun only refresh THOSE
 *  cached fields when a `'resize'` (SIGWINCH) event fires, which is exactly the signal
 *  {@link watchResize} exists to work around (tmux pane/window switch while jeo's pane
 *  isn't foregrounded, a SIGCONT race after Ctrl-Z, an SSH/multiplexer layer that only
 *  propagates the ioctl update on the next write) — in every one of those, the cached
 *  fields go stale and NOTHING re-freshes them without a real event. Returns `null` when
 *  unavailable (older runtimes, non-TTY streams — Bun/Node only expose `getWindowSize`
 *  on a real `tty.WriteStream`), it throws (handle torn down), or it reports `0,0` (no
 *  controlling terminal ever set a winsize, e.g. a bare pty as `bun test` sees). */
function liveWindowSize(): { cols: number; rows: number } | null {
  const stream = process.stdout as NodeJS.WriteStream & { getWindowSize?: () => [number, number] };
  if (typeof stream.getWindowSize !== "function") return null;
  try {
    const [cols, rows] = stream.getWindowSize();
    return cols > 0 && rows > 0 ? { cols, rows } : null;
  } catch {
    return null;
  }
}

/** Poll-based resize watcher — a SAFETY NET alongside the TTY `'resize'` event.
 *  `'resize'` (SIGWINCH) is missed in several real-world cases jeo actually hits: a
 *  tmux pane/window switch while jeo's pane isn't the foreground one (tmux only
 *  forwards SIGWINCH to the active pane), a SIGCONT race after Ctrl-Z where the resize
 *  happened entirely during the stop, and some SSH/multiplexer layers that only
 *  propagate the ioctl update on the next write rather than emitting a fresh event.
 *  In every one of these, `process.stdout.columns`/`.rows` (and therefore `size()`)
 *  go stale and NOTHING short of a real `'resize'` event ever refreshes them — so a
 *  naive poll comparing `size()` against itself can never observe a change that
 *  already happened, it would just keep comparing one stale cache to itself.
 *
 *  Each tick instead asks the OS DIRECTLY via {@link liveWindowSize} (a cheap,
 *  allocation-free ioctl — safe every `intervalMs`). When that live read disagrees
 *  with the last-seen geometry, this SELF-HEALS the stale cache — writing the
 *  corrected values onto `process.stdout.columns`/`.rows` exactly like Node's own
 *  SIGWINCH handler would — before firing `onChange`, so every other reader of
 *  `size()` (the live-frame `draw()`, `resizeRepaint()`, `idleResizeHandler()`, a
 *  picker's `repaint()`) sees the corrected geometry too, not just this callback.
 *  When `getWindowSize` is unavailable, falls back to comparing `size()` against
 *  itself (the pre-existing behavior) — still catches a genuine cache update that
 *  arrived via some OTHER path (e.g. a real `'resize'` event firing between polls).
 *  Never fires spuriously — only on an actual geometry change — so it composes
 *  safely alongside an existing `'resize'` listener (whichever notices first wins,
 *  the other becomes a no-op once both routes converge on the same geometry).
 *  Returns a `stop()` to clear the interval; the timer is `unref()`d so it can never
 *  keep the process alive on its own. */
export function watchResize(onChange: (cols: number, rows: number) => void, intervalMs = 300): () => void {
  let last = size();
  const timer = setInterval(() => {
    const live = liveWindowSize();
    const cur = live ?? size();
    if (cur.cols !== last.cols || cur.rows !== last.rows) {
      last = cur;
      if (live) {
        try {
          process.stdout.columns = live.cols;
          process.stdout.rows = live.rows;
        } catch { /* non-writable in this environment — onChange still fires below */ }
      }
      onChange(cur.cols, cur.rows);
    }
  }, intervalMs);
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
  return () => clearInterval(timer);
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

/** Undo {@link enableKittyKeyboard} on exit. `CSI > 1 u` PUSHES an entry onto the
 *  terminal's keyboard-mode stack, so the counterpart is a POP (`CSI < u`) — pushing
 *  `>0u` instead would leak our entry and leave flags-0 stacked on top of whatever
 *  the shell/tmux had. Terminals without kitty-protocol support ignore both. */
export function disableKittyKeyboard(): string {
  return `${ESC}<u`;
}
/** Set the terminal's TEXT CURSOR color via OSC 12 (`\x1b]12;#rrggbb\x07`) — widely
 *  supported (xterm, iTerm2, kitty, wezterm, alacritty, ghostty, foot, most tmux/VTE
 *  terminals). jeo's input box parks the REAL terminal cursor at the caret (see
 *  `input-box.ts`'s `cursorRow`/`cursorCol`) rather than drawing a fake one, so the
 *  cursor's on-screen color is entirely up to the terminal's default — usually a
 *  solid white/light block. On every theme except `mono` (whose panels/prompt already
 *  render colorless), that default cursor color visually MATCHES the light card
 *  backgrounds used elsewhere in the UI (e.g. `cardFillPaint`), making the caret
 *  nearly impossible to spot against typed text. Setting it to the theme's accent hue
 *  gives the caret a color that's always distinct from body text and panel fills. */
export function setCursorColor(hex: string): string {
  return `\x1b]12;${hex}\x07`;
}

/** Restore the terminal's default cursor color (OSC 112, no color id) — the
 *  counterpart to {@link setCursorColor}, sent on exit so a shell/editor started
 *  afterward isn't left with jeo's accent-colored cursor. */
export function resetCursorColor(): string {
  return `\x1b]112\x07`;
}
