import { test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadSkills, getSkillFrom, skillDirs, parseSkillMarkdown } from "../src/skills/catalog";

// Tolerance for the Vercel `npx skills add` ecosystem (agent-skills standard):
// canonical `.agents/skills/` store, agent-targeted `.claude/skills/` installs,
// gjc's `~/.gjc/agent/skills/`, SYMLINKED skill dirs, and frontmatter `name:`
// as the authoritative identity for external skills.

let home: string;
let cwd: string;
const prevHome = process.env.HOME;
const prevCfg = process.env.JOC_CONFIG_DIR;
const prevSkillsDir = process.env.JOC_SKILLS_DIR;

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-vercel-home-"));
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-vercel-cwd-"));
  process.env.HOME = home;
  process.env.JOC_CONFIG_DIR = path.join(home, ".joc");
  delete process.env.JOC_SKILLS_DIR;

  // 1. Vercel canonical store with a SYMLINKED skill dir (the layout `npx skills
  //    add` produces when linking agent dirs to its store).
  const store = path.join(home, "skills-store", "spec-stack");
  await fs.mkdir(store, { recursive: true });
  await fs.writeFile(
    path.join(store, "SKILL.md"),
    "---\nname: spec-stack\ndescription: Write → Freeze → Run composition.\n---\n\n# spec-stack\n\nCompose the layers.",
  );
  await fs.mkdir(path.join(cwd, ".agents", "skills"), { recursive: true });
  await fs.symlink(store, path.join(cwd, ".agents", "skills", "spec-stack"));
  // Broken symlink must be skipped silently, not crash discovery.
  await fs.symlink(path.join(home, "nope"), path.join(cwd, ".agents", "skills", "dangling"));

  // 2. Agent-targeted install dir (.claude/skills) — project level.
  await fs.mkdir(path.join(cwd, ".claude", "skills", "ralph-loop"), { recursive: true });
  await fs.writeFile(
    path.join(cwd, ".claude", "skills", "ralph-loop", "SKILL.md"),
    "---\nname: ralph-loop\ndescription: persistent verify-before-done loop\n---\n\nLoop until verified.",
  );

  // 3. gjc global skills dir.
  await fs.mkdir(path.join(home, ".gjc", "agent", "skills", "gjc-only"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".gjc", "agent", "skills", "gjc-only", "SKILL.md"),
    "summary: lives in the gjc tree\n\ngjc-installed skill body.",
  );

  // 4. Frontmatter name beats a mismatched directory name for external skills.
  await fs.mkdir(path.join(cwd, ".agents", "skills", "renamed-dir-7f3a"), { recursive: true });
  await fs.writeFile(
    path.join(cwd, ".agents", "skills", "renamed-dir-7f3a", "SKILL.md"),
    "---\nname: bigcode-eval\ndescription: code model benchmarking\n---\n\nRun the harness.",
  );
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevCfg === undefined) delete process.env.JOC_CONFIG_DIR;
  else process.env.JOC_CONFIG_DIR = prevCfg;
  if (prevSkillsDir === undefined) delete process.env.JOC_SKILLS_DIR;
  else process.env.JOC_SKILLS_DIR = prevSkillsDir;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(cwd, { recursive: true, force: true });
});

test("skillDirs covers Vercel canonical, agent-targeted, and gjc install roots", () => {
  const dirs = skillDirs(cwd);
  expect(dirs).toContain(path.join(home, ".claude", "skills"));
  expect(dirs).toContain(path.join(home, ".gjc", "agent", "skills"));
  expect(dirs).toContain(path.join(home, ".agents", "skills"));
  expect(dirs).toContain(path.join(cwd, ".claude", "skills"));
  expect(dirs).toContain(path.join(cwd, ".agents", "skills"));
  // jeo-native project dir stays highest-precedence among scanned defaults.
  expect(dirs.indexOf(path.join(cwd, ".joc", "skills"))).toBeGreaterThan(dirs.indexOf(path.join(cwd, ".agents", "skills")));
});

test("loadSkills follows symlinked skill dirs and skips dangling links", async () => {
  const skills = await loadSkills(cwd);
  const spec = getSkillFrom(skills, "spec-stack");
  expect(spec?.summary).toBe("Write → Freeze → Run composition.");
  expect(getSkillFrom(skills, "dangling")).toBeUndefined();
});

test("loadSkills discovers .claude/skills and ~/.gjc/agent/skills installs", async () => {
  const skills = await loadSkills(cwd);
  expect(getSkillFrom(skills, "ralph-loop")?.summary).toBe("persistent verify-before-done loop");
  expect(getSkillFrom(skills, "gjc-only")?.summary).toBe("lives in the gjc tree");
});

test("frontmatter name: is the identity for external skills (directory name loses)", async () => {
  const skills = await loadSkills(cwd);
  expect(getSkillFrom(skills, "bigcode-eval")).toBeDefined();
  expect(getSkillFrom(skills, "renamed-dir-7f3a")).toBeUndefined();
});

test("parseSkillMarkdown: preferMetaName is opt-in and rejects unsafe names", () => {
  const md = "---\nname: real-name\ndescription: d\n---\n\nbody";
  expect(parseSkillMarkdown("dir-name", md).name).toBe("dir-name"); // bundled path: opt-out
  expect(parseSkillMarkdown("dir-name", md, { preferMetaName: true }).name).toBe("real-name");
  const unsafe = "---\nname: not a single token\n---\n\nbody";
  expect(parseSkillMarkdown("dir-name", unsafe, { preferMetaName: true }).name).toBe("dir-name");
});
