import type { SkillDoc } from "../../skills/catalog";
import { skillSlashAliases } from "../../skills/catalog";
import { SelectList, renderSelectList, type RenderSelectOptions, type SelectItem } from "./select-list";

function skillHint(skill: SkillDoc): string {
  const aliases = skillSlashAliases(skill);
  return aliases.length ? aliases.slice(0, 3).join(" ") : skill.command;
}

export function buildSkillChoices(skills: SkillDoc[]): SelectItem<SkillDoc>[] {
  return skills.map(skill => ({
    value: skill,
    label: skill.name,
    group: "skills",
    hint: skillHint(skill),
  }));
}

export function skillPicker(skills: SkillDoc[]): SelectList<SkillDoc> {
  return new SelectList(buildSkillChoices(skills));
}

export function renderSkillPicker(list: SelectList<SkillDoc>, opts: RenderSelectOptions = {}): string[] {
  return renderSelectList(list, { title: "Select a skill", rows: 12, ...opts });
}
