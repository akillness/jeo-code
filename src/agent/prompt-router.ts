/**
 * PromptRouter: per-turn, prompt-content-based model routing (heuristic-first,
 * LLM-escalation-only-when-ambiguous, always fail-open).
 *
 * Why heuristic-first instead of always asking a model to classify: a classifier
 * call on every turn would burn latency+cost on the common case (most turns are
 * unambiguously trivial or unambiguously routine). The regex heuristic below
 * resolves the vast majority of turns with zero I/O; only genuinely ambiguous
 * prompts (conflicting or absent signals) pay for a cheap escalation call.
 *
 * Why fail-open everywhere: this module runs on EVERY qualifying turn (see
 * launch.ts's `runTurn`). A routing bug or a flaky classifier call must never
 * be able to break a real user turn — every internal step swallows its own
 * failures and falls back to a safe default, and the top-level export wraps
 * everything again as a final backstop.
 *
 * Why no STATIC tier→model map: `resolveTierModel` computes inline off
 * `config.roles`/`config.routing.tiers` so a user who already configured
 * `roles.smol`/`roles.slow` (for `--smol`/`--slow` role-tier resolution
 * elsewhere) gets working routing with zero additional config. An unconfigured
 * trivial/complex tier does NOT simply collapse to `defaultModel` (that would
 * defeat cross-provider routing for every user who hasn't hand-tuned
 * `routing.tiers`) — it auto-selects the cheapest (trivial) / most capable
 * (complex) model jeo has a stored credential for, computed LIVE off
 * `MODEL_CATALOG`/`pricing.ts` on every call. This is the "long-term" fix for
 * catalog drift: when jeo ships a new/cheaper/stronger model, auto-select
 * picks it up on the next call automatically — no user config edit, no
 * hand-maintained tier→model table to go stale. "standard" is the one
 * exception: it always falls through to `defaultModel` unless explicitly
 * configured, since routine day-to-day work should stay on the user's
 * deliberately chosen default rather than being silently reassigned.
 */
import { callLlm } from "./loop";
import { resolveRoleModel } from "../ai/model-manager";
import { catalogMetadata, MODEL_CATALOG, type CatalogModel } from "../ai/model-catalog";
import { priceForModel } from "../ai/pricing";
import { tryExtractJsonObject } from "./json";
import type { Config } from "./state";
import type { ThinkLevel } from "../ai/model-catalog";
import type { ProviderName } from "../ai/types";
import type { AuthProvider } from "../auth";

export type PromptTier = "trivial" | "standard" | "complex";

export interface HeuristicResult {
  tier: PromptTier;
  confidence: number; // 0..1
  signals: string[]; // fired signal names, e.g. ["short-question","no-code-no-path"]
}

export interface RouteDecision {
  model: string;
  thinking?: ThinkLevel; // undefined = do not override the session/global thinking level
  tier: PromptTier;
  confidence: number;
  source: "heuristic" | "llm";
  signals: string[];
  /** Present only on the "smol role not configured" first-occurrence case — see warnOnce below. */
  warning?: string;
}

export interface RoutePromptOptions {
  hasImages?: boolean;
  signal?: AbortSignal;
}

// --- Frozen, bilingual-validated classification signals (do not re-derive). ---

const RE_CAUSAL = /\b(why|how|root cause|how come)\b/i;
const RE_CAUSAL_KR = /(왜\s|근본\s*원인|이유가|어떻게)/;
const RE_TRIVIAL_QUESTION_WORD = /\b(what|who|when|where|which)\b/i;
const RE_TRIVIAL_QUESTION_WORD_KR = /(뭐|뭔가요|무엇|언제|어디|누구|몇\s|인가요|있나요)/;
const RE_CODE_FENCE = /```/;
const RE_PATH_TOKEN = /(?:^|[\s"'`(])@?(?:\.{0,2}[\w-]*\/)+[\w-]+(?:\.[\w-]+)*\.[A-Za-z]\w{0,7}\b/g;
const RE_DEEP_KEYWORDS_EN = /\b(design|architecture|refactor|debug|deep\s*dive|investigate|diagnose|redesign)\b/i;
const RE_DEEP_KEYWORDS_KR = /(설계|아키텍처|리팩터|디버그|딥\s*다이브|딥다이브|진단)/;
const RE_SENTENCE_BOUNDARY = /[.!?][ \n]|[.!?]$/g;

/**
 * Pure, synchronous, zero-I/O prompt classification. Every branch and threshold
 * here is frozen per the PromptRouter contract (validated against a 17+-case
 * bilingual corpus) — in particular: a causal ("why"/"how"/"왜"/"어떻게") question
 * is NEVER treated as trivial just because it's short and question-shaped (a
 * debugging question is the opposite of trivial), and the path-token regex is
 * anchored so numeric fractions like "3/4.5" or "10/10" never false-positive as
 * a file path (the trailing segment must end in a letter-led extension).
 */
