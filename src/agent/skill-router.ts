/**
 * ECC single-harness + Jev-style skill routing for jeo-code.
 *
 * Two concerns live here on purpose, mirroring the external operating layer:
 *
 * 1. ECC inventory (fail-closed on duplicates): exactly ONE harness path per
 *    skill identity. A later skill dir's same-named skill OVERRIDES (that is the
 *    documented `loadSkills` precedence), but two DIFFERENT source paths
 *    claiming the same normalized name inside ONE resolution pass is a duplicate
 *    installation — report it instead of silently shadowing.
 *
 * 2. Jev `route-skills` heuristic (advisory, always fail-open): scores a task
 *    against the loaded skill catalog with zero I/O and returns a top-k
 *    selection plus an advisory routing note. Gate and fit thresholds are both
 *    `0.30`, matching the Jev control plane. This never installs skills, never
 *    changes the model, and never throws — an empty/ambiguous task yields an
 *    explicit none with a reason, not a guess.
 */

import type { SkillDoc } from "../skills/catalog";

/** Gate below which no skill is selected (explicit none, reason "gate"). */
export const SKILL_ROUTE_GATE = 0.3;
/** Fit below which a top candidate is still rejected (explicit none, reason "fits"). */
export const SKILL_ROUTE_FIT = 0.3;
/** Max skills compared in one scoring shard (Jev `choiceCap` analogue). */
export const SKILL_ROUTE_CHOICE_CAP = 6;
/** Max skills returned. */
export const SKILL_ROUTE_TOP_K = 3;

export interface SkillRouteCandidate {
  name: string;
  score: number;
  reasons: string[];
}

export interface SkillRouteSelection {
  topK: SkillRouteCandidate[];
  /** "gate" = nothing cleared the gate; "fits" = cleared gate but failed fit; "ok" = advisory selection. */
  reason: "gate" | "fits" | "ok";
  /** "sharded" when ceil(catalogSize / choiceCap) <= 4, otherwise "shortlist". */
  strategy: "sharded" | "shortlist";
  /** Advisory only — never an install or model instruction. */
  routing: string;
}

const TOKEN_RE = /[a-z0-9][a-z0-9._-]*/gi;

/** Closed-class / low-signal words excluded from routing overlap — without
 *  this, chit-chat ("how are you") spuriously matches every long skill doc. */
const STOPWORDS = new Set([
  "the", "are", "you", "your", "and", "for", "with", "that", "this", "have",
  "has", "had", "what", "when", "where", "which", "how", "why", "who", "whom",
  "there", "here", "today", "hello", "please", "just", "like", "from", "into",
  "over", "under", "about", "after", "before", "then", "than", "also", "only",
  "very", "much", "more", "most", "some", "such", "will", "would", "could",
  "should", "does", "did", "not", "but", "all",
]);

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(TOKEN_RE)) {
    const t = m[0];
    if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

function skillText(s: SkillDoc): string {
  return `${s.name} ${s.summary} ${s.whenToUse} ${s.details}`.toLowerCase();
}

/**
 * Score one skill against the task: keyword overlap over the skill's own
 * name/summary/when/details vocabulary. Name-token hits weigh more (explicit
 * user intent, e.g. "ralplan" in the task). Pure, deterministic.
 */
export function scoreSkillForTask(task: string, skill: SkillDoc): { score: number; reasons: string[] } {
  const taskTokens = tokens(task);
  if (taskTokens.size === 0) return { score: 0, reasons: [] };
  const text = skillText(skill);
  const textTokens = tokens(text);
  let overlap = 0;
  const reasons: string[] = [];
  for (const t of taskTokens) {
    if (textTokens.has(t)) {
      overlap++;
      if (reasons.length < 5) reasons.push(t);
    }
  }
  const nameTokens = tokens(skill.name.replace(/[:/]/g, " "));
  let nameHits = 0;
  for (const t of taskTokens) if (nameTokens.has(t)) nameHits++;
  // Overlap ratio over task vocabulary + a decisive name bonus: an explicit
  // skill-name mention in the task (e.g. "ralplan") must dominate generic
  // vocabulary overlap from longer skill docs.
  const score = overlap / taskTokens.size + Math.min(nameHits * 1.0, 1.5);
  return { score, reasons };
}

/**
 * Jev-style `route-skills`: heuristic top-k skill selection for one task.
 * Never throws; empty input yields explicit none with reason "gate".
 */
export function routeSkillsForTask(task: string, skills: SkillDoc[], topK = SKILL_ROUTE_TOP_K): SkillRouteSelection {
  const strategy: SkillRouteSelection["strategy"] =
    Math.ceil(skills.length / SKILL_ROUTE_CHOICE_CAP) <= 4 ? "sharded" : "shortlist";
  const trimmed = task.trim();
  if (!trimmed) {
    return { topK: [], reason: "gate", strategy, routing: "No task text — no skill suggested. Answer directly." };
  }
  const scored = skills.map(s => {
    const { score, reasons } = scoreSkillForTask(trimmed, s);
    return { name: s.name, score, reasons };
  });
  scored.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
  const gated = scored.filter(c => c.score >= SKILL_ROUTE_GATE).slice(0, topK);
  if (gated.length === 0) {
    return { topK: [], reason: "gate", strategy, routing: "No skill cleared the gate — answer directly without a workflow skill." };
  }
  if (gated[0]!.score < SKILL_ROUTE_FIT) {
    return { topK: [], reason: "fits", strategy, routing: "Top candidate failed the fit threshold — answer directly." };
  }
  const names = gated.map(c => `$${c.name}`).join(", ");
  return {
    topK: gated,
    reason: "ok",
    strategy,
    routing: `Advisory only: the task resembles ${names}. Only follow a skill when the user invoked it via $skill or the task truly fits that bundled workflow; never recite skill docs.`,
  };
}

/** One duplicate-identity report from an ECC inventory scan. */
export interface SkillInventoryConflict {
  normalized: string;
  paths: string[];
}

/**
 * ECC inventory scan: group resolved skills by normalized name and report
 * identities claimed by more than one DISTINCT source path. Bundled skills
 * (no `sourcePath`) share one canonical path so they never conflict with
 * each other. Pure — no filesystem access.
 */
export function inventorySkillConflicts(skills: SkillDoc[]): SkillInventoryConflict[] {
  const byName = new Map<string, Set<string>>();
  for (const s of skills) {
    const normalized = s.name.toLowerCase();
    const p = s.sourcePath ?? `(bundled) src/prompts/skills/${s.name}/SKILL.md`;
    let set = byName.get(normalized);
    if (!set) {
      set = new Set();
      byName.set(normalized, set);
    }
    set.add(p);
  }
  const out: SkillInventoryConflict[] = [];
  for (const [normalized, paths] of byName) {
    if (paths.size > 1) out.push({ normalized, paths: [...paths].sort() });
  }
  out.sort((a, b) => (a.normalized < b.normalized ? -1 : 1));
  return out;
}
