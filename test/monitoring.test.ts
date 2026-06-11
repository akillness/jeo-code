import { test, expect } from "bun:test";
import { renderMonitorView } from "../src/tui/monitoring/hud-view";
import { stripAnsi } from "../src/tui/components/color";

test("renderMonitorView: correctly combines HUD, Evolution, and Analysis", () => {
  const state = {
    phase: "executing" as any,
    step: 5,
    maxSteps: 20,
    tickCount: 0,
    analysisReport: "- File length: 450 lines.\n- Issue: monolithic."
  };
  
  const view = stripAnsi(renderMonitorView(state));
  expect(view).toContain("ooo ralph Sovereign Monitoring HUD");
  expect(view).toContain("PHASE:");
  expect(view).toContain("executing"); // Phase
  expect(view).toContain("EVO  :");
  expect(view).toContain("Double Helix"); // Evolution stage for 5/20
  expect(view).toContain("- File length: 450 lines.");
  expect(view).toContain("- Issue: monolithic.");
});
