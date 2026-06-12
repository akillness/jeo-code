import { test, expect } from "bun:test";
import {
  SUBAGENT_ROLES,
  rolesFromConfig,
  allSubagentRoles,
  getSubagentRole,
  subagentRoleIds,
  resolveSubagentMaxSteps,
  subagentSystemPrompt,
  subagentToolset,
  applyTargetChoices,
} from "../src/agent/subagents";
import { taskToolProtocolLine } from "../src/agent/task-tool";
import { DEFAULT_TOOLS } from "../src/agent/engine";

const cfg = {
  defaultModel: "claude-haiku-4-5",
  thinkingLevel: undefined as any,
  subagents: {
    // role DECLARATION (description present) — becomes a custom role
    reviewer: { description: "Reviews diffs for style drift.", maxSteps: 6 },
    // bare model pin on an unknown id — NOT a role (typo safety)
    plnner: { model: "gpt-5.3" },
    // bundled-id override — must NOT duplicate the bundled role
    executor: { maxSteps: 25 },
    // mutating custom role with its own prompt template
    fixer: { title: "Fixer", prompt: "You are {{ROLE_TITLE}}.\n{{TOOL_PROTOCOL}}", readOnly: false },
  },
};

test("config-declared roles join the registry; pins and typos do not", () => {
  const customIds = rolesFromConfig(cfg).map(r => r.id);
  expect(customIds).toEqual(["reviewer", "fixer"]);
  expect(allSubagentRoles(cfg)).toHaveLength(SUBAGENT_ROLES.length + 2);
  expect(subagentRoleIds(cfg)).toContain("reviewer");
  expect(subagentRoleIds()).not.toContain("reviewer"); // no config → bundled only
});

test("custom role lookup, defaults, and safety: read-only unless declared", () => {
  const reviewer = getSubagentRole("Reviewer", cfg)!; // case-insensitive
  expect(reviewer.readOnly).toBe(true); // safe default
  expect(reviewer.defaultMaxSteps).toBe(6);
  expect(resolveSubagentMaxSteps("reviewer", cfg)).toBe(6);
  expect(getSubagentRole("reviewer")).toBeUndefined(); // configless lookup stays bundled
  const fixer = getSubagentRole("fixer", cfg)!;
  expect(fixer.readOnly).toBe(false); // explicit opt-in to mutate
});

test("read-only custom role gets a write-free toolset; mutating one keeps edit", () => {
  const reviewerTools = subagentToolset(getSubagentRole("reviewer", cfg)!, DEFAULT_TOOLS);
  expect(Object.keys(reviewerTools)).not.toContain("write");
  expect(Object.keys(reviewerTools)).not.toContain("edit");
  const fixerTools = subagentToolset(getSubagentRole("fixer", cfg)!, DEFAULT_TOOLS);
  expect(Object.keys(fixerTools)).toContain("edit");
});

test("prompt templating: generic template fills role vars; custom prompt is honored", () => {
  const reviewerPrompt = subagentSystemPrompt(getSubagentRole("reviewer", cfg)!);
  expect(reviewerPrompt).toContain("Reviewer subagent: Reviews diffs for style drift.");
  expect(reviewerPrompt).not.toContain("{{"); // every var substituted
  const fixerPrompt = subagentSystemPrompt(getSubagentRole("fixer", cfg)!);
  expect(fixerPrompt.startsWith("You are Fixer.")).toBe(true);
});

test("system surfaces advertise custom roles: protocol line + apply-target picker", () => {
  expect(taskToolProtocolLine(cfg)).toContain("reviewer");
  const choices = applyTargetChoices(cfg).map(c => c.value);
  expect(choices).toContain("reviewer");
  expect(choices).toContain("fixer");
});

test("bundled-id override never forks a duplicate role", () => {
  const ids = allSubagentRoles(cfg).map(r => r.id);
  expect(ids.filter(id => id === "executor")).toHaveLength(1);
  expect(resolveSubagentMaxSteps("executor", cfg)).toBe(25); // pin still applies
});
