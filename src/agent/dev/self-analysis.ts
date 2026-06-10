import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isDevMode } from "../state";

/**
 * joc-Centric Analysis: joc looks at its own performance and engine.
 */
export async function runSelfAnalysis(cwd: string): Promise<string> {
  if (!isDevMode()) throw new Error("Self-analysis only available in Dev Mode");

  const perfPath = path.join(cwd, ".joc/state/performance-metrics.json");
  let perfData = [];
  try {
    const content = await fs.readFile(perfPath, "utf-8");
    perfData = JSON.parse(content);
  } catch {
    // If no metrics yet, proceed with engine analysis
  }

  const targetPath = path.join(cwd, "src/agent/engine.ts");
  const content = await fs.readFile(targetPath, "utf-8");
  
  const lineCount = content.split("\n").length;
  const hasTooManyResponsibilities = content.includes("runAgentLoop") && content.includes("truncateToolOutput") && content.includes("spillToolResult");

  let report = "Analysis of src/agent/engine.ts:\n";
  report += "- File length: " + lineCount + " lines.\n";
  if (lineCount > 300) report += "- Issue: The file is becoming monolithic.\n";
  if (hasTooManyResponsibilities) report += "- Issue: runAgentLoop handles tool output truncation and spilling directly, which should be modularized.\n";
  
  if (perfData.length > 0) {
    const recent = perfData.slice(-20);
    const avgDuration = recent.reduce((sum, m) => sum + m.duration, 0) / recent.length;
    const failures = recent.filter((m) => !m.success).length;
    
    report += "\nPerformance Analysis (last " + recent.length + " tools):\n";
    report += "- Average tool duration: " + avgDuration.toFixed(2) + "ms\n";
    report += "- Success rate: " + (((recent.length - failures) / recent.length) * 100).toFixed(1) + "%\n";
    
    const slowTools = recent.filter((m) => m.duration > 2000);
    if (slowTools.length > 0) {
      report += "- Notice: " + slowTools.length + " tools took > 2s. Slowest: " + slowTools.sort((a, b) => b.duration - a.duration)[0].tool + "\n";
    }
  }

  return report;
}
