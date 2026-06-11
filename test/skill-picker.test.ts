import { test, expect } from "bun:test";
import { buildSkillChoices, skillPicker, renderSkillPicker } from "../src/tui/components/skill-picker";

const skills = [
  { name: "spec-kit", command: "/skill spec-kit", summary: "Spec-driven workflow", whenToUse: "SDD", details: "Use /speckit.plan", aliases: ["/speckit.plan", "/speckit.tasks"] },
  { name: "ralplan", command: "jeo ralplan", summary: "Plan", whenToUse: "planning", details: "Plan" },
];

test("buildSkillChoices shows aliases as hints", () => {
  const choices = buildSkillChoices(skills);
  expect(choices[0]?.label).toBe("spec-kit");
  expect(choices[0]?.hint).toContain("/speckit.plan");
  expect(choices[1]?.hint).toBe("jeo ralplan");
});

test("skillPicker renders a keyboard-selectable skill list", () => {
  const picker = skillPicker(skills);
  picker.down();
  expect(picker.selected()?.value.name).toBe("ralplan");
  const lines = renderSkillPicker(picker, { cols: 80, color: false, unicode: false });
  expect(lines.join("\n")).toContain("Select a skill");
  expect(lines.join("\n")).toContain("ralplan");
});
