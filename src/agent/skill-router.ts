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

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillDoc } from "../skills/catalog";

/** Gate below which no skill is selected (explicit none, reason "gate"). */
export const SKILL_ROUTE_GATE = 0.3;
/** Fit below which a top candidate is still rejected (explicit none, reason "fits"). */
export const SKILL_ROUTE_FIT = 0.3;
/** Max skills compared in one scoring shard (Jev `choiceCap` analogue). */
export const SKILL_ROUTE_CHOICE_CAP = 6;
/** Max skills returned (dynamic 0..8 deferred list; overridable per caller). */
export const SKILL_ROUTE_TOP_K = 8;

export interface SkillRouteCandidate {
  name: string;
  score: number;
  reasons: string[];
  reason?: string;
  path?: string;
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

const TOKEN_RE = /[a-z0-9][a-z0-9.+#/-]*|[가-힣]{2,}/gi;
const STOPWORDS = new Set([
  "the", "are", "you", "your", "and", "for", "with", "that", "this", "have",
  "has", "had", "what", "when", "where", "which", "how", "why", "who", "whom",
  "there", "here", "today", "hello", "please", "just", "like", "from", "into",
  "over", "under", "about", "after", "before", "then", "than", "also", "only",
  "very", "much", "more", "most", "some", "such", "will", "would", "could",
  "should", "does", "did", "not", "but", "all", "can", "use", "using", "need",
  "want", "help", "task", "work", "skill", "skills", "jev", "ok", "okay",
  "yes", "yep", "yeah", "no", "nope", "sure", "good", "great", "thanks",
  "thank", "hey", "hi", "proceed", "continue", "ahead", "option", "choice",
  "mean", "means", "difference", "between", "simple", "terms", "explain",
  "응", "네", "예", "ㅇㅇ", "오키", "오케이", "좋아", "좋아요", "알겠어", "고마워",
  "감사", "계속", "진행", "진행해", "진행해줘", "허용", "옵션", "정도", "같아",
  "잠깐만", "방금", "다시", "설명", "설명해줘", "알려줘", "해줘", "해주세요", "좀",
  "그냥", "그렇게", "이거", "그거", "말고", "아니", "맞아", "가자", "하자", "뭐야",
  "차이", "차이점", "개념", "간단하게", "어떨까", "오늘", "현재", "우리", "방법",
]);

const KO_EN_EXPANSIONS: Record<string, string[]> = {
  블렌더: ["blender"], 리깅: ["rigging", "rig"], 믹사모: ["mixamo"], 모션: ["motion"],
  한글: ["hwp", "hwpx"], 파싱: ["parse", "extract"], 치환: ["replace", "edit"],
  리액트: ["react"], 넥스트: ["nextjs"], 성능: ["performance", "optimization"],
  최적화: ["optimization", "performance"], 리뷰: ["review"], 코드리뷰: ["code-review"],
  스키마: ["schema", "database"], 데이터베이스: ["database", "schema", "sql"],
  쇼츠: ["shorts", "video"], 유튜브: ["youtube"], 영상: ["video"],
  크롬: ["chrome", "browser"], 브라우저: ["browser", "chrome"], 헤드리스: ["headless", "cdp"],
  로그인: ["login", "session", "authentication"], 세션: ["session"],
  로그: ["log", "logs"], 스택트레이스: ["stacktrace", "debugging"], 장애: ["outage", "log"],
  머지: ["merge", "conflict"], 충돌: ["conflict", "merge"], 기획서: ["prd", "spec"],
  보안: ["security"], 취약점: ["security"], 인증: ["authentication"],
  특허: ["patent", "kipris"], 옵시디언: ["obsidian"], 세컨드: ["second-brain"],
  볼트: ["vault", "obsidian"], 위키: ["wiki"], 조명: ["lighting"], 셰이더: ["shaders"],
  경쟁사: ["competitor"], 배틀카드: ["battlecard"], 리팩토링: ["refactoring", "refactor"],
  아키텍처: ["architecture"], 테스트: ["testing", "test"], 배포: ["deploy", "deployment"],
  모니터링: ["monitoring", "observability"], 접근성: ["accessibility", "wcag", "aria"],
  반응형: ["responsive"], 디자인: ["design"], 도커: ["docker"], 환경변수: ["env", "environment"],
  인터뷰: ["interview", "grill"], 요구사항: ["requirements", "spec"], 리서치: ["research"],
  나레이션: ["tts", "voice"], 사운드: ["sound", "audio"], 이펙트: ["vfx"],
  온톨로지: ["ontology", "rdf", "owl"], 벤치마크: ["benchmark"], 유니티: ["unity"],
};

const CHOICE_ENUM_RE = /(?:^|[\s,])\d+\s*[.)]\s*[a-e](?=$|[\s,.)])/i;
const CHOICE_OPT_RE = /\b(?:option\s*[a-e1-9]|choice\s*[a-e1-9])\b|(?:[1-9]\s*번\s*(?:옵션|으로|로|선택|가자)?|첫\s*번째|두\s*번째)/i;
const META_KO_RE = /(?:방금\s*(?:말한|설명한)|다시\s*설명|그거\s*말고|그렇게\s*(?:진행|해줘|하자)|계속\s*진행)/i;
const DOMAIN_ANCHOR_RE = /\b(?:react|next\.?js|three\.?js|webgl|blender|unity|unreal|godot|mixamo|hwp|hwpx|rhwp|sql|postgres|postgresql|bigquery|looker|supabase|firebase|genkit|vercel|docker|kubernetes|playwright|cdp|chrome|browser|mcp|fastmcp|langgraph|langsmith|langfuse|pydantic|a2a|rdf|owl|shacl|ontology|git|tdd|e2e|wcag|aria|csrf|oauth|jwt|api|prd|gtm|tts|vfx|glb|obsidian|zvec|semble|graphify|mex|hyperfine|kipris)\b|(?:블렌더|리깅|한글|리액트|코드\s*리뷰|스키마|유튜브|쇼츠|크롬|브라우저|로그|머지\s*충돌|기획서|보안|특허|옵시디언|셰이더|경쟁사|리팩토링|아키텍처|배포|모니터링|접근성|반응형|도커|환경변수|인터뷰|리서치|온톨로지|벤치마크)/i;

