import { cursorDown, cursorUp, toColumn, clearLine, clearToEnd, size, truncate } from "./terminal";

export type Writer = (s: string) => void;

export class Renderer {
  private write: Writer;
  private cols: () => number;
  private prev: string[] = [];

  constructor(write?: Writer, cols?: () => number) {
    this.write = write || ((s: string) => process.stdout.write(s));
    this.cols = cols || (() => size().cols);
  }

  render(lines: string[]): void {
    const currentCols = this.cols();
    const next = lines.map(line => truncate(line, currentCols));
    const maxLen = Math.max(this.prev.length, next.length);
    let cursorRow = 0;
    let out = "";

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

  clear(): void {
    this.write(toColumn(1) + clearToEnd());
    this.prev = [];
  }

  reset(): void {
    this.prev = [];
  }
}
