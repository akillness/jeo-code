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
  
  logs.push(entry);
  await fs.writeFile(logPath, JSON.stringify(logs, null, 2), "utf-8");
}
