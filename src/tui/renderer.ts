import { cursorDown, cursorUp, toColumn, clearLine, clearToEnd, size, truncate } from "./terminal";

export type Writer = (s: string) => void;

export interface RendererOptions {
  /** Inline (main-buffer) mode: before painting a frame TALLER than the previous one,
   *  reserve the missing rows with real newlines. Cursor-down can't scroll past the
   *  bottom margin, so without reservation a frame anchored near the bottom of the
   *  viewport would collapse onto its last rows. The newlines DO scroll, pushing prior
   *  content (the progress ledger) up into normal scrollback — which is exactly what
   *  keeps tmux / terminal mouse-wheel history working mid-turn. */
  reserve?: boolean;
}

export class Renderer {
  private write: Writer;
  private cols: () => number;
  private prev: string[] = [];
  private prevCols?: number;
  private readonly reserve: boolean;

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
    const maxLen = Math.max(this.prev.length, next.length);
    let cursorRow = 0;
    let out = "";

    if (this.reserve && next.length > this.prev.length) {
      // The cursor rests on the frame's first row (the anchor). Walk to the last
      // currently-occupied row, emit one newline per missing row (scrolling the
      // viewport when at the bottom margin), then hop back up to the — possibly
      // shifted — anchor so the diff below paints at stable relative positions.
      const have = Math.max(this.prev.length, 1);
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

    if (out.length > 0) {
      this.write(out);
    }

    this.prev = next;
  }

  /** Flush static text into normal scrollback ABOVE the live frame: clear the frame
   *  from its anchor, write the text (caller terminates it with "\n"), and drop the
   *  differential baseline so the next render() repaints the full frame below the
   *  newly emitted line(s). The follow-up render's row reservation scrolls the text
   *  up into history, where tmux / terminal mouse-wheel can reach it mid-turn.
   *  Inline-mode only by convention — the alt screen has no scrollback to flush into. */
  insertAbove(text: string): void {
    this.write(toColumn(1) + clearToEnd() + text);
    this.prev = [];
  }

  clear(): void {
    this.write(toColumn(1) + clearToEnd());
    this.prev = [];
  }

  reset(): void {
    this.prev = [];
  }
}
