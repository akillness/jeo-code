import { isDevMode } from "../state";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Logic for the agent to analyze its own performance and suggest improvements.
 * This module is only active when isDevMode() is true.
 */
export async function suggestSelfImprovement() {
  if (!isDevMode()) return null;
  
  console.log("[DEV] Analyzing joc for self-improvement...");
  
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
      if (avgDuration > 500) {
        suggestion = "Tool latency is high. Consider optimizing tool-registry.ts or reducing compaction thresholds.";
      } else if (successRate < 90) {
        suggestion = "Tool success rate is declining. Review error handling in src/agent/tools.ts.";
      } else {
        suggestion = "Core engine is stable. Focus on UX enhancements in src/commands/status.ts.";
      }

      await recordEvolutionLog("self-analysis", suggestion);
      return suggestion;
    }
  } catch (e) {
    return "No metrics found to analyze.";
  }
}

async function recordEvolutionLog(target: string, request: string) {
  const logPath = path.join(process.cwd(), ".joc", "state", "evolution-log.json");
  try {
    let logs = [];
    try {
      const data = await fs.readFile(logPath, "utf-8");
      logs = JSON.parse(data);
    } catch {}
    
    logs.push({
      timestamp: new Date().toISOString(),
      target,
      request,
      status: "success"
    });
    
    await fs.writeFile(logPath, JSON.stringify(logs, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to record evolution log:", err);
  }
}
