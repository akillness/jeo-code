import { cursorDown, cursorUp, toColumn, clearLine, clearToEnd, size, truncate } from "./terminal";

export type Writer = (s: string) => void;

export interface RendererOptions {
  /** Inline (main-buffer) mode: before painting a frame TALLER than the previous one,
   *  reserve the missing rows with real newlines. Cursor-down can't scroll past the
   *  bottom margin, so without reservation a frame anchored near the bottom of the
   *  viewport would collapse onto its last rows. The newlines DO scroll, pushing prior
   *  content (the progress ledger) up into normal scrollback — which is exactly what
   *  keeps tmux / terminal mouse-wheel history working mid-turn.
   *  Caller invariant: frames must be sliced to the viewport height. A frame taller
   *  than the viewport is NOT reserved (cursor-up would clamp at the top margin and
   *  mis-anchor the repaint), so the diff degrades to in-place painting instead. */
  reserve?: boolean;
}

// DECSET 2026 "synchronized update": the terminal buffers everything between BSU and
// ESU and presents it atomically, so the insertAbove flow (EL-overwrite of the first
// row(s) + full repaint below) never flashes an intermediate half-painted frame.
// Unsupported terminals ignore the
// sequences; supporting ones (incl. tmux ≥3.4) also time the update out (~150ms) if
// ESU never arrives, so a crash mid-update cannot freeze the screen.
const BEGIN_SYNC = "\x1b[?2026h";
const END_SYNC = "\x1b[?2026l";

export class Renderer {
  private write: Writer;
  private cols: () => number;
  private prev: string[] = [];
  private prevCols?: number;
  private prevRows?: number;
  private readonly reserve: boolean;
  // Stale rows left on screen by the previous frame after insertAbove() dropped the
  // baseline; the next render() must EL-clear any of them beyond the new frame.
  private coverRows = 0;
  // True between an insertAbove() (which opens a synchronized update) and the next
  // render()/clear() (which closes it after the repaint is fully written).
  private syncOpen = false;

  constructor(write?: Writer, cols?: () => number, opts?: RendererOptions) {
    this.write = write || ((s: string) => process.stdout.write(s));
    this.cols = cols || (() => size().cols);
    this.reserve = opts?.reserve ?? false;
  }

  render(lines: string[]): void {
    const currentCols = this.cols();
    const currentRows = size().rows;
    if ((this.prevCols !== undefined && this.prevCols !== currentCols) ||
        (this.prevRows !== undefined && this.prevRows !== currentRows)) {
      if (this.reserve) {
        // Inline/reserve mode: a resize needs a full repaint, but NOT an immediate
        // clear() — clear() zeroes coverRows/prev to 0 as an independent write, which
        // then fools the reserve block below (right after this) into believing NOTHING
        // currently occupies the screen (occupied=0) — even though the old frame's rows
        // are still physically there. With occupied wrongly 0, `next.length > occupied`
        // spuriously trips even when the new (post-resize) frame is SHORTER than the
        // old one, inserting real "\n" characters that ACTUALLY SCROLL the terminal —
        // corrupting whatever sits above the live frame and permanently desyncing this
        // renderer's row bookkeeping from reality (every later diff then paints at the
        // wrong absolute row, producing progressively worse duplicate/torn content on
        // each subsequent tick — reproduced deterministically with a standalone
        // Renderer harness before this fix landed). reset() is the same self-heal path
        // the periodic full-resync already uses: it remembers the old occupied rows via
        // coverRows (no output), so the diff loop below EL-clears exactly the excess
        // rows in place — no scroll, no desync.
        this.reset();
      } else {
        // Non-reserve (alt-screen/pipe) mode has no reserve block to fool (gated on
        // `this.reserve`), and the underlying screen buffer's own dimensions just
        // changed — keep the defensive full ED clear.
        this.clear();
      }
    }
    this.prevCols = currentCols;
    this.prevRows = currentRows;

    const next = lines.map(line => truncate(line, currentCols));
    // A terminal can shrink below the number of rows occupied by the prior frame.
    // Rows beyond the new viewport are not addressable: cursor-down stops at the
    // bottom margin and a later cursor-up would then underflow the anchor, leaving
    // every following diff one or more rows out of phase. Limit both the physical
    // occupancy and diff walk to visible rows; the next resize/grow repaints from
    // the bounded baseline at the restored geometry.
    const viewportRows = Math.max(1, currentRows);
    const occupied = Math.min(Math.max(this.prev.length, this.coverRows), viewportRows);
    const maxLen = Math.min(Math.max(this.prev.length, next.length, this.coverRows), viewportRows);
    this.coverRows = 0;
    let cursorRow = 0;
    let out = "";

    if (this.reserve && next.length > occupied && next.length <= Math.max(1, currentRows)) {
      // The cursor rests on the frame's first row (the anchor). Walk to the last
      // currently-occupied row, emit one newline per missing row (scrolling the
      // viewport when at the bottom margin), then hop back up to the — possibly
      // shifted — anchor so the diff below paints at stable relative positions.
      const have = Math.max(occupied, 1);
      out += cursorDown(have - 1) + "\n".repeat(next.length - have) + cursorUp(next.length - 1) + toColumn(1);
    }

    for (let i = 0; i < maxLen; i++) {
      if (i < next.length) {
        if (next[i] !== this.prev[i]) {
          if (i > cursorRow) {
            out += cursorDown(i - cursorRow);
          } else if (i < cursorRow) {
            out += cursorUp(cursorRow - i);
          }
          cursorRow = i;
          out += toColumn(1) + clearLine() + next[i];
        }
      } else {
        if (i > cursorRow) {
          out += cursorDown(i - cursorRow);
        } else if (i < cursorRow) {
          out += cursorUp(cursorRow - i);
        }
        cursorRow = i;
        out += toColumn(1) + clearLine();
      }
    }

    if (cursorRow > 0) {
      out += cursorUp(cursorRow);
    }
    out += toColumn(1);

    // Atomic present (DECSET-2026 synchronized update): wrap the WHOLE repaint so the
    // terminal never shows a half-painted frame — no torn row, no transient duplicate
    // bar a mid-repaint snapshot could catch. An insertAbove() may have already opened
    // the update (syncOpen); otherwise this render opens its own. Exactly one BSU/ESU
    // pair is emitted per write.
    if (out.length > 0) {
      this.write((this.syncOpen ? "" : BEGIN_SYNC) + out + END_SYNC);
      this.syncOpen = false;
    } else if (this.syncOpen) {
      this.write(END_SYNC);
      this.syncOpen = false;
    }

    this.prev = next;
  }