interface OfflineIndexEntry {
  name: string;
  positiveText?: string;
  koAliases?: string;
  tags?: string[];
  path?: string;
}

let cachedOfflineMap: Map<string, OfflineIndexEntry> | null = null;
let cachedOfflineMtime = 0;

function loadOfflineIndexMap(): Map<string, OfflineIndexEntry> | null {
  try {
    const idxPath = process.env.JEV_ROUTING_INDEX_PATH
      || join(homedir(), ".agents", "jev", "routing-index.v1.json");
    if (!existsSync(idxPath)) return null;
    const st = statSync(idxPath);
    if (cachedOfflineMap && cachedOfflineMtime === st.mtimeMs) return cachedOfflineMap;
    const raw = JSON.parse(readFileSync(idxPath, "utf8")) as { skills?: OfflineIndexEntry[] };
    const map = new Map<string, OfflineIndexEntry>();
    for (const s of raw.skills ?? []) map.set(s.name, s);
    cachedOfflineMap = map;
    cachedOfflineMtime = st.mtimeMs;
    return map;
  } catch {
    return null;
  }
}

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  const add = (t: string) => {
    if (!t || STOPWORDS.has(t)) return;
    if (/^\d+$/.test(t) || (/^[a-z0-9]+$/.test(t) && t.length < 2)) return;
    out.add(t);
  };
  for (const m of text.toLowerCase().matchAll(TOKEN_RE)) {
    const tok = m[0];
    let clean = tok;
    if (/^[가-힣]{3,}$/.test(tok)) {
      clean = tok.replace(/(?:에서|으로|이랑|까지|부터|하고|해서|처럼|보다|은|는|이|가|을|를|도|만|와|과|랑|로|에|의)$/, "");
      if (clean.length < 2) clean = tok;
    }
    add(clean);
    if (clean !== tok) add(tok);
    if (/[/-]/.test(tok)) {
      for (const part of tok.split(/[/-]+/)) {
        if (part.length >= 2) add(part);
      }
    }
    for (const [ko, ens] of Object.entries(KO_EN_EXPANSIONS)) {
      if (clean === ko || (ko.length >= 2 && tok.startsWith(ko))) {
        for (const en of ens) add(en);
      }
    }
  }
  return out;
}

function isConversationalAbstention(task: string, skillNameSet: Set<string>): boolean {
  const trimmed = task.trim();
  if (!trimmed || trimmed.length < 2) return true;
  const lower = trimmed.toLowerCase();
  for (const m of lower.matchAll(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/g)) {
    if (skillNameSet.has(m[0])) return false;
  }
  if (DOMAIN_ANCHOR_RE.test(trimmed)) return false;
  if (CHOICE_ENUM_RE.test(trimmed) && trimmed.length <= 160) return true;
  if (CHOICE_OPT_RE.test(trimmed) && trimmed.length <= 90) return true;
  if (META_KO_RE.test(trimmed) && trimmed.length <= 80) return true;
  const toks = tokens(trimmed);
  if (toks.size === 0) return true;
  return false;
}

