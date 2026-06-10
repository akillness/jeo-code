import { expect, test, describe } from "bun:test";
import { monitorRalphImplementation } from "../src/agent/dev/ralph-monitor";
import * as fs from "node:fs/promises";
import * as path from "node:path";

describe("monitorRalphImplementation", () => {
  test("should monitor and log successful implementation", async () => {
    const target = "test-target";
    const simulatedStream = (async function* () {
      yield "Working... ✓\n";
      yield "DONE\n";
    })();

    await monitorRalphImplementation(target, simulatedStream);

    const logPath = path.join(process.cwd(), ".joc", "state", "evolution-log.json");
    const logs = JSON.parse(await fs.readFile(logPath, "utf-8"));
    const entry = logs.find((l: any) => l.target === target);
    
    expect(entry).toBeDefined();
    expect(entry.status).toBe("success");
  });

  test("should detect failure in stream", async () => {
    const target = "fail-target";
    const simulatedStream = (async function* () {
      yield "Working... ✗\n";
      yield "Error: Failed to implementation\n";
    })();

    await monitorRalphImplementation(target, simulatedStream);

    const logPath = path.join(process.cwd(), ".joc", "state", "evolution-log.json");
    const logs = JSON.parse(await fs.readFile(logPath, "utf-8"));
    const entry = logs.find((l: any) => l.target === target);
    
    expect(entry.status).toBe("failed");
  });
});