export function classifyPromptHeuristically(prompt: string): HeuristicResult {
  const trimmed = prompt.trim();
  const signals: string[] = [];
  let trivialScore = 0;
  let complexScore = 0;

  const isCausal = RE_CAUSAL.test(trimmed) || RE_CAUSAL_KR.test(trimmed);

  // trivial signal 1: short AND a factual-lookup-shaped question (never for a causal question).
  const isShort = trimmed.length < 40;
  const looksLikeFactualQuestion =
    !isCausal &&
    (trimmed.includes("?") || RE_TRIVIAL_QUESTION_WORD.test(trimmed) || RE_TRIVIAL_QUESTION_WORD_KR.test(trimmed));
  if (isShort && looksLikeFactualQuestion) {
    trivialScore++;
    signals.push("short-question");
  }

  // trivial signal 2: no code fence AND no file path mention.
  const hasCodeFence = RE_CODE_FENCE.test(trimmed);
  const pathMatches = [...trimmed.matchAll(RE_PATH_TOKEN)];
  if (!hasCodeFence && pathMatches.length === 0) {
    trivialScore++;
    signals.push("no-code-no-path");
  }

  // complex signal 1: deep-work keyword.
  if (RE_DEEP_KEYWORDS_EN.test(trimmed) || RE_DEEP_KEYWORDS_KR.test(trimmed)) {
    complexScore++;
    signals.push("deep-work-keyword");
  }

  // complex signal 1b: causal/debugging question.
  if (isCausal) {
    complexScore++;
    signals.push("causal-question");
  }

  // complex signal 2: long or multi-sentence.
  const questionMarkCount = (trimmed.match(/\?/g) ?? []).length;
  const sentenceCount = (trimmed.match(RE_SENTENCE_BOUNDARY) ?? []).length;
  if (trimmed.length >= 200 || questionMarkCount >= 2 || sentenceCount >= 3) {
    complexScore++;
    signals.push("long-or-multi-sentence");
  }

  // complex signal 3: multiple distinct file mentions.
  const distinctPaths = new Set(pathMatches.map(m => m[0].trim()));
  if (distinctPaths.size >= 2) {
    complexScore++;
    signals.push("multi-file");
  }

  // Tier + confidence resolution (frozen thresholds).
  if (trivialScore > 0 && complexScore > 0) {
    return { tier: "standard", confidence: 0.35, signals }; // conflicting signals -> let escalation decide
  }
  if (complexScore >= 2) return { tier: "complex", confidence: 0.85, signals };
  if (complexScore === 1) return { tier: "complex", confidence: 0.65, signals };
  if (trivialScore >= 2) return { tier: "trivial", confidence: 0.85, signals };
  if (trivialScore === 1) return { tier: "trivial", confidence: 0.65, signals };
  return { tier: "standard", confidence: 0.9, signals }; // no signals at all -> common case, high confidence
}

// --- warnOnce: module-level one-time warning surface (no existing helper for this). ---

const warnedKeys = new Set<string>();

/** Returns `message` the first time `key` is seen in this process, `undefined` every
 *  time after — lets a fail-open path surface a diagnostic exactly once instead of
 *  spamming it on every qualifying turn. */
export function warnOnce(key: string, message: string): string | undefined {
  if (warnedKeys.has(key)) return undefined;
  warnedKeys.add(key);
  return message;
}

/** Test-only: clear warned-once state between test cases (mirrors
 *  src/tui/components/color.ts's resetAppearanceCache pattern). */
export function resetPromptRouterWarnings(): void {
  warnedKeys.clear();
}

/** `resolveTierModel`'s config requirement: `providers`/`oauth` are OPTIONAL (not
 *  just a `Pick`) so callers/tests that never touch credentials (e.g. this file's
 *  own tests, which only exercise heuristic/escalation logic) keep compiling
 *  unchanged — omitting the keys entirely still satisfies this type, and
 *  `config.providers?.[p]` / `config.oauth?.[p]` are safe on the resulting
 *  `undefined`. Production callers (`readGlobalConfig()`'s real `Config`) always
 *  provide both. */
export type RoutingConfig = Pick<Config, "defaultModel" | "roles" | "routing"> &
  Partial<Pick<Config, "providers" | "oauth">>;

/** Cloud providers eligible for cross-provider auto-select (excludes local
 *  ollama/lmstudio, which are never a sensible "route to the cheapest/strongest"
 *  target — a local model's cost/capability isn't comparable to a hosted one). */
