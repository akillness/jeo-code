import { test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseSkillMarkdown, loadSkills, getSkillFrom, SKILLS } from "../src/skills/catalog";

test("parseSkillMarkdown infers summary from the first body line; strips a title", () => {
  const s = parseSkillMarkdown("notes", "# Notes Skill\nKeep a running log of decisions.\nMore detail here.");
  expect(s.name).toBe("notes");
  expect(s.summary).toBe("Keep a running log of decisions.");
  expect(s.details).toContain("More detail here.");
  expect(s.command).toBe("/skill notes");
});

test("parseSkillMarkdown honors explicit header keys", () => {
  const s = parseSkillMarkdown("deploy", "summary: ship it\ncommand: /skill deploy\nwhen: release time\n\nDo the deploy steps.");
  expect(s.summary).toBe("ship it");
  expect(s.whenToUse).toBe("release time");
  expect(s.details).toBe("Do the deploy steps.");
});

let dir: string;
const prev = process.env.JOC_CONFIG_DIR;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-skills-"));
  process.env.JOC_CONFIG_DIR = dir;
  await fs.mkdir(path.join(dir, "skills"), { recursive: true });
  await fs.writeFile(path.join(dir, "skills", "myskill.md"), "summary: my custom skill\n\nStep 1. Step 2.");
  // Override a bundled skill by name.
  await fs.writeFile(path.join(dir, "skills", "ralplan.md"), "summary: my overridden ralplan\n\ncustom plan flow");
});

afterAll(async () => {
  if (prev === undefined) delete process.env.JOC_CONFIG_DIR;
  else process.env.JOC_CONFIG_DIR = prev;
  await fs.rm(dir, { recursive: true, force: true });
});

test("loadSkills merges bundled + user skill docs; user overrides by name", async () => {
  const skills = await loadSkills(dir); // use a cwd with no .joc/skills, so only the global dir adds
  const names = skills.map(s => s.name);
  // bundled skills present
  for (const b of SKILLS) expect(names).toContain(b.name);
  // user skill added
  const mine = getSkillFrom(skills, "myskill");
  expect(mine?.summary).toBe("my custom skill");
  // bundled ralplan overridden by the user file
  expect(getSkillFrom(skills, "ralplan")?.summary).toBe("my overridden ralplan");
});
