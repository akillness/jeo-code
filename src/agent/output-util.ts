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
