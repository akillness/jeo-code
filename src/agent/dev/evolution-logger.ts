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
  stage?: "analysis" | "consultation" | "implementation" | "verification";
}

export async function logEvolution(entry: EvolutionEntry, cwd: string = process.cwd()) {
  const logPath = path.join(cwd, "logs", "evolution-log.json");
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  
  let logs: EvolutionEntry[] = [];
  try {
    const content = await fs.readFile(logPath, "utf-8");
    logs = JSON.parse(content);
  } catch {}
  
  const existingIdx = logs.findIndex(l => l.status === "in_progress" && l.target === entry.target);
  if (existingIdx !== -1) {
    logs[existingIdx] = { ...logs[existingIdx], ...entry };
  } else {
    logs.push(entry);
  }
  
  await fs.writeFile(logPath, JSON.stringify(logs, null, 2), "utf-8");
}

export async function streamEvolutionLogs(executionId: string, output: string, cwd: string = process.cwd()) {
  const logDir = path.join(cwd, "logs", "evolution");
  await fs.mkdir(logDir, { recursive: true });
  const logFile = path.join(logDir, `${executionId}.log`);
  await fs.appendFile(logFile, output + "\n", "utf-8");
  return logFile;
}
