import deepInterviewSkillRaw from "../prompts/skills/deep-interview/SKILL.md" with { type: "text" };
import deepDiveSkillRaw from "../prompts/skills/deep-dive/SKILL.md" with { type: "text" };
import ralplanSkillRaw from "../prompts/skills/ralplan/SKILL.md" with { type: "text" };
import teamSkillRaw from "../prompts/skills/team/SKILL.md" with { type: "text" };
import ultragoalSkillRaw from "../prompts/skills/ultragoal/SKILL.md" with { type: "text" };

const MAX_SKILL_SUMMARY_CHARS = 180;
const MAX_SKILL_DETAILS_CHARS = 8_000;
const MAX_SKILLS_PROMPT_LINES = 40;
const MAX_SKILLS_PROMPT_CHARS = 6_000;

export interface SkillDoc {
  name: string;          // e.g. "deep-interview"
  command: string;       // e.g. "jeo deep-interview \"<idea>\""
  summary: string;       // one line
  whenToUse: string;     // one line
  details: string;       // 2-5 lines of guidance
  /** Slash aliases that invoke this skill directly, e.g. `/speckit.plan`. */
  aliases?: string[];
  /** Source SKILL.md path for discovered skills; absent for bundled skills. */
  sourcePath?: string;
  raw?: string;
}

