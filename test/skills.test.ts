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
  skillsPromptSection,
  workflowSkillsForPrompt,
  parseSkillInvocation,
  parseSkillMarkdown,
  buildSkillTask,
} from "../src/skills/catalog";

test("buildSkillTask: drives execution with real tools, not a skill-named tool call", () => {
  const skill = parseSkillMarkdown("demo", "---\ndescription: Demo\nslash: /demo\n---\n# Demo\nCreate demo-output.txt.");
  const task = buildSkillTask(skill, "make the file", "/demo");
  // Explicitly forbids the failure we reproduced (model calling a tool named "demo").
  expect(task).toContain('Do NOT emit a tool call named "demo"');
  expect(task).toContain("Use your real tools");
  expect(task).toContain("<skill_guidance name=\"demo\">");
  expect(task).not.toContain("Command: /skill demo");
  expect(task).not.toContain("Skill: demo");
  expect(task).toContain("User intent: make the file");
  expect(task).toContain("Invoked as: /demo");
  expect(task).toContain("Create demo-output.txt"); // skill guidance injected
});

test("buildSkillTask: no intent → still instructs the agent to carry out the workflow", () => {
  const skill = parseSkillMarkdown("demo", "# Demo\nDo a thing.");
  const task = buildSkillTask(skill, "");
  expect(task).toContain("Carry out this skill's workflow now");
  expect(task).not.toContain("Invoked as:");
});

test("parseSkillMarkdown folds YAML block scalars and the lead-in '... >' form", () => {
  // plain block scalar
  expect(parseSkillMarkdown("a", "---\ndescription: >\n  Hello block scalar.\n---\n").summary)
    .toBe("Hello block scalar.");
  // invalid-but-ubiquitous lead-in form: "<text> >" + indented continuation
  expect(parseSkillMarkdown("b", "---\ndescription: Use this skill when >\n  doing TDD work.\n---\n").summary)
    .toBe("Use this skill when doing TDD work.");
  // chomping indicator with lead-in
  expect(parseSkillMarkdown("c", "---\ndescription: Lead >-\n  rest of it.\n---\n").summary)
    .toBe("Lead rest of it.");
  // a description that merely ENDS in '>' (no whitespace before) must be left intact
  expect(parseSkillMarkdown("d", "---\ndescription: returns Promise<T>\n---\nbody").summary)
    .toBe("returns Promise<T>");
});

test("parseSkillMarkdown caps oversized details to keep skill invocation prompts bounded", () => {
  const giant = "detail line\n".repeat(1200);
  const parsed = parseSkillMarkdown("huge", `---\nsummary: big\n---\n${giant}`);
  expect(parsed.details.length).toBeLessThanOrEqual(8_000);
  expect(parsed.details.endsWith("…")).toBe(true);
});

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

test("skillsPromptSection caps an oversized skill catalog and reports omitted entries", () => {
  const many = Array.from({ length: 80 }, (_, i) => ({
    name: `skill-${i}`,
    command: `/skill skill-${i}`,
    summary: "S".repeat(180),
    whenToUse: "",
    details: "",
  }));
  const section = skillsPromptSection(many);
  expect(section.length).toBeLessThanOrEqual(6_200);
  expect(section).toContain("omitted for brevity");
  expect(section.split("\n").length).toBeLessThanOrEqual(41);
});

test("workflowSkillsForPrompt advertises only bundled workflow skills", () => {
  const ralplan = SKILLS.find(s => s.name === "ralplan")!;
  const external = parseSkillMarkdown("spec-kit", "summary: SDD wrapper\naliases: /speckit.plan\n\nUse spec-kit.");
  const routed = workflowSkillsForPrompt([...SKILLS, external, { ...ralplan, summary: "custom ralplan" }]);
  expect(routed.map(s => s.name)).toEqual(SKILLS.map(s => s.name));
  expect(routed.some(s => s.name === "spec-kit")).toBe(false);
  expect(routed.find(s => s.name === "ralplan")?.summary).toBe("custom ralplan");
});

test("parseSkillInvocation only matches explicit slash invocations", () => {
  const spec = parseSkillMarkdown("spec-kit", "summary: SDD wrapper\naliases: /speckit.plan\n\nUse spec-kit.");
  const skills = [...SKILLS, spec];
  expect(parseSkillInvocation("/speckit.plan write tasks", skills)).toMatchObject({
    skill: expect.objectContaining({ name: "spec-kit" }),
    intent: "write tasks",
    invokedAs: "/speckit.plan",
  });
  expect(parseSkillInvocation("/skill:spec-kit write plan", skills)).toMatchObject({
    skill: expect.objectContaining({ name: "spec-kit" }),
    intent: "write plan",
  });
  expect(parseSkillInvocation("Use /speckit.plan as reference, but fix the provider bug", skills)).toBeNull();
});

test("parseSkillInvocation can load an explicit skill file path but still blocks reserved meta-skill names", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-skill-path-"));
  try {
    const skillPath = path.join(dir, "reviewer.md");
    await fs.writeFile(skillPath, "summary: Reviewer wrapper\naliases: /reviewer\n\nReview the target.");
    const invocation = parseSkillInvocation(`/skill:${skillPath} src/app.ts`, SKILLS);
    expect(invocation?.skill.name).toBe("reviewer");
    expect(invocation?.intent).toBe("src/app.ts");

    const reservedDir = path.join(dir, "skill");
    await fs.mkdir(reservedDir);
    await fs.writeFile(path.join(reservedDir, "SKILL.md"), "summary: meta skill\n\nDump local skills.");
    expect(parseSkillInvocation(`/skill:${reservedDir} list`, SKILLS)).toBeNull();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
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