function extractNegatedPhrases(task: string): string[] {
  const lower = task.toLowerCase();
  const out: string[] = [];
  for (const re of [
    /\(\s*not\s+([^)]{2,50})\)/gi,
    /\b(?:not|never)\s+(?:using\s+|for\s+|a\s+|an\s+|the\s+)?([a-z0-9][a-z0-9._-]*(?:\s+[a-z0-9][a-z0-9._-]*){0,2})/gi,
    /\b(?:without|instead\s+of|rather\s+than)\s+([^,.;!?]{3,65})/gi,
    /([가-힣a-z0-9][가-힣a-z0-9\s._-]{1,25}?)\s*(?:말고|없이|제외하고)/gi,
  ]) {
    for (const m of lower.matchAll(re)) {
      if (m[1]?.trim()) out.push(m[1].trim());
    }
  }
  return out;
}

function isExplicitlyNegated(name: string, phrases: string[]): boolean {
  if (!phrases.length) return false;
  const lower = name.toLowerCase();
  const generic = new Set(["system", "setup", "best", "practices", "design", "web", "game", "development", "analysis", "automation", "performance", "optimization", "testing", "code", "review", "agent", "skills", "skill", "pack", "fundamentals"]);
  const parts = lower.split("-").filter(p => p.length >= 3 && !STOPWORDS.has(p) && !generic.has(p));
  for (const ph of phrases) {
    if (ph.includes(lower)) return true;
    for (const p of parts) {
      if (new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(ph)) return true;
    }
  }
  return false;
}

function firstSentence(text: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  const first = s.split(/(?<=[.!?])\s+/)[0] || s;
  return first.length > 110 ? `${first.slice(0, 107).trim()}...` : first;
}

function skillText(skill: SkillDoc, off?: OfflineIndexEntry): string {
  if (off) {
    return `${skill.name} ${off.positiveText || skill.summary || ""} ${(off.tags ?? []).join(" ")} ${off.koAliases || ""}`;
  }
  return `${skill.name} ${skill.summary ?? ""} ${skill.whenToUse ?? ""} ${skill.details ?? ""}`;
}

