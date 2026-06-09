export interface SkillDoc {
  name: string;          // e.g. "deep-interview"
  command: string;       // e.g. "joc deep-interview \"<idea>\""
  summary: string;       // one line
  whenToUse: string;     // one line
  details: string;       // 2-5 lines of guidance
  /** Slash aliases that invoke this skill directly, e.g. `/speckit.plan`. */
  aliases?: string[];
}

export const SKILLS: SkillDoc[] = [
  {
    name: "deep-interview",
    command: 'joc deep-interview "<idea>"',
    summary: "Socratic ambiguity gate, freezes a seed at ambiguity ≤ 20%; --auto for non-interactive.",
    whenToUse: "When an idea is vague and needs requirement gathering and refinement before planning.",
    details: "Initiates a Socratic dialogue to ask clarifying questions about a vague idea.\nScores the ambiguity of the proposal and iterates until it is under 20%.\nSaves a structured requirements seed that can be used by subsequent workflows.\nSupports an --auto flag to skip interaction."
  },
  {
    name: "ralplan",
    command: "joc ralplan",
    summary: "Planner/Architect/Critic blueprint from the seed.",
    whenToUse: "When requirements are clear (e.g. from deep-interview) and you need a robust execution blueprint.",
    details: "Executes a multi-agent critique and planning process to generate a structured implementation plan.\nCombines views from a Planner, an Architect, and a Critic to identify risks, define tasks, and specify files.\nSaves the blueprint for execution."
  },
  {
    name: "team",
    command: "joc team",
    summary: "Per-task executor loop against the plan.",
    whenToUse: "When you have a blueprint/plan and need to execute the concrete implementation tasks.",
    details: "Coordinates execution of individual tasks defined in the blueprint.\nSpawns per-task executor subagents or loops to implement code changes.\nEnsures task-level isolation and tracks implementation status."
  },
  {
    name: "ultragoal",
    command: "joc ultragoal",
    summary: "Verify acceptance criteria, write report.",
    whenToUse: "When tasks are implemented and you need a final, high-level verification and summary report.",
    details: "Verifies the implementation against the acceptance criteria specified in the plan.\nRuns checks, tests, or validations to ensure correctness.\nGenerates a final completion report outlining the changes and verification evidence."
  }
];

export function getSkill(name: string): SkillDoc | undefined {
  return SKILLS.find(s => s.name.toLowerCase() === name.toLowerCase());
}

export function skillNames(): string[] {
  return SKILLS.map(s => s.name);
}

export function formatSkill(s: SkillDoc): string {
  const aliases = skillSlashAliases(s);
  return [
    `Skill: ${s.name}`,
    `Command: ${s.command}`,
    aliases.length ? `Slash aliases: ${aliases.join(", ")}` : undefined,
    `Summary: ${s.summary}`,
    `When to use: ${s.whenToUse}`,
    `Details:`,
    s.details.split("\n").map(line => `  ${line}`).join("\n")
  ].filter(Boolean).join("\n");
}

export function skillsPromptSection(skills: SkillDoc[] = SKILLS): string {
  return skills
    .map(s => {
      const aliases = skillSlashAliases(s);
      return `- ${s.name}${aliases.length ? ` (${aliases.join(", ")})` : ""} — ${s.summary}`;
    })
    .join("\n");
}

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
const BUILTIN_SLASH_ALIASES = new Set([
  "/help", "/clear", "/compact", "/model", "/models", "/provider", "/logout",
  "/agents", "/subagent", "/subagents", "/config", "/roles", "/thinking",
  "/view", "/diff", "/find", "/search", "/sessions", "/skill", "/evolve",
  "/exit", "/quit",
]);

