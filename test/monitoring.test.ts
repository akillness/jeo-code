import { test, expect } from "bun:test";
import { renderMonitorView } from "../src/tui/monitoring/hud-view";
import chalk from "chalk";

test("renderMonitorView: correctly combines HUD, Evolution, and Analysis", () => {
  const state = {
    phase: "executing" as const,
    step: 5,
    maxSteps: 20,
    analysisReport: "- File length: 450 lines.\n- Issue: monolithic."
  };
  
  const view = renderMonitorView(state);
  expect(view).toContain("=== joc Sovereign Monitoring HUD ===");
  expect(view).toContain("executing"); // Phase
  expect(view).toContain("Tool User"); // Evolution stage for 5/20 (0.25 -> stage 1)
  expect(view).toContain("--- Self-Analysis Report ---");
  expect(view).toContain("monolithic");
});