function explicitMention(task: string, skillName: string): boolean {
  const esc = skillName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)[$/]${esc}(?:\\s|$|[.,;:!?])`, "i").test(task);
}

/**
 * Route a user task against the loaded skill catalog using bilingual boundary-aware
 * lexical + IDF scoring (enriched by `~/.agents/jev/routing-index.v1.json` when present)
 * and Stage-0 conversational abstention.
 */
export function routeSkillsForTask(
  task: string,
  skills: SkillDoc[],
  topK: number = SKILL_ROUTE_TOP_K,
): SkillRouteSelection {
  const shards = Math.ceil(skills.length / SKILL_ROUTE_CHOICE_CAP);
  const strategy: SkillRouteSelection["strategy"] = shards <= 4 ? "sharded" : "shortlist";
  const trimmed = task.trim();
  if (!trimmed || skills.length === 0) {
    return { topK: [], reason: "gate", strategy, routing: "No task or skills to route." };
  }

  const skillNameSet = new Set(skills.map(s => s.name.toLowerCase()));
  if (isConversationalAbstention(trimmed, skillNameSet)) {
    return { topK: [], reason: "gate", strategy, routing: "Conversational turn — answer directly without a workflow skill." };
  }

  const taskTokens = tokens(trimmed);
  if (taskTokens.size === 0) {
    return { topK: [], reason: "gate", strategy, routing: "No substantive task tokens — answer directly." };
  }

  const isLargeCatalog = skills.length > 40;
  const offlineMap = isLargeCatalog ? loadOfflineIndexMap() : null;
  const negatedPhrases = extractNegatedPhrases(trimmed);

  const docs = skills.map(s => {
    const off = offlineMap?.get(s.name);
    const posDesc = off?.positiveText || s.summary || "";
    const textTokens = tokens(skillText(s, off));
    const nameTokens = tokens(s.name.replace(/[:/_-]/g, " "));
    const tagKoTokens = off ? tokens(`${(off.tags ?? []).join(" ")} ${off.koAliases || ""}`) : new Set<string>();
    return { s, off, posDesc, textTokens, nameTokens, tagKoTokens };
  });

  // Document frequency across catalog for IDF weighting (prevents generic word 0.50 ties!)
  const df = new Map<string, number>();
  for (const t of taskTokens) df.set(t, 0);
  for (const d of docs) {
    for (const t of taskTokens) {
      if (d.textTokens.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const N = Math.max(2, docs.length);
  const idf = (t: string): number => Math.log(1 + N / (1 + (df.get(t) ?? 0)));
  let totalTaskIdf = 0;
  for (const t of taskTokens) totalTaskIdf += idf(t);
  totalTaskIdf = Math.max(0.5, totalTaskIdf);

  const scored: SkillRouteCandidate[] = docs.map(d => {
    const { s, off, posDesc, textTokens, nameTokens, tagKoTokens } = d;
    if (explicitMention(trimmed, s.name)) {
      return {
        name: s.name,
        score: 2.0,
        reasons: ["explicit $skill mention"],
        reason: firstSentence(posDesc),
        path: s.sourcePath || off?.path,
      };
    }
    if (isExplicitlyNegated(s.name, negatedPhrases)) {
      return { name: s.name, score: 0, reasons: ["explicitly negated"] };
    }

    let matchedIdf = 0;
    let overlapCount = 0;
    let nameHits = 0;
    let tagHits = 0;
    for (const t of taskTokens) {
      if (textTokens.has(t)) {
        matchedIdf += idf(t);
        overlapCount++;
      }
      if (nameTokens.has(t)) nameHits++;
      if (tagKoTokens.has(t)) tagHits++;
    }

    const idfRatio = matchedIdf / totalTaskIdf;
    let score = idfRatio + Math.min(nameHits * 0.45, 1.35) + Math.min(tagHits * 0.22, 0.66);
    if (isLargeCatalog && overlapCount === 1 && nameHits === 0 && tagHits === 0) {
      score *= 0.45;
    }

    const reasons: string[] = [];
    if (nameHits > 0) reasons.push(`name:${nameHits}`);
    if (tagHits > 0) reasons.push(`tag/ko:${tagHits}`);
    if (overlapCount > 0) reasons.push(`overlap:${overlapCount}/${taskTokens.size}`);

    return {
      name: s.name,
      score: Number(score.toFixed(4)),
      reasons,
      reason: firstSentence(posDesc),
      path: s.sourcePath || off?.path,
    };
  });

  scored.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
  const best = scored[0];
  if (!best || best.score < SKILL_ROUTE_GATE) {
    return { topK: [], reason: "gate", strategy, routing: "No skill cleared the gate — answer directly without a workflow skill." };
  }
  if (best.score < SKILL_ROUTE_FIT) {
    return { topK: [], reason: "fits", strategy, routing: "Top candidate failed the fit threshold — answer directly." };
  }

  const cliff = Math.max(SKILL_ROUTE_GATE, best.score * 0.52);
  const gated = scored.filter(c => c.score >= cliff).slice(0, topK);
  const names = gated.map(c => `$${c.name}`).join(", ");
  return {
    topK: gated,
    reason: "ok",
    strategy,
    routing: `Advisory only: the task resembles ${names}. Load SKILL.toon/SKILL.md on demand only when the user invoked it via $skill or the task truly fits that bundled workflow; never recite skill docs.`,
  };
}

/**
 * Render the Jev `route-skills` 2-stage deferred advisory note for a selection.
 * Empty string when the selection cleared nothing (gate / fit miss / abstention).
 */
export function skillAdvisoryRoutingNote(selection: SkillRouteSelection): string {
  if (selection.topK.length === 0) return "";
  const detail = selection.topK.map(c => `${c.name} (score ${c.score.toFixed(2)})`).join(", ");
  const deferred = selection.topK
    .filter(c => c.reason || c.path)
    .map(c => `- ${c.name} (${c.score.toFixed(2)})${c.reason ? ` — ${c.reason}` : ""}${c.path ? ` [${c.path}]` : ""}`)
    .join("\n");
  const lead = [
    `Jev advisory routing: task similarity cleared the skill gate for ${detail}.`,
    "Advisory only — the router proposes, never auto-executes; load SKILL.toon/SKILL.md on demand only when the user invoked it via $skill or the task truly fits that workflow.",
  ].join(" ");
  return deferred ? `${lead}\n${deferred}` : lead;
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
