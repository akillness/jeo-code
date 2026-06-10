import chalk from "chalk";
import { categoryBadge, categoryForTool } from "./category-index";

export type ToolStatus = "running" | "ok" | "fail";

interface ToolRow {
  tool: string;
  status: ToolStatus;
}
export interface ToolStats {
  running: number;
  ok: number;
  fail: number;
  total: number;
}


export class ToolList {
  private rows: ToolRow[] = [];
  // Rows trimmed from the front to keep memory + per-frame cost flat on a
  // pathologically long turn. `start()` returns an ABSOLUTE index so `finish()`
  // stays valid across trims (a no-op in normal turns, which stay well under cap).
  private dropped = 0;
  private readonly cap: number;

  constructor(cap = 500) {
    this.cap = Math.max(1, cap);
  }

  start(tool: string): number {
    this.rows.push({ tool, status: "running" });
    const absIndex = this.dropped + this.rows.length - 1;
    if (this.rows.length > this.cap) {
      const drop = this.rows.length - this.cap;
      this.rows.splice(0, drop);
      this.dropped += drop;
    }
    return absIndex;
  }

  finish(index: number, ok: boolean): void {
    const i = index - this.dropped;
    if (i >= 0 && this.rows[i]) {
      this.rows[i].status = ok ? "ok" : "fail";
    }
  }

  render(maxRows?: number, optionsOrColor?: boolean | { color?: boolean; indexed?: boolean }): string[] {
    let color = true;
    let indexed = false;
    if (typeof optionsOrColor === "boolean") {
      color = optionsOrColor;
    } else if (optionsOrColor && typeof optionsOrColor === "object") {
      if (optionsOrColor.color !== undefined) {
        color = optionsOrColor.color;
      }
      indexed = optionsOrColor.indexed === true;
    }

    const rows =
      maxRows !== undefined && maxRows > 0 && this.rows.length > maxRows
        ? this.rows.slice(this.rows.length - (maxRows - 1)) // keep the most recent rows
        : this.rows;
    const hidden = this.dropped + (this.rows.length - rows.length);

    const cyanBullet = color ? chalk.cyan("◓") : "◓";
    const cyanRunning = color ? chalk.cyan.bold("running...") : "running...";
    const greenCheck = color ? chalk.green("✔") : "✔";
    const redCross = color ? chalk.red("✖") : "✖";
    const redFailed = color ? chalk.red.bold("FAILED") : "FAILED";
    const grayLine = (s: string) => color ? chalk.gray(s) : s;

    const lines = rows.map((row, i) => {
      const badge = indexed ? `${categoryBadge(categoryForTool(row.tool), { index: hidden + i + 1, color })} ` : "";
      if (row.status === "running") {
        return `  ${cyanBullet} ${badge}${row.tool} ${cyanRunning}`;
      } else if (row.status === "ok") {
        // Faded decay for completed successful tools
        return `  ${greenCheck} ${badge}${grayLine(row.tool + " ok")}`;
      } else {
        // Bright red for failures
        return `  ${redCross} ${badge}${row.tool} ${redFailed}`;
      }
    });
    if (hidden > 0) {
      lines.unshift(grayLine(`  · (+${hidden} earlier)`));
    }
    return lines;
  }

  currentTool(): string | undefined {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (this.rows[i]!.status === "running") return this.rows[i]!.tool;
    }
    return undefined;
  }

  stats(): ToolStats {
    const stats: ToolStats = { running: 0, ok: 0, fail: 0, total: this.dropped + this.rows.length };
    for (const row of this.rows) stats[row.status]++;
    return stats;
  }

  reset(): void {
    this.rows = [];
    this.dropped = 0;
  }

  /** Immutable snapshot of the tool rows (for the step timeline / summaries). */
  snapshot(): { tool: string; status: ToolStatus }[] {
    return this.rows.map(r => ({ tool: r.tool, status: r.status }));
  }
}
