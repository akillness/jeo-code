/**
 * Streamed-output region. Keeps a BOUNDED ring of completed lines (+ a trailing
 * partial line not yet terminated by "\n") so memory and per-frame render cost
 * stay flat over a long session instead of growing with total output (the old
 * implementation accumulated one ever-growing string and re-split/re-wrapped it
 * every 120ms frame).
 */
export class StreamRegion {
  private lines: string[] = [];
  private partial = "";
  private readonly cap: number;

  constructor(cap = 500) {
    this.cap = Math.max(1, cap);
  }

  append(text: string): void {
    const parts = (this.partial + text).split("\n");
    this.partial = parts.pop() ?? "";
    if (parts.length > 0) {
      for (const p of parts) this.lines.push(p);
      // Trim from the front so the ring never exceeds `cap` completed lines.
      if (this.lines.length > this.cap) this.lines.splice(0, this.lines.length - this.cap);
    }
  }

  render(width: number, maxLines?: number): string[] {
    const all = this.partial ? [...this.lines, this.partial] : this.lines;
    if (all.length === 0) return [];

    const cols = Math.max(1, width);
    const result: string[] = [];
    for (const segment of all) {
      if (segment === "") {
        result.push("");
      } else {
        for (let i = 0; i < segment.length; i += cols) {
          result.push(segment.slice(i, i + cols));
        }
      }
    }

    if (maxLines !== undefined && maxLines > 0 && result.length > maxLines) {
      return result.slice(result.length - maxLines);
    }
    return result;
  }

  clear(): void {
    this.lines = [];
    this.partial = "";
  }
}
