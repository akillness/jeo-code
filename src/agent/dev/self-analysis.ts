import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isDevMode } from "../state";

/**
 * joc-Centric Analysis: joc looks at its own engine.ts
 */
export async function runSelfAnalysis(cwd: string): Promise<string> {
  if (!isDevMode()) throw new Error("Self-analysis only available in Dev Mode");

  const targetPath = path.join(cwd, "src/agent/engine.ts");
  const content = await fs.readFile(targetPath, "utf-8");
  
  const lineCount = content.split("\n").length;
  const hasTooManyResponsibilities = content.includes("runAgentLoop") && content.includes("truncateToolOutput") && content.includes("spillToolResult");

  let report = `Analysis of src/agent/engine.ts:\n`;
  report += `- File length: ${lineCount} lines.\n`;
  if (lineCount > 300) report += `- Issue: The file is becoming monolithic.\n`;
  if (hasTooManyResponsibilities) report += `- Issue: runAgentLoop handles tool output truncation and spilling directly, which should be modularized.\n`;
  
  return report;
}