function isCloudProvider(p: ProviderName): p is AuthProvider {
  return p !== "ollama" && p !== "lmstudio";
}

/** Cheapest cloud model jeo has a credential for, computed LIVE off
 *  `MODEL_CATALOG`/`priceForModel` — picks up new/repriced catalog entries
 *  automatically, never a hand-maintained id. `null` when no credentialed
 *  model has a known price (caller falls back to `defaultModel`). Tiebreak:
 *  canonical id (deterministic across otherwise-equal candidates). */
function cheapestCredentialed(config: RoutingConfig): string | null {
  let best: CatalogModel | null = null;
  let bestCost = Infinity;
  for (const m of MODEL_CATALOG) {
    // "ANY stored credential" (API key OR OAuth) is enough here — auto-select only
    // needs "can this provider serve a request at all", not WHICH credential kind
    // wins (unlike provider-status.ts's `configuredCredential` precedence). The
    // real veto gate in launch.ts's `runTurn` re-verifies full readiness (including
    // live OAuth expiry) before a turn actually uses the model.
    if (!isCloudProvider(m.provider) || !(config.providers?.[m.provider] || config.oauth?.[m.provider])) continue;
    const price = priceForModel(m.canonical);
    if (!price) continue;
    const cost = price.inPerM + price.outPerM;
    if (cost < bestCost || (cost === bestCost && best && m.canonical < best.canonical)) {
      best = m;
      bestCost = cost;
    }
  }
  return best?.canonical ?? null;
}

/** Most capable cloud model jeo has a credential for, computed LIVE off
 *  `MODEL_CATALOG` — ranks by full (xhigh) thinking support first, then max
 *  output tokens, then context window, so a newly catalogued frontier model
 *  is picked up automatically without a hand-maintained id. `null` when no
 *  credentialed model qualifies (caller falls back to `defaultModel`).
 *  Tiebreak: canonical id (deterministic; also happens to prefer widely-
 *  available ids like `claude-fable-5` alphabetically ahead of limited-
 *  availability siblings such as `claude-mythos-5`). */
function strongestCredentialed(config: RoutingConfig): string | null {
  let best: CatalogModel | null = null;
  for (const m of MODEL_CATALOG) {
    // "ANY stored credential" is enough (see cheapestCredentialed's comment above).
    if (!isCloudProvider(m.provider) || !(config.providers?.[m.provider] || config.oauth?.[m.provider])) continue;
    if (!best) { best = m; continue; }
    const xhighM = m.thinking.includes("xhigh") ? 1 : 0;
    const xhighBest = best.thinking.includes("xhigh") ? 1 : 0;
    if (xhighM !== xhighBest) { if (xhighM > xhighBest) best = m; continue; }
    if (m.maxOutputTokens !== best.maxOutputTokens) { if (m.maxOutputTokens > best.maxOutputTokens) best = m; continue; }
    if (m.contextTokens !== best.contextTokens) { if (m.contextTokens > best.contextTokens) best = m; continue; }
    if (m.canonical < best.canonical) best = m;
  }
  return best?.canonical ?? null;
}

// --- Tier -> model/thinking resolution (inline off config.roles/config.routing.tiers; no static map). ---

/** Exported for `jeo doctor`'s routing-preview diagnostic (same resolution the real
 *  `routePrompt` uses — no duplicated logic between "what WILL routing pick" and
 *  "what does doctor SHOW the user routing will pick"). */
export function resolveTierModel(tier: PromptTier, config: RoutingConfig): string {
  const configured = config.routing?.tiers?.[tier]?.model;
  if (configured) return configured;
  if (tier === "trivial") return config.roles?.smol || cheapestCredentialed(config) || config.defaultModel;
  if (tier === "complex") return config.roles?.slow || strongestCredentialed(config) || config.defaultModel;
  return config.defaultModel; // "standard" always falls through to defaultModel unless explicitly configured
}

function resolveTierThinking(tier: PromptTier, config: RoutingConfig): ThinkLevel | undefined {
  return config.routing?.tiers?.[tier]?.thinking; // undefined = no override, caller keeps session/global level
}

const VALID_TIERS: readonly PromptTier[] = ["trivial", "standard", "complex"];
function isPromptTier(value: unknown): value is PromptTier {
  return typeof value === "string" && (VALID_TIERS as readonly string[]).includes(value);
}

/** Hard cap on how much of the prompt is embedded in the escalation classifier call —
 *  never send megabytes of user text to a cheap classifier model. */
const ESCALATION_PROMPT_CHAR_CAP = 2000;

