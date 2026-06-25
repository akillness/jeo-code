import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SKILLS, getSkillFrom, formatSkill, loadSkills, skillDirs, bundledSkillFileContent, userSkillsDir } from "../skills/catalog";
import { getLocalJeoDir } from "../agent/state";

export { userSkillsDir };

export type SkillSyncStatus = "missing" | "up-to-date" | "differs";
export type SkillSyncAction = "installed" | "overwritten" | "preserved" | "unchanged" | "none";

export interface SkillSyncEntry {
  name: string;
  /** State of the on-disk file BEFORE any write this run. */
  status: SkillSyncStatus;
  /** What sync did (or, for --check, "none"). */
  action: SkillSyncAction;
  path: string;
}

export interface SkillSyncResult {
  dir: string;
  entries: SkillSyncEntry[];
  /** true when any bundled skill is missing or differs from its on-disk copy. */
  drift: boolean;
  /** Number of files actually written this run. */
  wrote: number;
}

/** Reconcile the bundled workflow skills against `dir` (default {@link userSkillsDir}).
 *  Default install preserves existing local files (gjc `setup defaults` parity):
 *  missing skills are installed, differing ones preserved unless `force`. `check`
 *  is a pure drift report — it writes nothing. Returns a structured result so the
 *  CLI wrapper owns all console output / exit codes. */
export async function syncBundledSkills(
  dir: string,
  opts: { check?: boolean; force?: boolean } = {},
): Promise<SkillSyncResult> {
  const entries: SkillSyncEntry[] = [];
  let wrote = 0;
  if (!opts.check) await fs.mkdir(dir, { recursive: true });
  for (const s of SKILLS) {
    const file = path.join(dir, `${s.name}.md`);
    const want = bundledSkillFileContent(s);
    let have: string | null = null;
    try { have = await fs.readFile(file, "utf-8"); } catch { /* missing */ }
    const status: SkillSyncStatus = have === null ? "missing" : have === want ? "up-to-date" : "differs";
    let action: SkillSyncAction = "none";
    if (!opts.check) {
      if (status === "missing") {
        await fs.writeFile(file, want, "utf-8");
        action = "installed";
        wrote++;
      } else if (status === "differs") {
        if (opts.force) {
          await fs.writeFile(file, want, "utf-8");
          action = "overwritten";
          wrote++;
        } else {
          action = "preserved";
        }
      } else {
        action = "unchanged";
      }
    }
    entries.push({ name: s.name, status, action, path: file });
  }
  return { dir, entries, drift: entries.some(e => e.status !== "up-to-date"), wrote };
}

async function runSkillsSync(cleanArgs: string[], isJson: boolean, cwd: string): Promise<void> {
  const check = cleanArgs.includes("--check");
  const force = cleanArgs.includes("--force");
  const dirArg = cleanArgs.slice(1).find(a => !a.startsWith("--"));
  const dir = dirArg ? path.resolve(cwd, dirArg) : userSkillsDir();
  const result = await syncBundledSkills(dir, { check, force });

  if (isJson) {
    console.log(JSON.stringify({ ...result, mode: check ? "check" : force ? "force" : "install" }, null, 2));
  } else if (check) {
    console.log(`\n=== jeo skills sync --check ===\nTarget: ${dir}\n`);
    for (const e of result.entries) console.log(`  ${e.status.padEnd(11)} ${e.name}`);
    console.log(
      result.drift
        ? `\nDrift detected. Run 'jeo skills sync' to install missing skills, or '--force' to overwrite differing local copies.`
        : `\nAll ${result.entries.length} bundled skills are in sync.`,
    );
  } else {
    console.log(`\n=== jeo skills sync ===\nTarget: ${dir}\n`);
    for (const e of result.entries) console.log(`  ${e.action.padEnd(11)} ${e.name}`);
    const preserved = result.entries.filter(e => e.action === "preserved").length;
    console.log(`\nWrote ${result.wrote} file(s)${preserved ? `, preserved ${preserved} local copy(ies) (use --force to overwrite)` : ""}.`);
  }

  // --check is CI-usable: non-zero exit signals drift (gjc `setup defaults --check` parity).
  if (check && result.drift) process.exitCode = 1;
}


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
    const dir = cleanArgs[1] ? path.resolve(cwd, cleanArgs[1]) : path.join(getLocalJeoDir(cwd), "skills");
    await fs.mkdir(dir, { recursive: true });
    for (const s of SKILLS) {
      const file = path.join(dir, `${s.name}.md`);
      await fs.writeFile(file, bundledSkillFileContent(s), "utf-8");
    }
    console.log(`Wrote ${SKILLS.length} skill docs to ${dir}`);
    return;
  }

  // `jeo skills sync [--check|--force] [dir]` — bundled skill inspection & safe install
  // (gjc `setup defaults --check/--force` parity): install missing bundled skills into
  // ~/.jeo/skills, preserve existing local copies by default, and report drift.
  if (cleanArgs[0] === "sync") {
    await runSkillsSync(cleanArgs, isJson, cwd);
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
      console.log("Install/inspect bundled defaults: 'jeo skills sync' (preserve local) · '--check' (drift report) · '--force' (overwrite local)");
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
