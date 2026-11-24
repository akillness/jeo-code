import { test, expect } from "bun:test";
import { SKILLS, getSkill } from "../src/skills/catalog";
import { KARPATHY_DISCIPLINE, OUTPUT_DISCIPLINE, executorSystemPrompt } from "../src/agent/engine";
import { SUBAGENT_ROLES, getSubagentRole, subagentSystemPrompt } from "../src/agent/subagents";
import { routeSkillsForTask, inventorySkillConflicts, skillAdvisoryRoutingNote, SKILL_ROUTE_GATE } from "../src/agent/skill-router";

test("subagentSystemPrompt injects KARPATHY_DISCIPLINE across bundled and custom roles without duplication", () => {
  for (const role of SUBAGENT_ROLES) {
    const prompt = subagentSystemPrompt(role);
    expect(prompt).toContain(KARPATHY_DISCIPLINE);
    expect(prompt.split(KARPATHY_DISCIPLINE)).toHaveLength(2);
  }

  const defaultCustom = getSubagentRole("reviewer", {
    subagents: { reviewer: { description: "Custom reviewer", readOnly: false } },
  })!;
  const defaultCustomPrompt = subagentSystemPrompt(defaultCustom);
  expect(defaultCustomPrompt).toContain(KARPATHY_DISCIPLINE);
  expect(defaultCustomPrompt.split(KARPATHY_DISCIPLINE)).toHaveLength(2);

  const bareCustom = getSubagentRole("minimalist", {
    subagents: { minimalist: { prompt: "You are {{ROLE_TITLE}}." } },
  })!;
  const bareCustomPrompt = subagentSystemPrompt(bareCustom);
  expect(bareCustomPrompt).toContain("You are Minimalist.");
  expect(bareCustomPrompt).toContain(KARPATHY_DISCIPLINE);
  expect(bareCustomPrompt.split(KARPATHY_DISCIPLINE)).toHaveLength(2);
});

test("OUTPUT_DISCIPLINE harmonizes trivial assumption-stating with non-trivial clarification", () => {
  expect(OUTPUT_DISCIPLINE).toContain("on trivial tasks state reasonable assumptions");
  expect(OUTPUT_DISCIPLINE).toContain("on non-trivial ambiguity ask at most one clarifying question");
});

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

test("skillAdvisoryRoutingNote: gate-miss selection renders no advisory (answer directly)", () => {
  const miss = { topK: [], reason: "gate" as const, strategy: "sharded" as const, routing: "No skill cleared the gate." };
  expect(skillAdvisoryRoutingNote(miss)).toBe("");
});

test("skillAdvisoryRoutingNote: ok selection renders the suggested skill names as advisory", () => {
  const sel = routeSkillsForTask("run ralplan to plan the auth refactor", SKILLS);
  expect(sel.reason).toBe("ok");
  const note = skillAdvisoryRoutingNote(sel);
  expect(note).toContain("Jev advisory routing");
  expect(note).toContain("ralplan");
  expect(note).toContain("Advisory only");
});

test("route-skills: conversational choice replies and 'ok' abstain cleanly", () => {
  const mk = (name: string, summary: string) => ({ name, command: `jeo /${name}`, summary, whenToUse: summary, details: "" });
  const skills = [
    mk("okf", "Create and validate Open Knowledge Format bundles."),
    mk("brainstorm-okrs", "Brainstorm quarterly OKRs."),
    mk("agent-beacon", "Skill routing and agent coordination."),
  ];
  for (const prompt of [
    "1.c, 2.a, 3. 2~3초 ok, 응 허용 4. 엉뚱한걸 체크하는거같아",
    "1. c, 2. a, 3. a",
    "ok",
    "응 그렇게 진행해줘",
    "고마워, 잘 됐어!",
  ]) {
    const sel = routeSkillsForTask(prompt, skills);
    expect(sel.topK).toEqual([]);
    expect(sel.reason).toBe("gate");
    expect(skillAdvisoryRoutingNote(sel)).toBe("");
  }
});

test("route-skills: Korean technical prompts route accurately without alphabetical ties", () => {
  const mk = (name: string, summary: string) => ({ name, command: `jeo /${name}`, summary, whenToUse: summary, details: "" });
  const skills = [
    mk("agent-beacon", "Agent skill status beacon."),
    mk("agent-manager", "Manage agent skills."),
    mk("blender-skills", "Blender 5.2+ rigging, skinning, weight painting, and 3D modeling."),
  ];
  const sel = routeSkillsForTask("블렌더에서 캐릭터 리깅하고 웨이트 페인팅 알려줘", skills);
  expect(sel.reason).toBe("ok");
  expect(sel.topK[0]?.name).toBe("blender-skills");
  expect(sel.topK.some(c => c.name === "agent-beacon")).toBe(false);
});

test("route-skills: single-char Korean tech terms (웹/앱/깃) route cleanly", () => {
  const mk = (name: string, summary: string) => ({ name, command: `jeo /${name}`, summary, whenToUse: summary, details: "" });
  const skills = [
    mk("git-workflow", "Git branch, commit, push, and PR workflow automation."),
    mk("web-design-guidelines", "Web UI and responsive app layout guidelines."),
    mk("blender-skills", "Blender 3D modeling and rigging."),
  ];
  const webSel = routeSkillsForTask("웹 앱 UI 레이아웃 수정해줘", skills);
  expect(webSel.reason).toBe("ok");
  expect(webSel.topK.map(c => c.name)).toContain("web-design-guidelines");
  expect(webSel.topK.map(c => c.name)).not.toContain("blender-skills");

  const gitSel = routeSkillsForTask("깃 커밋하고 푸시해줘", skills);
  expect(gitSel.reason).toBe("ok");
  expect(gitSel.topK.map(c => c.name)).toContain("git-workflow");
  expect(gitSel.topK.map(c => c.name)).not.toContain("blender-skills");
});

test("route-skills: Korean compound multi-intent stems (딥리서치하고, 깃푸시, 실동작검증) match accurately", () => {
  const mk = (name: string, summary: string) => ({ name, command: `jeo /${name}`, summary, whenToUse: summary, details: "" });
  const skills = [
    mk("deep-research", "Structured deep research workflow with parallel web search and report generation."),
    mk("git-workflow", "Git commit, push, branch management, and GitHub workflow."),
    mk("code-review", "Code review, audit, and architecture quality checks."),
    mk("blender-skills", "Blender 3D sculpting and rendering."),
  ];
  const sel = routeSkillsForTask("subagent 이용해. 추가 리뷰 및 딥리서치하고 개선해서 깃푸시하고 실동작검증까지 진행", skills);
  expect(sel.reason).toBe("ok");
  const names = sel.topK.map(c => c.name);
  expect(names).toContain("deep-research");
  expect(names).toContain("git-workflow");
  expect(names).not.toContain("blender-skills");
});