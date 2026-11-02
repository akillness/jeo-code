import { test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadSkills, skillDirs, skillsPromptSection, type SkillDoc } from "../src/skills/catalog";
import { routeSkillsForTask, SKILL_ROUTE_GATE } from "../src/agent/skill-router";

let tempHome: string;
let tempCwd: string;
const prevHome = process.env.HOME;
const prevCfg = process.env.JEO_CONFIG_DIR;

beforeAll(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-skills-home-"));
  tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-skills-cwd-"));
  process.env.HOME = tempHome;
  process.env.JEO_CONFIG_DIR = path.join(tempHome, ".jeo");

  // Simulate jeo-skills installation into ~/.agents/skills and project .agent-skills
  const globalSkills = path.join(tempHome, ".agents", "skills");
  const projectAgentSkills = path.join(tempCwd, ".agent-skills");

  await fs.mkdir(path.join(globalSkills, "web-frontend-design"), { recursive: true });
  await fs.writeFile(
    path.join(globalSkills, "web-frontend-design", "SKILL.md"),
    "---\nname: web-frontend-design\ndescription: Comprehensive modern frontend and responsive design guidelines.\n---\n\n# Web Frontend Design\n\nMobile first, accessibility, CSS architecture.",
  );

  await fs.mkdir(path.join(projectAgentSkills, "repo-orchestrator"), { recursive: true });
  await fs.writeFile(
    path.join(projectAgentSkills, "repo-orchestrator", "SKILL.md"),
    "---\nname: repo-orchestrator\ndescription: Orchestrate multi-step repo migration workflows.\n---\n\n# Repo Orchestrator\n\nOrchestration workflow guidance.",
  );
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevCfg === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = prevCfg;
  await fs.rm(tempHome, { recursive: true, force: true });
  await fs.rm(tempCwd, { recursive: true, force: true });
});

test("skillDirs includes .agent-skills directory from cwd and home", () => {
  const dirs = skillDirs(tempCwd);
  expect(dirs).toContain(path.join(tempHome, ".agents", "skills"));
  expect(dirs).toContain(path.join(tempHome, ".agent-skills"));
  expect(dirs).toContain(path.join(tempCwd, ".agents", "skills"));
  expect(dirs).toContain(path.join(tempCwd, ".agent-skills"));
});

test("loadSkills discovers skills installed via jeo-skills layout", async () => {
  const skills = await loadSkills(tempCwd);
  const names = skills.map(s => s.name);
  expect(names).toContain("web-frontend-design");
  expect(names).toContain("repo-orchestrator");
});

test("skillsPromptSection prioritizes relevant configured skills when currentTask matches", async () => {
  const skills = await loadSkills(tempCwd);
  const section = skillsPromptSection(skills, "I need to update the responsive web-frontend design for mobile");
  expect(section).toContain("web-frontend-design");
});

test("independent routeSkillsForTask selects jeo-skills workflows deterministically", async () => {
  const skills = await loadSkills(tempCwd);
  const routeResult = routeSkillsForTask("orchestrate multi-step repo migration workflow", skills);
  expect(routeResult.reason).toBe("ok");
  expect(routeResult.topK.length).toBeGreaterThan(0);
  expect(routeResult.topK[0]!.name).toBe("repo-orchestrator");
  expect(routeResult.topK[0]!.score).toBeGreaterThanOrEqual(SKILL_ROUTE_GATE);
});
