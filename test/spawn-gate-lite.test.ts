import { test, expect } from "bun:test";
import { createTaskTool } from "../src/agent/task-tool";
import { TOOL_OUTPUT_MAX, TOOL_SPILL_THRESHOLD, truncateToolOutput } from "../src/agent/engine";

// Spawn-gate lite + env-tunable output budget (plan/gjc-inheritance.md B9/B10).

test("task fan-out beyond the gate is refused without a justification", async () => {
  const tool = createTaskTool({ config: { defaultModel: "test" } as any });
  const tasks = Array.from({ length: 5 }, (_, i) => `task ${i + 1}`);
  const refused = await tool({ role: "planner", tasks }, process.cwd());
  expect(refused.success).toBe(false);
  expect(refused.error).toContain("exceeds the default gate of 4");
  expect(refused.error).toContain('"justification"');
  // Too-short justification is still refused — it must carry actual reasoning.
  const tooShort = await tool({ role: "planner", tasks, justification: "parallel" }, process.cwd());
  expect(tooShort.success).toBe(false);
});

test("output budget constants align and respect the default", () => {
  expect(TOOL_SPILL_THRESHOLD).toBe(TOOL_OUTPUT_MAX);
  expect(TOOL_OUTPUT_MAX).toBeGreaterThanOrEqual(500);
  const long = "x".repeat(TOOL_OUTPUT_MAX + 1000);
  const cut = truncateToolOutput(long);
  expect(cut.length).toBeLessThan(long.length);
  expect(cut).toContain("chars truncated");
});
