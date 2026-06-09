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

  start(tool: string): number {
    this.rows.push({ tool, status: "running" });
    return this.rows.length - 1;
  }

  finish(index: number, ok: boolean): void {
    if (this.rows[index]) {
      this.rows[index].status = ok ? "ok" : "fail";
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
    const hidden = this.rows.length - rows.length;

    const yellowDot = color ? chalk.yellow("·") : "·";
    const yellowRunning = color ? chalk.yellow.bold("running...") : "running...";
    const redDot = color ? chalk.red("·") : "·";
    const redFailed = color ? chalk.red.bold("FAILED") : "FAILED";
    const grayLine = (s: string) => color ? chalk.gray(s) : s;

    const lines = rows.map((row, i) => {
      const badge = indexed ? `${categoryBadge(categoryForTool(row.tool), { index: hidden + i + 1, color })} ` : "";
      if (row.status === "running") {
        return `  ${yellowDot} ${badge}${row.tool} ${yellowRunning}`;
      } else if (row.status === "ok") {
        // Faded decay for completed successful tools
        return grayLine(`  · ${badge}${row.tool} ok`);
      } else {
        // Bright red for failures
        return `  ${redDot} ${badge}${row.tool} ${redFailed}`;
      }
    });
    if (hidden > 0) {
      lines.unshift(grayLine(`  · (+${hidden} earlier)`));
    }
    return lines;
  }

  currentTool(): string | undefined {
    return [...this.rows].reverse().find(row => row.status === "running")?.tool;
  }

  stats(): ToolStats {
    const stats: ToolStats = { running: 0, ok: 0, fail: 0, total: this.rows.length };
    for (const row of this.rows) stats[row.status]++;
    return stats;
  }

  reset(): void {
    this.rows = [];
  }

  /** Immutable snapshot of the tool rows (for the step timeline / summaries). */
  snapshot(): { tool: string; status: ToolStatus }[] {
    return this.rows.map(r => ({ tool: r.tool, status: r.status }));
  }
}
