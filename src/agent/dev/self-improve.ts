import { isDevMode } from "../state";
import { runSelfAnalysis } from "./self-analysis";
import { logEvolution } from "./evolution-logger";

/**
 * Logic for the agent to analyze its own performance and suggest improvements.
 * This module is only active when isDevMode() is true.
 */
export async function suggestSelfImprovement(cwd: string) {
  if (!isDevMode()) return null;
  
  console.log("[DEV] Analyzing joc for self-improvement...");
  const report = await runSelfAnalysis(cwd);
  
  await logEvolution({
    timestamp: new Date().toISOString(),
    target: "Self-Improvement Audit",
    request: "Autonomous performance and architectural audit",
    status: "success",
    verificationOutput: report
  });
  
  return report;
}
