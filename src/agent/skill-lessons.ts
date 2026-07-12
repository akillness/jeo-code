/**
 * Skill self-compounding: the durable link the bundled/user skill docs were
 * missing. `recordFailedAttempt` (memory.ts) already writes stalled turns into
 * OKF concept memory, but nothing ever fed that signal BACK into the skill
 * files themselves — a skill that repeatedly leads an agent into the same dead
 * end never learns to warn about it. This module closes that loop:
 *
 *   - `matchLessonToSkill` deterministically (no LLM) maps free text to the
 *     bundled skill it most plausibly concerns, conservatively preferring
 *     `undefined` over a wrong guess.
 *   - `appendSkillLesson`/`recordSkillLesson` append a lesson bullet into a
 *     `## Known Failure Modes` or `## Anti-Patterns (do NOT do)` section of the
 *     project-level `.jeo/skills/<name>.md` file (seeded from the bundled
 *     skill on first write), idempotent on exact-title re-append.
 *   - `evalSkillLessons` is the self-eval half: ONE batched LLM call judges
 *     whether each recorded lesson is still "covered" by the skill's current
 *     guidance or has gone "stale" (guidance drifted, entry looks obsolete),
 *     so a human/agent can prune or fold lessons back into the skill body.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SKILLS, getSkill, bundledSkillFileContent } from "../skills/catalog";
import { callLlm } from "./loop";
import { resolveVerifierModel } from "./prompt-router";
import { readGlobalConfig } from "./state";
import { tryExtractJsonObject } from "./json";

export interface SkillLesson {
  skill: string;
  kind: "failure-mode" | "anti-pattern";
  title: string;
  detail: string;
}

const SECTION_HEADER: Record<SkillLesson["kind"], string> = {
  "failure-mode": "## Known Failure Modes",
  "anti-pattern": "## Anti-Patterns (do NOT do)",
};

/** Hand-picked keyword sets per bundled skill, used ONLY for the deterministic
 *  free-text -> skill matcher below. Kept as one small record (not inline in
 *  the function) so the mapping is easy to audit/extend as skills are added. */
const SKILL_KEYWORDS: Record<string, string[]> = {
  "deep-interview": ["ambiguity", "interview", "clarify", "clarification", "requirements", "socratic", "vague"],
  "deep-dive": ["root cause", "root-cause", "diagnose", "diagnosis", "trace", "hypothesis", "causal"],
  "ralplan": ["critic", "consensus", "[okay]", "[iterate]", "plan draft", "plan critique", "iterate verdict"],
  "team": ["parallel_group", "worktree", "team executor", "plan step", "coordinated agents", "shared task list"],
  "ultragoal": ["verification", "acceptance criteria", "goal verifier", "goal state", "verdict: met", "not_met"],
};

/**
 * Deterministic (no LLM) free-text -> bundled-skill match. Scores each SKILLS
 * entry by counting keyword/substring hits (the skill's own `name` plus its
 * hand-picked related terms from {@link SKILL_KEYWORDS}) against the lowercased
 * input text, and returns the highest-scoring skill name — or `undefined` when
 * nothing scores at all, since a wrong guess is worse than no guess here.
 */
