import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface EvolutionEntry {
  timestamp: string;
  target: string;
  request: string;
  status: "success" | "failed" | "in_progress";
  verificationOutput?: string;
  driftScore?: number;
  logFile?: string;
}

export async function logEvolution(entry: EvolutionEntry, cwd: string = process.cwd()) {
  const logPath = path.join(cwd, "logs", "evolution-log.json");
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  
  let logs: EvolutionEntry[] = [];
  try {
    const content = await fs.readFile(logPath, "utf-8");
    logs = JSON.parse(content);
  } catch {}
  
  logs.push(entry);
  await fs.writeFile(logPath, JSON.stringify(logs, null, 2), "utf-8");
}

/**
 * Level 3: Stream implementation logs to a dedicated file for TUI visibility.
 */
export async function streamEvolutionLogs(executionId: string, output: string, cwd: string = process.cwd()) {
  const logDir = path.join(cwd, "logs", "evolution");
  await fs.mkdir(logDir, { recursive: true });
  const logFile = path.join(logDir, `${executionId}.log`);
  await fs.appendFile(logFile, output + "\n", "utf-8");
  return logFile;
}
