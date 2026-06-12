import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SKILLS, getSkillFrom, formatSkill, loadSkills, skillDirs } from "../skills/catalog";
import { getLocalJocDir } from "../agent/state";

function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1, // deletion
        d[i][j - 1] + 1, // insertion
        d[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return d[m][n];
}

function suggestSkills(name: string, known: string[]): string[] {
  const q = name.toLowerCase();
  if (!q) return [];
  return known.filter(n => n.toLowerCase().startsWith(q) || editDistance(n.toLowerCase(), q) <= 2);
}

export async function runSkillsCommand(args: string[] = []): Promise<void> {
  const cwd = process.cwd();
  const isJson = args.includes("--json");
  const cleanArgs = args.filter(a => a !== "--json");

  // `jeo skills --write [dir]` materializes bundled skill docs to disk (gjc-style SKILL.md files).
  if (cleanArgs[0] === "--write") {
    const dir = cleanArgs[1] ? path.resolve(cwd, cleanArgs[1]) : path.join(getLocalJocDir(cwd), "skills");
    await fs.mkdir(dir, { recursive: true });
    for (const s of SKILLS) {
      const file = path.join(dir, `${s.name}.md`);
      await fs.writeFile(file, s.raw || `# ${s.name}\n\n${formatSkill(s)}\n`, "utf-8");
    }
    console.log(`Wrote ${SKILLS.length} skill docs to ${dir}`);
    return;
  }

  // List/lookup over the MERGED set (bundled + ~/.jeo/skills + ~/.agents/skills + project dirs), matching the REPL /skill.
  const skills = await loadSkills(cwd);
  const command = cleanArgs[0];

  if (!command || command === "list") {
    if (isJson) {
      console.log(JSON.stringify(skills.map(s => ({ name: s.name, summary: s.summary })), null, 2));
    } else {
      console.log("\n=== jeo skills ===");
      console.log("Workflow skills (bundled + ~/.jeo/skills, ~/.agents/skills, project dirs) — 'jeo skills <name>' for details, --write to export:\n");
      for (const s of skills) {
        console.log(`  ${s.name.padEnd(16)} ${s.summary}`);
      }
      console.log("\nInvoke: /skill <name> [intent]  ·  $<name> [intent]  ·  skill-owned slash aliases (e.g. /speckit.plan)");
      console.log("Discovery dirs (later wins on name clash; JEO_SKILLS_DIR adds more):");
      for (const d of skillDirs(cwd)) console.log(`  ${d}`);
      console.log("");
    }
    return;
  }

  let name: string;
  if (command === "read") {
    name = cleanArgs[1];
    if (!name) {
      console.log("Error: Missing skill name for 'read' command.");
      process.exitCode = 1;
      return;
    }
  } else {
    name = command;
  }

  const skill = getSkillFrom(skills, name);
  if (!skill) {
    const knownNames = skills.map(s => s.name);
    const suggestions = suggestSkills(name, knownNames);
    const hint = suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : "";
    console.log(`Unknown skill: ${name}.${hint}\nAvailable: ${knownNames.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  if (isJson) {
    const content = skill.raw || `# ${skill.name}\n\n${formatSkill(skill)}\n`;
    console.log(JSON.stringify({ name: skill.name, content }, null, 2));
  } else {
    console.log(formatSkill(skill));
  }
}
