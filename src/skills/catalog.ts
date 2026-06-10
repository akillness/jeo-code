import deepInterviewSkillRaw from "../prompts/skills/deep-interview/SKILL.md" with { type: "text" };
import ralplanSkillRaw from "../prompts/skills/ralplan/SKILL.md" with { type: "text" };
import teamSkillRaw from "../prompts/skills/team/SKILL.md" with { type: "text" };
import ultragoalSkillRaw from "../prompts/skills/ultragoal/SKILL.md" with { type: "text" };
import gjcSkillRaw from "../prompts/skills/gjc/SKILL.md" with { type: "text" };

const MAX_SKILL_SUMMARY_CHARS = 180;
const MAX_SKILL_DETAILS_CHARS = 8_000;
const MAX_SKILLS_PROMPT_LINES = 40;
const MAX_SKILLS_PROMPT_CHARS = 6_000;

export interface SkillDoc {
  name: string;          // e.g. "deep-interview"
  command: string;       // e.g. "joc deep-interview \"<idea>\""
  summary: string;       // one line
  whenToUse: string;     // one line
  details: string;       // 2-5 lines of guidance
  /** Slash aliases that invoke this skill directly, e.g. `/speckit.plan`. */
  aliases?: string[];
  raw?: string;
}

export const SKILLS: SkillDoc[] = [
  parseSkillMarkdown("deep-interview", deepInterviewSkillRaw),
  parseSkillMarkdown("ralplan", ralplanSkillRaw),
  parseSkillMarkdown("team", teamSkillRaw),
  parseSkillMarkdown("ultragoal", ultragoalSkillRaw),
  parseSkillMarkdown("gjc", gjcSkillRaw),
];
export const BUILTIN_SKILL_NAMES = SKILLS.map(s => s.name.toLowerCase());

export function workflowSkillsForPrompt(skills?: SkillDoc[]): SkillDoc[] {
  if (!skills) {
    return SKILLS;
  }
  const result: SkillDoc[] = [];
  const bundleNames = new Set(BUILTIN_SKILL_NAMES);
  
  result.push(...SKILLS);

  for (const s of skills) {
    if (!bundleNames.has(s.name.toLowerCase())) {
      result.push(s);
    }
  }
  return result;
}


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

function compactSkillExecutionBrief(skill: SkillDoc): string {
  const aliases = skillSlashAliases(skill);
  let details = skill.details;
  if (details.length > 2400) {
    details = details.slice(0, 2400) + "…";
  }
  return [
    `Name: ${skill.name}`,
    aliases.length ? `Slash aliases: ${aliases.join(", ")}` : undefined,
    `Summary: ${skill.summary}`,
    skill.whenToUse ? `When to use: ${skill.whenToUse}` : undefined,
    "Guidance:",
    ...details.split("\n").map(line => `  ${line}`),
  ].filter(Boolean).join("\n");
}

/**
 * Build the agent task that EXECUTES a skill's workflow (rather than merely echoing
 * the doc or — as weak models do — calling a bogus tool named after the skill). The
 * skill text is injected as GUIDANCE and the agent is told to use its real tools.
 */
export function buildSkillTask(skill: SkillDoc, intent: string, invokedAs?: string): string {
  const requested = invokedAs ? `Invoked as: ${invokedAs}\n` : "";
  return [
    `You are now executing the "${skill.name}" workflow skill in this repository.`,
    `IMPORTANT: this skill is GUIDANCE for you — it is NOT a callable tool. Do NOT emit a tool call named "${skill.name}". Use your real tools (read, write, edit, bash, find, search, ls, task, todo) to carry out the work, then call done with a short summary.`,
    `You must never quote or recite the guidance text as your reply; the done reason must describe actual work/outcome.`,
    "",
    `<skill_guidance name="${skill.name}">`,
    compactSkillExecutionBrief(skill),
    `</skill_guidance>`,
    "",
    requested +
      (intent
        ? `User intent: ${intent}`
        : "Carry out this skill's workflow now. If it needs a concrete target you weren't given, make a reasonable assumption or ask the user via done."),
  ].join("\n");
}
export function skillsPromptSection(skills: SkillDoc[] = SKILLS): string {
  const bundleSkills: SkillDoc[] = [];
  const configuredSkills: SkillDoc[] = [];

  const bundleNames = new Set(BUILTIN_SKILL_NAMES);
  for (const s of skills) {
    if (bundleNames.has(s.name.toLowerCase())) {
      bundleSkills.push(s);
    } else {
      configuredSkills.push(s);
    }
  }

  const lines: string[] = [];
  let used = 0;

  function tryAppend(line: string): boolean {
    if (lines.length >= MAX_SKILLS_PROMPT_LINES) return false;
    if (used + line.length + 1 > MAX_SKILLS_PROMPT_CHARS) return false;
    lines.push(line);
    used += line.length + 1;
    return true;
  }

  // 1. Bundled workflow skills
  if (bundleSkills.length > 0) {
    if (tryAppend("Bundled workflow skills:")) {
      for (const [i, s] of bundleSkills.entries()) {
        const aliases = skillSlashAliases(s);
        const line = `- ${s.name}${aliases.length ? ` (${aliases.join(", ")})` : ""} — ${s.summary}`;
        if (!tryAppend(line)) {
          const remaining = bundleSkills.length - i;
          lines.push(`- … ${remaining} more skill(s) omitted for brevity`);
          break;
        }
      }
    } else {
      lines.push(`- … ${bundleSkills.length} more skill(s) omitted for brevity`);
    }
  }

  // 2. Configured skills
  if (configuredSkills.length > 0) {
    const isBudgetFull = lines.length >= MAX_SKILLS_PROMPT_LINES || used >= MAX_SKILLS_PROMPT_CHARS;
    if (isBudgetFull) {
      lines.push(`- … ${configuredSkills.length} more skill(s) omitted for brevity`);
    } else {
      const spaceAdded = tryAppend("");
      const titleAdded = tryAppend("Configured skills:");
      
      if (titleAdded) {
        for (const [i, s] of configuredSkills.entries()) {
          const aliases = skillSlashAliases(s);
          const line = `- ${s.name}${aliases.length ? ` (${aliases.join(", ")})` : ""} — ${s.summary}`;
          if (!tryAppend(line)) {
            const remaining = configuredSkills.length - i;
            lines.push(`- … ${remaining} more skill(s) omitted for brevity`);
            break;
          }
        }
      } else {
        if (spaceAdded && lines[lines.length - 1] === "") {
          lines.pop();
        }
        lines.push(`- … ${configuredSkills.length} more skill(s) omitted for brevity`);
      }
    }
  }

  return lines.join("\n");
}

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { existsSync, statSync, readFileSync } from "node:fs";

