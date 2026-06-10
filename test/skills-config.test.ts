import { test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseSkillMarkdown, loadSkills, getSkillFrom, getSkillBySlash, skillSlashAliases, formatSkill, SKILLS } from "../src/skills/catalog";

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

test("parseSkillMarkdown extracts explicit and inferred slash aliases", () => {
  const s = parseSkillMarkdown(
    "spec-kit",
    "summary: SDD wrapper\naliases: /speckit.constitution /speckit.plan\n\nRun `/speckit.specify` or `/speckit.tasks` inside the agent.",
  );
  expect(skillSlashAliases(s)).toEqual(["/speckit.constitution", "/speckit.plan", "/speckit.specify", "/speckit.tasks"]);
  expect(formatSkill(s)).toContain("Slash aliases: /speckit.constitution, /speckit.plan");
});

test("parseSkillMarkdown ignores inferred slash aliases owned by other skills", () => {
  const s = parseSkillMarkdown(
    "spec-kit",
    "summary: SDD wrapper\n\nRun `/speckit.plan`, but route `/commit` and `/build` elsewhere.",
  );
  expect(skillSlashAliases(s)).toEqual(["/speckit.plan"]);
});

test("parseSkillMarkdown infers aliases for the last segment of a namespaced skill name", () => {
  const s = parseSkillMarkdown(
    "oh-my-claudecode:teamx",
    "summary: team orchestration\n\nInvoke with `/teamx` or `/teamx.run`; `/commit` belongs elsewhere.",
  );
  expect(skillSlashAliases(s)).toEqual(["/teamx", "/teamx.run"]);
});

test("parseSkillMarkdown skips YAML frontmatter and uses folded description as summary", () => {
  const s = parseSkillMarkdown("spec-kit", "---\nname: spec-kit\ndescription: >\n  Spec-driven workflow via specify.\n  Supports /speckit.plan.\n---\n\n# spec-kit\n\nBody starts here.");
  expect(s.summary).toBe("Spec-driven workflow via specify. Supports /speckit.plan.");
  expect(s.details).toContain("Body starts here.");
  expect(skillSlashAliases(s)).toContain("/speckit.plan");
});

let dir: string;
const prev = process.env.JOC_CONFIG_DIR;
const prevHome = process.env.HOME;
const prevSkillsDir = process.env.JOC_SKILLS_DIR;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-skills-"));
  process.env.JOC_CONFIG_DIR = dir;
  // Isolate from the real ~/.agents/skills and any JOC_SKILLS_DIR so the merge
  // assertions see only the fixtures written below.
  process.env.HOME = dir;
  delete process.env.JOC_SKILLS_DIR;
  await fs.mkdir(path.join(dir, "skills"), { recursive: true });
  await fs.writeFile(path.join(dir, "skills", "myskill.md"), "summary: my custom skill\n\nStep 1. Step 2.");
  // Override a bundled skill by name.
  await fs.writeFile(path.join(dir, "skills", "ralplan.md"), "summary: my overridden ralplan\n\ncustom plan flow");
  await fs.mkdir(path.join(dir, "skills", "spec-kit"), { recursive: true });
  await fs.writeFile(path.join(dir, "skills", "spec-kit", "SKILL.md"), "summary: spec kit skill\n\nUse /speckit.plan and /speckit.tasks.");
  await fs.mkdir(path.join(dir, ".agents", "skills", ".system"), { recursive: true });
  await fs.writeFile(path.join(dir, ".agents", "skills", ".system", "hidden.md"), "summary: hidden\n\nbody");
  await fs.mkdir(path.join(dir, "skills", "skill"), { recursive: true });
  await fs.writeFile(path.join(dir, "skills", "skill", "SKILL.md"), "summary: conflicts with builtin\n\nShould not load.");
});

afterAll(async () => {
  if (prev === undefined) delete process.env.JOC_CONFIG_DIR;
  else process.env.JOC_CONFIG_DIR = prev;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevSkillsDir === undefined) delete process.env.JOC_SKILLS_DIR;
  else process.env.JOC_SKILLS_DIR = prevSkillsDir;
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
  const spec = getSkillFrom(skills, "spec-kit");
  expect(spec?.summary).toBe("spec kit skill");
  expect(getSkillBySlash(skills, "/speckit.plan")?.name).toBe("spec-kit");
});

test("loadSkills skips hidden system dirs and external skills that collide with builtin command names", async () => {
  const skills = await loadSkills(dir);
  expect(getSkillFrom(skills, "skill")).toBeUndefined();
  expect(getSkillFrom(skills, "hidden")).toBeUndefined();
});

test("parseSkillMarkdown round-trips the formatSkill (joc skills --write) decoration", () => {
  const bundled = SKILLS.find(s => s.name === "deep-interview")!;
  // This is exactly what `joc skills --write` puts on disk.
  const onDisk = `# ${bundled.name}\n\n${formatSkill(bundled)}\n`;
  const back = parseSkillMarkdown(bundled.name, onDisk);
  expect(back.summary).toBe(bundled.summary); // NOT "Skill: deep-interview"
  expect(back.command).toBe(bundled.command);
  expect(back.whenToUse).toBe(bundled.whenToUse);
  expect(back.details.split("\n")[0]).toBe(bundled.details.split("\n")[0]);
});

test("loadSkills loads skills from JOC_SKILLS_DIR (positive path)", async () => {
  const extra = await fs.mkdtemp(path.join(os.tmpdir(), "joc-skills-extra-"));
  await fs.writeFile(path.join(extra, "envskill.md"), "summary: from env dir\n\nSteps here.");
  process.env.JOC_SKILLS_DIR = extra;
  try {
    const skills = await loadSkills(dir);
    expect(getSkillFrom(skills, "envskill")?.summary).toBe("from env dir");
  } finally {
    delete process.env.JOC_SKILLS_DIR;
    await fs.rm(extra, { recursive: true, force: true });
  }
});

test("loadSkills overrides bundled skills case-insensitively by filename", async () => {
  // A capital-cased filename must still override the lowercase bundled name.
  await fs.writeFile(path.join(dir, "skills", "Team.md"), "summary: cased override\n\nbody");
  try {
    const skills = await loadSkills(dir);
    const team = skills.filter(s => s.name.toLowerCase() === "team");
    expect(team.length).toBe(1); // no duplicate bundled+user entry
    expect(getSkillFrom(skills, "team")?.summary).toBe("cased override");
  } finally {
    await fs.rm(path.join(dir, "skills", "Team.md"), { force: true });
  }
});