export const SKILLS: SkillDoc[] = [
  parseSkillMarkdown("deep-interview", deepInterviewSkillRaw),
  parseSkillMarkdown("deep-dive", deepDiveSkillRaw),
  parseSkillMarkdown("ralplan", ralplanSkillRaw),
  parseSkillMarkdown("team", teamSkillRaw),
  parseSkillMarkdown("ultragoal", ultragoalSkillRaw),
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

/** Canonical on-disk content for a bundled skill — the exact bytes `jeo skills
 *  --write` / `jeo skills sync` materialize into a `<name>.md` file. Prefers the
 *  original SKILL.md text; falls back to a decorated render for skills without raw. */
export function bundledSkillFileContent(s: SkillDoc): string {
  return s.raw || `# ${s.name}\n\n${formatSkill(s)}\n`;
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

import { jeoEnv } from "../util/env";

const BUILTIN_SLASH_ALIASES = new Set([
  "/help", "/clear", "/compact", "/model", "/fast", "/provider", "/logout",
  "/agents", "/config", "/roles", "/thinking",
  "/view", "/diff", "/find", "/search",
  "/exit", "/quit",
]);

const RESERVED_SKILL_NAMES = new Set([
  ...[...BUILTIN_SLASH_ALIASES].map(alias => alias.slice(1).toLowerCase()),
  "skill",
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


/** User-level bundled-skills install dir (`<config>/skills`, i.e. `~/.jeo/skills`
 *  honoring JEO_CONFIG_DIR / $HOME) — the highest-precedence flat skill dir and the
 *  destination `jeo skills sync` reconciles against. $HOME wins over os.homedir() so
 *  tests/sandboxes that re-point HOME are honored (see {@link skillDirs}). */
export function userSkillsDir(): string {
  const userHome = process.env.HOME || os.homedir();
  return path.join(jeoEnv("CONFIG_DIR") || path.join(userHome, ".jeo"), "skills");
}

/** Global + per-project skill-doc directories (user-configurable SKILL.md files).
 *  Ordered lowest → highest precedence (a later dir's skill overrides an earlier
 *  one with the same name): foreign-ecosystem roots first, jeo-native last.
 *  Covered install layouts:
 *  - Vercel `npx skills add [-g]` canonical store: `.agents/skills/` (project + ~)
 *  - Vercel agent-targeted installs (`-a claude-code`): `.claude/skills/` (project + ~)
 *  - jeo agent skills (self-contained `.jeo` namespace, gjc-structure parity):
 *    `<config>/agent/skills/` (+ project `<cwd>/.jeo/agent/skills/`)
 *  - jeo-native flat: `<config>/skills/`, `<cwd>/.jeo/skills/`, then `JEO_SKILLS_DIR`. */
export function skillDirs(cwd: string = process.cwd()): string[] {
  // $HOME wins over os.homedir(): Bun caches the system home, so tests (and
  // sandboxed runs) that re-point HOME would otherwise still scan the real one.
  const userHome = process.env.HOME || os.homedir();
  const home = jeoEnv("CONFIG_DIR") || path.join(userHome, ".jeo");
  const configured = (jeoEnv("SKILLS_DIR") ?? "")
    .split(path.delimiter)
    .map(s => s.trim())
    .filter(Boolean);
  return [
    path.join(userHome, ".claude", "skills"),
    path.join(home, "agent", "skills"),
    path.join(userHome, ".agents", "skills"),
    userSkillsDir(),
    path.join(cwd, ".claude", "skills"),
    path.join(cwd, ".agents", "skills"),
    path.join(cwd, ".jeo", "skills"),
    path.join(cwd, ".jeo", "agent", "skills"),
    ...configured,
  ];
}

/** A frontmatter `name:` usable as a skill identity: one bare token, no spaces. */
function sanitizeSkillName(raw: string | undefined): string | undefined {
  const m = (raw ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(m) ? m : undefined;
}

/** Parse a user skill markdown file into a SkillDoc. Recognizes both the documented
 *  `key: value` header grammar (summary / command / when[ to use] / use) AND the
 *  decorated form emitted by `jeo skills --write` (`Skill:` / `When to use:` /
 *  `Details:`), tolerating a leading `# title` and blank separators. Falls back to
 *  inferring the summary from the first body line. */
export function parseSkillMarkdown(name: string, content: string, opts?: { preferMetaName?: boolean }): SkillDoc {
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
  // External (Vercel/agent-skills standard) SKILL.md files carry their identity in
  // the frontmatter `name:`; honor it over the directory/file name when the caller
  // opts in — bundled skills keep their fixed constructor names.
  const docName = (opts?.preferMetaName ? sanitizeSkillName(meta.name) : undefined) ?? name;
  return {
    name: docName,
    command: meta.command ?? `/skill ${docName}`,
    summary,
    whenToUse: meta.whentouse ?? meta.when ?? meta.use ?? "",
    details,
    aliases: dedupeAliases([...explicitAliases, ...inferSlashAliases(content, docName)]),
    raw: content,
  };
}

const ALLOWED_SKILL_NAMES = new Set([
  "deep-interview",
  "deep-dive",
  "ralplan",
  "team",
  "ultragoal",
  "research",
  "ultrawork"
]);

function isSupportedExternalSkill(doc: SkillDoc): boolean {
  const nameLower = doc.name.toLowerCase();
  return !RESERVED_SKILL_NAMES.has(nameLower);
}

/** Bundled skills merged with user skill docs from {@link skillDirs} (user overrides by name). */
export async function loadSkills(cwd: string = process.cwd()): Promise<SkillDoc[]> {
  try {
    const lockPath = path.join(cwd, "skills-lock.json");
    const lockContent = await fs.readFile(lockPath, "utf-8");
    const lockData = JSON.parse(lockContent);
    if (lockData && lockData.skills) {
      for (const name of Object.keys(lockData.skills)) {
        ALLOWED_SKILL_NAMES.add(name.toLowerCase());
      }
    }
  } catch {}
  const byName = new Map<string, SkillDoc>(SKILLS.map(s => [s.name.toLowerCase(), s]));
  for (const dir of skillDirs(cwd)) {
    let entries: import("node:fs").Dirent[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      let isFile = entry.isFile();
      let isDir = entry.isDirectory();
      // Vercel `npx skills add` links agent dirs (.claude/skills/x) to its canonical
      // store — a symlinked skill reports NEITHER isFile nor isDirectory on the
      // Dirent, which silently dropped every linked skill. Follow the link.
      if (entry.isSymbolicLink()) {
        try {
          const st = await fs.stat(path.join(dir, entry.name));
          isFile = st.isFile();
          isDir = st.isDirectory();
        } catch { continue; /* broken symlink */ }
      }
      if (isFile && entry.name.endsWith(".md")) {
        const nm = entry.name.slice(0, -3);
        try {
          const parsed = parseSkillMarkdown(nm, await fs.readFile(path.join(dir, entry.name), "utf-8"), { preferMetaName: true });
          parsed.sourcePath = path.join(dir, entry.name);
          if (isSupportedExternalSkill(parsed)) byName.set(parsed.name.toLowerCase(), parsed);
        } catch { /* skip unreadable file */ }
        continue;
      }
      if (isDir) {
        const skillPath = path.join(dir, entry.name, "SKILL.md");
        try {
          const parsed = parseSkillMarkdown(entry.name, await fs.readFile(skillPath, "utf-8"), { preferMetaName: true });
          parsed.sourcePath = skillPath;
          if (isSupportedExternalSkill(parsed)) byName.set(parsed.name.toLowerCase(), parsed);
        } catch { /* skip dirs without SKILL.md or unreadable files */ }
      }
    }
  }
  return [...byName.values()];
}

/** gjc-style skill-invocation card body (the `[skill]` block shown in the TUI
 *  when `$name`//skill runs): name, resolved SKILL.md path (or the bundled
 *  module path), and the prompt size actually injected. Pure — testable. */
export function skillInvocationCard(skill: SkillDoc, intent?: string): string[] {
  const promptLines = (skill.raw ?? skill.details ?? "").split("\n").filter(l => l.trim().length > 0).length;
  // jeo-ref tree-connector detail: the skill name leads, resolved metadata hangs
  // off ├─/└─ connectors so the card scans like the reference's Skill panel. The
  // intent (when given) is shown here so it isn't lost — the injected SKILL.md is
  // NOT echoed as a user box (gjc-style: compact card, not the raw doc).
  const trimmedIntent = intent?.trim();
  const intentLine = trimmedIntent
    ? [`├─ intent: ${trimmedIntent.length > 88 ? `${trimmedIntent.slice(0, 87)}…` : trimmedIntent}`]
    : [];
  return [
    `Skill: ${skill.name}`,
    `├─ path: ${skill.sourcePath ?? `(bundled) src/prompts/skills/${skill.name}/SKILL.md`}`,
    ...intentLine,
    `└─ prompt: ${promptLines} lines`,
  ];
}

/** Case-insensitive lookup within a resolved skill list. */
export function getSkillFrom(skills: SkillDoc[], name: string): SkillDoc | undefined {
  return skills.find(s => s.name.toLowerCase() === name.toLowerCase());
}

/** The single skill whose name PREFIX-matches `query` (case-insensitive), or undefined
 *  when zero or many match. Lets `$te` precisely resolve to `$team` without full spelling. */
export function uniquePrefixSkill(skills: SkillDoc[], query: string): SkillDoc | undefined {
  const q = query.toLowerCase();
  if (!q) return undefined;
  const hits = skills.filter(s => s.name.toLowerCase().startsWith(q));
  return hits.length === 1 ? hits[0] : undefined;
}

/** Prefix-first, then fuzzy-subsequence skill suggestions for a `$query` that did NOT
 *  resolve — drives the REPL's clear "did you mean / available" feedback. */
export function suggestSkills(skills: SkillDoc[], query: string): SkillDoc[] {
  const q = query.toLowerCase();
  const prefix = skills.filter(s => s.name.toLowerCase().startsWith(q));
  const seen = new Set(prefix.map(s => s.name));
  const fuzzy = skills.filter(s => !seen.has(s.name) && skillNameSubsequence(q, s.name.toLowerCase()));
  return [...prefix, ...fuzzy];
}

/** Order-preserving subsequence test (every char of `needle` appears in `hay` L→R). */
function skillNameSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i++;
  return i === needle.length;
}

/** Case-insensitive lookup by direct slash alias, e.g. `/speckit.plan`. */
export function getSkillBySlash(skills: SkillDoc[], command: string): SkillDoc | undefined {
  const q = command.toLowerCase();
  return skills.find(s => skillSlashAliases(s).some(a => a.toLowerCase() === q));
}

/** Resolve a leading `/alias` slash command to the skill that DECLARES it, e.g.
 *  `/obsidian-capture note text` → { skill, intent: "note text", invokedAs: "/obsidian-capture" }.
 *  Returns null when the first token is not a declared skill slash alias. This is what lets an
 *  installed skill add real, dispatchable `/` commands (not just routing-hint metadata): only the
 *  FIRST token is matched, and the rest of the line becomes the intent passed to the skill. */
export function parseSkillSlashInvocation(input: string, skills: SkillDoc[]): SkillInvocation | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const command = trimmed.split(/\s+/, 1)[0] ?? "";
  const skill = getSkillBySlash(skills, command);
  if (!skill) return null;
  return { skill, intent: trimmed.slice(command.length).trim(), invokedAs: command };
}

export interface SkillInvocation {
  skill: SkillDoc;
  intent: string;
  invokedAs?: string;
}
/** Parse only an explicit `$skill` invocation. Skills are invokable ONLY via the `$`
 * entrypoint — `/` commands and slash aliases never load a skill file, and pasted SKILL.md
 * paths cannot hijack an ordinary coding request. Only the FIRST token counts, and only
 * when a skill with that exact name (or unique name prefix) is loaded; `$HOME is what?` or
 * any unknown `$word` falls through to the model as an ordinary prompt. */
export function parseSkillInvocation(input: string, skills: SkillDoc[]): SkillInvocation | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const command = trimmed.split(/\s+/, 1)[0] ?? "";
  if (command.length > 1 && command.startsWith("$")) {
    const dollarSkill = getSkillFrom(skills, command.slice(1)) ?? uniquePrefixSkill(skills, command.slice(1));
    if (dollarSkill) {
      return { skill: dollarSkill, intent: trimmed.slice(command.length).trim(), invokedAs: command };
    }
  }
  return null;
}
/** Parse a LEADING run of `$skill` tokens into an ordered chain that shares the trailing
 *  text as one intent: `$ralplan $team build auth` → [ralplan, team] each with intent
 *  "build auth". This is what lets `$` invoke several skills in one line — they all run,
 *  in order. Scanning stops at the first non-`$` token, OR a `$UPPERCASE` env-var-style
 *  token (e.g. `$HOME`), which is left in the intent so shell-style references pass through.
 *  Each `$name` resolves by exact name then unique prefix; names that resolve to nothing go
 *  into `unresolved` (so the REPL can report every typo, not just the first). Returns null
 *  only when the input opens with no parseable `$skill` token at all. */
export function parseSkillChain(
  input: string,
  skills: SkillDoc[],
): { invocations: SkillInvocation[]; unresolved: string[] } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("$")) return null;
  const tokens = trimmed.split(/\s+/);
  const invocations: SkillInvocation[] = [];
  const unresolved: string[] = [];
  let i = 0;
  for (; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    if (!tok.startsWith("$") || tok.length < 2) break;
    const name = tok.slice(1);
    if (/^[A-Z_][A-Z0-9_]*$/.test(name)) break; // env-var-style → boundary; keep in intent
    const skill = getSkillFrom(skills, name) ?? uniquePrefixSkill(skills, name);
    if (skill) invocations.push({ skill, intent: "", invokedAs: tok });
    else unresolved.push(name);
  }
  if (invocations.length === 0 && unresolved.length === 0) return null;
  const intent = tokens.slice(i).join(" ").trim();
  return { invocations: invocations.map(inv => ({ ...inv, intent })), unresolved };
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
