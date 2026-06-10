import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface EvolutionEntry {
  timestamp: string;
  target: string;
  request: string;
  status: "success" | "failed" | "in_progress";
  verificationOutput?: string;
  driftScore?: number;
}

export async function logEvolution(entry: EvolutionEntry) {
  const logPath = path.join(process.cwd(), ".joc", "state", "evolution-log.json");
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  
  let logs: EvolutionEntry[] = [];
  try {
    const content = await fs.readFile(logPath, "utf-8");
    logs = JSON.parse(content);
  } catch {}
  
  // If entry is in_progress, check if we should replace an existing one for the same target
  if (entry.status === "in_progress") {
    const existingIdx = logs.findIndex(l => l.target === entry.target && l.status === "in_progress");
    if (existingIdx !== -1) {
      logs[existingIdx] = entry;
    } else {
      logs.push(entry);
    }
  } else {
    // If it's success/failed, update the corresponding in_progress entry or just push
    const existingIdx = logs.findIndex(l => l.target === entry.target && l.status === "in_progress");
    if (existingIdx !== -1) {
      logs[existingIdx] = { ...logs[existingIdx], ...entry };
    } else {
      logs.push(entry);
    }
  }

  await fs.writeFile(logPath, JSON.stringify(logs, null, 2), "utf-8");
}
