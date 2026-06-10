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
    
    // Verify log entry
    const logPath = path.join(jocDir, "evolution-log.json");
    const logs = JSON.parse(await fs.readFile(logPath, "utf-8"));
    expect(logs.some((l: any) => l.target === "self-analysis")).toBe(true);

    // Clean up
    await fs.unlink(perfPath);
  });

  test("should detect high failure rate for specific tool", async () => {
    process.env.JOC_DEV_MODE = "1";
    const cwd = process.cwd();
    const jocDir = path.join(cwd, ".joc", "state");
    await fs.mkdir(jocDir, { recursive: true });
    
    const perfPath = path.join(jocDir, "performance-metrics.json");
    const mockMetrics = Array(10).fill({ tool: "broken-tool", duration: 50, success: false });
    await fs.writeFile(perfPath, JSON.stringify(mockMetrics));

    const result = await suggestSelfImprovement();
    expect(result).toContain("High failure rate detected in tool: broken-tool");

    // Clean up
    await fs.unlink(perfPath);
  });
});
