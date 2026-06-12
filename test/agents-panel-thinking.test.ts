import { test, expect } from "bun:test";
import { formatAgentsPanel, formatAgentDetail } from "../src/tui/components/config-panel";
import { SUBAGENT_ROLES, getSubagentRole } from "../src/agent/subagents";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("agents panel shows per-role thinking: explicit level or (inherit)", () => {
  const lines = formatAgentsPanel(SUBAGENT_ROLES, r => ({
    model: "m1",
    maxSteps: 20,
    thinking: r.id === "architect" ? "xhigh" : undefined,
  })).map(stripAnsi);
  const architect = lines.find(l => l.includes("architect"))!;
  expect(architect).toContain("(xhigh)");
  const executor = lines.find(l => l.includes("executor"))!;
  expect(executor).toContain("(inherit)");
  expect(executor).toContain("≤20 steps");
});

test("agent detail block includes the thinking row (inherit explained)", () => {
  const role = getSubagentRole("planner")!;
  const detail = formatAgentDetail(role, { model: "m1", maxSteps: 12 }).map(stripAnsi).join("\n");
  expect(detail).toContain("thinking:  inherit (follows the default thinking level)");
  const pinned = formatAgentDetail(role, { model: "m1", maxSteps: 12, thinking: "high" }).map(stripAnsi).join("\n");
  expect(pinned).toContain("thinking:  high");
});
