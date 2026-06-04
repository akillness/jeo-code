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

export function truncate(line: string, cols: number): string {
  return line.length <= cols ? line : line.slice(0, cols);
}