  /** Flush static text into normal scrollback ABOVE the live frame: overwrite the
   *  frame's first row(s) with the text (caller terminates it with "\n") and drop the
   *  differential baseline so the next render() repaints the full frame below the
   *  newly emitted line(s). The follow-up render's row reservation scrolls the text
   *  up into history, where tmux / terminal mouse-wheel can reach it mid-turn.
   *  Erases with per-line EL (\x1b[2K), NEVER clear-to-end: tmux pushes ED-erased
   *  rows into scrollback, so an ED here would flood history with one full frame
   *  copy per flush (the bug this replaced). Rows the new frame doesn't cover are
   *  EL-cleared by the next render() via coverRows.
   *  Opens a DECSET 2026 synchronized update that the next render()/clear() closes,
   *  so the overwrite → flush → repaint triplet never flashes intermediate states.
   *  Inline-mode only by convention — the alt screen has no scrollback to flush into. */
  insertAbove(text: string): void {
    this.syncOpen = true;
    const rows = text.split("\n");
    // Rows the body actually writes (the trailing "" from the final "\n" emits nothing).
    const written = rows.length - (rows[rows.length - 1] === "" ? 1 : 0);
    const body = rows
      .map((line, i, arr) => (i === arr.length - 1 && line === "" ? "" : toColumn(1) + clearLine() + line))
      .join("\n");
    let out = BEGIN_SYNC + body;
    // EL-clear the old frame rows the inserted block did NOT cover, then hop back to the
    // row right below the insert (where the next render() anchors). The terminal may have
    // shrunk since the last render, so never walk farther than its currently visible rows:
    // cursor-down clamps at the bottom margin and an uncapped cursor-up would desync the
    // physical anchor used by every subsequent diff.
    const viewportRows = Math.max(1, size().rows);
    const occupied = Math.min(Math.max(this.prev.length, this.coverRows), viewportRows);
    const stale = occupied - written;
    if (stale > 0) {
      for (let i = 0; i < stale; i++) {
        out += toColumn(1) + clearLine() + (i < stale - 1 ? cursorDown(1) : "");
      }
      out += (stale > 1 ? cursorUp(stale - 1) : "") + toColumn(1);
    }
    this.write(out);
    this.prev = [];
    this.coverRows = 0;
  }

  /** Clear the live frame. Inline (reserve) mode walks the known frame rows with
   *  per-line EL — clear-to-end would make tmux push the erased frame into
   *  scrollback (see insertAbove). Alt-screen/non-TTY renderers keep the cheaper
   *  ED clear: the alt screen has no history and pipes have no screen. */
  clear(): void {
    let out: string;
    if (this.reserve) {
      const viewportRows = Math.max(1, size().rows);
      const rows = Math.min(Math.max(this.prev.length, this.coverRows), viewportRows);
      out = toColumn(1);
      for (let i = 0; i < rows; i++) {
        out += (i > 0 ? cursorDown(1) : "") + toColumn(1) + clearLine();
      }
      if (rows > 1) out += cursorUp(rows - 1) + toColumn(1);
    } else {
      out = toColumn(1) + clearToEnd();
    }
    if (this.syncOpen) {
      out += END_SYNC;
      this.syncOpen = false;
    }
    this.coverRows = 0;
    this.write(out);
    this.prev = [];
  }

  reset(): void {
    // Drop the diff baseline so the next render() repaints every line — but REMEMBER
    // how many rows are physically on screen so that repaint also EL-clears any the
    // new (possibly shorter) frame doesn't cover. Without this, a self-heal reset on a
    // frame that just shrank left stale rows behind (duplicate model bars / orphaned
    // borders — the live-analysis screen corruption).
    this.coverRows = Math.max(this.coverRows, this.prev.length);
    this.prev = [];
    // Close any synchronized update opened by a preceding insertAbove() so a reset()
    // landing between insertAbove() and the next render() cannot strand an open BSU
    // window (which times out ~150ms later and flashes a partial frame).
    if (this.syncOpen) {
      this.write(END_SYNC);
      this.syncOpen = false;
    }
  }
}
