/**
 * Streamed-output region. Keeps a BOUNDED ring of completed lines (+ a trailing
 * partial line not yet terminated by "\n") so memory and per-frame render cost
 * stay flat over a long session instead of growing with total output (the old
 * implementation accumulated one ever-growing string and re-split/re-wrapped it
 * every 120ms frame).
 */
import chalk from "chalk";

interface StreamLine {
  text: string;
  isReasoning: boolean;
  isReasoningHeader?: boolean;
}

export class StreamRegion {
  private lines: StreamLine[] = [];
  private partial = "";
  private isCurrentlyReasoning = false;
  private readonly cap: number;

  constructor(cap = 500) {
    this.cap = Math.max(1, cap);
  }

  append(text: string): void {
    const parts = (this.partial + text).split("\n");
    this.partial = parts.pop() ?? "";
    if (parts.length > 0) {
      for (const p of parts) {
        const stripped = p.replace(/\x1b\[[0-9;]*m/g, "").trim();
        if (stripped === "jeo") {
          this.isCurrentlyReasoning = true;
          this.lines.push({ text: p, isReasoning: true, isReasoningHeader: true });
        } else if (this.isCurrentlyReasoning) {
          if (
            stripped.startsWith("user ▸") ||
            stripped.startsWith("user >") ||
            stripped.startsWith("jeo ◂") ||
            stripped.startsWith("jeo <") ||
            stripped.startsWith("✔") ||
            stripped.startsWith("✗") ||
            stripped.startsWith("v ") ||
            stripped.startsWith("x ") ||
            stripped.startsWith("◆") ||
            stripped.startsWith("->")
          ) {
            this.isCurrentlyReasoning = false;
            this.lines.push({ text: p, isReasoning: false });
          } else {
            this.lines.push({ text: p, isReasoning: true });
          }
        } else {
          this.lines.push({ text: p, isReasoning: false });
        }
      }
      // Trim from the front so the ring never exceeds `cap` completed lines.
      if (this.lines.length > this.cap) this.lines.splice(0, this.lines.length - this.cap);
    }
  }

  render(width: number, maxLines?: number, opts: { unicode?: boolean; color?: boolean } = {}): string[] {
    const all = this.partial
      ? [...this.lines, { text: this.partial, isReasoning: this.isCurrentlyReasoning }]
      : this.lines;
    if (all.length === 0) return [];

    const cols = Math.max(5, width);
    const unicode = opts.unicode !== false;
    const color = opts.color !== false && chalk.level > 0;
    const dim = color ? chalk.dim : (s: string) => s;

    const boxTL = unicode ? "┌" : "+";
    const boxBL = unicode ? "└" : "+";
    const boxV = unicode ? "│" : "|";
    const boxH = unicode ? "─" : "-";

    const result: string[] = [];
    let inReasoningBlock = false;

    for (const segment of all) {
      if (segment.isReasoning) {
        if (!inReasoningBlock) {
          const label = " thinking ";
          const barW = cols - 1 - label.length;
          const bar = boxTL + boxH.repeat(2) + label + boxH.repeat(Math.max(0, barW - 2));
          result.push(dim(bar));
          inReasoningBlock = true;
        }

        if (segment.isReasoningHeader) {
          continue;
        }

        const text = segment.text;
        if (text === "") {
          result.push(dim(`${boxV} `));
        } else {
          const contentWidth = cols - 2;
          for (let i = 0; i < text.length; i += contentWidth) {
            const chunk = text.slice(i, i + contentWidth);
            result.push(dim(`${boxV} ${chunk}`));
          }
        }
      } else {
        if (inReasoningBlock) {
          const bar = boxBL + boxH.repeat(cols - 1);
          result.push(dim(bar));
          inReasoningBlock = false;
        }

        const text = segment.text;
        if (text === "") {
          result.push("");
        } else {
          for (let i = 0; i < text.length; i += cols) {
            result.push(text.slice(i, i + cols));
          }
        }
      }
    }

    if (inReasoningBlock) {
      const bar = boxBL + boxH.repeat(cols - 1);
      result.push(dim(bar));
    }

    if (maxLines !== undefined && maxLines > 0 && result.length > maxLines) {
      return result.slice(result.length - maxLines);
    }
    return result;
  }

  clear(): void {
    this.lines = [];
    this.partial = "";
    this.isCurrentlyReasoning = false;
  }
}