function normalizeSlashAlias(raw: string): string | undefined {
  const m = raw.trim().match(/^\/[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*$/);
  if (!m) return undefined;
  const alias = m[0];
  return BUILTIN_SLASH_ALIASES.has(alias.toLowerCase()) ? undefined : alias;
}

function splitAliasHeader(value: string): string[] {
  return value.split(/[,\s]+/).map(normalizeSlashAlias).filter((a): a is string => !!a);
}

function inferSlashAliases(content: string): string[] {
  const aliases: string[] = [];
  const re = /(?:^|[\s`([{])((\/[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content))) {
    const alias = normalizeSlashAlias(match[1] ?? "");
    if (alias && !aliases.some(a => a.toLowerCase() === alias.toLowerCase())) aliases.push(alias);
  }
  return aliases;
}

function dedupeAliases(aliases: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const alias of aliases) {
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
  }
  return out;
}

export function skillSlashAliases(skill: SkillDoc): string[] {
  return dedupeAliases(skill.aliases ?? []);
}


const MAX_SKILL_SUMMARY_CHARS = 180;
const MAX_SKILL_DETAILS_CHARS = 8_000;
/** Global + per-project skill-doc directories (user-configurable SKILL.md files). */
export function skillDirs(cwd: string = process.cwd()): string[] {
  const home = process.env.JOC_CONFIG_DIR || path.join(os.homedir(), ".joc");
  const configured = (process.env.JOC_SKILLS_DIR ?? "")
    .split(path.delimiter)
    .map(s => s.trim())
    .filter(Boolean);
  return [
    path.join(os.homedir(), ".agents", "skills"),
    path.join(home, "skills"),
    path.join(cwd, ".agents", "skills"),
    path.join(cwd, ".joc", "skills"),
    ...configured,
  ];
}

/** Parse a user skill markdown file into a SkillDoc. Recognizes both the documented
 *  `key: value` header grammar (summary / command / when[ to use] / use) AND the
 *  decorated form emitted by `joc skills --write` (`Skill:` / `When to use:` /
 *  `Details:`), tolerating a leading `# title` and blank separators. Falls back to
 *  inferring the summary from the first body line. */
export function parseSkillMarkdown(name: string, content: string): SkillDoc {
  const meta: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  const HEADER = /^(summary|command|when to use|when|whentouse|use|skill|alias|aliases|slash|slashes)\s*:\s*(.*)$/i;
  let idx = 0;
  // YAML-style frontmatter (the standard agent SKILL.md format): a `---` … `---`
  // block at the very top. `description:` maps to the summary so real skill files
  // never surface a literal "---" summary into the prompt or /skill list.
  while (idx < lines.length && lines[idx]!.trim() === "") idx++;
  if (idx < lines.length && lines[idx]!.trim() === "---") {
    idx++;
    for (; idx < lines.length && lines[idx]!.trim() !== "---"; idx++) {
      const fm = lines[idx]!.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
      if (!fm) continue;
      const key = fm[1]!.toLowerCase().replace(/[\s_-]+/g, "");
      let value = fm[2]!.trim().replace(/^["']|["']$/g, "");
      // YAML block scalar indicator `>` / `|` (with optional chomping `+`/`-`). Also fold in
      // the invalid-but-ubiquitous lead-in form real SKILL.md files use, e.g.
      // `description: Use this skill when >` followed by an indented continuation block —
      // otherwise the summary is the truncated nonsense "Use this skill when >".
      // Require whitespace before the indicator (or the whole value) so a description that
      // merely ENDS in `>` (e.g. "returns <T>") is left intact.
      if (/(?:^|\s)[>|][+-]?$/.test(value)) {
        const lead = value.replace(/\s*[>|][+-]?$/, "").trim();
        const block: string[] = [];
        for (idx++; idx < lines.length && /^\s+/.test(lines[idx] ?? ""); idx++) block.push(lines[idx]!.trim());
        idx--;
        value = [lead, block.join(" ")].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      }
      meta[key] = value;
    }
    if (idx < lines.length) idx++; // consume the closing ---
  }
  // Skip leading blank lines and a single leading markdown title.
  while (idx < lines.length && lines[idx]!.trim() === "") idx++;
  if (idx < lines.length && lines[idx]!.startsWith("# ")) {
    idx++;
    while (idx < lines.length && lines[idx]!.trim() === "") idx++;
  }
  // Parse a leading header block (tolerating blank separators); `Details:` (or the
  // first free line) begins the body.
  let detailsBlock: string[] | null = null;
  for (; idx < lines.length; idx++) {
    const raw = lines[idx]!;
    if (raw.trim() === "") continue;
    const dm = raw.match(/^details\s*:\s*(.*)$/i);
    if (dm) {
      const inline = dm[1]!.trim();
      detailsBlock = inline ? [inline] : [];
      for (idx++; idx < lines.length; idx++) detailsBlock.push(lines[idx]!.replace(/^ {2}/, ""));
      break;
    }
    const m = raw.match(HEADER);
    if (m) { meta[m[1]!.toLowerCase().replace(/\s+/g, "")] = m[2]!.trim(); continue; }
    break;
  }
  const body = (detailsBlock ? detailsBlock.join("\n") : lines.slice(idx).join("\n")).trim();
  const firstLine = body.split("\n").find(l => l.trim())?.trim() ?? "";
  const explicitAliases = [
    ...splitAliasHeader(meta.alias ?? ""),
    ...splitAliasHeader(meta.aliases ?? ""),
    ...splitAliasHeader(meta.slash ?? ""),
    ...splitAliasHeader(meta.slashes ?? ""),
  ];
  const rawSummary = meta.summary ?? meta.description ?? firstLine;
  const summary = rawSummary ? (rawSummary.length > MAX_SKILL_SUMMARY_CHARS ? rawSummary.slice(0, MAX_SKILL_SUMMARY_CHARS - 1) + "…" : rawSummary) : name;
  const details = body
    ? (body.length > MAX_SKILL_DETAILS_CHARS ? body.slice(0, MAX_SKILL_DETAILS_CHARS - 1) + "…" : body)
    : "(no details)";
  return {
    name,
    command: meta.command ?? `/skill ${name}`,
    summary,
    whenToUse: meta.whentouse ?? meta.when ?? meta.use ?? "",
    details,
    aliases: dedupeAliases([...explicitAliases, ...inferSlashAliases(content)]),
  };
}

/** Bundled skills merged with user skill docs from {@link skillDirs} (user overrides by name). */
export async function loadSkills(cwd: string = process.cwd()): Promise<SkillDoc[]> {
  const byName = new Map<string, SkillDoc>(SKILLS.map(s => [s.name.toLowerCase(), s]));
  for (const dir of skillDirs(cwd)) {
    let entries: import("node:fs").Dirent[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const nm = entry.name.slice(0, -3);
        try {
          byName.set(nm.toLowerCase(), parseSkillMarkdown(nm, await fs.readFile(path.join(dir, entry.name), "utf-8")));
        } catch { /* skip unreadable file */ }
        continue;
      }
      if (entry.isDirectory()) {
        const skillPath = path.join(dir, entry.name, "SKILL.md");
        try {
          byName.set(entry.name.toLowerCase(), parseSkillMarkdown(entry.name, await fs.readFile(skillPath, "utf-8")));
        } catch { /* skip dirs without SKILL.md or unreadable files */ }
      }
    }
  }
  return [...byName.values()];
}

/** Case-insensitive lookup within a resolved skill list. */
export function getSkillFrom(skills: SkillDoc[], name: string): SkillDoc | undefined {
  return skills.find(s => s.name.toLowerCase() === name.toLowerCase());
}

/** Case-insensitive lookup by direct slash alias, e.g. `/speckit.plan`. */
export function getSkillBySlash(skills: SkillDoc[], command: string): SkillDoc | undefined {
  const q = command.toLowerCase();
  return skills.find(s => skillSlashAliases(s).some(a => a.toLowerCase() === q));
}
