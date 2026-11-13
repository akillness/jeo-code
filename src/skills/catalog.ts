import deepInterviewSkillRaw from "../prompts/skills/deep-interview/SKILL.md" with { type: "text" };
import deepDiveSkillRaw from "../prompts/skills/deep-dive/SKILL.md" with { type: "text" };
import ralplanSkillRaw from "../prompts/skills/ralplan/SKILL.md" with { type: "text" };
import teamSkillRaw from "../prompts/skills/team/SKILL.md" with { type: "text" };
import ultragoalSkillRaw from "../prompts/skills/ultragoal/SKILL.md" with { type: "text" };
import karpathyGuidelinesSkillRaw from "../prompts/skills/karpathy-guidelines/SKILL.md" with { type: "text" };

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
  /** Original-to-snapshot paths for explicitly approved sandbox resources. */
  sandboxResources?: Array<{ source: string; snapshot: string }>;
  raw?: string;
}

export const SKILLS: SkillDoc[] = [
  parseSkillMarkdown("deep-interview", deepInterviewSkillRaw),
  parseSkillMarkdown("deep-dive", deepDiveSkillRaw),
  parseSkillMarkdown("ralplan", ralplanSkillRaw),
  parseSkillMarkdown("team", teamSkillRaw),
  parseSkillMarkdown("ultragoal", ultragoalSkillRaw),
  parseSkillMarkdown("karpathy-guidelines", karpathyGuidelinesSkillRaw),
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
    ...(skill.sandboxResources?.length ? ["Only the following skill resource files are authorized. Use their snapshot paths instead of the original paths:", ...skill.sandboxResources.map(resource => `${resource.source} -> ${resource.snapshot}`), ""] : []),
    "",
    requested +
      (intent
        ? `User intent: ${intent}`
        : "Carry out this skill's workflow now. If it needs a concrete target you weren't given, make a reasonable assumption or ask the user via done."),
  ].join("\n");
}
const TASK_STOPWORDS: Record<string, true> = {
  the: true, and: true, for: true, with: true, use: true, this: true, that: true, from: true, into: true,
  you: true, your: true, can: true, please: true, make: true,
};
const isAscii = (text: string): boolean => /^[\x00-\x7f]+$/.test(text);

/** Words of any script (Korean, Japanese, Chinese included), lowercased; ASCII needs 3+ chars, others 2+. */
function relevanceTokens(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? [];
  return new Set(words.filter(w => w.length >= (isAscii(w) ? 3 : 2) && TASK_STOPWORDS[w] !== true));
}

/**
 * How well a skill fits a task. An exact name (+20) or a name part (+10) match always outranks
 * description matches, which add at most +8 so a chatty description cannot beat an explicit name.
 * Non-ASCII words carry no spaces or inflection boundaries ("설치해줘"), so they match a description
 * as a substring either way round.
 */
function skillRelevance(skill: SkillDoc, task: Set<string>): number {
  const name = skill.name.toLowerCase();
  const score = (task.has(name) ? 20 : 0) + (name.split(/[._-]/).some(part => task.has(part)) ? 10 : 0);
  const description = `${skill.summary} ${skill.whenToUse}`.toLowerCase();
  const words = relevanceTokens(description);
  let hits = 0;
  for (const token of task) {
    if (isAscii(token) ? words.has(token) : description.includes(token) || [...words].some(w => !isAscii(w) && token.includes(w))) hits++;
  }
  return score + Math.min(hits, 8);
}

