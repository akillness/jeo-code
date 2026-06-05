import chalk from "chalk";

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

  render(maxRows?: number): string[] {
    const rows =
      maxRows !== undefined && maxRows > 0 && this.rows.length > maxRows
        ? this.rows.slice(this.rows.length - (maxRows - 1)) // keep the most recent rows
        : this.rows;
    const hidden = this.rows.length - rows.length;
    const lines = rows.map(row => {
      if (row.status === "running") {
        return `  ${chalk.yellow("·")} ${row.tool} ${chalk.yellow.bold("running...")}`;
      } else if (row.status === "ok") {
        // Faded decay for completed successful tools
        return chalk.gray(`  · ${row.tool} ok`);
      } else {
        // Bright red for failures
        return `  ${chalk.red("·")} ${row.tool} ${chalk.red.bold("FAILED")}`;
      }
    });
    if (hidden > 0) {
      lines.unshift(chalk.gray(`  · (+${hidden} earlier)`));
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
}
