export type ToolStatus = "running" | "ok" | "fail";

interface ToolRow {
  tool: string;
  status: ToolStatus;
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

  render(): string[] {
    return this.rows.map(row => {
      const label = row.status === "running" ? "running" : row.status === "ok" ? "ok" : "FAILED";
      return `  · ${row.tool} ${label}`;
    });
  }

  reset(): void {
    this.rows = [];
  }
}
