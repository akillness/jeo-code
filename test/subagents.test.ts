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

test("subagentSystemPrompt: read-only roles get a no-mutation directive", () => {
  const exec = subagentSystemPrompt(getSubagentRole("executor")!);
  expect(exec).not.toContain("READ-ONLY");
  const arch = subagentSystemPrompt(getSubagentRole("architect")!);
  expect(arch).toContain("READ-ONLY");
  expect(arch).toContain("Do not create or modify files");
});

test("subagentSystemPrompt: read-only roles advertise only non-mutating tools", () => {
  const arch = subagentSystemPrompt(getSubagentRole("architect")!);
  // The restricted protocol must NOT offer write/edit/bash, which subagentToolset removed.
  expect(arch).not.toMatch(/^\s*\d+\.\s*write\b/m);
  expect(arch).not.toMatch(/^\s*\d+\.\s*edit\b/m);
  expect(arch).not.toMatch(/^\s*\d+\.\s*bash\b/m);
  expect(arch).toContain("read");
  expect(arch).toContain("search");
  // The executor (mutating) prompt still advertises write/edit/bash.
  const exec = subagentSystemPrompt(getSubagentRole("executor")!);
  expect(exec).toMatch(/^\s*\d+\.\s*write\b/m);
  expect(exec).toMatch(/^\s*\d+\.\s*bash\b/m);
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
