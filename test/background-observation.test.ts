import { expect, test } from "bun:test";
import { JobRegistry } from "../src/agent/job-registry";
import { createJobTool } from "../src/agent/job-tool";
import { MonitorRegistry } from "../src/agent/monitor-registry";
import { createMonitorTool } from "../src/agent/monitor-tool";

for (const kind of ["job", "monitor"] as const) {
  test(`${kind} tail of another process does not consume an unseen failure`, async () => {
    const registry = kind === "job" ? new JobRegistry() : new MonitorRegistry();
    const tool = kind === "job" ? createJobTool(registry as JobRegistry) : createMonitorTool(registry as MonitorRegistry);
    const failure = kind === "job" ? (registry as JobRegistry).start("exit 7", process.cwd()) : (registry as MonitorRegistry).start("exit 7", process.cwd(), true);
    const other = kind === "job" ? (registry as JobRegistry).start("exit 0", process.cwd()) : (registry as MonitorRegistry).start("exit 0", process.cwd(), true);
    await registry.awaitIds([failure.id, other.id], 3000);
    const tail = await tool({ action: "tail", ids: [other.id] }, process.cwd());
    expect(tail.mutationMayHaveOccurred).toBe(true);
    expect(registry.unobserved().map(record => record.id)).toContain(failure.id);
    const observed = await tool({ action: "await", ids: [failure.id] }, process.cwd());
    expect(observed.mutationMayHaveOccurred).toBe(true);
    expect(registry.unobserved().map(record => record.id)).not.toContain(failure.id);
  });
}

test("default monitor await observes already settled processes exactly once", async () => {
  const registry = new MonitorRegistry();
  const tool = createMonitorTool(registry);
  const monitor = registry.start("exit 7", process.cwd(), true);
  await registry.awaitIds([monitor.id], 3000);
  expect(registry.unobserved().map(record => record.id)).toContain(monitor.id);
  const first = await tool({ action: "await" }, process.cwd());
  expect(first.output).toContain(monitor.id);
  expect(first.mutationMayHaveOccurred).toBe(true);
  expect(registry.unobserved()).toEqual([]);
  const again = await tool({ action: "await" }, process.cwd());
  expect(again.output).not.toContain(monitor.id);
  expect(again.mutationMayHaveOccurred).not.toBe(true);
});
