import { expect, test, describe } from "bun:test";
import { suggestSelfImprovement } from "../src/agent/dev/self-improve";
import * as fs from "node:fs/promises";
import * as path from "node:path";

describe("suggestSelfImprovement", () => {
  test("should skip if not in dev mode", async () => {
    process.env.JOC_DEV_MODE = "0";
    const result = await suggestSelfImprovement();
    expect(result).toBeNull();
  });

  test("should provide suggestion based on performance metrics", async () => {
    process.env.JOC_DEV_MODE = "1";
    const cwd = process.cwd();
    const jocDir = path.join(cwd, ".joc", "state");
    await fs.mkdir(jocDir, { recursive: true });
    
    const perfPath = path.join(jocDir, "performance-metrics.json");
    const mockMetrics = [
      { duration: 100, success: true },
      { duration: 150, success: true }
    ];
    await fs.writeFile(perfPath, JSON.stringify(mockMetrics));

    const result = await suggestSelfImprovement();
    expect(result).toContain("Core engine is stable");
    
    // Clean up
    await fs.unlink(perfPath);
  });
});