export function tryResolveSkillFromFilePath(filePath: string): SkillDoc | null {
  try {
    let targetPath = path.resolve(filePath);
    if (!existsSync(targetPath)) {
      return null;
    }
    const stat = statSync(targetPath);
    if (stat.isDirectory()) {
      const skillMd = path.join(targetPath, "SKILL.md");
      if (existsSync(skillMd) && statSync(skillMd).isFile()) {
        targetPath = skillMd;
      } else {
        return null;
      }
    } else if (!stat.isFile() || !targetPath.endsWith(".md")) {
      return null;
    }

    const content = readFileSync(targetPath, "utf-8");
    // Determine a name for this skill
    let skillName = path.basename(targetPath, ".md");
    if (skillName.toLowerCase() === "skill" || skillName.toLowerCase() === "readme") {
      // Use the directory name if the filename is generic
      skillName = path.basename(path.dirname(targetPath));
    }
    const parsed = parseSkillMarkdown(skillName, content);
    return isSupportedExternalSkill(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
const BUILTIN_SLASH_ALIASES = new Set([
  "/help", "/clear", "/compact", "/model", "/models", "/provider", "/logout",
  "/agents", "/config", "/roles", "/thinking",
  "/view", "/diff", "/find", "/search", "/sessions", "/skill", "/evolve",
  "/exit", "/quit",
]);

const RESERVED_SKILL_NAMES = new Set(
  [...BUILTIN_SLASH_ALIASES].map(alias => alias.slice(1).toLowerCase())
);

function normalizeSlashAlias(raw: string): string | undefined {
  const m = raw.trim().match(/^\/[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*$/);
  if (!m) return undefined;
  const alias = m[0];
  return BUILTIN_SLASH_ALIASES.has(alias.toLowerCase()) ? undefined : alias;
}

function splitAliasHeader(value: string): string[] {
  return value.split(/[,\s]+/).map(normalizeSlashAlias).filter((a): a is string => !!a);
}

function aliasOwner(alias: string): string {
  return alias.slice(1).split(".", 1)[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
}

function skillAliasOwners(name: string): Set<string> {
  const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const owners = new Set([sanitize(name)]);
  // Namespaced skills (e.g. "oh-my-claudecode:team") also own aliases for their
  // last segment, so "/team" inside that skill's doc is still self-owned.
  const last = name.split(/[:/]/).pop();
  if (last) owners.add(sanitize(last));
  owners.delete("");
  return owners;
}

function inferSlashAliases(content: string, skillName: string): string[] {
  const aliases: string[] = [];
  const owners = skillAliasOwners(skillName);
  const re = /(?:^|[\s`([{])((\/[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content))) {
    const alias = normalizeSlashAlias(match[1] ?? "");
    if (!alias || !owners.has(aliasOwner(alias))) continue;
    if (!aliases.some(a => a.toLowerCase() === alias.toLowerCase())) aliases.push(alias);
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
    aliases: dedupeAliases([...explicitAliases, ...inferSlashAliases(content, name)]),
    raw: content,
  };
}

function isSupportedExternalSkill(doc: SkillDoc): boolean {
  return !RESERVED_SKILL_NAMES.has(doc.name.toLowerCase());
}

/** Bundled skills merged with user skill docs from {@link skillDirs} (user overrides by name). */
export async function loadSkills(cwd: string = process.cwd()): Promise<SkillDoc[]> {
  const byName = new Map<string, SkillDoc>(SKILLS.map(s => [s.name.toLowerCase(), s]));
  for (const dir of skillDirs(cwd)) {
    let entries: import("node:fs").Dirent[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const nm = entry.name.slice(0, -3);
        try {
          const parsed = parseSkillMarkdown(nm, await fs.readFile(path.join(dir, entry.name), "utf-8"));
          if (isSupportedExternalSkill(parsed)) byName.set(nm.toLowerCase(), parsed);
        } catch { /* skip unreadable file */ }
        continue;
      }
      if (entry.isDirectory()) {
        const skillPath = path.join(dir, entry.name, "SKILL.md");
        try {
          const parsed = parseSkillMarkdown(entry.name, await fs.readFile(skillPath, "utf-8"));
          if (isSupportedExternalSkill(parsed)) byName.set(entry.name.toLowerCase(), parsed);
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

export interface SkillInvocation {
  skill: SkillDoc;
  intent: string;
  invokedAs?: string;
}

/** Parse only explicit skill invocations. Ambient mentions of skill names or slash
 * aliases inside a broader prompt are deliberately ignored so pasted SKILL.md files
 * cannot hijack an ordinary coding request. */
export function parseSkillInvocation(input: string, skills: SkillDoc[]): SkillInvocation | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const explicitEntrypoint = trimmed.startsWith("/skill:")
    ? "/skill:"
    : (trimmed === "/skill" || trimmed.startsWith("/skill ")) ? "/skill" : "";
  if (explicitEntrypoint) {
    const rest = trimmed.substring(explicitEntrypoint.length).trim();
    if (!rest) return null;
    const [name, ...intentParts] = rest.split(/\s+/);
    let skill = getSkillFrom(skills, name ?? "");
    if (!skill && name) {
      skill = tryResolveSkillFromFilePath(name) ?? undefined;
    }
    return skill ? { skill, intent: intentParts.join(" ").trim() } : null;
  }

  const command = trimmed.split(/\s+/, 1)[0] ?? "";
  let skill = getSkillBySlash(skills, command);
  if (!skill) {
    if (command.startsWith("/") || command.startsWith(".") || command.includes("/")) {
      const resolved = tryResolveSkillFromFilePath(command);
      if (resolved) {
        return { skill: resolved, intent: trimmed.slice(command.length).trim(), invokedAs: command };
      }
    }
  }
  return skill ? { skill, intent: trimmed.slice(command.length).trim(), invokedAs: command } : null;
}
export function looksLikeSkillEcho(reply: string, skills: SkillDoc[]): boolean {
  if (reply.length < 80) {
    return false;
  }

  const lines = reply.split(/\r?\n/);

  // Heuristic 1: Contains <skill_guidance or a line starting with "Skill: " AND a line starting with "When to use:"
  if (reply.includes("<skill_guidance")) {
    return true;
  }
  const hasSkillLine = lines.some(l => l.trim().startsWith("Skill: "));
  const hasWhenToUseLine = lines.some(l => l.trim().startsWith("When to use:"));
  if (hasSkillLine && hasWhenToUseLine) {
    return true;
  }

  // Heuristic 2: >= 3 reply lines are near-verbatim matches (trimmed, case-insensitive)
  // of skill summary lines or of "- <name> — <summary>" lines that skillsPromptSection would emit
  const targets = new Set<string>();
  for (const s of skills) {
    if (s.summary) {
      targets.add(s.summary.trim().toLowerCase());
    }
    const aliases = skillSlashAliases(s);
    const promptLine = `- ${s.name}${aliases.length ? ` (${aliases.join(", ")})` : ""} — ${s.summary}`;
    targets.add(promptLine.trim().toLowerCase());
  }

  let matchCount = 0;
  for (const line of lines) {
    const trimmedLine = line.trim().toLowerCase();
    if (targets.has(trimmedLine)) {
      matchCount++;
    }
  }
  if (matchCount >= 3) {
    return true;
  }

  // Heuristic 3: Contains a verbatim chunk (>= 160 consecutive chars) of any skill's details
  // (only check first 50 skills, and only those with details length >= 160, using start/middle/end probes)
  const checkedSkills = skills.slice(0, 50);
  for (const s of checkedSkills) {
    const details = s.details;
    if (!details || details.length < 160) {
      continue;
    }
    const len = details.length;
    const startProbe = details.slice(0, 160);
    const midStart = Math.floor((len - 160) / 2);
    const midProbe = details.slice(midStart, midStart + 160);
    const endProbe = details.slice(len - 160);

    if (reply.includes(startProbe) || reply.includes(midProbe) || reply.includes(endProbe)) {
      return true;
    }
  }

  return false;
}