export function matchLessonToSkill(text: string): string | undefined {
  const haystack = text.toLowerCase();
  if (!haystack.trim()) return undefined;

  let bestName: string | undefined;
  let bestScore = 0;
  for (const skill of SKILLS) {
    const terms = [skill.name.toLowerCase(), ...(SKILL_KEYWORDS[skill.name] ?? [])];
    let score = 0;
    for (const term of terms) {
      if (term && haystack.includes(term)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestName = skill.name;
    }
  }
  return bestScore > 0 ? bestName : undefined;
}

/** Project-level skill file path — `<cwd>/.jeo/skills/<name>.md`, the same
 *  highest-precedence directory `skillDirs()` (catalog.ts) resolves last, so a
 *  lesson written here transparently overrides/extends the bundled version by
 *  name the next time skills are loaded. */
export function skillFilePath(cwd: string, skillName: string): string {
  return path.join(cwd, ".jeo", "skills", `${skillName}.md`);
}

/** Locate the target H2 section within `content`'s lines. Returns the line
 *  index range `[headerLine, bulletsEnd)` where `bulletsEnd` is the index to
 *  insert a new bullet at (immediately before the next `## ` header, or
 *  end-of-file, trimming any trailing blank lines inside the section so the
 *  new bullet lands directly after the last existing one). `null` when the
 *  section header isn't present yet. */
function findSection(lines: string[], header: string): { headerLine: number; insertAt: number } | null {
  const headerLine = lines.findIndex(l => l.trim() === header);
  if (headerLine < 0) return null;
  let end = lines.length;
  for (let i = headerLine + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ")) { end = i; break; }
  }
  let insertAt = end;
  while (insertAt > headerLine + 1 && lines[insertAt - 1]!.trim() === "") insertAt--;
  return { headerLine, insertAt };
}

/** Does a `- **title**: ...` (or bare `- title...`) bullet with this exact
 *  title (case-insensitive) already exist between `[start, end)`? */
function sectionHasTitle(lines: string[], start: number, end: number, title: string): boolean {
  const needle = title.trim().toLowerCase();
  for (let i = start; i < end; i++) {
    const m = lines[i]!.match(/^-\s+\*\*(.+?)\*\*\s*:/);
    if (m && m[1]!.trim().toLowerCase() === needle) return true;
  }
  return false;
}

/**
 * Core compounding write: append `lesson` as a markdown bullet into the
 * project-level skill file's failure-mode/anti-pattern section, seeding the
 * file from the bundled skill's own on-disk text on first write so existing
 * guidance is never lost. Idempotent on exact-title re-append (case-
 * insensitive) — returns `{ appended: false, reason: "duplicate" }` rather
 * than writing a second copy. Best-effort: any I/O error is caught and
 * reported, never thrown (mirrors `recordFailedAttempt`'s fail-open contract).
 */
export async function appendSkillLesson(cwd: string, lesson: SkillLesson): Promise<{ appended: boolean; reason?: string }> {
  const title = lesson.title.trim();
  if (!title) return { appended: false, reason: "empty title" };
  const detail = lesson.detail.trim();
  const header = SECTION_HEADER[lesson.kind];

  try {
    const filePath = skillFilePath(cwd, lesson.skill);
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch {
      const bundled = getSkill(lesson.skill);
      content = bundled ? bundledSkillFileContent(bundled) : `# ${lesson.skill}\n\n`;
    }

    let lines = content.replace(/\r\n/g, "\n").split("\n");
    let section = findSection(lines, header);
    if (!section) {
      // Append the section header at the end of the file (blank-line separated).
      if (lines.length > 0 && lines[lines.length - 1]!.trim() !== "") lines.push("");
      if (!(lines.length > 0 && lines[lines.length - 1] === "")) lines.push("");
      lines.push(header, "");
      section = { headerLine: lines.length - 2, insertAt: lines.length };
    } else if (sectionHasTitle(lines, section.headerLine + 1, section.insertAt, title)) {
      return { appended: false, reason: "duplicate" };
    }

    const bullet = `- **${title}**: ${detail}`;
    lines.splice(section.insertAt, 0, bullet);

    const finalContent = lines.join("\n").replace(/\n{3,}$/, "\n\n");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}`;
    await fs.writeFile(tmpPath, finalContent, "utf-8");
    await fs.rename(tmpPath, filePath);
    return { appended: true };
  } catch (err) {
    return { appended: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Convenience wrapper for the automatic (stall-guard) path: matches `freeText`
 * to a bundled skill via {@link matchLessonToSkill} and, only on a match,
 * writes the lesson via {@link appendSkillLesson}. Unrelated text (no skill
 * match) correctly writes nothing.
 */
export async function recordSkillLesson(
  cwd: string,
  freeText: string,
  lesson: Omit<SkillLesson, "skill">,
): Promise<{ appended: boolean; skill?: string; reason?: string }> {
  const skill = matchLessonToSkill(freeText);
  if (!skill) return { appended: false, reason: "no matching skill" };
  const result = await appendSkillLesson(cwd, { ...lesson, skill });
  return { ...result, skill };
}

export interface LessonEvalResult {
  skill: string;
  total: number;
  covered: number;
  stale: Array<{ title: string; reason: string }>;
}

interface ParsedBullet {
  title: string;
  detail: string;
}

/** Extract every bullet from `[start, end)`, splitting the `- **title**:
 *  detail` format {@link appendSkillLesson} produces — a plain `- detail`
 *  bullet (no bold title) tolerantly uses the whole bullet text as both. */
function extractBullets(lines: string[], start: number, end: number): ParsedBullet[] {
  const out: ParsedBullet[] = [];
  for (let i = start; i < end; i++) {
    const line = lines[i]!;
    if (!line.startsWith("- ")) continue;
    const m = line.match(/^-\s+\*\*(.+?)\*\*\s*:\s*(.*)$/);
    if (m) {
      out.push({ title: m[1]!.trim(), detail: m[2]!.trim() });
    } else {
      const text = line.slice(2).trim();
      if (text) out.push({ title: text, detail: text });
    }
  }
  return out;
}

/** The skill body with BOTH lesson sections (header + their bullets) removed —
 *  i.e. just the skill's core guidance, which is what the eval judge should
 *  compare each lesson against. */
function coreBodyWithoutLessons(lines: string[]): string {
  const headers = new Set(Object.values(SECTION_HEADER));
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (headers.has(line.trim())) { skipping = true; continue; }
    if (skipping && line.startsWith("## ")) skipping = false;
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").trim();
}

/**
 * Self-eval half of the compounding loop: reads the project-level skill file
 * and, for every recorded failure-mode/anti-pattern bullet, asks an
 * independent LLM call whether the skill's CURRENT core guidance still
 * addresses it ("covered") or has drifted ("stale"). Zero bullets short-
 * circuits to a zero-cost result (no LLM call). `null` when the project-level
 * file doesn't exist at all (no lessons ever recorded for this skill).
 * Parse failure fails conservatively: every entry is treated as "covered"
 * rather than risk falsely flagging a lesson as obsolete.
 */
export async function evalSkillLessons(
  cwd: string,
  skillName: string,
  opts: { model?: string } = {},
): Promise<LessonEvalResult | null> {
  const filePath = skillFilePath(cwd, skillName);
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const failureSection = findSection(lines, SECTION_HEADER["failure-mode"]);
  const antiSection = findSection(lines, SECTION_HEADER["anti-pattern"]);
  const bullets: ParsedBullet[] = [
    ...(failureSection ? extractBullets(lines, failureSection.headerLine + 1, failureSection.insertAt) : []),
    ...(antiSection ? extractBullets(lines, antiSection.headerLine + 1, antiSection.insertAt) : []),
  ];

  if (bullets.length === 0) {
    return { skill: skillName, total: 0, covered: 0, stale: [] };
  }

  const model = opts.model ?? resolveVerifierModel(await readGlobalConfig());
  const coreBody = coreBodyWithoutLessons(lines);
  const lessonList = bullets.map((b, i) => `${i + 1}. "${b.title}": ${b.detail}`).join("\n");

  const systemPrompt = `You are an independent Skill Auditor. You are shown a skill's CURRENT core guidance text and a list of lessons (failure modes / anti-patterns) previously recorded against earlier versions of this skill.

For EACH lesson, judge:
- "covered": the skill's current guidance still clearly addresses this lesson (a reader following the current guidance would avoid/handle it).
- "stale": the guidance has drifted and no longer clearly addresses this lesson, OR the lesson itself looks obsolete/no-longer-applicable.

Respond with ONLY a JSON object: {"results": [{"title": string, "verdict": "covered" | "stale", "reason": string}]}. Include EVERY lesson by its exact title. No markdown, no code fences, no other text.`;

  const userMessage = `Skill's current core guidance:\n\n${coreBody}\n\nRecorded lessons:\n\n${lessonList}\n\nJudge each lesson.`;

  const verdictByTitle = new Map<string, { verdict: "covered" | "stale"; reason: string }>();
  try {
    const response = await callLlm(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      { model, jsonMode: true, maxTokens: 1500, reasoningEffort: "none" },
    );
    const parsed = tryExtractJsonObject<{ results?: unknown }>(response);
    if (parsed && Array.isArray(parsed.results)) {
      for (const entry of parsed.results) {
        if (
          entry && typeof entry === "object" &&
          "title" in entry && typeof entry.title === "string" &&
          "verdict" in entry && (entry.verdict === "covered" || entry.verdict === "stale")
        ) {
          const reason = "reason" in entry && typeof entry.reason === "string" ? entry.reason : "";
          verdictByTitle.set(entry.title.trim().toLowerCase(), { verdict: entry.verdict, reason });
        }
      }
    }
  } catch {
    // fail conservatively below: an empty verdictByTitle treats every bullet as "covered"
  }

  let covered = 0;
  const stale: Array<{ title: string; reason: string }> = [];
  for (const b of bullets) {
    const v = verdictByTitle.get(b.title.trim().toLowerCase());
    if (v && v.verdict === "stale") {
      stale.push({ title: b.title, reason: v.reason || "flagged stale by skill auditor" });
    } else {
      covered++;
    }
  }
  return { skill: skillName, total: bullets.length, covered, stale };
}
