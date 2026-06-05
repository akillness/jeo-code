import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runSkillsCommand } from "../src/commands/skills";
import { SKILLS } from "../src/skills/catalog";
import {
  getSkill,
  skillNames,
  formatSkill,
  skillsPromptSection
} from "../src/skills/catalog";

test("skillNames returns all four skills", () => {
  const names = skillNames();
  expect(names.length).toBe(4);
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

  expect(section).toContain("deep-interview");
  expect(section).toContain("ralplan");
  expect(section).toContain("team");
  expect(section).toContain("ultragoal");
  expect(section).toContain("—");
});

test("runSkillsCommand --write: materializes one .md per skill", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-skills-"));
  try {
    await runSkillsCommand(["--write", dir]);
    const files = (await fs.readdir(dir)).sort();
    expect(files).toEqual(SKILLS.map(s => `${s.name}.md`).sort());
    const sample = await fs.readFile(path.join(dir, "deep-interview.md"), "utf-8");
    expect(sample).toContain("# deep-interview");
    expect(sample).toContain("joc deep-interview");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
