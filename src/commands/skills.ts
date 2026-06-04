import { SKILLS, getSkill, formatSkill, skillNames } from "../skills/catalog";

export async function runSkillsCommand(args: string[] = []): Promise<void> {
  const name = args[0];
  if (name) {
    const skill = getSkill(name);
    if (!skill) {
      console.log(`Unknown skill: ${name}\nAvailable: ${skillNames().join(", ")}`);
      process.exitCode = 1;
      return;
    }
    console.log(formatSkill(skill));
    return;
  }
  console.log("\n=== joc skills ===");
  console.log("Bundled workflow skills (run 'joc skills <name>' for details):\n");
  for (const s of SKILLS) {
    console.log(`  ${s.name.padEnd(16)} ${s.summary}`);
  }
  console.log("");
}
