import { test, expect } from "bun:test";
import {
  SUBAGENT_ROLES,
  getSubagentRole,
  defaultSubagentRole,
  normalizeRoleId,
  resolveSubagentModel,
  resolveSubagentMaxSteps,
  subagentSystemPrompt,
  subagentToolset,
  subagentRoleIds,
  parseMaxSteps,
  withSubagentSetting,
  clearSubagentSetting,
  validateSubagentDoneReason,
} from "../src/agent/subagents";

test("registry exposes the four bundled roles; only executor mutates", () => {
  const ids = SUBAGENT_ROLES.map(r => r.id);
  expect(ids).toEqual(["executor", "planner", "architect", "critic"]);
  expect(getSubagentRole("executor")!.readOnly).toBe(false);
  for (const id of ["planner", "architect", "critic"]) {
    expect(getSubagentRole(id)!.readOnly).toBe(true);
  }
});

test("getSubagentRole is case-insensitive; defaultSubagentRole is executor", () => {
  expect(getSubagentRole("  ARCHITECT ")!.id).toBe("architect");
  expect(getSubagentRole("nope")).toBeUndefined();
  expect(normalizeRoleId(" Planner ")).toBe("planner");
  expect(defaultSubagentRole().id).toBe("executor");
});

test("resolveSubagentModel: per-role override wins, else default model", () => {
  const cfg = { defaultModel: "claude-3-5-sonnet", subagents: { planner: { model: "fast" } } };
  expect(resolveSubagentModel("planner", cfg)).toBe("fast");
  expect(resolveSubagentModel("executor", cfg)).toBe("claude-3-5-sonnet");
  expect(resolveSubagentModel("PLANNER", cfg)).toBe("fast"); // normalized
});

test("resolveSubagentMaxSteps: override → role default → 15 fallback", () => {
  expect(resolveSubagentMaxSteps("executor", {})).toBe(15);
  expect(resolveSubagentMaxSteps("critic", {})).toBe(8);
  expect(resolveSubagentMaxSteps("critic", { subagents: { critic: { maxSteps: 3 } } })).toBe(3);
  expect(resolveSubagentMaxSteps("unknown", {})).toBe(15);
});

test("subagentSystemPrompt: role prompts expose richer contracts", () => {
  const exec = subagentSystemPrompt(getSubagentRole("executor")!);
  expect(exec).toContain("<execution_loop>");
  expect(exec).toContain("Changed Files:");
  expect(exec).toContain("Verification:");

  const planner = subagentSystemPrompt(getSubagentRole("planner")!);
  expect(planner).toContain("File-level Changes:");
  expect(planner).toContain("Acceptance Criteria:");
  expect(planner).toContain("You have these READ-ONLY tools");

  const arch = subagentSystemPrompt(getSubagentRole("architect")!);
  expect(arch).toContain("Architectural Status:");
  expect(arch).toContain("Code Review Recommendation:");
  expect(arch).toContain("CRITICAL");

  const critic = subagentSystemPrompt(getSubagentRole("critic")!);
  expect(critic).toContain("[OKAY]");
  expect(critic).toContain("Required Fixes:");
});

test("subagentToolset: read-only roles drop write/edit/bash, executor keeps them", () => {
  const execTools = Object.keys(subagentToolset(getSubagentRole("executor")!));
  expect(execTools).toContain("write");
  expect(execTools).toContain("edit");
  expect(execTools).toContain("bash");

  const roTools = Object.keys(subagentToolset(getSubagentRole("planner")!));
  expect(roTools).not.toContain("write");
  expect(roTools).not.toContain("edit");
  expect(roTools).not.toContain("bash"); // bash can mutate the repo → excluded for read-only roles
  expect(roTools).toContain("read");
  expect(roTools).toContain("search");
  expect(roTools).toContain("find");
});

test("subagent helpers parse and persist role overrides immutably", () => {
  expect(subagentRoleIds()).toEqual(["executor", "planner", "architect", "critic"]);
  expect(parseMaxSteps(" 12 ")).toBe(12);
  expect(parseMaxSteps("0")).toBeUndefined();
  expect(parseMaxSteps("-2")).toBeUndefined();
  expect(parseMaxSteps("nope")).toBeUndefined();

  const original = { subagents: { planner: { model: "fast", maxSteps: 4 } } };
  const patched = withSubagentSetting(original, " PLANNER ", { maxSteps: 9 });
  expect(patched).toEqual({ planner: { model: "fast", maxSteps: 9 } });
  expect(original.subagents.planner.maxSteps).toBe(4);

  const added = withSubagentSetting(original, "architect", { model: "sonnet" });
  expect(added.architect).toEqual({ model: "sonnet" });
  expect(original.subagents).not.toHaveProperty("architect");

  const cleared = clearSubagentSetting({ subagents: patched }, "planner");
  expect(cleared).toEqual({});
  expect(patched).toHaveProperty("planner");
});

test("validateSubagentDoneReason enforces role-specific done markers", () => {
  const architect = getSubagentRole("architect")!;
  expect(validateSubagentDoneReason(architect, "Summary:\nFindings:\nArchitectural Status: WATCH\nCode Review Recommendation: COMMENT").ok).toBe(true);
  expect(validateSubagentDoneReason(architect, "reviewed").ok).toBe(false);

  const critic = getSubagentRole("critic")!;
  expect(validateSubagentDoneReason(critic, "[REJECT]\nJustification:\nSummary:\nRequired Fixes:").ok).toBe(true);
  expect(validateSubagentDoneReason(critic, "Justification:\nSummary:").ok).toBe(false);
});
