import * as fs from "node:fs/promises";
import * as path from "node:path";
import chalk from "chalk";

export async function runStatusCommand(): Promise<void> {
  const cwd = process.cwd();
  const logPath = path.join(cwd, "logs", "evolution-log.json");
  const perfPath = path.join(cwd, ".jeo", "state", "performance-metrics.json");
  const planPath = path.join(cwd, ".specify", "plan.md");
  
  console.log(chalk.bold("\n=== jeo Core Engine Status ==="));
  
  try {
    const planContent = await fs.readFile(planPath, "utf-8");
    const tasks = planContent.match(/- \[[x ]\] .+/g) || [];
    const completedTasks = tasks.filter(t => t.startsWith("- [x]")).length;
    const totalTasks = tasks.length;
    
    if (totalTasks > 0) {
      const percentage = (completedTasks / totalTasks) * 100;
      const barWidth = 30;
      const filledWidth = Math.round((completedTasks / totalTasks) * barWidth);
      const bar = chalk.green("█").repeat(filledWidth) + chalk.gray("░").repeat(barWidth - filledWidth);
      
      console.log(chalk.bold("Overall Project Progress: [" + bar + "] " + percentage.toFixed(1) + "%"));
      console.log(chalk.dim("(" + completedTasks + "/" + totalTasks + " tasks completed from plan.md)\n"));
    }
  } catch (e) {}

  try {
    const content = await fs.readFile(logPath, "utf-8");
    const logs = JSON.parse(content);
    
    if (logs.length === 0) {
      console.log("No evolution history found.");
    } else {
      const activeTask = logs.find((l: any) => l.status === "in_progress");
      if (activeTask) {
        console.log(chalk.yellow.bold("▶ ACTIVE EVOLUTION: ") + chalk.cyan(activeTask.target));
        if (activeTask.stage) {
          console.log(chalk.magenta("  Stage: ") + chalk.bold(activeTask.stage.toUpperCase()));
        }
        console.log(chalk.dim("  Started: " + activeTask.timestamp + "\n"));
      }

      console.log(chalk.bold("Recent Evolution Turns:"));
      const recent = logs.slice(-5).reverse();
      for (const entry of recent) {
        const statusColor = entry.status === "success" ? chalk.green : (entry.status === "failed" ? chalk.red : chalk.yellow);
        const stageLabel = entry.stage ? ` [${entry.stage.toUpperCase()}]` : "";
        console.log("- " + chalk.dim("[" + new Date(entry.timestamp).toLocaleTimeString() + "]") + stageLabel.padEnd(16) + " " + statusColor(entry.status.toUpperCase().padEnd(11)) + " " + chalk.cyan(entry.target));
      }
      console.log("");
    }
  } catch (e) {
    console.log("Status: Idle (No evolution logs)");
  }

  console.log(chalk.bold("=== Engine Performance Metrics ==="));
  try {
    const perfPathAlt = path.join(cwd, "logs", "performance-metrics.json");
    let perfContent = "";
    try {
      perfContent = await fs.readFile(perfPath, "utf-8");
    } catch {
      perfContent = await fs.readFile(perfPathAlt, "utf-8");
    }
    const metrics = JSON.parse(perfContent);
    if (metrics.length > 0) {
      const recent = metrics.slice(-50);
      const avgDuration = recent.reduce((sum: number, m: any) => sum + m.duration, 0) / recent.length;
      const successRate = (recent.filter((m: any) => m.success).length / recent.length) * 100;
      
      console.log("Average Tool Time: " + chalk.magenta(avgDuration.toFixed(0) + "ms"));
      const successColor = successRate > 90 ? chalk.green : chalk.yellow;
      console.log("Tool Success Rate: " + successColor(successRate.toFixed(1) + "%"));
    } else {
      console.log("No performance metrics collected yet.");
    }
  } catch (e) {
    console.log("Performance metrics unavailable.");
  }
  console.log("");
}
