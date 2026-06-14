import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isDevMode } from "../state";
import type { PerfMetric } from "../output-util";

/**
 * jeo-Centric Analysis: jeo looks at its own performance and engine.
 */
export async function runSelfAnalysis(cwd: string): Promise<string> {
  if (!isDevMode()) throw new Error("Self-analysis only available in Dev Mode");

  const perfPath = path.join(cwd, ".jeo/state/performance-metrics.json");
  let perfData: PerfMetric[] = [];
  try {
    const content = await fs.readFile(perfPath, "utf-8");
    perfData = JSON.parse(content);
  } catch {
    // If no metrics yet, proceed with engine analysis
  }

  const targetPath = path.join(cwd, "src/agent/engine.ts");
  const content = await fs.readFile(targetPath, "utf-8");
  
  const lineCount = content.split("\n").length;
  // Ownership-accurate SRP check: the loop drives steps, while output shaping
  // (truncate/spill) lives in tool-output.ts. Flag only when those are DEFINED
  // here again, not merely imported or re-exported for backward compatibility.
  const definesOutputShaping =
    /\bfunction\s+truncateToolOutput\b/.test(content) && /\bfunction\s+spillToolResult\b/.test(content);
  const hasTooManyResponsibilities = content.includes("runAgentLoop") && definesOutputShaping;

  let report = "Analysis of src/agent/engine.ts:\n";
  report += "- File length: " + lineCount + " lines.\n";
  if (lineCount > 300) report += "- Issue: The file is becoming monolithic.\n";
  if (hasTooManyResponsibilities) report += "- Issue: runAgentLoop handles tool output truncation and spilling directly, which should be modularized.\n";
  
  if (perfData.length > 0) {
    const recent = perfData.slice(-50);
    const avgDuration = recent.reduce((sum, m) => sum + (m as any).duration, 0) / recent.length;
    const failures = recent.filter((m) => !m.success).length;
    
    report += "\nPerformance & Error Analysis (last " + recent.length + " tools):\n";
    report += "- Average tool duration: " + avgDuration.toFixed(2) + "ms\n";
    report += "- Success rate: " + (((recent.length - failures) / recent.length) * 100).toFixed(1) + "%\n";
    
    const slowTools = recent.filter((m) => (m as any).duration > 2000);
    if (slowTools.length > 0) {
      report += "- Notice: " + slowTools.length + " tools took > 2s. Slowest: " + slowTools.sort((a, b) => (b as any).duration - (a as any).duration)[0].tool + "\n";
    }

    const recentErrors = recent.filter(m => !m.success && (m as any).error).map(m => (m as any).error!);
    if (recentErrors.length > 0) {
      report += "- Top Error Patterns:\n";
      const counts: Record<string, number> = {};
      for (const err of recentErrors) {
        const key = err.substring(0, 60);
        counts[key] = (counts[key] || 0) + 1;
      }
      Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .forEach(([err, count]) => {
          report += "  * [" + count + "x] " + err + "...\n";
        });
    }
  }

  return report;
}
