import { isDevMode } from "../state";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logEvolution } from "./evolution-logger";

/**
 * Logic for the agent to analyze its own performance and suggest improvements.
 * This module is only active when isDevMode() is true.
 */
export async function suggestSelfImprovement() {
  if (!isDevMode()) return null;
  
  console.log("[joc-Core] Analyzing engine performance for self-improvement...");
  
  const cwd = process.cwd();
  const perfPath = path.join(cwd, ".joc", "state", "performance-metrics.json");

  try {
    const perfData = await fs.readFile(perfPath, "utf-8");
    const metrics = JSON.parse(perfData);
    
    if (metrics.length > 0) {
      const recent = metrics.slice(-20);
      const avgDuration = recent.reduce((sum: number, m: any) => sum + m.duration, 0) / recent.length;
      const successRate = (recent.filter((m: any) => m.success).length / recent.length) * 100;
      
      let suggestion = "";
      let target = "self-analysis";
      
      if (avgDuration > 500) {
        suggestion = "Tool latency is high. Consider optimizing tool-registry.ts or reducing compaction thresholds.";
      } else if (successRate < 90) {
        suggestion = "Tool success rate is declining. Review error handling in src/agent/tools.ts.";
      } else {
        suggestion = "Core engine is stable. Focus on UX enhancements in src/commands/status.ts.";
      }

      // Check for specific tool failures
      const failures = recent.filter(m => !m.success);
      if (failures.length > 3) {
        const mostFrequentFailure = failures.reduce((acc, m) => {
          acc[m.tool] = (acc[m.tool] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);
        const topTool = Object.entries(mostFrequentFailure).sort((a, b) => b[1] - a[1])[0][0];
        suggestion = "High failure rate detected in tool: " + topTool + ". Proposing reliability audit.";
        target = "reliability-audit:" + topTool;
      }

      await logEvolution({
        timestamp: new Date().toISOString(),
        target,
        request: suggestion,
        status: "success"
      });
      
      return suggestion;
    }
  } catch (e) {
    return "No metrics found to analyze.";
  }
}
