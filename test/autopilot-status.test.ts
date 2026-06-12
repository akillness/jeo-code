import { test, expect } from "bun:test";
import { renderAutopilotStatusPanel } from "../src/tui/components/autopilot-status";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("renderAutopilotStatusPanel presents score, attempts, and recommendation as a readable field", () => {
  const lines = renderAutopilotStatusPanel({
    task: "raise coverage",
    goal: "max",
    eval: "bun test --coverage",
    baseline: "71",
    best: "82",
    attempts: 4,
    kept: 2,
    reverted: 2,
    sinceImprove: 1,
    converged: false,
    recommendation: "continue",
  }, { cols: 88, color: false, unicode: true }).map(stripAnsi);

  const text = lines.join("\n");
  expect(text).toContain("Autopilot Ratchet CONTINUE");
  expect(text).toContain("task raise coverage");
  expect(text).toContain("eval max · bun test --coverage");
  expect(text).toContain("score 71 → 82");
  expect(text).toContain("attempts 4 · ✓ 2 kept · ↶ 2 reverted · patience 1");
  expect(text).toContain("next continue");
  expect(lines[0]).toMatch(/^─+$/);
  expect(lines.at(-1)).toBe(lines[0]);
});
