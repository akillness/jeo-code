import * as fs from "node:fs/promises";
import * as path from "node:path";
import chalk from "chalk";

export async function runStatusCommand(): Promise<void> {
  const cwd = process.cwd();
  const logPath = path.join(cwd, ".joc", "state", "evolution-log.json");
  const perfPath = path.join(cwd, ".joc", "state", "performance-metrics.json");
  
  console.log(chalk.bold("\n=== joc Core Engine Status ==="));
  
  try {
    const content = await fs.readFile(logPath, "utf-8");
    const logs = JSON.parse(content);
    
    if (logs.length === 0) {
      console.log("No evolution history found.");
    } else {
      console.log("Total Evolution Turns: " + logs.length + "\n");
      const recent = logs.slice(-5);
      for (const entry of recent) {
        const statusColor = entry.status === "success" ? chalk.green : (entry.status === "failed" ? chalk.red : chalk.yellow);
        console.log("[" + entry.timestamp + "] " + chalk.cyan(entry.target));
        console.log("Status: " + statusColor(entry.status.toUpperCase()));
        console.log("Request: " + entry.request.split("\n")[0] + "...");
        console.log("-".repeat(40));
      }
    }
  } catch {
    console.log("Status: Idle (No evolution logs)");
  }

  console.log(chalk.bold("\n=== Engine Performance Metrics ==="));
  try {
    const perfContent = await fs.readFile(perfPath, "utf-8");
    const metrics = JSON.parse(perfContent);
    if (metrics.length > 0) {
      const recent = metrics.slice(-50);
      const avgDuration = recent.reduce((sum, m) => sum + m.duration, 0) / recent.length;
      const successRate = (recent.filter(m => m.success).length / recent.length) * 100;
      
      console.log("Average Tool Time (last " + recent.length + "): " + chalk.magenta(avgDuration.toFixed(0) + "ms"));
      console.log("Tool Success Rate: " + chalk.green(successRate.toFixed(1) + "%"));
    } else {
      console.log("No performance metrics collected yet.");
    }
  } catch {
    console.log("Performance metrics unavailable.");
  }
}
