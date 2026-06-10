import { test, expect } from "bun:test";
import {
  SKILLS,
  workflowSkillsForPrompt,
  buildSkillTask,
  looksLikeSkillEcho,
  type SkillDoc
} from "../src/skills/catalog";

test("workflowSkillsForPrompt ignores a user doc named 'team' with a foreign summary", () => {
  const foreignTeam: SkillDoc = {
    name: "team",
    command: "joc team",
    summary: "foreign team mode override",
    whenToUse: "When using OMX mode",
    details: "foreign details here"
  };
  const result = workflowSkillsForPrompt([foreignTeam]);
  const teamSkill = result.find(s => s.name === "team");
  expect(teamSkill).toBeDefined();
  expect(teamSkill!.summary).not.toBe("foreign team mode override");
  expect(teamSkill!.summary).toBe("Per-task executor loop against the plan.");
});

test("buildSkillTask clamps long details and contains the anti-recite line", () => {
  const longDetails = "a".repeat(3000);
  const longSkill: SkillDoc = {
    name: "test-clamp",
    command: "joc test-clamp",
    summary: "test clamp summary",
    whenToUse: "Always",
    details: longDetails
  };
  const task = buildSkillTask(longSkill, "do something");

  // Check anti-recite line
  expect(task).toContain("You must never quote or recite the guidance text as your reply; the done reason must describe actual work/outcome.");

  // Check details are clamped
  const guidanceIndex = task.indexOf("<skill_guidance");
  const guidanceCloseIndex = task.indexOf("</skill_guidance>");
  expect(guidanceIndex).not.toBe(-1);
  expect(guidanceCloseIndex).not.toBe(-1);
  const guidanceContent = task.slice(guidanceIndex, guidanceCloseIndex);

  const expectedDetailsClamped = "a".repeat(2400) + "…";
  expect(guidanceContent).toContain(expectedDetailsClamped);
  expect(guidanceContent).not.toContain("a".repeat(2401));
});

test("looksLikeSkillEcho detects replies dominated by skill-doc content", () => {
  const longDetails = "x".repeat(300) + "y".repeat(300) + "z".repeat(300); // 900 chars
  const skill: SkillDoc = {
    name: "fab-skill",
    command: "joc fab-skill",
    summary: "fab summary",
    whenToUse: "when needed",
    details: longDetails
  };

  // (1) True for a reply containing <skill_guidance
  const guidanceReply = "Here is some text with <skill_guidance name=\"fab-skill\"> in it, which makes it look like an echo.";
  expect(looksLikeSkillEcho(guidanceReply, [skill])).toBe(true);

  // (2) True for a reply with "Skill: " and "When to use:"
  const formattedReply = "Skill: fab-skill\nCommand: joc fab-skill\nSummary: fab summary\nWhen to use: when needed\nDetails:\n  some details here";
  expect(looksLikeSkillEcho(formattedReply, [skill])).toBe(true);

  // (3) True for a reply quoting 200 chars of a skill's details (start probe is 160 'x's, so 200 'x's will trigger it)
  const detailsChunk = "x".repeat(200);
  const quotingReply = "Here is some context and then the quoted details:\n" + detailsChunk + "\nAnd some more text to reach length 80.";
  expect(looksLikeSkillEcho(quotingReply, [skill])).toBe(true);

  // (4) True for a reply listing 3 bundled skill summary lines
  const replyWith3Summaries = [
    "Socratic ambiguity gate; freezes a seed only when clarity is sufficient, with --auto for non-interactive clarification.",
    "Planner/Architect/Critic blueprint from the seed.",
    "Per-task executor loop against the plan."
  ].join("\n");
  expect(looksLikeSkillEcho(replyWith3Summaries, SKILLS)).toBe(true);

  // (5) True for a reply listing 3 prompt section lines
  const replyWith3PromptLines = [
    "- deep-interview — Socratic ambiguity gate; freezes a seed only when clarity is sufficient, with --auto for non-interactive clarification.",
    "- ralplan — Planner/Architect/Critic blueprint from the seed.",
    "- team — Per-task executor loop against the plan."
  ].join("\n");
  expect(looksLikeSkillEcho(replyWith3PromptLines, SKILLS)).toBe(true);

  // (6) False for a normal coding answer mentioning one skill name
  const normalReply = "To solve this, we can run the team skill or deep-interview to gather requirements.\nHere is some code:\nconst x = 1;\nconsole.log(x);";
  expect(looksLikeSkillEcho(normalReply, SKILLS)).toBe(false);

  // (7) False for short replies (less than 80 chars)
  const shortReply = "Skill: deep-interview\nWhen to use: vague idea";
  expect(looksLikeSkillEcho(shortReply, SKILLS)).toBe(false);
});