export function skillsPromptSection(skills: SkillDoc[] = SKILLS, currentTask?: string): string {
  const bundleSkills: SkillDoc[] = [];
  let configuredSkills: SkillDoc[] = [];

  const bundleNames = new Set(BUILTIN_SKILL_NAMES);
  for (const s of skills) {
    if (bundleNames.has(s.name.toLowerCase())) {
      bundleSkills.push(s);
    } else {
      configuredSkills.push(s);
    }
  }

  // When a task is provided and skills exceed budget, rank configured skills by relevance (stable for ties).
  if (currentTask && currentTask.trim().length > 0 && configuredSkills.length > 5) {
    const task = relevanceTokens(currentTask);
    configuredSkills = configuredSkills
      .map((skill, index) => ({ skill, index, score: skillRelevance(skill, task) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map(entry => entry.skill);
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
import { constants as fsConstants, closeSync, fstatSync, lstatSync, readSync, realpathSync } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { dlopen } from "bun:ffi";

import { jeoEnv } from "../util/env";
import { currentSandboxExecution } from "../agent/hooks";
import type { SandboxSupervisor } from "../agent/sandbox/types";
import { canonicalSandboxPath, nativeSandboxHome } from "../agent/sandbox/policy";

async function sandboxSkillCatalog<T>(action: string, cwd: string, args: Record<string, unknown> = {}): Promise<T> {
  const sandbox = currentSandboxExecution();
  if (!sandbox) throw new Error("SANDBOX_SKILLS: missing execution scope");
  const result = await sandbox.supervisor.call("__workflow", { operation: "skillCatalog", action, ...args }, { cwd, signal: sandbox.signal });
  if (!result.success) throw new Error(result.error || "SANDBOX_SKILLS: operation failed");
  return JSON.parse(result.output) as T;
}

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
 *  - jeo agent skills (self-contained `.jeo` namespace):
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
    path.join(userHome, ".agent-skills"),
    userSkillsDir(),
    path.join(cwd, ".claude", "skills"),
    path.join(cwd, ".agents", "skills"),
    path.join(cwd, ".agent-skills"),
    path.join(cwd, ".jeo", "skills"),
    path.join(cwd, ".jeo", "agent", "skills"),
    ...configured,
  ];
}

/** Fixed user skill stores only: never turn a redirected root or a configured
 * arbitrary directory into guest authority. Descendant symlinks remain subject
 * to the sandbox's normal path restrictions. */
export async function nativeSandboxSkillRoots(cwd: string): Promise<string[]> {
  const home = await canonicalSandboxPath(await nativeSandboxHome());
  const allowed = new Set([
    path.join(home, ".claude", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(home, ".agent-skills"),
    path.join(home, ".jeo", "agent", "skills"),
    path.join(home, ".jeo", "skills"),
  ]);
  const roots: string[] = [];
  for (const dir of skillDirs(cwd).slice(0, 5)) {
    const expected = path.resolve(dir);
    if (!allowed.has(expected)) continue;
    try {
      const actual = await fs.realpath(expected);
      if (actual === expected && (await fs.stat(actual)).isDirectory() && !roots.includes(actual)) roots.push(actual);
    } catch { /* Missing or inaccessible optional store. */ }
  }
  return roots;
}

export interface SandboxSkillSnapshot {
  root: string;
  paths: Map<string, string>;
  resources?: Map<string, string>;
}

/** Open every component without following links; never resolve an untrusted pathname after opening it. */
function readAuthorizedSkillFile(source: string, remainingBytes: number): { data: Buffer; mode: number } {
  const library = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : process.platform === "linux" ? "libc.so.6" : undefined;
  if (!library || !fsConstants.O_DIRECTORY || !fsConstants.O_NOFOLLOW) throw new Error("SANDBOX_SKILLS: safe directory-relative file access is unavailable");
  const libc = dlopen(library, {
    open: { args: ["ptr", "i32"], returns: "i32" },
    openat: { args: ["i32", "ptr", "i32"], returns: "i32" },
  });
  let fd = -1;
  try {
    fd = libc.symbols.open(Buffer.from("/\0"), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    if (fd < 0) throw new Error("SANDBOX_SKILLS: cannot open trusted filesystem root");
    const components = source.slice(1).split(path.sep);
    for (let i = 0; i < components.length; i++) {
      const flags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (i < components.length - 1 ? fsConstants.O_DIRECTORY : fsConstants.O_NONBLOCK);
      const next = libc.symbols.openat(fd, Buffer.from(`${components[i]}\0`), flags);
      if (next < 0) throw new Error("SANDBOX_SKILLS: authorized path is inaccessible or traverses a symlink");
      closeSync(fd);
      fd = next;
    }
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) throw new Error("SANDBOX_SKILLS: authorized resource must be a bounded regular file without hard links");
    if (stat.size > remainingBytes) throw new Error("SANDBOX_SKILLS: snapshot limit exceeded");
    const data = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < data.length) {
      const size = readSync(fd, data, count, data.length - count, count);
      if (!size) break;
      count += size;
    }
    if (count !== stat.size) throw new Error("SANDBOX_SKILLS: source changed during snapshot");
    // The authorized path must still lead to the very file that was read: a directory moved away and
    // replaced between the walk and the open would otherwise leak the moved tree's bytes. Ceiling: a
    // same-user host process rewriting the store in the instant after this check; the sandboxed guest
    // cannot rename host directories.
    const end = fstatSync(fd);
    let named: Stats | undefined;
    try { named = lstatSync(source); } catch { /* The path no longer names a file. */ }
    if (!named || realpathSync(source) !== source || named.dev !== stat.dev || named.ino !== stat.ino || end.nlink !== 1 || end.size !== stat.size || end.mtimeMs !== stat.mtimeMs) {
      throw new Error("SANDBOX_SKILLS: authorized path changed during snapshot");
    }
    return { data: data.subarray(0, count), mode: stat.mode };
  } finally {
    if (fd >= 0) closeSync(fd);
    libc.close();
  }
}

/** Copy only individually authorized regular files from fixed global skill stores. */
export async function snapshotSandboxSkillAssets(cwd: string, destination: string, writableRoots: readonly string[] = [], authorizedFiles: readonly string[] = []): Promise<SandboxSkillSnapshot> {
  if (currentSandboxExecution()) throw new Error("SANDBOX_SKILLS: snapshot requires trusted initialization");
  const stores = await nativeSandboxSkillRoots(cwd);
  const denied = await Promise.all([cwd, ...writableRoots].map(dir => canonicalSandboxPath(dir, false)));
  const paths = new Map<string, string>();
  const resources = new Map<string, string>();
  const root = await canonicalSandboxPath(destination, false);
  if (stores.some(store => withinCatalogRoot(root, store)) || denied.some(dir => withinCatalogRoot(root, dir))) {
    throw new Error("SANDBOX_SKILLS: snapshot destination overlaps a source or writable root");
  }
  await fs.mkdir(root, { mode: 0o700 });
  let bytes = 0;
  for (const source of new Set(authorizedFiles)) {
    if (typeof source !== "string" || source.includes("\0") || !path.isAbsolute(source) || path.resolve(source) !== source) {
      throw new Error("SANDBOX_SKILLS: authorized files must be normalized absolute paths");
    }
    const store = stores.find(dir => withinCatalogRoot(source, dir) && source !== dir);
    if (!store || denied.some(dir => withinCatalogRoot(source, dir))) {
      throw new Error("SANDBOX_SKILLS: authorized file is outside a permitted skill store");
    }
    const relative = path.relative(store, source);
    const { data, mode } = readAuthorizedSkillFile(source, 256 * 1024 * 1024 - bytes);
    bytes += data.length;
    const index = skillDirs(cwd).slice(0, 5).findIndex(dir => path.resolve(dir) === store);
    const target = path.join(root, String(index), relative);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, data, { flag: "wx", mode: 0o600 | (mode & 0o100) });
    resources.set(source, target);
    const components = relative.split(path.sep);
    if ((components.length === 2 && components[1] === "SKILL.md") || (components.length === 1 && components[0]!.endsWith(".md"))) paths.set(source, target);
  }
  return { root, paths, resources };
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

/** Resolve ONE directory entry from {@link skillDirs} to its `SkillDoc`, or `null`
 *  when the entry is not a skill (dotfile, non-`.md` file, directory with no
 *  `SKILL.md`, unreadable/broken symlink). Pure I/O + parse — no shared-state
 *  writes — so callers can run many of these concurrently. */
async function resolveSkillEntry(dir: string, entry: Dirent): Promise<SkillDoc | null> {
  if (entry.name.startsWith(".")) return null;
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
    } catch { return null; /* broken symlink */ }
  }
  if (isFile && entry.name.endsWith(".md")) {
    const nm = entry.name.slice(0, -3);
    const filePath = path.join(dir, entry.name);
    try {
      const parsed = parseSkillMarkdown(nm, await fs.readFile(filePath, "utf-8"), { preferMetaName: true });
      parsed.sourcePath = filePath;
      return isSupportedExternalSkill(parsed) ? parsed : null;
    } catch { return null; /* unreadable file */ }
  }
  if (isDir) {
    const skillPath = path.join(dir, entry.name, "SKILL.md");
    try {
      const parsed = parseSkillMarkdown(entry.name, await fs.readFile(skillPath, "utf-8"), { preferMetaName: true });
      parsed.sourcePath = skillPath;
      return isSupportedExternalSkill(parsed) ? parsed : null;
    } catch { return null; /* dir without SKILL.md, or unreadable */ }
  }
  return null;
}

/** Concurrency cap for {@link resolveSkillEntry} within one directory: high enough
 *  that a large skill directory (hundreds of entries — a real field case: `npx skills
 *  add`-style installs commonly accumulate 500+) resolves in one or two batches
 *  instead of paying per-file `fs` round-trip latency SEQUENTIALLY (534 entries at
 *  ~0.4ms/syscall was a measured ~220ms — a visible stall on every session start and
 *  every `/skill` listing), while staying well under the lowest realistic per-process
 *  file-descriptor ulimit (macOS defaults to 256) even with several directories'
 *  batches racing across the `skillDirs` loop below. */
const SKILL_ENTRY_LOAD_BATCH = 32;

interface CatalogPath { path: string; traversal: string[]; visited?: string[]; guestPath?: string }
interface CatalogEntry { location: CatalogPath; skillName: string; doc?: SkillDoc }
interface CatalogDirectory { location: CatalogPath; entries: CatalogEntry[] }
interface SandboxSkillCatalog { cwd: string; roots: string[]; readableRoots: string[]; directories: CatalogDirectory[] }
const sandboxSkillCatalogs = new WeakMap<SandboxSupervisor, SandboxSkillCatalog>();

function withinCatalogRoot(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function guestCatalogPath(location: CatalogPath, roots: string[]): string | undefined {
  if (location.guestPath) return location.guestPath;
  const route = location.traversal.find(file => roots.some(root => withinCatalogRoot(file, root)));
  if (!route && location.visited?.some(file => roots.some(root => withinCatalogRoot(file, root)))) {
    throw new Error("SANDBOX_SKILLS: catalog traversal leaves a writable root; explicit guest access required");
  }
  return route;
}

/** Metadata only: stop BEFORE traversing a workspace-controlled symlink. Called
 * only while constructing the pre-execution snapshot, never for live host reads. */
async function traceCatalogPath(file: string, roots: string[], protectedRoots: string[]): Promise<CatalogPath> {
  const absolute = path.resolve(file);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  let parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const traversal = [absolute];
  if (!protectedRoots.some(root => withinCatalogRoot(absolute, root))) return { path: absolute, traversal, guestPath: absolute };
  const visited: string[] = [];
  let links = 0;
  while (parts.length > 0) {
    const part = parts.shift()!;
    if (part === ".") continue;
    current = part === ".." ? path.dirname(current) : path.join(current, part);
    visited.push(current);
    const candidate = path.join(current, ...parts);
    if (!protectedRoots.some(root => withinCatalogRoot(current, root) || withinCatalogRoot(root, current))) {
      return { path: candidate, traversal, visited, guestPath: candidate };
    }
    if (roots.some(root => withinCatalogRoot(current, root))) {
      traversal.push(candidate);
      const location = { path: candidate, traversal, visited };
      guestCatalogPath(location, roots); // Reject '..' escape, never normalize it into a trusted host read.
      return location;
    }
    if (part !== ".." && (await fs.lstat(current)).isSymbolicLink()) {
      if (++links > 40) throw new Error("Too many skill catalog symlinks");
      const target = await fs.readlink(current);
      const targetRoot = path.parse(target).root;
      current = targetRoot || path.dirname(current);
      // Retain '..' until its preceding components and symlinks have been visited.
      parts = target.slice(targetRoot.length).split(path.sep).filter(Boolean).concat(parts);
      traversal.push(path.join(current, ...parts));
    }
  }
  return { path: current, traversal, visited };
}

/** Must run before the supervisor executes any model-controlled guest code.
 * Parent skill bytes are frozen in memory, not reread after tools can mutate paths. */
export async function prepareSandboxSkillCatalog(supervisor: SandboxSupervisor, cwd: string, writableRoots: readonly string[] = [], readableRoots: readonly string[] = writableRoots, snapshot?: SandboxSkillSnapshot): Promise<void> {
  if (currentSandboxExecution()) throw new Error("SANDBOX_SKILLS: snapshot requires trusted initialization");
  if (sandboxSkillCatalogs.has(supervisor)) throw new Error("SANDBOX_SKILLS: catalog already initialized");
  const roots = [...new Set([path.resolve(cwd), await fs.realpath(cwd), ...writableRoots.map(root => path.resolve(root))])];
  // These roots (and their canonical aliases) are forbidden to EVERY sandbox
  // profile, unlike runtime HOME/config directories or another session's grants.
  const nativeHome = await nativeSandboxHome();
  const nativeRoots = [".agents", ".agent-skills", ".claude", ".jeo", ".jeopi"].map(name => path.join(nativeHome, name));
  const protectedRoots = [...new Set([...nativeRoots, ...await Promise.all(nativeRoots.map(root => canonicalSandboxPath(root, false)))])];
  const authorizedRoots = [...new Set([path.resolve(cwd), await fs.realpath(cwd), ...readableRoots.map(root => path.resolve(root))])];
  const directories: CatalogDirectory[] = [];
  for (const [index, dir] of skillDirs(cwd).entries()) {
    let location: CatalogPath;
    try { location = await traceCatalogPath(dir, roots, protectedRoots); }
    catch {
      directories.push({ location: { path: path.resolve(dir), traversal: [path.resolve(dir)] }, entries: [] });
      continue;
    }
    const directory: CatalogDirectory = { location, entries: [] };
    directories.push(directory);
    if (guestCatalogPath(location, roots)) continue;
    if (index < 5) {
      if (!snapshot) continue;
      for (const [source, frozen] of snapshot.paths) {
        const relative = path.relative(dir, source);
        if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
        const components = relative.split(path.sep);
        if (components.length !== 1 && !(components.length === 2 && components[1] === "SKILL.md")) continue;
        const skillName = components[0]!.replace(/\.md$/, "");
        const itemLocation = await traceCatalogPath(source, roots, protectedRoots);
        if (guestCatalogPath(itemLocation, roots)) continue;
        const doc = parseSkillMarkdown(skillName, await fs.readFile(frozen, "utf-8"), { preferMetaName: true });
        doc.sourcePath = frozen;
        if (components.length === 2) {
          const skillRoot = path.dirname(source);
          doc.sandboxResources = [...(snapshot.resources ?? new Map())].filter(([original]) => original !== source && withinCatalogRoot(original, skillRoot)).map(([original, target]) => ({ source: original, snapshot: target }));
        }
        if (isSupportedExternalSkill(doc)) directory.entries.push({ location: itemLocation, skillName, doc });
      }
      continue;
    }
  }
  sandboxSkillCatalogs.set(supervisor, { cwd: path.resolve(cwd), roots, readableRoots: authorizedRoots, directories });
}

/** Grant revisions may taint formerly trusted paths. Reclassify captured path
 * provenance only; never refresh content from a now-running model's host paths. */
export function updateSandboxSkillCatalogRoots(supervisor: SandboxSupervisor, writableRoots: readonly string[], readableRoots: readonly string[] = writableRoots): void {
  const catalog = sandboxSkillCatalogs.get(supervisor);
  if (!catalog) throw new Error("SANDBOX_SKILLS: catalog not initialized");
  catalog.roots = [...new Set([...catalog.roots, ...writableRoots.map(root => path.resolve(root))])];
  catalog.readableRoots = [...new Set([catalog.cwd, ...readableRoots.map(root => path.resolve(root))])];
}

async function loadSandboxSkills(cwd: string): Promise<SkillDoc[]> {
  const sandbox = currentSandboxExecution();
  if (!sandbox) throw new Error("SANDBOX_SKILLS: missing execution scope");
  const catalog = sandboxSkillCatalogs.get(sandbox.supervisor);
  if (!catalog) throw new Error("SANDBOX_SKILLS: trusted catalog not initialized");
  const byName = new Map<string, SkillDoc>(SKILLS.map(skill => [skill.name.toLowerCase(), skill]));
  for (const name of await sandboxSkillCatalog<string[]>("lock", cwd)) ALLOWED_SKILL_NAMES.add(name.toLowerCase());
  // A subagent may use another approved cwd: reuse only trusted global bytes,
  // and derive its project directories without touching host filesystem state.
  const directories = path.resolve(cwd) === catalog.cwd
    ? catalog.directories
    : catalog.directories.map((directory, index) => index >= 5 && index < 10
      ? { location: { path: skillDirs(cwd)[index]!, traversal: [skillDirs(cwd)[index]!] }, entries: [] }
      : directory);
  for (const directory of directories) {
    const guestDir = guestCatalogPath(directory.location, catalog.roots)
      ?? (path.resolve(cwd) !== catalog.cwd && withinCatalogRoot(directory.location.path, path.resolve(cwd)) ? directory.location.path : undefined);
    if (guestDir) {
      if (!catalog.readableRoots.some(root => withinCatalogRoot(guestDir, root))) continue;
      for (const doc of await sandboxSkillCatalog<SkillDoc[]>("scan", guestDir)) byName.set(doc.name.toLowerCase(), doc);
      continue;
    }
    for (const entry of directory.entries) {
      const guestFile = guestCatalogPath(entry.location, catalog.roots);
      if (guestFile && !catalog.readableRoots.some(root => withinCatalogRoot(guestFile, root))) continue;
      const doc = guestFile
        ? await sandboxSkillCatalog<SkillDoc | null>("entry", path.dirname(guestFile), { name: path.basename(guestFile), skillName: entry.skillName })
        : entry.doc;
      if (doc) byName.set(doc.name.toLowerCase(), { ...doc });
    }
  }
  return [...byName.values()];
}

async function scanSkillDirectory(dir: string): Promise<SkillDoc[]> {
  let entries: Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const skills: SkillDoc[] = [];
  for (let i = 0; i < entries.length; i += SKILL_ENTRY_LOAD_BATCH) {
    const resolved = await Promise.all(entries.slice(i, i + SKILL_ENTRY_LOAD_BATCH).map(entry => resolveSkillEntry(dir, entry)));
    for (const skill of resolved) if (skill) skills.push(skill);
  }
  return skills;
}

/** Only workspace catalog effects execute in hands; trusted global docs stay in brain. */
export async function executeSkillCatalogOperation(args: Record<string, unknown>, cwd: string): Promise<unknown> {
  if (currentSandboxExecution()) throw new Error("SANDBOX_SKILLS: guest handler cannot run in the brain");
  if (args.action === "lock") {
    try {
      const lockData: unknown = JSON.parse(await fs.readFile(path.join(cwd, "skills-lock.json"), "utf-8"));
      if (lockData && typeof lockData === "object" && "skills" in lockData && lockData.skills && typeof lockData.skills === "object") return Object.keys(lockData.skills);
    } catch {}
    return [];
  }
  if (args.action === "scan") return scanSkillDirectory(cwd);
  if (args.action === "entry") {
    if (typeof args.name !== "string" || args.name !== path.basename(args.name)) throw new Error("Invalid skill entry name");
    const entryPath = path.join(cwd, args.name);
    try {
      const stat = await fs.stat(entryPath);
      const file = stat.isDirectory() ? path.join(entryPath, "SKILL.md") : entryPath;
      if (!stat.isDirectory() && (!stat.isFile() || !args.name.endsWith(".md"))) return null;
      const doc = parseSkillMarkdown(typeof args.skillName === "string" ? args.skillName : args.name.replace(/\.md$/, ""), await fs.readFile(file, "utf-8"), { preferMetaName: true });
      doc.sourcePath = file;
      return isSupportedExternalSkill(doc) ? doc : null;
    } catch { return null; }
  }
  throw new Error("Unknown skill catalog operation");
}

/** Bundled skills merged with user skill docs from {@link skillDirs} (user overrides by name). */
export async function loadSkills(cwd: string = process.cwd()): Promise<SkillDoc[]> {
  if (currentSandboxExecution()) return loadSandboxSkills(cwd);
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
  // Directories are walked in their documented lowest→highest precedence order
  // (a later dir's skill overrides an earlier one with the same name) — that
  // cross-directory override MUST stay sequential. Entries WITHIN one directory
  // have no such contract (readdir order is not a precedence guarantee anyone
  // depends on), so they resolve concurrently in bounded batches, then apply to
  // `byName` in their original readdir order for a fully deterministic result.
  for (const dir of skillDirs(cwd)) {
    let entries: Dirent[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (let i = 0; i < entries.length; i += SKILL_ENTRY_LOAD_BATCH) {
      const batch = entries.slice(i, i + SKILL_ENTRY_LOAD_BATCH);
      const resolved = await Promise.all(batch.map(entry => resolveSkillEntry(dir, entry)));
      for (const parsed of resolved) {
        if (parsed) byName.set(parsed.name.toLowerCase(), parsed);
      }
    }
  }
  return [...byName.values()];
}

/** Skill-invocation card body (the `[skill]` block shown in the TUI
 *  when `$name`//skill runs): name, resolved SKILL.md path (or the bundled
 *  module path), and the prompt size actually injected. Pure — testable. */
export function skillInvocationCard(skill: SkillDoc, intent?: string): string[] {
  const promptLines = (skill.raw ?? skill.details ?? "").split("\n").filter(l => l.trim().length > 0).length;
  // jeo-ref tree-connector detail: the skill name leads, resolved metadata hangs
  // off ├─/└─ connectors so the card scans like the reference's Skill panel. The
  // intent (when given) is shown here so it isn't lost — the injected SKILL.md is
  // NOT echoed as a user box: compact card, not the raw doc.
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

/** Resolve a bare `$`-token (the text after `$`, no leading `$`) to a skill: exact name,
 *  then exact declared alias (the alias compared without its leading `/`), then unique name
 *  prefix. This makes declared aliases first-class `$` entrypoints — `$obsidian-capture`
 *  resolves the skill that declares `/obsidian-capture` — so skills stay `$`-managed and a
 *  declared `alias` becomes an invocable `$<alias>`, never a dispatchable `/` command. */
export function getSkillByDollarToken(skills: SkillDoc[], token: string): SkillDoc | undefined {
  const q = token.toLowerCase();
  if (!q) return undefined;
  const byName = skills.find(s => s.name.toLowerCase() === q);
  if (byName) return byName;
  const byAlias = skills.find(s => skillSlashAliases(s).some(a => a.replace(/^\//, "").toLowerCase() === q));
  if (byAlias) return byAlias;
  return uniquePrefixSkill(skills, token);
}

export interface SkillInvocation {
  skill: SkillDoc;
  intent: string;
  invokedAs?: string;
}
/** Parse only an explicit `$skill` invocation. Skills are invokable ONLY via the `$`
 * entrypoint — `/` commands never load a skill file, and pasted SKILL.md paths cannot
 * hijack an ordinary coding request. Only the FIRST token counts, and only when a skill
 * with that exact name, exact declared alias, or unique name prefix is loaded; `$HOME is
 * what?` or any unknown `$word` falls through to the model as an ordinary prompt. */
export function parseSkillInvocation(input: string, skills: SkillDoc[]): SkillInvocation | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const command = trimmed.split(/\s+/, 1)[0] ?? "";
  if (command.length > 1 && command.startsWith("$")) {
    const dollarSkill = getSkillByDollarToken(skills, command.slice(1));
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
 *  Each `$name` resolves by exact name, exact declared alias, then unique prefix; names that
 *  resolve to nothing go into `unresolved` (so the REPL can report every typo, not just the first). Returns null
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
    const skill = getSkillByDollarToken(skills, name);
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