function buildClassifierPrompt(prompt: string): string {
  const capped = prompt.length > ESCALATION_PROMPT_CHAR_CAP ? prompt.slice(0, ESCALATION_PROMPT_CHAR_CAP) : prompt;
  return (
    `Classify the complexity of the following user request for a coding assistant into exactly one ` +
    `tier: "trivial" (a quick factual lookup, no repo work), "standard" (routine coding/editing work), ` +
    `or "complex" (multi-file, architectural, or root-cause debugging work). ` +
    `Respond with ONLY a JSON object of the shape {"tier":"trivial"|"standard"|"complex"}.\n\n` +
    `Request:\n${capped}`
  );
}

/** Attempt LLM-based re-classification for an ambiguous heuristic result. Fail-open:
 *  ANY failure (throw, abort/timeout, malformed JSON, invalid tier value) resolves to
 *  `undefined` so the caller falls back to the heuristic tier silently. */
async function escalateToLlm(prompt: string, smolModel: string, signal: AbortSignal | undefined): Promise<PromptTier | undefined> {
  try {
    const raw = await callLlm([{ role: "user", content: buildClassifierPrompt(prompt) }], {
      model: smolModel,
      jsonMode: true,
      maxTokens: 200,
      signal,
    });
    const parsed = tryExtractJsonObject<{ tier?: unknown }>(raw);
    if (parsed && isPromptTier(parsed.tier)) return parsed.tier;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Stable key for the one-time "escalation skipped, roles.smol unconfigured" notice. */
const SMOL_UNCONFIGURED_WARNING_KEY = "prompt-router:smol-unconfigured";

/**
 * Route a single turn's prompt to a tier-appropriate model. Heuristic-first: only
 * escalates to a real LLM call when the heuristic's confidence is below
 * `config.routing?.confidenceThreshold` (default 0.6). Returns `null` (never
 * throws) when routing should not override the caller's own already-computed
 * model — either because of an unexpected internal failure (defensive backstop;
 * every internal step already fails open on its own) or because the resolved
 * tier's model lacks image support for an image-bearing turn (the caller must
 * keep whatever multimodal-capable model it already had).
 */
export async function routePrompt(
  prompt: string,
  config: RoutingConfig,
  opts: RoutePromptOptions = {},
): Promise<RouteDecision | null> {
  try {
    const heuristic = classifyPromptHeuristically(prompt);
    const threshold = config.routing?.confidenceThreshold ?? 0.6;

    let tier = heuristic.tier;
    let source: "heuristic" | "llm" = "heuristic";
    let warning: string | undefined;

    if (heuristic.confidence < threshold) {
      const smolModel = resolveRoleModel("smol", config);
      if (smolModel === config.defaultModel) {
        // roles.smol not configured -> "escalate to a cheap model" would actually call
        // defaultModel (expensive) — the exact paradox the design doc identifies. Skip
        // escalation, keep the heuristic result, and surface a one-time warning.
        warning = warnOnce(
          SMOL_UNCONFIGURED_WARNING_KEY,
          "[route] confidence below threshold but roles.smol is not configured — skipping LLM escalation, using heuristic tier (set roles.smol to enable escalation)",
        );
      } else {
        const escalated = await escalateToLlm(prompt, smolModel, opts.signal);
        if (escalated) {
          tier = escalated;
          source = "llm";
        }
      }
    }

    const model = resolveTierModel(tier, config);
    if (opts.hasImages && catalogMetadata(model)?.images === false) return null;

    const decision: RouteDecision = {
      model,
      thinking: resolveTierThinking(tier, config),
      tier,
      confidence: heuristic.confidence,
      source,
      signals: heuristic.signals,
    };
    if (warning) decision.warning = warning;
    return decision;
  } catch {
    return null;
  }
}

/**
 * Derive the provider-side prompt-cache correlation key for a turn (forwarded as
 * `sessionKey` -> `prompt_cache_key`/`session_id` in loop.ts/model-manager.ts/
 * openai-responses.ts). Provider-side prompt caches are keyed PER MODEL — reusing
 * the bare `sessionId` across a mid-session model switch (routePrompt changing
 * `activeModel` turn to turn) would send the same cache-correlation key to a
 * DIFFERENT model/provider, guaranteeing a cache miss on every switch and silently
 * undermining the cost/latency savings routing exists for (design doc §7 risk #4).
 * Scoping the key to `${sessionId}:${model}` gives each model its own cache
 * lineage within the session: same model across turns -> same key (cache reuse
 * preserved), different model -> different key (no false cross-model cache hit).
 * Deliberately excludes any turn counter/timestamp — the key must stay STABLE
 * across consecutive turns that keep the same model.
 */
export function deriveCacheSessionKey(sessionId: string, model: string): string {
  return `${sessionId}:${model}`;
}
