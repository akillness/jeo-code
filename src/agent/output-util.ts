import * as fs from "node:fs/promises";
import * as path from "node:path";

export const TOOL_SPILL_THRESHOLD = 32_000;

export function truncateToolOutput(output: string, limit = 8000): string {
  if (output.length <= limit) return output;
  const half = Math.floor(limit / 2);
  return output.slice(0, half) + `\n\n... (elided ${output.length - limit} chars) ...\n\n` + output.slice(-half);
}

export async function spillToolResult(tool: string, output: string, cwd: string): Promise<string> {
  const artifactsDir = path.join(cwd, ".joc", "artifacts");
  await fs.mkdir(artifactsDir, { recursive: true });
  
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `result-${tool}-${ts}.txt`;
  const fullPath = path.join(artifactsDir, filename);
  
  await fs.writeFile(fullPath, output, "utf-8");
  return path.relative(cwd, fullPath);
}

export async function loadSpecKitContext(cwd: string): Promise<string | null> {
  const constitutionPath = path.join(cwd, ".specify", "constitution.md");
  try {
    const content = await fs.readFile(constitutionPath, "utf-8");
    return "

=== Project Constitution ===
" + content + "
===========================
";
  } catch {
    return null;
  }
}

export function logPerformanceMetric(tool: string, duration: number, success: boolean, cwd: string): void {
  const perfPath = path.join(cwd, ".joc", "state", "performance-metrics.json");
  // Implementation omitted for brevity in this patch, but would append to JSON
}
