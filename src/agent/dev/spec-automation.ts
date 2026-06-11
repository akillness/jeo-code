import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logEvolution } from "./evolution-logger";

/**
 * Level 3: Specification Automation
 * Syncs .specify/ artifacts to ooo seeds.
 */
export async function syncSpecificationToSeed(cwd: string) {
  const specPath = path.join(cwd, ".specify", "specification.md");
  const seedPath = path.join(cwd, ".ouroboros", "seeds", "generated-seed.yaml");
  
  console.log("[jeo-Core] Syncing specification to ooo seed...");
  
  try {
    const spec = await fs.readFile(specPath, "utf-8");
    
    // Simple extraction logic for demo/Phase 3
    const goalsMatch = spec.match(/## Purpose\n([\s\S]+?)\n\n/);
    const goals = goalsMatch ? goalsMatch[1].trim() : "Autonomous Evolution";
    const reqsMatch = spec.match(/## Requirements\n([\s\S]+?)\n\n/);
    const reqs = reqsMatch ? reqsMatch[1].split("\n").map(l => l.replace(/^[*-]\d+./, "").trim()).filter(Boolean) : [];

    const seedContent = `
goal: "${goals.replace(/"/g, '\\\\\\\\"')}"
constraints:
  - "Bun runtime"
  - "Zero native dependencies"
acceptance_criteria:
${reqs.map(r => `  - "${r.replace(/"/g, '\\\\\\\\"')}"`).join("\n")}
  - "Mechanical verification (tests) must pass"
`;

    await fs.mkdir(path.dirname(seedPath), { recursive: true });
    await fs.writeFile(seedPath, seedContent.trim(), "utf-8");
    
    await logEvolution({
      timestamp: new Date().toISOString(),
      target: ".ouroboros/seeds/generated-seed.yaml",
      request: "Automated seed generation from .specify/specification.md",
      status: "success"
    });
    
    console.log("[jeo-Core] Successfully generated seed.");
  } catch (err: any) {
    console.error(`[jeo-Core] Failed to sync specification: ${err.message}`);
    throw err;
  }
}
