import { test, expect } from "bun:test";
import {
  getSkill,
  skillNames,
  formatSkill,
  skillsPromptSection
} from "../src/skills/catalog";

test("skillNames returns all five skills", () => {
  const names = skillNames();
  expect(names.length).toBe(5);
  expect(names).toContain("launch");
  expect(names).toContain("deep-interview");
  expect(names).toContain("ralplan");
  expect(names).toContain("team");
  expect(names).toContain("ultragoal");
});

test("getSkill case-insensitive lookup", () => {
  const skill = getSkill("DEEP-INTERVIEW");
  expect(skill).toBeDefined();
  expect(skill?.name).toBe("deep-interview");
  expect(skill?.command).toBe('joc deep-interview "<idea>"');
});

test("getSkill returns undefined for non-existent skill", () => {
  expect(getSkill("nope")).toBeUndefined();
  expect(getSkill("")).toBeUndefined();
});

test("formatSkill output format", () => {
  const skill = getSkill("ralplan");
  expect(skill).toBeDefined();
  if (skill) {
    const formatted = formatSkill(skill);
    expect(formatted).toContain("joc ralplan");
    expect(formatted).toContain("Planner/Architect/Critic blueprint from the seed.");
    expect(formatted).toContain("When to use:");
    expect(formatted).toContain("Details:");
  }
});

test("skillsPromptSection contains every skill name", () => {
  const section = skillsPromptSection();
  expect(section).toContain("launch");
  expect(section).toContain("deep-interview");
  expect(section).toContain("ralplan");
  expect(section).toContain("team");
  expect(section).toContain("ultragoal");
  expect(section).toContain("—");
});
