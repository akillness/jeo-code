import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SKILLS, getSkill, formatSkill, skillNames } from "../skills/catalog";
import { getLocalJocDir } from "../agent/state";

export async function runSkillsCommand(args: string[] = []): Promise<void> {
  // `joc skills --write [dir]` materializes bundled skill docs to disk (gjc-style SKILL.md files).
  if (args[0] === "--write") {
    const cwd = process.cwd();
    const dir = args[1] ? path.resolve(cwd, args[1]) : path.join(getLocalJocDir(cwd), "skills");
    await fs.mkdir(dir, { recursive: true });
    for (const s of SKILLS) {
      const file = path.join(dir, `${s.name}.md`);
      await fs.writeFile(file, `# ${s.name}\n\n${formatSkill(s)}\n`, "utf-8");
    }
    console.log(`Wrote ${SKILLS.length} skill docs to ${dir}`);
    return;
  }

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
  console.log("Bundled workflow skills (run 'joc skills <name>' for details, --write to export):\n");
  for (const s of SKILLS) {
    console.log(`  ${s.name.padEnd(16)} ${s.summary}`);
  }
  console.log("");
}
