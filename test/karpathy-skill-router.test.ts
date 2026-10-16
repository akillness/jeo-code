import { test, expect } from "bun:test";
import { SKILLS, getSkill } from "../src/skills/catalog";
import { KARPATHY_DISCIPLINE, executorSystemPrompt } from "../src/agent/engine";
import { routeSkillsForTask, inventorySkillConflicts, SKILL_ROUTE_GATE } from "../src/agent/skill-router";

test("karpathy-guidelines is a registered bundled skill", () => {
  const names = SKILLS.map(s => s.name);
  expect(names).toContain("karpathy-guidelines");
  const skill = getSkill("karpathy-guidelines")!;
  expect(skill.summary.length).toBeGreaterThan(10);
  expect(skill.raw ?? skill.details).toContain("Think Before Coding");
  expect(skill.raw ?? skill.details).toContain("Surgical Changes");
  expect(skill.raw ?? skill.details).toContain("Goal-Driven Execution");
});

test("KARPATHY_DISCIPLINE covers all four Karpathy principles", () => {
  for (const needle of ["Think before coding", "Simplicity first", "Surgical changes", "Goal-driven execution"]) {
    expect(KARPATHY_DISCIPLINE).toContain(needle);
  }
  expect(executorSystemPrompt()).toContain(KARPATHY_DISCIPLINE);
});

test("route-skills: explicit workflow mention routes to that skill", () => {
  const sel = routeSkillsForTask("run ralplan to plan the auth refactor", SKILLS);
  expect(sel.reason).toBe("ok");
  expect(sel.topK[0]!.name).toBe("ralplan");
  expect(sel.topK[0]!.score).toBeGreaterThanOrEqual(SKILL_ROUTE_GATE);
});

test("route-skills: empty task is explicit none (gate), never throws", () => {
  const sel = routeSkillsForTask("   ", SKILLS);
  expect(sel.topK).toEqual([]);
  expect(sel.reason).toBe("gate");
});

test("route-skills: unrelated chit-chat stays below gate", () => {
  const sel = routeSkillsForTask("hello there, how are you today", SKILLS);
  expect(sel.topK).toEqual([]);
  expect(sel.reason).toBe("gate");
});

test("route-skills: strategy is sharded for the bundled catalog, shortlist for huge catalogs", () => {
  const small = routeSkillsForTask("fix the bug", SKILLS);
  expect(small.strategy).toBe("sharded");
  const huge = Array.from({ length: 60 }, (_, i) => ({
    name: `skill-${i}`,
    command: `/skill skill-${i}`,
    summary: `test skill ${i}`,
    whenToUse: "",
    details: `unrelated filler vocabulary ${i}`,
  }));
  const big = routeSkillsForTask("fix the bug", huge);
  expect(big.strategy).toBe("shortlist");
});

test("inventory: duplicate normalized names from distinct paths conflict", () => {
  const conflicts = inventorySkillConflicts([
    { name: "Team", command: "", summary: "", whenToUse: "", details: "", sourcePath: "/a/SKILL.md" },
    { name: "team", command: "", summary: "", whenToUse: "", details: "", sourcePath: "/b/SKILL.md" },
    { name: "team", command: "", summary: "", whenToUse: "", details: "", sourcePath: "/b/SKILL.md" },
  ]);
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]!.normalized).toBe("team");
});

test("inventory: bundled catalog has no conflicts", () => {
  expect(inventorySkillConflicts(SKILLS)).toEqual([]);
});
