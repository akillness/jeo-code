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
    if (this.prevCols !== undefined && this.prevCols !== currentCols) {
      this.clear();
    }
    this.prevCols = currentCols;

    const next = lines.map(line => truncate(line, currentCols));
    // Rows physically occupied by the prior frame — or recorded by reset() when the
    // baseline was dropped WITHOUT clearing the screen. The diff below EL-clears any
    // of these that the new (possibly shorter) frame does not cover, and the reserve
    // block below uses it so a post-reset repaint does not spuriously re-scroll.
    const occupied = Math.max(this.prev.length, this.coverRows);
    const maxLen = Math.max(this.prev.length, next.length, this.coverRows);
    this.coverRows = 0;
    let cursorRow = 0;
    let out = "";

    if (this.reserve && next.length > occupied && next.length <= Math.max(1, size().rows)) {
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
    // Eagerly EL-clear the old frame rows the inserted block did NOT cover, then hop
    // back to the row right below the insert (where the next render() anchors).
    // The geometry is provably safe HERE: when stale > 0 the body write never hit
    // the bottom margin (the old frame fit on screen and the insert is shorter), so
    // every stale row exists and cursor-down cannot clamp. Deferring this clear to
    // the next render() via coverRows walked PAST the bottom margin, where the
    // clamped cursor-down desynced the row bookkeeping — each subsequent frame then
    // painted one row higher, devouring the flushed scrollback content above (the
    // "truncated card" corruption).
    // Use the same occupancy measure the reserve block uses (max of prev.length and
    // coverRows). A reset() between frames drops prev but records coverRows; ignoring it
    // here left the old frame's lower rows uncleared and the cursor below the true
    // anchor, so the next render's cursorDown crossed the bottom margin and clamped —
    // the persistent off-by-one that duplicated the model bar.
    const occupied = Math.max(this.prev.length, this.coverRows);
    const stale = occupied - written;
    if (stale > 0) {
      for (let i = 0; i < stale; i++) {
        out += toColumn(1) + clearLine() + (i < stale - 1 ? cursorDown(1) : "");
      }
      out += (stale > 1 ? cursorUp(stale - 1) : "") + toColumn(1);
    }
    this.write(out);
    this.prev = [];
    this.coverRows = 0; // consumed: the frame below is now the single source of truth
  }

  /** Clear the live frame. Inline (reserve) mode walks the known frame rows with
   *  per-line EL — clear-to-end would make tmux push the erased frame into
   *  scrollback (see insertAbove). Alt-screen/non-TTY renderers keep the cheaper
   *  ED clear: the alt screen has no history and pipes have no screen. */
  clear(): void {
    let out: string;
    if (this.reserve) {
      const rows = Math.max(this.prev.length, this.coverRows);
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
