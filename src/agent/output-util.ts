import * as fs from "node:fs/promises";
import * as path from "node:path";

export const TOOL_SPILL_THRESHOLD = 32_000;

export function truncateToolOutput(output: string, limit = 8000): string {
  if (output.length <= limit) return output;
  const half = Math.floor(limit / 2);
  return output.slice(0, half) + "\n\n... (elided " + (output.length - limit) + " chars) ...\n\n" + output.slice(-half);
}

export async function spillToolResult(tool: string, output: string, cwd: string): Promise<string> {
  const artifactsDir = path.join(cwd, ".joc", "artifacts");
  await fs.mkdir(artifactsDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = "result-" + tool + "-" + ts + ".txt";
  const fullPath = path.join(artifactsDir, filename);

  await fs.writeFile(fullPath, output, "utf-8");
  return path.relative(cwd, fullPath);
}

/** One tool execution's performance record (consumed by dev self-analysis). */
export interface PerfMetric {
  tool: string;
  duration: number;
  success: boolean;
  error?: string;
}

/** Append a tool performance metric to `.joc/state/performance-metrics.json`
 *  (bounded to the most recent 200 records). Best-effort: failures are ignored
 *  so metrics can never break an agent turn. */
export async function logPerformanceMetric(cwd: string, metric: PerfMetric): Promise<void> {
  try {
    const dir = path.join(cwd, ".joc", "state");
    const file = path.join(dir, "performance-metrics.json");
    await fs.mkdir(dir, { recursive: true });
    let records: PerfMetric[] = [];
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf-8"));
      if (Array.isArray(parsed)) records = parsed;
    } catch { /* first write or corrupt file → start fresh */ }
    records.push(metric);
    if (records.length > 200) records = records.slice(-200);
    await fs.writeFile(file, JSON.stringify(records), "utf-8");
  } catch { /* best-effort */ }
}

/** Read spec-kit project context (`.specify/memory/constitution.md`) when the repo
 *  was initialized with GitHub spec-kit, so the agent honors the project
 *  constitution. Returns null when absent/unreadable; content is capped. */
export async function loadSpecKitContext(cwd: string): Promise<string | null> {
  try {
    const file = path.join(cwd, ".specify", "memory", "constitution.md");
    const content = (await fs.readFile(file, "utf-8")).trim();
    if (!content) return null;
    const capped = content.length > 4000 ? content.slice(0, 4000) + "…" : content;
    return "\n\n<spec-kit-constitution>\n" + capped + "\n</spec-kit-constitution>";
  } catch {
    return null;
  }
}
