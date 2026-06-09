import chalk from "chalk";

export type UiCategory = "progress" | "done" | "diff" | "subagent" | "code" | "file" | "cmd" | "tool" | "error" | "search";

interface CategoryMeta {
  token: string;
  label: string;
  paint: (s: string) => string;
}

const META: Record<UiCategory, CategoryMeta> = {
  progress: { token: "STEP", label: "progress", paint: chalk.cyan.bold },
  done: { token: "DONE", label: "completed", paint: chalk.green.bold },
  diff: { token: "DIFF", label: "diff", paint: chalk.magenta.bold },
  subagent: { token: "AGENT", label: "subagent", paint: chalk.blue.bold },
  code: { token: "CODE", label: "code block", paint: chalk.cyan.bold },
  file: { token: "FILE", label: "file path", paint: chalk.yellow.bold },
  cmd: { token: "CMD", label: "command", paint: chalk.yellow.bold },
  tool: { token: "TOOL", label: "tool", paint: chalk.magenta.bold },
  error: { token: "ERR", label: "error", paint: chalk.red.bold },
  search: { token: "SRCH", label: "search", paint: chalk.green.bold },
};

export function categoryMeta(category: UiCategory): { token: string; label: string } {
  const m = META[category];
  return { token: m.token, label: m.label };
}

export function categoryBadge(category: UiCategory, opts: { index?: number; color?: boolean } = {}): string {
  const m = META[category];
  const n = typeof opts.index === "number" ? `${String(Math.max(1, Math.trunc(opts.index))).padStart(2, "0")}:` : "";
  const raw = `[${n}${m.token}]`;
  return opts.color === false ? raw : m.paint(raw);
}

export function prefixCategory(category: UiCategory, text: string, opts: { index?: number; color?: boolean } = {}): string {
  return `${categoryBadge(category, opts)} ${text}`;
}

export function categoryForTool(tool: string): UiCategory {
  const normalized = (tool || "").toLowerCase();
  if (normalized === "bash") return "cmd";
  if (normalized === "read" || normalized === "write") return "file";
  if (normalized === "edit") return "diff";
  if (normalized === "search" || normalized === "find") return "search";
  if (normalized === "task" || normalized.includes("agent")) return "subagent";
  return "tool";
}
