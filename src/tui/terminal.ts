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
 * Truncate a line to `cols` *visible* columns. SGR color escapes are copied
 * verbatim and do NOT count toward the width, so a colored line is never cut
 * mid-escape (which would spill raw `\x1b[…` bytes onto the screen). If the line
 * is cut while a color is active, a reset (`\x1b[0m`) is appended so trailing
 * frame content is not tinted by a dangling color.
 */
// Sticky SGR matcher reused across truncate() calls so a heavily color-escaped
// line (e.g. a per-char gradient) is scanned in O(length) without allocating a
// fresh `line.slice(i)` substring at every escape.
const SGR_STICKY = /\x1b\[[0-9;]*m/y;

export function truncate(line: string, cols: number): string {
  const limit = Math.max(0, cols);
  // Fast path: no escapes → plain slice by length.
  if (!line.includes("\x1b")) {
    return line.length <= limit ? line : line.slice(0, limit);
  }
  let out = "";
  let visible = 0;
  let sawEscape = false;
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      SGR_STICKY.lastIndex = i;
      const m = SGR_STICKY.exec(line);
      if (m) {
        out += m[0];
        sawEscape = true;
        i += m[0].length;
        continue;
      }
    }
    if (visible >= limit) break;
    out += line[i];
    visible++;
    i++;
  }
  if (i < line.length && sawEscape && !out.endsWith("\x1b[0m")) {
    out += "\x1b[0m";
  }
  return out;
}
